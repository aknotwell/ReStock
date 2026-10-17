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
