// Owner: Person 1. Live store prices for the "Which one?" options, from SerpApi's Google Shopping engine.
//
// Store results are untrusted web data. We validate them with a schema, drop anything the guardrails object
// to, and use only a short title, the seller, and the price. They are shown to the member and never sent to
// the model. One search returns many results, so three options cost one search. Results are cached (and
// saved with the store) so repeat requests and restarts don't spend the free quota, and a daily cap keeps a
// runaway loop from spending it all. Any failure falls back to the demo catalog.
import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { getProduct, groupOf, type Product } from "../core/catalog.js";
import { registerState } from "../core/persist.js";
import { checkInput } from "../safety/guardrails.js";
import { parseUnits } from "./rank.js";
import { knownStore } from "./request.js";

/** One store listing, already cleaned. */
export type Offer = { title: string; store: string; cents: number };

const SEARCH_URL = "https://serpapi.com/search.json";
export const SEARCH_TIMEOUT_MS = 3000;
export const DEFAULT_MAX_AGE_HOURS = 12;
const MAX_OFFERS = 40;

type Cached = { at: number; offers: Offer[] };
const cache = new Map<string, Cached>();
let usage = { day: "", count: 0 };

registerState("live-deals", {
  dump: () => ({ cache: [...cache], usage }),
  load: (data) => {
    const d = data as { cache: [string, Cached][]; usage: typeof usage };
    cache.clear();
    for (const [k, v] of d.cache) cache.set(k, v);
    usage = d.usage;
  },
});

export function liveDealsEnabled(): boolean {
  return !!config.serpapiKey;
}

const Row = z.object({
  title: z.string().min(1).max(500),
  source: z.string().min(1).max(100),
  extracted_price: z.number().positive(),
});
const Top = z.object({ shopping_results: z.array(z.unknown()).optional() });

/** One line of printable text, or undefined if it's empty or trips a guardrail. */
function clean(text: string, max: number): string | undefined {
  const t = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || checkInput(t)) return undefined;
  return t.length > max ? t.slice(0, max).trimEnd() : t;
}

