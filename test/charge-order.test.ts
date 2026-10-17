import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Household, Order, Shares } from "../src/types.js";

// Fake Stripe. `cardBehavior[memberId]` decides what happens when that member's card is used.
type Behavior = "ok" | "decline" | "needs_3ds" | "network" | "already_captured";
let cardBehavior: Record<string, Behavior> = {};
let n = 0;
const fakeStripe = {
  paymentIntents: {
    create: vi.fn(async (params: { amount: number; metadata: { memberId: string } }) => {
      const id = `pi_${params.metadata.memberId}_${++n}`;
      switch (cardBehavior[params.metadata.memberId] ?? "ok") {
        case "ok":
          return { id, status: "requires_capture", amount: params.amount };
        case "already_captured":
          return { id, status: "succeeded", amount: params.amount };
        case "needs_3ds":
          return { id, status: "requires_action", amount: params.amount };
        case "decline":
          throw Object.assign(new Error("Your card was declined."), { type: "StripeCardError", payment_intent: { id } });
        case "network":
          throw Object.assign(new Error("connection reset"), { type: "StripeConnectionError" });
      }
    }),
    capture: vi.fn(async (id: string) => ({ id, status: "succeeded" })),
    cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
  },
  refunds: { create: vi.fn(async () => ({ id: "re_1" })) },
};
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe, STRIPE_MIN_CHARGE_CENTS: 50 }));

const { chargeOrder, ChargeFailedError, STRIPE_MIN_CHARGE_CENTS } = await import("../src/payments/charges.js");

// The demo household from PLAN.md: Sam owns, Jake has a card, Priya has none.
let household: Household;
const order: Order = { id: "o1", householdId: "h1", itemIds: [], totalCents: 7275, rule: "smart", createdAt: "" };
const demoShares: Shares = { sam: 1565, jake: 4695, priya: 1015 }; // PLAN.md smart split, $72.75

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  cardBehavior = {};
  n = 0;
  household = {
    id: "h1",
    groupChatId: "g1",
    ownerId: "sam",
    budgetCents: 18515,
    spentCents: 0,
    members: [
      { id: "sam", name: "Sam", phone: "+15550000001", role: "owner", stripeCustomerId: "cus_sam", paymentMethodId: "pm_sam", cardLast4: "4242" },
      { id: "jake", name: "Jake", phone: "+15550000002", role: "member", stripeCustomerId: "cus_jake", paymentMethodId: "pm_jake", cardLast4: "1881" },
      { id: "priya", name: "Priya", phone: "+15550000003", role: "member" },
    ],
  };
});

const amountsHeld = () => fakeStripe.paymentIntents.create.mock.calls.map(([p]) => [p.metadata.memberId, p.amount]);
const succeededTotal = (charges: { cents: number; status: string }[]) =>
  charges.filter((c) => c.status === "succeeded").reduce((s, c) => s + c.cents, 0);

describe("chargeOrder: the demo order", () => {
  it("charges Jake his share, charges Sam his share plus Priya's, and records Priya's debt", async () => {
    const { charges, debts } = await chargeOrder(order, demoShares, household);

    expect(amountsHeld()).toEqual([["jake", 4695], ["sam", 1565 + 1015]]);
    expect(fakeStripe.paymentIntents.capture).toHaveBeenCalledTimes(2);
    expect(charges).toEqual([
      expect.objectContaining({ memberId: "jake", cents: 4695, paidBy: "jake", status: "succeeded" }),
      expect.objectContaining({ memberId: "sam", cents: 1565, paidBy: "sam", status: "succeeded" }),
      expect.objectContaining({ memberId: "priya", cents: 1015, paidBy: "sam", status: "succeeded" }),
    ]);
    expect(debts).toEqual([expect.objectContaining({ debtorId: "priya", creditorId: "sam", cents: 1015, status: "open" })]);
    expect(succeededTotal(charges)).toBe(7275); // every cent of the order is paid, exactly once
  });

  it("holds first, then captures, off-session, with one idempotency key per order and member", async () => {
    await chargeOrder(order, demoShares, household);
    const [params, opts] = fakeStripe.paymentIntents.create.mock.calls[0]! as unknown as [Record<string, unknown>, { idempotencyKey: string }];
    expect(params).toMatchObject({
      currency: "usd",
      customer: "cus_jake",
      payment_method: "pm_jake",
      off_session: true,
      confirm: true,
      capture_method: "manual",
      metadata: { orderId: "o1", householdId: "h1", memberId: "jake" },
    });
    expect(JSON.stringify(params)).not.toMatch(/\+1555|Jake/); // no phone numbers or names sent to Stripe
    expect(opts.idempotencyKey).toBe("restock-hold-o1-jake");
  });
});

