// Owner: Person 2. Deterministic money math — never the LLM.
import type { Cents, Item, Member, MemberId, Shares, SplitRule } from "../types.js";

/** One item's part of one member's share. `splitWays` is 1 for an item that's all theirs. */
export type ShareLine = { itemId: string; name: string; cents: Cents; splitWays: number };

/**
 * Each member's share, item by item, in integer cents. computeShares is the sum of these lines,
 * so receipts that list items always add up to what was charged.
 *
 * - smart: shared items split evenly across all members, personal items to whoever added them,
 *          and items with `splitWith` split evenly between exactly those members
 * - even:  every item split evenly
 * - adder: every item to whoever added it
 *
 * Even splits are done per item; remainder cents go one each to the first
 * members in `members` order. Shares must always sum to the item total.
 */
export function computeShareLines(items: Item[], members: Member[], rule: SplitRule): Record<MemberId, ShareLine[]> {
  if (members.length === 0) throw new Error("computeShares: a household needs at least one member");

  const lines: Record<MemberId, ShareLine[]> = {};
  for (const m of members) lines[m.id] = [];

  for (const item of items) {
    if (!Number.isInteger(item.cents) || item.cents < 0) {
      throw new Error(`computeShares: ${item.name} has an invalid price (${item.cents}); prices are whole cents`);
    }
    // smart: an item split between some people goes to exactly them (anyone who left is skipped).
    const group = rule === "smart" && item.splitWith?.length ? members.filter((m) => item.splitWith!.includes(m.id)) : [];
    const toAdder = !group.length && (rule === "adder" || (rule === "smart" && !item.shared));
    // An item added by someone no longer in the household is split evenly rather than dropped.
    if (toAdder && item.addedBy in lines) {
      lines[item.addedBy]!.push({ itemId: item.id, name: item.name, cents: item.cents, splitWays: 1 });
      continue;
    }
    const payers = group.length ? group : members;
    const base = Math.floor(item.cents / payers.length);
    const remainder = item.cents - base * payers.length;
    payers.forEach((m, i) => {
      const cents = base + (i < remainder ? 1 : 0);
      lines[m.id]!.push({ itemId: item.id, name: item.name, cents, splitWays: payers.length });
    });
  }
  return lines;
}

/** Split an order into per-member shares in integer cents (the sum of computeShareLines). */
export function computeShares(items: Item[], members: Member[], rule: SplitRule): Shares {
  const lines = computeShareLines(items, members, rule);
  const shares: Shares = {};
  for (const m of members) shares[m.id] = lines[m.id]!.reduce((sum, l) => sum + l.cents, 0);
  return shares;
}
