// Pay-back site: texted-code login, only your own debts, Stripe Checkout, and the webhook settling it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeStripe = {
  customers: { create: vi.fn(async () => ({ id: "cus_priya" })) },
  checkout: { sessions: { create: vi.fn(async (_p: Record<string, unknown>) => ({ url: "https://checkout.stripe.test/s" })) } },
  paymentIntents: { retrieve: vi.fn(async () => ({ payment_method: { id: "pm_saved", card: { last4: "5555" } } })) },
};
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe }));

const { seedDemo } = await import("../scripts/seed.js");
const { db, formerMembers, newId } = await import("../src/core/store.js");
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

  it("includes every household for that phone, and charges the debtor's own record", async () => {
    db.households.set("other-house", {
      id: "other-house",
      kind: "group",
      groupChatId: "other-chat",
      ownerId: "sam-2",
      spentCents: 0,
      members: [
        { id: "sam-2", name: "Sam", phone: "+15550000001", role: "owner" },
        { id: "priya-2", name: "Priya", phone: PRIYA, role: "member" },
      ],
    });
    const otherDebt = newId();
    db.debts.set(otherDebt, { id: otherDebt, orderId: "o2", debtorId: "priya-2", creditorId: "sam-2", cents: 500, status: "open" });
    formerMembers.set("priya-old", {
      household: { id: "gone", groupChatId: "gone", ownerId: "sam", spentCents: 0, members: [] },
      member: { id: "priya-old", name: "Priya", phone: PRIYA, role: "member" },
    });
    const oldDebt = newId();
    db.debts.set(oldDebt, { id: oldDebt, orderId: "o3", debtorId: "priya-old", creditorId: "sam", cents: 250, status: "open" });

    const { token } = await logIn();
    const priya = payback.sessionMember(token)!;
    expect(priya.id).toBe("priya");
    expect(payback.myDebts(priya).map((d) => d.id).sort()).toEqual([debtId, otherDebt, oldDebt].sort());

    await expect(payback.createPayBackCheckout(priya, otherDebt, false)).resolves.toBe("https://checkout.stripe.test/s");
    const params = fakeStripe.checkout.sessions.create.mock.calls.at(-1)![0] as { metadata: { memberId: string }; line_items: { price_data: { unit_amount: number } }[] };
    expect(params.line_items[0]!.price_data.unit_amount).toBe(500);
    expect(params.metadata.memberId).toBe("priya-2");

    await expect(payback.createPayBackCheckout(priya, oldDebt, false)).resolves.toBe("https://checkout.stripe.test/s");
    const oldParams = fakeStripe.checkout.sessions.create.mock.calls.at(-1)![0] as { metadata: { memberId: string } };
    expect(oldParams.metadata.memberId).toBe("priya-old");

    const jake = db.households.get("demo-house")!.members.find((m) => m.id === "jake")!;
    await expect(payback.createPayBackCheckout(jake, otherDebt, false)).rejects.toThrow(/isn't open for you/);
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
