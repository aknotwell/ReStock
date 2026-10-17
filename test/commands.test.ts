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
