// Web sign-up + invite links: reserve a Restock number on the web, activate with the first text,
// join households through the owner's link, and relay household news to everyone's own thread.
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, householdsForPhone, resetStore } from "../src/core/store.js";
import {
  activateFromFirstText, householdForInvite, inviteCodeFor, MAX_OPEN_SIGNUPS, resetInvite, resetSignups, SIGNUP_TTL_MS, SignupError, startSignup,
} from "../src/core/signups.js";
import { CONSOLE_LINE } from "../src/messaging/photonLines.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound, resetMuted } from "../src/messaging/photon.js";
import { resetConfirmations } from "../src/messaging/confirm.js";
import { resetPayBack } from "../src/payments/payback.js";
import { webRoutes } from "../src/web/routes.js";

const ALEX = "+14255550101", AMBER = "+14255550102", DAVID = "+15095550103";
let n = 0;
let logs: string[];
const out = () => logs.join("\n");

async function dm(from: string, text: string) {
  const msg = { messageId: `s${++n}`, spaceId: `pho_spc_dm_${from}`, spaceKind: "direct" as const, fromPhone: from, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}

beforeEach(() => {
  resetStore();
  resetSignups();
  resetPayBack();
  resetMuted();
  resetConfirmations();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("start a household on the web", () => {
  it("reserves a Restock number; the first text creates the household and sends the invite link", async () => {
    const result = await startSignup({ name: "Alex", phone: "(425) 555-0101" });
    expect(result).toEqual({ line: CONSOLE_LINE, householdName: null });
    expect(householdsForPhone(ALEX)).toHaveLength(0); // nothing exists until they text

    await dm(ALEX, "hi");
    const [h] = householdsForPhone(ALEX);
    expect(h?.members).toMatchObject([{ name: "Alex", role: "owner" }]);
    expect(out()).toMatch(/Welcome to Restock, Alex!.*budget owner/s);
    expect(out()).toMatch(/Invite roommates with this link: http:\/\/localhost:3000\/join\/[A-Za-z0-9_-]{16}/);
  });

  it("signing up twice reuses the same reservation", async () => {
    await startSignup({ name: "Alex", phone: ALEX });
    await startSignup({ name: "Alex", phone: ALEX });
    await dm(ALEX, "hi");
    expect(db.households.size).toBe(1);
  });

  it("rejects bad names, bad numbers, and numbers already in a household", async () => {
    await expect(startSignup({ name: "12", phone: ALEX })).rejects.toThrow(SignupError);
    await expect(startSignup({ name: "Alex", phone: "555-0101" })).rejects.toThrow(/10-digit/);
    await startSignup({ name: "Alex", phone: ALEX });
    await dm(ALEX, "hi");
    await expect(startSignup({ name: "Alex", phone: ALEX })).rejects.toThrow(/already uses Restock.*delete my data/);
  });

  it("unactivated sign-ups expire after 24 hours", async () => {
    const t0 = Date.now();
    await startSignup({ name: "Alex", phone: ALEX }, t0);
    expect(activateFromFirstText(ALEX, t0 + SIGNUP_TTL_MS + 1)).toBeUndefined();
  });

  it("caps open sign-ups (each holds a Photon seat)", async () => {
    for (let i = 0; i < MAX_OPEN_SIGNUPS; i++) await startSignup({ name: "Pat", phone: `+1206555${String(1000 + i)}` });
    await expect(startSignup({ name: "Pat", phone: "+12065559999" })).rejects.toThrow(/capacity/);
  });
});

describe("invite links", () => {
  async function owner() {
    await startSignup({ name: "Alex", phone: ALEX });
    await dm(ALEX, "hi");
    return householdsForPhone(ALEX)[0]!;
  }

  it("joining through the link adds the person on their first text; everyone else hears about it", async () => {
    const h = await owner();
    const code = inviteCodeFor(h, h.ownerId);
    expect(await startSignup({ name: "Amber", phone: AMBER, inviteCode: code })).toEqual({ line: CONSOLE_LINE, householdName: "Alex's household" });
    logs = [];
    await dm(AMBER, "hey!");
    expect(h.members.map((m) => m.name)).toEqual(["Alex", "Amber"]);
    expect(out()).toMatch(/Welcome, Amber! You're in Alex's household/);
    expect(out()).toMatch(/\[photon:console → pho_spc_dm_\+14255550101\]\nAmber joined the household\./); // Alex's own thread
  });

  it("reset links stop working; unknown links are rejected", async () => {
    const h = await owner();
    const old = inviteCodeFor(h, h.ownerId);
    const fresh = resetInvite(h, h.ownerId);
    expect(householdForInvite(old)).toBeUndefined();
    expect(householdForInvite(fresh)?.id).toBe(h.id);
    await expect(startSignup({ name: "Amber", phone: AMBER, inviteCode: old })).rejects.toThrow(/expired or was reset/);
    await expect(startSignup({ name: "Amber", phone: AMBER, inviteCode: "nope" })).rejects.toThrow(/expired or was reset/);
  });

  it("rejects a duplicate name in the household", async () => {
    const h = await owner();
    await expect(startSignup({ name: "alex", phone: AMBER, inviteCode: inviteCodeFor(h, h.ownerId) })).rejects.toThrow(/already a alex/);
  });

  it("owners text 'invite' for the link; members can't", async () => {
    const h = await owner();
    await startSignup({ name: "Amber", phone: AMBER, inviteCode: inviteCodeFor(h, h.ownerId) });
    await dm(AMBER, "hi");
    logs = [];
    await dm(ALEX, "invite");
    expect(out()).toMatch(/Your invite link: http:\/\/localhost:3000\/join\//);
    await dm(AMBER, "invite");
    expect(out()).toMatch(/Only the budget owner can invite people/);
  });
});

describe("household news without a shared group chat", () => {
  it("relays items added to everyone else's thread", async () => {
    await startSignup({ name: "Alex", phone: ALEX });
    await dm(ALEX, "hi");
    const h = householdsForPhone(ALEX)[0]!;
    await startSignup({ name: "David", phone: DAVID, inviteCode: inviteCodeFor(h, h.ownerId) });
    await dm(DAVID, "hi");
    logs = [];
    await dm(ALEX, "add hand soap");
    await dm(ALEX, "1"); // pick from the options
    expect(out()).toMatch(/\[photon:console → pho_spc_dm_\+15095550103\]\nAlex added [^\n]*hand soap/i); // relayed to David
  });
});

describe("HTTP API", () => {
  let server: Server;
  let base: string;
  beforeAll(() => {
    server = express().use(express.json()).use(webRoutes).listen(0);
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("requires consent, then returns the number and an sms: link", async () => {
    expect((await post("/signup/api/start", { name: "Alex", phone: "4255550101" })).status).toBe(400);
    const res = await post("/signup/api/start", { name: "Alex", phone: "4255550101", consent: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      line: CONSOLE_LINE,
      householdName: null,
      smsLink: `sms:${CONSOLE_LINE}&body=hi`,
      contactLink: expect.stringMatching(/\/contact\/%2B16285550100\.vcf$/), // "save restock to contacts"
    });
  });

  it("serves the sign-up pages and rejects bad invite codes", async () => {
    expect((await fetch(`${base}/start`)).status).toBe(200);
    expect((await fetch(`${base}/join/whatever`)).status).toBe(200);
    expect((await fetch(`${base}/privacy`)).status).toBe(200);
    expect((await fetch(`${base}/signup/api/invite/nope`)).status).toBe(404);
  });

  it("rate-limits repeated attempts for one phone", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post("/signup/api/start", { name: "Rae", phone: "2065550177", consent: true })).status);
    expect(codes).toContain(429);
  });

  it("only a logged-in owner can get the invite link", async () => {
    expect((await post("/app/api/invite", {})).status).toBe(403);
  });
});

describe("STOP / START", () => {
  it("STOP silences everything (including relays) until START", async () => {
    await startSignup({ name: "Alex", phone: ALEX });
    await dm(ALEX, "hi");
    const h = householdsForPhone(ALEX)[0]!;
    await startSignup({ name: "Amber", phone: AMBER, inviteCode: inviteCodeFor(h, h.ownerId) });
    await dm(AMBER, "hi");

    await dm(AMBER, "STOP");
    expect(out()).toMatch(/You won't get any more texts from Restock/);
    logs = [];
    await dm(ALEX, "add hand soap");
    await dm(ALEX, "1");
    expect(out()).not.toMatch(/pho_spc_dm_\+14255550102\]/); // nothing relayed to Amber
    await dm(AMBER, "what do I owe?");
    expect(out()).not.toMatch(/pho_spc_dm_\+14255550102\]/); // ignored while stopped

    await dm(AMBER, "start");
    expect(out()).toMatch(/Welcome back! Texts from Restock are on again/);
  });
});

describe("delete my data", () => {
  async function household() {
    await startSignup({ name: "Alex", phone: ALEX });
    await dm(ALEX, "hi");
    const h = householdsForPhone(ALEX)[0]!;
    await startSignup({ name: "Amber", phone: AMBER, inviteCode: inviteCodeFor(h, h.ownerId) });
    await dm(AMBER, "hi");
    return h;
  }

  it("a member asks, confirms with yes, and is removed", async () => {
    const h = await household();
    logs = [];
    await dm(AMBER, "delete my data");
    expect(out()).toMatch(/can't be undone\. Reply "yes"/);
    expect(h.members).toHaveLength(2);
    await dm(AMBER, "yes");
    expect(out()).toMatch(/Your Restock data is deleted/);
    expect(householdsForPhone(AMBER)).toHaveLength(0);
  });

  it("the owner must remove others first; alone, it deletes the household", async () => {
    await household();
    logs = [];
    await dm(ALEX, "leave household");
    await dm(ALEX, "yes");
    expect(out()).toMatch(/remove the others first/);
    await dm(ALEX, "remove member Amber");
    await dm(ALEX, "delete my data");
    await dm(ALEX, "yes");
    expect(db.households.size).toBe(0);
  });

  it("'no' keeps everything", async () => {
    const h = await household();
    await dm(AMBER, "delete my data");
    await dm(AMBER, "no");
    expect(h.members).toHaveLength(2);
  });
});
