// Owner: Person 1. Wording follows the design note (PLAN.md).
import type { Cents, Household, Member, OrderResult, SplitRule } from "../types.js";

export const fmt = (c: Cents) => `$${(c / 100).toFixed(2)}`;

const ruleText: Record<SplitRule, string> = {
  smart: "shared items split evenly, personal items paid by whoever added them",
  even: "split evenly",
  adder: "each person pays for what they added",
};

export function groupSummary(h: Household, r: OrderResult): string {
  const lines = h.members.map((m) => `${m.name} ${fmt(r.shares[m.id] ?? 0)}`).join(" · ");
  const left = h.budgetCents - h.spentCents;
  return `Ordered! ${r.items.length} items, ${fmt(r.order.totalCents)}, ${ruleText[r.order.rule]}.\n${lines}\nArrives ${r.order.eta ?? "soon"}. Household budget left: ${fmt(left)}`;
}

export function ownerReceipt(owner: Member, share: Cents, coveredForOthers: Cents): string {
  let t = `Receipt: your share is ${fmt(share)}, charged to your Visa ending ${owner.cardLast4 ?? "????"}.`;
  if (coveredForOthers > 0) {
    t += `\nYour card also covered ${fmt(coveredForOthers)} for roommates without a card. I'll remind them to pay you back.`;
  }
  return t;
}

export function memberReceipt(member: Member, share: Cents): string {
  return `Receipt: your share is ${fmt(share)}, charged to your card ending ${member.cardLast4 ?? "????"}.`;
}

export function youOwe(owner: Member, share: Cents, payLink: string, cardLink: string): string {
  return `Your share of this week's order is ${fmt(share)}. ${owner.name}'s card covered it.\nPay ${owner.name} back: ${payLink}\nOr add a card so it's paid automatically next time: ${cardLink}`;
}

export function helpMessage(): string {
  return [
    "I'm Restock, an AI assistant for this household. I'm not a person.",
    "Text what you need (\"we're out of TP\") and I'll add it to the cart. Say \"personal\" if it's just for you.",
    "Nothing is charged until someone texts \"order now\". I never ask for card numbers in chat.",
  ].join("\n");
}

export function inviteToAddCard(cardLink: string): string {
  return `Add a card so your share is paid automatically: ${cardLink}`;
}

export function cardNumberWarning(cardLink: string): string {
  return `Please don't send card numbers in chat — I've ignored that message. Add your card securely here instead: ${cardLink}`;
}
