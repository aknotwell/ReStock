// Charge each member's share.
//
// Two steps, so nobody is charged for an order that doesn't go through:
//   1. Hold: authorize every share on a card (capture_method "manual"). Nothing is taken yet.
//   2. Capture: only once every hold succeeded, take the money. If anything fails first, release the holds.
import type Stripe from "stripe";
import { newId } from "../core/store.js";
import type { Charge, ChargeResult, Debt, Household, Member, Order, Shares } from "../types.js";
import { assertOwnerCard, findOwner } from "./ownerGate.js";
import { STRIPE_MIN_CHARGE_CENTS } from "./limits.js";
import { requireStripe } from "./stripe.js";

// Shares under Stripe's minimum go on the owner's charge, with a Debt.
export { STRIPE_MIN_CHARGE_CENTS };

/** The order was not placed and nobody was charged. The message is safe to text to the group. */
export class ChargeFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChargeFailedError";
  }
}

/**
 * For each member's share:
 * - card on file: off-session PaymentIntent on their own card
 * - no card (or share under $0.50): add their share to the owner's charge and create Debt(member -> owner)
 * - member's card fails: fall back to the owner's card and create a Debt
 * Idempotent per (order, member): Stripe idempotency keys mean a retry never charges twice.
 */
export async function chargeOrder(order: Order, shares: Shares, household: Household): Promise<ChargeResult> {
  // Backstop: placeOrder checks this first, but no code path may charge without the owner's card.
  assertOwnerCard(household);
  const owner = findOwner(household)!;
  validateShares(order, shares, household);
  if (!owner.stripeCustomerId) {
    throw new ChargeFailedError(`${owner.name}, please add your card again with the add-card link. I didn't place the order.`);
  }

  const stripe = requireStripe();
  const held: Stripe.PaymentIntent[] = [];
  const captured: string[] = [];
  const charges: Charge[] = [];
  const covered: { member: Member; cents: number }[] = []; // shares the owner's card pays for

  try {
    // 1a. Hold each other member's share on their own card.
    for (const member of household.members) {
      const cents = shares[member.id] ?? 0;
      if (member.id === owner.id || cents === 0) continue;
      if (!member.paymentMethodId || !member.stripeCustomerId || cents < STRIPE_MIN_CHARGE_CENTS) {
        covered.push({ member, cents });
        continue;
      }
      const hold = await holdShare(stripe, order, member, cents);
      if (hold.ok) {
        held.push(hold.intent);
        charges.push({ orderId: order.id, memberId: member.id, cents, paidBy: member.id, stripePaymentIntentId: hold.intent.id, status: "succeeded" });
      } else {
        // Their card didn't work (declined, needs 3D Secure, ...). Record it, then fall back to the owner.
        charges.push({ orderId: order.id, memberId: member.id, cents, paidBy: member.id, stripePaymentIntentId: hold.intentId, status: "failed" });
        covered.push({ member, cents });
      }
    }

    // 1b. Hold the owner's share plus everything their card covers, as one charge.
    const ownerShare = shares[owner.id] ?? 0;
    const ownerTotal = ownerShare + covered.reduce((sum, c) => sum + c.cents, 0);
    let ownerIntentId: string | undefined;
    if (ownerTotal > 0) {
      if (ownerTotal < STRIPE_MIN_CHARGE_CENTS) {
        throw new ChargeFailedError("That order is under the $0.50 card minimum, so I didn't place it. Add something and try again.");
      }
      const hold = await holdShare(stripe, order, owner, ownerTotal);
      if (!hold.ok) {
        throw new ChargeFailedError(`${owner.name}'s card didn't go through, so I didn't place the order. Nobody was charged.`);
      }
      held.push(hold.intent);
      ownerIntentId = hold.intent.id;
    }

    // 2. Every hold succeeded: take the money.
    for (const intent of held) {
      if (intent.status !== "requires_capture") continue; // already captured by an earlier attempt
      await stripe.paymentIntents.capture(intent.id, {}, { idempotencyKey: `restock-capture-${intent.id}` });
      captured.push(intent.id);
    }

    if (ownerShare > 0) {
      charges.push({ orderId: order.id, memberId: owner.id, cents: ownerShare, paidBy: owner.id, stripePaymentIntentId: ownerIntentId, status: "succeeded" });
    }
    const debts: Debt[] = [];
    for (const { member, cents } of covered) {
      charges.push({ orderId: order.id, memberId: member.id, cents, paidBy: owner.id, stripePaymentIntentId: ownerIntentId, status: "succeeded" });
      debts.push({ id: newId(), orderId: order.id, debtorId: member.id, creditorId: owner.id, cents, status: "open" });
    }
    return { charges, debts };
  } catch (err) {
    await undo(stripe, held, captured);
    if (err instanceof ChargeFailedError) throw err;
    // Network or API trouble: stop rather than guess. Log the message only, never card details.
    console.error("chargeOrder failed:", err instanceof Error ? err.message : err);
    throw new ChargeFailedError("I couldn't reach the payment provider, so I didn't place the order. Nobody was charged. Try again in a minute.");
  }
}

