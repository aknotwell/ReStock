// Bugs found in a review of the whole repo: chat flows where the model or other people could change what a
// "yes" does. Claude is mocked; each test failed before its fix.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "../src/ai/intent.js";

const fakeStripe = {
  paymentIntents: {
    create: vi.fn(async (p: { amount: number }) => ({ id: `pi_${p.amount}`, status: "requires_capture" })),
    capture: vi.fn(async () => ({})),
    cancel: vi.fn(async () => ({})),
  },
  refunds: { create: vi.fn() },
};
vi.mock("../src/payments/stripe.js", () => ({ requireStripe: () => fakeStripe, stripe: undefined }));

// What "Claude" reads each message as.
let next: Intent[] = [];
vi.mock("../src/ai/parseMessage.js", () => ({ parseMessage: vi.fn(async () => next) }));

const { seedDemo } = await import("../scripts/seed.js");
const { addItem, db, householdsForPhone, pendingItems } = await import("../src/core/store.js");
const { handleInbound } = await import("../src/messaging/inbound.js");
const { rememberInbound } = await import("../src/messaging/photon.js");
const { resetConfirmations } = await import("../src/messaging/confirm.js");

const SAM = "+15550000001";
const intent = (type: Intent["type"], itemName: string | null = null): Intent => ({ type, itemName, quantity: null, shared: null });
let n = 0;
let logs: string[];
const out = () => logs.join("\n");

async function dm(from: string, text: string, reads: Intent[] = []) {
  next = reads;
  const msg = { messageId: `bc${++n}`, spaceId: `pho_spc_dm_${from}`, spaceKind: "direct" as const, fromPhone: from, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}

beforeEach(() => {
  const h = seedDemo();
  for (const m of h.members) if (m.paymentMethodId) m.stripeCustomerId = `cus_${m.id}`;
  resetConfirmations();
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("starting another household from casual words", () => {
  it("the model can only propose it: nothing is created until the member says yes", async () => {
    const before = householdsForPhone(SAM).length;
    await dm(SAM, "we should make a new group for the soccer team", [intent("start_household")]);
    expect(householdsForPhone(SAM)).toHaveLength(before);
    expect(out()).toMatch(/Start a new household with you \(Sam\) as the budget owner\? Reply "yes"/);

    await dm(SAM, "yes");
    expect(householdsForPhone(SAM)).toHaveLength(before + 1);
  });

  it('"no" leaves everything as it was', async () => {
    const before = householdsForPhone(SAM).length;
    await dm(SAM, "can you set up another group for us?", [intent("start_household")]); // casual: the exact "start a group" command needs no yes
    await dm(SAM, "no");
    expect(householdsForPhone(SAM)).toHaveLength(before);
  });
});

describe('"yes" buys exactly the cart that was shown', () => {
  it("an item someone added after the preview isn't bought without being shown first", async () => {
    await dm(SAM, "order now", [intent("order_now")]);
    expect(out()).toMatch(/6 items, \$72\.75/);
    addItem({ householdId: "demo-house", name: "Sponges, 6 pack", addedBy: "jake", cents: 599, shared: true }); // Jake, meanwhile

    logs = [];
    await dm(SAM, "yes");
    expect(db.orders.size).toBe(0);
    expect(fakeStripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(out()).toMatch(/The cart changed since I showed it, so I didn't order yet\.[\s\S]*7 items, \$78\.74[\s\S]*Reply "yes" to order/);

    await dm(SAM, "yes"); // to what they've now seen
    expect(db.orders.size).toBe(1);
    expect([...db.orders.values()][0]!.totalCents).toBe(7874);
  });

  it("so is a change to who pays for an item", async () => {
    await dm(SAM, "order now", [intent("order_now")]);
    const fryer = pendingItems("demo-house").find((i) => i.name.startsWith("Air fryer"))!;
    fryer.shared = true; // Jake made his air fryer shared after Sam saw the cart
    await dm(SAM, "yes");
    expect(db.orders.size).toBe(0);
    expect(out()).toMatch(/The cart changed since I showed it/);
  });

  it("an unchanged cart is ordered on the first yes, as before", async () => {
    await dm(SAM, "order now", [intent("order_now")]);
    await dm(SAM, "yes");
    expect(db.orders.size).toBe(1);
    expect([...db.orders.values()][0]!.totalCents).toBe(7275);
  });
});
