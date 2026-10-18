// Receipts and "you owe" texts list what each person paid for, and those lines always add up.
import { describe, expect, it, vi } from "vitest";
import { computeShareLines, computeShares } from "../src/core/split.js";
import { itemList, MAX_ITEM_LINES, ownerReceipt } from "../src/messaging/templates.js";
import type { Item, Member, SplitRule } from "../src/types.js";

const member = (id: string): Member => ({ id, name: id[0]!.toUpperCase() + id.slice(1), phone: `+1555000${id.length}`, role: "member" });
const item = (id: string, cents: number, addedBy: string, shared: boolean): Item => ({ id, householdId: "h", name: `Item ${id}`, addedBy, cents, shared, status: "pending" });

describe("computeShareLines", () => {
  const members = ["sam", "jake", "priya"].map(member);
  const items = [
    item("tp", 1199, "priya", true), // 1199 / 3 leaves 2 remainder cents
    item("soap", 849, "jake", true),
    item("fryer", 3200, "jake", false),
    item("chips", 479, "jake", false),
    item("milk", 549, "sam", false),
    item("gum", 1, "ghost", true), // 1¢ split 3 ways: two people get 0¢
    item("lost", 100, "ghost", false), // added by someone no longer in the household: split evenly
  ];

  it.each<SplitRule>(["smart", "even", "adder"])("%s: each member's lines add up to their share", (rule) => {
    const lines = computeShareLines(items, members, rule);
    const shares = computeShares(items, members, rule);
    for (const m of members) expect(lines[m.id]!.reduce((s, l) => s + l.cents, 0)).toBe(shares[m.id]);
    const total = items.reduce((s, i) => s + i.cents, 0);
    expect(Object.values(shares).reduce((s, c) => s + c, 0)).toBe(total);
  });

  it("marks shared items with how many ways they were split", () => {
    const priya = computeShareLines(items, members, "smart").priya!;
    expect(priya.find((l) => l.itemId === "tp")).toMatchObject({ cents: 399, splitWays: 3 });
    expect(computeShareLines(items, members, "smart").jake!.find((l) => l.itemId === "fryer")).toMatchObject({ cents: 3200, splitWays: 1 });
  });
});

describe("itemList", () => {
  const line = (n: number, cents = 100, splitWays = 1) => ({ itemId: `i${n}`, name: `Thing ${n}`, cents, splitWays });

  it("lists items with prices, and says how shared items were split", () => {
    expect(itemList([line(1, 3200), line(2, 283, 3)])).toBe("\n• Thing 1 $32.00\n• Thing 2 (split 3 ways) $2.83");
  });

  it("leaves out 0¢ lines and is empty when there's nothing to list", () => {
    expect(itemList([line(1, 0, 3)])).toBe("");
    expect(itemList()).toBe("");
  });

  it(`shows at most ${MAX_ITEM_LINES} lines, then sums the rest`, () => {
    const text = itemList(Array.from({ length: MAX_ITEM_LINES + 2 }, (_, i) => line(i + 1, 150)));
    expect(text.split("\n• ")).toHaveLength(MAX_ITEM_LINES + 2); // "" + 8 lines + 1 summary line
    expect(text).toMatch(/\n• …and 2 more items \$3\.00$/);
  });
});

describe("owner receipt", () => {
  it("names everyone the owner's card covered", () => {
    const sam = { ...member("sam"), role: "owner" as const, cardLast4: "4242" };
    const text = ownerReceipt(sam, 1565, 1227, [], [
      { name: "Priya", cents: 1015 },
      { name: "David", cents: 212 },
    ]);
    expect(text).toMatch(/Your card also covered \$12\.27 for Priya \(\$10\.15\) and David \(\$2\.12\)\./);
  });
});

describe("after-order texts never show item lines that don't match the charge", () => {
  it("leaves the list out if a member's lines don't add up to what they were charged", async () => {
    const { sendOrderTexts } = await import("../src/messaging/afterOrder.js");
    const { seedDemo } = await import("../scripts/seed.js");
    const { db } = await import("../src/core/store.js");
    const h = seedDemo();
    const items = [...db.items.values()];
    const shares = { ...computeShares(items, h.members, "smart"), jake: 1 }; // pretend Jake was charged 1¢
    const order = { id: "o1", householdId: h.id, itemIds: [], totalCents: 7275, rule: "smart" as const, createdAt: "" };
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    await sendOrderTexts(h, { order, items, shares, charges: [], debts: [] });
    spy.mockRestore();

    const jake = logs.find((l) => l.includes("→ Jake (private)"))!;
    expect(jake).toMatch(/Receipt: your share is \$0\.01/);
    expect(jake).not.toMatch(/•/);
    expect(logs.find((l) => l.includes("→ Sam (private)"))).toMatch(/• Oat milk \$5\.49/); // Sam's still match
  });
});
