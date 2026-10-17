// Owner: Person 1. Proactive restock suggestions from the household's order history.
// Suggestions are only ever *offered* in chat ("Add them?"). Nothing is added or charged without a reply.
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { catalog, getProduct, type Product } from "../core/catalog.js";
import { anthropic, MODEL } from "./client.js";

export type PurchaseRecord = { productId: string; orderedAt: string };

export type RestockSuggestion = { product: Product; reason: string };

const SuggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      productId: z.string(),
      reason: z.string().describe("One short, friendly sentence, e.g. 'Last ordered 15 days ago; you usually reorder every 2 weeks.'"),
    }),
  ),
});

const SYSTEM = `You help a household notice supplies they are about to run out of.
Given the catalog (with typical restock intervals in days), the purchase history, the current cart, and today's date,
suggest at most 3 products that are probably due. Only use productIds from the catalog. Skip anything already in the cart.
Base every suggestion on the history; if nothing is clearly due, return an empty list.`;

/** Deterministic fallback: items whose restock interval has passed since the last purchase. */
export function dueByInterval(history: PurchaseRecord[], inCart: Set<string>, now: Date): RestockSuggestion[] {
  const last = new Map<string, number>();
  for (const h of history) last.set(h.productId, Math.max(last.get(h.productId) ?? 0, Date.parse(h.orderedAt)));

  const due: RestockSuggestion[] = [];
  for (const [id, ts] of last) {
    const p = getProduct(id);
    if (!p?.restockDays || inCart.has(id)) continue;
    const days = Math.floor((now.getTime() - ts) / 86_400_000);
    if (days >= p.restockDays) due.push({ product: p, reason: `Last ordered ${days} days ago.` });
  }
  return due.slice(0, 3);
}

export async function suggestRestock(
  history: PurchaseRecord[],
  inCart: Set<string>,
  now: Date = new Date(),
): Promise<RestockSuggestion[]> {
  if (!anthropic || history.length === 0) return dueByInterval(history, inCart, now);

  const catalogText = catalog.map((p) => `${p.id}: ${p.name}, restock every ${p.restockDays ?? "n/a"} days`).join("\n");
  const historyText = history.map((h) => `${h.orderedAt.slice(0, 10)} ${h.productId}`).join("\n");

  try {
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Catalog:\n${catalogText}\n\nPurchase history:\n${historyText}\n\nIn cart: ${[...inCart].join(", ") || "nothing"}\nToday: ${now.toISOString().slice(0, 10)}`,
        },
      ],
      output_config: { effort: "low", format: zodOutputFormat(SuggestionSchema) },
    });
    const out = response.parsed_output;
    if (response.stop_reason === "refusal" || !out) return dueByInterval(history, inCart, now);

    // Validate every suggestion against the catalog and the cart; cap at 3.
    return out.suggestions
      .map((s) => ({ product: getProduct(s.productId), reason: s.reason }))
      .filter((s): s is RestockSuggestion => !!s.product && !inCart.has(s.product.id))
      .slice(0, 3);
  } catch (err) {
    console.warn("AI restock suggestion failed, using interval rule:", err instanceof Error ? err.message : err);
    return dueByInterval(history, inCart, now);
  }
}
