// Inbound pipeline in console mode (no Photon/Anthropic keys): deterministic fallbacks only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedDemo } from "../scripts/seed.js";
import { db, getHousehold, pendingItems, UNBOUND_GROUP } from "../src/core/store.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { clearPendingChoices } from "../src/messaging/options.js";
import { rememberInbound, type InboundMessage } from "../src/messaging/photon.js";

let n = 0;
const text = (fromPhone: string, body: string, spaceKind: "group" | "direct" = "group", spaceId = "pho_spc_group"): InboundMessage => ({
  messageId: `m${++n}`,
  spaceId,
  spaceKind,
  fromPhone,
  text: body,
  agentUserId: "pho_usr_agent",
});

const SAM = "+15550000001";

async function send(msg: InboundMessage) {
  rememberInbound(msg);
  await handleInbound(msg);
}

describe("handleInbound", () => {
  let logs: string[];
  beforeEach(() => {
    seedDemo();
    clearPendingChoices();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("binds the household to the first group chat a member texts from", async () => {
    expect(getHousehold("demo-house").groupChatId).toBe(UNBOUND_GROUP);
    await send(text(SAM, "help"));
    expect(getHousehold("demo-house").groupChatId).toBe("pho_spc_group");
    expect(logs.join("\n")).toMatch(/AI assistant/);
  });

  it.each(["are you a real person?", "is this a bot?", "who is this", "are you an AI?"])("says it is an AI when asked %j", async (q) => {
    await send(text(SAM, q));
    expect(logs.join("\n")).toMatch(/I'm Restock, an AI assistant/);
  });

  it.each(["4242  4242  4242  4242", "4242.4242.4242.4242", "4242/4242/4242/4242", "4242\n4242\n4242\n4242"])(
    "drops a card number written as %j", async (body) => {
      const before = pendingItems("demo-house").length;
      await send(text(SAM, `add chips ${body}`));
      expect(pendingItems("demo-house")).toHaveLength(before);
      expect(logs.join("\n")).not.toMatch(/4242/);
    });

  it("adds a catalog item with its catalog price and confirms it", async () => {
    const before = pendingItems("demo-house").length;
    await send(text(SAM, "add hand soap"));
    expect(pendingItems("demo-house")).toHaveLength(before); // asks which one first
    expect(logs.join("\n")).toMatch(/Which one\?\n1\. Hand soap refill, 50 oz: \$7\.99/);
    await send(text(SAM, "1"));
    const items = pendingItems("demo-house");
    expect(items).toHaveLength(before + 1);
    expect(items.at(-1)).toMatchObject({ name: "Hand soap refill, 50 oz", cents: 799, addedBy: "sam" });
    expect(logs.join("\n")).toMatch(/Added Hand soap refill, 50 oz \(shared, \$7\.99\)/);
  });

  it("drops messages containing a card number and never adds an item", async () => {
    const before = db.items.size;
    await send(text(SAM, "add 4242 4242 4242 4242", "direct", "pho_spc_dm_sam"));
    expect(db.items.size).toBe(before);
    const out = logs.join("\n");
    expect(out).toMatch(/I can't confirm, store, or repeat card numbers/);
    expect(out).not.toMatch(/4242 4242/);
  });

  it("tells unknown direct senders how to join", async () => {
    await send(text("+19999999999", "hi", "direct", "pho_spc_dm_stranger"));
    expect(logs.join("\n")).toMatch(/budget owner to add you/);
  });

  it("ignores unknown group chats", async () => {
    await send(text("+19999999999", "add tp", "group", "pho_spc_other"));
    expect(logs).toHaveLength(0);
  });
});

describe("V-008 card links only on request", () => {
  beforeEach(() => {
    seedDemo();
  });

  it("the card-number refusal never contains a link or token", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    await send(text(SAM, "my card is 4532 1234 5678 9010", "direct", "pho_spc_dm_sam_v8"));
    const out = logs.join("\n");
    expect(out).toMatch(/I can't confirm, store, or repeat card numbers/);
    expect(out).toMatch(/text "add card"/);
    expect(out).not.toMatch(/https?:\/\/|\/c\/|4532/);
  });

  it("'add card' sends the secure setup link to the member", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    await send(text(SAM, "add card", "direct", "pho_spc_dm_sam_v8b"));
    expect(logs.join("\n")).toMatch(/Add a card so your share is paid automatically: https?:\/\/\S+\/c\/\S+/);
  });
});
