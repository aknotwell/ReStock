// Approval requests must reach the approvers, and the requester hears when it's approved.
// Households without a shared group chat (everyone texts their own Restock number) get these privately.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHousehold, addMember } from "../src/core/households.js";
import { pendingItems, resetStore } from "../src/core/store.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound } from "../src/messaging/photon.js";
import { resetConfirmations } from "../src/messaging/confirm.js";

const ALEX = "+14255550101", DAVID = "+15095550103";
let n = 0;
let logs: string[];
const out = () => logs.join("\n");
const thread = (phone: string) => `[photon:console → pho_spc_dm_${phone}]`;

async function dm(from: string, text: string) {
  const msg = { messageId: `a${++n}`, spaceId: `pho_spc_dm_${from}`, spaceKind: "direct" as const, fromPhone: from, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}

let householdId: string;
beforeEach(async () => {
  resetStore();
  resetConfirmations();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = createHousehold("Alex", ALEX);
  const david = addMember(h, "David", DAVID);
  david.canApprove = false; // David's items wait for Alex
  householdId = h.id;
  await dm(ALEX, "hi"); // both have their own Restock thread; no shared group chat
  await dm(DAVID, "hi");
  logs = [];
});

describe("approval requests without a group chat", () => {
  it("sends the request to the owner privately, not just a promise to the requester", async () => {
    await dm(DAVID, "add hand soap");
    await dm(DAVID, "1");
    expect(out()).toMatch(/I've asked Alex to approve it/);
    // The bug: Alex never got anything. Now Alex's own thread has the request.
    const toAlex = out().split(thread(ALEX)).slice(1).join("\n");
    expect(toAlex).toMatch(/David asked for [^\n]*hand soap[^\n]*\. Reply "yes" to add it to the cart\./i);
    expect(pendingItems(householdId).find((i) => /hand soap/i.test(i.name))?.needsApproval).toBe(true);
  });

  it("the owner's yes approves it and tells the requester", async () => {
    await dm(DAVID, "add hand soap");
    await dm(DAVID, "1");
    logs = [];
    await dm(ALEX, "yes");
    expect(pendingItems(householdId).some((i) => i.needsApproval)).toBe(false);
    const toDavid = out().split(thread(DAVID)).slice(1).join("\n");
    expect(toDavid).toMatch(/Alex approved [^\n]*hand soap[^\n]*\. It'll be in the next order\./i);
  });
});

describe("who gets the request", () => {
  it("only approvers (not other members, not the requester) get it", async () => {
    const h = createHousehold("Kim", "+12065550170");
    const lee = addMember(h, "Lee", "+12065550171");
    const mo = addMember(h, "Mo", "+12065550172");
    lee.canApprove = false;
    mo.canApprove = false;
    for (const p of ["+12065550170", "+12065550171", "+12065550172"]) await dm(p, "hi");
    logs = [];
    await dm("+12065550171", "add hand soap");
    await dm("+12065550171", "1");
    const after = (phone: string) => out().split(thread(phone)).slice(1).join("\n");
    expect(after("+12065550170")).toMatch(/Lee asked for/); // Kim, the owner
    expect(after("+12065550172")).not.toMatch(/asked for/); // Mo can't approve
  });
});
