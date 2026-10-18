import { beforeEach, expect, it, vi } from "vitest";
const { parse, order } = vi.hoisted(() => ({ parse: vi.fn(), order: vi.fn() }));
vi.mock("../src/ai/parseMessage.js", () => ({ parseMessage: parse }));
vi.mock("../src/core/orders.js", () => ({ placeOrder: order, OrderError: class extends Error {} }));
import { handleInbound } from "../src/messaging/inbound.js";
import { captureOutbound } from "../src/messaging/photon.js";
import { seedDemo } from "../scripts/seed.js";
import { OrderError } from "../src/core/orders.js";
beforeEach(() => {
  seedDemo(); order.mockReset();
  parse.mockResolvedValue([{ type: "order_now", itemName: null, quantity: null, shared: null }]);
  order.mockRejectedValue(new OrderError("Checkout handoff verified."));
});
const send = (text: string, fromPhone = "+15550000001") => captureOutbound(() => handleInbound({
  messageId: "authorization", spaceId: "dm", spaceKind: "direct", fromPhone, text,
}));
it("rejects model-issued checkout even when the parser is bypassed", async () => {
  await send("buy whatever you think we need");
  expect(order).not.toHaveBeenCalled();
});
it("requires an authenticated household member", async () => {
  await send("order now", "unknown");
  expect(order).not.toHaveBeenCalled();
});
it("hands off a member's explicit command exactly once, after their yes", async () => {
  await send("order now");
  expect(order).not.toHaveBeenCalled(); // "order now" shows what would be bought first
  const replies = await send("yes");
  expect(order).toHaveBeenCalledExactlyOnceWith("demo-house");
  expect(replies.join()).toContain("Checkout handoff verified.");
});
