// A saved Stripe customer can stop existing (deleted when someone left a household or deleted their data, or made
// with another Stripe key). Adding a card, paying back and ordering must recover instead of failing with "couldn't
// reach our payment provider".
import { beforeEach, describe, expect, it, vi } from "vitest";

const GONE = "cus_gone";
const missing = () => Object.assign(new Error(`No such customer: '${GONE}'`), { type: "StripeInvalidRequestError", code: "resource_missing", param: "customer" });
const fakeStripe = {
  customers: { create: vi.fn(async () => ({ id: "cus_new" })) },
  checkout: {
    sessions: {
      create: vi.fn(async (p: { customer?: string }) => {
        if (p.customer === GONE) throw missing();
        return { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", status: "open" };
      }),
      retrieve: vi.fn(),
      expire: vi.fn(),
    },
  },
  paymentIntents: {
    create: vi.fn(async (p: { amount: number; customer?: string }) => {
      if (p.customer === GONE) throw missing();
      return { id: `pi_${p.amount}`, status: "requires_capture" };
    }),
    capture: vi.fn(async () => ({})),
    cancel: vi.fn(async () => ({})),
  },
  refunds: { create: vi.fn() },
};
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe, stripe: undefined }));
vi.mock("../src/ai/client.js", () => ({ anthropic: undefined, MODEL: "test" }));

const { createHousehold, addMember } = await import("../src/core/households.js");
const { db, resetStore } = await import("../src/core/store.js");
const { createCardSetupLink, createPayBackLink, openCardSetupLink, openPayBackLink, resetCardLinks, resetPayBackLinks } = await import("../src/payments/links.js");
const { createPayBackCheckout } = await import("../src/payments/payback.js");
const { chargeOrder } = await import("../src/payments/charges.js");

beforeEach(() => {
  resetStore();
  resetCardLinks();
  resetPayBackLinks();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("the add-card link", () => {
  it("makes a new Stripe customer when the saved one is gone, and forgets the old card everywhere", async () => {
    const maple = createHousehold("Sam", "+15550000001", { name: "Maple House" });
    const club = createHousehold("Sam", "+15550000001", { name: "Book Club" });
    for (const h of [maple, club]) Object.assign(h.members[0]!, { stripeCustomerId: GONE, paymentMethodId: "pm_gone", cardLast4: "4242" });
    const sam = maple.members[0]!;

    const token = (await createCardSetupLink(sam.id)).split("/c/")[1]!;
    expect(await openCardSetupLink(token)).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(sam.stripeCustomerId).toBe("cus_new");
    expect(club.members[0]).not.toHaveProperty("paymentMethodId"); // that card was on the deleted customer
    // Not the usual idempotency key: Stripe would replay the deleted customer for 24 hours.
    const [, options] = fakeStripe.customers.create.mock.calls.at(-1) as unknown as [unknown, { idempotencyKey: string }];
    expect(options.idempotencyKey).toMatch(/^restock-customer-sam-[0-9a-f]{12}$/);
  });
});

describe("paying back", () => {
  function owed() {
    const h = createHousehold("Sam", "+15550000001");
    Object.assign(h.members[0]!, { stripeCustomerId: "cus_sam", paymentMethodId: "pm_sam", cardLast4: "4242" });
    const priya = addMember(h, "Priya", "+15550000003");
    priya.stripeCustomerId = GONE;
    db.orders.set("o1", { id: "o1", householdId: h.id, itemIds: [], totalCents: 1015, rule: "smart", createdAt: "2026-10-18T00:00:00Z" });
    db.debts.set("d1", { id: "d1", orderId: "o1", debtorId: priya.id, creditorId: h.ownerId, cents: 1015, status: "open" });
    return priya;
  }

  it("the /pay site works when the debtor's saved customer is gone", async () => {
    const priya = owed();
    expect(await createPayBackCheckout(priya, "d1", false)).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(priya.stripeCustomerId).toBe("cus_new");
  });

  it("the texted pay-back link works too", async () => {
    const priya = owed();
    const token = (await createPayBackLink("d1")).split("/p/")[1]!;
    expect(await openPayBackLink(token)).toEqual({ kind: "checkout", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    expect(priya).not.toHaveProperty("stripeCustomerId");
  });
});

describe("ordering", () => {
  it("a member whose saved customer is gone is covered by the owner instead of failing the whole order", async () => {
    const h = createHousehold("Sam", "+15550000001");
    Object.assign(h.members[0]!, { stripeCustomerId: "cus_sam", paymentMethodId: "pm_sam", cardLast4: "4242" });
    const jake = addMember(h, "Jake", "+15550000002");
    Object.assign(jake, { stripeCustomerId: GONE, paymentMethodId: "pm_gone", cardLast4: "1881" });
    const order = { id: "o2", householdId: h.id, itemIds: [], totalCents: 2000, rule: "smart" as const, createdAt: "2026-10-18T00:00:00Z" };

    const { debts } = await chargeOrder(order, { [h.ownerId]: 1000, [jake.id]: 1000 }, h);
    expect(debts).toMatchObject([{ debtorId: jake.id, creditorId: h.ownerId, cents: 1000 }]);
    expect(jake).not.toHaveProperty("paymentMethodId"); // asked to add a card again next time
  });
});
