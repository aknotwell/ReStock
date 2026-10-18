// "shopping list" in a one-on-one text from someone in several groups: ask which group's
// list they mean, then show that one. Only the sender's own groups are ever listed, and picks are read by code.
import { registerState } from "../core/persist.js";
import { db, householdsForPhone, pendingItems } from "../core/store.js";
import type { Household } from "../types.js";
import { cartSummary } from "./cart.js";

const PICK_TTL_MS = 10 * 60 * 1000;

/** "list": show the chosen group's cart. "order": start checking out the chosen group's cart. */
/** "invite": run the invite command (`payload`) for the chosen household. */
export type PickPurpose = "list" | "order" | "invite";
type Pending = { householdIds: string[]; expires: number; purpose?: PickPurpose; payload?: unknown };
const pending = new Map<string, Pending>(); // phone -> the groups we asked them to pick from

registerState("list-picks", {
  dump: () => [...pending],
  load: (data) => {
    pending.clear();
    for (const [k, p] of data as [string, Pending][]) if (p.expires > Date.now()) pending.set(k, p);
  },
});

/**
 * "Your personal list", "we da fam (David and you)" for a household with its own name, or "Sam's household (Sam, Jake
 * and Priya)": the members are listed so two households with one owner differ.
 */
export function groupName(household: Household, phone: string): string {
  if (household.kind === "personal") return "Your personal list";
  const owner = household.members.find((m) => m.id === household.ownerId);
  const names = household.members.map((m) => (m.phone === phone ? "you" : m.name));
  const who = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  // Its own name when it has one ("we da fam (David and you)"); otherwise "<owner>'s household".
  if (household.name) return `${household.name} (${who})`;
  return `${owner?.phone === phone ? "Your" : `${owner?.name ?? "A"}'s`} household (${who})`;
}

/** The groups this phone is in, when there's more than one to choose from. */
export function groupsToPick(phone: string): Household[] | undefined {
  const mine = householdsForPhone(phone);
  return mine.length > 1 ? mine : undefined;
}

/** Ask "Which list?" (or "Which cart should I order?") and remember the question for a few minutes. */
export function askWhichList(phone: string, households: Household[], purpose: PickPurpose = "list", payload?: unknown, question?: string): string {
  pending.set(phone, { householdIds: households.map((h) => h.id), expires: Date.now() + PICK_TTL_MS, purpose, ...(payload ? { payload } : {}) });
  const lines = households.map((h, i) => `\n${i + 1}. ${groupName(h, phone)}`);
  question ??= purpose === "order" ? "Which cart should I order?" : purpose === "invite" ? "Which household should I invite them to?" : "Which list?";
  return `${question}${lines.join("")}\nReply with a number, or "cancel".`;
}

export type ListPick =
  | { kind: "shown"; text: string }
  | { kind: "cancelled" }
  | { kind: "order"; household: Household }
  | { kind: "invite"; household: Household; payload: unknown };

/**
 * A reply to "Which list?": "2", "Sam's", "personal" or "cancel". Returns undefined when nothing is pending or
 * the text isn't a pick; any other message drops the question, so a later "1" goes to whatever was asked last.
 */
export function resolveListPick(phone: string, text: string): ListPick | undefined {
  const ask = pending.get(phone);
  if (!ask) return undefined;
  if (ask.expires <= Date.now()) {
    pending.delete(phone);
    return undefined;
  }
  const t = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, "");
  if (/^(?:cancel|never ?mind|nvm|stop asking|no)$/.test(t)) {
    pending.delete(phone);
    return { kind: "cancelled" };
  }
  // Numbers follow the list as asked. Membership is re-checked: someone may have left a group since then.
  const stillMine = (h: Household | undefined): h is Household => !!h && h.members.some((m) => m.phone === phone);
  const number = /^#?(\d{1,2})$/.exec(t);
  const chosen = number
    ? [db.households.get(ask.householdIds[Number(number[1]) - 1] ?? "")].find(stillMine)
    : byName(ask.householdIds.map((id) => db.households.get(id)).filter(stillMine), t, phone);
  if (!chosen) {
    if (number) return { kind: "shown", text: `Reply with a number from 1 to ${ask.householdIds.length}, or "cancel".` };
    pending.delete(phone); // not a reply to the question
    return undefined;
  }
  pending.delete(phone);
  if (ask.purpose === "order") return { kind: "order", household: chosen };
  if (ask.purpose === "invite") return { kind: "invite", household: chosen, payload: ask.payload };
  const me = chosen.members.find((m) => m.phone === phone)!;
  return { kind: "shown", text: `${groupName(chosen, phone)}:\n${cartSummary(pendingItems(chosen.id), chosen, me.id)}` };
}

/** "personal", "mine", "sam", "sam's", "sam's household": exactly one group must match. */
function byName(groups: Household[], t: string, phone: string): Household | undefined {
  const words = t.replace(/'s\b/g, "").replace(/\b(?:the|household|house|group|list|one)\b/g, "").trim();
  if (!words) return undefined;
  const hits = groups.filter((h) => {
    if (h.kind === "personal") return /^(?:personal|my personal|mine|just me|me)$/.test(words);
    const owner = h.members.find((m) => m.id === h.ownerId);
    // Its own name, as typed ("we da fam") or with the same filler words dropped ("maple" for "Maple House").
    const own = h.name?.toLowerCase();
    if (own && (own === t || own.replace(/'s\b/g, "").replace(/\b(?:the|household|house|group|list|one)\b/g, "").replace(/\s+/g, " ").trim() === words)) return true;
    if (owner?.phone === phone && /^(?:my|mine|our)$/.test(words)) return true;
    return !!owner && (owner.name.toLowerCase() === words || owner.name.toLowerCase().split(/\s+/)[0] === words);
  });
  return hits.length === 1 ? hits[0] : undefined;
}
