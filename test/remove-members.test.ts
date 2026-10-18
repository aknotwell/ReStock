// The owner removing people or deleting the whole household. Owner-only, always confirmed for bulk changes,
// and open debts are never lost: the owner is warned with who owes whom, and the ledger keeps them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addItem, db, findMember, householdsForPhone, pendingItems, resetStore } from "../src/core/store.js";
import { markDebtPaid, openDebtsFor } from "../src/core/ledger.js";
import { parseMembershipCommand } from "../src/messaging/membership.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound } from "../src/messaging/photon.js";
import { resetConfirmations } from "../src/messaging/confirm.js";
import { findMemberByHandle, myDebts } from "../src/payments/payback.js";

const ALEX = "+14255550101", AMBER = "+14255550102", DAVID = "+15095550103";
let n = 0;
let logs: string[];
const out = () => logs.join("\n");

async function dm(from: string, text: string) {
  const msg = { messageId: `rm${++n}`, spaceId: `pho_spc_dm_${from}`, spaceKind: "direct" as const, fromPhone: from, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}

/** Alex (owner), Amber and David, all joined. */
async function household() {
  await dm(ALEX, "start household as Alex");
  await dm(ALEX, "invite Amber 425-555-0102");
  await dm(AMBER, "hi");
  await dm(ALEX, "invite David 509-555-0103");
  await dm(DAVID, "hi");
  const h = householdsForPhone(ALEX)[0]!;
  expect(h.members.map((m) => m.name)).toEqual(["Alex", "Amber", "David"]);
  logs = [];
  return h;
}

/** Amber owes Alex $12.34 from an earlier order. */
function amberOwesAlex(h: ReturnType<typeof householdsForPhone>[number]) {
  const amber = h.members.find((m) => m.name === "Amber")!;
  db.orders.set("o1", { id: "o1", householdId: h.id, itemIds: [], totalCents: 3702, rule: "smart", createdAt: "2026-10-17T20:00:00Z" });
  db.debts.set("d1", { id: "d1", orderId: "o1", debtorId: amber.id, creditorId: h.ownerId, cents: 1234, status: "open" });
  return amber;
}

beforeEach(() => {
  resetStore();
  resetConfirmations();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("parsing", () => {
  it("reads 'remove everyone' and 'delete household' without stealing item removals", () => {
    expect(parseMembershipCommand("remove everyone")).toEqual({ type: "remove_everyone" });
    expect(parseMembershipCommand("Kick out all the members")).toEqual({ type: "remove_everyone" });
    expect(parseMembershipCommand("remove everyone else from the household")).toEqual({ type: "remove_everyone" });
    expect(parseMembershipCommand("delete household")).toEqual({ type: "delete_household" });
    expect(parseMembershipCommand("Delete this group.")).toEqual({ type: "delete_household" });
    expect(parseMembershipCommand("remove chips")).toBeUndefined();
    expect(parseMembershipCommand("remove all the chips")).toBeUndefined();
  });
});

describe("only the owner", () => {
  it("can remove everyone or delete the household", async () => {
    const h = await household();
    await dm(AMBER, "remove everyone");
    expect(out()).toMatch(/Only the budget owner can invite or remove people/);
    await dm(AMBER, "delete household");
    expect(out()).toMatch(/Only the budget owner can delete the household/);
    await dm(AMBER, "yes"); // nothing was proposed to her, so her "yes" does nothing here
    expect(db.households.get(h.id)?.members).toHaveLength(3);
  });
});

describe("removing everyone", () => {
  it("asks first, then removes everyone but the owner and tells each of them", async () => {
    const h = await household();
    await dm(ALEX, "remove everyone");
    expect(out()).toMatch(/Remove everyone else from Alex's household \(Amber, David\)\?/);
    expect(out()).not.toMatch(/Heads up/);
    expect(h.members).toHaveLength(3); // nothing happens before "yes"
    logs = [];
    await dm(ALEX, "yes");
    expect(h.members.map((m) => m.name)).toEqual(["Alex"]);
    expect(householdsForPhone(AMBER)).toHaveLength(0);
    expect(householdsForPhone(DAVID)).toHaveLength(0);
    expect(out()).toMatch(/Alex removed you from Alex's household and you won't get its texts anymore\./);
    expect(out().match(/Alex removed you from/g)).toHaveLength(2); // Amber and David
    expect(out()).toMatch(/Removed Amber, David from Alex's household\. You're still its budget owner\./);
  });

  it("says so when there's nobody else", async () => {
    await dm(ALEX, "start household as Alex");
    logs = [];
    await dm(ALEX, "remove everyone");
    expect(out()).toMatch(/nobody else in Alex's household/);
  });
});

describe("deleting the household", () => {
  it("without open debts: asks, 'no' keeps it, 'yes' deletes it and clears the cart", async () => {
    const h = await household();
    addItem({ householdId: h.id, name: "Dish soap", addedBy: h.ownerId, cents: 849, shared: true });
    await dm(ALEX, "delete household");
    expect(out()).toMatch(/Delete Alex's household\? This removes everyone \(Amber, David\), clears the cart and can't be undone\./);
    expect(out()).toMatch(/Reply "yes" to confirm/);
    expect(out()).not.toMatch(/Heads up/);
    await dm(ALEX, "no");
    expect(db.households.has(h.id)).toBe(true);

    await dm(ALEX, "delete household");
    logs = [];
    await dm(ALEX, "yes");
    expect(db.households.has(h.id)).toBe(false);
    expect(pendingItems(h.id)).toHaveLength(0);
    expect(householdsForPhone(AMBER)).toHaveLength(0);
    expect(out()).toMatch(/Alex deleted Alex's household, so its cart is cleared/);
    expect(out()).toMatch(/Alex's household is deleted/);
  });

  it("with open debts: warns who owes how much and recommends settling first, but lets the owner go ahead", async () => {
    const h = await household();
    const amber = amberOwesAlex(h);
    await dm(ALEX, "delete household");
    expect(out()).toMatch(/Heads up, there are open balances:\n• Amber owes Alex \$12\.34/);
    expect(out()).toMatch(/I recommend settling up first/);
    expect(out()).toMatch(/Reply "yes" to delete it anyway/);
    expect(db.households.has(h.id)).toBe(true);

    logs = [];
    await dm(ALEX, "yes, delete");
    expect(db.households.has(h.id)).toBe(false);
    expect(out()).toMatch(/Alex deleted Alex's household.*You still owe \$12\.34 from earlier orders\. Pay it back anytime: .*\/pay/);

    // The debt survives, with names, and Amber can still log in and pay it back.
    expect(openDebtsFor(amber.id).map((d) => d.cents)).toEqual([1234]);
    expect(findMember(amber.id)?.member.name).toBe("Amber");
    expect(findMember(amber.id)?.member.stripeCustomerId).toBeUndefined();
    expect(findMemberByHandle(AMBER)?.id).toBe(amber.id);
    expect(myDebts(amber)).toEqual([expect.objectContaining({ to: "Alex", cents: 1234 })]);

    markDebtPaid("d1");
    expect(findMember(amber.id)).toBeUndefined(); // once settled, the leftover record is gone
    expect(findMemberByHandle(AMBER)).toBeUndefined();
  });

  it("a 'yes' after switching households still deletes the one the owner was asked about", async () => {
    const h = await household();
    await dm(ALEX, "delete household");
    await dm(ALEX, "new household called Lake Cabin");
    const cabin = householdsForPhone(ALEX).find((x) => x.name === "Lake Cabin")!;
    await dm(ALEX, "delete household"); // replaces the pending question with one about Lake Cabin
    await dm(ALEX, "yes");
    expect(db.households.has(cabin.id)).toBe(false);
    expect(db.households.has(h.id)).toBe(true);
  });
});

describe("removing one member with an open balance", () => {
  it("warns instead of blocking, and keeps the debt after removal", async () => {
    const h = await household();
    const amber = amberOwesAlex(h);
    await dm(ALEX, "remove member Amber");
    expect(out()).toMatch(/Remove Amber from Alex's household\?\nHeads up, there are open balances:\n• Amber owes Alex \$12\.34/);
    expect(h.members).toHaveLength(3);

    await dm(ALEX, "yes");
    expect(h.members.map((m) => m.name)).toEqual(["Alex", "David"]);
    expect(db.debts.get("d1")).toMatchObject({ status: "open", cents: 1234 });
    expect(myDebts(amber)).toEqual([expect.objectContaining({ to: "Alex" })]);
  });

  it("without a balance, 'remove member' still works right away", async () => {
    const h = await household();
    await dm(ALEX, "remove member David");
    expect(out()).toMatch(/Removed David from Alex's household/);
    expect(out()).toMatch(/Alex removed you/);
    expect(h.members.map((m) => m.name)).toEqual(["Alex", "Amber"]);
  });
});
