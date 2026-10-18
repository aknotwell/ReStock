// Casual phrasing through Claude (mocked), with confirm-to-act: the model can propose an order or a membership
// change, but only the asked person's explicit "yes" runs it. Phone numbers never reach the model.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// What "Claude" reads each message as. Tests set this per message; it records what text the model saw.
const seen: string[] = [];
let next: Intent[] = [];
vi.mock("../src/ai/parseMessage.js", () => ({
  parseMessage: vi.fn(async (text: string) => {
    seen.push(text);
    return next;
  }),
}));

const { seedDemo } = await import("../scripts/seed.js");
const { db, householdsForPhone, pendingItems } = await import("../src/core/store.js");
const { handleInbound } = await import("../src/messaging/inbound.js");
const { rememberInbound } = await import("../src/messaging/photon.js");
const { resetConfirmations, CONFIRM_TTL_MS } = await import("../src/messaging/confirm.js");

const SAM = "+15550000001", JAKE = "+15550000002", NEW = "+14255550188";
const intent = (type: Intent["type"], itemName: string | null = null): Intent => ({ type, itemName, quantity: null, shared: null });
let n = 0;
let logs: string[];
const out = () => logs.join("\n");

async function dm(from: string, text: string, reads: Intent[] = []) {
  next = reads;
  const msg = { messageId: `c${++n}`, spaceId: `pho_spc_dm_${from}`, spaceKind: "direct" as const, fromPhone: from, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}

beforeEach(() => {
  const h = seedDemo();
  for (const m of h.members) if (m.paymentMethodId) m.stripeCustomerId = `cus_${m.id}`;
  resetConfirmations();
  seen.length = 0;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("casual checkout needs an explicit yes", () => {
  it("'ok let's just order everything' asks first; 'yes' places the order", async () => {
    await dm(SAM, "ok let's just order everything", [intent("checkout")]);
    expect(out()).toMatch(/Place the order now\? 6 items, \$72\.75\. Reply "yes"/);
    expect(db.orders.size).toBe(0);
    await dm(SAM, "yes");
    expect(db.orders.size).toBe(1);
    expect(out()).toMatch(/Ordered! 6 items, \$72\.75/);
  });

  it("'no' cancels and nothing is bought", async () => {
    await dm(SAM, "let's order", [intent("checkout")]);
    await dm(SAM, "nah");
    expect(out()).toMatch(/OK, I won't do that/);
    await dm(SAM, "yes");
    expect(db.orders.size).toBe(0);
  });

  it("someone else's 'yes' doesn't confirm it", async () => {
    await dm(SAM, "buy it all", [intent("checkout")]);
    await dm(JAKE, "yes");
    expect(db.orders.size).toBe(0);
  });

  it("a confirmation expires after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await dm(SAM, "send the order", [intent("checkout")]);
    vi.setSystemTime(Date.now() + CONFIRM_TTL_MS + 1);
    await dm(SAM, "yes");
    expect(db.orders.size).toBe(0);
  });

  it("the exact 'order now' command still orders immediately", async () => {
    await dm(SAM, "order now", [intent("order_now")]);
    expect(db.orders.size).toBe(1);
  });
});

describe("casual household management", () => {
  it("a new person starts a household in their own words, then confirms", async () => {
    await dm(NEW, "make me a new household, im alex", [intent("start_household", "Alex")]);
    expect(out()).toMatch(/Start a household with you \(Alex\) as the budget owner\? Reply "yes"/);
    expect(householdsForPhone(NEW)).toHaveLength(0);
    await dm(NEW, "yes");
    expect(householdsForPhone(NEW)[0]?.members).toMatchObject([{ name: "Alex", role: "owner" }]);
  });

  it("adding a roommate casually: the model never sees the number, and the owner confirms", async () => {
    await dm(SAM, "can you add my roommate amber, her number is 425 555 0123", [intent("add_member", "Amber")]);
    expect(seen.at(-1)).toBe("can you add my roommate amber, her number is [phone]");
    expect(seen.join(" ")).not.toMatch(/555/);
    expect(out()).toMatch(/Add Amber \(phone ending 0123\) to the household\? Reply "yes"/);
    await dm(SAM, "yes");
    expect(householdsForPhone("+14255550123")[0]?.members.map((m) => m.name)).toContain("Amber");
  });

  it("only the owner can add or remove people, even casually", async () => {
    await dm(JAKE, "add my friend bo, 206 555 0111", [intent("add_member", "Bo")]);
    await dm(JAKE, "kick priya out", [intent("remove_member", "Priya")]);
    expect(out().match(/Only the budget owner can add or remove people/g)).toHaveLength(2);
    await dm(JAKE, "yes");
    expect(householdsForPhone("+12065550111")).toHaveLength(0);
  });

  it("removing someone casually asks first", async () => {
    await dm(SAM, "take jake off the house", [intent("remove_member", "Jake")]);
    expect(out()).toMatch(/Remove Jake from the household\?/);
    await dm(SAM, "yes");
    expect(householdsForPhone(JAKE)).toHaveLength(0);
  });

  it("'who's in our house' lists members right away", async () => {
    await dm(JAKE, "who lives here again lol", [intent("list_members")]);
    expect(out()).toMatch(/Your household:\n• Sam \(budget owner\)/);
  });

  it("asks for the number if a casual add has none", async () => {
    await dm(SAM, "add amber to the house", [intent("add_member", "Amber")]);
    expect(out()).toMatch(/What's Amber's phone number\?/);
  });
});

describe("phone numbers stay protected", () => {
  it("a phone number in a message that isn't adding a member is still refused", async () => {
    const before = pendingItems("demo-house").length;
    await dm(SAM, "add tp and text 425 555 0123 when it ships", [intent("add_item", "toilet paper")]);
    expect(seen.at(-1)).not.toMatch(/555/);
    expect(out()).toMatch(/can't share/);
    expect(pendingItems("demo-house").length).toBe(before);
  });

  it("card numbers are never treated as a phone number", async () => {
    await dm(SAM, "add amber 4242 4242 4242 4242", [intent("add_member", "Amber")]);
    expect(seen).toHaveLength(0); // the card guard stops it before the model
    expect(out()).toMatch(/I can't confirm, store, or repeat card numbers/);
  });
});
