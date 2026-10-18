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
import type { Debt, Household, Item } from "../types.js";
import { checkInput, INJECTION_REPLY } from "../safety/guardrails.js";
import { isMuted, mute, reply, sendGroup, sendPrivate, unmute, type InboundMessage } from "./photon.js";
import { parseCommand } from "./commands.js";
import { balanceSummary, CARD_NUMBER_WARNING, fmt, groupSummary, helpMessage, inviteToAddCard } from "./templates.js";
import { sendOrderTexts } from "./afterOrder.js";
import { handleMembershipCommand, parseMembershipCommand } from "./membership.js";
import { clearAction, isNo, isYes, peekAction, proposeAction } from "./confirm.js";
import { activateFromFirstText, invitedTo, inviteCodeFor, isPendingSignup, lineFor, type Activation } from "../core/signups.js";
import { isRestockLine } from "./photonLines.js";
import { CONTACT_NAME, contactLink } from "../web/contactCard.js";
import { config } from "../config.js";
import { cleanName, findPhone } from "../core/households.js";
import { handleOnboarding, setupInProgress } from "./onboarding.js";
import { parseDealRequest, stripDealWords } from "../deals/request.js";
import { currentListing, liveDealsEnabled, offCatalogProduct } from "../deals/live.js";
import { describeParts, parseSplitCommand, parseSplitInAdd, payersOf, setPayers, splitLabel, unclearReply, type SplitRequest } from "./splitWith.js";
import {
  buildDealChoice, hasPendingChoice, isCancel, lastBought, namedSpecifically, parsePick, queueChoices, resolvePick, stripUsual, wantsUsual,
  type Choice,
} from "./options.js";
import type { Product } from "../core/catalog.js";
import { sendLoginCode } from "../payments/payback.js";

