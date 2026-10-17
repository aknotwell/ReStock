// Owner: Person 2. Remove `.skip` once computeShares is implemented — these must pass before merging it.
import { describe, expect, it } from "vitest";
import { computeShares } from "../src/core/split.js";
import { pendingItems } from "../src/core/store.js";
import { DEMO_HOUSEHOLD_ID, seedDemo } from "../scripts/seed.js";
import type { Item, Member } from "../src/types.js";

const sum = (s: Record<string, number>) => Object.values(s).reduce((a, b) => a + b, 0);

describe.skip("computeShares", () => {
  const demo = () => {
    const h = seedDemo();
    return { members: h.members, items: pendingItems(DEMO_HOUSEHOLD_ID) };
  };

  it("smart: shared split evenly, personal to adder", () => {
    const { items, members } = demo();
    expect(computeShares(items, members, "smart")).toEqual({ sam: 1565, jake: 4695, priya: 1015 });
  });

  it("even: every item split evenly, remainder to first members", () => {
    const { items, members } = demo();
    expect(computeShares(items, members, "even")).toEqual({ sam: 2426, jake: 2426, priya: 2423 });
  });

  it("adder: each person pays for what they added", () => {
    const { items, members } = demo();
    expect(computeShares(items, members, "adder")).toEqual({ sam: 549, jake: 4528, priya: 2198 });
  });

  it("shares always sum to the order total ($72.75)", () => {
    const { items, members } = demo();
    for (const rule of ["smart", "even", "adder"] as const) {
      expect(sum(computeShares(items, members, rule))).toBe(7275);
    }
  });

  it("flipping an item from personal to shared moves cost off the adder", () => {
    const { items, members } = demo();
    const chips = items.find((i) => i.name === "Tortilla chips")!;
    chips.shared = true;
    const s = computeShares(items, members, "smart");
    expect(s.jake).toBe(4695 - 479 + 160);
    expect(sum(s)).toBe(7275);
  });

  it("$10.00 split 3 ways is 334/333/333", () => {
    const members: Member[] = ["a", "b", "c"].map((id) => ({ id, name: id, phone: id, role: "member" }));
    const items: Item[] = [{ id: "x", householdId: "h", name: "x", addedBy: "a", cents: 1000, shared: true, status: "pending" }];
    expect(computeShares(items, members, "even")).toEqual({ a: 334, b: 333, c: 333 });
  });
});
