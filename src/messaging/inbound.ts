// Person 1. One serialized conversation per household; retries drain an outbox, never reapply actions.
import { parseMessage } from "../ai/parseMessage.js";
import { CATALOG, linePrice, matchProducts, normalize, type Product } from "../ai/catalog.js";
import { ParsedMessageSchema, type Intent } from "../ai/intent.js";
import { db, findHouseholdByGroupChat, findMemberByPhone, newId, pendingItems } from "../core/store.js";
import { openDebtsFor } from "../core/ledger.js";
import { OrderError, placeOrder } from "../core/orders.js";
import { createCardSetupLink, createPayBackLink } from "../payments/links.js";
import type { Household, Item, Member } from "../types.js";
import { containsCardNumber } from "./guard.js";
import { isApprovalCommand, isOrderCommand } from "./commands.js";
import { InboundMessageSchema, sendGroup, sendPrivate, type InboundMessage } from "./photon.js";
import { cardNumberWarning, fmt, inviteToAddCard } from "./templates.js";
import { addCatalogItem, canEdit, cartText, cartTotal, cartVersion, classifyItem, findCartItems, itemVersion, removeCartItem } from "./cart.js";
import { assertFundedResult, receiptReplies, type Reply } from "./receipts.js";

const QUESTION_TTL = 10 * 60 * 1000;
const HELP = "I’m Restock, your household’s AI assistant. Tell me what you need, or use: add 2 dish soap, cart, make chips personal, remove chips, add card, what do I owe, cancel. Only ‘order now’ requests test checkout. Purchases and delivery are simulated in this demo.";

type Question = {
  kind: "product"; intent: Intent; choices: Product[]; remaining: Intent[]; expires: number;
} | {
  kind: "item"; intent: Intent; choices: { id: string; version: string }[]; remaining: Intent[]; expires: number;
};
type State = { questions: Map<string, Question>; last: Map<string, string>; approval?: { id: string; version: string; expires: number }; visible?: string; checkoutUncertain?: boolean };

type Dependencies = {
  parse: typeof parseMessage; order: typeof placeOrder;
  group: typeof sendGroup; private: typeof sendPrivate;
  card: typeof createCardSetupLink; pay: typeof createPayBackLink; now: () => number;
};