const LOGIN_CODE = /^(?:(?:send|text|give) me (?:a |my |the )?|get (?:a |my )?)?(?:log ?in |dashboard |verification )?code[.!?]*$|^log ?in[.!?]*$/i;

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
      // "hi" just activates. Anything else ("we're out of TP") is also handled, so it isn't lost.
      if (isGreeting(msg.text)) return;
    }
  }

  const household = resolveHousehold(msg);
  const member = household && findMemberByPhone(household, msg.fromPhone);

  // "code": a login code for the dashboard and pay-back site, as a reply (Restock can't text first, so the
  // website's "Text me a code" only reaches people who have texted us one-on-one). Never in a group chat.
  if (member && LOGIN_CODE.test(msg.text.trim())) {
    if (msg.spaceKind === "direct") await sendLoginCode(member, respond);
    else await respond("For your security, text me directly for a login code.");
    return;
  }

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
  // `payers`: who it's split between, when they said ("for me and Jake"); otherwise shared/personal as usual.
  const addToCart = async (product: Product, shared: boolean | null, prefix = "Added", overBudget?: { ownerName: string }, payers?: string[]) => {
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
    if (payers?.length) setPayers(item, payers, household);
    if (waits) {
      const budgetNote = exceedsBudget ? " It would exceed this month's budget." : "";
      const ask = `${member.name} asked for ${item.name} (${splitLabel(item, household)}, ${fmt(item.cents)}).${budgetNote} ${approverNames(household, member.id)}: reply "yes" to add it to the cart.`;
      if (household.groupChatId === UNBOUND_GROUP) {
        // No shared group chat: each approver gets the request in their own Restock thread. Send first, then tell
        // the requester who was actually reached: an approver who hasn't texted Restock yet only has it queued.
        const privateAsk = `${member.name} asked for ${item.name} (${item.shared ? "shared" : "personal"}, ${fmt(item.cents)}).${budgetNote} Reply "yes" to add it to the cart.`;
        const reached: string[] = [];
        const queued: string[] = [];
        for (const approver of approvers(household)) {
          if (approver.id === member.id) continue;
          const result = await sendPrivate(approver.id, privateAsk, `ask:${item.id}:${approver.id}`).catch((err) => {
            console.warn("approval request failed:", err instanceof Error ? err.message : err);
            return undefined;
          });
          if (result === "sent") reached.push(approver.name);
          else if (result === "queued") queued.push(approver.name);
        }
        const asked = reached.length ? ` I've asked ${joinNames(reached)} to approve it.` : "";
        await respond(msg.spaceKind === "direct" ? `Best match: ${item.name} (${fmt(item.cents)}).${budgetNote}${asked}` : ask);
        if (queued.length) {
          const verb = queued.length === 1 ? "hasn't" : "haven't";
          await respond(
            `${joinNames(queued)} ${verb} texted me directly yet, so I couldn't send your request. ` +
              `Ask ${queued.length === 1 ? "them" : "each of them"} to text me, and they'll get it right away.`,
          );
        }
        return;
      }
      await respond(
        msg.spaceKind === "direct"
          ? `Best match: ${item.name} (${fmt(item.cents)}).${budgetNote} I've asked ${approverNames(household, member.id)} to approve it.`
          : ask,
      );
      if (msg.spaceKind === "direct") {
        await sendGroup(household.id, ask, `${msg.messageId}:ask:${item.id}`);
      }
      return;
    }
    const budgetNote = exceedsBudget ? " Heads-up: this puts the household over this month's budget." : "";
    await respond(
      `${prefix} ${item.name} (${splitLabel(item, household, member.id)}, ${fmt(item.cents)}). ${changeHint(item, household, member.id)}${budgetNote}`,
    );
    if (household.groupChatId === UNBOUND_GROUP) {
      await relayToOthers(household, member.id, `${member.name} added ${item.name} (${splitLabel(item, household)}, ${fmt(item.cents)}).`, `add:${item.id}`);
    }
  };

  // "just me and Alex" / "split with Priya" / "everyone" change the sender's most recent item.
  // "not me" (or "not me for the chips") takes the sender off an item someone else put them on.
  const changePayers = async (request: SplitRequest) => {
    const pending = pendingItems(household.id);
    if (request.kind === "unclear") {
      await respond(unclearReply(request.words, household));
      return;
    }
    if (request.kind === "not_me") {
      const named = request.itemName?.toLowerCase();
      const item = named
        ? pending.find((i) => i.name.toLowerCase().includes(named))
        : pending.filter((i) => payersOf(i, household).some((m) => m.id === member.id)).at(-1);
      if (!item) {
        await respond(named ? `I couldn't find "${request.itemName}" in the cart.` : "You're not paying for anything in the cart.");
        return;
      }
      const payers = payersOf(item, household);
      if (!payers.some((m) => m.id === member.id)) {
        await respond(`You're not paying for ${item.name}.`);
        return;
      }
      if (payers.length === 1 && item.addedBy === member.id) {
        await respond(`${item.name} is yours. Text "remove ${item.name.toLowerCase()}" to take it out of the cart.`);
        return;
      }
      const rest = payers.filter((m) => m.id !== member.id).map((m) => m.id);
      setPayers(item, rest.length ? rest : [item.addedBy], household); // nobody left: back to whoever added it
      await respond(`Took you off ${item.name}. It's now ${describeParts(item, household)}.`);
      if (household.groupChatId === UNBOUND_GROUP) {
        await relayToOthers(household, member.id, `${member.name} took themselves off ${item.name}. It's now ${describeParts(item, household)}.`, `split:${msg.messageId}`);
      }
      return;
    }
    const item = pending.filter((i) => i.addedBy === member.id).at(-1);
    if (!item) {
      await respond("There's nothing of yours in the cart to change.");
      return;
    }
    setPayers(item, request.kind === "everyone" ? household.members.map((m) => m.id) : request.memberIds, household);
    await respond(`${item.name} is now ${describeParts(item, household, member.id)}.`);
    if (household.groupChatId === UNBOUND_GROUP) {
      await relayToOthers(household, member.id, `${member.name} changed ${item.name}: it's now ${describeParts(item, household)}.`, `split:${msg.messageId}`);
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
      else if (result?.kind === "picked") await addToCart(result.product, result.shared, "Added", result.overBudget, result.splitWith);
      else if (result?.kind === "cancelled") await respond("OK, I didn't add that one.");
      if (result && result.kind !== "invalid" && result.next) await respond(result.next);
      return;
    }
  }

  // "contact" / "save contact": a link to save this Restock number as "restock", with the logo.
  if (isContactRequest(msg.text)) {
    await respond(contactReply(msg.agentLine ?? lineFor(msg.fromPhone)));
    return;
  }

  // Changing who pays for an item already in the cart ("just me and Alex", "everyone", "not me"):
  // handled in code against the household's members, before any AI parsing.
  const splitCommand = parseSplitCommand(msg.text, household, member);
  if (splitCommand) {
    await changePayers(splitCommand);
    return;
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
  // "add oat milk for me and Jake": who it's for also comes from their own words, read by code.
  const splitAsk = parseSplitInAdd(msg.text, household, member);
  const payers =
    splitAsk?.request.kind === "group" ? splitAsk.request.memberIds
    : splitAsk?.request.kind === "everyone" ? household.members.map((m) => m.id)
    : undefined;

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
      let requested = stripDealWords(stripUsual(intent.itemName) || intent.itemName);
      if (splitAsk) requested = requested.replace(new RegExp(`\\s*${escapeRegExp(splitAsk.phrase)}$`, "i"), "").trim() || requested;
      if (splitAsk?.request.kind === "unclear") {
        await respond(unclearReply(splitAsk.request.words, household, requested));
        continue;
      }
      const match = await matchItem(requested);
      if (!match) {
        // Not in the demo catalog. With store prices on, search the stores for what they asked for: the member
        // still picks from real listings, and nothing is added until they do.
        const offCatalog = liveDealsEnabled() ? offCatalogProduct(requested) : undefined;
        // "The usual": re-add last time's listing at today's price, like catalog items.
        const usualListing = usual && offCatalog ? lastBought(household.id, offCatalog) : undefined;
        if (offCatalog && usualListing?.store) {
          const fresh = await currentListing(usualListing, offCatalog);
          if (fresh) {
            await addToCart(fresh, intent.shared, "Added your usual:", undefined, payers);
            continue;
          }
        }
        const choice = offCatalog ? await buildDealChoice(household.id, offCatalog, intent.shared, dealOptions, member.id) : undefined;
        if (choice?.checkedAt && choice.options.length) {
          if (usualListing) choice.note = `Your usual, ${usualListing.name}, isn't listed right now. Here are today's store prices.`;
          else if (usual) choice.note = `I don't see an earlier order for ${requested}, so here are the options.`;
          if (payers) choice.splitWith = payers;
          choices.push(choice);
        } else {
          await respond(liveDealsEnabled()
            ? "I couldn’t find store listings for that right now. Try another household item name?"
            : "I couldn’t find that in the demo catalog. Try another household item name?");
        }
        continue;
      }
      // Real prices first: when store prices are on, the usual and specific requests use today's listings too,
      // and the demo catalog price is the fallback when there are none.
      const liveChoice = async (note?: string) => {
        if (!liveDealsEnabled()) return false;
        const choice = await buildDealChoice(household.id, match.product, intent.shared, dealOptions, member.id);
        if (!choice.checkedAt) return false; // no store listings: fall back
        if (note) choice.note = note;
        if (payers) choice.splitWith = payers;
        choices.push(choice);
        return true;
      };
      const usualProduct = usual ? lastBought(household.id, match.product) : undefined;
      if (usualProduct?.store) {
        // Last time it was a store listing: re-add it at today's price, or show today's listings.
        const fresh = await currentListing(usualProduct, match.product);
        if (fresh) await addToCart(fresh, intent.shared, "Added your usual:", undefined, payers);
        else if (!(await liveChoice(`Your usual, ${usualProduct.name}, isn't listed right now. Here are today's store prices.`))) {
          await addToCart(usualProduct, intent.shared, "Added your usual (last time's price):", undefined, payers);
        }
      } else if (usualProduct) {
        if (!(await liveChoice(`Last time you got ${usualProduct.name}. Here are today's store prices.`))) {
          await addToCart(usualProduct, intent.shared, "Added your usual:", undefined, payers);
        }
      } else if (namedSpecifically(requested, match.product)) {
        if (!(await liveChoice())) await addToCart(match.product, intent.shared, "Added", undefined, payers);
      } else {
        if (usual) await respond(`I don't see an earlier order for ${requested}, so here are the options.`);
        const choice = await buildDealChoice(household.id, match.product, intent.shared, dealOptions, member.id);
        if (payers) choice.splitWith = payers;
        choices.push(choice);
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
        delete item.splitWith; // "shared"/"personal" replace any earlier "just me and Jake"
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
        await respond("Only the budget owner can invite or remove people.");
      } else if (!name) {
        await respond(`Who should I ${intent.type === "add_member" ? "invite" : "remove"}? Use their first name.`);
      } else if (intent.type === "add_member" && !heldPhone) {
        await respond(`What's ${name}'s phone number? Text "invite ${name} <phone number>".`);
      } else if (intent.type === "add_member") {
        proposeAction(msg.fromPhone, { kind: "membership", command: { type: "add_member", name, phone: heldPhone! } });
        await respond(`Invite ${name} (phone ending ${heldPhone!.slice(-4)}) to the household? Reply "yes" to confirm or "no" to cancel.`);
      } else if (!household.members.some((m) => m.name.toLowerCase() === name.toLowerCase()) && !invitedTo(household.id).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
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
  const line = lineFor(member.phone);
  const saveMe = line && isRestockLine(line) ? `\nSave me as "${CONTACT_NAME}" in your contacts: ${contactLink(line)}` : "";
  if (!joined) {
    const link = `${config.publicBaseUrl}/join/${inviteCodeFor(household, member.id)}`;
    await respond(
      `Welcome to Restock, ${member.name}! Your household is set up and you're the budget owner.\n` +
        `Invite roommates with this link: ${link}\n` +
        `Text what you need anytime ("we're out of TP"), and text "add card" so orders can go through.${saveMe}`,
    );
    return;
  }
  await respond(
    `Welcome, ${member.name}! You're in ${owner?.name ?? "your"}'s household.\n` +
      `Text what you need ("we're out of TP"), "what do I owe?", or "help". No card needed to join; text "add card" anytime.${saveMe}`,
  );
  await relayToOthers(household, member.id, `${member.name} joined the household.`, `joined:${member.id}`);
}

/** "contact", "save contact", "add contact", "contact card", "vcard". */
export function isContactRequest(text: string): boolean {
  return /^(?:(?:save|add|get|send)\s+(?:me\s+)?)?(?:your\s+|the\s+|a\s+|restock'?s?\s+)?(?:contact(?:\s+(?:card|info))?|vcard)[.!?]*$/i.test(text.trim());
}

/** The reply with the contact link, or a plain fallback when we don't know which Restock number this is. */
export function contactReply(line: string | undefined): string {
  return line && isRestockLine(line)
    ? `Tap to save me as "${CONTACT_NAME}" in your contacts: ${contactLink(line)}`
    : `Save this number in your contacts as "${CONTACT_NAME}" so you can find me easily.`;
}

/** A first text that's only a greeting ("hi", "hey!"), so there's nothing else to act on after the welcome. */
function isGreeting(text: string): boolean {
  return /^(?:hi+|hey+|hello|hiya|yo|sup|howdy|hi there|hello there|start|join|ok|okay)[\s!.?]*$/i.test(text.trim());
}

/** "Alex", "Alex and Sam", "Alex, Sam and Jo". */
function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "Abdul hasn't texted me…" / "Abdul and David haven't texted me…" */
export function waitingForDm(names: string[]): string {
  const who = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const verb = names.length === 1 ? "hasn't" : "haven't";
  return `${who} ${verb} texted me directly yet. I'll send their private messages as soon as they do.`;
}

/** The "how to change it" hint after adding an item. Shared items also show how to name people. */
function changeHint(item: Item, household: Household, senderId: string): string {
  if (item.splitWith?.length) return `Reply "everyone" or "just me" to change.`;
  if (!item.shared) return `Reply "shared" to change.`;
  const other = household.members.find((m) => m.id !== senderId);
  return other
    ? `Reply "personal", or "just me and ${other.name.split(/\s+/)[0]}" to split it with some people.`
    : `Reply "personal" to change.`;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
