// Owner: Person 3. Owner card gate: no order until the budget owner has a card on file.
// Members without a card are covered by the owner's card, so ordering without it is never safe.
import type { Household, Member } from "../types.js";
import { createCardSetupLink } from "./links.js";

export class OwnerCardRequiredError extends Error {
  constructor(readonly owner: Member | undefined) {
    super(owner ? `${owner.name} needs to add a card before I can order.` : "This household has no budget owner yet.");
    this.name = "OwnerCardRequiredError";
  }
}

export function findOwner(household: Household): Member | undefined {
  return household.members.find((m) => m.id === household.ownerId);
}

export function ownerHasCard(household: Household): boolean {
  return Boolean(findOwner(household)?.paymentMethodId);
}

/** Throws OwnerCardRequiredError unless the owner has a card on file. */
export function assertOwnerCard(household: Household): void {
  if (!ownerHasCard(household)) throw new OwnerCardRequiredError(findOwner(household));
}

/**
 * The texts to send when "order now" hits the gate: a short note in the group chat, and a private
 * message to the owner with a secure add-card link. The link goes only to the owner, never the group.
 */
export async function ownerCardRequest(
  household: Household,
): Promise<{ groupText: string; ownerId?: string; ownerText?: string }> {
  const owner = findOwner(household);
  if (!owner) return { groupText: "This household has no budget owner yet, so I can't place orders." };
  const link = await createCardSetupLink(owner.id);
  return {
    groupText: `${owner.name} needs to add a card before I can order. ${owner.name}, I've texted you a secure link.`,
    ownerId: owner.id,
    ownerText: `You're the budget owner, so I need your card before I can place the order. Add it securely here (I never see the number): ${link}\nThen text "order now" again.`,
  };
}
