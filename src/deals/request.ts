// Deal preferences typed in chat ("cheapest TP under $15 from Costco"), read by code.
// Plain patterns, never the LLM, so a price cap or store filter is exactly what the member typed.
import type { DealOptions } from "./rank.js";

/** Sellers we recognize in "from <store>" / "at <store>". Unknown names are ignored, never passed through. */
export const KNOWN_STORES = [
  "Target", "Walmart", "Costco", "Amazon", "Kroger", "Safeway", "Whole Foods", "Trader Joe's", "CVS",
  "Walgreens", "Sam's Club", "Fred Meyer", "QFC", "Albertsons", "Publix", "Aldi", "Meijer", "H-E-B", "Home Depot",
  "Lowe's", "Dollar General", "Wegmans",
];

const storeKey = (name: string) =>
  name.toLowerCase().replace(/^the\s+/, "").replace(/\.com$/, "").replace(/\s+(?:pharmacy|market|supermarkets?|stores?|inc\.?)$/, "").trim();
const STORE_KEYS = new Map(KNOWN_STORES.map((s) => [storeKey(s), s]));

/**
 * A seller's usual name if it's a store we recognize ("Amazon.com" -> "Amazon", "CVS Pharmacy" -> "CVS"),
 * else undefined. Marketplace resellers ("Walmart - One Click Away") are not the store itself, so they don't count.
 */
export function knownStore(seller: string): string | undefined {
  if (/\s[-–|]\s/.test(seller)) return undefined;
  return STORE_KEYS.get(storeKey(seller));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3 };

const PRICE = /\b(?:under|below|less than|at most|no more than|max(?:imum)?(?: of)?)\s*\$\s*(\d{1,4}(?:\.\d{1,2})?)\b/i;
const PRICE_ALT = /\$\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:or less|max)\b/i;
const MIN_UNITS = /\bat least\s+(\d{1,4})\b(?:\s+[a-z]+)?/i;
const MIN_UNITS_PLUS = /\b(\d{1,4})\+(?:\s+[a-z]+)?/i;
const COUNT = /\b(?:(?:top|show(?: me)?|just|only)\s+(one|two|three|[1-3])(?:\s+(?:options?|choices?))?|(one|two|three|[1-3])\s+(?:options?|choices?))\b/i;
const CHEAPEST = /\b(?:cheapest|lowest price|least expensive)\b/i;
const BEST_VALUE = /\b(?:best (?:value|deal|price)|better deal|good deal)\b/i;
const STORE = new RegExp(`\\b(?:from|at|on|only)\\s+(${KNOWN_STORES.map(escape).join("|")})(?![\\w'])`, "gi");

/** Deal options found in a message. Anything not mentioned is left undefined (defaults apply). */
export function parseDealRequest(text: string): DealOptions {
  const opts: DealOptions = {};
  const price = PRICE.exec(text) ?? PRICE_ALT.exec(text);
  if (price?.[1]) opts.maxPriceCents = Math.round(Number(price[1]) * 100);
  const min = MIN_UNITS.exec(text) ?? MIN_UNITS_PLUS.exec(text);
  if (min?.[1]) opts.minUnits = Number(min[1]);
  const count = COUNT.exec(text);
  const n = count?.[1] ?? count?.[2];
  if (n) opts.count = NUMBER_WORDS[n.toLowerCase()] ?? Number(n);
  if (CHEAPEST.test(text)) opts.sort = "cheapest";
  else if (BEST_VALUE.test(text)) opts.sort = "best_value";
  const stores = [...text.matchAll(STORE)].map((m) => KNOWN_STORES.find((s) => s.toLowerCase() === m[1]!.toLowerCase())!);
  if (stores.length) opts.stores = [...new Set(stores)];
  return opts;
}

/** The item name without deal words, so "TP under $15 from Costco" still matches toilet paper. */
export function stripDealWords(itemName: string): string {
  const out = [PRICE, PRICE_ALT, MIN_UNITS, MIN_UNITS_PLUS, COUNT, CHEAPEST, BEST_VALUE, STORE]
    .reduce((s, re) => s.replace(new RegExp(re.source, "gi"), " "), itemName)
    .replace(/\b(?:the|a|some)\s*$/i, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.!-]+|[\s,;:.!-]+$/g, "");
  return out || itemName;
}
