// Owner: Person 1. Pipeline: identify household + sender -> guard -> AI parse -> act -> reply.
import { answerQuestion, OFFLINE_REPLY } from "../ai/answerQuestion.js";
import { matchItem } from "../ai/matchItem.js";
import { parseMessage } from "../ai/parseMessage.js";
import { addItem, db, findHouseholdByGroupChat, findMemberByPhone, householdsForPhone, pendingItems, UNBOUND_GROUP } from "../core/store.js";
import { openDebtsFor, owedTo } from "../core/ledger.js";
import { OrderError, placeOrder } from "../core/orders.js";
import { createCardSetupLink } from "../payments/links.js";
import { ChargeFailedError } from "../payments/charges.js";
import { OwnerCardRequiredError, ownerCardRequest } from "../payments/ownerGate.js";
import type { Debt, Household } from "../types.js";
import { checkInput } from "../safety/guardrails.js";
import { reply, sendGroup, sendPrivate, type InboundMessage } from "./photon.js";
import { parseCommand } from "./commands.js";
import { balanceSummary, CARD_NUMBER_WARNING, fmt, groupSummary, helpMessage, inviteToAddCard } from "./templates.js";
import { sendOrderTexts } from "./afterOrder.js";
import { handleMembershipCommand, parseMembershipCommand } from "./membership.js";
import {
  buildChoice, hasPendingChoice, isCancel, lastBought, namedSpecifically, parsePick, queueChoices, resolvePick, stripUsual, wantsUsual,
  type Choice,
} from "./options.js";
import type { Product } from "../core/catalog.js";

/** Which household a message belongs to. Binds an unbound household to its group chat on first contact. */
function resolveHousehold(msg: InboundMessage): Household | undefined {
  if (msg.spaceKind === "group") {
    const known = findHouseholdByGroupChat(msg.spaceId);
    if (known) return known;
    const unbound = householdsForPhone(msg.fromPhone).filter((h) => h.groupChatId === UNBOUND_GROUP);
    if (unbound.length === 1 && unbound[0]) {
      unbound[0].groupChatId = msg.spaceId;
      console.log(`Bound household ${unbound[0].id} to group ${msg.spaceId}`);
      return unbound[0];
    }
    return undefined;
  }
  const mine = householdsForPhone(msg.fromPhone);
  return mine.length === 1 ? mine[0] : undefined; // TODO(P1): pick a household when someone is in several
}

