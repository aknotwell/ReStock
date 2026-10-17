import { describe, expect, it } from "vitest";
import { helpMessage } from "../src/messaging/templates.js";

describe("helpMessage", () => {
  it("discloses that Restock is an AI and that nothing is charged without 'order now'", () => {
    const text = helpMessage();
    expect(text).toMatch(/AI assistant/);
    expect(text).toMatch(/not a person/);
    expect(text).toMatch(/order now/);
  });
});
