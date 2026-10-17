// Owner: Person 1. Private texts after "order now": a receipt for everyone charged on their own card,
// and a "you owe" text (pay-back link + add-card link) for members the owner's card covered.
import type { Household, OrderResult } from "../types.js";
import { createCardSetupLink, createPayBackLink } from "../payments/links.js";
import { sendPrivate } from "./photon.js";
import { memberReceipt, ownerReceipt, youOwe } from "./templates.js";

export async function sendOrderTexts(household: Household, result: OrderResult): Promise<void> {
  const owner = household.members.find((m) => m.id === household.ownerId);
  if (!owner) return;
  const key = (memberId: string) => `order:${result.order.id}:${memberId}`;
  const coveredForOthers = result.debts.filter((d) => d.creditorId === owner.id).reduce((s, d) => s + d.cents, 0);

  for (const member of household.members) {
    const share = result.shares[member.id] ?? 0;
    if (member.id === owner.id) {
      if (share > 0 || coveredForOthers > 0) await sendPrivate(member.id, ownerReceipt(owner, share, coveredForOthers), key(member.id));
      continue;
    }
    if (share <= 0) continue;
    const debt = result.debts.find((d) => d.debtorId === member.id);
    if (debt) {
      const [payLink, cardLink] = await Promise.all([createPayBackLink(debt.id), createCardSetupLink(member.id)]);
      await sendPrivate(member.id, youOwe(owner, debt.cents, payLink, cardLink), key(member.id));
    } else {
      await sendPrivate(member.id, memberReceipt(member, share), key(member.id));
    }
  }
}
