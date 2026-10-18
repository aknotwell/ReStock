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
      create: vi.fn(async (_params: unknown) => {
        const s = { id: `cs_test_${++n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}`, status: "open" as const };
        sessions.set(s.id, s);
        return s;
      }),
      retrieve: vi.fn(async (id: string) => sessions.get(id)),
      expire: vi.fn(async (id: string) => {
        const s = sessions.get(id)!;
        if (s.status === "complete") throw new Error("You can't expire a completed session"); // like Stripe
        s.status = "expired";
        return s;
      }),
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
        metadata: { payBack: "1", debtorId: "priya", creditorId: "sam", debtIds: "d1" },
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

  it("marks the debt paid", async () => {
    expect(await markDebtPaidFromSession(session())).toBe("paid");
    expect(debt.status).toBe("paid");
  });

  it("is safe to run twice (Stripe retries webhooks)", async () => {
    await markDebtPaidFromSession(session());
    expect(await markDebtPaidFromSession(session())).toBe("paid");
    expect(debt.status).toBe("paid");
  });

  it.each([
    ["not ours (e.g. `stripe trigger`)", { metadata: {} }, "not_a_pay_back"],
    ["for a debt we don't know", { metadata: { debtId: "nope" } }, "unknown_debt"],
    ["not actually paid", { payment_status: "unpaid" as const }, "not_paid"],
    ["for a different amount", { amount_total: 500 }, "amount_mismatch"],
  ])("leaves the debt open when the session is %s", async (_label, overrides, result) => {
    expect(await markDebtPaidFromSession(session(overrides as Partial<Stripe.Checkout.Session>))).toBe(result);
    expect(debt.status).toBe("open");
  });
});

