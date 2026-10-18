// Ranking and filtering the "Which one?" options, in code (never the LLM).
// Works the same for catalog products and live store results: price per unit, filters, best value.
import type { Product } from "../core/catalog.js";

export type DealSort = "best_value" | "cheapest";

/** Knobs for one "Which one?" question. Every field is optional; defaults keep today's behavior. */
export type DealOptions = {
  /** How many options to show, 1–3 (default 3). We never show more than 3. */
  count?: number;
  /** Per-item price cap in cents ("TP under $15"). */
  maxPriceCents?: number;
  /** Smallest pack size in the product's unit ("at least 24 rolls"). */
  minUnits?: number;
  /** Only these sellers ("from Costco"). Catalog products have no seller, so this only keeps live results. */
  stores?: string[];
  /** best_value (default): lowest price per unit first. cheapest: lowest sticker price first. */
  sort?: DealSort;
  /** Label options that would take the household over its monthly budget (default true). */
  respectBudget?: boolean;
  /** How old a cached live price may be before we search again (default 12 hours). */
  maxAgeHours?: number;
  /** A brand or variant the member named ("Dawn"), checked by searchSpecFor. Store listings must include it. */
  brand?: string;
  /** A size the member named ("56 oz"), checked against how the product is sold. Searched instead of the catalog's. */
  size?: string;
};

export const MAX_OPTIONS = 3;

export function optionCount(count: number | undefined): number {
  if (count === undefined || !Number.isInteger(count)) return MAX_OPTIONS;
  return Math.min(MAX_OPTIONS, Math.max(1, count));
}

/** Integer cross-multiplication, so no rounding ever decides an order. Both must have `units`. */
const perUnit = (a: Product, b: Product) => a.cents * b.units! - b.cents * a.units!;

/**
 * Rank options. best_value: products with a known pack size, cheapest per unit first, then the rest in their
 * original order (or by price, with `restByPrice`, for store listings). cheapest: lowest price first.
 * All sorts are stable, so ties keep the incoming order.
 */
export function rankOptions(products: Product[], sort: DealSort = "best_value", { restByPrice = false } = {}): Product[] {
  const byPrice = (a: Product, b: Product) => a.cents - b.cents;
  if (sort === "cheapest") return [...products].sort(byPrice);
  const unit = products.find((p) => p.units && p.unit)?.unit;
  const known = products.filter((p) => p.units && p.unit === unit);
  const rest = products.filter((p) => !known.includes(p));
  return [...known.sort(perUnit), ...(restByPrice ? rest.sort(byPrice) : rest)];
}

/** The option to label "best value": cheapest per unit, only if it strictly beats every other comparable option. */
export function bestValueId(options: Product[]): string | undefined {
  const unit = options.find((p) => p.units && p.unit)?.unit;
  const known = options.filter((p) => p.units && p.unit === unit);
  if (known.length < 2) return undefined;
  const [best, next] = [...known].sort(perUnit);
  return best && next && perUnit(best, next) < 0 ? best.id : undefined;
}

export function hasFilters(opts: DealOptions): boolean {
  return opts.maxPriceCents !== undefined || opts.minUnits !== undefined || !!opts.stores?.length;
}

export function applyFilters(products: Product[], opts: DealOptions): Product[] {
  const stores = opts.stores?.map((s) => s.toLowerCase());
  return products.filter(
    (p) =>
      (opts.maxPriceCents === undefined || p.cents <= opts.maxPriceCents) &&
      (opts.minUnits === undefined || (p.units ?? 0) >= opts.minUnits) &&
      (!stores?.length || (!!p.store && stores.includes(p.store.toLowerCase()))),
  );
}

/** "under $15", "from Costco", "at least 24": what the member asked for, for "nothing matched" replies. */
export function describeFilters(opts: DealOptions): string {
  const parts: string[] = [];
  if (opts.maxPriceCents !== undefined) parts.push(`under $${(opts.maxPriceCents / 100).toFixed(2)}`);
  if (opts.minUnits !== undefined) parts.push(`with at least ${opts.minUnits}`);
  if (opts.stores?.length) parts.push(`from ${opts.stores.join(" or ")}`);
  return parts.join(", ");
}

