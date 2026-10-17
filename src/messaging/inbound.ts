// Owner: Person 1. Pipeline: guard -> identify sender -> AI parse -> act -> reply.
import { matchItem } from "../ai/matchItem.js";
import { parseMessage } from "../ai/parseMessage.js";
import { addItem, findHouseholdByGroupChat, findMemberByPhone } from "../core/store.js";
import { OrderError, placeOrder } from "../core/orders.js";
import { createCardSetupLink } from "../payments/links.js";
import { containsCardNumber } from "./guard.js";
import { sendGroup, sendPrivate, type InboundMessage } from "./photon.js";
import { cardNumberWarning, fmt, groupSummary, helpMessage } from "./templates.js";

export async function handleInbound(msg: InboundMessage): Promise<void> {
  const household = findHouseholdByGroupChat(msg.groupChatId);
  if (!household) return; // TODO(P1): onboarding a new household

  const member = findMemberByPhone(household, msg.fromPhone);
  if (!member) {
    // TODO(P1): join flow — create a Member with no card, send inviteToAddCard privately
    return;
  }

  // 1. Card-number guard runs before anything else sees the text.
  if (containsCardNumber(msg.text)) {
    await sendPrivate(member.id, cardNumberWarning(await createCardSetupLink(member.id)));
    return;
  }

  // 2. Understand the message.
  const intents = await parseMessage(msg.text, member.name);

  // 3. Act. TODO(P1): remove_item, set_shared, what_do_i_owe, approve
  for (const intent of intents) {
    if (intent.type === "add_item" && intent.itemName) {
      const match = await matchItem(intent.itemName);
      if (!match) {
        await sendGroup(household.id, `I couldn't find "${intent.itemName}" in the store. Try another name?`);
        continue;
      }
      const item = addItem({
        householdId: household.id,
        name: match.product.name,
        addedBy: member.id,
        cents: match.product.cents,
        shared: intent.shared ?? match.product.defaultShared,
      });
      await sendGroup(
        household.id,
        `Added ${item.name} (${item.shared ? "shared" : "personal"}, ${fmt(item.cents)}). Reply "${item.shared ? "personal" : "shared"}" to change.`,
      );
    } else if (intent.type === "help") {
      await sendGroup(household.id, helpMessage());
    } else if (intent.type === "order_now") {
      try {
        const result = await placeOrder(household.id);
        await sendGroup(household.id, groupSummary(household, result));
        // TODO(P1): private receipts / "you owe" texts using templates.ts
      } catch (err) {
        if (err instanceof OrderError) await sendGroup(household.id, err.message);
        else throw err;
      }
    }
  }
}
