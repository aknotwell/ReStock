// Owner: Person 1. Live store prices for the "Which one?" options, from SerpApi's Google Shopping engine.
//
// Store results are untrusted web data. We validate them with a schema, drop anything the guardrails object
// to, and use only a short title, the seller, and the price. They are shown to the member and never sent to
// the model. Store prices are the default whenever SERPAPI_KEY is set, including for items that aren't in the
// demo catalog (offCatalogProduct). One search returns many results, so three options cost one search. Results are cached (and
// saved with the store) so repeat requests and restarts don't spend the free quota, and a daily cap keeps a
// runaway loop from spending it all. Any failure falls back to the demo catalog.
import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { getProduct, groupOf, type Product } from "../core/catalog.js";
import { registerState } from "../core/persist.js";
import { checkInput } from "../safety/guardrails.js";
import { parseUnits } from "./rank.js";
import { shortLink } from "./links.js";
import { knownStore } from "./request.js";

/** One store listing, already cleaned. */
/** One store listing, already cleaned. `link` is its Google Shopping page, rebuilt by productLink. */
export type Offer = { title: string; store: string; cents: number; link?: string };

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

/**
 * One log line per price lookup, so the server logs show what SerpApi did: `[serpapi] "<search>" <outcome> k=v…`.
 * Only the search terms of a catalog product and counts are logged. A search for an item that isn't in the catalog
 * uses the member's own words, so it is logged by a hash ID instead. Never the request URL (it carries the API key),
 * and nothing about the household or its messages.
 */
function logSearch(query: string, outcome: string, details: Record<string, string | number | undefined> = {}, warn = false): void {
  const extra = Object.entries(details)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  (warn ? console.warn : console.log)(`[serpapi] "${query}" ${outcome}${extra ? ` ${extra}` : ""}`);
}

const minutesOld = (at: number, now: number) => `${Math.max(0, Math.round((now - at) / 60_000))}m`;

