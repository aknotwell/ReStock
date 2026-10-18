// Owner: Person 2. In-memory store so everyone can build against it today.
// TODO(P2): swap for SQLite/Postgres behind the same functions.
import { randomUUID } from "node:crypto";
import type { Debt, Household, Item, Member, Order, Charge } from "../types.js";

export const db = {
  households: new Map<string, Household>(),
  items: new Map<string, Item>(),
  orders: new Map<string, Order>(),
  charges: [] as Charge[],
  debts: new Map<string, Debt>(),
};

export const newId = () => randomUUID();

/** groupChatId placeholder until the household's real group chat is seen. */
export const UNBOUND_GROUP = "unbound";

export function getHousehold(id: string): Household {
  const h = db.households.get(id);
  if (!h) throw new Error(`Unknown household ${id}`);
  return h;
}

export function findHouseholdByGroupChat(groupChatId: string): Household | undefined {
  for (const h of db.households.values()) if (h.groupChatId === groupChatId) return h;
  return undefined;
}

export function findMember(memberId: string): { household: Household; member: Member } | undefined {
  for (const household of db.households.values()) {
    const member = household.members.find((m) => m.id === memberId);
    if (member) return { household, member };
  }
  return undefined;
}

export function findMemberByPhone(household: Household, phone: string): Member | undefined {
  return household.members.find((m) => m.phone === phone);
}

/** All households this phone/handle belongs to. */
export function householdsForPhone(phone: string): Household[] {
  return [...db.households.values()].filter((h) => h.members.some((m) => m.phone === phone));
}

export function pendingItems(householdId: string): Item[] {
  return [...db.items.values()].filter((i) => i.householdId === householdId && i.status === "pending");
}

export function addItem(item: Omit<Item, "id" | "status">): Item {
  const full: Item = { ...item, id: newId(), status: "pending" };
  db.items.set(full.id, full);
  return full;
}

export function resetStore(): void {
  db.households.clear();
  db.items.clear();
  db.orders.clear();
  db.charges.length = 0;
  db.debts.clear();
}
