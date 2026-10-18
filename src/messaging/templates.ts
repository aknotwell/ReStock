// Owner: Person 1. Wording follows the design note (PLAN.md).
import type { ShareLine } from "../core/split.js";
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

/** Most item lines shown in one text; the rest are summed into one "…and N more" line. */
export const MAX_ITEM_LINES = 8;

/**
 * "\n• Air fryer $32.00\n• Dish soap, 3 pack (split 3 ways) $2.83", or "" when there's nothing to list.
 * Lines worth 0¢ (a tiny item split many ways) are left out.
 */
export function itemList(lines: ShareLine[] = []): string {
  const shown = lines.filter((l) => l.cents > 0);
  const out = shown.slice(0, MAX_ITEM_LINES).map((l) => `\n• ${l.name}${l.splitWays > 1 ? ` (split ${l.splitWays} ways)` : ""} ${fmt(l.cents)}`);
  const rest = shown.slice(MAX_ITEM_LINES);
  if (rest.length) {
    const cents = rest.reduce((sum, l) => sum + l.cents, 0);
    out.push(`\n• …and ${rest.length} more item${rest.length === 1 ? "" : "s"} ${fmt(cents)}`);
  }
  return out.join("");
}

/** Who the owner's card covered, e.g. "Priya" or "Priya ($10.15) and David ($2.12)". */
function coveredNames(covered: { name: string; cents: Cents }[]): string {
  if (covered.length === 1) return covered[0]!.name;
  const parts = covered.map((c) => `${c.name} (${fmt(c.cents)})`);
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** `lines`: the owner's own items. `covered`: who their card paid for, so the receipt can name them. */
export function ownerReceipt(
  owner: Member,
  share: Cents,
  coveredForOthers: Cents,
  lines?: ShareLine[],
  covered?: { name: string; cents: Cents }[],
): string {
  let t = `Receipt: your share is ${fmt(share)}, charged to your Visa ending ${owner.cardLast4 ?? "????"}.${itemList(lines)}`;
  if (coveredForOthers > 0) {
    const who = covered?.length ? coveredNames(covered) : "roommates without a card";
    t += `\nYour card also covered ${fmt(coveredForOthers)} for ${who}. I'll remind them to pay you back.`;
  }
  return t;
}

export function memberReceipt(member: Member, share: Cents, lines?: ShareLine[]): string {
  return `Receipt: your share is ${fmt(share)}, charged to your card ending ${member.cardLast4 ?? "????"}.${itemList(lines)}`;
}

/** `totalOwed`: everything they owe the owner, this order included. The pay link pays all of it. */
export function youOwe(
  owner: Member,
  share: Cents,
  payLink: string,
  cardLink: string,
  totalOwed: Cents = share,
  lines?: ShareLine[],
): string {
  const total = totalOwed > share ? `\nWith earlier orders, you owe ${owner.name} ${fmt(totalOwed)} in total. This link pays all of it.` : "";
  return `Your share of this week's order is ${fmt(share)}. ${owner.name}'s card covered it.${itemList(lines)}${total}\nPay ${owner.name} back: ${payLink}\nOr add a card so it's paid automatically next time: ${cardLink}`;
}

export function helpMessage(): string {
  return [
    "I'm Restock, an AI assistant for this household. I'm not a person.",
    "Text what you need (\"we're out of TP\") and I'll add it to the cart. Say \"personal\" if it's just for you, or name who it's for (\"for me and Jake\") to split it with some of you.",
    "Text \"cart\" to see what's on the shopping list. Nothing is charged until someone texts \"order now\". I never ask for card numbers in chat.",
    "In more than one household? Text \"households\" to see them and \"switch to <name>\" to change where your texts go.",
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

/** To the owner when someone pays them back through a pay-back link. */
export function paidBack(debtorName: string, cents: Cents, orders: number): string {
  return `${debtorName} paid you back ${fmt(cents)}${orders > 1 ? ` for ${orders} orders` : ""}.`;
}

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
