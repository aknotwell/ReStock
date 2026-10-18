// Everyday ways of asking for something work without the AI ("we're out of TP"), but only for real
// catalog items, so ordinary chat in the group never gets a reply.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedDemo } from "../scripts/seed.js";
import { db, pendingItems } from "../src/core/store.js";
import { casualItems } from "../src/messaging/casualAdd.js";
import { parseCommand } from "../src/messaging/commands.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { rememberInbound } from "../src/messaging/photon.js";

describe("casual requests become add_item", () => {
  it.each([
    ["we're out of TP", ["tp"]],
    ["We are out of toilet paper!", ["toilet paper"]],
    ["ugh we're out of dish soap again lol", ["dish soap"]],
    ["ran out of coffee", ["coffee"]],
    ["running low on paper towels", ["paper towels"]],
    ["almost out of eggs", ["eggs"]],
    ["we need trash bags", ["trash bags"]],
    ["can we get oat milk?", ["oat milk"]],
    ["can someone grab sponges", ["sponges"]],
    ["could you pick up laundry detergent please", ["laundry detergent"]],
    ["buy coffee", ["coffee"]],
    ["grab some chips", ["chips"]],
    ["the coffee is almost gone", ["coffee"]],
    ["dish soap is out", ["dish soap"]],
    ["no more paper towels", ["paper towels"]],
    ["tp please", ["tp"]],
    ["more coffee pls", ["coffee"]],
    ["out of eggs 🥚", ["eggs"]],
    ["Im out of fucking dish soap", ["dish soap"]],
    ["im out of dish soap", ["dish soap"]],
    ["were out of tp", ["tp"]],
    ["ive run out of coffee", ["coffee"]],
    ["we're out of freaking paper towels", ["paper towels"]],
    ["need damn tp", ["tp"]],
  ])("%s", (text, items) => {
    expect(casualItems(text)).toEqual(items);
    expect(parseCommand(text).map((i) => [i.type, i.itemName])).toEqual(items.map((n) => ["add_item", n]));
  });

  it("strips swearing from item names, whatever the case", async () => {
    const { stripIntensifiers } = await import("../src/messaging/casualAdd.js");
    expect(stripIntensifiers("Fucking dish soap")).toBe("dish soap");
    expect(stripIntensifiers("the freakin' TP")).toBe("the TP");
    expect(stripIntensifiers("dish soap")).toBe("dish soap");
  });

  it("splits several items, only when each one is a catalog item", () => {
    expect(casualItems("we need tp and dish soap")).toEqual(["tp", "dish soap"]);
    expect(casualItems("we're out of tp, dish soap and sponges")).toEqual(["tp", "dish soap", "sponges"]);
    expect(casualItems("we need mac and cheese")).toBeUndefined(); // not in the catalog, so not split or added
  });

  it("keeps who it's for, so splitWith can read it", () => {
    expect(casualItems("we need oat milk for me and jake")).toEqual(["oat milk for me and jake"]);
    expect(casualItems("we're out of tp and eggs for jake and priya")).toEqual(["tp", "eggs for jake and priya"]);
  });

  it.each([
    "I need a nap", "we're out of ideas", "we need to talk", "I'm out of here", "get out", "thanks", "please",
    "ok sounds good", "can you get the door?", "we need to clean", "is this shared?",
  ])("leaves ordinary chat alone: %s", (text) => {
    expect(casualItems(text)).toBeUndefined();
    expect(parseCommand(text).some((i) => i.type === "add_item")).toBe(false);
  });

  it("doesn't change the existing commands", () => {
    expect(parseCommand("order now")[0]?.type).toBe("order_now");
    expect(parseCommand("add dish soap")[0]).toMatchObject({ type: "add_item", itemName: "dish soap" });
    expect(parseCommand("personal")[0]?.type).toBe("set_shared");
  });
});

describe("over chat, without the AI (console mode)", () => {
  const SAM = "+15550000001";
  let logs: string[];
  let n = 0;
  async function say(text: string) {
    const msg = { messageId: `ca${++n}`, spaceId: "pho_spc_group", spaceKind: "group" as const, fromPhone: SAM, text, agentUserId: "pho_usr_agent" };
    rememberInbound(msg);
    await handleInbound(msg);
  }

  beforeEach(async () => {
    const h = seedDemo();
    for (const i of pendingItems(h.id)) db.items.delete(i.id);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await say("help"); // binds the group chat
    logs = [];
  });

  it("'we're out of TP and dish soap' offers both, one after the other, and adds both", async () => {
    await say("we're out of TP and dish soap");
    expect(logs.join("\n")).toMatch(/Which one\?[\s\S]*Toilet paper/);
    await say("1");
    await say("1");
    expect(pendingItems("demo-house").map((i) => i.name)).toEqual([expect.stringMatching(/toilet paper/i), expect.stringMatching(/dish soap/i)]);
  });

  it("ordinary chat in the group gets no reply at all", async () => {
    for (const t of ["we're out of ideas lol", "I need a nap", "we need to talk later"]) await say(t);
    expect(logs).toHaveLength(0);
    expect(pendingItems("demo-house")).toHaveLength(0);
  });
});
