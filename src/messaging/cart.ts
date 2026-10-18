// Owner: Person 1. "shopping list" / "cart": what's waiting for the next order, built in code (no AI).
import { approverNames } from "../core/approvals.js";
import type { Household, Item } from "../types.js";
import { describeParts } from "./splitWith.js";
import { fmt } from "./templates.js";

/** Most item lines in one text; the rest are summed into one "…and N more" line. */
export const MAX_CART_LINES = 12;

/**
 * "In the cart (2 items):\n• Dish soap, 3 pack, $8.49, split with everyone\n…\nTotal: $13.28. Text "order now" to check out."
 * Items waiting for approval are marked and left out of the total, since the order skips them until approved.
 * `viewerId` is who reads it, so their items say "yours".
 */
export function cartSummary(items: Item[], household: Household, viewerId?: string): string {
  if (items.length === 0) return 'The cart is empty. Text what you need ("we\'re out of TP") and I\'ll add it.';
  const line = (i: Item) => {
    const waits = i.needsApproval ? ` (waiting for ${approverNames(household, i.addedBy)}'s OK)` : "";
    return `\n• ${i.name}, ${fmt(i.cents)}, ${describeParts(i, household, viewerId)}${waits}`;
  };
  const shown = items.slice(0, MAX_CART_LINES).map(line);
  const rest = items.slice(MAX_CART_LINES);
  if (rest.length) shown.push(`\n• …and ${rest.length} more item${rest.length === 1 ? "" : "s"}, ${fmt(rest.reduce((s, i) => s + i.cents, 0))}`);

  const ready = items.filter((i) => !i.needsApproval);
  const total = fmt(ready.reduce((sum, i) => sum + i.cents, 0));
  const waiting = items.length - ready.length;
  const footer = ready.length
    ? `Total: ${total}${waiting ? ` (not counting ${waiting} waiting for approval)` : ""}. Text "order now" to check out.`
    : "Nothing is ready to order until it's approved.";
  return `In the cart (${items.length} item${items.length === 1 ? "" : "s"}):${shown.join("")}\n${footer}`;
}