describe("chargeOrder: when a member's card doesn't work", () => {
  it.each(["decline", "needs_3ds"] as const)("%s: Sam's card covers Jake, and Jake owes Sam", async (behavior) => {
    cardBehavior.jake = behavior;
    const { charges, debts } = await chargeOrder(order, demoShares, household);

    expect(amountsHeld()).toEqual([["jake", 4695], ["sam", 1565 + 4695 + 1015]]);
    expect(charges).toContainEqual(expect.objectContaining({ memberId: "jake", paidBy: "jake", status: "failed" }));
    expect(charges).toContainEqual(expect.objectContaining({ memberId: "jake", cents: 4695, paidBy: "sam", status: "succeeded" }));
    expect(debts.map((d) => [d.debtorId, d.cents])).toEqual([["jake", 4695], ["priya", 1015]]);
    expect(succeededTotal(charges)).toBe(7275);
    if (behavior === "needs_3ds") expect(fakeStripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_jake_1");
  });

  it(`puts shares under $${(STRIPE_MIN_CHARGE_CENTS / 100).toFixed(2)} on the owner's charge with a debt`, async () => {
    const small: Order = { ...order, totalCents: 1000 };
    const { debts } = await chargeOrder(small, { sam: 334, jake: 30, priya: 636 }, household);
    expect(amountsHeld()).toEqual([["sam", 1000]]); // Jake's 30¢ is below Stripe's minimum
    expect(debts.map((d) => [d.debtorId, d.cents])).toEqual([["jake", 30], ["priya", 636]]);
  });
});

describe("chargeOrder: nobody is charged when the order can't go through", () => {
  it("owner's card declined: Jake's hold is released, nothing is captured", async () => {
    cardBehavior.sam = "decline";
    await expect(chargeOrder(order, demoShares, household)).rejects.toThrow(
      new ChargeFailedError("Sam's card didn't go through, so I didn't place the order. Nobody was charged."),
    );
    expect(fakeStripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_jake_1");
    expect(fakeStripe.paymentIntents.capture).not.toHaveBeenCalled();
  });

  it("network trouble: releases holds and says so plainly", async () => {
    cardBehavior.sam = "network";
    await expect(chargeOrder(order, demoShares, household)).rejects.toThrow(/couldn't reach the payment provider/);
    expect(fakeStripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_jake_1");
    expect(fakeStripe.paymentIntents.capture).not.toHaveBeenCalled();
  });

  it("a capture fails halfway: refunds what was taken and releases the rest", async () => {
    fakeStripe.paymentIntents.capture
      .mockImplementationOnce(async (id: string) => ({ id, status: "succeeded" }))
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { type: "StripeAPIError" }));
    await expect(chargeOrder(order, demoShares, household)).rejects.toThrow(ChargeFailedError);
    expect(fakeStripe.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_jake_1" }, expect.anything());
    expect(fakeStripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_sam_2");
  });

  it("owner has a card ID but no Stripe customer (e.g. placeholder seed data): stops before Stripe", async () => {
    delete household.members[0]!.stripeCustomerId;
    await expect(chargeOrder(order, demoShares, household)).rejects.toThrow(/add your card again/);
    expect(fakeStripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("order under the $0.50 minimum is refused", async () => {
    const tiny: Order = { ...order, totalCents: 40 };
    await expect(chargeOrder(tiny, { sam: 20, priya: 20 }, household)).rejects.toThrow(/\$0\.50 card minimum/);
  });
});

describe("chargeOrder: money safety", () => {
  it.each([
    ["don't add up to the total", { sam: 1565, jake: 4695, priya: 1014 }, /add up to 7274/],
    ["include a fraction of a cent", { sam: 1565.5, jake: 4694.5, priya: 1015 }, /whole, non-negative cents/],
    ["are negative", { sam: 8290, jake: -1015, priya: 0 }, /whole, non-negative cents/],
    ["name someone outside the household", { sam: 1565, jake: 4695, mallory: 1015 }, /unknown member mallory/],
  ])("refuses shares that %s, before calling Stripe", async (_label, shares, error) => {
    await expect(chargeOrder(order, shares, household)).rejects.toThrow(error);
    expect(fakeStripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("a retry of an already-charged order captures nothing new", async () => {
    cardBehavior = { sam: "already_captured", jake: "already_captured" }; // Stripe replays the first result
    const { charges } = await chargeOrder(order, demoShares, household);
    expect(fakeStripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(succeededTotal(charges)).toBe(7275);
  });
});
