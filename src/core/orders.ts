// The "order now" flow.
import type { OrderResult, SplitRule } from "../types.js";
import { db, getHousehold, newId, pendingItems } from "./store.js";
import { computeShares } from "./split.js";
import { chargeOrder } from "../payments/charges.js";
import { assertOwnerCard } from "../payments/ownerGate.js";
import { adoptCards } from "./households.js";

export class OrderError extends Error {}

export async function placeOrder(householdId: string, rule: SplitRule = "smart"): Promise<OrderResult> {
  const household = getHousehold(householdId);
  adoptCards(household); // a card someone added in another of their households counts here too
  assertOwnerCard(household); // throws OwnerCardRequiredError (src/payments/ownerGate.ts)

  const items = pendingItems(householdId).filter((i) => !i.needsApproval);
  if (items.length === 0) throw new OrderError("The cart is empty.");

  const totalCents = items.reduce((sum, i) => sum + i.cents, 0);
  const order = {
    id: newId(),
    householdId,
    itemIds: items.map((i) => i.id),
    totalCents,
    rule,
    createdAt: new Date().toISOString(),
    eta: "Thursday", // TODO: real ETA from the merchant/catalog
  };

  const shares = computeShares(items, household.members, rule);
  const { charges, debts } = await chargeOrder(order, shares, household);

  db.orders.set(order.id, order);
  db.charges.push(...charges);
  for (const d of debts) db.debts.set(d.id, d);
  for (const i of items) i.status = "ordered";
  household.spentCents += totalCents;

  return { order, items, shares, charges, debts };
}