describe("one pay-back page for everything owed (several orders)", () => {
  let d2: Debt;
  beforeEach(() => {
    // Two orders, an hour apart (UTC). Priya owes Sam for both.
    db.orders.set("o1", { id: "o1", householdId: "h1", itemIds: [], totalCents: 7275, rule: "smart", createdAt: "2026-10-18T00:07:00Z" });
    db.orders.set("o2", { id: "o2", householdId: "h1", itemIds: [], totalCents: 849, rule: "smart", createdAt: "2026-10-18T01:07:00Z" });
    d2 = { id: "d2", orderId: "o2", debtorId: "priya", creditorId: "sam", cents: 212, status: "open" };
    db.debts.set(d2.id, d2);
  });

  it("any of her links opens one page for the total, itemized by order (Pacific time)", async () => {
    const oldLink = await openPayBackLink(tokenOf(await createPayBackLink("d1")));
    const newLink = await openPayBackLink(tokenOf(await createPayBackLink("d2")));
    expect(newLink).toEqual(oldLink);
    expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const params = fakeStripe.checkout.sessions.create.mock.calls[0]![0] as unknown as {
      line_items: { price_data: { unit_amount: number; product_data: { name: string } } }[];
      metadata: Record<string, string>;
    };
    expect(params.line_items.map((l) => l.price_data.unit_amount)).toEqual([1015, 212]); // $12.27 total
    expect(params.line_items[0]!.price_data.product_data.name).toBe("Pay Sam back: your share of the order on Oct 17, 5:07 PM");
    expect(params.metadata.debtIds).toBe("d1,d2");
  });

  it("a new debt cancels the open page, so the old total can't be paid, and the next tap shows the new total", async () => {
    db.debts.delete("d2");
    const token = tokenOf(await createPayBackLink("d1"));
    await openPayBackLink(token); // page for $10.15
    db.debts.set("d2", d2); // a new order adds $2.12

    expect(await openPayBackLink(token)).toEqual({ kind: "checkout", url: "https://checkout.stripe.com/c/pay/cs_test_2" });
    expect(fakeStripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_test_1");
    const second = fakeStripe.checkout.sessions.create.mock.calls[1]![0] as unknown as { line_items: unknown[] };
    expect(second.line_items).toHaveLength(2);
  });

  it("if the old page was paid just before a new debt, the new page covers only the new debt", async () => {
    db.debts.delete("d2");
    const token = tokenOf(await createPayBackLink("d1"));
    await openPayBackLink(token);
    sessions.get("cs_test_1")!.status = "complete"; // paid; webhook not here yet, so d1 still looks open
    db.debts.set("d2", d2);

    await openPayBackLink(token);
    const second = fakeStripe.checkout.sessions.create.mock.calls[1]![0] as unknown as { metadata: { debtIds: string } };
    expect(second.metadata.debtIds).toBe("d2");
  });

  it("small debts add up: two shares under $0.50 become payable together", async () => {
    debt.cents = 30;
    d2.cents = 30;
    expect(await openPayBackLink(tokenOf(await createPayBackLink("d1")))).toMatchObject({ kind: "checkout" });
  });

  it("paying the page marks every debt on it paid, and only those", async () => {
    const d3: Debt = { id: "d3", orderId: "o2", debtorId: "jake", creditorId: "sam", cents: 500, status: "open" };
    db.debts.set(d3.id, d3);
    await openPayBackLink(tokenOf(await createPayBackLink("d1")));
    const paid = { id: "cs_test_1", mode: "payment", payment_status: "paid", amount_total: 1227, metadata: {} } as unknown as Stripe.Checkout.Session;

    expect(await markDebtPaidFromSession(paid)).toBe("paid");
    expect([debt.status, d2.status, d3.status]).toEqual(["paid", "paid", "open"]); // Jake's debt isn't Priya's to pay
  });

  it("the webhook can also read the debt list from metadata (e.g. after a restart lost the page record)", async () => {
    const fromMetadata = { id: "cs_other", mode: "payment", payment_status: "paid", amount_total: 1227, metadata: { debtIds: "d1,d2" } } as unknown as Stripe.Checkout.Session;
    expect(await markDebtPaidFromSession(fromMetadata)).toBe("paid");
    expect([debt.status, d2.status]).toEqual(["paid", "paid"]);
  });

  it("leaves every debt open if the paid amount doesn't match their total", async () => {
    const wrong = { id: "cs_other", mode: "payment", payment_status: "paid", amount_total: 1015, metadata: { debtIds: "d1,d2" } } as unknown as Stripe.Checkout.Session;
    expect(await markDebtPaidFromSession(wrong)).toBe("amount_mismatch");
    expect([debt.status, d2.status]).toEqual(["open", "open"]);
  });
});

describe("youOwe text", () => {
  it("mentions the total only when there are earlier debts too", async () => {
    const { youOwe } = await import("../src/messaging/templates.js");
    const sam = db.households.get("h1")!.members[0]!;
    expect(youOwe(sam, 212, "P", "C")).not.toMatch(/in total/);
    expect(youOwe(sam, 212, "P", "C", 1227)).toMatch(/With earlier orders, you owe Sam \$12\.27 in total\. This link pays all of it\./);
  });
});

describe("text to the owner when someone pays them back", () => {
  const paidPage = (id: string, cents: number, debtIds: string) =>
    ({ id, mode: "payment", payment_status: "paid", amount_total: cents, metadata: { debtIds } }) as unknown as Stripe.Checkout.Session;
  const textsToSam = (log: { mock: { calls: unknown[][] } }) =>
    log.mock.calls.map((c) => c.join(" ")).filter((line: string) => line.includes("→ Sam (private)"));

  it("Sam is told who paid and how much, once per payment", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await markDebtPaidFromSession(paidPage("cs_a", 1015, "d1"));
    await markDebtPaidFromSession(paidPage("cs_a", 1015, "d1")); // Stripe retries the webhook
    const texts = textsToSam(log);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/Priya paid you back \$10\.15\./);
  });

  it("says how many orders a combined payment covered", async () => {
    db.debts.set("d2", { id: "d2", orderId: "o2", debtorId: "priya", creditorId: "sam", cents: 212, status: "open" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await markDebtPaidFromSession(paidPage("cs_b", 1227, "d1,d2"));
    expect(textsToSam(log)[0]).toMatch(/Priya paid you back \$12\.27 for 2 orders\./);
  });

  it("sends nothing when the payment doesn't go through our checks", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await markDebtPaidFromSession(paidPage("cs_c", 500, "d1")); // wrong amount
    expect(textsToSam(log)).toHaveLength(0);
  });
});
