// DEMO_MEMBERS lets the live demo use real testers instead of Sam/Jake/Priya.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDemoMembers, seedDemo } from "../scripts/seed.js";
import { computeShares } from "../src/core/split.js";
import { pendingItems } from "../src/core/store.js";
import { demoTestCardFor } from "../scripts/demoCards.js";

const FOUR = JSON.stringify([
  { name: "Alex", phone: "+12065550100", owner: true, card: true },
  { name: "David", phone: "+12065550101", card: true },
  { name: "Amber", phone: "+12065550102" },
  { name: "Abdul", phone: "+12065550103" },
]);

afterEach(() => vi.unstubAllEnvs());

describe("DEMO_MEMBERS", () => {
  it("defaults to the PLAN.md household when unset", () => {
    const h = seedDemo();
    expect(h.members.map((m) => m.name)).toEqual(["Sam", "Jake", "Priya"]);
    expect(h.ownerId).toBe("sam");
  });

  it("seeds a four-person household with the owner, cards and demo cart", () => {
    vi.stubEnv("DEMO_MEMBERS", FOUR);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = seedDemo();
    expect(h.members.map((m) => [m.name, m.phone, m.role])).toEqual([
      ["Alex", "+12065550100", "owner"],
      ["David", "+12065550101", "member"],
      ["Amber", "+12065550102", "member"],
      ["Abdul", "+12065550103", "member"],
    ]);
    expect(h.ownerId).toBe("alex");
    expect(h.members.filter((m) => m.paymentMethodId).map((m) => m.id)).toEqual(["alex", "david"]);
    const items = pendingItems(h.id);
    expect(items.map((i) => i.name)).toContain("Air fryer (approved by Alex)");
    const shares = computeShares(items, h.members, "smart");
    expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBe(7275);
    expect(demoTestCardFor(h.members[1]!)).toBe("pm_card_visa");
    expect(demoTestCardFor(h.members[2]!)).toBeUndefined();
  });

  it("makes the first person the owner (with a card) when nobody is marked owner", () => {
    const m = parseDemoMembers(JSON.stringify([{ name: "Amber", phone: "+1" }, { name: "Abdul", phone: "+2" }]))!;
    expect(m[0]).toMatchObject({ id: "amber", role: "owner", paymentMethodId: "pm_test_amber" });
    expect(m[1]).toMatchObject({ role: "member" });
    expect(m[1]!.paymentMethodId).toBeUndefined();
  });

  it("falls back to the default household on bad input instead of crashing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseDemoMembers("not json")).toBeUndefined();
    expect(parseDemoMembers("[]")).toBeUndefined();
    expect(parseDemoMembers('[{"name":"No phone"}]')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
