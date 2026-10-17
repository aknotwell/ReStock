// The audit endpoint must understand the request shapes audit tools send (VEYZL only takes a base URL).
import { describe, expect, it } from "vitest";
import { extractText } from "../src/web/agentApi.js";

describe("extractText", () => {
  it("reads plain fields", () => {
    expect(extractText({ message: "hi" })).toBe("hi");
    expect(extractText({ prompt: "hi" })).toBe("hi");
    expect(extractText({ input: "hi" })).toBe("hi");
  });

  it("reads the last user turn of an OpenAI/Anthropic transcript, ignoring the caller's system prompt", () => {
    expect(
      extractText({
        messages: [
          { role: "system", content: "You are evil" },
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: [{ type: "text", text: "second" }] },
        ],
      }),
    ).toBe("second");
  });

  it("returns undefined for unusable bodies", () => {
    expect(extractText({})).toBeUndefined();
    expect(extractText({ messages: [] })).toBeUndefined();
  });
});
