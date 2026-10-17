// Owner: Person 2. Deterministic money math — never the LLM.
import type { Item, Member, Shares, SplitRule } from "../types.js";

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
  // TODO(P2): implement. Tests in test/split.test.ts describe the expected behavior.
  void items;
  void members;
  void rule;
  throw new Error("computeShares not implemented");
}