type Hold = { ok: true; intent: Stripe.PaymentIntent } | { ok: false; intentId?: string };

/** Authorize (but don't take) `cents` on the member's saved card, without them present. */
async function holdShare(stripe: Stripe, order: Order, member: Member, cents: number): Promise<Hold> {
  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: cents,
        currency: "usd",
        customer: member.stripeCustomerId,
        payment_method: member.paymentMethodId,
        off_session: true,
        confirm: true,
        capture_method: "manual",
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        description: "Restock household order",
        metadata: { orderId: order.id, householdId: order.householdId, memberId: member.id },
      },
      // Same order + member = same key, so a retry returns the first result instead of charging again.
      { idempotencyKey: `restock-hold-${order.id}-${member.id}` },
    );
    // "succeeded" means a retry of an order that was already captured.
    if (intent.status === "requires_capture" || intent.status === "succeeded") return { ok: true, intent };
    await stripe.paymentIntents.cancel(intent.id).catch(() => undefined);
    return { ok: false, intentId: intent.id };
  } catch (err) {
    if (isCardError(err)) return { ok: false, intentId: err.payment_intent?.id };
    throw err;
  }
}

function isCardError(err: unknown): err is { payment_intent?: { id: string } } {
  return typeof err === "object" && err !== null && (err as { type?: string }).type === "StripeCardError";
}

/**
 * Put back what this attempt did: refund what it captured, release what it only held. Payments an
 * earlier attempt already captured are left alone. Best effort, logged.
 */
async function undo(stripe: Stripe, held: Stripe.PaymentIntent[], captured: string[]): Promise<void> {
  for (const intent of held) {
    try {
      if (captured.includes(intent.id)) {
        await stripe.refunds.create({ payment_intent: intent.id }, { idempotencyKey: `restock-refund-${intent.id}` });
      } else if (intent.status === "requires_capture") {
        await stripe.paymentIntents.cancel(intent.id);
      }
    } catch (err) {
      console.error(`chargeOrder: couldn't undo ${intent.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Money safety: shares are whole cents, belong to members, and add up to the order total exactly. */
function validateShares(order: Order, shares: Shares, household: Household): void {
  let sum = 0;
  for (const [memberId, cents] of Object.entries(shares)) {
    if (!household.members.some((m) => m.id === memberId)) throw new Error(`Share for unknown member ${memberId}`);
    if (!Number.isInteger(cents) || cents < 0) throw new Error(`Share for ${memberId} must be whole, non-negative cents`);
    sum += cents;
  }
  if (sum !== order.totalCents) throw new Error(`Shares add up to ${sum}, but the order total is ${order.totalCents}`);
}
