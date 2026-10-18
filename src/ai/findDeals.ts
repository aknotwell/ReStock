// Owner: Person 1. "We're out of TP" -> the best store listings for it, chosen by Claude.
// Claude writes the store search and reads the listings, but it only ever returns listing numbers. Every name,
// price, store and link shown in the chat comes from SerpApi's data through code. Any problem returns undefined,
// and the caller falls back to the word filters in src/deals/live.ts.
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { liveDealsEnabled, searchOffers, searchTermsFor, storeOffers, type Offer } from "../deals/live.js";
import { anthropic, MODEL } from "./client.js";
import { aiErrorSummary } from "./errors.js";
import { DEALS_PROMPT, wrapListings, wrapUntrusted } from "./prompt.js";

const MAX_TURNS = 4;
const MAX_SEARCHES = 2;
const MAX_SHOWN = 25;
const MAX_PICKS = 5;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_store",
    description: "Search US store listings (Google Shopping) for a product. Returns numbered listings with title, store and price.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "A short product search, e.g. \"Charmin toilet paper 12 rolls\"" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "choose_listings",
    description: "Finish: the listing numbers that are the best deals for what the member asked for, best first. Empty if none fit.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { listing_numbers: { type: "array", items: { type: "integer" } } },
      required: ["listing_numbers"],
      additionalProperties: false,
    },
  },
];

const SearchInput = z.object({ query: z.string().min(1).max(200) });
const ChooseInput = z.object({ listing_numbers: z.array(z.number().int()).max(20) });

/** A listing Claude chose, and when its search ran. The caller turns it into an option with listingProduct. */
export type DealPick = { offer: Offer; at: number };

/**
 * The best store listings for `request`, best first. Undefined when Claude or store prices are off, the call
 * fails, or Claude doesn't finish properly: the caller then uses the word filters. An empty list means Claude
 * searched and found nothing that fits.
 */
export async function findDeals(request: string): Promise<DealPick[] | undefined> {
  if (!anthropic || !liveDealsEnabled()) return undefined;
  const seen = new Map<number, DealPick>();
  let searches = 0;

  const search = async (query: string): Promise<string> => {
    if (searches >= MAX_SEARCHES) return "No more searches allowed. Call choose_listings now.";
    searches++;
    const terms = searchTermsFor(query);
    if (!terms) return "That search can't be run. Try a plain product name.";
    // The search may carry the member's words, so it's logged and cached by a hash only.
    const logAs = `ai-${createHash("sha256").update(terms.toLowerCase()).digest("hex").slice(0, 12)}`;
    const result = await searchOffers(terms, { logAs });
    const offers = result ? storeOffers(result.offers).slice(0, MAX_SHOWN) : [];
    if (!result || !offers.length) return "No listings found.";
    const lines = offers.map((offer) => {
      const n = seen.size + 1;
      seen.set(n, { offer, at: result.at });
      return `[${n}] ${offer.title} | ${offer.store} | $${(offer.cents / 100).toFixed(2)}`;
    });
    return wrapListings(lines);
  };

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: wrapUntrusted("member", request) }];
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 4096,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: DEALS_PROMPT,
        tools: TOOLS,
        tool_choice: { type: "auto" },
        output_config: { effort: "low" },
        messages,
      });
      if (response.stop_reason !== "tool_use") return undefined; // refusal, cut off, or ended without choosing

      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const choose = calls.find((c) => c.name === "choose_listings");
      if (choose) {
        const parsed = ChooseInput.safeParse(choose.input);
        if (!parsed.success) return undefined;
        // Only numbers we showed count; each listing once; at most five.
        const picks = [...new Set(parsed.data.listing_numbers)].flatMap((n) => {
          const s = seen.get(n);
          return s ? [s] : [];
        });
        return picks.slice(0, MAX_PICKS);
      }

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        const input = SearchInput.safeParse(call.input);
        const content = call.name === "search_store" && input.success ? await search(input.data.query) : "Unknown tool or bad input.";
        results.push({ type: "tool_result", tool_use_id: call.id, content });
      }
      messages.push({ role: "user", content: results });
    }
    return undefined;
  } catch (err) {
    // The log says why, never what was asked (AGENTS.md: no message bodies in logs).
    console.warn(`AI deal search failed: ${aiErrorSummary(err)}. Using the word filters.`);
    return undefined;
  }
}
