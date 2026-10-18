// Pay-back site: texted-code login, only your own debts, Stripe Checkout, and the webhook settling it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeStripe = {
  customers: { create: vi.fn(async () => ({ id: "cus_priya" })) },
  checkout: { sessions: { create: vi.fn(async (_p: Record<string, unknown>) => ({ url: "https://checkout.stripe.test/s" })) } },
  paymentIntents: { retrieve: vi.fn(async () => ({ payment_method: { id: "pm_saved", card: { last4: "5555" } } })) },
};
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe }));

const { seedDemo } = await import("../scripts/seed.js");
const { db, newId } = await import("../src/core/store.js");
const { captureOutboundDetailed } = await import("../src/messaging/photon.js");
const payback = await import("../src/payments/payback.js");

const PRIYA = "+15550000003";
let debtId: string;

beforeEach(() => {
  vi.clearAllMocks();
  payback.resetPayBack();
  seedDemo();
  debtId = newId();
  db.debts.set(debtId, { id: debtId, orderId: "o1", debtorId: "priya", creditorId: "sam", cents: 1015, status: "open" });
});

async function logIn(handle = "(555) 000-0003") {
  const sent = await captureOutboundDetailed(() => payback.startLogin(handle));
  const code = /code is (\d{6})/.exec(sent[0]?.text ?? "")?.[1];
  return { sent, code, token: code ? payback.verifyLogin(handle, code) : undefined };
}

describe("login", () => {
  it("texts a code only to the member, and the code logs them in once", async () => {
    const { sent, code, token } = await logIn();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.memberId).toBe("priya");
    expect(code).toMatch(/^\d{6}$/);
    expect(payback.sessionMember(token)?.id).toBe("priya");
    expect(payback.verifyLogin(PRIYA, code!)).toBeUndefined(); // already used
  });

  it("says nothing for a number that isn't in any household", async () => {
    const sent = await captureOutboundDetailed(() => payback.startLogin("+15559999999"));
    expect(sent).toHaveLength(0);
  });

  it("rejects wrong and expired codes, and stops after a few tries", async () => {
    await captureOutboundDetailed(() => payback.startLogin(PRIYA));
    for (let i = 0; i < payback.MAX_CODE_TRIES; i++) expect(payback.verifyLogin(PRIYA, "000000x")).toBeUndefined();
    expect(payback.verifyLogin(PRIYA, "123456")).toBeUndefined();

    const t0 = Date.now();
    const sent = await captureOutboundDetailed(() => payback.startLogin(PRIYA, t0));
    const code = /code is (\d{6})/.exec(sent[0]!.text)![1]!;
    expect(payback.verifyLogin(PRIYA, code, t0 + payback.CODE_TTL_MS + 1)).toBeUndefined();
  });
});

describe("paying back", () => {
  it("shows only the logged-in member's own open debts", async () => {
    const { token } = await logIn();
    const priya = payback.sessionMember(token)!;
    expect(payback.myDebts(priya)).toEqual([expect.objectContaining({ id: debtId, to: "Sam", amount: "$10.15" })]);
    const sam = db.households.get("demo-house")!.members.find((m) => m.id === "sam")!;
    expect(payback.myDebts(sam)).toEqual([]);
  });

  it("opens Stripe Checkout for the exact amount, and refuses someone else's debt", async () => {
    const { token } = await logIn();
    const priya = payback.sessionMember(token)!;
    await expect(payback.createPayBackCheckout(priya, debtId, true)).resolves.toBe("https://checkout.stripe.test/s");
    const params = fakeStripe.checkout.sessions.create.mock.calls[0]![0] as any;
    expect(params.mode).toBe("payment");
    expect(params.line_items[0].price_data.unit_amount).toBe(1015);
    expect(params.payment_intent_data.setup_future_usage).toBe("off_session");

    const jake = db.households.get("demo-house")!.members.find((m) => m.id === "jake")!;
    await expect(payback.createPayBackCheckout(jake, debtId, false)).rejects.toThrow(/isn't open for you/);
  });

  it("the webhook marks the debt paid, saves the card, texts Sam, and is safe to repeat", async () => {
    const session = { metadata: { debtId, memberId: "priya", saveCard: "1" }, payment_intent: "pi_1", customer: "cus_priya" } as any;
    const sent = await captureOutboundDetailed(async () => { expect(await payback.settlePayBack(session)).toBe("paid"); });
    expect(db.debts.get(debtId)?.status).toBe("paid");
    const priya = db.households.get("demo-house")!.members.find((m) => m.id === "priya")!;
    expect(priya.cardLast4).toBe("5555");
    expect(sent).toEqual([expect.objectContaining({ memberId: "sam", text: "Priya paid you back $10.15." })]);
    expect(await payback.settlePayBack(session)).toBe("already_paid");
  });
});
