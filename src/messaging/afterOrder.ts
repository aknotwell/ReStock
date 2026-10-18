// Owner: Person 1. Private texts after "order now": a receipt for everyone charged on their own card,
// and a "you owe" text (pay-back link + add-card link) for members the owner's card covered.
import type { Household, OrderResult } from "../types.js";
import { createCardSetupLink, createPayBackLink, openDebtsBetween } from "../payments/links.js";
import { sendPrivate } from "./photon.js";
import { memberReceipt, ownerReceipt, youOwe } from "./templates.js";

/**
 * Sends each member's private text. One member failing never stops the others. Returns the names of
 * members whose text is being held until they DM the agent, so the sender can be told who to nudge.
 */
export async function sendOrderTexts(household: Household, result: OrderResult): Promise<{ waiting: string[] }> {
  const waiting: string[] = [];
  const owner = household.members.find((m) => m.id === household.ownerId);
  if (!owner) return { waiting };
  const key = (memberId: string) => `order:${result.order.id}:${memberId}`;
  const coveredForOthers = result.debts.filter((d) => d.creditorId === owner.id).reduce((s, d) => s + d.cents, 0);

  for (const member of household.members) {
    try {
      const share = result.shares[member.id] ?? 0;
      let text: string | undefined;
      if (member.id === owner.id) {
        if (share > 0 || coveredForOthers > 0) text = ownerReceipt(owner, share, coveredForOthers);
      } else if (share > 0) {
        const debt = result.debts.find((d) => d.debtorId === member.id);
        if (debt) {
          const [payLink, cardLink] = await Promise.all([createPayBackLink(debt.id), createCardSetupLink(member.id)]);
          const totalOwed = openDebtsBetween(member.id, owner.id).reduce((sum, d) => sum + d.cents, 0);
          text = youOwe(owner, debt.cents, payLink, cardLink, totalOwed);
        } else {
          text = memberReceipt(member, share);
        }
      }
      if (text && (await sendPrivate(member.id, text, key(member.id))) === "queued") waiting.push(member.name);
    } catch (err) {
      console.error(`order text to ${member.name} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { waiting };
}
