// Owner: Person 1. Pipeline: identify household + sender -> guard -> AI parse -> act -> reply.
import { matchItem } from "../ai/matchItem.js";
import { parseMessage } from "../ai/parseMessage.js";
import { addItem, findHouseholdByGroupChat, findMemberByPhone, householdsForPhone, UNBOUND_GROUP } from "../core/store.js";
import { OrderError, placeOrder } from "../core/orders.js";
import { createCardSetupLink } from "../payments/links.js";
import type { Household } from "../types.js";
import { checkInput } from "../safety/guardrails.js";
import { reply, sendGroup, sendPrivate, type InboundMessage } from "./photon.js";
import { cardNumberWarning, fmt, groupSummary, helpMessage } from "./templates.js";

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
  const hit = checkInput(msg.text);
  if (hit?.reply) {
    await respond(hit.reply);
    return;
  }
  if (hit?.rule === "card_number") {
    const household = resolveHousehold(msg);
    const member = household && findMemberByPhone(household, msg.fromPhone);
    const link = member ? await createCardSetupLink(member.id) : undefined;
    const warning = cardNumberWarning(link ?? "ask your household's budget owner for an invite link");
    if (msg.spaceKind === "direct" || !member) await respond(warning);
    else await sendPrivate(member.id, warning, `card-guard:${msg.messageId}`);
    return;
  }

  const household = resolveHousehold(msg);
  const member = household && findMemberByPhone(household, msg.fromPhone);
  if (!household || !member) {
    // TODO(P1): join flow — create a Member with no card and send inviteToAddCard privately
    if (msg.spaceKind === "direct") await respond(`${helpMessage()}\nAsk your household's budget owner to add you to Restock.`);
    return;
  }

  // Group-wide news goes to the household chat once it's bound; otherwise answer where we were asked.
  const announce = (text: string) =>
    household.groupChatId === UNBOUND_GROUP ? respond(text) : sendGroup(household.id, text, `${msg.messageId}:${part++}`);

  // 2. Understand the message.
  const intents = await parseMessage(msg.text, member.name);

  // 3. Act. TODO(P1): remove_item, set_shared, what_do_i_owe, approve
  for (const intent of intents) {
    if (intent.type === "add_item" && intent.itemName) {
      const match = await matchItem(intent.itemName);
      if (!match) {
        await respond(`I couldn't find "${intent.itemName}" in the store. Try another name?`);
        continue;
      }
      const item = addItem({
        householdId: household.id,
        name: match.product.name,
        addedBy: member.id,
        cents: match.product.cents,
        shared: intent.shared ?? match.product.defaultShared,
      });
      await respond(
        `Added ${item.name} (${item.shared ? "shared" : "personal"}, ${fmt(item.cents)}). Reply "${item.shared ? "personal" : "shared"}" to change.`,
      );
    } else if (intent.type === "help") {
      await respond(helpMessage());
    } else if (intent.type === "order_now") {
      try {
        const result = await placeOrder(household.id);
        await announce(groupSummary(household, result));
        // TODO(P1): private receipts / "you owe" texts via sendPrivate + templates.ts
      } catch (err) {
        if (err instanceof OrderError) await respond(err.message);
        else throw err;
      }
    }
  }
}
