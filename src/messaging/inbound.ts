// Owner: Person 1. Pipeline: identify household + sender -> guard -> AI parse -> act -> reply.
import { answerQuestion, OFFLINE_REPLY } from "../ai/answerQuestion.js";
import { matchItem } from "../ai/matchItem.js";
import { parseMessage } from "../ai/parseMessage.js";
import { addItem, db, findHouseholdByGroupChat, findMemberByPhone, householdsForPhone, pendingItems, UNBOUND_GROUP } from "../core/store.js";
import { approvableBy, approverNames, approvers, needsApproval } from "../core/approvals.js";
import { openDebtsFor, owedTo } from "../core/ledger.js";
import { OrderError, placeOrder } from "../core/orders.js";
import { createCardSetupLink } from "../payments/links.js";
import { ChargeFailedError } from "../payments/charges.js";
import { OwnerCardRequiredError, ownerCardRequest } from "../payments/ownerGate.js";
import type { Debt, Household } from "../types.js";
import { checkInput, INJECTION_REPLY } from "../safety/guardrails.js";
import { isMuted, mute, reply, sendGroup, sendPrivate, unmute, type InboundMessage } from "./photon.js";
import { parseCommand } from "./commands.js";
import { balanceSummary, CARD_NUMBER_WARNING, fmt, groupSummary, helpMessage, inviteToAddCard } from "./templates.js";
import { sendOrderTexts } from "./afterOrder.js";
import { handleMembershipCommand, parseMembershipCommand } from "./membership.js";
import { clearAction, isNo, isYes, peekAction, proposeAction } from "./confirm.js";
import { activateFromFirstText, inviteCodeFor, isPendingSignup, type Activation } from "../core/signups.js";
import { config } from "../config.js";
import { cleanName, findPhone } from "../core/households.js";
import { handleOnboarding, setupInProgress } from "./onboarding.js";
import { parseDealRequest, stripDealWords } from "../deals/request.js";
import {
  buildDealChoice, hasPendingChoice, isCancel, lastBought, namedSpecifically, parsePick, queueChoices, resolvePick, stripUsual, wantsUsual,
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
  // One-on-one texts go to the sender's personal space when they have one.
  const mine = householdsForPhone(msg.fromPhone);
  const personal = mine.find((h) => h.kind === "personal");
  if (personal) return personal;
  return mine.length === 1 ? mine[0] : undefined; // TODO(P1): pick a household when someone is in several
}

