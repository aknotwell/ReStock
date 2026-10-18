// An approver who hasn't texted Restock yet only gets the request queued (shared lines can't text first).
// The requester must not be told that approver was asked; they're told to have them text Restock instead.
import { beforeEach, describe, expect, it, vi } from "vitest";

const outcome = new Map<string, "sent" | "queued" | "throw">();
vi.mock("../src/messaging/photon.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messaging/photon.js")>();
  return {
    ...actual,
    sendPrivate: vi.fn(async (memberId: string) => {
      const o = outcome.get(memberId) ?? "sent";
      if (o === "throw") throw new Error("photon down");
      return o;
    }),
  };
});

const { createHousehold, addMember } = await import("../src/core/households.js");
const { pendingItems, resetStore } = await import("../src/core/store.js");
const { handleInbound } = await import("../src/messaging/inbound.js");
const { rememberInbound } = await import("../src/messaging/photon.js");

let n = 0;
let logs: string[];
const out = () => logs.join("\n");
async function dm(from: string, text: string) {
  const msg = { messageId: `q${++n}`, spaceId: `pho_spc_dm_${from}`, spaceKind: "direct" as const, fromPhone: from, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}

let householdId: string;
beforeEach(() => {
  resetStore();
  outcome.clear();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = createHousehold("Alex", "+14255550101"); // owner, can approve
  const sam = addMember(h, "Sam", "+14255550104");
  sam.canApprove = true; // a second approver
  const david = addMember(h, "David", "+15095550103");
  david.canApprove = false; // his items wait
  outcome.set(sam.id, "sent");
  householdId = h.id;
});

async function davidAddsSoap() {
  await dm("+15095550103", "add hand soap");
  await dm("+15095550103", "1");
}

describe("approval requests and approvers who haven't texted yet", () => {
  it("names only approvers actually reached, and flags the queued ones", async () => {
    outcome.set(pendingOwnerId(), "queued");
    await davidAddsSoap();
    expect(out()).toMatch(/I've asked Sam to approve it\./);
    expect(out()).not.toMatch(/I've asked Alex/);
    expect(out()).toMatch(/Alex hasn't texted me directly yet, so I couldn't send your request\. Ask them to text me/);
    expect(pendingItems(householdId).some((i) => i.needsApproval)).toBe(true);
  });

  it("when nobody could be reached, it doesn't claim anyone was asked", async () => {
    for (const id of ["alex", "sam"]) outcome.set(id, "queued");
    await davidAddsSoap();
    expect(out()).not.toMatch(/I've asked/);
    expect(out()).toMatch(/Alex and Sam haven't texted me directly yet/);
  });

  it("a send that throws is still only logged, never reported as reached", async () => {
    outcome.set(pendingOwnerId(), "throw");
    await davidAddsSoap();
    expect(out()).toMatch(/I've asked Sam to approve it\./);
    expect(out()).not.toMatch(/I've asked Alex|Alex hasn't texted/);
    expect(console.warn).toHaveBeenCalledWith("approval request failed:", "photon down");
  });
});

function pendingOwnerId(): string {
  return "alex";
}
