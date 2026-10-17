import { describe, expect, it } from "vitest";
import { assertFundedResult, receiptReplies } from "../src/messaging/receipts.js";
import type { Household, OrderResult } from "../src/types.js";
const household: Household = { id: "h", groupChatId: "g", ownerId: "owner", budgetCents: 10000, spentCents: 100,
  members: [{ id: "owner", name: "Sam", phone: "+15550000001", role: "owner" }, { id: "member", name: "Priya", phone: "+15550000002", role: "member" }] };
const makeResult = (): OrderResult => ({
  order: { id: "o", householdId: "h", itemIds: ["i"], totalCents: 100, rule: "smart", createdAt: "2026-10-17" },
  items: [{ id: "i", householdId: "h", name: "Test item", cents: 100, addedBy: "member", shared: false, status: "ordered" }],
  shares: { owner: 0, member: 100 },
  charges: [{ orderId: "o", memberId: "member", paidBy: "owner", cents: 100, status: "succeeded" }],
  debts: [{ id: "d", orderId: "o", debtorId: "member", creditorId: "owner", cents: 100, status: "open" }],
});
const expected = { itemIds: ["i"], totalCents: 100 };
describe("checkout receipt contract", () => {
  it("accepts a funded result for exactly the approved cart", () => {
    expect(() => assertFundedResult(household, makeResult(), expected)).not.toThrow();
  });
  it("rejects missing, failed, duplicate or mismatched funding", () => {
    for (const modify of [
      (r: OrderResult) => { r.charges = []; },
      (r: OrderResult) => { r.charges[0]!.status = "failed"; },
      (r: OrderResult) => { r.charges.push({ ...r.charges[0]! }); },
      (r: OrderResult) => { r.charges[0]!.cents = 99; },
      (r: OrderResult) => { r.shares.member = 99; },
      (r: OrderResult) => { r.order.itemIds = ["other"]; },
      (r: OrderResult) => { r.order.totalCents = 101; },
      (r: OrderResult) => { r.shares.member = NaN; },
    ]) {
      const result = makeResult(); modify(result);
      expect(() => assertFundedResult(household, result, expected)).toThrow();
    }
  });
  it("receipts owner coverage even when their own share is zero", async () => {
    const replies = await receiptReplies(household, makeResult(), { card: async () => "card-link", pay: async () => "pay-link" });
    expect(replies.find((r) => r.recipient === "owner")?.text).toContain("also covered $1.00");
    expect(replies.find((r) => r.recipient === "member")?.text).toContain("pay-link");
    expect(replies.every((r) => r.audience === "private")).toBe(true);
  });
  it("preserves debt information if link generation fails", async () => {
    const replies = await receiptReplies(household, makeResult(), { card: async () => "card-link", pay: async () => { throw new Error("offline"); } });
    expect(replies.find((r) => r.recipient === "member")?.text).toContain("$1.00");
    expect(replies.find((r) => r.recipient === "member")?.text).toContain("temporarily unavailable");
  });
});
