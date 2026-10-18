// Owner: Person 2. Who owes whom.
import type { Debt } from "../types.js";
import { db, formerMembers } from "./store.js";

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
  // A removed member's record is only kept for their open debts. Once those are paid, forget them.
  for (const id of [debt.debtorId, debt.creditorId]) if (formerMembers.has(id) && !openBalancesOf([id]).length) formerMembers.delete(id);
}

/** Open debts these members owe or are owed (e.g. everyone in a household). */
export function openBalancesOf(memberIds: string[]): Debt[] {
  const ids = new Set(memberIds);
  return [...db.debts.values()].filter((d) => d.status === "open" && (ids.has(d.debtorId) || ids.has(d.creditorId)));
}
