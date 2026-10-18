// What "order now" is about to buy, shown before anything is charged: which cart, and who pays
// for what (everyone, just one person, or a few people). Display only: the real split is computed by
// computeShares when the order is placed, in integer cents.
import { pendingItems } from "../core/store.js";
import type { Household, Item } from "../types.js";
import { payersOf } from "./splitWith.js";
import { fmt } from "./templates.js";
import { groupName } from "./whichList.js";

/**
 * "Amber's household (Amber and you)", or "your personal list", for the middle of a sentence. `short` drops the
 * member list ("Amber's household"), for replies that already have their own parentheses.
 */
export function cartName(household: Household, phone: string, { short = false } = {}): string {
  if (household.kind === "personal") return "your personal list";
  const name = groupName(household, phone).replace(/^Your /, "your ");
  return short ? name.replace(/\s*\(.*\)$/, "") : name;
}

/** The items "order now" would buy: pending, and not waiting for someone's approval. */
export function readyItems(household: Household): Item[] {
  return pendingItems(household.id).filter((i) => !i.needsApproval);
}

/**
 * "Order for Amber's household (Amber and you)? 3 items, $19.86.
 *  Shared (everyone): Paper towels $9.99
 *  Personal (just you): Paper plates $5.38
 *  Split (you and Amber): Oat milk $4.49
 *  Reply "yes" to order or "no" to cancel."
 */
export function orderPreview(household: Household, viewerId: string, viewerPhone: string): string {
  const items = readyItems(household);
  const total = items.reduce((sum, i) => sum + i.cents, 0);
  const everyone = household.members.length;
  const nameOf = (id: string) => (id === viewerId ? "you" : household.members.find((m) => m.id === id)?.name ?? "someone");
  const and = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

  // Group items by who pays, in a fixed order: shared, then personal (you first), then splits.
  const groups = new Map<string, { label: string; rank: number; lines: string[] }>();
  for (const item of items) {
    const payers = payersOf(item, household).map((m) => m.id);
    const ids = [...payers].sort((a, b) => (a === viewerId ? -1 : b === viewerId ? 1 : 0));
    const key = [...payers].sort().join(",");
    const label =
      household.kind === "personal" ? "Yours"
      : payers.length >= everyone ? "Shared (everyone)"
      : payers.length === 1 ? `Personal (${ids[0] === viewerId ? "just you" : nameOf(ids[0]!)})`
      : `Split (${and(ids.map(nameOf))})`;
    const rank = label.startsWith("Shared") ? 0 : label === "Personal (just you)" ? 1 : label.startsWith("Personal") ? 2 : 3;
    const g = groups.get(key) ?? { label, rank, lines: [] };
    g.lines.push(`${item.name} ${fmt(item.cents)}`);
    groups.set(key, g);
  }
  const body = [...groups.values()].sort((a, b) => a.rank - b.rank).map((g) => `${g.label}: ${g.lines.join("; ")}`);
  const waiting = pendingItems(household.id).filter((i) => i.needsApproval);
  const held = waiting.length ? [`Waiting for approval, not included: ${waiting.map((i) => i.name).join(", ")}`] : [];
  const count = `${items.length} item${items.length === 1 ? "" : "s"}`;
  return [`Order for ${cartName(household, viewerPhone)}? ${count}, ${fmt(total)}.`, ...body, ...held, 'Reply "yes" to order or "no" to cancel.'].join("\n");
}

/**
 * "order now" when the budget owner has no card yet. Nothing is charged and the cart stays; the owner gets a
 * private link (sent by the caller). `toOwner`: the person asking is the owner.
 */
export function ownerCardWait(household: Household, ownerName: string, viewerPhone: string, toOwner: boolean): string {
  if (toOwner) return ""; // the owner gets the add-card link itself instead
  return (
    `I can't order for ${cartName(household, viewerPhone)} yet. ${ownerName} is the budget owner, and their card has to be on file ` +
    `because it covers anyone without a card. I've texted ${ownerName} a secure link to add one. ` +
    `Nothing was charged and the cart is saved: text "order now" again once ${ownerName} has added it.`
  );
}
