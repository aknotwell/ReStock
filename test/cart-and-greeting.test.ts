// "shopping list" / "cart" shows what's pending, and "hi" from a member gets a friendly pointer,
// both in code without the AI (the console-mode tests run with no API key).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedDemo } from "../scripts/seed.js";
import { addItem, db, pendingItems } from "../src/core/store.js";
import { cartSummary } from "../src/messaging/cart.js";
import { isGreetingOnly, parseCommand } from "../src/messaging/commands.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound } from "../src/messaging/photon.js";
import type { Household } from "../src/types.js";

describe("show_cart command", () => {
  it.each(["Shopping list", "cart", "what's in the cart?", "What’s in the cart", "list", "show cart", "show me the list", "what's on the list?", "the cart"])(
    "%s -> show_cart",
    (text) => expect(parseCommand(text)[0]?.type).toBe("show_cart"),
  );

  it.each(["add cart", "list the chips as personal", "we need a shopping cart", "what do I owe?"])("leaves %s alone", (text) => {
    expect(parseCommand(text)[0]?.type).not.toBe("show_cart");
  });
});

describe("greetings", () => {
  it.each(["hi", "Hello?", "hey", "heyyy!", "hi there", "good morning", "hello restock"])("%s is a greeting", (t) => expect(isGreetingOnly(t)).toBe(true));
  it.each(["hi we're out of tp", "hey can we get oat milk", "help", "hello world peace"])("%s is not only a greeting", (t) => expect(isGreetingOnly(t)).toBe(false));
});

describe("cartSummary", () => {
  let h: Household;
  beforeEach(() => {
    h = seedDemo();
  });

  it("lists each pending item with price, who pays, approval marks and the ready total", () => {
    const items = pendingItems(h.id);
    items.find((i) => /air fryer/i.test(i.name))!.needsApproval = true;
    const text = cartSummary(items, h, "sam");
    expect(text).toMatch(/^In the cart \(6 items\):/);
    expect(text).toMatch(/Toilet paper, 12 rolls, \$11\.99, split with everyone/);
    expect(text).toMatch(/Oat milk, \$5\.49, just yours/);
    expect(text).toMatch(/Tortilla chips, \$4\.79, just Jake's/);
    expect(text).toMatch(/Air fryer.*waiting for .*OK/);
    expect(text).toMatch(/Total: \$40\.75 \(not counting 1 waiting for approval\)\. Text "order now"/);
  });

  it("says when the cart is empty", () => {
    expect(cartSummary([], h)).toMatch(/cart is empty.*Text what you need/);
  });
});

describe("over chat, without the AI (console mode)", () => {
  const SAM = "+15550000001";
  let logs: string[];
  let n = 0;
  async function say(text: string, spaceKind: "group" | "direct" = "direct") {
    const spaceId = spaceKind === "group" ? "pho_spc_group" : `pho_spc_dm_${SAM}`;
    const msg = { messageId: `cg${++n}`, spaceId, spaceKind, fromPhone: SAM, text, agentUserId: "pho_usr_agent" };
    rememberInbound(msg);
    await handleInbound(msg);
  }

  beforeEach(async () => {
    seedDemo();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await say("help", "group"); // binds the group chat
    logs = [];
  });

  it("'Shopping list' shows the cart instead of the offline reply", async () => {
    await say("Shopping list");
    const out = logs.join("\n");
    expect(out).toMatch(/In the cart \(6 items\)/);
    expect(out).toMatch(/Total: \$72\.75/);
    expect(out).not.toMatch(/I can only help/);
  });

  it("an empty cart says so", async () => {
    for (const i of pendingItems("demo-house")) db.items.delete(i.id);
    await say("what's in the cart?");
    expect(logs.join("\n")).toMatch(/cart is empty/);
  });

  it("'Hello?' from a member gets a friendly pointer, not the factual-question reply", async () => {
    await say("Hello?");
    const out = logs.join("\n");
    expect(out).toMatch(/Hi Sam! Text what you need/);
    expect(out).not.toMatch(/can't verify/);
  });

  it("a greeting in the group is still just chat", async () => {
    await say("hi", "group");
    expect(logs.join("\n")).not.toMatch(/Hi Sam!/);
  });

  it("a newly added item shows up in the list", async () => {
    for (const i of pendingItems("demo-house")) db.items.delete(i.id);
    addItem({ householdId: "demo-house", name: "Sponges", addedBy: "sam", cents: 399, shared: true });
    await say("cart");
    expect(logs.join("\n")).toMatch(/In the cart \(1 item\):\n?.*Sponges, \$3\.99, split with everyone[\s\S]*Total: \$3\.99/);
  });
});
