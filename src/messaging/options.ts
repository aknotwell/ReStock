// Owner: Person 1. "Add TP" -> up to three options to pick from, or the household's usual if asked.
// Real prices first: when SERPAPI_KEY is set and the search finds store listings (src/deals/live.ts), the options
// are those listings only. The demo catalog is the fallback, labelled as demo prices when live prices were expected.
// Names and prices come from those listings or the catalog, never the model. The member picks; the AI never
// chooses for them. Options are ranked by price per unit in code, and the cheapest is labelled "best value".
import { alternativesFor, getProductByName, groupOf, unitCents, type Product } from "../core/catalog.js";
import { registerState } from "../core/persist.js";
import { db, getHousehold, pendingItems } from "../core/store.js";
import { liveDealsEnabled, liveOptionsFor, pickedByName, rememberPicked } from "../deals/live.js";
import { applyFilters, bestValueId, describeFilters, hasFilters, optionCount, rankOptions, type DealOptions } from "../deals/rank.js";
import { fmt } from "./templates.js";

const PICK_TTL_MS = 10 * 60 * 1000;

/** One item someone asked for, waiting for them to choose an option. */
export type Choice = {
  options: Product[];
  shared: boolean | null;
  /** Who it's split between, if they said ("for me and Jake"): carried through to the pick. */
  splitWith?: string[];
  lastBoughtId?: string;
  bestValueId?: string;
  /** Options that would take the household over its monthly budget: picking one needs the owner's OK. */
  overBudgetIds?: string[];
  ownerName?: string;
  /** The owner asked, so over-budget options need nobody's OK: they're just labelled "over budget". */
  askedByOwner?: boolean;
  /** When live prices were checked (ISO), if any option is a live listing. */
  checkedAt?: string;
  /** Shown above the options, e.g. when nothing matched the member's filters. */
  note?: string;
  /** Catalog options shown because store prices weren't available: labelled as demo prices. */
  demoPrices?: boolean;
};
type Pending = { queue: Choice[]; expires: number };

const pending = new Map<string, Pending>();
// Open "Which one?" questions survive a restart; expired ones are dropped on load.
registerState("option-picks", {
  dump: () => [...pending],
  load: (data) => {
    pending.clear();
    for (const [k, p] of data as [string, Pending][]) if (p.expires > Date.now()) pending.set(k, p);
  },
});
const key = (householdId: string, memberId: string) => `${householdId}:${memberId}`;

/** "the usual", "same as last time", "what we got before"... */
export function wantsUsual(text: string): boolean {
  return /\b(?:usual|same (?:as|one|kind|thing)(?: as)?(?: (?:last time|before|last order))?|(?:what|the one) (?:we|i) (?:got|had|bought|ordered|get)(?: last time| before)?|last time|like before)\b/i.test(text);
}

/** Drop words that mean "the usual" so "the usual TP" still matches toilet paper. */
export function stripUsual(itemName: string): string {
  return itemName
    .replace(/\b(?:the|my|our)\s+usual\b|\busual\b|\bsame (?:as|one|kind|thing)(?: as)?(?: (?:last time|before|last order))?\b|\b(?:like|from) (?:last time|before)\b|\blast time\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.!-]+|[\s,;:.!-]+$/g, "");
}

/** The most recent product this household ordered from the same group, if any. */
export function lastBought(householdId: string, product: Product): Product | undefined {
  const group = groupOf(product);
  const orders = [...db.orders.values()]
    .filter((o) => o.householdId === householdId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const order of orders) {
    for (const id of order.itemIds) {
      const name = db.items.get(id)?.name;
      const bought = name ? getProductByName(name) ?? pickedByName(name) : undefined;
      if (bought && groupOf(bought) === group) return bought;
    }
  }
  return undefined;
}

/**
 * Did the member name a specific option ("bulk TP", "decaf")? Then we add it directly.
 * Only an alternative's own name or aliases count. The group's main product shares the generic words.
 */
export function namedSpecifically(requested: string, product: Product): boolean {
  if (!product.group) return false;
  const q = requested.trim().toLowerCase();
  return q === product.name.toLowerCase() || product.aliases.some((a) => q.includes(a.toLowerCase()));
}

/** Money left this month after the current cart. */
function budgetLeft(householdId: string): number {
  const h = getHousehold(householdId);
  if (h.budgetCents === undefined) return Number.POSITIVE_INFINITY;
  return h.budgetCents - h.spentCents - pendingItems(householdId).reduce((sum, i) => sum + i.cents, 0);
}

