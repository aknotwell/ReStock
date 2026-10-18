// Keeps the store on disk so a restart or redeploy doesn't wipe the household.
//
// Approach: the app keeps working on the in-memory store (store.ts) exactly as before. We save a
// full copy to SQLite whenever it changes (it's a few KB) and load it back at startup. Other
// modules with state that must survive a restart (link tokens, reply routing, open questions)
// register a dump/load pair with `registerState`.
//
// We never store message bodies, prompts, model responses, or card numbers.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Charge, Debt, Household, Item, Order } from "../types.js";
import { db } from "./store.js";

const SCHEMA_VERSION = 1;

type StateSection = { dump: () => unknown; load: (data: unknown) => void };
const sections = new Map<string, StateSection>();

/** Let a module persist its own in-memory state. `load` must accept whatever `dump` returned. */
export function registerState(name: string, section: StateSection): void {
  sections.set(name, section);
}

let database: DatabaseSync | undefined;
let lastSaved = "";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS households (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, household_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, household_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS charges (seq INTEGER PRIMARY KEY, order_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS debts (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS state (name TEXT PRIMARY KEY, data TEXT NOT NULL);
`;

/**
 * Open (or create) the database file and load whatever it holds into the in-memory store.
 * Returns true if it found saved households, so the caller can skip seeding the demo.
 */
export function openDatabase(file: string): boolean {
  closeDatabase();
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  database.exec(SCHEMA);
  const version = database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (version && Number(version.value) !== SCHEMA_VERSION) {
    throw new Error(`Database schema ${version.value} doesn't match this code (${SCHEMA_VERSION}). Delete the file to start fresh.`);
  }
  const restored = load(database);
  lastSaved = snapshot();
  return restored;
}

function rows<T>(d: DatabaseSync, sql: string): T[] {
  return (d.prepare(sql).all() as { data: string }[]).map((r) => JSON.parse(r.data) as T);
}

function load(d: DatabaseSync): boolean {
  const households = rows<Household>(d, "SELECT data FROM households");
  if (!households.length) return false;
  db.households.clear();
  db.items.clear();
  db.orders.clear();
  db.debts.clear();
  db.charges.length = 0;
  for (const h of households) db.households.set(h.id, h);
  for (const i of rows<Item>(d, "SELECT data FROM items")) db.items.set(i.id, i);
  for (const o of rows<Order>(d, "SELECT data FROM orders")) db.orders.set(o.id, o);
  db.charges.push(...rows<Charge>(d, "SELECT data FROM charges ORDER BY seq"));
  for (const x of rows<Debt>(d, "SELECT data FROM debts")) db.debts.set(x.id, x);
  for (const r of d.prepare("SELECT name, data FROM state").all() as { name: string; data: string }[]) {
    try {
      sections.get(r.name)?.load(JSON.parse(r.data));
    } catch (err) {
      // One bad section shouldn't block startup; that module just starts empty.
      console.error(`Couldn't restore saved ${r.name}:`, err instanceof Error ? err.message : err);
    }
  }
  return true;
}

function snapshot(): string {
  const state: Record<string, unknown> = {};
  for (const [name, s] of sections) state[name] = s.dump();
  return JSON.stringify({
    households: [...db.households.values()],
    items: [...db.items.values()],
    orders: [...db.orders.values()],
    charges: db.charges,
    debts: [...db.debts.values()],
    state,
  });
}

/** Write the whole store if anything changed since the last save. Cheap to call often. */
export function saveNow(): boolean {
  if (!database) return false;
  const current = snapshot();
  if (current === lastSaved) return false;
  const d = database;
  const data = JSON.parse(current) as {
    households: Household[]; items: Item[]; orders: Order[]; charges: Charge[]; debts: Debt[]; state: Record<string, unknown>;
  };
  d.exec("BEGIN IMMEDIATE");
  try {
    for (const t of ["households", "items", "orders", "charges", "debts", "state"]) d.exec(`DELETE FROM ${t}`);
    const put = (sql: string, ...args: (string | number)[]) => d.prepare(sql).run(...args);
    for (const h of data.households) put("INSERT INTO households (id, data) VALUES (?, ?)", h.id, JSON.stringify(h));
    for (const i of data.items) put("INSERT INTO items (id, household_id, data) VALUES (?, ?, ?)", i.id, i.householdId, JSON.stringify(i));
    for (const o of data.orders) put("INSERT INTO orders (id, household_id, data) VALUES (?, ?, ?)", o.id, o.householdId, JSON.stringify(o));
    data.charges.forEach((c, seq) => put("INSERT INTO charges (seq, order_id, data) VALUES (?, ?, ?)", seq, c.orderId, JSON.stringify(c)));
    for (const x of data.debts) put("INSERT INTO debts (id, order_id, data) VALUES (?, ?, ?)", x.id, x.orderId, JSON.stringify(x));
    for (const [name, value] of Object.entries(data.state)) put("INSERT INTO state (name, data) VALUES (?, ?)", name, JSON.stringify(value));
    put("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION));
    put("INSERT OR REPLACE INTO meta (key, value) VALUES ('saved_at', ?)", new Date().toISOString());
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  lastSaved = current;
  return true;
}

let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Save every `intervalMs` when something changed, and once more on shutdown. Texts arrive by
 * polling (not HTTP), so a timer catches changes that no request handler sees.
 */
export function startAutosave(intervalMs = 1000): void {
  if (!database || timer) return;
  const safeSave = () => {
    try {
      saveNow();
    } catch (err) {
      console.error("Saving the database failed:", err instanceof Error ? err.message : err);
    }
  };
  timer = setInterval(safeSave, intervalMs);
  timer.unref();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      safeSave();
      process.exit(0);
    });
  }
}

export function closeDatabase(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  database?.close();
  database = undefined;
  lastSaved = "";
}
