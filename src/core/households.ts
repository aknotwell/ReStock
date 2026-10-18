// Owner: Person 2 (store) / Person 1 (chat). Creating households and managing members.
// Membership is security-sensitive (it decides who shares a bill), so it's plain code: never the LLM.
// The persistence layer saves these changes automatically (src/core/persist.ts).
import type { Household, Member } from "../types.js";
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

/** A personal space doesn't count: someone can have their own space and be in a group. */
export const inAGroup = (phone: string) => householdsForPhone(phone).some((h) => h.kind !== "personal");

export const allMemberIds = () => new Set([...db.households.values()].flatMap((h) => h.members.map((m) => m.id)));

export function createHousehold(ownerName: string, ownerPhone: string): Household {
  if (inAGroup(ownerPhone)) throw new MembershipError("You're already in a household.");
  const owner: Member = { id: memberId(ownerName, allMemberIds()), name: ownerName, phone: ownerPhone, role: "owner" };
  const household: Household = {
    id: newId(),
    groupChatId: UNBOUND_GROUP,
    ownerId: owner.id,
    budgetCents: DEFAULT_BUDGET_CENTS,
    spentCents: 0,
    members: [owner],
  };
  db.households.set(household.id, household);
  return household;
}

export function addMember(household: Household, name: string, phone: string): Member {
  if (household.members.length >= 9) throw new MembershipError("A household can have up to 9 people.");
  if (inAGroup(phone)) throw new MembershipError("That number is already in a household.");
  if (household.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
    throw new MembershipError(`There's already a ${name} in your household. Use a different name, like "${name} B".`);
  }
  const member: Member = { id: memberId(name, allMemberIds()), name, phone, role: "member" };
  household.members.push(member);
  return member;
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
