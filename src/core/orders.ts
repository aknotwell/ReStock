// The "order now" flow.
import type { Household, Item, OrderResult, SplitRule } from "../types.js";
import { db, getHousehold, inflightCheckouts, newId, pendingItems } from "./store.js";
import { computeShares } from "./split.js";
import { chargeOrder } from "../payments/charges.js";
import { assertOwnerCard } from "../payments/ownerGate.js";
import { adoptCards, ensureBudgetMonth } from "./households.js";
import { registerState, saveNow } from "./persist.js";

export class OrderError extends Error {}

/** The cart changed after it was shown for "yes": nothing was charged, and it must be shown again. */
export class CartChangedError extends Error {
  constructor() {
    super("The cart changed since it was shown.");
    this.name = "CartChangedError";
  }
}

/**
 * Everything that decides what "yes" buys and who pays: each ready item (price, shared or personal, who it's split
 * with) and the household's members. The order preview records this; placeOrder checks it before charging.
 */
export function cartFingerprint(items: Item[], household: Household): string {
  const lines = [...items]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((i) => `${i.id}:${i.cents}:${i.shared ? "s" : "p"}:${i.addedBy}:${(i.splitWith ?? []).join("+")}`);
  return `${household.members.map((m) => m.id).join(",")}|${lines.join(";")}`;
}

const INFLIGHT_KEEP = 200;

registerState("inflight-checkouts", {
  dump: () => [...inflightCheckouts],
  load: (data) => {
    inflightCheckouts.clear();
    for (const [key, orderId] of data as [string, string][]) inflightCheckouts.set(key, orderId);
  },
});

function rememberCheckout(key: string, orderId: string): void {
  inflightCheckouts.set(key, orderId);
  while (inflightCheckouts.size > INFLIGHT_KEEP) {
    const oldest = inflightCheckouts.keys().next().value;
    if (oldest === undefined) break;
    inflightCheckouts.delete(oldest);
  }
}

/** An order already saved for this checkout text, so a retry must not charge again. */
function savedOrderResult(orderId: string): OrderResult | undefined {
  const order = db.orders.get(orderId);
  if (!order) return undefined;
  const household = db.households.get(order.householdId);
  if (!household) return undefined;
  const items = order.itemIds.map((id) => db.items.get(id)).filter((item): item is Item => !!item);
  return {
    order,
    items,
    shares: computeShares(items, household.members, order.rule),
    charges: db.charges.filter((c) => c.orderId === orderId),
    debts: [...db.debts.values()].filter((d) => d.orderId === orderId),
  };
}

/**
 * Place the pending cart. `idempotencyKey` is the text that confirmed checkout. The order id is saved
 * before Stripe is called, and a retry reuses it, so a crash after capture cannot charge a second time.
 * `expectedCart` is the fingerprint of the cart the member said "yes" to (cartFingerprint): if anyone changed
 * it since, CartChangedError is thrown before anything is charged.
 */
export async function placeOrder(householdId: string, rule: SplitRule = "smart", idempotencyKey?: string, expectedCart?: string): Promise<OrderResult> {
  const household = getHousehold(householdId);
  adoptCards(household); // a card someone added in another of their households counts here too
  assertOwnerCard(household); // throws OwnerCardRequiredError (src/payments/ownerGate.ts)
  ensureBudgetMonth(household);

  if (idempotencyKey) {
    const previousId = inflightCheckouts.get(idempotencyKey);
    if (previousId) {
      const saved = savedOrderResult(previousId);
      if (saved) return saved;
    }
  }

  const items = pendingItems(householdId).filter((i) => !i.needsApproval);
  if (items.length === 0) throw new OrderError("The cart is empty.");
  if (expectedCart !== undefined && cartFingerprint(items, household) !== expectedCart) throw new CartChangedError();

  const totalCents = items.reduce((sum, i) => sum + i.cents, 0);
  const order = {
    id: (idempotencyKey && inflightCheckouts.get(idempotencyKey)) || newId(),
    householdId,
    itemIds: items.map((i) => i.id),
    totalCents,
    rule,
    createdAt: new Date().toISOString(),
    eta: "Thursday", // TODO: real ETA from the merchant/catalog
  };
  // Remember the id before any charge. saveNow is a no-op until a database is open.
  if (idempotencyKey) {
    rememberCheckout(idempotencyKey, order.id);
    saveNow();
  }

  const shares = computeShares(items, household.members, rule);
  const { charges, debts } = await chargeOrder(order, shares, household);

  db.orders.set(order.id, order);
  db.charges.push(...charges);
  for (const d of debts) db.debts.set(d.id, d);
  for (const i of items) i.status = "ordered";
  household.spentCents += totalCents;

  return { order, items, shares, charges, debts };
}
