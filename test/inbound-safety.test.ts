import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  events: [] as string[],
  intents: [] as Array<{ type: string; itemName: null; quantity: null; shared: null }>,
}));

vi.mock("../src/messaging/guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messaging/guard.js")>();
  return {
    containsCardNumber: (text: string) => {
      calls.events.push("guard");
      return actual.containsCardNumber(text);
    },
  };
});

vi.mock("../src/core/store.js", () => ({
  findHouseholdByGroupChat: () => {
    calls.events.push("database");
    return { id: "home", members: [] };
  },
  findMemberByPhone: () => ({ id: "member", name: "Sam" }),
}));
vi.mock("../src/ai/parseMessage.js", () => ({
  parseMessage: () => {
    calls.events.push("AI");
    return calls.intents;
  },
}));
vi.mock("../src/ai/matchItem.js", () => ({ matchItem: vi.fn() }));
vi.mock("../src/core/orders.js", () => ({
  OrderError: class OrderError extends Error {},
  placeOrder: () => { calls.events.push("charge"); return {}; },
}));
vi.mock("../src/payments/links.js", () => ({ createCardSetupLink: () => "https://example.test/card" }));
vi.mock("../src/messaging/photon.js", () => ({
  sendGroup: vi.fn(),
  sendPrivate: () => { calls.events.push("private warning"); },
}));
vi.mock("../src/messaging/templates.js", () => ({
  cardNumberWarning: () => "Use the secure card link",
  fmt: vi.fn(),
  groupSummary: () => "Ordered",
  helpMessage: vi.fn(),
}));

import { handleInbound } from "../src/messaging/inbound.js";

describe("inbound safety gates", () => {
  beforeEach(() => {
    calls.events.length = 0;
    calls.intents = [];
  });

  it("drops card data before the database or AI sees the message", async () => {
    await handleInbound({ groupChatId: "group", fromPhone: "sender", text: "my card is 4242 4242 4242 4242" });
    expect(calls.events).toEqual(["guard", "database", "private warning"]);
  });

  it("ignores a model's order intent without the exact human command", async () => {
    calls.intents = [{ type: "order_now", itemName: null, quantity: null, shared: null }];
    await handleInbound({ groupChatId: "group", fromPhone: "sender", text: "do not order now" });
    expect(calls.events).toEqual(["guard", "database", "AI"]);
  });

  it("accepts an explicit human order command", async () => {
    await handleInbound({ groupChatId: "group", fromPhone: "sender", text: " Order Now " });
    expect(calls.events).toEqual(["guard", "database", "charge"]);
  });
});
