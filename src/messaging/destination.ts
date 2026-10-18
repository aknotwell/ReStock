// Where an item goes and who it's for, when someone in several households texts Restock one-on-one:
// 1. "Which household is this for?" (their personal list is one of the choices), then
// 2. "Who's it for?" (everyone, just you, or some people), then the usual "Which one?".
// Both can be said up front ("order toilet paper for everyone for we da fam"), and then nothing is asked.
// Everything here is read by code. The questions are kept in memory only: they hold the member's message text,
// which is never saved to disk.
import { householdName } from "../core/households.js";
import { householdsForPhone } from "../core/store.js";
import type { Household, Member } from "../types.js";
import { parseSplitInAdd } from "./splitWith.js";
import { groupName } from "./whichList.js";

const TTL_MS = 10 * 60 * 1000;

type Pending =
  | { step: "household"; text: string; householdIds: string[]; newPersonal: boolean; expires: number }
  | { step: "split"; text: string; householdId: string; expires: number };
const pending = new Map<string, Pending>(); // phone -> the open question

const lower = (s: string) => s.toLowerCase().replace(/[’]/g, "'");

/** The names a member might use for one of their households: its name, "<owner>'s (household)", "personal". */
function namesFor(household: Household, phone: string): string[] {
  if (household.kind === "personal") return ["my personal list", "personal list", "my personal", "personal", "my list"];
  const owner = household.members.find((m) => m.id === household.ownerId);
  const names = [lower(householdName(household))];
  if (owner) {
    const first = lower(owner.name).split(/\s+/)[0]!;
    names.push(`${first}'s household`, `${first}'s house`, `${first}'s`);
    if (owner.phone === phone) names.push("my household", "our household");
  }
  return names;
}

/**
 * A household named in an add ("… for we da fam", "… in Amber's household", "… to my personal list"), with the
 * words to drop from the item text. Only the sender's own households count, and the longest name wins.
 */
export function namedHousehold(phone: string, text: string): { household: Household; phrase: string } | undefined {
  const t = lower(text);
  let best: { household: Household; phrase: string; length: number } | undefined;
  for (const h of householdsForPhone(phone)) {
    for (const name of namesFor(h, phone)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = new RegExp(`(?:^|\\s)(?:for|in|at|to|into|on)\\s+(?:the\\s+)?${escaped}(?=$|[\\s.,!?])`).exec(t);
      if (m && (!best || name.length > best.length)) best = { household: h, phrase: text.slice(m.index, m.index + m[0].length), length: name.length };
    }
  }
  return best && { household: best.household, phrase: best.phrase };
}

// "for my personal", "to my personal list", "in my personal cart", "on my personal account".
const PERSONAL = /(?:^|\s)(?:for|in|to|into|on)\s+(?:my\s+)?personal(?:\s+(?:list|cart|order|space|account))?(?=$|[\s.,!?])/i;
const hasPersonal = (phone: string) => householdsForPhone(phone).some((h) => h.kind === "personal");

/**
 * "for my personal" from someone who has no personal list yet: the words to drop. The caller creates the list
 * (only them, on their own card). Someone who has one is matched by namedHousehold instead.
 */
export function newPersonalNamed(phone: string, text: string): string | undefined {
  if (hasPersonal(phone)) return undefined;
  return PERSONAL.exec(text)?.[0];
}

