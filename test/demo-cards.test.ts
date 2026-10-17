import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { attachDemoCards } from "../scripts/demoCards.js";
import { seedDemo } from "../scripts/seed.js";
import type { Household } from "../src/types.js";

// Fake Stripe sandbox: customers by email, saved cards by customer.
let customers: { id: string; email: string }[];
let cards: Record<string, { id: string; card: { last4: string } }[]>;
const LAST4: Record<string, string> = { pm_card_visa: "4242", pm_card_visa_debit: "5556" };
const fake = {
  customers: {
    list: vi.fn(async ({ email }: { email: string }) => ({ data: customers.filter((c) => c.email === email) })),
    create: vi.fn(async ({ email }: { email: string }) => {
      const c = { id: `cus_${customers.length + 1}`, email };
      customers.push(c);
      return c;
    }),
  },
  paymentMethods: {
    list: vi.fn(async ({ customer }: { customer: string }) => ({ data: cards[customer] ?? [] })),
    attach: vi.fn(async (pm: string, { customer }: { customer: string }) => {
      const card = { id: `pm_${customer}_${pm}`, card: { last4: LAST4[pm]! } };
      (cards[customer] ??= []).push(card);
      return card;
    }),
  },
};
const stripe = fake as unknown as Stripe;

let h: Household;
const member = (id: string) => h.members.find((m) => m.id === id)!;

beforeEach(() => {
  customers = [];
  cards = {};
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h = seedDemo();
});

describe("attachDemoCards", () => {
  it("gives Sam and Jake real sandbox cards and leaves Priya without one", async () => {
    await attachDemoCards(h, stripe);
    expect(member("sam")).toMatchObject({ stripeCustomerId: "cus_1", paymentMethodId: "pm_cus_1_pm_card_visa", cardLast4: "4242" });
    expect(member("jake")).toMatchObject({ stripeCustomerId: "cus_2", paymentMethodId: "pm_cus_2_pm_card_visa_debit", cardLast4: "5556" });
    expect(member("priya").paymentMethodId).toBeUndefined();
    expect(fake.customers.create).toHaveBeenCalledWith(expect.not.objectContaining({ phone: expect.anything() }));
  });

  it("reuses the same customers and cards after a restart", async () => {
    await attachDemoCards(h, stripe);
    h = seedDemo(); // server restart: placeholders again
    await attachDemoCards(h, stripe);
    expect(fake.customers.create).toHaveBeenCalledTimes(2);
    expect(fake.paymentMethods.attach).toHaveBeenCalledTimes(2);
    expect(member("sam")).toMatchObject({ stripeCustomerId: "cus_1", cardLast4: "4242" });
  });

  it("keeps the placeholder cards when there's no Stripe key", async () => {
    await attachDemoCards(h, null); // null, not undefined: undefined would fall back to the real client
    expect(member("sam")).toMatchObject({ paymentMethodId: "pm_test_sam", cardLast4: "4242" });
    expect(member("sam").stripeCustomerId).toBeUndefined();
  });

  it("doesn't crash the server if Stripe can't be reached", async () => {
    fake.customers.list.mockRejectedValueOnce(new Error("connection reset"));
    await expect(attachDemoCards(h, stripe)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("couldn't set up sandbox cards"), "connection reset");
  });
});
