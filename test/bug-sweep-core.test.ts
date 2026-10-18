// Bugs found in a review of the whole repo (core data, splits, persistence, texts). Each test failed before its fix.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", () => ({ anthropic: undefined, MODEL: "test" }));

import { addMember, createHousehold, removeMember } from "../src/core/households.js";
import { openDebtsFor } from "../src/core/ledger.js";
import { computeShares } from "../src/core/split.js";
import { addItem, db, householdsForPhone, pendingItems, resetStore } from "../src/core/store.js";
import { askWhichHousehold, answerDestination, resetDestinations } from "../src/messaging/destination.js";
import { fmt, groupSummary } from "../src/messaging/templates.js";
import { publicBaseUrlFrom } from "../src/config.js";
import type { Household, Item, OrderResult } from "../src/types.js";

const SAM = "+15550000001", JAKE = "+15550000002", PRIYA = "+15550000003", BEA = "+15550000004", AMBER2 = "+15550000005";

beforeEach(() => {
  resetStore();
  resetDestinations();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("member ids are never reused", () => {
  it("a new person doesn't get the id of someone kept only for an unpaid debt", () => {
    const maple = createHousehold("Sam", SAM, { name: "Maple House" });
    const amber = addMember(maple, "Amber", JAKE);
    db.debts.set("d1", { id: "d1", orderId: "o1", debtorId: amber.id, creditorId: maple.ownerId, cents: 500, status: "open" });
    removeMember(maple, "Amber", { keepBalances: true }); // kept in formerMembers until she pays

    const club = createHousehold("Bea", BEA, { name: "Book Club" });
    const otherAmber = addMember(club, "Amber", AMBER2); // a different person, also called Amber
    expect(otherAmber.id).not.toBe(amber.id);
    expect(openDebtsFor(otherAmber.id)).toEqual([]); // she doesn't inherit the first Amber's debt
  });

  it("…or the id on past charges of someone who left", () => {
    const maple = createHousehold("Sam", SAM, { name: "Maple House" });
    const jake = addMember(maple, "Jake", JAKE);
    db.charges.push({ orderId: "o1", memberId: jake.id, cents: 499, paidBy: jake.id, status: "succeeded" });
    removeMember(maple, "Jake");
    const newJake = addMember(createHousehold("Bea", BEA), "Jake", AMBER2);
    expect(newJake.id).not.toBe(jake.id);
  });
});

describe("removing someone takes their own items out of the cart", () => {
  function household(): { h: Household; jake: string; priya: string } {
    const h = createHousehold("Sam", SAM, { name: "Maple House" });
    const jake = addMember(h, "Jake", JAKE).id;
    const priya = addMember(h, "Priya", PRIYA).id;
    return { h, jake, priya };
  }

  it("their personal items and items only they pay for are dropped, so nobody else is charged for them", () => {
    const { h, jake, priya } = household();
    addItem({ householdId: h.id, name: "Air fryer", addedBy: jake, cents: 3200, shared: false });
    addItem({ householdId: h.id, name: "Chips for Jake", addedBy: priya, cents: 479, shared: true, splitWith: [jake] });
    addItem({ householdId: h.id, name: "Dish soap", addedBy: jake, cents: 849, shared: true }); // the household's
    const oat = addItem({ householdId: h.id, name: "Oat milk", addedBy: priya, cents: 549, shared: true, splitWith: [jake, priya] });

    removeMember(h, "Jake");
    expect(pendingItems(h.id).map((i) => i.name).sort()).toEqual(["Dish soap", "Oat milk"]);
    expect(oat.splitWith).toEqual([priya]);
    const shares = computeShares(pendingItems(h.id), h.members, "smart");
    expect(shares).toEqual({ [h.ownerId]: 425, [priya]: 424 + 549 }); // dish soap split two ways; oat milk all Priya's
  });
});

describe("restoring a save with no households", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "restock-db-"));
  });
  afterEach(async () => {
    (await import("../src/core/persist.js")).closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("still restores debts and saved state, so the next autosave doesn't wipe them", async () => {
    const file = path.join(dir, "restock.db");
    vi.resetModules();
    let persist = await import("../src/core/persist.js");
    let store = await import("../src/core/store.js");
    let photon = await import("../src/messaging/photon.js");
    persist.openDatabase(file);
    store.db.debts.set("d1", { id: "d1", orderId: "o1", debtorId: "amber", creditorId: "sam", cents: 1015, status: "open" });
    photon.mute(PRIYA); // texted STOP
    persist.saveNow();
    persist.closeDatabase();

    vi.resetModules(); // a restart
    persist = await import("../src/core/persist.js");
    store = await import("../src/core/store.js");
    photon = await import("../src/messaging/photon.js");
    // Saved data with no households still counts as restored: seeding the demo would reset the store and wipe it.
    expect(persist.openDatabase(file)).toBe(true);
    expect(store.db.debts.get("d1")?.cents).toBe(1015);
    expect(photon.isMuted(PRIYA)).toBe(true);
    persist.saveNow();
    persist.closeDatabase();

    vi.resetModules();
    persist = await import("../src/core/persist.js");
    store = await import("../src/core/store.js");
    persist.openDatabase(file);
    expect(store.db.debts.size).toBe(1); // still there after another save
  });
});

