// Bugs found in a review of the whole repo: Restock numbers (Photon lines) for people who already use Restock,
// and the audit endpoint's sandbox. Each test failed before its fix.
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Photon gives a phone one live assignment: signing up again hands back the same one. Record what's released.
const lines = vi.hoisted(() => ({ assigned: [] as string[], released: [] as string[] }));
vi.mock("../src/ai/client.js", () => ({ anthropic: undefined, MODEL: "test" }));
vi.mock("../src/messaging/photonLines.js", async (orig) => {
  const real = await orig<typeof import("../src/messaging/photonLines.js")>();
  return {
    ...real,
    assignLine: vi.fn(async (phone: string) => {
      lines.assigned.push(phone);
      return { assignmentId: `asg-${phone}`, line: real.CONSOLE_LINE };
    }),
    releaseLine: vi.fn(async (id: string) => {
      lines.released.push(id);
      return true;
    }),
    releaseLinesForHandle: vi.fn(async () => true),
  };
});

const { activeHousehold, createHousehold } = await import("../src/core/households.js");
const { db, householdsForPhone, resetStore } = await import("../src/core/store.js");
const { cancelInvite, inviteCodeFor, invitedTo, isPendingSignup, resetSignups, SIGNUP_TTL_MS, startSignup, sweepExpiredSignups } = await import(
  "../src/core/signups.js"
);
const { handleInbound } = await import("../src/messaging/inbound.js");
const { rememberInbound } = await import("../src/messaging/photon.js");
const { proposeAction, resetConfirmations } = await import("../src/messaging/confirm.js");
const { agentApi } = await import("../src/web/agentApi.js");

const ALEX = "+14255550101", BEA = "+15095550103", CAL = "+12065550177";
let n = 0;
let logs: string[];
const out = () => logs.join("\n");

async function dm(from: string, text: string) {
  const msg = { messageId: `ls${++n}`, spaceId: `pho_spc_dm_${from}`, spaceKind: "direct" as const, fromPhone: from, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}

beforeEach(() => {
  resetStore();
  resetSignups();
  resetConfirmations();
  lines.assigned.length = 0;
  lines.released.length = 0;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a sign-up or invite for someone who already uses Restock never releases their number", () => {
  it("an expired second sign-up leaves the line they already text on", async () => {
    const t0 = Date.now();
    await startSignup({ name: "Alex", phone: ALEX }, t0);
    await dm(ALEX, "hi"); // activated: Alex's household, on asg-ALEX
    expect(householdsForPhone(ALEX)).toHaveLength(1);

    await startSignup({ name: "Alex", phone: ALEX }, t0 + 1000); // starts another household on the web, never texts
    await sweepExpiredSignups(t0 + SIGNUP_TTL_MS + 5000);
    expect(isPendingSignup(ALEX, t0 + SIGNUP_TTL_MS + 5000)).toBe(false);
    expect(lines.released).not.toContain(`asg-${ALEX}`);
  });

  it("cancelling an invite to an existing user keeps their line; a new person's is still freed", async () => {
    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    createHousehold("Bea", BEA, { name: "Book Club" });
    const code = inviteCodeFor(maple, maple.ownerId);
    await startSignup({ name: "Bea", phone: BEA, inviteCode: code }); // Bea opens Alex's link
    await startSignup({ name: "Cal", phone: CAL, inviteCode: code }); // Cal is new to Restock
    expect(await cancelInvite(maple.id, "Bea")).toBe("Bea");
    expect(await cancelInvite(maple.id, "Cal")).toBe("Cal");
    expect(lines.released).not.toContain(`asg-${BEA}`);
    expect(lines.released).toContain(`asg-${CAL}`);
  });
});

describe("inviting someone who already uses Restock by text", () => {
  it("texts them a join code instead of joining them with whatever they text next", async () => {
    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    const club = createHousehold("Bea", BEA, { name: "Book Club" });
    await dm(BEA, "hi"); // Bea has a thread with Restock
    logs = [];
    await dm(ALEX, "invite Bea 509-555-0103");
    expect(out()).toMatch(/Bea already uses Restock/);
    const code = /join ([A-Za-z0-9_-]{16})/.exec(out())?.[1];
    expect(code).toBeDefined();
    expect(isPendingSignup(BEA)).toBe(false);
    expect(lines.assigned).not.toContain(BEA); // no new Restock number reserved

    await dm(BEA, "add dish soap"); // about her own household
    expect(maple.members.map((m) => m.name)).toEqual(["Alex"]);
    expect(activeHousehold(BEA)?.id).toBe(club.id);

    await dm(BEA, `join ${code}`); // her choice
    expect(maple.members.map((m) => m.name)).toEqual(["Alex", "Bea"]);
  });
});

describe("the audit endpoint's sandbox", () => {
  let server: Server;
  let base: string;
  beforeAll(() => {
    server = express().use(express.json()).post("/api/agent", agentApi).listen(0);
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  const ask = async (message: string) =>
    ((await (await fetch(`${base}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })).json()) as { reply: string }).reply;

  it("can't reserve Restock numbers for real phones, start households, or join one", async () => {
    expect(await ask("invite Bob 206-555-0123")).toMatch(/sandbox/i);
    expect(lines.assigned).toEqual([]);
    expect(invitedTo("sandbox")).toEqual([]);

    await ask("new household called Test Lab");
    expect(householdsForPhone("sandbox-tester").map((h) => h.id)).toEqual(["sandbox"]);

    const maple = createHousehold("Alex", ALEX, { name: "Maple House" });
    await ask(`join ${inviteCodeFor(maple, maple.ownerId)}`);
    expect(maple.members).toHaveLength(1);

    // A membership change the model proposed can't be confirmed there either.
    proposeAction("sandbox-tester", { kind: "membership", command: { type: "add_member", name: "Bob", phone: "+12065550123" } });
    expect(await ask("yes")).toMatch(/sandbox/i);
    expect(lines.assigned).toEqual([]);
  });

  it("still handles shopping and questions as before", async () => {
    expect(await ask("add dish soap")).toMatch(/Which one\?/);
    expect(await ask("who is in the house?")).toMatch(/Tester \(budget owner\)/);
    expect([...db.households.keys()]).toContain("sandbox");
  });
});