/** SerpApi JSON -> cleaned offers. Malformed rows are skipped, never trusted. Exported for tests. */
export function parseOffers(json: unknown): Offer[] {
  const top = Top.safeParse(json);
  if (!top.success) return [];
  const seen = new Set<string>();
  const offers: Offer[] = [];
  for (const raw of top.data.shopping_results ?? []) {
    const row = Row.safeParse(raw);
    if (!row.success) continue;
    const cents = Math.round(row.data.extracted_price * 100);
    const title = clean(row.data.title, 120);
    const store = clean(row.data.source, 40);
    if (!title || !store || !Number.isSafeInteger(cents) || cents < 50 || cents > 100_000) continue;
    const key = `${store}|${title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push({ title, store, cents });
    if (offers.length >= MAX_OFFERS) break;
  }
  return offers;
}

/**
 * Store offers for a search, from the cache when fresh enough. Returns a stale cached result (with its age)
 * rather than nothing when the search fails or today's cap is used up, and undefined when there's neither.
 */
export async function searchOffers(
  query: string,
  { now = Date.now(), maxAgeHours = DEFAULT_MAX_AGE_HOURS }: { now?: number; maxAgeHours?: number } = {},
): Promise<Cached | undefined> {
  const key = config.serpapiKey;
  if (!key) return undefined;
  const cacheKey = `${query.toLowerCase()}|${config.dealsLocation ?? ""}`;
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at <= maxAgeHours * 3_600_000) return hit;

  const day = new Date(now).toISOString().slice(0, 10);
  if (usage.day !== day) usage = { day, count: 0 };
  if (usage.count >= config.dealsDailyLimit) return hit;
  usage.count++;

  const params = new URLSearchParams({ engine: "google_shopping", q: query, gl: "us", hl: "en", api_key: key });
  if (config.dealsLocation) params.set("location", config.dealsLocation);
  try {
    const res = await fetch(`${SEARCH_URL}?${params}`, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const fresh = { at: now, offers: parseOffers(await res.json()) };
    cache.set(cacheKey, fresh);
    return fresh;
  } catch (err) {
    // Never log the request URL: it carries the API key.
    console.warn(`Live price search failed (${err instanceof Error ? err.name : "error"}); using the catalog.`);
    return hit;
  }
}

/**
 * What we search for: the product's name with its pack size ("Toilet paper, 12 rolls" -> "Toilet paper 12 rolls").
 * The size steers results toward comparable packs and toward major retailers rather than single-roll sellers.
 */
export function searchQuery(product: Product): string {
  return product.name.replace(/\(.*?\)/g, " ").replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

const ACCESSORY = /\b(?:holders?|dispensers?|stands?|organizers?|storage|covers?|mounts?|caddy|rack)\b/i;

/**
 * A listing only counts if its title shares a word with the product ("toilet", "paper"), isn't an accessory
 * (a toilet paper holder), and is priced like the product: between a quarter and three times the catalog price,
 * which drops single rolls and commercial cases.
 */
function relevant(offer: Offer, product: Product): boolean {
  const title = offer.title.toLowerCase();
  const words = [product.name.split(",")[0]!, ...product.aliases]
    .flatMap((n) => n.toLowerCase().split(/[^a-z]+/))
    .filter((w) => w.length >= 4);
  const base = getProduct(groupOf(product))?.cents ?? product.cents;
  return words.some((w) => title.includes(w)) && !ACCESSORY.test(title) && offer.cents >= base / 4 && offer.cents <= base * 3;
}

/** Live store listings for a catalog product, as options the member can pick. Undefined when unavailable. */
export async function liveOptionsFor(
  product: Product,
  opts: { now?: number; maxAgeHours?: number } = {},
): Promise<{ products: Product[]; checkedAt: number } | undefined> {
  const result = await searchOffers(searchQuery(product), opts);
  if (!result) return undefined;
  // By default only major retailers we recognize, under their usual names. DEALS_ANY_STORE=1 keeps every seller.
  const products = result.offers
    .filter((o) => relevant(o, product))
    .flatMap((o) => {
      const store = config.dealsAnyStore ? o.store : knownStore(o.store);
      return store ? [{ ...o, store }] : [];
    })
    .map((o): Product => {
      const units = parseUnits(o.title, product.unit);
      return {
        id: `live-${createHash("sha256").update(`${o.store}|${o.title}`).digest("hex").slice(0, 12)}`,
        name: `${o.title.length > 60 ? `${o.title.slice(0, 59).trimEnd()}…` : o.title} (${o.store})`,
        aliases: [],
        category: product.category,
        cents: o.cents,
        defaultShared: product.defaultShared,
        restockDays: product.restockDays,
        group: groupOf(product),
        ...(units ? { units, unit: product.unit } : {}),
        store: o.store,
        checkedAt: new Date(result.at).toISOString(),
      };
    });
  return { products, checkedAt: result.at };
}

// Store listings someone picked, by cart item name, so "the usual" can find a store purchase again.
const picked = new Map<string, Product>();
registerState("live-picked", {
  dump: () => [...picked],
  load: (data) => {
    picked.clear();
    for (const [k, v] of data as [string, Product][]) picked.set(k, v);
  },
});

export function rememberPicked(product: Product): void {
  if (product.store) picked.set(product.name, product);
}

/** A store listing someone picked before, by its cart item name. */
export function pickedByName(name: string): Product | undefined {
  return picked.get(name);
}

/** The same store listing (same seller and title) in today's search, with today's price. */
export async function currentListing(listing: Product, searchFor: Product): Promise<Product | undefined> {
  const live = await liveOptionsFor(searchFor);
  return live?.products.find((p) => p.id === listing.id);
}

/** Tests only. */
export function clearLiveDeals(): void {
  cache.clear();
  picked.clear();
  usage = { day: "", count: 0 };
}
