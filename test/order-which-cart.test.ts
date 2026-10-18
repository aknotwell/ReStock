// "order now" shows which cart and who pays for what before anything is bought, asks which cart when the sender
// is in several groups, and explains plainly when the budget owner has no card yet.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", () => ({ anthropic: undefined, MODEL: "test" }));
// Stripe is faked: holds succeed and are captured, so a confirmed order goes through.
const fakeStripe = vi.hoisted(() => ({
  paymentIntents: {
    create: async (p: { amount: number }) => ({ id: `pi_${p.amount}`, status: "requires_capture" }),
    capture: async () => ({}),
    cancel: async () => ({}),
  },
  refunds: { create: async () => ({}) },
}));
vi.mock("../src/payments/stripe.js", () => ({ stripe: undefined, requireStripe: () => fakeStripe }));

import { seedDemo } from "../scripts/seed.js";
import { addItem, db, pendingItems } from "../src/core/store.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound } from "../src/messaging/photon.js";
import { resetConfirmations } from "../src/messaging/confirm.js";

const SAM = "+15550000001";
const JAKE = "+15550000002";
let logs: string[];
let n = 0;

async function say(from: string, text: string, spaceKind: "group" | "direct" = "group") {
  const spaceId = spaceKind === "group" ? "pho_spc_group" : `pho_spc_dm_${from}`;
  const msg = { messageId: `oc${++n}`, spaceId, spaceKind, fromPhone: from, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
}
const out = () => logs.join("\n");
const ordersFor = (householdId: string) => [...db.orders.values()].filter((o) => o.householdId === householdId);

/** Sam is also in Alex's household, a second group with one shared item. Alex has no card yet. */
function addSecondHousehold() {
  db.households.set("alex-house", {
    id: "alex-house",
    kind: "group",
    groupChatId: "pho_spc_alex",
    ownerId: "alex",
    spentCents: 0,
    members: [
      { id: "alex", name: "Alex", phone: "+15550000099", role: "owner" },
      { id: "sam-2", name: "Sam", phone: SAM, role: "member" },
    ],
  });
  addItem({ householdId: "alex-house", name: "Coffee beans", addedBy: "alex", cents: 1299, shared: true });
}

beforeEach(async () => {
  const h = seedDemo();
  for (const m of h.members) if (m.paymentMethodId) m.stripeCustomerId = `cus_${m.id}`;
  db.households.delete("alex-house");
  for (const i of [...db.items.values()]) if (i.householdId === "alex-house") db.items.delete(i.id);
  for (const [id, o] of db.orders) if (o.householdId === "alex-house") db.orders.delete(id);
  resetConfirmations();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await say(SAM, "help"); // binds the demo group chat
  logs = [];
});

describe("before buying: which cart, and who pays for what", () => {
  it("groups the demo cart into shared, personal and someone else's personal items", async () => {
    await say(JAKE, "order now");
    expect(out()).toContain(
      [
        "Order for Sam's household (Sam, you and Priya)? 6 items, $72.75.",
        "Shared (everyone): Toilet paper, 12 rolls $11.99; Dish soap, 3 pack $8.49; Paper towels, 6 rolls $9.99",
        "Personal (just you): Air fryer (approved by Sam) $32.00; Tortilla chips $4.79",
        "Personal (Sam): Oat milk $5.49",
        'Reply "yes" to order or "no" to cancel.',
      ].join("\n"),
    );
    expect(db.orders.size).toBe(0); // nothing bought yet
    await say(JAKE, "yes");
    expect(db.orders.size).toBe(1);
    expect(out()).toMatch(/Ordered! 6 items, \$72\.75/);
  });

  it("shows items split between some people", async () => {
    const chips = pendingItems("demo-house").find((i) => i.name === "Tortilla chips")!;
    chips.splitWith = ["jake", "priya"];
    await say(JAKE, "order now");
    expect(out()).toMatch(/Split \(you and Priya\): Tortilla chips \$4\.79/);
  });

  it("'no' cancels, and nothing is bought", async () => {
    await say(JAKE, "order now");
    await say(JAKE, "no");
    expect(out()).toMatch(/OK, I won't do that\./);
    expect(db.orders.size).toBe(0);
  });
});

describe("in several groups", () => {
  it("'order now' one-on-one asks which cart, and 'yes' orders only that one", async () => {
    addSecondHousehold();
    Object.assign(db.households.get("alex-house")!.members[0]!, { paymentMethodId: "pm_card_visa", stripeCustomerId: "cus_alex" });
    await say(SAM, "order now", "direct");
    expect(out()).toMatch(/Which cart should I order\?\n1\. Your household \(you, Jake and Priya\)\n2\. Alex's household \(Alex and you\)\nReply with a number, or "cancel"\./);
    logs = [];
    await say(SAM, "2", "direct");
    expect(out()).toMatch(/Order for Alex's household \(Alex and you\)\? 1 item, \$12\.99\.\nShared \(everyone\): Coffee beans \$12\.99/);
    await say(SAM, "yes", "direct");
    expect(ordersFor("alex-house")).toHaveLength(1);
    expect(ordersFor("demo-house")).toHaveLength(0);
  });

  it("names the cart when adding, so it's clear which list it went to", async () => {
    addSecondHousehold();
    await say(SAM, "add oat milk");
    await say(SAM, "2"); // "Which one?": the plain oat milk
    expect(out()).toMatch(/Added Oat milk to your household \(/);
  });

  it("in a group chat, or with one group, there's no question about which cart", async () => {
    addSecondHousehold();
    await say(SAM, "order now"); // the demo group chat
    expect(out()).not.toMatch(/Which cart/);
    expect(out()).toMatch(/Order for your household/);
  });
});

describe("when the budget owner has no card", () => {
  it("explains what's blocked and why, charges nothing, and texts the owner a link", async () => {
    addSecondHousehold();
    await say(SAM, "order now", "direct");
    logs = [];
    await say(SAM, "2", "direct");
    expect(out()).toMatch(
      /I can't order for Alex's household \(Alex and you\) yet\. Alex is the budget owner, and their card has to be on file because it covers anyone without a card\. I've texted Alex a secure link to add one\. Nothing was charged and the cart is saved: text "order now" again once Alex has added it\./,
    );
    expect(out()).not.toMatch(/Reply "yes" to order/);
    expect(ordersFor("alex-house")).toHaveLength(0);
  });
});
