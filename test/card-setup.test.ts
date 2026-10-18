import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db, resetStore } from "../src/core/store.js";
import type { Household, Member } from "../src/types.js";

// A fake Stripe client: no network, no keys. Each test checks what we asked Stripe to do.
const fakeStripe = {
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
  setupIntents: { retrieve: vi.fn() },
};
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe }));

const { CARD_LINK_TTL_MS, createCardSetupLink, openCardSetupLink, resetCardLinks } = await import(
  "../src/payments/links.js"
);
const { confirmCardSetup, saveCardFromSetupSession } = await import("../src/payments/webhook.js");

let priya: Member;

beforeEach(() => {
  resetStore();
  resetCardLinks();
  vi.clearAllMocks();
  fakeStripe.customers.create.mockResolvedValue({ id: "cus_priya" });
  fakeStripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_test_1" });

  priya = { id: "m_priya", name: "Priya", phone: "+15550000003", role: "member" };
  const household: Household = {
    id: "h1",
    groupChatId: "g1",
    ownerId: "m_sam",
    budgetCents: 40000,
    spentCents: 0,
    members: [{ id: "m_sam", name: "Sam", phone: "+15550000001", role: "owner" }, priya],
  };
  db.households.set(household.id, household);
});

const tokenOf = (link: string) => link.split("/c/")[1]!;

describe("createCardSetupLink", () => {
  it("returns a short /c/ link with a random token, not the member ID", async () => {
    const link = await createCardSetupLink("m_priya");
    expect(link).toMatch(/\/c\/[A-Za-z0-9_-]{20,}$/);
    expect(link).not.toContain("m_priya");
    expect(await createCardSetupLink("m_priya")).not.toBe(link); // a new token each time
  });

  it("does not call Stripe until the link is tapped", async () => {
    await createCardSetupLink("m_priya");
    expect(fakeStripe.customers.create).not.toHaveBeenCalled();
    expect(fakeStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects unknown members", async () => {
    await expect(createCardSetupLink("m_nobody")).rejects.toThrow("Unknown member");
  });
});

describe("openCardSetupLink", () => {
  it("creates a Stripe Customer, then a setup-mode Checkout session, and returns its URL", async () => {
    const url = await openCardSetupLink(tokenOf(await createCardSetupLink("m_priya")));

    expect(url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(fakeStripe.customers.create).toHaveBeenCalledWith(
      { name: "Priya", metadata: { memberId: "m_priya" } }, // no phone number sent to Stripe
      { idempotencyKey: "restock-customer-m_priya" },
    );
    expect(priya.stripeCustomerId).toBe("cus_priya");
    expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "setup",
        customer: "cus_priya",
        metadata: { memberId: "m_priya" },
        success_url: expect.stringMatching(/\/card\/success\?session_id=\{CHECKOUT_SESSION_ID\}$/),
        cancel_url: expect.stringMatching(/\/cancel$/),
      }),
    );
  });

  it("reuses the member's existing Stripe Customer", async () => {
    priya.stripeCustomerId = "cus_existing";
    await openCardSetupLink(tokenOf(await createCardSetupLink("m_priya")));
    expect(fakeStripe.customers.create).not.toHaveBeenCalled();
    expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" }),
    );
  });

  it("returns undefined for unknown or expired tokens", async () => {
    expect(await openCardSetupLink("not-a-real-token")).toBeUndefined();

    const now = Date.now();
    const token = tokenOf(await createCardSetupLink("m_priya", now));
    expect(await openCardSetupLink(token, now + CARD_LINK_TTL_MS + 1)).toBeUndefined();
    expect(fakeStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("saveCardFromSetupSession (checkout.session.completed, setup mode)", () => {
  const session = (overrides: Partial<Stripe.Checkout.Session> = {}) =>
    ({
      mode: "setup",
      customer: "cus_priya",
      setup_intent: "seti_1",
      metadata: { memberId: "m_priya" },
      ...overrides,
    }) as Stripe.Checkout.Session;

  beforeEach(() => {
    fakeStripe.setupIntents.retrieve.mockResolvedValue({
      id: "seti_1",
      payment_method: { id: "pm_priya", card: { last4: "4242" } },
    });
  });

  it("saves the payment method ID and last 4 digits on the member", async () => {
    expect(await saveCardFromSetupSession(session())).toBe("saved");
    expect(fakeStripe.setupIntents.retrieve).toHaveBeenCalledWith("seti_1", { expand: ["payment_method"] });
    expect(priya).toMatchObject({ stripeCustomerId: "cus_priya", paymentMethodId: "pm_priya", cardLast4: "4242" });
  });

  it("is safe to run twice (Stripe retries webhooks)", async () => {
    await saveCardFromSetupSession(session());
    await saveCardFromSetupSession(session());
    expect(priya).toMatchObject({ paymentMethodId: "pm_priya", cardLast4: "4242" });
  });

  it("ignores sessions for members we don't know, like `stripe trigger` fixtures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await saveCardFromSetupSession(session({ metadata: {} }))).toBe("unknown_member");
    expect(await saveCardFromSetupSession(session({ metadata: { memberId: "m_nobody" } }))).toBe("unknown_member");
    expect(fakeStripe.setupIntents.retrieve).not.toHaveBeenCalled();
    expect(priya.paymentMethodId).toBeUndefined();
  });

  it("saves nothing when no card came back", async () => {
    fakeStripe.setupIntents.retrieve.mockResolvedValue({ id: "seti_1", payment_method: null });
    expect(await saveCardFromSetupSession(session())).toBe("no_card");
    expect(priya.paymentMethodId).toBeUndefined();
  });
});

describe("confirmCardSetup (back from Stripe at /card/success?session_id=…)", () => {
  beforeEach(() => {
    fakeStripe.setupIntents.retrieve.mockResolvedValue({ id: "seti_1", payment_method: { id: "pm_priya", card: { last4: "4242" } } });
  });
  const stripeSession = (overrides: Partial<Stripe.Checkout.Session> = {}) =>
    ({ id: "cs_test_1", mode: "setup", status: "complete", customer: "cus_priya", setup_intent: "seti_1", metadata: { memberId: "m_priya" }, ...overrides }) as Stripe.Checkout.Session;

  it("saves the card without waiting for the webhook, asking Stripe (not the page) what was saved", async () => {
    fakeStripe.checkout.sessions.retrieve.mockResolvedValue(stripeSession());
    expect(await confirmCardSetup("cs_test_1")).toBe("saved");
    expect(fakeStripe.checkout.sessions.retrieve).toHaveBeenCalledWith("cs_test_1");
    expect(priya).toMatchObject({ paymentMethodId: "pm_priya", cardLast4: "4242" });
  });

  it("then the webhook for the same card changes nothing and sends no second \"card added\" text", async () => {
    fakeStripe.checkout.sessions.retrieve.mockResolvedValue(stripeSession());
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    await confirmCardSetup("cs_test_1");
    await saveCardFromSetupSession(stripeSession());
    expect(logs.filter((l) => l.includes("Card added")).length).toBe(1);
  });

  it("saves nothing for a session that isn't finished or isn't an add-card page", async () => {
    fakeStripe.checkout.sessions.retrieve.mockResolvedValue(stripeSession({ status: "open" }));
    expect(await confirmCardSetup("cs_test_1")).toBe("not_complete");
    fakeStripe.checkout.sessions.retrieve.mockResolvedValue(stripeSession({ mode: "payment" }));
    expect(await confirmCardSetup("cs_test_1")).toBe("not_complete");
    expect(priya.paymentMethodId).toBeUndefined();
  });
});
