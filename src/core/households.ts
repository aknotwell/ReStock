// Creating households and managing members.
// Membership is security-sensitive (it decides who shares a bill), so it's plain code: never the LLM.
// The persistence layer saves these changes automatically (src/core/persist.ts).
import type { Cents, Household, Member } from "../types.js";
import { registerState } from "./persist.js";
import { db, householdsForPhone, newId, UNBOUND_GROUP } from "./store.js";
import { openDebtsFor, owedTo } from "./ledger.js";

export const DEFAULT_BUDGET_CENTS = 20000;

export class MembershipError extends Error {}

/** E.164 for US numbers typed loosely ("425-829-9688", "(425) 829 9688", "+1 425…"); undefined if it isn't a phone. */
export function normalizePhone(raw: string): string | undefined {
  const hasPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!hasPlus && digits.length === 10) return `+1${digits}`;
  if (!hasPlus && digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (hasPlus && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return undefined;
}

export function cleanName(raw: string): string | undefined {
  const name = raw.trim().replace(/\s+/g, " ");
  return /^[\p{L}][\p{L}'. -]{0,29}$/u.test(name) ? name : undefined;
}

export function memberId(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "member";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** A phone can be in a few households at once (roommates, family, a team) plus a personal space. */
export const MAX_SPACES_PER_PHONE = 5;

export const TOO_MANY_SPACES =
  `That number is already in ${MAX_SPACES_PER_PHONE} Restock households, the most one number can be in. ` +
  'Leave one first: text "switch to <household>", then "leave household".';

export const atSpaceLimit = (phone: string) => householdsForPhone(phone).length >= MAX_SPACES_PER_PHONE;

/** What members call a household: its own name, or "<owner>'s household". */
export function householdName(household: Household): string {
  if (household.name) return household.name;
  if (household.kind === "personal") return "Personal";
  return `${household.members.find((m) => m.id === household.ownerId)?.name ?? "Your"}'s household`;
}

/** "Maple House", "Apt 4B", "Garcia Family"; undefined if it isn't a plain short name. */
export function cleanHouseholdName(raw: string): string | undefined {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}'&. -]{0,29}$/u.test(name)) return undefined;
  return /^personal$/i.test(name) ? undefined : name; // "Personal" is the personal space's name
}

// ---------- Which household one-on-one texts go to ----------
// A group chat always knows its household. One-on-one texts go to the person's active household: the one
// they last started, joined or switched to ("switch to Maple House"). Saved with the store.
const active = new Map<string, string>(); // phone -> householdId
registerState("activeHouseholds", {
  dump: () => [...active],
  load: (data) => {
    active.clear();
    for (const [phone, id] of data as [string, string][]) active.set(phone, id);
  },
});

export function setActiveHousehold(phone: string, householdId: string): void {
  active.set(phone, householdId);
}

/** The household this phone's one-on-one texts go to. With none chosen: their personal space, else their first. */
export function activeHousehold(phone: string): Household | undefined {
  const mine = householdsForPhone(phone);
  const chosen = mine.find((h) => h.id === active.get(phone));
  return chosen ?? mine.find((h) => h.kind === "personal") ?? mine[0];
}

/** "Maple House", "maple", or "2" (its number in the "households" list): one of this phone's households. */
export function findMyHousehold(phone: string, query: string): Household | undefined {
  const mine = householdsForPhone(phone);
  const q = query.trim().toLowerCase().replace(/^(?:the|my|our)\s+/, "").replace(/\s+(?:household|group)$/, "");
  if (/^\d$/.test(q)) return mine[Number(q) - 1];
  const named = (h: Household) => householdName(h).toLowerCase();
  return mine.find((h) => named(h) === q || named(h) === `${q}'s household`) ?? (q.length >= 3 ? mine.find((h) => named(h).includes(q)) : undefined);
}

/** The person's own name, from any household they're in (so starting or joining another doesn't ask again). */
export const knownName = (phone: string) => householdsForPhone(phone).flatMap((h) => h.members).find((m) => m.phone === phone)?.name;

export const allMemberIds = () => new Set([...db.households.values()].flatMap((h) => h.members.map((m) => m.id)));

export type NewHousehold = { name?: string; groupType?: Household["groupType"]; budgetCents?: Cents | null };

/** Start a group household with this person as its budget owner. It becomes their active household. */
export function createHousehold(ownerName: string, ownerPhone: string, options: NewHousehold = {}): Household {
  if (atSpaceLimit(ownerPhone)) throw new MembershipError(TOO_MANY_SPACES);
  const mine = householdsForPhone(ownerPhone);
  if (options.name && mine.some((h) => householdName(h).toLowerCase() === options.name!.toLowerCase())) {
    throw new MembershipError(`You already have a household called ${options.name}. Pick another name.`);
  }
  const owner: Member = { id: memberId(ownerName, allMemberIds()), name: ownerName, phone: ownerPhone, role: "owner" };
  const budget = options.budgetCents === undefined ? DEFAULT_BUDGET_CENTS : options.budgetCents;
  const household: Household = {
    id: newId(),
    kind: "group",
    ...(options.name ? { name: options.name } : {}),
    ...(options.groupType ? { groupType: options.groupType } : {}),
    groupChatId: UNBOUND_GROUP,
    ownerId: owner.id,
    ...(budget === null ? {} : { budgetCents: budget }),
    spentCents: 0,
    members: [owner],
  };
  db.households.set(household.id, household);
  setActiveHousehold(ownerPhone, household.id);
  return household;
}

/** Add someone to a household. It becomes their active household. */
export function addMember(household: Household, name: string, phone: string): Member {
  checkCanJoin(household, name, phone);
  // Same rule as joining in a group chat: everyone can approve requests, except in a family (only the owner).
  const member: Member = { id: memberId(name, allMemberIds()), name, phone, role: "member", ...(household.groupType === "family" ? {} : { canApprove: true }) };
  household.members.push(member);
  setActiveHousehold(phone, household.id);
  return member;
}

/** Throws MembershipError if this person can't join this household (used when inviting and when they join). */
export function checkCanJoin(household: Household, name: string, phone: string): void {
  if (household.members.length >= 9) throw new MembershipError("A household can have up to 9 people.");
  if (household.members.some((m) => m.phone === phone)) throw new MembershipError(`That number is already in ${householdName(household)}.`);
  if (atSpaceLimit(phone)) {
    throw new MembershipError(`That number is already in ${MAX_SPACES_PER_PHONE} Restock households, the most one number can be in.`);
  }
  if (household.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
    throw new MembershipError(`There's already a ${name} in your household. Use a different name, like "${name} B".`);
  }
}

export function removeMember(household: Household, name: string): Member {
  const member = household.members.find((m) => m.name.toLowerCase() === name.trim().toLowerCase());
  if (!member) throw new MembershipError(`I couldn't find ${name.trim()} in your household.`);
  if (member.id === household.ownerId) throw new MembershipError("The budget owner can't be removed.");
  if (openDebtsFor(member.id).length || owedTo(member.id).length) {
    throw new MembershipError(`${member.name} still has an open balance. Settle up first, then remove them.`);
  }
  household.members = household.members.filter((m) => m.id !== member.id);
  return member;
}

/** The first real phone number written anywhere in a message, e.g. "her number is 425 555 0123". */
export function findPhone(text: string): { raw: string; phone: string } | undefined {
  for (const m of text.matchAll(/\+?\(?\d[\d\s().-]{8,18}\d/g)) {
    const raw = m[0].trim();
    const phone = normalizePhone(raw);
    if (phone && raw.replace(/\D/g, "").length >= 10) return { raw, phone };
  }
  return undefined;
}

/** Delete a household and its pending cart (owner leaving with nobody else in it). Orders/charges stay as records. */
export function deleteHousehold(household: Household): void {
  for (const [id, item] of db.items) if (item.householdId === household.id && item.status === "pending") db.items.delete(id);
  db.households.delete(household.id);
}
