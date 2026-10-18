// Owner: Person 4. What the dashboard may show a logged-in member: their own household, read-only.
// Never phone numbers, and other members' cards only as "has a card" (last 4 digits are yours alone).
import { computeShares } from "../core/split.js";
import { db, findMember, pendingItems } from "../core/store.js";
import type { Member } from "../types.js";

export type HouseholdView = {
  me: { id: string; name: string; role: Member["role"]; cardLast4: string | null };
  household: { name: string; budgetCents: number | null; spentCents: number; approvalOverCents: number | null };
  members: { id: string; name: string; role: Member["role"]; hasCard: boolean; isMe: boolean }[];
  items: { id: string; name: string; cents: number; shared: boolean; addedBy: string; needsApproval: boolean }[];
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
    me: { id: me.id, name: me.name, role: me.role, cardLast4: me.paymentMethodId ? (me.cardLast4 ?? null) : null },
    household: { name: `${owner?.name ?? "Your"}'s household`, budgetCents: household.budgetCents ?? null, spentCents: household.spentCents, approvalOverCents: household.approvalOverCents ?? null },
    members: household.members.map((m) => ({ id: m.id, name: m.name, role: m.role, hasCard: !!m.paymentMethodId, isMe: m.id === me.id })),
    items: items.map((i) => ({ id: i.id, name: i.name, cents: i.cents, shared: i.shared, addedBy: nameOf(i.addedBy), needsApproval: !!i.needsApproval })),
    sharesIfOrderedNow: Object.fromEntries(Object.entries(shares).map(([id, cents]) => [nameOf(id), cents])),
    openDebts: [...db.debts.values()]
      .filter((d) => d.status === "open" && inHousehold.has(d.debtorId))
      .map((d) => ({ from: nameOf(d.debtorId), to: nameOf(d.creditorId), cents: d.cents })),
  };
}
