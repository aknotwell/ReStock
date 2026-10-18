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
  const budget = h.budgetCents === undefined ? "" : ` Household budget left: ${fmt(h.budgetCents - h.spentCents)}`;
  return `Ordered! ${r.items.length} items, ${fmt(r.order.totalCents)}, ${ruleText[r.order.rule]}.\n${lines}\nArrives ${r.order.eta ?? "soon"}.${budget}\n(Demo order: nothing ships, and payments are Stripe test mode.)`;
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

/** `totalOwed`: everything they owe the owner, this order included. The pay link pays all of it. */
export function youOwe(owner: Member, share: Cents, payLink: string, cardLink: string, totalOwed: Cents = share): string {
  const total = totalOwed > share ? `\nWith earlier orders, you owe ${owner.name} ${fmt(totalOwed)} in total. This link pays all of it.` : "";
  return `Your share of this week's order is ${fmt(share)}. ${owner.name}'s card covered it.${total}\nPay ${owner.name} back: ${payLink}\nOr add a card so it's paid automatically next time: ${cardLink}`;
}

export function helpMessage(): string {
  return [
    "I'm Restock, an AI assistant for this household. I'm not a person.",
    "Text what you need (\"we're out of TP\") and I'll add it to the cart. Say \"personal\" if it's just for you.",
    "Nothing is charged until someone texts \"order now\". I never ask for card numbers in chat.",
    "Reply STOP to stop texts, or \"delete my data\" to leave. Demo: orders are simulated and payments are Stripe test mode.",
  ].join("\n");
}

export function inviteToAddCard(cardLink: string): string {
  return `Add a card so your share is paid automatically: ${cardLink}`;
}

// V-008: the refusal is fixed text. It never carries a link or token, so a reply to a message that
// contained card data can't itself leak an identifier. The secure link is sent only on request ("add card").
export const CARD_NUMBER_WARNING =
  "I can't confirm, store, or repeat card numbers, so I've ignored that message. Please don't send card details in chat. To add a card safely, text \"add card\" and I'll send you a private, secure link.";

export function cardAdded(last4: string): string {
  return `Card added, ending ${last4}. From the next order on, your share is charged to it automatically.`;
}

export function balanceSummary(owes: { to: string; cents: Cents }[], owed: { from: string; cents: Cents }[]): string {
  if (owes.length === 0 && owed.length === 0) return "You're all settled up. Nobody owes anything.";
  const lines = [
    ...owes.map((o) => `You owe ${o.to} ${fmt(o.cents)}.`),
    ...owed.map((o) => `${o.from} owes you ${fmt(o.cents)}.`),
  ];
  return lines.join("\n");
}