// Words a store title might use for each catalog unit. Count-style units also accept "40 count" / "40 ct".
const UNIT_WORDS: Record<string, string> = {
  roll: "rolls?",
  load: "loads?",
  pod: "pods?|pacs?|tabs?|tablets?",
  bag: "bags?",
  sponge: "sponges?",
  egg: "eggs?",
  carton: "cartons?",
  bottle: "bottles?",
};
const PACK_UNITS = new Set(["carton", "bottle"]);
// Rolls sold as "double", "mega", "jumbo"... are bigger than a regular roll by an amount we can't know, so a
// per-roll price would compare unlike things.
const ROLL_SIZE = /\b(?:double|triple|quad(?:ruple)?|mega|jumbo|huge|giant|family|super|xl|big)\b/;
// A bottle or carton that states its own volume ("40 fl oz") may be a different size from the catalog's.
const VOLUME = /(?<![\w.])\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|oz|ounces?|ml|l|liters?|litres?|gal(?:lons?)?|qt|quarts?)\b/;
const MEASURE = /\b(?:gal|gallons?|qt|quarts?|ply|inch|in|oz|ounces?|lbs?|pounds?|liters?|l|ml|mil|sheets?|ft|feet)\b/;

/**
 * Pack size from a store title in the catalog product's unit ("Charmin, 24 Mega Rolls" -> 24 for "roll").
 * Undefined when the title doesn't say; we never guess. Such options are shown but can't be "best value".
 * A number glued to letters or a decimal point doesn't count: "38C405" is a model number, not 405 rolls.
 * Rolls of a non-standard size ("8 Triple Rolls") and bottles or cartons with a stated volume are left undefined:
 * their per-unit price wouldn't be comparable with the catalog's.
 */
export function parseUnits(title: string, unit: string | undefined): number | undefined {
  if (!unit) return undefined;
  const t = title.toLowerCase().replace(/,/g, " ");
  const ok = (n: number) => (Number.isFinite(n) && n > 0 && n <= 1000 ? n : undefined);
  if (unit === "roll" && ROLL_SIZE.test(t)) return undefined;
  if (PACK_UNITS.has(unit) && VOLUME.test(t)) return undefined;
  if (unit === "oz") {
    const oz = /(?<![\w.])(\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?(?:oz|ounces?)\b/.exec(t);
    if (oz) return ok(Number(oz[1]));
    const lb = /(?<![\w.])(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/.exec(t);
    return lb ? ok(Number(lb[1]) * 16) : undefined;
  }
  if (unit === "egg") {
    const dozen = /(?:(?<![\w.])(\d+)\s*)?\bdozen\b/.exec(t);
    if (dozen) return ok((dozen[1] ? Number(dozen[1]) : 1) * 12);
  }
  const count = /(?<![\w.])(\d+)\s*(?:-\s*)?(?:count|ct)\b/.exec(t);
  if (count) return ok(Number(count[1]));
  const words = UNIT_WORDS[unit];
  if (words) {
    // "24 Mega Rolls", "6 Double Rolls": up to two words between the number and the unit. A measurement word
    // in between means the number isn't a count ("13 gallon trash bags", "2-ply mega rolls").
    for (const m of t.matchAll(new RegExp(`(?<![\\w.])(\\d+)\\s*(?:-\\s*)?((?:[a-z]+\\s+){0,2})(?:${words})\\b`, "g"))) {
      if (!MEASURE.test(m[2] ?? "")) return ok(Number(m[1]));
    }
  }
  if (PACK_UNITS.has(unit)) {
    const pack = /(?<![\w.])(\d+)\s*(?:-\s*)?(?:pack|pk)\b/.exec(t);
    if (pack) return ok(Number(pack[1]));
  }
  return undefined;
}
