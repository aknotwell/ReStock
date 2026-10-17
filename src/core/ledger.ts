// Owner: Person 2. Who owes whom.
import type { Debt } from "../types.js";
import { db } from "./store.js";

export function openDebtsFor(memberId: string): Debt[] {
  return [...db.debts.values()].filter((d) => d.debtorId === memberId && d.status === "open");
}

export function owedTo(memberId: string): Debt[] {
  return [...db.debts.values()].filter((d) => d.creditorId === memberId && d.status === "open");
}

/** Called by the Stripe webhook (Person 3). Idempotent. */
export function markDebtPaid(debtId: string): void {
  const debt = db.debts.get(debtId);
  if (!debt) throw new Error(`Unknown debt ${debtId}`);
  debt.status = "paid";
}
