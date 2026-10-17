import { beforeEach, describe, expect, it, vi } from "vitest";
const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock("../src/ai/client.js", () => ({ anthropic: { messages: { parse: model } }, MODEL: "test" }));
import { parseMessage } from "../src/ai/parseMessage.js";
import { matchItem } from "../src/ai/matchItem.js";
import { suggestRestock } from "../src/ai/suggestRestock.js";
const intent = (type: string, itemName: string | null = null) => ({ type, itemName, quantity: null, shared: null });

describe("untrusted model responses", () => {
  beforeEach(() => { model.mockReset(); });
  it("removes model-issued checkout and approval", async () => {
    model.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { intents: [intent("order_now"), intent("approve")] } });
    expect(await parseMessage("we need some stuff", "Private Name")).toEqual([]);
    expect(JSON.stringify(model.mock.calls)).not.toContain("Private Name");
  });
  it("runs explicit checkout without a model call", async () => {
    expect((await parseMessage("order now", "Sam"))[0]?.type).toBe("order_now");
    expect(model).not.toHaveBeenCalled();
  });
  it("rejects malformed or unsafe intent output", async () => {
    model.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { intents: [intent("add_item", "sam@example.com")] } });
    expect(await parseMessage("we need stuff", "Sam")).toEqual([]);
    model.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { intents: [{ ...intent("add_item", "soap"), quantity: -1 }] } });
    expect((await parseMessage("we need stuff", "Sam"))[0]?.type).toBe("unknown");
  });
  it("never sends sensitive inputs to either model entry point", async () => {
    await parseMessage("sam@example.com", "Sam");
    await matchItem("sam@example.com");
    expect(model).not.toHaveBeenCalled();
  });
  it("does not log provider error payloads", async () => {
    const original = console.warn;
    const logs: unknown[][] = [];
    console.warn = (...args: unknown[]) => { logs.push(args); };
    try {
      model.mockRejectedValue(new Error("PRIVATE_PROVIDER_PAYLOAD"));
      expect((await parseMessage("we need stuff", "Sam"))[0]?.type).toBe("unknown");
      expect(await matchItem("stuff")).toBeUndefined();
      expect(logs).toEqual([["AI parse failed; using command parser."], ["AI match failed; using keyword match."]]);
    } finally { console.warn = original; }
  });
  it("uses calculated restock reasons instead of model prose", async () => {
    model.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { suggestions: [
      { productId: "tp-12", reason: "PRIVATE_MODEL_OUTPUT" },
      { productId: "coffee", reason: "invented history" },
    ] } });
    const result = await suggestRestock([{ productId: "tp-12", orderedAt: "2026-09-30T12:00:00Z" }], new Set(), new Date("2026-10-17T12:00:00Z"));
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toBe("Last ordered 17 days ago.");
  });
});
