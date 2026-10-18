// A brand or size the member names goes into the store search, but only after it's checked: code finds the
// words and checks sizes, the AI judges whether a brand makes sense, and code re-checks what the AI returned.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({ brand: null as string | null, calls: 0, fail: false }));
vi.mock("../src/ai/client.js", () => ({
  MODEL: "test",
  anthropic: {
    messages: {
      parse: vi.fn(async (req: { system: string }) => {
        if (!req.system.startsWith("A household member asked")) return { stop_reason: "end_turn", parsed_output: null }; // other AI calls: use fallbacks
        ai.calls++;
        if (ai.fail) throw new Error("overloaded");
        return { stop_reason: "end_turn", parsed_output: { brand: ai.brand } };
      }),
    },
  },
}));

import { seedDemo } from "../scripts/seed.js";
import { config } from "../src/config.js";
import { getProduct } from "../src/core/catalog.js";
import { clearLiveDeals, liveOptionsFor, specQuery } from "../src/deals/live.js";
import { leftoverWords, searchSpecFor, sizeFits } from "../src/ai/searchSpec.js";
import { handleInbound } from "../src/messaging/inbound.js";
import { buildDealChoice, clearPendingChoices } from "../src/messaging/options.js";
import { rememberInbound, type InboundMessage } from "../src/messaging/photon.js";

const TP = () => getProduct("tp-12")!;
const DISH = () => getProduct("dish-3")!;
const row = (title: string, source: string, price: number) => ({ title, source, extracted_price: price });
const DISH_RESULTS = {
  shopping_results: [
    row("Dawn Ultra Dish Soap, 3 Pack", "Walmart", 9.97),
    row("Palmolive Ultra Dish Soap, 3 Pack", "Target", 8.49),
    row("Dawn Platinum Dish Soap Refill, 3 Pack", "Target", 13.99),
  ],
};
let fetchMock: ReturnType<typeof vi.fn>;
let logs: string[] = [];
let n = 0;

beforeEach(() => {
  seedDemo();
  clearPendingChoices();
  clearLiveDeals();
  config.serpapiKey = "test-key";
  ai.brand = null;
  ai.calls = 0;
  ai.fail = false;
  logs = [];
  fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(DISH_RESULTS), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => {
  config.serpapiKey = undefined;
  vi.unstubAllGlobals();
});

const searched = () => fetchMock.mock.calls.map(([url]) => new URL(url as string).searchParams.get("q"));

describe("finding the extra words", () => {
  it("keeps the brand and size, drops the product's own words and filler", () => {
    expect(leftoverWords("we need more Dawn dish soap please", DISH())).toEqual({ rest: ["dawn"] });
    expect(leftoverWords("Charmin toilet paper 24 rolls", TP())).toEqual({ rest: ["charmin"], size: { text: "24 rolls", unit: "rolls" } });
    expect(leftoverWords("dish soap", DISH())).toEqual({ rest: [] });
  });

  it("only accepts sizes that fit how the product is sold", () => {
    expect(sizeFits("rolls", TP())).toBe(true);
    expect(sizeFits("pack", TP())).toBe(true);
    expect(sizeFits("oz", TP())).toBe(false); // toilet paper is sold by the roll
    expect(sizeFits("fl oz", DISH())).toBe(true); // dish soap bottles have a volume
    expect(sizeFits("rolls", DISH())).toBe(false);
  });
});

describe("searchSpecFor", () => {
  it("uses a brand the AI confirms, copied from the member's words", async () => {
    ai.brand = "Dawn";
    expect(await searchSpecFor("Dawn dish soap", DISH(), "add Dawn dish soap")).toEqual({ brand: "Dawn" });
  });

  it("rejects a brand the member never said, even if the AI returns one", async () => {
    ai.brand = "Palmolive";
    expect(await searchSpecFor("Dawn dish soap", DISH(), "add Dawn dish soap")).toEqual({});
    ai.brand = "Dawn";
    // The parsed item name had a brand the member didn't type (the AI must not add words).
    expect(await searchSpecFor("Dawn dish soap", DISH(), "add dish soap")).toEqual({});
  });

  it("drops words the AI says don't describe the product", async () => {
    ai.brand = null;
    expect(await searchSpecFor("asdfgh dish soap", DISH(), "add asdfgh dish soap")).toEqual({});
  });

  it("keeps a checked size without asking the AI, and flags a size that doesn't fit", async () => {
    expect(await searchSpecFor("toilet paper 24 rolls", TP(), "add toilet paper 24 rolls")).toEqual({ size: "24 rolls" });
    expect(await searchSpecFor("12 oz toilet paper", TP(), "add 12 oz toilet paper")).toEqual({ droppedSize: "12 oz" });
    expect(ai.calls).toBe(0);
  });

  it("searches without a brand if the AI check fails", async () => {
    ai.fail = true;
    expect(await searchSpecFor("Dawn dish soap 56 oz", DISH(), "add Dawn dish soap 56 oz")).toEqual({ size: "56 oz" });
  });
});

describe("the store search", () => {
  it("puts the brand and size in the query", () => {
    expect(specQuery(DISH(), "Dawn")).toBe("Dawn Dish soap 3 pack");
    expect(specQuery(DISH(), "Dawn", "56 oz")).toBe("Dawn Dish soap 56 oz");
    expect(specQuery(TP(), undefined, "24 rolls")).toBe("Toilet paper 24 rolls");
    expect(specQuery(TP())).toBe("Toilet paper 12 rolls");
  });

  it("only shows listings from the brand, and logs the search by a hash, not the member's words", async () => {
    const live = await liveOptionsFor(DISH(), { brand: "Dawn" });
    expect(live?.products.map((p) => p.name)).toEqual([
      "Dawn Ultra Dish Soap, 3 Pack (Walmart)",
      "Dawn Platinum Dish Soap Refill, 3 Pack (Target)",
    ]);
    expect(searched()).toEqual(["Dawn Dish soap 3 pack"]);
    expect(logs.join("\n")).not.toMatch(/Dawn/);
  });

  it("with no listings from that brand, shows the product's other listings and says so", async () => {
    const choice = await buildDealChoice("demo-house", DISH(), null, { brand: "Method" });
    expect(choice.note).toBe("I couldn't find Method listings right now, so here are other options.");
    expect(choice.options.length).toBeGreaterThan(1);
  });
});

describe("in the chat", () => {
  async function say(body: string) {
    const msg: InboundMessage = { messageId: `ss${++n}`, spaceId: "pho_spc_group", spaceKind: "group", fromPhone: "+15550000001", text: body, agentUserId: "pho_usr_agent" };
    rememberInbound(msg);
    await handleInbound(msg);
  }

  it("'add Dawn dish soap' searches for Dawn", async () => {
    ai.brand = "Dawn";
    await say("add Dawn dish soap");
    expect(searched()).toEqual(["Dawn Dish soap 3 pack"]);
    expect(logs.join("\n")).toMatch(/1\. Dawn Ultra Dish Soap, 3 Pack \(Walmart\)/);
  });

  it("'add 12 oz toilet paper' explains the size doesn't fit and searches without it", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ shopping_results: [row("Charmin Toilet Paper, 12 Rolls", "Target", 11.99), row("Cottonelle Toilet Paper 12 Rolls", "Walmart", 10.49)] })),
    );
    await say("add 12 oz toilet paper");
    expect(logs.join("\n")).toMatch(/"12 oz" doesn't fit toilet paper \(it's sold by the roll\), so I searched without it\./);
    expect(searched()).toEqual(["Toilet paper 12 rolls"]);
  });
});