export async function handleInbound(msg: InboundMessage): Promise<void> {
  let part = 0;
  const respond = (text: string) => reply(msg, text, part++);

  // STOP / START (texting consent). Checked before anything else; while stopped, we only answer START.
  const word = msg.text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(?:stop|stopall|unsubscribe|quit|end)$/.test(word)) {
    mute(msg.fromPhone);
    await respond('You won\'t get any more texts from Restock. Text START to turn them back on, or "delete my data" to leave.');
    return;
  }
  if (isMuted(msg.fromPhone)) {
    if (/^(?:start|unstop|resume)$/.test(word)) {
      unmute(msg.fromPhone);
      await respond("Welcome back! Texts from Restock are on again. Text \"help\" to see what I can do.");
    }
    return;
  }

  // 1. Guardrails run before anything else sees the text — even for unknown senders.
  // "add member <name> <phone>" must contain a phone number, which the PII guardrail would refuse. For that
  // one deterministic command, check everything except the number (it goes to the store, never to the AI).
  // The exemption applies only if the phone number is the *only* thing the guardrails object to.
  const membership = parseMembershipCommand(msg.text);
  let hit = checkInput(msg.text);
  if (hit?.rule === "injection" && membership?.type === "add_member" && !checkInput(msg.text.replace(membership.phone, "[phone]"))) {
    hit = undefined;
  }
  // Casual phrasing ("add amber, her number is 425 555 0123"): hold the number back in code so the model only
  // ever sees "[phone]". If the model doesn't read it as adding a member, the message is refused below as before.
  let aiText = msg.text;
  let heldPhone: string | undefined;
  if (hit?.rule === "injection" && !membership) {
    const found = findPhone(msg.text);
    if (found && !checkInput(msg.text.replace(found.raw, "[phone]"))) {
      hit = undefined;
      heldPhone = found.phone;
      aiText = msg.text.replace(found.raw, "[phone]");
    }
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

  // First text from someone who signed up on the web: it proves they own the phone and activates them.
  if (msg.spaceKind === "direct" && isPendingSignup(msg.fromPhone)) {
    const activation = activateFromFirstText(msg.fromPhone);
    if (activation) {
      await welcome(activation, respond);
      return;
    }
  }

  const household = resolveHousehold(msg);
  const member = household && findMemberByPhone(household, msg.fromPhone);

  // A "yes"/"no" to a question Restock asked (confirm-to-act). Only the person who was asked can answer.
  let confirmedOrder = false;
  const pendingAction = peekAction(msg.fromPhone);
  if (pendingAction && (isYes(msg.text) || isNo(msg.text))) {
    clearAction(msg.fromPhone);
    if (isNo(msg.text)) {
      await respond("OK, I won't do that.");
      return;
    }
    if (pendingAction.kind === "membership") {
      await handleMembershipCommand({ command: pendingAction.command, fromPhone: msg.fromPhone, spaceKind: msg.spaceKind, household, member: member || undefined, respond });
      return;
    }
    confirmedOrder = true; // runs below, once the household context is set up
  }

  // 2. Household membership commands (start / add member / remove member / members). Plain code, never the AI.
  if (membership?.type === "delete_self" && household && member) {
    // Deleting your data can't be undone: ask first, like any sensitive action.
    proposeAction(msg.fromPhone, { kind: "membership", command: membership });
    await respond('Leave Restock and delete your data? This removes you from the household and can\'t be undone. Reply "yes" to confirm or "no" to cancel.');
    return;
  }
  // While Restock is asking setup questions here, the answers go to setup ("roommates" is an answer, not a command).
  if (membership && !(membership.type === "members" && !member && setupInProgress(msg))) {
    await handleMembershipCommand({ command: membership, fromPhone: msg.fromPhone, spaceKind: msg.spaceKind, household, member: member || undefined, respond });
    return;
  }

  // 3. Not set up yet (or new to this group): Restock says hi and sets things up by asking questions.
  if (!household || !member) {
    if (setupInProgress(msg) || msg.spaceKind === "group") {
      await handleOnboarding({ msg, household, respond });
      return;
    }
    if (heldPhone) {
      await respond(INJECTION_REPLY);
      return;
    }
    // Someone new can start a household in their own words ("make me a household, I'm Alex"); they confirm with "yes".
    const intents = confirmedOrder ? [] : await parseMessage(aiText, "member");
    const start = intents.find((i) => i.type === "start_household");
    if (start) {
      const name = start.itemName ? cleanName(start.itemName) : undefined;
      if (!name) {
        await respond('Happy to set that up! What should I call you? Text "start household as <your first name>".');
      } else {
        proposeAction(msg.fromPhone, { kind: "membership", command: { type: "start", name } });
        await respond(`Start a household with you (${name}) as the budget owner? Reply "yes" to confirm or "no" to cancel.`);
      }
      return;
    }
    await handleOnboarding({ msg, household, respond });
    return;
  }

  // Group-wide news goes to the household chat once it's bound; otherwise answer where we were asked.
  // If the group chat can't be reached (e.g. not seen since a restart), say it here instead of failing.
  const announce = async (text: string) => {
    if (household.kind === "personal") return respond(text);
    if (household.groupChatId === UNBOUND_GROUP) {
      // No shared group chat (everyone texts their own Restock number): tell the sender here, and relay to everyone else.
      await respond(text);
      await relayToOthers(household, member.id, text, `${msg.messageId}:${part++}`);
      return;
    }
    try {
      await sendGroup(household.id, text, `${msg.messageId}:${part++}`);
    } catch (err) {
      console.warn("group announcement failed, replying here instead:", err instanceof Error ? err.message : err);
      await respond(text);
    }
  };

  // `overBudget`: the member picked an option past this month's budget. It waits for the owner's "yes",
  // using the same approval flow as expensive personal items (placeOrder skips it until then).
  const addToCart = async (product: Product, shared: boolean | null, prefix = "Added", overBudget?: { ownerName: string }) => {
    const budget = household.budgetCents;
    const committed = household.spentCents + pendingItems(household.id).reduce((sum, item) => sum + item.cents, 0);
    const exceedsBudget = overBudget ?? (budget !== undefined && committed + product.cents > budget
      ? { ownerName: household.members.find((m) => m.id === household.ownerId)?.name ?? "the budget owner" }
      : undefined);
    const waits = needsApproval(household, member, product.cents) || (!!exceedsBudget && member.id !== household.ownerId);
    const item = addItem({
      householdId: household.id,
      name: product.name,
      addedBy: member.id,
      cents: product.cents,
      shared: shared ?? product.defaultShared,
      ...(waits ? { needsApproval: true } : {}),
    });
    if (waits) {
      const budgetNote = exceedsBudget ? " It would exceed this month's budget." : "";
      const ask = `${member.name} asked for ${item.name} (${item.shared ? "shared" : "personal"}, ${fmt(item.cents)}).${budgetNote} ${approverNames(household, member.id)}: reply "yes" to add it to the cart.`;
      await respond(
        msg.spaceKind === "direct"
          ? `Best match: ${item.name} (${fmt(item.cents)}).${budgetNote} I've asked ${approverNames(household, member.id)} to approve it.`
          : ask,
      );
      if (msg.spaceKind === "direct" && household.groupChatId !== UNBOUND_GROUP) {
        await sendGroup(household.id, ask, `${msg.messageId}:ask:${item.id}`);
      } else if (household.groupChatId === UNBOUND_GROUP) {
        // No shared group chat: each approver gets the request in their own Restock thread.
        const privateAsk = `${member.name} asked for ${item.name} (${item.shared ? "shared" : "personal"}, ${fmt(item.cents)}).${budgetNote} Reply "yes" to add it to the cart.`;
        for (const approver of approvers(household)) {
          if (approver.id === member.id) continue;
          await sendPrivate(approver.id, privateAsk, `ask:${item.id}:${approver.id}`).catch((err) =>
            console.warn("approval request failed:", err instanceof Error ? err.message : err),
          );
        }
      }
      return;
    }
    const budgetNote = exceedsBudget ? " Heads-up: this puts the household over this month's budget." : "";
    await respond(
      `${prefix} ${item.name} (${item.shared ? "shared" : "personal"}, ${fmt(item.cents)}). Reply "${item.shared ? "personal" : "shared"}" to change.${budgetNote}`,
    );
    if (household.groupChatId === UNBOUND_GROUP) {
      await relayToOthers(household, member.id, `${member.name} added ${item.name} (${item.shared ? "shared" : "personal"}, ${fmt(item.cents)}).`, `add:${item.id}`);
    }
  };

  const runOrder = async () => {
    try {
      const result = await placeOrder(household.id);
      await announce(groupSummary(household, result));
      const { waiting } = await sendOrderTexts(household, result);
      if (waiting.length) {
        await respond(waitingForDm(waiting));
      }
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
  };

  // The member said "yes" to "Place the order now?": this, not the model, authorizes checkout.
  if (confirmedOrder) {
    await runOrder();
    return;
  }

  // A reply to "Which one?" (1/2/3 or cancel) is handled in code, before any AI parsing.
  if (hasPendingChoice(household.id, member.id)) {
    const pick = parsePick(msg.text);
    const cancel = pick === undefined && isCancel(msg.text);
    if (pick !== undefined || cancel) {
      const result = resolvePick(household.id, member.id, cancel ? "cancel" : pick!);
      if (result?.kind === "invalid") await respond(result.prompt);
      else if (result?.kind === "picked") await addToCart(result.product, result.shared, "Added", result.overBudget);
      else if (result?.kind === "cancelled") await respond("OK, I didn't add that one.");
      if (result && result.kind !== "invalid" && result.next) await respond(result.next);
      return;
    }
  }

  // 2. Understand the message.
  const intents = await parseMessage(aiText, member.name);
  if (heldPhone && !intents.some((i) => i.type === "add_member")) {
    await respond(INJECTION_REPLY); // a phone number outside adding a member: refused, as before
    return;
  }
  const choices: Choice[] = [];
  // "cheapest TP under $15 from Costco": deal preferences come from the member's own words, read by code.
  const dealOptions = parseDealRequest(msg.text);

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
      const requested = stripDealWords(stripUsual(intent.itemName) || intent.itemName);
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
        choices.push(await buildDealChoice(household.id, match.product, intent.shared, dealOptions));
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
      const mine = approvableBy(household, member, waiting);
      if (waiting.length === 0) {
        await respond("Nothing is waiting for approval.");
      } else if (mine.length === 0) {
        await respond(`Only ${approverNames(household, member.id)} can approve that.`);
      } else {
        for (const i of mine) i.needsApproval = false;
        await respond(`Approved by ${member.name}: ${mine.map((i) => i.name).join(", ")}. They'll be in the next order.`);
        // Tell each person who asked that their item was approved.
        for (const requesterId of new Set(mine.map((i) => i.addedBy))) {
          if (requesterId === member.id || !household.members.some((m) => m.id === requesterId)) continue;
          const theirs = mine.filter((i) => i.addedBy === requesterId).map((i) => i.name).join(", ");
          await sendPrivate(requesterId, `${member.name} approved ${theirs}. It'll be in the next order.`, `approved:${msg.messageId}:${requesterId}`).catch((err) =>
            console.warn("approval notice failed:", err instanceof Error ? err.message : err),
          );
        }
      }
    } else if (intent.type === "add_card") {
      // The secure Stripe link goes only to the member, privately, and only when they ask for it.
      const invite = inviteToAddCard(await createCardSetupLink(member.id));
      if (msg.spaceKind === "direct") await respond(invite);
      else await sendPrivate(member.id, invite, `add-card:${msg.messageId}`);
    } else if (intent.type === "checkout") {
      // Casual "let's order": ask first. Only the member's explicit "yes" (or "order now") places it.
      const ready = pendingItems(household.id).filter((i) => !i.needsApproval);
      if (ready.length === 0) {
        await respond("The cart is empty.");
      } else {
        const total = ready.reduce((sum, i) => sum + i.cents, 0);
        proposeAction(msg.fromPhone, { kind: "order" });
        await respond(`Place the order now? ${ready.length} item${ready.length === 1 ? "" : "s"}, ${fmt(total)}. Reply "yes" to confirm or "no" to cancel.`);
      }
    } else if (intent.type === "start_household" || intent.type === "list_members") {
      const command = intent.type === "list_members" ? ({ type: "members" } as const) : ({ type: "start", name: null } as const);
      await handleMembershipCommand({ command, fromPhone: msg.fromPhone, spaceKind: msg.spaceKind, household, member, respond });
    } else if (intent.type === "add_member" || intent.type === "remove_member") {
      // Owner-only, checked in code before asking and again when it runs.
      const name = intent.itemName ? cleanName(intent.itemName) : undefined;
      if (member.id !== household.ownerId) {
        await respond("Only the budget owner can add or remove people.");
      } else if (!name) {
        await respond(`Who should I ${intent.type === "add_member" ? "add" : "remove"}? Use their first name.`);
      } else if (intent.type === "add_member" && !heldPhone) {
        await respond(`What's ${name}'s phone number? Text "add member ${name} <phone number>".`);
      } else if (intent.type === "add_member") {
        proposeAction(msg.fromPhone, { kind: "membership", command: { type: "add_member", name, phone: heldPhone! } });
        await respond(`Add ${name} (phone ending ${heldPhone!.slice(-4)}) to the household? Reply "yes" to confirm or "no" to cancel.`);
      } else if (!household.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
        await respond(`I couldn't find ${name} in your household.`);
      } else {
        proposeAction(msg.fromPhone, { kind: "membership", command: { type: "remove_member", name } });
        await respond(`Remove ${name} from the household? Reply "yes" to confirm or "no" to cancel.`);
      }
    } else if (intent.type === "help") {
      await respond(helpMessage());
    } else if (intent.type === "order_now") {
      // Authorization is independent of model output, even if the parser is bypassed.
      const commands = parseCommand(msg.text);
      if (commands.length !== 1 || commands[0]?.type !== "order_now") {
        await respond('To check out the current cart, text "order now".');
        continue;
      }
      await runOrder();
    }
  }

  // Ask "Which one?" once, after the other replies. Later items wait their turn.
  const prompt = queueChoices(household.id, member.id, choices);
  if (prompt) await respond(prompt);
}

