// With Claude picking the store listings, it also says what's worth narrowing down (ask_about). Code only shows a
// hint for what the chosen listings really differ in, and writes it from the listing data, never the model's words.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { parse, create } = vi.hoisted(() => ({ parse: vi.fn(), create: vi.fn() }));
vi.mock("../src/ai/client.js", () => ({ anthropic: { messages: { parse }, beta: { messages: { create } } }, MODEL: "test" }));

import { seedDemo } from "../scripts/seed.js";
import { findDealsDetailed } from "../src/ai/findDeals.js";
import { config } from "../src/config.js";
import { clearLiveDeals } from "../src/deals/live.js";
import { resetDetails } from "../src/messaging/details.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { clearPendingChoices } from "../src/messaging/options.js";
import { rememberInbound, type InboundMessage } from "../src/messaging/photon.js";

const row = (title: string, source: string, price: number) => ({ title, source, extracted_price: price });
const VARIED = {
  shopping_results: [
    row("Charmin Ultra Soft Toilet Paper, 12 Rolls", "Target", 11.99), // [1]
    row("Charmin Ultra Strong Toilet Paper, 24 Rolls", "Walmart", 21.49), // [2]
    row("Charmin Essentials Toilet Paper, 18 Rolls", "Costco", 16.99), // [3]
  ],
};
let replies: string[] = [];
let n = 0;

const toolUse = (name: string, input: unknown) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: `tu_${name}_${n}`, name, input }] });
function claudeChooses(numbers: number[], askAbout: string[]) {
  create
    .mockResolvedValueOnce(toolUse("search_store", { query: "toilet paper" }))
    .mockResolvedValueOnce(toolUse("choose_listings", { listing_numbers: numbers, ask_about: askAbout }));
}

async function dm(text: string): Promise<string> {
  const before = replies.length;
  const msg: InboundMessage = { messageId: `dh${++n}`, spaceId: "pho_spc_dm_sam", spaceKind: "direct", fromPhone: "+15550000001", text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
  return replies.slice(before).join("\n");
}

beforeEach(() => {
  seedDemo();
  clearPendingChoices();
  clearLiveDeals();
  resetDetails();
  create.mockReset();
  config.serpapiKey = "test-key";
  replies = [];
  // Intent parsing and catalog matching: "add_item: toilet paper", matched to the catalog's toilet paper.
  parse.mockImplementation(async (params: { system: string }) =>
    params.system.includes("Catalog:")
      ? { stop_reason: "end_turn", parsed_output: { productId: "tp-12", confidence: "high" } }
      : { stop_reason: "end_turn", parsed_output: { intents: [{ type: "add_item", itemName: "Toilet paper", quantity: null, shared: null }] } },
  );
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(VARIED))));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    const line = a.join(" ");
    if (line.startsWith("[photon:console")) replies.push(line);
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  config.serpapiKey = undefined;
  vi.unstubAllGlobals();
});

describe("Claude's ask_about", () => {
  it("is returned with the picks", async () => {
    claudeChooses([2, 1], ["size"]);
    const result = await findDealsDetailed("toilet paper");
    expect(result?.picks.map((p) => p.offer.store)).toEqual(["Walmart", "Target"]);
    expect(result?.askAbout).toEqual(["size"]);
  });

  it("'size': the hint names the sizes the listings come in, not the brand", async () => {
    claudeChooses([1, 2, 3], ["size"]);
    const reply = await dm("We're out of toilet paper");
    expect(reply).toMatch(/Want a size \(12, 18 or 24 rolls\)\? Reply like "24 rolls" and I'll search again\./);
  });

  it("'brand' when every listing is the same brand: code drops it, so no hint", async () => {
    claudeChooses([1, 2, 3], ["brand"]);
    expect(await dm("We're out of toilet paper")).not.toMatch(/Want a/);
  });

  it("nothing to ask about: no hint", async () => {
    claudeChooses([1, 2, 3], []);
    expect(await dm("We're out of toilet paper")).not.toMatch(/Want a/);
  });

  it("an answer without ask_about counts as nothing to ask about", async () => {
    create
      .mockResolvedValueOnce(toolUse("search_store", { query: "toilet paper" }))
      .mockResolvedValueOnce(toolUse("choose_listings", { listing_numbers: [1, 2, 3] }));
    expect((await findDealsDetailed("toilet paper"))?.askAbout).toEqual([]);
  });
});
