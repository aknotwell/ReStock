// Owner: Person 1 (drafted by Person 3). Who pays for an item, from people's own words:
// "add oat milk for me and Jake", "just me and Alex", "split with Abdul", "everyone", "not me".
// Parsed in code and checked against the household's members. The model never decides who pays,
// and a name we can't match is asked about, never guessed.
import type { Cents, Household, Item, Member } from "../types.js";
import { fmt } from "./templates.js";

export type SplitRequest =
  | { kind: "everyone" }
  | { kind: "group"; memberIds: string[] } // household order, no duplicates
  | { kind: "not_me"; itemName?: string }
  | { kind: "unclear"; words: string[] }; // words that aren't anyone in the household

const EVERYONE = /^(?:everyone|everybody|all of us|all|us all|the (?:whole )?(?:house|household|group))$/;
const EVERYONE_EXCEPT = /^(?:everyone|everybody|all of us)\s+(?:except|but|other than)\s+(.+)$/;
const ME = /^(?:me|myself|i)$/;
// Words that mean "some people" without saying who: always asked about, never guessed.
const VAGUE_PEOPLE = /^(?:the )?(?:guys|girls|boys|gals|roommates|roomies|housemates|others|other guys|rest of us|kids|us|them|we|y'?all|you guys|you all|everyone else)$/;

/** "me, Jake and Priya" -> ["me", "jake", "priya"] */
function words(list: string): string[] {
  return list
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .split(/\s*(?:,|&|\+|\band\b)\s*/)
    .map((w) => w.trim().replace(/^@/, ""))
    .filter(Boolean);
}

function matchMember(word: string, household: Household, sender: Member): Member | "ambiguous" | undefined {
  if (ME.test(word)) return sender;
  const hits = household.members.filter((m) => {
    const name = m.name.toLowerCase();
    return name === word || name.split(/\s+/)[0] === word;
  });
  return hits.length > 1 ? "ambiguous" : hits[0];
}

type Resolved = { everyone: true } | { ids: string[]; unknown: string[] };

function resolve(list: string, household: Household, sender: Member): Resolved {
  const text = list.toLowerCase().trim().replace(/[.!?]+$/, "");
  if (EVERYONE.test(text)) return { everyone: true };
  const except = EVERYONE_EXCEPT.exec(text);
  const unknown: string[] = [];
  const ids = new Set<string>();
  for (const w of words(except ? except[1]! : text)) {
    const m = matchMember(w, household, sender);
    if (!m || m === "ambiguous") unknown.push(w);
    else ids.add(m.id);
  }
  const chosen = except ? household.members.filter((m) => !ids.has(m.id)) : household.members.filter((m) => ids.has(m.id));
  return { ids: chosen.map((m) => m.id), unknown };
}

const toRequest = (r: Resolved): SplitRequest =>
  "everyone" in r ? { kind: "everyone" } : r.unknown.length ? { kind: "unclear", words: r.unknown } : { kind: "group", memberIds: r.ids };

/**
 * Who an item is for, from the end of an "add" message: "for me and Jake", "split with Abdul",
 * "between Abdul and David". `phrase` is the matched text, so it can be stripped from the item name.
 * "for …" only counts when it names people ("tp for the bathroom" is not a split request).
 */
export function parseSplitInAdd(text: string, household: Household, sender: Member): { request: SplitRequest; phrase: string } | undefined {
  const m = /\b(split (?:it )?(?:with|between)|shared? (?:it )?(?:with|between)|between|for)\s+(.+?)[.!?]*$/i.exec(text);
  if (!m) return undefined;
  const [phrase, keyword, list] = [m[0], m[1]!.toLowerCase(), m[2]!];
  const resolved = resolve(list, household, sender);
  // "for the bathroom" isn't about people; "for the guys" is, but doesn't say who, so it's asked about.
  if ("ids" in resolved && keyword === "for" && resolved.ids.length === 0 && !resolved.unknown.some((w) => VAGUE_PEOPLE.test(w))) {
    return undefined;
  }
  // "split with Abdul" means the sender and Abdul; "for"/"between" name exactly who pays.
  if ("ids" in resolved && /with/.test(keyword) && !resolved.unknown.length) {
    resolved.ids = household.members.filter((x) => x.id === sender.id || resolved.ids.includes(x.id)).map((x) => x.id);
  }
  return { request: toRequest(resolved), phrase };
}

/**
 * A whole message that changes who pays for an item already in the cart:
 * "just me and Alex", "only Abdul", "split with Priya", "everyone", "not me", "not me for the chips".
 * Returns undefined when the message isn't one of these (it then goes to the normal parser).
 */
export function parseSplitCommand(text: string, household: Household, sender: Member): SplitRequest | undefined {
  const t = text.trim().toLowerCase().replace(/[’]/g, "'");
  const notMe = /^(?:not me|count me out|leave me out|take me off|i'?m out)(?:\s+(?:for|of|from|on)\s+(?:the\s+)?(.+?))?[.!]*$/.exec(t);
  if (notMe) return { kind: "not_me", ...(notMe[1] ? { itemName: notMe[1] } : {}) };
  if (/^(?:(?:split (?:it )?with|share (?:it )?with)\s+)?(?:everyone|everybody|all of us)[.!]*$/.test(t)) return { kind: "everyone" };

  const just = /^(?:just|only)\s+(.+)$/.exec(t);
  if (just) {
    const r = resolve(just[1]!, household, sender);
    return "ids" in r && (r.unknown.length || !r.ids.length) ? undefined : toRequest(r);
  }
  const split = /^(split (?:it )?(?:with|between)|share (?:it )?with)\s+(.+)$/.exec(t);
  if (split) {
    const r = resolve(split[2]!, household, sender);
    if ("ids" in r && /with/.test(split[1]!) && !r.unknown.length) {
      r.ids = household.members.filter((x) => x.id === sender.id || r.ids.includes(x.id)).map((x) => x.id);
    }
    return toRequest(r);
  }
  return undefined;
}

/** Who pays for this item now, in household order. */
export function payersOf(item: Item, household: Household): Member[] {
  if (item.splitWith?.length) {
    const group = household.members.filter((m) => item.splitWith!.includes(m.id));
    if (group.length) return group;
  }
  if (!item.shared) {
    const adder = household.members.find((m) => m.id === item.addedBy);
    if (adder) return [adder];
  }
  return household.members;
}

/**
 * Set who pays. Everyone in the household becomes plain "shared" and the adder alone becomes plain
 * "personal", so the cart stays simple; anything in between is stored as `splitWith`.
 */
export function setPayers(item: Item, memberIds: string[], household: Household): void {
  const ids = household.members.filter((m) => memberIds.includes(m.id)).map((m) => m.id);
  delete item.splitWith;
  if (ids.length === 0 || ids.length === household.members.length) item.shared = true;
  else if (ids.length === 1 && ids[0] === item.addedBy) item.shared = false;
  else {
    item.shared = true;
    item.splitWith = ids;
  }
}

/** Each payer's part, with the split engine's rule: leftover cents go to the first in household order. */
export function partsOf(item: Item, household: Household): { member: Member; cents: Cents }[] {
  const payers = payersOf(item, household);
  const base = Math.floor(item.cents / payers.length);
  const remainder = item.cents - base * payers.length;
  return payers.map((member, i) => ({ member, cents: base + (i < remainder ? 1 : 0) }));
}

const names = (list: string[]) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

/**
 * The label in "Added Oat milk (…, $5.49)": "shared", "personal", or "split between you and Jake".
 * `viewerId` is who reads it, so they see "you".
 */
export function splitLabel(item: Item, household: Household, viewerId?: string): string {
  if (!item.splitWith?.length) return item.shared ? "shared" : "personal";
  const payers = payersOf(item, household);
  const me = payers.filter((m) => m.id === viewerId).map(() => "you");
  return `split between ${names([...me, ...payers.filter((m) => m.id !== viewerId).map((m) => m.name)])}`;
}

/** "split between you ($2.75) and Alex ($2.74)", "split with everyone", or "just Alex's" */
export function describeParts(item: Item, household: Household, viewerId?: string): string {
  const parts = partsOf(item, household);
  if (!item.splitWith?.length && item.shared) return "split with everyone";
  if (parts.length === 1) return parts[0]!.member.id === viewerId ? "just yours" : `just ${parts[0]!.member.name}'s`;
  const ordered = [...parts.filter((p) => p.member.id === viewerId), ...parts.filter((p) => p.member.id !== viewerId)];
  return `split between ${names(ordered.map((p) => `${p.member.id === viewerId ? "you" : p.member.name} (${fmt(p.cents)})`))}`;
}

/** "Who's "the guys"? Reply with names, like "Alex, Abdul"." */
export function unclearReply(words: string[], household: Household, itemName?: string): string {
  const example = household.members.slice(0, 2).map((m) => m.name).join(", ");
  const who = words.map((w) => `"${w}"`).join(", ");
  return `I don't know who ${who} ${words.length === 1 ? "is" : "are"} in this household${itemName ? `, so I didn't add ${itemName} yet` : ""}. Use first names, like "${example}", or "everyone".`;
}