export function createAgent(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { parse: parseMessage, order: placeOrder, group: sendGroup, private: sendPrivate,
    card: createCardSetupLink, pay: createPayBackLink, now: Date.now, ...overrides };
  const states = new Map<string, State>();
  const deliveries = new Map<string, Reply[]>();
  const queues = new Map<string, Promise<void>>();

  async function process(msg: InboundMessage, blocked: boolean): Promise<void> {
    const h = findHouseholdByGroupChat(msg.groupChatId);
    if (!h) return;
    const key = JSON.stringify([h.id, msg.id]);
    let replies = deliveries.get(key);
    const state: State = states.get(h.id) ?? { questions: new Map(), last: new Map() };
    states.set(h.id, state);
    if (!replies) {
      replies = [];
      deliveries.set(key, replies);
      const outbox = replies;
      const group = (text: string) => { outbox.push({ audience: "group", recipient: h.id, text }); };
      const privateReply = (id: string, text: string) => { outbox.push({ audience: "private", recipient: id, text }); };
      const showCart = () => { outbox.push({ audience: "group", recipient: h.id, text: cartText(h), cartVersion: cartVersion(h) }); };
      let member = findMemberByPhone(h, msg.fromPhone);
      if (!member) {
        member = { id: newId(), name: `Roommate ${h.members.length + 1}`, phone: msg.fromPhone, role: "member" };
        // TODO(P2): replace with store.addMember when the durable store is implemented.
        h.members.push(member);
        state.visible = undefined;
        try { privateReply(member.id, inviteToAddCard(await deps.card(member.id))); }
        catch { privateReply(member.id, "Welcome! Card setup is temporarily unavailable. Try ‘add card’ later."); }
      }
      const actor = member;
      const text = msg.text.trim();
      const normalized = text.toLowerCase().replace(/[.!?]+$/, "");

      const requestApproval = (item: Item) => {
        if (!item.needsApproval) return;
        state.approval = { id: item.id, version: itemVersion(item), expires: deps.now() + QUESTION_TTL };
        group(`Owner approval needed for ${item.name} (${fmt(item.cents)}, personal). ${h.members.find((m) => m.id === h.ownerId)?.name ?? "Owner"}, reply ‘approve ${item.name}’ or ‘yes’ to approve this item. This does not place an order.`);
      };
      const add = (product: Product, intent: Intent) => {
        const item = addCatalogItem(h, actor, product, intent.quantity ?? 1, intent.shared ?? product.shared);
        state.last.set(actor.id, item.id);
        group(`Added ${item.name} (${item.shared ? "shared" : "personal"}, ${fmt(item.cents)}). Reply ‘${item.shared ? "personal" : "shared"}’ to change, or ‘remove ${product.name}’.`);
        requestApproval(item);
        showCart();
      };
      const edit = (item: Item, intent: Intent, confirmedSelection = false) => {
        if (!canEdit(h, actor, item)) { group("Only the person who added that item or the owner can change it."); return; }
        if (intent.type === "approve") {
          if (actor.id !== h.ownerId || (!confirmedSelection && !isApprovalCommand(text))) { group("Only the owner can approve that item."); return; }
          item.needsApproval = false;
          state.approval = undefined;
          group(`Approved ${item.name}. Reply ‘order now’ when the cart is ready.`);
        } else if (intent.type === "remove_item") {
          removeCartItem(item);
          group(`Removed ${item.name}.`);
        } else if (intent.type === "set_shared" && intent.shared !== null) {
          classifyItem(item, intent.shared);
          state.last.set(actor.id, item.id);
          group(`${item.name} is now ${item.shared ? "shared" : "personal"} (${fmt(item.cents)}).`);
          requestApproval(item);
        }
        showCart();
      };
      const execute = async (intents: Intent[]): Promise<void> => {
        for (let index = 0; index < intents.length; index++) {
          const intent = intents[index]!;
          const remaining = intents.slice(index + 1);
          switch (intent.type) {
            case "add_item": {
              if (!intent.itemName) { group("What would you like to restock? Try ‘add dish soap’. "); break; }
              const match = matchProducts(intent.itemName);
              if (match.exact) { add(match.exact, intent); break; }
              const choices = match.candidates.length ? match.candidates : [...CATALOG];
              state.questions.set(actor.id, { kind: "product", intent, choices, remaining, expires: deps.now() + QUESTION_TTL });
              const quantity = intent.quantity ?? 1;
              group(`I don’t have an exact match for that request. Would one of these demo products work?\n${choices.map((p, i) => `${i + 1}. ${quantity} × ${p.name} — ${fmt(linePrice(p, quantity))} total`).join("\n")}\nReply with a number${choices.length === 1 ? " or ‘yes’" : ""}, or ‘cancel’. Quantities count packs; requested brands and special preferences are not guaranteed.`);
              return;
            }
            case "remove_item": case "set_shared": case "approve": {
              if (intent.type === "approve" && (actor.id !== h.ownerId || !isApprovalCommand(text))) { group("Only the owner can explicitly approve a personal item."); break; }
              let matches = findCartItems(h, intent.itemName, state.last.get(actor.id));
              if (intent.type === "approve" && !intent.itemName) {
                const approval = state.approval;
                matches = approval && approval.expires > deps.now() ? pendingItems(h.id).filter((i) => i.id === approval.id && itemVersion(i) === approval.version) : [];
              }
              if (intent.type === "approve") matches = matches.filter((i) => i.needsApproval);
              if (!matches.length) { group("There isn’t a matching pending item. Say ‘cart’ to see items, then include the item name."); break; }
              if (matches.length === 1) { edit(matches[0]!, intent); break; }
              state.questions.set(actor.id, { kind: "item", intent, choices: matches.map((i) => ({ id: i.id, version: itemVersion(i) })), remaining, expires: deps.now() + QUESTION_TTL });
              group(`Which item?\n${matches.map((i, n) => `${n + 1}. ${i.name} (${h.members.find((m) => m.id === i.addedBy)?.name}, ${fmt(i.cents)})`).join("\n")}\nReply with a number or ‘cancel’.`);
              return;
            }
            case "show_cart": showCart(); break;
            case "order_now": {
              if (!isOrderCommand(text) || intents.length !== 1) { group("To checkout the displayed cart, send ‘order now’ by itself."); break; }
              if (state.checkoutUncertain) { group("The previous checkout needs payment reconciliation. Checkout is paused to avoid duplicate charges."); break; }
              if ([...state.questions.values()].some((q) => q.expires > deps.now())) { group("Please answer or cancel the pending product questions before ordering."); break; }
              const items = pendingItems(h.id);
              if (!items.length) { showCart(); break; }
              if (state.visible !== cartVersion(h)) { showCart(); group("Review this current cart, then send ‘order now’ again to confirm."); break; }
              if (items.some((i) => i.needsApproval)) { group("The owner needs to approve the flagged personal items before checkout."); break; }
              if (items.some((i) => !Number.isSafeInteger(i.cents) || i.cents <= 0) || cartTotal(items) > h.budgetCents - h.spentCents) {
                group("Checkout stopped: the cart has an invalid price or exceeds the remaining household budget."); break;
              }
              if (!h.members.find((m) => m.id === h.ownerId)?.paymentMethodId) { group("The owner needs to add a card before checkout. Send ‘add card’ for a private setup link."); break; }
              try {
                const expected = { itemIds: items.map((i) => i.id), totalCents: cartTotal(items) };
                const result = await deps.order(h.id);
                assertFundedResult(h, result, expected);
                state.visible = undefined;
                group(`Test checkout completed: ${result.items.length} items, ${fmt(result.order.totalCents)}. Fulfillment is simulated; no retailer purchase or delivery was placed.\n${h.members.map((m) => `${m.name} ${fmt(result.shares[m.id] ?? 0)}`).join(" · ")}\nHousehold budget left: ${fmt(h.budgetCents - h.spentCents)}.`);
                outbox.push(...await receiptReplies(h, result, deps));
              } catch (error) {
                if (error instanceof OrderError) group(error.message);
                else { state.checkoutUncertain = true; group("Checkout could not be confirmed. No order confirmation has been issued. The team must check payment status before retrying."); }
              }
              break;
            }
            case "what_do_i_owe": {
              const debts = openDebtsFor(actor.id).filter((d) => db.orders.get(d.orderId)?.householdId === h.id);
              if (!debts.length) { privateReply(actor.id, "You have no open debts in this household."); break; }
              for (const debt of debts) {
                const creditor = h.members.find((m) => m.id === debt.creditorId)?.name ?? "the owner";
                try { privateReply(actor.id, `You owe ${creditor} ${fmt(debt.cents)}. Pay back: ${await deps.pay(debt.id)}`); }
                catch { privateReply(actor.id, `You owe ${creditor} ${fmt(debt.cents)}. Payment links are temporarily unavailable.`); }
              }
              break;
            }
            case "add_card":
              try { privateReply(actor.id, inviteToAddCard(await deps.card(actor.id))); }
              catch { privateReply(actor.id, "Card setup is temporarily unavailable. Please try again later."); }
              break;
            case "cancel": state.questions.delete(actor.id); group("Cancelled your pending question. Existing cart items remain; use ‘remove <item>’ to remove one."); break;
            case "clarify": group("What product and how many packs do you need? Try ‘add 2 dish soap’. Available: toilet paper, dish soap, paper towels, air fryer, tortilla chips, oat milk."); break;
            case "help": group(HELP); break;
            case "unknown": group("I couldn’t identify a shopping request. Try ‘add dish soap’, ‘cart’, or ‘help’."); break;
          }
        }
      };
      try {
        if (blocked) {
          try { privateReply(actor.id, cardNumberWarning(await deps.card(actor.id))); }
          catch { privateReply(actor.id, "Please don’t send card numbers in chat. I ignored that message. Secure card setup is temporarily unavailable."); }
        } else {
          const question = state.questions.get(actor.id);
          if (question && question.expires <= deps.now()) state.questions.delete(actor.id);
          const active = state.questions.get(actor.id);
          const selection = /^\d+$/.test(normalized) ? Number(normalized) - 1 : -1;
          if (active && (/^(cancel|no|never mind|nevermind)$/.test(normalized))) {
            state.questions.delete(actor.id); group("Cancelled that request.");
          } else if (active && (selection >= 0 || normalized === "yes" || (active.kind === "product" && active.choices.some((p) => normalize(p.name) === normalize(text))))) {
            const selected = selection >= 0 ? selection : normalized === "yes" && active.choices.length === 1 ? 0 : active.kind === "product" ? active.choices.findIndex((p) => normalize(p.name) === normalize(text)) : -1;
            if (selected < 0 || selected >= active.choices.length) { group("Please reply with one of the listed numbers, or ‘cancel’."); }
            else {
              state.questions.delete(actor.id);
              if (active.kind === "product") add(active.choices[selected]!, active.intent);
              else {
                const choice = active.choices[selected]!;
                const item = pendingItems(h.id).find((i) => i.id === choice.id && itemVersion(i) === choice.version);
                if (!item) group("That item changed while we were talking. Please request the change again.");
                else edit(item, active.intent, true);
              }
              await execute(active.remaining);
            }
          } else if (!active && question && /^(yes|\d+)$/.test(normalized)) {
            group("That question expired. Please tell me what you want to add or change again.");
          } else {
            const parsed = ParsedMessageSchema.safeParse({ intents: await deps.parse(text, actor.name, { cart: pendingItems(h.id).map((i) => ({ name: i.name, shared: i.shared })) }) });
            if (!parsed.success) group("I couldn’t validate that request. Try ‘add dish soap’ or ‘cart’.");
            else await execute(parsed.data.intents);
          }
        }
      } catch {
        group("I couldn’t finish that request. Send ‘cart’ to check the current items before trying again.");
      }
    }
    // Retain unsent replies on delivery failure. A retry never repeats the mutation or charge.
    while (replies.length) {
      const reply = replies[0]!;
      await (reply.audience === "group" ? deps.group(reply.recipient, reply.text) : deps.private(reply.recipient, reply.text));
      if (reply.cartVersion) state.visible = reply.cartVersion;
      replies.shift();
    }
  }

  return async (msg: InboundMessage): Promise<void> => {
    // Check text before any household/member lookup, parsing, or persistence.
    const blocked = containsCardNumber(msg.text);
    InboundMessageSchema.parse(msg);
    const previous = queues.get(msg.groupChatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => process(msg, blocked));
    queues.set(msg.groupChatId, next);
    try { await next; } finally { if (queues.get(msg.groupChatId) === next) queues.delete(msg.groupChatId); }
  };
}

export const handleInbound = createAgent();
