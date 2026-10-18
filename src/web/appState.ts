// What the dashboard may show a logged-in member: their own household, read-only.
// Never phone numbers, and other members' cards only as "has a card" (last 4 digits are yours alone).
import { computeShares } from "../core/split.js";
import { db, findMember, householdsForPhone, pendingItems } from "../core/store.js";
import { householdName } from "../core/households.js";
import type { Household, Member } from "../types.js";

export type HouseholdView = {
  id: string; // the household's id, so the dashboard can tell your households apart
  me: { id: string; name: string; role: Member["role"]; cardLast4: string | null };
  household: {
    name: string;
    kind: "personal" | "group";
    groupType: Household["groupType"] | null;
    budgetCents: number | null;
    spentCents: number;
    approvalOverCents: number | null;
  };
  members: { id: string; name: string; role: Member["role"]; hasCard: boolean; canApprove: boolean; isMe: boolean }[];
  items: { id: string; name: string; cents: number; shared: boolean; splitWith: string[] | null; addedBy: string; needsApproval: boolean }[]; // splitWith: names, when it's split between some people
  sharesIfOrderedNow: Record<string, number>; // member name -> cents
  openDebts: { from: string; to: string; cents: number }[];
};

export function householdView(me: Member): HouseholdView | undefined {
  const found = findMember(me.id);
  if (!found) return undefined;
  const { household } = found;
  const nameOf = (id: string) => household.members.find((m) => m.id === id)?.name ?? "Former member";
  const owner = household.members.find((m) => m.id === household.ownerId);
  const items = pendingItems(household.id);
  const ready = items.filter((i) => !i.needsApproval);
  const shares: Record<string, number> = ready.length ? computeShares(ready, household.members, "smart") : {};
  const inHousehold = new Set(household.members.map((m) => m.id));

  return {
    id: household.id,
    me: { id: me.id, name: me.name, role: me.role, cardLast4: me.paymentMethodId ? (me.cardLast4 ?? null) : null },
    household: {
      name: householdName(household),
      kind: household.kind ?? "group",
      groupType: household.groupType ?? null,
      budgetCents: household.budgetCents ?? null,
      spentCents: household.spentCents,
      approvalOverCents: household.approvalOverCents ?? null,
    },
    members: household.members.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      hasCard: !!m.paymentMethodId,
      canApprove: m.id === household.ownerId || m.canApprove === true,
      isMe: m.id === me.id,
    })),
    items: items.map((i) => ({ id: i.id, name: i.name, cents: i.cents, shared: i.shared, splitWith: i.splitWith?.length ? i.splitWith.map(nameOf) : null, addedBy: nameOf(i.addedBy), needsApproval: !!i.needsApproval })),
    sharesIfOrderedNow: Object.fromEntries(Object.entries(shares).map(([id, cents]) => [nameOf(id), cents])),
    openDebts: [...db.debts.values()]
      .filter((d) => d.status === "open" && inHousehold.has(d.debtorId))
      .map((d) => ({ from: nameOf(d.debtorId), to: nameOf(d.creditorId), cents: d.cents })),
  };
}

/**
 * Every space the logged-in person is in: their personal space and their group, if they have both.
 * Each one is their own member record there (same phone), so it's still only their own data.
 */
export function spacesView(me: Member): HouseholdView[] {
  return householdsForPhone(me.phone)
    .map((h) => h.members.find((m) => m.phone === me.phone))
    .filter((m): m is Member => !!m)
    .map((m) => householdView(m))
    .filter((v): v is HouseholdView => !!v);
}

/** The logged-in person's own member record with this id, or undefined if it isn't theirs. */
export function ownRecord(me: Member, memberId: string): Member | undefined {
  return householdsForPhone(me.phone).flatMap((h) => h.members).find((m) => m.id === memberId && m.phone === me.phone);
}
