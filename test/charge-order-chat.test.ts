// A failed charge reaches the group chat as a plain message, and nothing is recorded.
import { describe, expect, it, vi } from "vitest";

// computeShares is Person 2's and not built yet. Use PLAN.md's expected demo split.
vi.mock("../src/core/split.js", () => ({ computeShares: () => ({ sam: 1565, jake: 4695, priya: 1015 }) }));
const fakeStripe = { paymentIntents: { create: vi.fn(), capture: vi.fn(), cancel: vi.fn() }, refunds: { create: vi.fn() } };
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe }));

const { seedDemo } = await import("../scripts/seed.js");
const { db } = await import("../src/core/store.js");
const { handleInbound } = await import("../src/messaging/inbound.js");
const { rememberInbound } = await import("../src/messaging/photon.js");

describe('"order now" when the charge can\'t go through', () => {
  it("tells the group why, charges nobody, and records no order", async () => {
    // The seed gives Sam a placeholder card ID with no Stripe customer, so chargeOrder stops early.
    const h = seedDemo();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    let n = 0;
    for (const text of ["help", "order now"]) {
      const msg = { messageId: `c${++n}`, spaceId: "pho_spc_group", spaceKind: "group" as const, fromPhone: "+15550000002", text, agentUserId: "pho_usr_agent" };
      rememberInbound(msg);
      await handleInbound(msg);
    }

    expect(logs.join("\n")).toMatch(/Sam, please add your card again with the add-card link\. I didn't place the order\./);
    expect(fakeStripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(db.orders.size).toBe(0);
    expect(db.charges).toHaveLength(0);
    expect(h.spentCents).toBe(0);
  });
});
