// Saved data survives a restart: households, carts, orders, debts, texted links, open questions.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", () => ({ gemini: undefined, MODEL: "test" }));

let dir: string;
let file: string;

/** A fresh copy of every module, like a new server process. */
async function boot() {
  vi.resetModules();
  const persist = await import("../src/core/persist.js");
  const store = await import("../src/core/store.js");
  const seed = await import("../scripts/seed.js");
  const links = await import("../src/payments/links.js");
  const options = await import("../src/messaging/options.js");
  const photon = await import("../src/messaging/photon.js");
  const inbound = await import("../src/messaging/inbound.js");
  const catalog = await import("../src/core/catalog.js");
  return { persist, store, seed, links, options, photon, inbound, catalog };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "restock-db-"));
  file = path.join(dir, "nested", "restock.db");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  (await import("../src/core/persist.js")).closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

describe("SQLite persistence", () => {
  it("a new database starts empty and creates its folder", async () => {
    const { persist } = await boot();
    expect(persist.openDatabase(file)).toBe(false);
  });

  it("restores households, items, orders, charges and debts exactly", async () => {
    const a = await boot();
    a.persist.openDatabase(file);
    const h = a.seed.seedDemo();
    const [first] = a.store.pendingItems(h.id);
    first!.status = "ordered";
    a.store.db.orders.set("o1", { id: "o1", householdId: h.id, itemIds: [first!.id], totalCents: first!.cents, rule: "smart", createdAt: "2026-10-17T20:00:00.000Z" });
    a.store.db.charges.push({ orderId: "o1", memberId: "sam", cents: 1199, paidBy: "sam", status: "succeeded" });
    a.store.db.debts.set("d1", { id: "d1", orderId: "o1", debtorId: "priya", creditorId: "sam", cents: 400, status: "open" });
    h.spentCents = 1199;
    expect(a.persist.saveNow()).toBe(true);
    const before = JSON.stringify({ h: [...a.store.db.households], i: [...a.store.db.items], o: [...a.store.db.orders], c: a.store.db.charges, d: [...a.store.db.debts] });
    a.persist.closeDatabase();

    const b = await boot();
    expect(b.persist.openDatabase(file)).toBe(true);
    const after = JSON.stringify({ h: [...b.store.db.households], i: [...b.store.db.items], o: [...b.store.db.orders], c: b.store.db.charges, d: [...b.store.db.debts] });
    expect(after).toBe(before);
  });

  it("only writes when something changed", async () => {
    const { persist, seed, store } = await boot();
    persist.openDatabase(file);
    seed.seedDemo();
    expect(persist.saveNow()).toBe(true);
    expect(persist.saveNow()).toBe(false);
    store.pendingItems("demo-house")[0]!.shared = false;
    expect(persist.saveNow()).toBe(true);
  });

  it("pay-back links texted before a restart still open after it", async () => {
    const a = await boot();
    a.persist.openDatabase(file);
    a.seed.seedDemo();
    a.store.db.debts.set("small", { id: "small", orderId: "o", debtorId: "priya", creditorId: "sam", cents: 30, status: "open" });
    a.store.db.debts.set("done", { id: "done", orderId: "o", debtorId: "priya", creditorId: "sam", cents: 900, status: "paid" });
    const tokenOf = (url: string) => url.split("/p/")[1]!;
    const small = tokenOf(await a.links.createPayBackLink("small"));
    const done = tokenOf(await a.links.createPayBackLink("done"));
    a.persist.saveNow();
    a.persist.closeDatabase();

    const b = await boot();
    expect(await b.links.openPayBackLink(small)).toMatchObject({ kind: "not_found" }); // nothing loaded yet
    b.persist.openDatabase(file);
    expect(await b.links.openPayBackLink(small)).toMatchObject({ kind: "too_small", cents: 30 });
    // Any pay-back link pays everything still owed to that person, so the paid debt's link shows the 30¢ left.
    expect(await b.links.openPayBackLink(done)).toMatchObject({ kind: "too_small", cents: 30 });
  });

  it("expired links are dropped when loading", async () => {
    const a = await boot();
    a.persist.openDatabase(file);
    a.seed.seedDemo();
    a.store.db.debts.set("old", { id: "old", orderId: "o", debtorId: "priya", creditorId: "sam", cents: 30, status: "open" });
    const longAgo = Date.now() - a.links.PAY_BACK_LINK_TTL_MS - 1000;
    const token = (await a.links.createPayBackLink("old", longAgo)).split("/p/")[1]!;
    a.persist.saveNow();
    a.persist.closeDatabase();

    const b = await boot();
    b.persist.openDatabase(file);
    expect(await b.links.openPayBackLink(token)).toMatchObject({ kind: "not_found" });
  });

  it("an open 'Which one?' question survives a restart", async () => {
    const a = await boot();
    a.persist.openDatabase(file);
    a.seed.seedDemo();
    a.options.queueChoices("demo-house", "sam", [a.options.buildChoice("demo-house", a.catalog.getProduct("tp-12")!, null)]);
    a.persist.saveNow();
    a.persist.closeDatabase();

    const b = await boot();
    b.persist.openDatabase(file);
    expect(b.options.resolvePick("demo-house", "sam", 2)).toMatchObject({ kind: "picked", product: { id: "tp-12" } });
  });

  it("resumes polling where it left off, but not after a long outage", async () => {
    const a = await boot();
    a.persist.openDatabase(file);
    a.seed.seedDemo();
    a.persist.saveNow();
    a.persist.closeDatabase();
    // The poller handled a message 2 minutes before "now". Write that position the way a save would.
    const now = Date.parse("2026-10-17T22:00:00Z");
    const saved = { agentBySpace: [], dmByHandle: [], since: "2026-10-17T21:58:00.000Z", seen: ["m1"] };
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT OR REPLACE INTO state (name, data) VALUES ('photon', ?)").run(JSON.stringify(saved));
    raw.close();

    const b = await boot();
    b.persist.openDatabase(file);
    expect(b.photon.pollStart(now)).toBe("2026-10-17T21:58:00.000Z");
    expect(b.photon.pollStart(now + 15 * 60 * 1000)).toBe(new Date(now + 15 * 60 * 1000 - 5000).toISOString());
  });

  it("never stores message text", async () => {
    const a = await boot();
    a.persist.openDatabase(file);
    a.seed.seedDemo();
    const msg = { messageId: "x1", spaceId: "pho_spc_group", spaceKind: "group" as const, fromPhone: "+15550000001", text: "add tp please-zebra-marker", agentUserId: "agent" };
    a.photon.rememberInbound(msg);
    await a.inbound.handleInbound(msg);
    a.persist.saveNow();
    a.persist.closeDatabase();
    for (const f of [file, `${file}-wal`]) {
      let bytes = "";
      try { bytes = readFileSync(f).toString("latin1"); } catch { /* no WAL file */ }
      expect(bytes).not.toContain("zebra-marker");
    }
  });

  it("refuses a database from a different schema version", async () => {
    const a = await boot();
    a.persist.openDatabase(file);
    a.persist.closeDatabase();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '99')").run();
    raw.close();
    const b = await boot();
    expect(() => b.persist.openDatabase(file)).toThrow(/schema 99/);
  });
});
