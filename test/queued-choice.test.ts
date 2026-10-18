// Replays a real session: a second "we're out of …" while a "Which one?" was waiting got no reply at all.
// Every message must get an answer, and asking for the same thing twice must not queue it twice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", () => ({ anthropic: undefined, MODEL: "test" }));

import { seedDemo } from "../scripts/seed.js";
import { config } from "../src/config.js";
import { clearLiveDeals } from "../src/deals/live.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { clearPendingChoices, queueChoices } from "../src/messaging/options.js";
import { rememberInbound, type InboundMessage } from "../src/messaging/photon.js";
import { pendingItems } from "../src/core/store.js";

const SAM = "+15550000001";
const row = (title: string, source: string, price: number) => ({ title, source, extracted_price: price });
const RESULTS: Record<string, unknown> = {
  "Toilet paper 12 rolls": { shopping_results: [row("Charmin Toilet Paper, 12 Rolls", "Target", 11.99), row("Scott ComfortPlus Toilet Paper, 12 Rolls", "Walmart", 7.47)] },
  "Dish soap 3 pack": { shopping_results: [row("Dawn Ultra Dish Soap, 3 Pack", "Walmart", 9.97), row("Palmolive Dish Soap, 3 Pack", "Target", 8.49)] },
};
let replies: string[] = [];
let n = 0;

async function dm(text: string): Promise<string> {
  const before = replies.length;
  const msg: InboundMessage = { messageId: `q${++n}`, spaceId: "pho_spc_dm_sam", spaceKind: "direct", fromPhone: SAM, text, agentUserId: "pho_usr_agent" };
  rememberInbound(msg);
  await handleInbound(msg);
  return replies.slice(before).join("\n");
}

beforeEach(() => {
  seedDemo();
  clearPendingChoices();
  clearLiveDeals();
  config.serpapiKey = "test-key";
  replies = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(RESULTS[new URL(url).searchParams.get("q")!] ?? {}))));
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

describe("a new request while a 'Which one?' is waiting", () => {
  it("always gets a reply, and the queued item is asked about next", async () => {
    expect(await dm("We're out of toilet paper")).toMatch(/Which one\?\n1\. Scott ComfortPlus/);

    const second = await dm("We're out of dish soap");
    expect(second).toMatch(/Got it, I'll ask about dish soap next\. First, the toilet paper:\nWhich one\?\n1\. Scott ComfortPlus/);

    const again = await dm("We're out of toilet paper");
    expect(again).toMatch(/That's already waiting for your pick: toilet paper\.\nWhich one\?/);

    const picked = await dm("1");
    expect(picked).toMatch(/Added Scott ComfortPlus/);
    expect(picked).toMatch(/Which one\?\n1\. Palmolive Dish Soap/); // dish soap is next, asked once
    await dm("2");
    expect(pendingItems("demo-house").filter((i) => /Scott|Dawn/.test(i.name)).map((i) => i.name)).toHaveLength(2);
    expect(await dm("1")).not.toMatch(/Which one\?/); // nothing else was queued
  });

  it("queueChoices never returns nothing for a non-empty request", () => {
    const opt = { id: "x", name: "X", aliases: [], category: "other", cents: 100, defaultShared: true, restockDays: null };
    expect(queueChoices("h", "m", [{ options: [opt], shared: null, item: "x", group: "x" }])).toMatch(/Which one\?/);
    expect(queueChoices("h", "m", [{ options: [opt], shared: null, item: "y", group: "y" }])).toMatch(/I'll ask about y next/);
  });
});
