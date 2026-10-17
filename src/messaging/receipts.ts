import type { Household, OrderResult } from "../types.js";
import { fmt, memberReceipt, ownerReceipt, youOwe } from "./templates.js";

export type Reply = { audience: "group" | "private"; recipient: string; text: string; cartVersion?: string };

// Verify the checkout contract before describing funds as collected. The split itself
// still belongs exclusively to Person 2's computeShares implementation.
export function assertFundedResult(h: Household, result: OrderResult, expected: { itemIds: string[]; totalCents: number }): void {
  const members = new Set(h.members.map((m) => m.id));
  const ids = result.order.itemIds;
  const money = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const shares = Object.entries(result.shares);
  if (result.order.householdId !== h.id || result.order.totalCents !== expected.totalCents
    || ids.length !== expected.itemIds.length || new Set(ids).size !== ids.length
    || expected.itemIds.some((id) => !ids.includes(id))
    || result.items.length !== ids.length || result.items.some((item) => !ids.includes(item.id))
    || shares.some(([id, cents]) => !members.has(id) || !money(cents))
    || shares.reduce((sum, [, cents]) => sum + cents, 0) !== expected.totalCents
    || result.charges.some((c) => c.orderId !== result.order.id || c.status !== "succeeded" || !members.has(c.memberId) || !members.has(c.paidBy) || !money(c.cents))
    || result.charges.reduce((sum, c) => sum + c.cents, 0) !== expected.totalCents
    || shares.some(([id, cents]) => result.charges.filter((c) => c.memberId === id).reduce((sum, c) => sum + c.cents, 0) !== cents)) {
    throw new Error("Checkout result is not fully funded for the confirmed cart");
  }
}

export async function receiptReplies(h: Household, result: OrderResult, links: {
  card: (memberId: string) => Promise<string>; pay: (debtId: string) => Promise<string>;
}): Promise<Reply[]> {
  const owner = h.members.find((m) => m.id === h.ownerId)!;
  const replies: Reply[] = [];
  for (const member of h.members) {
    const share = result.shares[member.id] ?? 0;
    const covered = member.id === owner.id ? result.charges.filter((c) => c.paidBy === owner.id && c.memberId !== owner.id && c.status === "succeeded").reduce((sum, c) => sum + c.cents, 0) : 0;
    if (!share && !covered) continue;
    const debt = result.debts.find((d) => d.debtorId === member.id);
    let text: string;
    if (debt) {
      try { text = youOwe(owner, debt.cents, await links.pay(debt.id), await links.card(member.id)); }
      catch { text = `Your share is ${fmt(debt.cents)}. ${owner.name}'s card covered it. Payment links are temporarily unavailable; ask ‘what do I owe?’ to try again.`; }
    } else if (member.id === owner.id) {
      text = ownerReceipt(member, share, covered);
    } else {
      text = memberReceipt(member, share);
    }
    replies.push({ audience: "private", recipient: member.id, text: `Test payment receipt. ${text}` });
  }
  return replies;
}
