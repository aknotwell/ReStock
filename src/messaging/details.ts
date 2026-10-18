// Owner: Person 1. "Any brand or size?": asked only when a store search comes back thin and the member didn't
// say a brand or size. Their answer is searched again; "any" shows what was found; anything else moves on.
import { leftoverWords } from "../ai/searchSpec.js";
import type { Product } from "../core/catalog.js";
import { registerState } from "../core/persist.js";
import type { Choice } from "./options.js";

export const DETAILS_TTL_MS = 10 * 60 * 1000;
/** Fewer good store listings than this, and it's worth asking for a brand or size. */
export const MIN_GOOD_LISTINGS = 2;

type Pending = { requested: string; shared: boolean | null; found: Choice; expires: number };
const pending = new Map<string, Pending>();
const key = (householdId: string, memberId: string) => `${householdId}|${memberId}`;

registerState("detail-questions", {
  dump: () => [...pending],
  load: (data) => {
    pending.clear();
    const now = Date.now();
    for (const [k, v] of data as [string, Pending][]) if (v.expires > now) pending.set(k, v);
  },
});

/** Did they already name a brand or size? Then asking again wouldn't help. */
export function namedDetails(requested: string, product: Product | undefined): boolean {
  if (product && !product.id.startsWith("search-")) {
    const { rest, size } = leftoverWords(requested, product);
    return !!size || rest.length > 0;
  }
  // Off-catalog items are already the member's own words: a number or a longer phrase is specific enough.
  return /\d/.test(requested) || requested.trim().split(/\s+/).length >= 3;
}

/** A store search that found fewer than two listings to choose from. Catalog-only results don't count. */
export function thinResults(choice: Choice): boolean {
  return choice.options.filter((o) => o.checkedAt).length < MIN_GOOD_LISTINGS;
}

export function askForDetails(
  householdId: string, memberId: string, requested: string, item: string, shared: boolean | null, found: Choice, now = Date.now(),
): string {
  pending.set(key(householdId, memberId), { requested, shared, found, expires: now + DETAILS_TTL_MS });
  const count = found.options.filter((o) => o.checkedAt).length;
  const lead = count === 0 ? `I couldn't find good store matches for ${item}.` : `I only found 1 good match for ${item}.`;
  const any = count ? ` Or reply "any" to see what I found.` : ` Or reply "cancel".`;
  return `${lead} Any brand or size you want? (like "Charmin, 24 rolls")${any}`;
}

/** The open question for this member, if any. Expired ones are dropped. */
export function pendingDetails(householdId: string, memberId: string, now = Date.now()): Pending | undefined {
  const k = key(householdId, memberId);
  const p = pending.get(k);
  if (p && p.expires <= now) pending.delete(k);
  return p && p.expires > now ? p : undefined;
}

export function clearDetails(householdId: string, memberId: string): void {
  pending.delete(key(householdId, memberId));
}

/** "any", "no preference", "whatever", "doesn't matter", "show me": go with what was found. */
export const NO_PREFERENCE = /^(?:any(?:thing| is fine| works)?|no(?:pe|ne)?|nah|whatever|no preference|doesn'?t matter|don'?t care|show me(?: what you (?:found|have))?|just show me)[.!]*$/i;

/** Test helper. */
export function resetDetails(): void {
  pending.clear();
}

// ---------- Vague but plenty: a hint under the options ----------

export type DetailKind = "brand" | "size";

/** "Charmin, Cottonelle or Scott", "12 or 24 rolls". */
const orList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

/**
 * How the shown store listings differ: their pack sizes (in the product's unit) and brands (a listing title's first
 * word, unless it's one of the product's own words, like "Toilet"). Only real listing data, never the model's words.
 */
export function optionVariety(options: Product[], product: Product | undefined): { sizes: number[]; unit?: string; brands: string[] } {
  const listings = options.filter((o) => o.store);
  const unit = listings.find((o) => o.units && o.unit)?.unit;
  const sizes = [...new Set(listings.filter((o) => o.units && o.unit === unit).map((o) => o.units!))].sort((a, b) => a - b);
  const own = new Set(product ? [product.name, ...product.aliases].flatMap((n) => n.toLowerCase().split(/[^\p{L}\p{N}]+/u)) : []);
  const brands: string[] = [];
  for (const o of listings) {
    const first = /^[\p{Lu}][\p{L}'&.-]{1,20}/u.exec(o.name)?.[0];
    if (first && !own.has(first.toLowerCase()) && !brands.some((b) => b.toLowerCase() === first.toLowerCase())) brands.push(first);
  }
  return { sizes, ...(unit ? { unit } : {}), brands };
}

/**
 * The line under the options when a request was vague: which sizes or brands they could name, taken from the
 * listings shown. `askAbout` is Claude's suggestion; it only counts where the listings really differ. Without
 * Claude (undefined), any real difference counts. Undefined when there's nothing worth suggesting.
 */
export function detailsHint(options: Product[], product: Product | undefined, askAbout?: DetailKind[]): string | undefined {
  const { sizes, unit, brands } = optionVariety(options, product);
  const wants = (k: DetailKind) => askAbout === undefined || askAbout.includes(k);
  const sizeText = wants("size") && sizes.length >= 2 && unit ? `${orList(sizes.map(String))} ${unit}s` : undefined;
  const brandText = wants("brand") && brands.length >= 2 ? orList(brands.slice(0, 3)) : undefined;
  if (!sizeText && !brandText) return undefined;
  const example = [brandText ? brands[0] : undefined, sizeText ? `${sizes.at(-1)} ${unit}s` : undefined].filter(Boolean).join(", ");
  const what = [brandText && `a brand (${brandText})`, sizeText && `a size (${sizeText})`].filter(Boolean).join(" or ");
  return `Want ${what}? Reply like "${example}" and I'll search again.`;
}

/**
 * Is this text an answer naming a brand or size ("Charmin, 24 rolls")? Commands, greetings, "yes", questions and
 * long messages aren't: they're handled as usual.
 */
export function looksLikeDetails(answer: string, isOtherwiseHandled: boolean): boolean {
  return !isOtherwiseHandled && !/\?\s*$/.test(answer) && answer.trim().split(/\s+/).length <= 8;
}
