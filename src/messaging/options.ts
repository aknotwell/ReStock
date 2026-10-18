// Owner: Person 1. "Add TP" -> three catalog options to pick from, or the household's usual if asked.
// Prices and names always come from the catalog. The member picks; the AI never chooses for them.
// Options are ranked by price per unit in code, and the cheapest is labelled "best value".
import { alternativesFor, byUnitPrice, getProductByName, groupOf, unitCents, type Product } from "../core/catalog.js";
import { registerState } from "../core/persist.js";
import { db } from "../core/store.js";
import { fmt } from "./templates.js";

const PICK_TTL_MS = 10 * 60 * 1000;

/** One item someone asked for, waiting for them to choose an option. */
export type Choice = { options: Product[]; shared: boolean | null; lastBoughtId?: string; bestValueId?: string };
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
      const bought = name ? getProductByName(name) : undefined;
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

/**
 * Up to three options, best value (lowest price per unit) first, then the rest by price per unit.
 * The household's last purchase (if any) still goes to the top, so "what we usually get" is easy to repeat.
 */
export function buildChoice(householdId: string, product: Product, shared: boolean | null): Choice {
  const alternatives = alternativesFor(product);
  const ranked = byUnitPrice(alternatives);
  // "Best value" only when the options were comparable and the cheapest strictly beats the runner-up.
  const [best, next] = ranked;
  let bestValueId: string | undefined;
  if (ranked !== alternatives && best && next && best.cents * next.units! < next.cents * best.units!) bestValueId = best.id;
  const last = lastBought(householdId, product);
  if (last) {
    const rest = ranked.filter((p) => p.id !== last.id);
    return { options: [last, ...rest].slice(0, 3), shared, lastBoughtId: last.id, bestValueId };
  }
  return { options: ranked, shared, bestValueId };
}

function optionLine(p: Product, i: number, choice: Choice): string {
  const per = unitCents(p);
  const notes = [
    per !== undefined ? `${fmt(per)}/${p.unit}` : undefined,
    p.id === choice.bestValueId ? "best value" : undefined,
    p.id === choice.lastBoughtId ? "what you got last time" : undefined,
  ].filter(Boolean);
  return `${i + 1}. ${p.name}: ${fmt(p.cents)}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

export function choicePrompt(choice: Choice): string {
  const lines = choice.options.map((p, i) => optionLine(p, i, choice));
  const n = choice.options.length;
  const replies = n === 1 ? "1" : `${Array.from({ length: n - 1 }, (_, i) => i + 1).join(", ")} or ${n}`;
  return `Which one?\n${lines.join("\n")}\nReply ${replies}, or "cancel".`;
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
  | { kind: "picked"; product: Product; shared: boolean | null; next?: string }
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
  return { kind: "picked", product: choice.options[reply - 1]!, shared: choice.shared, next };
}

/** Tests only. */
export function clearPendingChoices(): void {
  pending.clear();
}
