// The demo story end to end through the chat pipeline (PLAN.md): items in the group, "order now",
// then private receipts for Sam and Jake and a "you owe Sam" text for Priya. Stripe is faked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeStripe = {
  paymentIntents: {
    create: vi.fn(async (p: { amount: number }) => ({ id: `pi_${p.amount}`, status: "requires_capture" })),
    capture: vi.fn(async () => ({})),
    cancel: vi.fn(async () => ({})),
  },
  refunds: { create: vi.fn() },
};
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe }));

const { seedDemo } = await import("../scripts/seed.js");
const { db, pendingItems } = await import("../src/core/store.js");
const { handleInbound } = await import("../src/messaging/inbound.js");
const { rememberInbound } = await import("../src/messaging/photon.js");

const SAM = "+15550000001", JAKE = "+15550000002", PRIYA = "+15550000003";
let n = 0;
let logs: string[];

async function say(from: string, text: string, spaceKind: "group" | "direct" = "group") {
  const spaceId = spaceKind === "group" ? "pho_spc_group" : `pho_spc_dm_${from}`;
  const msg = { messageId: `d${++n}`, spaceId, spaceKind, fromPhone: from, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}
const out = () => logs.join("\n");

beforeEach(() => {
  const h = seedDemo();
  for (const m of h.members) if (m.paymentMethodId) m.stripeCustomerId = `cus_${m.id}`;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("demo flow over chat", () => {
  it("order now → group summary, receipts for card holders, 'you owe Sam' for Priya", async () => {
    await say(SAM, "help"); // binds the group
    await say(PRIYA, "hi", "direct"); // Priya has a DM with the agent, so her private text can reach her
    logs = [];
    await say(JAKE, "order now");
    const text = out();
    expect(text).toMatch(/Ordered! 6 items, \$72\.75/);
    expect(text).toMatch(/Receipt: your share is \$\d+\.\d\d, charged to your Visa ending 4242\./);
    expect(text).toMatch(/Your card also covered \$\d+\.\d\d for roommates without a card/);
    expect(text).toMatch(/Receipt: your share is \$\d+\.\d\d, charged to your card ending 1881\./);
    expect(text).toMatch(/Your share of this week's order is \$\d+\.\d\d\. Sam's card covered it\.\nPay Sam back: \S+\nOr add a card/);
    expect(db.debts.size).toBe(1);
  });

  it("'what do I owe?' answers privately with only the sender's balances", async () => {
    await say(SAM, "help");
    await say(PRIYA, "hi", "direct");
    await say(JAKE, "order now");
    logs = [];
    await say(PRIYA, "what do I owe?", "direct");
    expect(out()).toMatch(/You owe Sam \$\d+\.\d\d\./);
    logs = [];
    await say(SAM, "what do I owe?", "direct");
    expect(out()).toMatch(/Priya owes you \$\d+\.\d\d\./);
  });

  it("'personal' / 'shared' flips the sender's last item; 'remove' drops it", async () => {
    await say(SAM, "add hand soap");
    const soap = () => pendingItems("demo-house").find((i) => i.name.startsWith("Hand soap"));
    expect(soap()?.shared).toBe(true);
    await say(SAM, "personal");
    expect(soap()?.shared).toBe(false);
    expect(out()).toMatch(/is now personal \(just Sam\)/);
    await say(SAM, "remove hand soap");
    expect(soap()).toBeUndefined();
  });

  it("only people the owner allows can approve items waiting for approval", async () => {
    await say(SAM, "help");
    pendingItems("demo-house")[0]!.needsApproval = true;
    db.households.get("demo-house")!.members.find((m) => m.id === "jake")!.canApprove = false;
    logs = [];
    await say(JAKE, "yes");
    expect(out()).toMatch(/Only Sam or Priya can approve that/);
    await say(SAM, "yes");
    expect(out()).toMatch(/Approved by Sam: /);
    expect(pendingItems("demo-house").some((i) => i.needsApproval)).toBe(false);
  });
});
