// The AI layer must keep working without an API key (AGENTS.md): these exercise the deterministic fallbacks.
import { describe, expect, it } from "vitest";
import { keywordMatch } from "../src/core/catalog.js";
import { matchItem } from "../src/ai/matchItem.js";
import { dueByInterval } from "../src/ai/suggestRestock.js";

describe("catalog keyword match", () => {
  it("matches aliases and names", () => {
    expect(keywordMatch("tp")?.id).toBe("tp-12");
    expect(keywordMatch("hand soap")?.id).toBe("hand-soap");
    expect(keywordMatch("we need garbage bags")?.id).toBe("trash-bags");
  });

  it("returns undefined for unknown items", () => {
    expect(keywordMatch("unicorn")).toBeUndefined();
  });
});

describe("matchItem without an API key", () => {
  it("falls back to keyword matching with catalog prices", async () => {
    const m = await matchItem("dish soap");
    expect(m).toMatchObject({ source: "keyword", product: { id: "dish-3", cents: 849 } });
  });
});

describe("dueByInterval", () => {
  const now = new Date("2026-10-17T12:00:00Z");

  it("suggests items past their restock interval and skips the cart", () => {
    const history = [
      { productId: "tp-12", orderedAt: "2026-09-30T12:00:00Z" }, // 17 days, interval 14 -> due
      { productId: "pt-6", orderedAt: "2026-09-30T12:00:00Z" }, // due, but in cart
      { productId: "laundry", orderedAt: "2026-10-10T12:00:00Z" }, // 7 days, interval 30 -> not due
    ];
    const s = dueByInterval(history, new Set(["pt-6"]), now);
    expect(s.map((x) => x.product.id)).toEqual(["tp-12"]);
  });
});