/** SerpApi reports some problems ("no results", "out of searches") as an `error` field, sometimes with HTTP 200. */
function serpError(json: unknown): string | undefined {
  const e = json && typeof json === "object" ? (json as { error?: unknown }).error : undefined;
  return typeof e === "string" ? e.replace(/[\u0000-\u001f\u007f"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : undefined;
}

let loggedOff = false;

// v4: offers carry their Google Shopping link. Older cached results have none, so they're searched again once.
const cacheKeyFor = (label: string) => `v4|${label.toLowerCase()}|${config.dealsLocation ?? ""}`;
/** Below this many usable listings, a search isn't worth keeping for 12 hours: the next request searches again. */
export const MIN_CACHED_LISTINGS = 2;

export function liveDealsEnabled(): boolean {
  return !!config.serpapiKey;
}

const Row = z.object({
  title: z.string().min(1).max(500),
  source: z.string().min(1).max(100),
  extracted_price: z.number().positive().optional(),
  price: z.string().max(40).optional(),
  product_link: z.string().max(2000).optional(),
});

/**
 * A listing's Google Shopping page, rebuilt from its product id: https, www.google.com, the shopping view, and
 * nothing else from the result (no tracking or redirect parameters). Undefined for anything else. SerpApi's
 * shopping results carry no direct store link; getting one costs another search per listing.
 */
export function productLink(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const prds = url.searchParams.get("prds");
  if (url.protocol !== "https:" || url.hostname !== "www.google.com" || url.pathname !== "/search" || !prds) return undefined;
  if (!/^[\w:,-]{1,200}$/.test(prds)) return undefined;
  const q = (url.searchParams.get("q") ?? "").replace(/[^\p{L}\p{N} '&.-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `https://www.google.com/search?${new URLSearchParams({ ibp: "oshop", q, prds, udm: "28", gl: "us", hl: "en" })}`;
}
const Top = z.object({
  shopping_results: z.array(z.unknown()).optional(),
  inline_shopping_results: z.array(z.unknown()).optional(),
  categorized_shopping_results: z.array(z.unknown()).optional(),
});
const Category = z.object({ shopping_results: z.array(z.unknown()).optional(), results: z.array(z.unknown()).optional() });

/**
 * Every listing row in a response. Google sometimes groups shopping results into categories, and SerpApi then
 * returns them under `categorized_shopping_results` with only a few left in `shopping_results`.
 */
function listingRows(json: unknown): unknown[] {
  const top = Top.safeParse(json);
  if (!top.success) return [];
  const grouped = (top.data.categorized_shopping_results ?? []).flatMap((c) => {
    const cat = Category.safeParse(c);
    return cat.success ? [...(cat.data.shopping_results ?? []), ...(cat.data.results ?? [])] : [];
  });
  return [...(top.data.shopping_results ?? []), ...grouped, ...(top.data.inline_shopping_results ?? [])];
}

/** "$4.97" or "4.97" -> 4.97. Anything else (ranges, "From $5", other currencies) is ignored. */
function priceFromText(text: string | undefined): number | undefined {
  const m = text ? /^\s*\$?\s*(\d{1,4}(?:,\d{3})*(?:\.\d{1,2})?)\s*$/.exec(text) : undefined;
  return m ? Number(m[1]!.replace(/,/g, "")) : undefined;
}

/** One line of printable text, or undefined if it's empty or trips a guardrail. */
function clean(text: string, max: number): string | undefined {
  const t = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || checkInput(t)) return undefined;
  return t.length > max ? t.slice(0, max).trimEnd() : t;
}

/** Why rows were dropped while parsing, for the `[serpapi]` log line. */
export type ParseStats = { rows: number; malformed: number; noPrice: number; blocked: number; outOfRange: number; duplicate: number };

/** SerpApi JSON -> cleaned offers. Malformed rows are skipped, never trusted. Exported for tests. */
export function parseOffers(json: unknown, stats?: ParseStats): Offer[] {
  const rows = listingRows(json);
  const st = stats ?? { rows: 0, malformed: 0, noPrice: 0, blocked: 0, outOfRange: 0, duplicate: 0 };
  st.rows = rows.length;
  const seen = new Set<string>();
  const offers: Offer[] = [];
  for (const raw of rows) {
    const row = Row.safeParse(raw);
    if (!row.success) {
      st.malformed++;
      continue;
    }
    const price = row.data.extracted_price ?? priceFromText(row.data.price);
    if (price === undefined) {
      st.noPrice++;
      continue;
    }
    const cents = Math.round(price * 100);
    const title = clean(row.data.title, 120);
    const store = clean(row.data.source, 40);
    if (!title || !store) {
      st.blocked++;
      continue;
    }
    if (!Number.isSafeInteger(cents) || cents < 50 || cents > 100_000) {
      st.outOfRange++;
      continue;
    }
    const key = `${store}|${title}`.toLowerCase();
    if (seen.has(key)) {
      st.duplicate++;
      continue;
    }
    seen.add(key);
    const link = productLink(row.data.product_link);
    offers.push({ title, store, cents, ...(link ? { link } : {}) });
    if (offers.length >= MAX_OFFERS) break;
  }
  return offers;
}

/**
 * Store offers for a search, from the cache when fresh enough. Returns a stale cached result (with its age)
 * rather than nothing when the search fails or today's cap is used up, and undefined when there's neither.
 */
export async function searchOffers(
  search: string,
  { now = Date.now(), maxAgeHours = DEFAULT_MAX_AGE_HOURS, logAs }: { now?: number; maxAgeHours?: number; logAs?: string } = {},
): Promise<Cached | undefined> {
  // What the log and the cache call this search. `search` is what SerpApi gets. Off-catalog searches pass a
  // hash label, so the member's words are never logged or saved with the cache.
  const query = logAs ?? search;
  const key = config.serpapiKey;
  if (!key) {
    // Once per process: a missing or misspelled variable otherwise fails silently.
    if (!loggedOff) console.log("[serpapi] off: SERPAPI_KEY is not set, so options use catalog prices.");
    loggedOff = true;
    return undefined;
  }
  const cacheKey = cacheKeyFor(query);
  const hit = cache.get(cacheKey);
  const fallback = hit ? `cached (${minutesOld(hit.at, now)} old)` : "catalog";
  if (hit && now - hit.at <= maxAgeHours * 3_600_000) {
    logSearch(query, "cache hit", { age: minutesOld(hit.at, now), offers: hit.offers.length });
    return hit;
  }

  const day = new Date(now).toISOString().slice(0, 10);
  if (usage.day !== day) usage = { day, count: 0 };
  if (usage.count >= config.dealsDailyLimit) {
    logSearch(query, "skipped: daily cap reached", { today: `${usage.count}/${config.dealsDailyLimit}`, fallback }, true);
    return hit;
  }
  usage.count++;
  const today = `${usage.count}/${config.dealsDailyLimit}`;

  const params = new URLSearchParams({ engine: "google_shopping", q: search, gl: "us", hl: "en", api_key: key });
  if (config.dealsLocation) params.set("location", config.dealsLocation);
  const started = Date.now();
  let status: number | undefined;
  try {
    const res = await fetch(`${SEARCH_URL}?${params}`, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    status = res.status;
    const json: unknown = await res.json().catch(() => undefined);
    const message = serpError(json);
    if (!res.ok) throw Object.assign(new Error(`status ${res.status}`), { name: "HttpError", serp: message });
    const stats: ParseStats = { rows: 0, malformed: 0, noPrice: 0, blocked: 0, outOfRange: 0, duplicate: 0 };
    const fresh = { at: now, offers: parseOffers(json, stats) };
    // Rows that didn't become offers, by reason, so a short list can be explained from the logs.
    const skipped = (["malformed", "noPrice", "blocked", "outOfRange", "duplicate"] as const)
      .filter((k) => stats[k] > 0)
      .map((k) => `${k}:${stats[k]}`)
      .join(",");
    logSearch(query, message ? "ok, with SerpApi error" : "ok", {
      status, ms: Date.now() - started, results: stats.rows, offers: fresh.offers.length, today, error: message && `"${message}"`,
      skipped: skipped || undefined,
    }, !!message);
    cache.set(cacheKey, fresh);
    return fresh;
  } catch (err) {
    // Never log the request URL or the raw error text: either can carry the API key.
    const name = err instanceof Error ? err.name : "error";
    const serp = (err as { serp?: string } | undefined)?.serp;
    logSearch(query, "failed", { reason: name, status, ms: Date.now() - started, today, error: serp && `"${serp}"`, fallback }, true);
    console.warn(`Live price search failed (${name}); using the catalog.`);
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
// Janitorial and commercial packs ("Jumbo Tissue, 12 Rolls Per Case", "JRT"), and facial tissue next to bath tissue.
// A bare "jumbo" stays allowed: consumer packs say "6 Jumbo Rolls".
const NOT_HOUSEHOLD = /\b(?:jumbo (?:roll )?(?:bath )?tissue|jumbo[- ]jr|jr\.? jumbo|jrt|per case|case of|commercial|janitorial|industrial|facial)\b/i;
const OFF_CATALOG = "search-";

/**
 * The words we send to the store search for something a member asked for: letters, digits and a few joiners,
 * at most 60 characters. Undefined if nothing usable is left or it trips a guardrail.
 */
export function searchTermsFor(requested: string): string | undefined {
  // Check the raw text too: cleaning would turn "sam@example.com" into words a guardrail no longer sees.
  if (checkInput(requested)) return undefined;
  const t = requested.replace(/[^\p{L}\p{N}\s'&.-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trimEnd();
  if (!/\p{L}/u.test(t) || checkInput(t)) return undefined;
  return t;
}

/**
 * A stand-in for an item that isn't in the demo catalog ("AA batteries"), so its store listings can be searched,
 * ranked and picked like any other. Its id comes from the search words, so "the usual" finds the same group again.
 * It has no price of its own, so listings aren't held to a price band.
 */
export function offCatalogProduct(requested: string): Product | undefined {
  const terms = searchTermsFor(requested);
  if (!terms) return undefined;
  return {
    id: `${OFF_CATALOG}${createHash("sha256").update(terms.toLowerCase()).digest("hex").slice(0, 12)}`,
    name: terms.charAt(0).toUpperCase() + terms.slice(1),
    aliases: [],
    category: "other",
    cents: 0,
    defaultShared: true,
    restockDays: null,
  };
}

/**
 * A listing only counts if its title shares a word with the product ("toilet", "paper"), isn't an accessory
 * (a toilet paper holder) or a commercial or facial-tissue pack unless that is what was asked for, and is priced
 * like the product: between a
 * quarter and three times the catalog price, which drops single rolls and commercial cases. Items that aren't
 * in the catalog have no price to compare, so only the words count.
 */
function relevant(offer: Offer, product: Product): boolean {
  const title = offer.title.toLowerCase();
  const all = [product.name.split(",")[0]!, ...product.aliases].flatMap((n) => n.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  const long = all.filter((w) => w.length >= 4);
  // Short requests ("ice", "AA batteries") still need a word to match.
  const words = long.length ? long : all.filter((w) => w.length >= 2);
  // Accessories and commercial packs are dropped unless that's what was asked for ("jumbo trash bags").
  const asked = [product.name, ...product.aliases].join(" ");
  const accessoryOk = (!ACCESSORY.test(title) || ACCESSORY.test(asked)) && (!NOT_HOUSEHOLD.test(title) || NOT_HOUSEHOLD.test(asked));
  const base = getProduct(groupOf(product))?.cents ?? product.cents;
  const offCatalog = base <= 0;
  const priced = offCatalog || (offer.cents >= base / 4 && offer.cents <= base * 3);
  // Without a price band to catch mismatches, off-catalog listings must share a whole word ("rice" isn't "price").
  const titleWords = new Set(title.split(/[^\p{L}\p{N}]+/u));
  const shares = offCatalog ? words.some((w) => titleWords.has(w)) : words.some((w) => title.includes(w));
  return shares && accessoryOk && priced;
}

/** By default only major retailers we recognize, under their usual names. DEALS_ANY_STORE=1 keeps every seller. */
export function storeOffers(offers: Offer[]): Offer[] {
  return offers.flatMap((o) => {
    const store = config.dealsAnyStore ? o.store : knownStore(o.store);
    return store ? [{ ...o, store }] : [];
  });
}

/**
 * A store listing as an option the member can pick, grouped with `base` (a catalog product or an off-catalog
 * stand-in) so "the usual" can find it again. The link is a short Restock link to the listing's page.
 */
export function listingProduct(o: Offer, base: Product, checkedAt: number): Product {
  const units = parseUnits(o.title, base.unit);
  const url = o.link ? shortLink(o.link) : undefined;
  return {
    id: `live-${createHash("sha256").update(`${o.store}|${o.title}`).digest("hex").slice(0, 12)}`,
    name: `${o.title.length > 60 ? `${o.title.slice(0, 59).trimEnd()}…` : o.title} (${o.store})`,
    aliases: [],
    category: base.category,
    cents: o.cents,
    defaultShared: base.defaultShared,
    restockDays: base.restockDays,
    group: groupOf(base),
    ...(units ? { units, unit: base.unit } : {}),
    store: o.store,
    checkedAt: new Date(checkedAt).toISOString(),
    ...(url ? { url } : {}),
  };
}

/** Live store listings for a catalog product, as options the member can pick. Undefined when unavailable. */
export async function liveOptionsFor(
  product: Product,
  opts: { now?: number; maxAgeHours?: number } = {},
): Promise<{ products: Product[]; checkedAt: number } | undefined> {
  const query = searchQuery(product);
  // Off-catalog searches carry the member's words, so logs name them by id only.
  const logAs = product.id.startsWith(OFF_CATALOG) ? product.id : undefined;
  const result = await searchOffers(query, { ...opts, ...(logAs ? { logAs } : {}) });
  if (!result) return undefined;
  // By default only major retailers we recognize, under their usual names. DEALS_ANY_STORE=1 keeps every seller.
  const relevantOffers = result.offers.filter((o) => relevant(o, product));
  const products = storeOffers(relevantOffers).map((o) => listingProduct(o, product, result.at));
  // Why listings drop out: off-topic or mispriced (relevant), then sellers we don't recognize (stores).
  logSearch(logAs ?? query, "listings", {
    kept: products.length, offers: result.offers.length, relevant: relevantOffers.length,
    sized: products.filter((p) => p.units).length,
  });
  // A search that leaves almost nothing usable shouldn't be reused for 12 hours: drop it so the next request
  // searches again. The daily cap still limits how often that can happen.
  if (products.length < MIN_CACHED_LISTINGS && cache.delete(cacheKeyFor(logAs ?? query))) {
    logSearch(logAs ?? query, "not cached", { kept: products.length, min: MIN_CACHED_LISTINGS });
  }
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
  loggedOff = false;
  picked.clear();
  usage = { day: "", count: 0 };
}