/**
 * Household news for members who aren't in a shared group chat: each gets it in their own Restock thread.
 * Failures for one person never stop the others.
 */
async function relayToOthers(household: Household, senderId: string, text: string, key: string): Promise<void> {
  for (const other of household.members) {
    if (other.id === senderId) continue;
    await sendPrivate(other.id, text, `relay:${key}:${other.id}`).catch((err) =>
      console.warn("household relay failed:", err instanceof Error ? err.message : err),
    );
  }
}

/** Welcome a newly activated sign-up. The owner gets their invite link; existing members hear who joined. */
async function welcome({ household, member, joined }: Activation, respond: (text: string) => Promise<void>): Promise<void> {
  const owner = household.members.find((m) => m.id === household.ownerId);
  if (!joined) {
    const link = `${config.publicBaseUrl}/join/${inviteCodeFor(household, member.id)}`;
    await respond(
      `Welcome to Restock, ${member.name}! Your household is set up and you're the budget owner.\n` +
        `Invite roommates with this link: ${link}\n` +
        `Text what you need anytime ("we're out of TP"), and text "add card" so orders can go through.`,
    );
    return;
  }
  await respond(
    `Welcome, ${member.name}! You're in ${owner?.name ?? "your"}'s household.\n` +
      `Text what you need ("we're out of TP"), "what do I owe?", or "help". No card needed to join; text "add card" anytime.`,
  );
  await relayToOthers(household, member.id, `${member.name} joined the household.`, `joined:${member.id}`);
}

/** "Abdul hasn't texted me…" / "Abdul and David haven't texted me…" */
export function waitingForDm(names: string[]): string {
  const who = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const verb = names.length === 1 ? "hasn't" : "haven't";
  return `${who} ${verb} texted me directly yet. I'll send their private messages as soon as they do.`;
}