/** The add without the household words: "order toilet paper for everyone for we da fam" -> "… for everyone". */
export function withoutHousehold(text: string, phrase: string): string {
  return text.replace(phrase, " ").replace(/\s+/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
}

/** Did they already say who it's for ("for me", "for everyone", "personal", "split with David")? */
export function splitStated(text: string, household: Household, sender: Member): boolean {
  if (/\b(?:personal|just (?:for )?me|only (?:for )?me|for myself|shared|for everyone|for all of us)\b/i.test(text)) return true;
  return !!parseSplitInAdd(text, household, sender);
}

export function askWhichHousehold(phone: string, text: string, now = Date.now()): string {
  const mine = householdsForPhone(phone);
  // Always a way to order just for themselves: their personal list, or a new one.
  const newPersonal = !mine.some((h) => h.kind === "personal");
  pending.set(phone, { step: "household", text, householdIds: mine.map((h) => h.id), newPersonal, expires: now + TTL_MS });
  const lines = mine.map((h, i) => `\n${i + 1}. ${groupName(h, phone)}`);
  if (newPersonal) lines.push(`\n${mine.length + 1}. Just me: a new personal list, on your own card`);
  return `Which household is this for?${lines.join("")}\nReply with a number or name, or "cancel".`;
}

export function askWhoFor(phone: string, text: string, household: Household, sender: Member, now = Date.now()): string {
  pending.set(phone, { step: "split", text, householdId: household.id, expires: now + TTL_MS });
  const other = household.members.find((m) => m.id !== sender.id)?.name.split(/\s+/)[0];
  const some = other ? `, or names like "me and ${other}"` : "";
  return `Who's it for in ${groupName(household, phone).replace(/^Your /, "your ")}? Reply "everyone", "just me"${some}.`;
}

export type DestinationReply =
  | { kind: "household"; household: Household; text: string }
  | { kind: "newPersonal"; text: string }
  | { kind: "split"; householdId: string; text: string }
  | { kind: "ask"; prompt: string }
  | { kind: "cancelled" }
  | { kind: "pass" };

const CANCEL = /^(?:cancel|never ?mind|nvm|no|stop)[.!]*$/;

/**
 * A reply to "Which household?" or "Who's it for?". Returns undefined when nothing is open or it has expired.
 * Returns `{ kind: "pass" }` when a question was open but this text isn't an answer: the question is dropped
 * and the caller handles the text as usual.
 */
export function answerDestination(phone: string, answer: string, member: (h: Household) => Member | undefined, now = Date.now()): DestinationReply | undefined {
  const p = pending.get(phone);
  if (!p) return undefined;
  if (p.expires <= now) {
    pending.delete(phone);
    return undefined;
  }
  const a = lower(answer.trim()).replace(/[.!?]+$/, "");
  if (CANCEL.test(a)) {
    pending.delete(phone);
    return { kind: "cancelled" };
  }
  if (p.step === "household") {
    // Numbers follow the list as it was asked (p.householdIds). Membership is re-checked: a household may have
    // been deleted or left since, and then its number must not slide onto the next one.
    const options = householdsForPhone(phone).filter((h) => p.householdIds.includes(h.id));
    const number = /^#?(\d{1,2})$/.exec(a);
    const personalAnswer = /^(?:just me|me|mine|personal|my personal(?: list)?|personal list|new personal list|a new personal list)$/.test(a);
    if (p.newPersonal && ((number && Number(number[1]) === p.householdIds.length + 1) || personalAnswer)) {
      pending.delete(phone);
      return { kind: "newPersonal", text: p.text };
    }
    const chosen = number
      ? options.find((h) => h.id === p.householdIds[Number(number[1]) - 1])
      : options.find((h) => namesFor(h, phone).some((n) => n === a || n.replace(/'s.*$/, "") === a));
    if (!chosen) {
      if (number) {
        const listed = Number(number[1]) >= 1 && Number(number[1]) <= p.householdIds.length;
        return {
          kind: "ask",
          prompt: listed
            ? `That household isn't available anymore. Reply with another number, or "cancel".`
            : `Reply with a number from 1 to ${p.householdIds.length + (p.newPersonal ? 1 : 0)}, or "cancel".`,
        };
      }
      pending.delete(phone);
      return { kind: "pass" };
    }
    pending.delete(phone);
    return { kind: "household", household: chosen, text: p.text };
  }
  const household = householdsForPhone(phone).find((h) => h.id === p.householdId);
  const me = household && member(household);
  if (!household || !me) {
    pending.delete(phone);
    return undefined;
  }
  const who =
    /^(?:everyone|everybody|all|all of us|shared|split it|the household|whole household)$/.test(a) ? "everyone"
    : /^(?:me|just me|only me|myself|personal|mine|just mine|for me)$/.test(a) ? "me"
    : a.replace(/^(?:for|just|only|split (?:it )?(?:with|between)|between)\s+/, "");
  const request = parseSplitInAdd(`item for ${who}`, household, me);
  if (!request) {
    pending.delete(phone); // not about people ("what do I owe?", "order now"): handle it as a new message
    return { kind: "pass" };
  }
  if (request.request.kind === "unclear") {
    // About people, but someone we can't place ("me and Bob", "the guys"): ask again.
    return { kind: "ask", prompt: `I don't know who that is in ${groupName(household, phone).replace(/^Your /, "your ")}. Reply "everyone", "just me", or first names.` };
  }
  pending.delete(phone);
  return { kind: "split", householdId: household.id, text: `${p.text} for ${who}` };
}

export function clearDestination(phone: string): void {
  pending.delete(phone);
}

/** Test helper. */
export function resetDestinations(): void {
  pending.clear();
}
