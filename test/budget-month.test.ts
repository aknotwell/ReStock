// Monthly spend is "this month" in Pacific time. The first time a household is seen, its current spend stays.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeStripe = vi.hoisted(() => ({
  paymentIntents: {
    create: async (p: { amount: number }) => ({ id: `pi_${p.amount}`, status: "requires_capture" }),
    capture: async (id: string) => ({ id, status: "succeeded" }),
    cancel: async () => ({}),
  },
  refunds: { create: async () => ({}) },
}));
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe, stripe: undefined }));

const { seedDemo } = await import("../scripts/seed.js");
const { db } = await import("../src/core/store.js");
const { budgetMonthKey, ensureBudgetMonth } = await import("../src/core/households.js");
const { placeOrder } = await import("../src/core/orders.js");

beforeEach(() => {
  const h = seedDemo();
  for (const m of h.members) if (m.paymentMethodId) m.stripeCustomerId = `cus_${m.id}`;
});

describe("budget month", () => {
  it("keeps spend the first time a household is seen", () => {
    const h = db.households.get("demo-house")!;
    h.spentCents = 500;
    ensureBudgetMonth(h, new Date("2026-10-18T12:00:00Z"));
    expect(h.spentCents).toBe(500);
    expect(h.budgetMonth).toBe("2026-10");
  });

  it("starts a new month at zero", () => {
    const h = db.households.get("demo-house")!;
    h.budgetMonth = "2026-09";
    h.spentCents = 5000;
    ensureBudgetMonth(h, new Date("2026-10-18T12:00:00Z"));
    expect(h.spentCents).toBe(0);
    expect(h.budgetMonth).toBe("2026-10");
  });

  it("uses Pacific time at the month boundary", () => {
    expect(budgetMonthKey(new Date("2026-10-01T06:00:00Z"))).toBe("2026-09");
    expect(budgetMonthKey(new Date("2026-10-01T08:00:00Z"))).toBe("2026-10");
  });

  it("an order in a new month replaces last month's spend", async () => {
    const h = db.households.get("demo-house")!;
    h.budgetMonth = "2026-09";
    h.spentCents = h.budgetCents!;
    const result = await placeOrder(h.id);
    expect(h.budgetMonth).toBe(budgetMonthKey(new Date()));
    expect(h.spentCents).toBe(result.order.totalCents);
  });

  it("an order in the same month adds to the spend", async () => {
    const h = db.households.get("demo-house")!;
    h.budgetMonth = budgetMonthKey(new Date());
    h.spentCents = 1000;
    const result = await placeOrder(h.id);
    expect(h.spentCents).toBe(1000 + result.order.totalCents);
  });
});
