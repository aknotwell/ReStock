// Owner: Person 2. Deterministic money math — never the LLM.
import type { Cents, Item, Member, Shares, SplitRule } from "../types.js";

/**
 * Split an order into per-member shares in integer cents.
 *
 * - smart: shared items split evenly across all members, personal items to whoever added them
 * - even:  every item split evenly
 * - adder: every item to whoever added it
 *
 * Even splits are done per item; remainder cents go one each to the first
 * members in `members` order. Shares must always sum to the item total.
 */
export function computeShares(items: Item[], members: Member[], rule: SplitRule): Shares {
  if (members.length === 0) throw new Error("computeShares: a household needs at least one member");

  const shares: Shares = {};
  for (const m of members) shares[m.id] = 0;

  const splitEvenly = (cents: Cents) => {
    const base = Math.floor(cents / members.length);
    const remainder = cents - base * members.length;
    members.forEach((m, i) => {
      shares[m.id]! += base + (i < remainder ? 1 : 0);
    });
  };

  for (const item of items) {
    if (!Number.isInteger(item.cents) || item.cents < 0) {
      throw new Error(`computeShares: ${item.name} has an invalid price (${item.cents}); prices are whole cents`);
    }
    const toAdder = rule === "adder" || (rule === "smart" && !item.shared);
    // An item added by someone no longer in the household is split evenly rather than dropped.
    if (toAdder && item.addedBy in shares) shares[item.addedBy]! += item.cents;
    else splitEvenly(item.cents);
  }
  return shares;
}
