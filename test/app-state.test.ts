// The dashboard's data API: logged-in members see only their own household, read-only, with no phone numbers.
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDemo } from "../scripts/seed.js";
import { createHousehold, addMember } from "../src/core/households.js";
import { addItem } from "../src/core/store.js";
import { resetPayBack } from "../src/payments/payback.js";
import { webRoutes } from "../src/web/routes.js";

let server: Server;
let base: string;
let logs: string[];

beforeAll(() => {
  server = express().use(express.json()).use(webRoutes).listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  seedDemo();
  resetPayBack();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const post = (path: string, body: unknown, cookie?: string) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

/** Log in like the dashboard does: request a code by text, read it from the (console-mode) text, verify it. */
async function login(handle: string): Promise<string> {
  await post("/pay/api/start", { handle });
  const code = /Your Restock code is (\d{6})/.exec(logs.join("\n"))?.[1];
  expect(code).toBeDefined();
  const res = await post("/pay/api/verify", { handle, code });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/Path=\/;/); // one login for /pay and /dashboard
  expect(setCookie).toMatch(/HttpOnly/);
  return setCookie.split(";")[0]!;
}

describe("GET /app/api/state", () => {
  it("is 401 without a login", async () => {
    const res = await fetch(`${base}/app/api/state`);
    expect(res.status).toBe(401);
  });

  it("returns the logged-in member's household after the texted-code login", async () => {
    const cookie = await login("+15550000002"); // Jake
    const res = await fetch(`${base}/app/api/state`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const state = await res.json();
    expect(state.me).toMatchObject({ name: "Jake", role: "member" });
    expect(state.household.name).toBe("Sam's household");
    expect(state.members.map((m: { name: string }) => m.name)).toEqual(["Sam", "Jake", "Priya"]);
    expect(state.items).toHaveLength(6);
    expect(Object.values(state.sharesIfOrderedNow as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(7275);
  });

  it("never includes phone numbers, and other members' card digits stay hidden", async () => {
    const cookie = await login("+15550000002");
    const raw = await (await fetch(`${base}/app/api/state`, { headers: { cookie } })).text();
    expect(raw).not.toMatch(/\+1555|phone/i);
    const state = JSON.parse(raw);
    const sam = state.members.find((m: { name: string }) => m.name === "Sam");
    expect(sam).toEqual({ id: "sam", name: "Sam", role: "owner", hasCard: true, canApprove: true, isMe: false });
  });

  it("says whether the space is personal or a group", async () => {
    const cookie = await login("+15550000002");
    const state = await (await fetch(`${base}/app/api/state`, { headers: { cookie } })).json();
    expect(state.household).toMatchObject({ kind: "group" });
  });

  it("shows only your own household", async () => {
    const other = createHousehold("Zoe", "+12065550190");
    addMember(other, "Yuri", "+12065550191");
    addItem({ householdId: other.id, name: "Secret snacks", addedBy: other.ownerId, cents: 999, shared: true });
    const cookie = await login("+12065550191"); // Yuri
    const state = await (await fetch(`${base}/app/api/state`, { headers: { cookie } })).json();
    expect(state.household.name).toBe("Zoe's household");
    expect(state.items.map((i: { name: string }) => i.name)).toEqual(["Secret snacks"]);
    expect(JSON.stringify(state)).not.toMatch(/Sam|Jake|Priya/);
  });

  it("is 401 again after logging out (the dashboard's other APIs too)", async () => {
    expect((await fetch(`${base}/app/api/spaces`)).status).toBe(401);
    expect((await post("/app/api/card-link", {})).status).toBe(401);
    const cookie = await login("+15550000001");
    await post("/pay/api/logout", {}, cookie);
    expect((await fetch(`${base}/app/api/state`, { headers: { cookie } })).status).toBe(401);
  });
});

describe("GET /app/api/spaces", () => {
  it("lists the person's personal space and their group, each as their own record", async () => {
    const ZOE = "+12065550190";
    const group = createHousehold("Zoe", ZOE);
    const personal = createHousehold("Zoe", "+12065550199");
    personal.kind = "personal";
    personal.members[0]!.phone = ZOE; // same person, a one-on-one space too
    addItem({ householdId: personal.id, name: "Face wash", addedBy: personal.ownerId, cents: 899, shared: false });
    const cookie = await login(ZOE);
    const { spaces } = await (await fetch(`${base}/app/api/spaces`, { headers: { cookie } })).json();
    expect(spaces.map((s: { household: { kind: string } }) => s.household.kind).sort()).toEqual(["group", "personal"]);
    const mine = spaces.find((s: { household: { kind: string } }) => s.household.kind === "personal");
    expect(mine.items.map((i: { name: string }) => i.name)).toEqual(["Face wash"]);
    expect(JSON.stringify(spaces)).not.toMatch(/\+1206|Sam|Jake|Priya/);
    expect(group.members).toHaveLength(1);
  });
});

describe("POST /app/api/card-link", () => {
  it("gives you your own add-card link, and never someone else's", async () => {
    const cookie = await login("+15550000003"); // Priya
    const mine = await post("/app/api/card-link", { memberId: "priya" }, cookie);
    expect(mine.status).toBe(200);
    expect((await mine.json()).url).toMatch(/\/c\/[A-Za-z0-9_-]{20,}$/);
    expect((await post("/app/api/card-link", { memberId: "sam" }, cookie)).status).toBe(401);
  });
});

describe("POST /app/api/remove (dashboard Manage group)", () => {
  const SAM = "+15550000001", JAKE = "+15550000002";
  const priyaOwesSam = async () => {
    const { db } = await import("../src/core/store.js");
    const h = [...db.households.values()].find((x) => x.ownerId === "sam")!;
    db.orders.set("o-rm", { id: "o-rm", householdId: h.id, itemIds: [], totalCents: 7275, rule: "smart", createdAt: "2026-10-17T20:00:00Z" });
    db.debts.set("d-rm", { id: "d-rm", orderId: "o-rm", debtorId: "priya", creditorId: "sam", cents: 1015, status: "open" });
    return { db, h };
  };

  it("is owner-only", async () => {
    const cookie = await login(JAKE);
    for (const kind of ["member", "everyone", "household"]) {
      const res = await post("/app/api/remove", { kind, targetId: "priya" }, cookie);
      expect(res.status).toBe(403);
    }
    expect((await post("/app/api/remove", { kind: "everyone" })).status).toBe(403);
  });

  it("asks first and lists open debts, then deletes the group on confirm; the debt survives", async () => {
    const { db, h } = await priyaOwesSam();
    const cookie = await login(SAM);
    const preview = await (await post("/app/api/remove", { kind: "household" }, cookie)).json();
    expect(preview).toMatchObject({ confirmNeeded: true, balances: [{ from: "Priya", to: "Sam", cents: 1015 }] });
    expect(preview.question).toMatch(/^Delete Sam's household\?/);
    expect(db.households.has(h.id)).toBe(true); // nothing happens without confirm

    const done = await (await post("/app/api/remove", { kind: "household", confirm: true }, cookie)).json();
    expect(done).toMatchObject({ done: true });
    expect(db.households.has(h.id)).toBe(false);
    expect(db.debts.get("d-rm")?.status).toBe("open");
    expect(logs.join("\n")).toMatch(/Sam deleted Sam's household.*You still owe \$10\.15/);
  });

  it("removes one member or everyone, with no warning when nobody owes", async () => {
    const { db } = await import("../src/core/store.js");
    for (const d of db.debts.values()) d.status = "paid";
    const cookie = await login(SAM);
    const preview = await (await post("/app/api/remove", { kind: "member", targetId: "jake" }, cookie)).json();
    expect(preview).toMatchObject({ confirmNeeded: true, question: "Remove Jake from Sam's household?", balances: [] });
    await post("/app/api/remove", { kind: "member", targetId: "jake", confirm: true }, cookie);
    let state = await (await fetch(`${base}/app/api/state`, { headers: { cookie } })).json();
    expect(state.members.map((m: { name: string }) => m.name)).toEqual(["Sam", "Priya"]);

    expect((await post("/app/api/remove", { kind: "member", targetId: "sam", confirm: true }, cookie)).status).toBe(400);
    await post("/app/api/remove", { kind: "everyone", confirm: true }, cookie);
    state = await (await fetch(`${base}/app/api/state`, { headers: { cookie } })).json();
    expect(state.members.map((m: { name: string }) => m.name)).toEqual(["Sam"]);
  });
});
