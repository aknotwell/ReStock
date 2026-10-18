// Charging an item to some of the household: "add oat milk for me and Jake", "just me and Alex",
// "everyone", "not me". Names are matched in code against the household, never guessed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedDemo } from "../scripts/seed.js";
import { computeShares } from "../src/core/split.js";
import { db, pendingItems } from "../src/core/store.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound } from "../src/messaging/photon.js";
import { describeParts, parseSplitCommand, parseSplitInAdd, payersOf, setPayers } from "../src/messaging/splitWith.js";
import type { Household, Item, Member } from "../src/types.js";

const SAM = "+15550000001", JAKE = "+15550000002", PRIYA = "+15550000003";
let h: Household;
let sam: Member, jake: Member, priya: Member;
let logs: string[];

beforeEach(() => {
  h = seedDemo();
  [sam, jake, priya] = h.members as [Member, Member, Member];
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const ids = (r: ReturnType<typeof parseSplitCommand>) => (r?.kind === "group" ? r.memberIds : r);

describe("reading who an item is for, when it's added", () => {
  it.each([
    ["add oat milk for me and jake", ["sam", "jake"]],
    ["add chips for Jake and Priya", ["jake", "priya"]],
    ["add eggs split with priya", ["sam", "priya"]], // "split with" includes the sender
    ["add eggs split between jake and priya", ["jake", "priya"]], // "between" is exactly who's named
    ["add coffee for everyone but me", ["jake", "priya"]],
  ])("%s", (text, expected) => {
    const r = parseSplitInAdd(text, h, sam);
    expect(r?.request).toEqual({ kind: "group", memberIds: expected });
  });

  it("'for' that isn't about people is ignored", () => {
    expect(parseSplitInAdd("add tp for the bathroom", h, sam)).toBeUndefined();
  });

  it.each(["add pizza for the guys", "add eggs split with sarah", "add chips for jake and sarah"])("asks instead of guessing: %s", (text) => {
    expect(parseSplitInAdd(text, h, sam)?.request.kind).toBe("unclear");
  });

  it("'for everyone' is everyone", () => {
    expect(parseSplitInAdd("add coffee for everyone", h, sam)?.request).toEqual({ kind: "everyone" });
  });
});

describe("changing who pays for an item already in the cart", () => {
  it("reads the correction commands", () => {
    expect(ids(parseSplitCommand("just me and jake", h, sam))).toEqual(["sam", "jake"]);
    expect(ids(parseSplitCommand("Only Priya", h, sam))).toEqual(["priya"]);
    expect(ids(parseSplitCommand("split with priya", h, sam))).toEqual(["sam", "priya"]);
    expect(parseSplitCommand("everyone", h, sam)).toEqual({ kind: "everyone" });
    expect(parseSplitCommand("not me", h, jake)).toEqual({ kind: "not_me" });
    expect(parseSplitCommand("not me for the chips", h, jake)).toEqual({ kind: "not_me", itemName: "chips" });
    expect(parseSplitCommand("split with sarah", h, sam)?.kind).toBe("unclear");
  });

  it("leaves ordinary messages alone", () => {
    for (const t of ["just checking", "only 2 left", "order now", "add tp", "yes", "personal"]) expect(parseSplitCommand(t, h, sam)).toBeUndefined();
  });

  it("stores everyone as plain shared, the adder alone as plain personal, anything else as splitWith", () => {
    const item = { id: "x", householdId: h.id, name: "X", addedBy: "sam", cents: 549, shared: true, status: "pending" } as Item;
    setPayers(item, ["sam", "jake", "priya"], h);
    expect([item.shared, item.splitWith]).toEqual([true, undefined]);
    setPayers(item, ["sam"], h);
    expect([item.shared, item.splitWith]).toEqual([false, undefined]);
    setPayers(item, ["jake", "sam"], h);
    expect([item.shared, item.splitWith]).toEqual([true, ["sam", "jake"]]); // household order
    expect(describeParts(item, h, "sam")).toBe("split between you ($2.75) and Jake ($2.74)");
  });
});

describe("the split engine", () => {
  const item = (splitWith?: string[]): Item => ({ id: "o", householdId: h.id, name: "Oat milk", addedBy: "sam", cents: 549, shared: true, splitWith, status: "pending" });

  it("splits an item between exactly its group, leftover cents to the first in household order", () => {
    expect(computeShares([item(["sam", "jake"])], h.members, "smart")).toEqual({ sam: 275, jake: 274, priya: 0 });
  });

  it("skips anyone in the group who has left, and falls back to everyone if nobody's left", () => {
    expect(computeShares([item(["jake", "former"])], h.members, "smart")).toEqual({ sam: 0, jake: 549, priya: 0 });
    expect(computeShares([item(["former"])], h.members, "smart")).toEqual({ sam: 183, jake: 183, priya: 183 });
  });

  it("the 'even' rule still splits everything across everyone", () => {
    expect(computeShares([item(["sam"])], h.members, "even")).toEqual({ sam: 183, jake: 183, priya: 183 });
  });
});

describe("over chat (console mode)", () => {
  let n = 0;
  async function say(from: string, text: string) {
    const msg = { messageId: `s${++n}`, spaceId: "pho_spc_group", spaceKind: "group" as const, fromPhone: from, text, agentUserId: "pho_usr_agent" };
    rememberInbound(msg);
    await handleInbound(msg);
  }
  const out = () => logs.join("\n");
  /** Add an item; if Restock asks "Which one?", pick option 1. */
  async function add(from: string, text: string) {
    await say(from, text);
    if (/Which one\?|Reply 1/.test(out())) await say(from, "1");
  }
  const newest = () => pendingItems(h.id).at(-1)!;

  beforeEach(async () => {
    for (const i of pendingItems(h.id)) db.items.delete(i.id); // start from an empty cart
    await say(SAM, "help"); // binds the group chat
    logs = [];
  });

  it("'add oat milk for me and jake' puts it on Sam and Jake only, through the option picker", async () => {
    await add(SAM, "add oat milk for me and jake");
    expect(newest()).toMatchObject({ splitWith: ["sam", "jake"] });
    expect(out()).toMatch(/\(split between you and Jake, \$\d+\.\d\d\)\. Reply "everyone" or "just me" to change\./);
    const shares = computeShares(pendingItems(h.id), h.members, "smart");
    expect(shares.priya).toBe(0);
  });

  it("a name that isn't in the household is asked about, and nothing is added", async () => {
    await say(SAM, "add pizza for the guys");
    expect(out()).toMatch(/I don't know who "the guys" is in this household, so I didn't add/);
    expect(pendingItems(h.id)).toHaveLength(0);
  });

  it("'just me and jake' changes the sender's newest item and shows each part", async () => {
    await add(SAM, "add eggs");
    logs = [];
    await say(SAM, "just me and jake");
    expect(payersOf(newest(), h).map((m) => m.id)).toEqual(["sam", "jake"]);
    expect(out()).toMatch(/is now split between you \(\$\d+\.\d\d\) and Jake \(\$\d+\.\d\d\)\./);
  });

  it("'not me' takes Jake off an item Sam put him on, and 'everyone' puts it back", async () => {
    await add(SAM, "add chips for jake and priya");
    logs = [];
    await say(JAKE, "not me");
    expect(payersOf(newest(), h).map((m) => m.id)).toEqual(["priya"]);
    expect(out()).toMatch(/Took you off .+\. It's now just Priya's\./);

    await say(SAM, "everyone");
    expect(newest()).toMatchObject({ shared: true });
    expect(newest().splitWith).toBeUndefined();
  });

  it("'not me' from the only person left hands the item back to whoever added it", async () => {
    await add(SAM, "add chips for priya");
    await say(PRIYA, "not me");
    expect(payersOf(newest(), h).map((m) => m.id)).toEqual(["sam"]);
  });

  it("the shares 'order now' would charge put the item on its group only", async () => {
    await add(SAM, "add oat milk for me and jake");
    const oat = newest();
    logs = [];
    const shares = computeShares(pendingItems(h.id), h.members, "smart");
    const half = Math.ceil(oat.cents / 2);
    expect([shares.sam, shares.jake, shares.priya]).toEqual([half, oat.cents - half, 0]);
  });
});