/**
 * Up to `opts.count` (default 3) options for an item. Live store listings and catalog alternatives are ranked
 * together: options with a known pack size by price per unit (best value first), then the rest by price; or all
 * by price for `sort: "cheapest"`. Ties keep live listings first. Filters (price cap, pack size, store) apply to
 * both; if nothing passes, we say so and show the unfiltered options. The household's last purchase still goes to
 * the top, so "the usual" is easy to repeat.
 */
export function buildChoice(
  householdId: string,
  product: Product,
  shared: boolean | null,
  opts: DealOptions = {},
  live: Product[] = [],
  askerId?: string,
): Choice {
  const count = optionCount(opts.count);
  // Real prices first: with store listings, the options are listings only. Without them, the demo catalog.
  // Unsized catalog options (hand soap) keep their catalog order; unsized listings go by price.
  const pool = live.length ? live : alternativesFor(product);
  // Store titles often leave out the pack size. With fewer than two sized listings there's nothing to compare
  // per unit, so listings go by price rather than letting one sized listing jump the queue.
  const sort = live.length && live.filter((p) => p.units).length < 2 ? "cheapest" : opts.sort;
  const rank = (list: Product[]) => rankOptions(list, sort, { restByPrice: live.length > 0 });
  let ranked = rank(hasFilters(opts) ? applyFilters(pool, opts) : pool);
  let note: string | undefined;
  if (!ranked.length) {
    note = live.length
      ? `No store listing matched ${describeFilters(opts)}, so here are the closest ones.`
      : `Nothing matched ${describeFilters(opts)}, so here are the usual options.`;
    ranked = rank(pool);
  }

  // Pin last time's pick unless it fails a filter the member asked for. With store listings, only a listing
  // that's in today's results counts (at today's price); a demo-catalog pick isn't mixed in with real prices.
  const found = lastBought(householdId, product);
  const current = found && (live.length ? live.find((p) => p.id === found.id) : found.store ? undefined : found);
  const last = current && (note || !hasFilters(opts) || applyFilters([current], opts).length > 0) ? current : undefined;
  const options = (last ? [last, ...ranked.filter((p) => p.id !== last.id)] : ranked).slice(0, count);

  const choice: Choice = { options, shared };
  if (last) choice.lastBoughtId = last.id;
  const best = bestValueId(options);
  if (best) choice.bestValueId = best;
  if (note) choice.note = note;
  const checked = options.find((p) => p.checkedAt)?.checkedAt;
  if (checked) choice.checkedAt = checked;
  else if (liveDealsEnabled()) choice.demoPrices = true;
  if (opts.respectBudget !== false) {
    const left = budgetLeft(householdId);
    const over = options.filter((p) => p.cents > left).map((p) => p.id);
    if (over.length) {
      const h = getHousehold(householdId);
      choice.overBudgetIds = over;
      choice.ownerName = h.members.find((m) => m.id === h.ownerId)?.name ?? "the budget owner";
      if (askerId === h.ownerId) choice.askedByOwner = true;
    }
  }
  return choice;
}

/** buildChoice with live store listings when SERPAPI_KEY is set. Falls back to the catalog on any problem. */
export async function buildDealChoice(
  householdId: string,
  product: Product,
  shared: boolean | null,
  opts: DealOptions = {},
  askerId?: string,
): Promise<Choice> {
  const spec = { ...(opts.brand ? { brand: opts.brand } : {}), ...(opts.size ? { size: opts.size } : {}) };
  let live = await liveOptionsFor(product, { maxAgeHours: opts.maxAgeHours, ...spec });
  let note: string | undefined;
  if (opts.brand && !live?.products.length) {
    // Nothing from that brand right now: show the product's other listings rather than nothing, and say why.
    live = await liveOptionsFor(product, { maxAgeHours: opts.maxAgeHours, ...(opts.size ? { size: opts.size } : {}) });
    if (live?.products.length) note = `I couldn't find ${opts.brand} listings right now, so here are other options.`;
  }
  const choice = buildChoice(householdId, product, shared, opts, live?.products ?? [], askerId);
  if (note) choice.note = choice.note ? `${note} ${choice.note}` : note;
  return choice;
}