export async function handleInbound(msg: InboundMessage): Promise<void> {
  let part = 0;
  const respond = (text: string) => reply(msg, text, part++);

  // 1. Guardrails run before anything else sees the text — even for unknown senders.
  // "add member <name> <phone>" must contain a phone number, which the PII guardrail would refuse. For that
  // one deterministic command, check everything except the number (it goes to the store, never to the AI).
  // The exemption applies only if the phone number is the *only* thing the guardrails object to.
  const membership = parseMembershipCommand(msg.text);
  let hit = checkInput(msg.text);
  if (hit?.rule === "injection" && membership?.type === "add_member" && !checkInput(msg.text.replace(membership.phone, "[phone]"))) {
    hit = undefined;
  }
  if (hit?.reply) {
    await respond(hit.reply);
    return;
  }
  if (hit?.rule === "card_number") {
    const household = resolveHousehold(msg);
    const member = household && findMemberByPhone(household, msg.fromPhone);
    if (msg.spaceKind === "direct" || !member) await respond(CARD_NUMBER_WARNING);
    else await sendPrivate(member.id, CARD_NUMBER_WARNING, `card-guard:${msg.messageId}`);
    return;
  }

  const household = resolveHousehold(msg);
  const member = household && findMemberByPhone(household, msg.fromPhone);

  // 2. Household membership commands (start / add member / remove member / members). Plain code, never the AI.
  if (membership) {
    await handleMembershipCommand({ command: membership, fromPhone: msg.fromPhone, spaceKind: msg.spaceKind, household, member: member || undefined, respond });
    return;
  }

  if (!household || !member) {
    if (msg.spaceKind === "direct") {
      await respond(`${helpMessage()}\nTo get started, text "start household as <your name>", or ask your household's budget owner to add you.`);
    }
    return;
  }

  // Group-wide news goes to the household chat once it's bound; otherwise answer where we were asked.
  const announce = (text: string) =>
    household.groupChatId === UNBOUND_GROUP ? respond(text) : sendGroup(household.id, text, `${msg.messageId}:${part++}`);

  const addToCart = async (product: Product, shared: boolean | null, prefix = "Added") => {
    const item = addItem({
      householdId: household.id,
      name: product.name,
      addedBy: member.id,
      cents: product.cents,
      shared: shared ?? product.defaultShared,
    });
    await respond(
      `${prefix} ${item.name} (${item.shared ? "shared" : "personal"}, ${fmt(item.cents)}). Reply "${item.shared ? "personal" : "shared"}" to change.`,
    );
  };

  // A reply to "Which one?" (1/2/3 or cancel) is handled in code, before any AI parsing.
  if (hasPendingChoice(household.id, member.id)) {
    const pick = parsePick(msg.text);
    const cancel = pick === undefined && isCancel(msg.text);
    if (pick !== undefined || cancel) {
      const result = resolvePick(household.id, member.id, cancel ? "cancel" : pick!);
      if (result?.kind === "invalid") await respond(result.prompt);
      else if (result?.kind === "picked") await addToCart(result.product, result.shared);
      else if (result?.kind === "cancelled") await respond("OK, I didn't add that one.");
      if (result && result.kind !== "invalid" && result.next) await respond(result.next);
      return;
    }
  }

  // 2. Understand the message.
  const intents = await parseMessage(msg.text, member.name);
  const choices: Choice[] = [];

  // In a DM, never leave someone without an answer; in the group, casual chat is ignored.
  if (msg.spaceKind === "direct" && intents.every((i) => i.type === "unknown")) {
    await respond(OFFLINE_REPLY);
    return;
  }

  // 3. Act.
  for (const intent of intents) {
    if (intent.itemName && checkInput(intent.itemName)) {
      await respond("I can only help with ordinary household supplies.");
      continue;
    }
    if (intent.type === "add_item" && intent.itemName) {
      const usual = wantsUsual(intent.itemName) || wantsUsual(msg.text);
      const requested = stripUsual(intent.itemName) || intent.itemName;
      const match = await matchItem(requested);
      if (!match) {
        await respond("I couldn’t find that in the demo catalog. Try another household item name?");
        continue;
      }
      const usualProduct = usual ? lastBought(household.id, match.product) : undefined;
      if (usualProduct) {
        await addToCart(usualProduct, intent.shared, "Added your usual:");
      } else if (namedSpecifically(requested, match.product)) {
        await addToCart(match.product, intent.shared);
      } else {
        if (usual) await respond(`I don't see an earlier order for ${requested}, so here are the options.`);
        choices.push(buildChoice(household.id, match.product, intent.shared));
      }
    } else if (intent.type === "question") {
      await respond(await answerQuestion(msg.text, member.name));
    } else if (intent.type === "set_shared" || intent.type === "remove_item") {
      // Which item? A named one, else the sender's most recent addition.
      const named = intent.itemName?.toLowerCase();
      const item = named
        ? pendingItems(household.id).find((i) => i.name.toLowerCase().includes(named))
        : pendingItems(household.id).filter((i) => i.addedBy === member.id).at(-1);
      if (!item) {
        await respond(named ? `I couldn't find "${intent.itemName}" in the cart.` : "There's nothing of yours in the cart to change.");
      } else if (intent.type === "remove_item") {
        db.items.delete(item.id);
        await respond(`Removed ${item.name} from the cart.`);
      } else {
        item.shared = intent.shared ?? !item.shared;
        await respond(`${item.name} is now ${item.shared ? "shared (split with everyone)" : `personal (just ${member.name})`}.`);
      }
    } else if (intent.type === "what_do_i_owe") {
      // Only the sender's own balances, and only sent to them.
      const nameOf = (id: string) => household.members.find((m) => m.id === id)?.name ?? "someone";
      const total = (debts: Debt[], key: "creditorId" | "debtorId") => {
        const by = new Map<string, number>();
        for (const d of debts) by.set(d[key], (by.get(d[key]) ?? 0) + d.cents);
        return [...by];
      };
      const text = balanceSummary(
        total(openDebtsFor(member.id), "creditorId").map(([id, cents]) => ({ to: nameOf(id), cents })),
        total(owedTo(member.id), "debtorId").map(([id, cents]) => ({ from: nameOf(id), cents })),
      );
      if (msg.spaceKind === "direct") await respond(text);
      else await sendPrivate(member.id, text, `balance:${msg.messageId}`);
    } else if (intent.type === "approve") {
      const waiting = pendingItems(household.id).filter((i) => i.needsApproval);
      if (member.id !== household.ownerId) {
        if (waiting.length) await respond("Only the budget owner can approve that.");
      } else if (waiting.length === 0) {
        await respond("Nothing is waiting for approval.");
      } else {
        for (const i of waiting) i.needsApproval = false;
        await respond(`Approved: ${waiting.map((i) => i.name).join(", ")}. They'll be in the next order.`);
      }
    } else if (intent.type === "add_card") {
      // The secure Stripe link goes only to the member, privately, and only when they ask for it.
      const invite = inviteToAddCard(await createCardSetupLink(member.id));
      if (msg.spaceKind === "direct") await respond(invite);
      else await sendPrivate(member.id, invite, `add-card:${msg.messageId}`);
    } else if (intent.type === "help") {
      await respond(helpMessage());
    } else if (intent.type === "order_now") {
      // Authorization is independent of model output, even if the parser is bypassed.
      const commands = parseCommand(msg.text);
      if (commands.length !== 1 || commands[0]?.type !== "order_now") {
        await respond('To check out the current cart, text "order now".');
        continue;
      }
      try {
        const result = await placeOrder(household.id);
        await announce(groupSummary(household, result));
        await sendOrderTexts(household, result);
      } catch (err) {
        if (err instanceof OwnerCardRequiredError) {
          // The add-card link goes only to the owner, privately. The group just hears why we stopped.
          const gate = await ownerCardRequest(household);
          if (gate.ownerId === member.id && msg.spaceKind === "direct" && gate.ownerText) await respond(gate.ownerText);
          else {
            await respond(gate.groupText);
            if (gate.ownerId && gate.ownerText) await sendPrivate(gate.ownerId, gate.ownerText, `owner-gate:${msg.messageId}`);
          }
        } else if (err instanceof OrderError || err instanceof ChargeFailedError) await respond(err.message);
        else throw err;
      }
    }
  }

  // Ask "Which one?" once, after the other replies. Later items wait their turn.
  const prompt = queueChoices(household.id, member.id, choices);
  if (prompt) await respond(prompt);
}
