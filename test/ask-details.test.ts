// "Any brand or size?": asked only when a store search comes back thin and the member didn't say a brand or size.
// Their answer is searched again, "any" shows what was found, "cancel" drops it, and anything else moves on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", () => ({ anthropic: undefined, MODEL: "test" }));

import { seedDemo } from "../scripts/seed.js";
import { config } from "../src/config.js";
import { clearLiveDeals } from "../src/deals/live.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { pendingDetails, resetDetails } from "../src/messaging/details.js";
import { clearPendingChoices } from "../src/messaging/options.js";
import { rememberInbound, type InboundMessage } from "../src/messaging/photon.js";

const SAM = "+15550000001";
const row = (title: string, source: string, price: number) => ({ title, source, extracted_price: price });
const THIN = { shopping_results: [row("Charmin Ultra Soft Toilet Paper, 12 Rolls", "Target", 11.99), row("Toilet Paper Holder", "Walmart", 14.99)] };
const PLENTY = {
  shopping_results: [
    row("Charmin Ultra Strong Toilet Paper, 24 Rolls", "Target", 23.99),
    row("Quilted Northern Toilet Paper, 24 Rolls", "Walmart", 21.49),
    row("Cottonelle Toilet Paper, 24 Rolls", "Costco", 19.99),
  ],
};
let results: Record<string, unknown> = {};
let fetchMock: ReturnType<typeof vi.fn>;
let replies: string[] = [];
let n = 0;

async function dm(text: string): Promise<string> {
  const before = replies.length;
  const msg: InboundMessage = { messageId: `ad${++n}`, spaceId: "pho_spc_dm_sam", spaceKind: "direct", fromPhone: SAM, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
  return replies.slice(before).join("\n");
}
const searched = () => fetchMock.mock.calls.map(([url]) => new URL(url as string).searchParams.get("q"));

beforeEach(() => {
  seedDemo();
  clearPendingChoices();
  clearLiveDeals();
  resetDetails();
  config.serpapiKey = "test-key";
  replies = [];
  results = { "Toilet paper 12 rolls": THIN, "Toilet paper 24 rolls": PLENTY };
  fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(results[new URL(url).searchParams.get("q")!] ?? {})));
  vi.stubGlobal("fetch", fetchMock);
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

const QUESTION = /I only found 1 good match for toilet paper\. Any brand or size you want\? \(like "Charmin, 24 rolls"\) Or reply "any" to see what I found\./;

describe("asking for a brand or size", () => {
  it("asks when the search is thin and they didn't say a brand or size", async () => {
    const reply = await dm("We're out of toilet paper");
    expect(reply).toMatch(QUESTION);
    expect(reply).not.toMatch(/Which one\?/);
  });

  it("searches again with their answer, and doesn't ask twice", async () => {
    await dm("We're out of toilet paper");
    const reply = await dm("Charmin, 24 rolls");
    expect(searched()).toContain("Toilet paper 24 rolls");
    expect(reply).toMatch(/Which one\?\n1\. .*24 Rolls/);
    expect(reply).not.toMatch(/Any brand or size/);
    expect(pendingDetails("demo-house", "sam")).toBeUndefined();
  });

  it("'any' shows what it found", async () => {
    await dm("We're out of toilet paper");
    expect(await dm("any")).toMatch(/Which one\?\n1\. Charmin Ultra Soft Toilet Paper, 12 Rolls \(Target\): \$11\.99/);
  });

  it("'cancel' drops it", async () => {
    await dm("We're out of toilet paper");
    expect(await dm("cancel")).toEqual(expect.stringContaining("OK, I didn't add toilet paper."));
    expect(await dm("any")).not.toMatch(/Which one\?/); // nothing left waiting
  });

  it("a command, a greeting or a question moves on instead of being searched", async () => {
    for (const other of ["shopping list", "hi", "what do I owe?"]) {
      await dm("We're out of toilet paper");
      fetchMock.mockClear();
      const reply = await dm(other);
      expect(reply, other).not.toMatch(/Any brand or size|Which one\?/);
      expect(searched(), other).toEqual([]);
      expect(pendingDetails("demo-house", "sam"), other).toBeUndefined();
    }
  });

  it("doesn't ask when they already named a size, or when there's plenty to choose from", async () => {
    expect(await dm("We're out of toilet paper, 24 rolls")).toMatch(/Which one\?/);
    results["Toilet paper 12 rolls"] = PLENTY;
    clearLiveDeals();
    expect(await dm("We're out of toilet paper")).toMatch(/Which one\?\n1\./);
  });

  it("doesn't ask when store prices aren't available (it wouldn't help)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    expect(await dm("We're out of toilet paper")).toMatch(/Restock demo prices/);
  });
});

describe("a hint when the request was vague but there's plenty to pick from", () => {
  const VARIED = {
    shopping_results: [
      row("Charmin Ultra Soft Toilet Paper, 12 Rolls", "Target", 11.99),
      row("Quilted Northern Toilet Paper, 24 Rolls", "Walmart", 21.49),
      row("Cottonelle Toilet Paper, 18 Rolls", "Costco", 16.99),
    ],
  };
  const HINT = /Reply 1, 2 or 3, or "cancel"\.\nWant a brand \((?:Charmin|Quilted|Cottonelle)(?:, (?:Charmin|Quilted|Cottonelle))? or (?:Charmin|Quilted|Cottonelle)\) or a size \(12, 18 or 24 rolls\)\? Reply like "\w+, 24 rolls" and I'll search again\./;

  it("shows the options now, with the brands and sizes these listings come in (code only, no Claude)", async () => {
    results["Toilet paper 12 rolls"] = VARIED;
    const reply = await dm("We're out of toilet paper");
    expect(reply).toMatch(/Which one\?\n1\./);
    expect(reply).toMatch(HINT);
  });

  it("a brand or size reply searches again instead of being misread", async () => {
    results["Toilet paper 12 rolls"] = VARIED;
    await dm("We're out of toilet paper");
    const reply = await dm("Cottonelle, 24 rolls");
    expect(searched()).toContain("Toilet paper 24 rolls");
    expect(reply).toMatch(/Which one\?\n1\. .*24 Rolls/);
    expect(reply).not.toMatch(/Want a brand/); // their answer isn't hinted again
    // The old question is gone: "1" now picks from the new search.
    expect(await dm("1")).toMatch(/Added .*24 Rolls/);
  });

  it("no hint when the listings don't differ, or they already said a size", async () => {
    results["Toilet paper 12 rolls"] = {
      shopping_results: [row("Charmin Toilet Paper, 12 Rolls", "Target", 11.99), row("Charmin Toilet Paper, 12 Rolls", "Walmart", 12.49)],
    };
    expect(await dm("We're out of toilet paper")).not.toMatch(/Want a/);
    results["Toilet paper 24 rolls"] = PLENTY;
    expect(await dm("We're out of toilet paper, 24 rolls")).not.toMatch(/Want a/);
  });

  it("'1' still picks normally from a hinted question", async () => {
    results["Toilet paper 12 rolls"] = VARIED;
    await dm("We're out of toilet paper");
    expect(await dm("1")).toMatch(/Added /);
  });
});

