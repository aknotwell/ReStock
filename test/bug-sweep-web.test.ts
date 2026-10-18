// Bugs found in a review of the whole repo: web routes. Each test failed before its fix.
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", () => ({ anthropic: undefined, MODEL: "test" }));

import { createHousehold } from "../src/core/households.js";
import { resetStore } from "../src/core/store.js";
import { rememberInbound } from "../src/messaging/photon.js";
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
  resetStore();
  resetPayBack();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const codesSent = () => logs.filter((l) => /Your Restock code is/.test(l)).length;

describe("login codes are rate limited", () => {
  it("one phone can't be sent unlimited codes (texting someone over and over, or guessing codes)", async () => {
    const phone = "+14255550142";
    createHousehold("Alex", phone);
    rememberInbound({ messageId: "m1", spaceId: "pho_spc_dm_alex", spaceKind: "direct", fromPhone: phone, text: "hi", agentUserId: "pho_usr_agent" });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await post("/pay/api/start", { handle: "425-555-0142" })).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect(codesSent()).toBe(5);
  });

  it("the same limit applies to numbers nobody uses, so it doesn't reveal who has an account", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post("/pay/api/start", { handle: "206-555-0177" })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it("code checks are limited per phone too", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await post("/pay/api/verify", { handle: "509-555-0103", code: String(100000 + i) })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe("routes that crashed or pointed people to a group chat", () => {
  it("a contact-card URL with a stray % is a 404, not a server error", async () => {
    expect((await fetch(`${base}/contact/%25E0.vcf`)).status).toBe(404);
  });

  it("expired texted links say how to get a new one without a group chat", async () => {
    const card = await fetch(`${base}/c/not-a-real-token`);
    expect(card.status).toBe(404);
    expect(await card.text()).toMatch(/text Restock "add card"/i);
    const pay = await fetch(`${base}/p/not-a-real-token`);
    expect(pay.status).toBe(404);
    const text = await pay.text();
    expect(text).not.toMatch(/group chat/);
    expect(text).toMatch(/\/pay/);
  });
});
