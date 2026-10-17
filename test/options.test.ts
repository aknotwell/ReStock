// "Add TP" -> three options to choose from; "the usual" -> what the household bought last time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", () => ({ anthropic: undefined, MODEL: "test" }));
import { seedDemo } from "../scripts/seed.js";
import { alternativesFor, catalog, getProduct, groupOf } from "../src/core/catalog.js";
import { addItem, db, pendingItems } from "../src/core/store.js";
import { handleInbound } from "../src/messaging/inbound.js";
import {
  buildChoice, clearPendingChoices, parsePick, queueChoices, resolvePick, stripUsual, wantsUsual,
} from "../src/messaging/options.js";
import { rememberInbound, type InboundMessage } from "../src/messaging/photon.js";

const SAM = "+15550000001";
const JAKE = "+15550000002";
const H = "demo-house";
let n = 0;
let logs: string[] = [];
const out = () => logs.join("\n");

async function say(fromPhone: string, body: string) {
  const msg: InboundMessage = { messageId: `o${++n}`, spaceId: "pho_spc_group", spaceKind: "group", fromPhone, text: body, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}

/** A past order of the given products, so "the usual" has something to find. */
function pastOrder(productIds: string[], createdAt: string) {
  const items = productIds.map((id) => {
    const p = getProduct(id)!;
    const item = addItem({ householdId: H, name: p.name, addedBy: "sam", cents: p.cents, shared: true });
    item.status = "ordered";
    return item;
  });
  const order = { id: `past-${createdAt}`, householdId: H, itemIds: items.map((i) => i.id), totalCents: 0, rule: "smart" as const, createdAt };
  db.orders.set(order.id, order);
}

beforeEach(() => {
  seedDemo();
  clearPendingChoices();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("catalog alternatives", () => {
  it("every product has exactly three options, all valid catalog entries", () => {
    for (const p of catalog) {
      const options = alternativesFor(p);
      expect(options).toHaveLength(3);
      expect(options[0]!.id).toBe(groupOf(p)); // the main product is always first
      for (const o of options) expect(Number.isSafeInteger(o.cents) && o.cents > 0).toBe(true);
    }
    expect(new Set(catalog.map((p) => p.name)).size).toBe(catalog.length);
    for (const p of catalog) if (p.group) expect(getProduct(p.group)?.group).toBeUndefined();
  });

  it("keeps the demo cart's products and prices unchanged ($72.75)", () => {
    const ids = ["tp-12", "dish-3", "pt-6", "air-fryer", "chips", "oat-milk"];
    expect(ids.reduce((sum, id) => sum + getProduct(id)!.cents, 0)).toBe(7275);
  });
});

describe("choosing between three options", () => {
  it("'add TP' lists three options and adds nothing until someone picks", async () => {
    const before = pendingItems(H).length;
    await say(SAM, "add tp");
    expect(pendingItems(H)).toHaveLength(before);
    expect(out()).toMatch(/Which one\?\n1\. Toilet paper, 12 rolls: \$11\.99\n2\. Toilet paper, 24 rolls \(bulk\): \$21\.99\n3\. Toilet paper, 12 rolls, ultra-soft: \$15\.49\nReply 1, 2 or 3/);
  });

  it("the pick is added with the catalog price and the sender as the adder", async () => {
    await say(SAM, "add tp");
    await say(SAM, "2");
    expect(pendingItems(H).at(-1)).toMatchObject({ name: "Toilet paper, 24 rolls (bulk)", cents: 2199, addedBy: "sam", shared: true });
    expect(out()).toMatch(/Added Toilet paper, 24 rolls \(bulk\) \(shared, \$21\.99\)/);
  });

  it("keeps 'for me' (personal) through the pick", async () => {
    await say(SAM, "add tp for me");
    await say(SAM, "the third one");
    expect(pendingItems(H).at(-1)).toMatchObject({ name: "Toilet paper, 12 rolls, ultra-soft", shared: false });
  });

  it("re-asks on an out-of-range number and adds nothing", async () => {
    const before = pendingItems(H).length;
    await say(SAM, "add tp");
    logs = [];
    await say(SAM, "7");
    expect(pendingItems(H)).toHaveLength(before);
    expect(out()).toMatch(/Which one\?/);
  });

  it("'cancel' drops the request", async () => {
    const before = pendingItems(H).length;
    await say(SAM, "add tp");
    await say(SAM, "cancel");
    await say(SAM, "1");
    expect(pendingItems(H)).toHaveLength(before);
    expect(out()).toMatch(/didn't add that one/);
  });

  it("only the person who asked can pick", async () => {
    const before = pendingItems(H).length;
    await say(SAM, "add tp");
    await say(JAKE, "1");
    expect(pendingItems(H)).toHaveLength(before);
    await say(SAM, "1");
    expect(pendingItems(H)).toHaveLength(before + 1);
  });

  it("the question expires after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T20:00:00Z"));
    const before = pendingItems(H).length;
    await say(SAM, "add tp");
    vi.setSystemTime(new Date("2026-10-17T20:10:01Z"));
    await say(SAM, "1");
    expect(pendingItems(H)).toHaveLength(before);
  });

  it("naming a specific option adds it directly", async () => {
    await say(SAM, "add bulk tp");
    expect(pendingItems(H).at(-1)).toMatchObject({ name: "Toilet paper, 24 rolls (bulk)", cents: 2199 });
    expect(out()).not.toMatch(/Which one\?/);
  });

  it("several items are asked one at a time, in order", () => {
    const tp = buildChoice(H, getProduct("tp-12")!, null);
    const soap = buildChoice(H, getProduct("dish-3")!, null);
    expect(queueChoices(H, "sam", [tp, soap])).toMatch(/Toilet paper/);
    const first = resolvePick(H, "sam", 1);
    expect(first).toMatchObject({ kind: "picked", product: { id: "tp-12" } });
    expect(first?.kind === "picked" && first.next).toMatch(/Dish soap/);
    expect(resolvePick(H, "sam", 3)).toMatchObject({ kind: "picked", product: { id: "dish-plant" } });
    expect(resolvePick(H, "sam", 1)).toBeUndefined();
  });

  it("a pick never places an order", async () => {
    await say(SAM, "add tp");
    await say(SAM, "1");
    expect(db.orders.size).toBe(0);
  });
});

describe("the usual", () => {
  it("adds what the household bought last time, without asking", async () => {
    pastOrder(["tp-soft", "dish-3"], "2026-10-01T12:00:00Z");
    await say(SAM, "add the usual tp");
    expect(pendingItems(H).at(-1)).toMatchObject({ name: "Toilet paper, 12 rolls, ultra-soft", cents: 1549 });
    expect(out()).toMatch(/Added your usual: Toilet paper, 12 rolls, ultra-soft/);
    expect(out()).not.toMatch(/Which one\?/);
  });

  it("uses the most recent order when there are several", async () => {
    pastOrder(["tp-soft"], "2026-09-01T12:00:00Z");
    pastOrder(["tp-24"], "2026-10-10T12:00:00Z");
    await say(SAM, "add tp, same as last time");
    expect(pendingItems(H).at(-1)?.name).toBe("Toilet paper, 24 rolls (bulk)");
  });

  it("without any history, says so and shows the options", async () => {
    const before = pendingItems(H).length;
    await say(SAM, "add the usual tp");
    expect(pendingItems(H)).toHaveLength(before);
    expect(out()).toMatch(/don't see an earlier order/);
    expect(out()).toMatch(/Which one\?/);
  });

  it("when not asked for the usual, lists last time's pick first and labels it", async () => {
    pastOrder(["tp-soft"], "2026-10-01T12:00:00Z");
    await say(SAM, "add tp");
    expect(out()).toMatch(/1\. Toilet paper, 12 rolls, ultra-soft: \$15\.49 \(what you got last time\)/);
  });

  it("another household's orders don't count", async () => {
    pastOrder(["tp-soft"], "2026-10-01T12:00:00Z");
    db.orders.forEach((o) => { o.householdId = "someone-else"; });
    await say(SAM, "add the usual tp");
    expect(out()).toMatch(/don't see an earlier order/);
  });
});

describe("parsing replies", () => {
  it.each([["1", 1], ["2.", 2], ["#3", 3], ["option 2", 2], ["the second one", 2], ["first", 1], ["Three please", 3]])("%j -> %d", (t, v) => {
    expect(parsePick(t as string)).toBe(v);
  });
  it.each(["add 2 tp", "12", "order now", "yes", "2 more please"])("%j is not a pick", (t) => {
    expect(parsePick(t)).toBeUndefined();
  });
  it("recognizes 'the usual' and strips it from the item name", () => {
    for (const t of ["the usual tp", "tp, same as last time", "our usual toilet paper", "tp like last time"]) expect(wantsUsual(t)).toBe(true);
    for (const t of ["tp", "dish soap", "personal"]) expect(wantsUsual(t)).toBe(false);
    expect(stripUsual("the usual tp")).toBe("tp");
    expect(stripUsual("tp, same as last time")).toBe("tp");
  });
});
