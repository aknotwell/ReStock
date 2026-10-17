import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db, resetStore } from "../src/core/store.js";
import type { Debt, Household } from "../src/types.js";

// Fake Stripe Checkout. `sessions` holds what Stripe would know about each session we created.
const sessions = new Map<string, { id: string; url: string; status: "open" | "complete" | "expired" }>();
let n = 0;
const fakeStripe = {
  checkout: {
    sessions: {
      create: vi.fn(async () => {
        const s = { id: `cs_test_${++n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}`, status: "open" as const };
        sessions.set(s.id, s);
        return s;
      }),
      retrieve: vi.fn(async (id: string) => sessions.get(id)),
    },
  },
};
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe }));

const { createPayBackLink, openPayBackLink, PAY_BACK_LINK_TTL_MS, resetPayBackLinks } = await import("../src/payments/links.js");
const { markDebtPaidFromSession } = await import("../src/payments/webhook.js");
const { redact } = await import("../src/safety/redact.js");

let debt: Debt;
const tokenOf = (link: string) => link.split("/p/")[1]!;

beforeEach(() => {
  resetStore();
  resetPayBackLinks();
  sessions.clear();
  n = 0;
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const household: Household = {
    id: "h1",
    groupChatId: "g1",
    ownerId: "sam",
    budgetCents: 18515,
    spentCents: 7275,
    members: [
      { id: "sam", name: "Sam", phone: "+15550000001", role: "owner", stripeCustomerId: "cus_sam", paymentMethodId: "pm_sam" },
      { id: "priya", name: "Priya", phone: "+15550000003", role: "member" },
    ],
  };
  db.households.set(household.id, household);
  debt = { id: "d1", orderId: "o1", debtorId: "priya", creditorId: "sam", cents: 1015, status: "open" };
  db.debts.set(debt.id, debt);
});

describe("createPayBackLink", () => {
  it("returns a short /p/ link with a random token, not the debt ID, and doesn't call Stripe yet", async () => {
    const link = await createPayBackLink("d1");
    expect(link).toMatch(/\/p\/[A-Za-z0-9]{22}$/);
    expect(link).not.toContain("d1");
    expect(redact(link)).toBe(link); // survives the outbound filter in sendPrivate
    expect(fakeStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects unknown debts", async () => {
    await expect(createPayBackLink("nope")).rejects.toThrow("Unknown debt");
  });
});

describe("openPayBackLink", () => {
  it("creates a Checkout payment page for exactly the debt amount", async () => {
    const page = await openPayBackLink(tokenOf(await createPayBackLink("d1")));
    expect(page).toEqual({ kind: "checkout", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        line_items: [
          expect.objectContaining({
            quantity: 1,
            price_data: expect.objectContaining({ currency: "usd", unit_amount: 1015 }),
          }),
        ],
        metadata: { debtId: "d1" },
        success_url: expect.stringMatching(/\/pay\/success$/),
        cancel_url: expect.stringMatching(/\/cancel$/),
      }),
    );
  });

  it("reuses the same open page when tapped again, so the debt can't be paid twice", async () => {
    const token = tokenOf(await createPayBackLink("d1"));
    const first = await openPayBackLink(token);
    const second = await openPayBackLink(tokenOf(await createPayBackLink("d1"))); // even from a newer link
    expect(second).toEqual(first);
    expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("makes a fresh page if the old one expired", async () => {
    const token = tokenOf(await createPayBackLink("d1"));
    await openPayBackLink(token);
    sessions.get("cs_test_1")!.status = "expired";
    expect(await openPayBackLink(token)).toEqual({ kind: "checkout", url: "https://checkout.stripe.com/c/pay/cs_test_2" });
  });

  it("says 'paid' once the debt is paid, or once Stripe says the page was paid (webhook still on its way)", async () => {
    const token = tokenOf(await createPayBackLink("d1"));
    await openPayBackLink(token);
    sessions.get("cs_test_1")!.status = "complete";
    expect(await openPayBackLink(token)).toEqual({ kind: "paid" });

    debt.status = "paid";
    expect(await openPayBackLink(token)).toEqual({ kind: "paid" });
    expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("doesn't send debts under $0.50 to Stripe", async () => {
    debt.cents = 33;
    expect(await openPayBackLink(tokenOf(await createPayBackLink("d1")))).toEqual({ kind: "too_small", cents: 33, creditorName: "Sam" });
    expect(fakeStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("returns not_found for unknown or expired tokens", async () => {
    expect(await openPayBackLink("not-a-real-token")).toEqual({ kind: "not_found" });
    const now = Date.now();
    const token = tokenOf(await createPayBackLink("d1", now));
    expect(await openPayBackLink(token, now + PAY_BACK_LINK_TTL_MS + 1)).toEqual({ kind: "not_found" });
  });
});

describe("markDebtPaidFromSession (checkout.session.completed, payment mode)", () => {
  const session = (overrides: Partial<Stripe.Checkout.Session> = {}) =>
    ({ mode: "payment", payment_status: "paid", amount_total: 1015, metadata: { debtId: "d1" }, ...overrides }) as Stripe.Checkout.Session;

  it("marks the debt paid", () => {
    expect(markDebtPaidFromSession(session())).toBe("paid");
    expect(debt.status).toBe("paid");
  });

  it("is safe to run twice (Stripe retries webhooks)", () => {
    markDebtPaidFromSession(session());
    expect(markDebtPaidFromSession(session())).toBe("paid");
    expect(debt.status).toBe("paid");
  });

  it.each([
    ["not ours (e.g. `stripe trigger`)", { metadata: {} }, "not_a_pay_back"],
    ["for a debt we don't know", { metadata: { debtId: "nope" } }, "unknown_debt"],
    ["not actually paid", { payment_status: "unpaid" as const }, "not_paid"],
    ["for a different amount", { amount_total: 500 }, "amount_mismatch"],
  ])("leaves the debt open when the session is %s", (_label, overrides, result) => {
    expect(markDebtPaidFromSession(session(overrides as Partial<Stripe.Checkout.Session>))).toBe(result);
    expect(debt.status).toBe("open");
  });
});
