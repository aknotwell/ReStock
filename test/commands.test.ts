import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/messaging/commands.js";

describe("parseCommand (LLM fallback)", () => {
  it("parses order now", () => {
    expect(parseCommand("Order now")[0]?.type).toBe("order_now");
  });

  it("parses add with personal flag", () => {
    expect(parseCommand("add tortilla chips for me")[0]).toMatchObject({ type: "add_item", itemName: "tortilla chips", shared: false });
    expect(parseCommand("add dish soap")[0]).toMatchObject({ type: "add_item", itemName: "dish soap", shared: null });
  });
});

describe("AI identity disclosure (AGENTS.md: the agent says it's an AI when asked)", () => {
  it.each([
    "are you a real person?", "Are you human", "is this a bot?", "who is this", "who's this?", "who are you?",
    "are you an AI?", "is this a real person", "am I talking to a bot?", "Am I texting with a human?", "are you real?", "what are you",
  ])("%s -> help", (q) => {
    expect(parseCommand(q)[0]?.type).toBe("help");
  });

  it("does not treat shopping messages as identity questions", () => {
    expect(parseCommand("add dish soap")[0]?.type).toBe("add_item");
    expect(parseCommand("is this shared?")[0]?.type).not.toBe("help");
    expect(parseCommand("who added the chips?")[0]?.type).not.toBe("help");
  });
});

describe("everyday ways to add items (works without the LLM)", () => {
  const adds = (text: string) => parseCommand(text).map((i) => (i.type === "add_item" ? i.itemName : i.type));

  it.each([
    ["We're out of toilet paper", ["toilet paper"]],
    ["we\u2019re out of TP and dish soap", ["tp", "dish soap"]],
    ["running low on paper towels!", ["paper towels"]],
    ["ugh we ran out of eggs", ["eggs"]],
    ["can we get oat milk?", ["oat milk"]],
    ["we need more trash bags please", ["trash bags"]],
    ["grab some coffee", ["coffee"]],
    ["add sponges to the list", ["sponges"]],
    ["out of laundry detergent, eggs and coffee", ["laundry detergent", "eggs", "coffee"]],
  ])("%j -> %j", (text, items) => {
    expect(adds(text)).toEqual(items);
  });

  it("keeps 'for me' as personal", () => {
    expect(parseCommand("I need coffee for me")[0]).toMatchObject({ type: "add_item", itemName: "coffee", shared: false });
  });

  it("marks shared/personal per item in a list", () => {
    expect(parseCommand("I need coffee for me and dish soap for everyone")).toEqual([
      { type: "add_item", itemName: "coffee", quantity: null, shared: false },
      { type: "add_item", itemName: "dish soap", quantity: null, shared: true },
    ]);
  });

  it("reads 'add X to the list?' with a question mark", () => {
    expect(adds("add eggs to the list?")).toEqual(["eggs"]);
  });

  it.each(["I'm out of town this weekend", "we need to talk", "short on time today", "let's get pizza", "out of curiosity, do we have soap?"])(
    "leaves ordinary chat alone: %j",
    (text) => {
      expect(parseCommand(text).some((i) => i.type === "add_item")).toBe(false);
    },
  );

  it("still handles the plain commands", () => {
    expect(adds("add dish soap")).toEqual(["dish soap"]);
    expect(parseCommand("order now")[0]?.type).toBe("order_now");
  });
});
