// Who can say "yes" to items, and which items have to wait for one. Deterministic, never the LLM.
//
// - The owner can always approve. Other members can approve only when the owner allows it
//   (roommates: usually everyone; a family: parents, not kids).
// - Items added by someone who can't approve wait for an approver's "yes".
// - Items over the household's approvalOverCents wait even when an approver added them,
//   and the person who added one can't approve it themselves (the owner excepted).
import type { Cents, Household, Item, Member } from "../types.js";

export function canApprove(household: Household, member: Member): boolean {
  return member.id === household.ownerId || member.canApprove === true;
}

export function approvers(household: Household): Member[] {
  return household.members.filter((m) => canApprove(household, m));
}

export function needsApproval(household: Household, addedBy: Member, cents: Cents): boolean {
  if (!canApprove(household, addedBy)) return true;
  const over = household.approvalOverCents;
  return addedBy.id !== household.ownerId && over !== undefined && cents > over;
}

/** Items waiting on a "yes" that this member is allowed to give. */
export function approvableBy(household: Household, member: Member, waiting: Item[]): Item[] {
  if (!canApprove(household, member)) return [];
  if (member.id === household.ownerId) return waiting;
  return waiting.filter((i) => i.addedBy !== member.id);
}

/** "Sam", "Sam or Jake", "Sam, Jake or Priya" — everyone who could approve, minus `except`. */
export function approverNames(household: Household, except?: string): string {
  const names = approvers(household).filter((m) => m.id !== except).map((m) => m.name);
  if (names.length <= 1) return names[0] ?? "the budget owner";
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}