describe('"Which household is this for?" numbers', () => {
  it("a number means the household shown with it, even if the list changed since", () => {
    const maple = createHousehold("Sam", SAM, { name: "Maple House" });
    const fam = createHousehold("Sam", SAM, { name: "We Da Fam" });
    const club = createHousehold("Sam", SAM, { name: "Book Club" });
    expect(askWhichHousehold(SAM, "add dish soap")).toMatch(/1\. Maple House[\s\S]*2\. We Da Fam[\s\S]*3\. Book Club/);
    db.households.delete(fam.id); // gone before they answer

    const reply = answerDestination(SAM, "2", (h) => h.members.find((m) => m.phone === SAM));
    expect(reply?.kind === "household" ? reply.household.id : undefined).not.toBe(club.id);
    expect(reply?.kind).toBe("ask");
    expect(householdsForPhone(SAM).map((h) => h.id)).toEqual([maple.id, club.id]);
  });
});

describe("order summary wording", () => {
  const summary = (items: Item[], budgetCents: number, spentCents: number) => {
    const h: Household = { id: "h", groupChatId: "unbound", ownerId: "sam", budgetCents, spentCents, members: [{ id: "sam", name: "Sam", phone: SAM, role: "owner" }] };
    const total = items.reduce((s, i) => s + i.cents, 0);
    const result: OrderResult = {
      order: { id: "o", householdId: "h", itemIds: items.map((i) => i.id), totalCents: total, rule: "smart", createdAt: "2026-10-18T00:00:00Z" },
      items,
      shares: { sam: total },
      charges: [],
      debts: [],
    };
    return groupSummary(h, result);
  };
  const item = (cents: number): Item => ({ id: "i", householdId: "h", name: "Dish soap", addedBy: "sam", cents, shared: true, status: "ordered" });

  it("says 1 item, not 1 items", () => {
    expect(summary([item(849)], 20000, 849)).toMatch(/^Ordered! 1 item, \$8\.49,/);
  });

  it("an overspent budget reads as over budget, not a negative amount after the dollar sign", () => {
    const text = summary([item(849)], 20000, 20500);
    expect(text).not.toMatch(/\$-/);
    expect(text).toMatch(/\$5\.00 over this month's budget/);
  });

  it("negative amounts put the minus sign first", () => {
    expect(fmt(-500)).toBe("-$5.00");
    expect(fmt(1015)).toBe("$10.15");
  });
});

describe("split engine edge", () => {
  it("an item from someone who left, whose id looks like a built-in object key, is split instead of crashing", () => {
    const members = [
      { id: "sam", name: "Sam", phone: SAM, role: "owner" as const },
      { id: "priya", name: "Priya", phone: PRIYA, role: "member" as const },
    ];
    const item: Item = { id: "i", householdId: "h", name: "Gum", addedBy: "constructor", cents: 101, shared: false, status: "pending" };
    expect(computeShares([item], members, "smart")).toEqual({ sam: 51, priya: 50 });
  });
});

describe("public base URL", () => {
  it("drops a trailing slash so texted links don't come out as https://site//c/…", () => {
    expect(publicBaseUrlFrom({ PUBLIC_BASE_URL: "https://restock.select/" })).toBe("https://restock.select");
    expect(publicBaseUrlFrom({ RAILWAY_PUBLIC_DOMAIN: "restock.up.railway.app" })).toBe("https://restock.up.railway.app");
    expect(publicBaseUrlFrom({})).toBe("http://localhost:3000");
  });
});
