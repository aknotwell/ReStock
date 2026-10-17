// Person 1 adapter over Person 2's current in-memory store.
// TODO(P2): move these mutations behind transactional store methods when persistence lands.
import { createHash } from "node:crypto";
import { addItem, db, pendingItems } from "../core/store.js";
import type { Household, Item, Member } from "../types.js";
import { linePrice, matchProducts, normalize, type Product } from "../ai/catalog.js";
import { fmt } from "./templates.js";

export const PERSONAL_APPROVAL_CENTS = 2500;
export const cartTotal = (items: Item[]): number => items.reduce((total, item) => total + item.cents, 0);
export const itemVersion = (item: Item): string => JSON.stringify([item.id, item.name, item.cents, item.shared, item.addedBy, item.needsApproval]);
export function cartVersion(household: Household): string {
  return createHash("sha256").update(JSON.stringify({
    items: pendingItems(household.id).map(itemVersion),
    members: household.members.map((m) => m.id),
    owner: household.ownerId, budget: household.budgetCents, spent: household.spentCents,
  })).digest("hex");
}

export function cartText(household: Household): string {
  const items = pendingItems(household.id);
  if (!items.length) return "Your cart is empty. Try ‘add dish soap’.";
  return `Demo cart (simulated fulfillment):\n${items.map((i) => `${i.name} — ${fmt(i.cents)}, ${i.shared ? "shared" : "personal"}${i.needsApproval ? " (owner approval needed)" : ""}`).join("\n")}\nTotal: ${fmt(cartTotal(items))}. Shared items split evenly; personal items paid by whoever added them. Reply ‘order now’ to request test checkout, or ‘remove <item>’ to change.`;
}

export function addCatalogItem(h: Household, member: Member, product: Product, quantity: number, shared: boolean): Item {
  const cents = linePrice(product, quantity);
  return addItem({ householdId: h.id, name: quantity === 1 ? product.name : `${quantity} × ${product.name}`,
    addedBy: member.id, cents, shared, needsApproval: !shared && cents > PERSONAL_APPROVAL_CENTS });
}

export function findCartItems(h: Household, query: string | null, lastId?: string): Item[] {
  const items = pendingItems(h.id);
  if (!query || /^(it|that|this)$/.test(normalize(query))) return items.filter((i) => i.id === lastId);
  const product = matchProducts(query).exact;
  const needle = normalize(product?.name ?? query);
  const exact = items.filter((i) => normalize(i.name) === needle);
  return exact.length ? exact : items.filter((i) => normalize(i.name).includes(needle));
}

export function canEdit(h: Household, member: Member, item: Item): boolean {
  return member.id === h.ownerId || member.id === item.addedBy;
}
export function removeCartItem(item: Item): void { db.items.delete(item.id); }
export function classifyItem(item: Item, shared: boolean): void {
  if (item.shared === shared) return;
  item.shared = shared;
  item.needsApproval = !shared && item.cents > PERSONAL_APPROVAL_CENTS;
}
