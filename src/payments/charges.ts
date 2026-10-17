// Owner: Person 3. Charge each member's share.
import type { ChargeResult, Household, Order, Shares } from "../types.js";

/**
 * For each member's share:
 * - card on file: off-session PaymentIntent on their own card
 * - no card: add their share to the owner's charge and create Debt(member -> owner)
 * - member's card fails: fall back to the owner's card and create a Debt
 * Must be idempotent per (order, member) so a retry never charges twice.
 */
export async function chargeOrder(order: Order, shares: Shares, household: Household): Promise<ChargeResult> {
  // TODO(P3): implement with requireStripe() from ./stripe.js
  void order;
  void shares;
  void household;
  throw new Error("chargeOrder not implemented");
}
