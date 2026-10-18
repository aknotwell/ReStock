// The same confirming text reuses one order id, so a crash after Stripe captures cannot charge it twice.
import { beforeEach, describe, expect, it, vi } from "vitest";

const stripe = vi.hoisted(() => {
  const byKey = new Map<string, { id: string; status: string; amount: number }>();
  const captures: string[] = [];
  let createCalls = 0;
  const fake = {
    paymentIntents: {
      create: async (params: { amount: number }, opts?: { idempotencyKey?: string }) => {
        createCalls += 1;
        const key = opts?.idempotencyKey ?? `anon-${byKey.size}`;
        const existing = byKey.get(key);
        if (existing) return existing;
        const intent = { id: `pi_${byKey.size}`, status: "requires_capture", amount: params.amount };
        byKey.set(key, intent);
        return intent;
      },
      capture: async (id: string) => {
        captures.push(id);
        for (const intent of byKey.values()) if (intent.id === id) intent.status = "succeeded";
        return { id, status: "succeeded" };
      },
      cancel: async () => ({}),
    },
    refunds: { create: async () => ({}) },
  };
  return {
    fake,
    byKey,
    captures,
    createCalls: () => createCalls,
    reset: () => {
      byKey.clear();
      captures.length = 0;
      createCalls = 0;
    },
  };
});
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => stripe.fake, stripe: undefined }));

const { seedDemo } = await import("../scripts/seed.js");
const { db } = await import("../src/core/store.js");
const { placeOrder, OrderError } = await import("../src/core/orders.js");

beforeEach(() => {
  stripe.reset();
  const h = seedDemo();
  for (const m of h.members) if (m.paymentMethodId) m.stripeCustomerId = `cus_${m.id}`;
});

describe("checkout retry", () => {
  it("a second call for the same text returns the saved order and does not charge again", async () => {
    const h = db.households.get("demo-house")!;
    const first = await placeOrder(h.id, "smart", "checkout:m1");
    const creates = stripe.createCalls();
    const captures = stripe.captures.length;
    const spent = h.spentCents;
    const second = await placeOrder(h.id, "smart", "checkout:m1");
    expect(second.order.id).toBe(first.order.id);
    expect(stripe.createCalls()).toBe(creates);
    expect(stripe.captures).toHaveLength(captures);
    expect(h.spentCents).toBe(spent);
  });

  it("a crash after capture reuses the order id and does not capture again", async () => {
    const h = db.households.get("demo-house")!;
    const first = await placeOrder(h.id, "smart", "checkout:m1");
    const orderId = first.order.id;
    db.orders.delete(orderId);
    for (let i = db.charges.length - 1; i >= 0; i--) if (db.charges[i]!.orderId === orderId) db.charges.splice(i, 1);
    for (const [id, debt] of db.debts) if (debt.orderId === orderId) db.debts.delete(id);
    for (const item of first.items) item.status = "pending";
    h.spentCents = 0;

    const creates = stripe.createCalls();
    const keys = [...stripe.byKey.keys()];
    const second = await placeOrder(h.id, "smart", "checkout:m1");
    expect(second.order.id).toBe(orderId);
    expect(stripe.createCalls()).toBeGreaterThan(creates);
    expect([...stripe.byKey.keys()]).toEqual(keys);
    expect(keys.every((key) => key.includes(orderId))).toBe(true);
    expect(stripe.captures).toHaveLength(2);
    expect(h.spentCents).toBe(first.order.totalCents);
    expect(db.orders.get(orderId)?.id).toBe(orderId);
  });

  it("a new checkout finds an empty cart", async () => {
    const h = db.households.get("demo-house")!;
    await placeOrder(h.id, "smart", "checkout:m1");
    await expect(placeOrder(h.id, "smart", "checkout:m2")).rejects.toThrow(OrderError);
    await expect(placeOrder(h.id, "smart", "checkout:m2")).rejects.toThrow(/The cart is empty/);
  });
});
