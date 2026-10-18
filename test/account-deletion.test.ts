// Deleting your data (or being removed) also removes you from Photon: the shared-line assignment that maps
// your phone to a Restock number is released, failed releases are retried, and cached Photon state is dropped.
import { beforeEach, describe, expect, it, vi } from "vitest";

const photonLines = vi.hoisted(() => ({
  assignLine: vi.fn(async (phone: string) => ({ assignmentId: `asg-${phone}`, line: "+16285550100" })),
  releaseLine: vi.fn(async (_id: string) => true),
  releaseLinesForHandle: vi.fn(async (_phone: string) => true),
}));
vi.mock("../src/messaging/photonLines.js", async (orig) => ({ ...(await orig<object>()), ...photonLines }));
const fakeStripe = vi.hoisted(() => ({ customers: { del: vi.fn(async (id: string) => ({ id, deleted: true })) } }));
vi.mock("../src/payments/stripe.js", () => ({ stripe: fakeStripe, requireStripe: () => fakeStripe }));

import Stripe from "stripe";
import { pendingCustomerDeletions, resetCustomerDeletions, retryCustomerDeletions } from "../src/payments/deleteCustomer.js";

import { householdsForPhone, resetStore } from "../src/core/store.js";
import { inviteCodeFor, resetSignups, startSignup, sweepExpiredSignups, unreleasedLines } from "../src/core/signups.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound, resetMuted } from "../src/messaging/photon.js";
import { resetConfirmations } from "../src/messaging/confirm.js";
import { resetPayBack } from "../src/payments/payback.js";

const ALEX = "+14255550101", AMBER = "+14255550102";
let n = 0;
let logs: string[];

async function dm(from: string, text: string) {
  const msg = { messageId: `pd${++n}`, spaceId: `pho_spc_dm_${from}`, spaceKind: "direct" as const, fromPhone: from, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}

async function household() {
  await startSignup({ name: "Alex", phone: ALEX });
  await dm(ALEX, "hi");
  const h = householdsForPhone(ALEX)[0]!;
  await startSignup({ name: "Amber", phone: AMBER, inviteCode: inviteCodeFor(h, h.ownerId) });
  await dm(AMBER, "hi");
  return h;
}

beforeEach(() => {
  resetStore();
  resetSignups();
  resetPayBack();
  resetMuted();
  resetConfirmations();
  resetCustomerDeletions();
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("account deletion reaches Photon", () => {
  it("'delete my data' releases the member's Photon line, by assignment and by phone", async () => {
    await household();
    await dm(AMBER, "delete my data");
    expect(photonLines.releaseLine).not.toHaveBeenCalled(); // nothing happens before "yes"
    await dm(AMBER, "yes");
    expect(photonLines.releaseLine).toHaveBeenCalledWith(`asg-${AMBER}`);
    expect(photonLines.releaseLinesForHandle).toHaveBeenCalledWith(AMBER);
    expect(photonLines.releaseLine).not.toHaveBeenCalledWith(`asg-${ALEX}`);
  });

  it("the owner deleting their household releases their own line", async () => {
    await startSignup({ name: "Alex", phone: ALEX });
    await dm(ALEX, "hi");
    await dm(ALEX, "delete my data");
    await dm(ALEX, "yes");
    expect(householdsForPhone(ALEX)).toHaveLength(0);
    expect(photonLines.releaseLine).toHaveBeenCalledWith(`asg-${ALEX}`);
  });

  it("the owner removing someone releases that person's line", async () => {
    await household();
    await dm(ALEX, "remove member Amber");
    expect(photonLines.releaseLine).toHaveBeenCalledWith(`asg-${AMBER}`);
    expect(photonLines.releaseLinesForHandle).toHaveBeenCalledWith(AMBER);
  });

  it("a failed release is kept and retried by the sweep until Photon accepts it", async () => {
    await household();
    photonLines.releaseLine.mockResolvedValueOnce(false);
    await dm(AMBER, "delete my data");
    await dm(AMBER, "yes");
    expect(householdsForPhone(AMBER)).toHaveLength(0); // our side is deleted right away
    expect(unreleasedLines()).toEqual([`asg-${AMBER}`]);
    await sweepExpiredSignups();
    expect(photonLines.releaseLine).toHaveBeenLastCalledWith(`asg-${AMBER}`);
    expect(unreleasedLines()).toEqual([]);
  });

  it("they can sign up again later with a fresh Photon assignment", async () => {
    await household();
    await dm(AMBER, "delete my data");
    await dm(AMBER, "yes");
    const later = Date.now() + 5 * 60_000;
    await startSignup({ name: "Amber", phone: AMBER }, later);
    const keys = photonLines.assignLine.mock.calls.filter(([phone]) => phone === AMBER).map((c) => (c as unknown[])[2]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]); // a reused key would return the released assignment
  });
});

describe("account deletion reaches Stripe", () => {
  const withCard = (phone: string, customerId: string) => {
    const m = householdsForPhone(phone)[0]!.members.find((x) => x.phone === phone)!;
    m.stripeCustomerId = customerId;
  };

  it("'delete my data' deletes the member's Stripe customer (and with it their saved card)", async () => {
    await household();
    withCard(AMBER, "cus_amber");
    await dm(AMBER, "delete my data");
    expect(fakeStripe.customers.del).not.toHaveBeenCalled(); // nothing happens before "yes"
    await dm(AMBER, "yes");
    expect(fakeStripe.customers.del).toHaveBeenCalledWith("cus_amber");
    expect(fakeStripe.customers.del).toHaveBeenCalledTimes(1);
  });

  it("the owner removing someone deletes that person's Stripe customer, not the owner's", async () => {
    await household();
    withCard(ALEX, "cus_alex");
    withCard(AMBER, "cus_amber");
    await dm(ALEX, "remove member Amber");
    expect(fakeStripe.customers.del).toHaveBeenCalledWith("cus_amber");
    expect(fakeStripe.customers.del).not.toHaveBeenCalledWith("cus_alex");
  });

  it("someone who never added a card makes no Stripe call", async () => {
    await household();
    await dm(AMBER, "delete my data");
    await dm(AMBER, "yes");
    expect(fakeStripe.customers.del).not.toHaveBeenCalled();
  });

  it("a failed deletion is kept and retried; one Stripe already deleted counts as done", async () => {
    await household();
    withCard(AMBER, "cus_amber");
    fakeStripe.customers.del.mockRejectedValueOnce(new Error("network down"));
    await dm(AMBER, "delete my data");
    await dm(AMBER, "yes");
    expect(householdsForPhone(AMBER)).toHaveLength(0); // our side is deleted right away
    expect(pendingCustomerDeletions()).toEqual(["cus_amber"]);
    fakeStripe.customers.del.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "resource_missing", message: "No such customer" }),
    );
    await retryCustomerDeletions();
    expect(pendingCustomerDeletions()).toEqual([]);
  });
});