/** "just now", "5 min ago", "3 hr ago". */
export function checkedAgo(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 2) return "just now";
  return mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} hr ago`;
}

function optionLine(p: Product, i: number, choice: Choice): string {
  const per = unitCents(p);
  const notes = [
    per !== undefined ? `${fmt(per)}/${p.unit}` : undefined,
    p.id === choice.bestValueId ? "best value" : undefined,
    p.id === choice.lastBoughtId ? "what you got last time" : undefined,
    choice.overBudgetIds?.includes(p.id) ? (choice.askedByOwner ? "over budget" : `over budget, needs ${choice.ownerName}'s OK`) : undefined,
  ].filter(Boolean);
  // The store page goes on its own line so the member can look before replying with a number.
  return `${i + 1}. ${p.name}: ${fmt(p.cents)}${notes.length ? ` (${notes.join(", ")})` : ""}${p.url ? `\n   ${p.url}` : ""}`;
}

export function choicePrompt(choice: Choice): string {
  const lines = choice.options.map((p, i) => optionLine(p, i, choice));
  const n = choice.options.length;
  const replies = n === 1 ? "1" : `${Array.from({ length: n - 1 }, (_, i) => i + 1).join(", ")} or ${n}`;
  const head = choice.note ? `${choice.note}\n` : "";
  const checked = choice.checkedAt
    ? `\nStore prices checked ${checkedAgo(choice.checkedAt)}.`
    : choice.demoPrices
      ? "\nStore prices aren't available right now, so these are Restock demo prices."
      : "";
  return `${head}Which one?\n${lines.join("\n")}${checked}\nReply ${replies}, or "cancel".`;
}

/** Queue choices for a member. Returns the prompt for the first one if nothing was already waiting. */
export function queueChoices(householdId: string, memberId: string, choices: Choice[], now = Date.now()): string | undefined {
  if (!choices.length) return undefined;
  const k = key(householdId, memberId);
  const current = pending.get(k);
  if (current && current.expires > now && current.queue.length) {
    current.queue.push(...choices);
    current.expires = now + PICK_TTL_MS;
    return undefined;
  }
  pending.set(k, { queue: [...choices], expires: now + PICK_TTL_MS });
  return choicePrompt(choices[0]!);
}

export function hasPendingChoice(householdId: string, memberId: string, now = Date.now()): boolean {
  const p = pending.get(key(householdId, memberId));
  if (p && p.expires <= now) pending.delete(key(householdId, memberId));
  return !!p && p.expires > now && p.queue.length > 0;
}

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, one: 1, two: 2, three: 3 };

/** "2", "#2", "option 2", "the second one" -> 2. Anything else -> undefined. */
export function parsePick(text: string): number | undefined {
  const t = text.trim().toLowerCase().replace(/[.!)]+$/, "");
  const digit = /^(?:#|no\.?\s*|number\s+|option\s+)?([1-9])$/.exec(t);
  if (digit) return Number(digit[1]);
  const word = /^(?:the\s+)?(first|second|third|one|two|three)(?:\s+one)?(?:\s+please)?$/.exec(t);
  return word ? ORDINALS[word[1]!] : undefined;
}

export function isCancel(text: string): boolean {
  return /^(?:cancel|none|nevermind|never mind|no thanks|none of (?:them|those))[.!]*$/i.test(text.trim());
}

export type PickResult =
  | { kind: "picked"; product: Product; shared: boolean | null; splitWith?: string[]; next?: string; overBudget?: { ownerName: string } }
  | { kind: "invalid"; prompt: string }
  | { kind: "cancelled"; next?: string };

/** Resolve the member's reply against their oldest waiting choice. */
export function resolvePick(householdId: string, memberId: string, reply: number | "cancel", now = Date.now()): PickResult | undefined {
  const k = key(householdId, memberId);
  if (!hasPendingChoice(householdId, memberId, now)) return undefined;
  const p = pending.get(k)!;
  const choice = p.queue[0]!;
  if (reply !== "cancel" && (reply < 1 || reply > choice.options.length)) return { kind: "invalid", prompt: choicePrompt(choice) };
  p.queue.shift();
  p.expires = now + PICK_TTL_MS;
  const next = p.queue[0] ? choicePrompt(p.queue[0]) : undefined;
  if (!p.queue.length) pending.delete(k);
  if (reply === "cancel") return { kind: "cancelled", next };
  const product = choice.options[reply - 1]!;
  rememberPicked(product); // a store listing, so "the usual" can find it after it's ordered
  const result: Extract<PickResult, { kind: "picked" }> = { kind: "picked", product, shared: choice.shared, next };
  if (choice.splitWith?.length) result.splitWith = choice.splitWith;
  if (choice.overBudgetIds?.includes(product.id)) result.overBudget = { ownerName: choice.ownerName ?? "the budget owner" };
  return result;
}

/** Tests only. */
export function clearPendingChoices(): void {
  pending.clear();
}
