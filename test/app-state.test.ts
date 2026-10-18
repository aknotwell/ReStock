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
    expect(sam).toEqual({ id: "sam", name: "Sam", role: "owner", hasCard: true, isMe: false });
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

  it("is 401 again after logging out", async () => {
    const cookie = await login("+15550000001");
    await post("/pay/api/logout", {}, cookie);
    expect((await fetch(`${base}/app/api/state`, { headers: { cookie } })).status).toBe(401);
  });
});
