// Owner: Person 1. Match what someone typed ("tp", "the good coffee") to a catalog product.
// The AI only picks an ID from our catalog; price and name always come from the catalog, never the model.
import { z } from "zod";
import { catalog, getProduct, keywordMatch, type Product } from "../core/catalog.js";
import { checkInput } from "../safety/guardrails.js";
import { wrapUntrusted } from "./prompt.js";
import { gemini } from "./client.js";
import { aiErrorSummary } from "./errors.js";

const MatchSchema = z.object({
  productId: z.string().nullable().describe("ID from the catalog, or null if nothing fits"),
  confidence: z.enum(["high", "medium", "low"]),
});

export type ItemMatch = { product: Product; source: "ai" | "keyword" } | undefined;

const CATALOG_LINES = catalog.map((p) => `${p.id}: ${p.name} (${p.category}; also called ${p.aliases.join(", ")})`).join("\n");

const SYSTEM = `You match household shopping requests to products in a fixed catalog.
Return the single best productId from the catalog, or null if nothing reasonably fits.
Never invent IDs. Prefer null over a poor match.

Catalog:
${CATALOG_LINES}`;

export async function matchItem(requested: string): Promise<ItemMatch> {
  if (checkInput(requested)) return undefined;
  const fallback = () => {
    const p = keywordMatch(requested);
    return p ? { product: p, source: "keyword" as const } : undefined;
  };
  if (!gemini) return fallback();

  try {
    const response = await gemini.generate({
      system: SYSTEM,
      user: wrapUntrusted("member", requested),
      schema: MatchSchema,
      maxOutputTokens: 1024,
    });
    const parsed = MatchSchema.safeParse(response.output);
    const out = parsed.success ? parsed.data : undefined;
    if (!response.finished || !out) return fallback();

    // Validate: the ID must exist in our catalog, and low-confidence matches are not trusted.
    const product = out.productId ? getProduct(out.productId) : undefined;
    if (!product || out.confidence === "low") return fallback();
    return { product, source: "ai" };
  } catch (err) {
    console.warn(`AI match failed: ${aiErrorSummary(err)}. Using keyword match.`);
    return fallback();
  }
}
