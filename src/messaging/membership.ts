// Chat commands for starting a household and managing who's in it.
// Deterministic and authorized in code (owner-only changes); the AI never decides membership.
import {
  activeHousehold, cleanHouseholdName, cleanName, knownName, createHousehold, describeBalances, findMyHousehold, householdBalances, householdName,
  MembershipError, normalizePhone, removeEveryone, removeMember, setActiveHousehold,
} from "../core/households.js";
import { db, householdsForPhone } from "../core/store.js";
import type { Debt, Household, Member } from "../types.js";
import { cancelInvite, invitedTo, inviteCodeFor, inviteToHousehold, releaseLineFor, resetInvite } from "../core/signups.js";
import { LineUnavailableError } from "./photonLines.js";
import { deleteHousehold } from "../core/households.js";
import { openBalancesOf, openDebtsFor, owedTo } from "../core/ledger.js";
import { config } from "../config.js";
import { forgetHandle, sendPrivate } from "./photon.js";
import { proposeAction } from "./confirm.js";
import { removedFromHousehold } from "./templates.js";
import { deleteStripeCustomer } from "../payments/deleteCustomer.js";

export type MembershipCommand =
  | { type: "start"; name: string | null; householdName?: string | null }
  | { type: "households" }
  | { type: "switch"; query: string }
  | { type: "rename"; name: string }
  | { type: "leave"; householdId?: string }
  | { type: "add_member"; name: string; phone: string }
  // `confirmed`/`householdId`: set when the owner said "yes" to a warning about this household.
  | { type: "remove_member"; name: string; confirmed?: boolean; householdId?: string }
  | { type: "remove_everyone"; confirmed?: boolean; householdId?: string }
  | { type: "delete_household"; confirmed?: boolean; householdId?: string }
  | { type: "members" }
  | { type: "invite"; reset: boolean }
  | { type: "delete_self" };

export function parseMembershipCommand(text: string): MembershipCommand | undefined {
  const t = text.trim().replace(/[.!]+$/, "");
  // "start household as Alex", "new group called Soccer Team", "create another household named Maple House as Alex"
  const start = /^(?:start|create|make|new)\s+(?:a\s+|my\s+|another\s+|a\s+new\s+)?(?:new\s+)?(?:household|house|home|group)(?:\s+(?:called|named)\s+(.+?))?(?:\s+as\s+(.+))?$/i.exec(t);
  if (start) return { type: "start", name: start[2] ?? null, ...(start[1] ? { householdName: start[1] } : {}) };
  if (/^(?:(?:my|list|show(?: me)?(?: my)?|all)\s+)?(?:households|groups|spaces)\??$|^which (?:household|group)(?: am i in| is this)?\??$/i.test(t)) return { type: "households" };
  // Needs "to": "switch the chips to personal" isn't this. Unknown names fall through (handler returns false).
  const switchTo = /^(?:switch|change|go|move)\s+(?:back\s+)?to\s+(.+)$/i.exec(t);
  if (switchTo?.[1]) return { type: "switch", query: switchTo[1] };
  const rename = /^(?:rename|name)\s+(?:the\s+|this\s+|our\s+|my\s+)?(?:household|group|house)\s+(?:to\s+)?(.+)$/i.exec(t);
  if (rename?.[1]) return { type: "rename", name: rename[1] };
  if (/^leave (?:the |my |this )?(?:household|house|group)$/i.test(t)) return { type: "leave" };
  // "invite Amber 425-829-9688": a name followed by a phone number. "add member Amber …" and "add Amber …" still
  // work for anyone used to the old wording. The name must start with a letter, and the number must be a real
  // phone number, so "add 4242 4242…" is never this.
  const add = /^(?:invite|add)\s+(?:member\s+|roommate\s+)?(\p{L}[\p{L}'. -]{0,29}?)\s+(\+?[\d(][\d\s().-]{8,18}\d)$/iu.exec(t);
  if (add?.[1] && add[2] && normalizePhone(add[2])) return { type: "add_member", name: add[1], phone: add[2] };
  const remove = /^remove\s+(?:member|roommate)\s+(.+)$/i.exec(t);
  if (remove?.[1]) return { type: "remove_member", name: remove[1] };
  if (/^delete my (?:data|account|info)$/i.test(t)) return { type: "delete_self" };
  if (/^(?:remove|kick(?: out)?)\s+(?:everyone|everybody|all\s+(?:the\s+)?(?:members|roommates|people))(?:\s+else)?(?:\s+from\s+(?:the\s+|this\s+|my\s+|our\s+)?(?:household|group|house))?$/i.test(t)) {
    return { type: "remove_everyone" };
  }
  if (/^(?:delete|disband|close)\s+(?:the\s+|this\s+|my\s+|our\s+)?(?:household|group|house)$/i.test(t)) return { type: "delete_household" };
  const invite = /^(reset\s+)?invite(?:\s+link)?$|^(?:get|send)\s+(?:me\s+)?(?:an?\s+|the\s+)?invite(?:\s+link)?$/i.exec(t);
  if (invite) return { type: "invite", reset: !!invite[1] };
  if (/^(?:members|roommates|who(?:'s| is) in (?:the |my |our )?(?:house(?:hold)?|home|group)\??)$/i.test(t)) return { type: "members" };
  return undefined;
}

type Ctx = {
  command: MembershipCommand;
  fromPhone: string;
  spaceKind: "direct" | "group";
  household: Household | undefined;
  member: Member | undefined;
  respond: (text: string) => Promise<void>;
};

/**
 * Someone left Restock: release their Restock number in Photon, drop what Photon told us about them, and
 * delete their Stripe customer so their saved card goes too. Failures are retried by the sweep.
 */
async function forgetPerson(member: Member): Promise<void> {
  // Each household membership has its own Stripe customer. Their number stays while they're in another household.
  if (member.stripeCustomerId) await deleteStripeCustomer(member.stripeCustomerId);
  // Keep their number while money is still owed to or by them: logging in to pay back texts them a code.
  if (householdsForPhone(member.phone).length || openBalancesOf([member.id]).length) return;
  forgetHandle(member.phone);
  await releaseLineFor(member.phone);
}

/** Why this member can't leave this household yet, or undefined if they can. */
function blockedLeaving(household: Household, member: Member): string | undefined {
  const others = household.members.filter((m) => m.id !== member.id);
  if (member.id === household.ownerId && others.length) {
    return `You're the budget owner of ${householdName(household)}, so remove the others first ("remove member ${others[0]!.name}").`;
  }
  if (openDebtsFor(member.id).length || owedTo(member.id).length) {
    return `You still have an open balance in ${householdName(household)}. Settle up first (text "what do I owe?").`;
  }
  return undefined;
}

function leave(household: Household, member: Member): void {
  if (member.id === household.ownerId) deleteHousehold(household);
  else removeMember(household, member.name);
}


function householdList(phone: string): string {
  const current = activeHousehold(phone);
  return householdsForPhone(phone)
    .map((h, i) => `${i + 1}. ${householdName(h)}${h.id === current?.id ? " (texts here go to this one)" : ""}`)
    .join("\n");
}

const last4 = (phone: string) => `phone ending ${phone.slice(-4)}`;

/** Handles a membership command. Returns true if it replied (the caller stops processing). */
export async function handleMembershipCommand({ command, fromPhone, spaceKind, household, member, respond }: Ctx): Promise<boolean> {
  try {
    if (command.type === "start") {
      if (spaceKind !== "direct") {
        await respond("Text me directly to start a household.");
        return true;
      }
      const name = command.name ? cleanName(command.name) : knownName(fromPhone);
      if (!name) {
        await respond('What should I call you? Text "start household as <your first name>", e.g. "start household as Alex".');
        return true;
      }
      const title = command.householdName ? cleanHouseholdName(command.householdName) : undefined;
      if (command.householdName && !title) {
        await respond('Household names can be up to 30 letters or numbers, like "new household called Maple House".');
        return true;
      }
      const created = createHousehold(name, fromPhone, title ? { name: title } : {});
      const switchBack = householdsForPhone(fromPhone).length > 1
        ? `\nTexts to me now go to ${householdName(created)}. Text "households" to see all of yours, or "switch to <name>" to change.`
        : "";
      await respond(
        `Done, ${name}! You started ${householdName(created)} and you're the budget owner.\n` +
          `Invite roommates: "invite <first name> <phone number>", or text "invite" for a link to share.\n` +
          `Add your card for this household so orders can go through: "add card".` +
          (title ? "" : '\nName it anytime: "rename household Maple House".') +
          switchBack,
      );
      return true;
    }

    if (command.type === "households") {
      if (!householdsForPhone(fromPhone).length) {
        await respond('You\'re not in a household yet. Text "start household as <your name>" to start one.');
        return true;
      }
      await respond(`Your households:\n${householdList(fromPhone)}\nText "switch to <name or number>" to change where your texts go, or "new household" to start another.`);
      return true;
    }

    if (command.type === "switch") {
      const target = findMyHousehold(fromPhone, command.query);
      if (!target) {
        // Not one of theirs: only answer when they clearly meant a household, so "switch to oat milk" isn't swallowed.
        if (!/\b(?:household|group|house)\b/i.test(command.query) || !householdsForPhone(fromPhone).length) return false;
        await respond(`I couldn't find that one. Your households:\n${householdList(fromPhone)}`);
        return true;
      }
      if (spaceKind !== "direct") {
        await respond("Text me directly to switch households. This group chat always uses its own household.");
        return true;
      }
      setActiveHousehold(fromPhone, target.id);
      const cart = [...db.items.values()].filter((i) => i.householdId === target.id && i.status === "pending").length;
      await respond(`Switched to ${householdName(target)}. Texts to me now go there. ${cart ? `Its cart has ${cart} item${cart === 1 ? "" : "s"}.` : "Its cart is empty."}`);
      return true;
    }

    // Everything else needs an existing household.
    if (!household || !member) {
      await respond('You\'re not in a household yet. Text "start household as <your name>" to start one, or ask your household\'s budget owner to invite you.');
      return true;
    }

    if (command.type === "members") {
      const lines = household.members.map(
        (m) => `• ${m.name}${m.id === household.ownerId ? " (budget owner)" : ""}${m.paymentMethodId ? ", card on file" : ", no card yet"}`,
      );
      const invited = invitedTo(household.id).map((p) => p.name);
      const waiting = invited.length ? `\nInvited, waiting for them to text: ${invited.join(", ")}` : "";
      await respond(`${household.name ?? "Your household"}:\n${lines.join("\n")}${waiting}`);
      return true;
    }

    if (command.type === "rename") {
      if (member.id !== household.ownerId) {
        await respond("Only the budget owner can rename the household.");
        return true;
      }
      const title = cleanHouseholdName(command.name);
      if (!title) {
        await respond('Household names can be up to 30 letters or numbers, like "rename household Maple House".');
        return true;
      }
      household.name = title;
      await respond(`Renamed it to ${title}.`);
      return true;
    }

    if (command.type === "leave") {
      // Runs only after the person's explicit "yes" (inbound asks first), for the household they were asked about.
      const target = (command.householdId && db.households.get(command.householdId)) || household;
      const me = target.members.find((m) => m.phone === fromPhone);
      if (!me) {
        await respond("You're not in that household anymore.");
        return true;
      }
      const blocked = blockedLeaving(target, me);
      if (blocked) {
        await respond(`${blocked} Then text "leave household" again.`);
        return true;
      }
      leave(target, me);
      const next = activeHousehold(fromPhone);
      const where = next ? ` Texts to me now go to ${householdName(next)}.` : "";
      try {
        await respond(
          next
            ? `Done. You've left ${householdName(target)} and its saved card is removed.${where}`
            : "Done. You've left your household, your Restock number is released, and any saved card is removed. " +
                `You won't get more texts from me. To come back, sign up again at ${config.publicBaseUrl}/start.`,
        );
      } finally {
        await forgetPerson(me);
      }
      return true;
    }

    if (command.type === "delete_self") {
      // Runs only after the person's explicit "yes" (inbound asks first). Plain code; leaves every household,
      // frees their Photon line and deletes their Stripe customers (and saved cards).
      const memberships = householdsForPhone(fromPhone).map((h) => ({ household: h, me: h.members.find((m) => m.phone === fromPhone)! }));
      const blocked = memberships.map(({ household: h, me }) => blockedLeaving(h, me)).find(Boolean);
      if (blocked) {
        await respond(`${blocked} Then text "delete my data" again.`);
        return true;
      }
      for (const { household: h, me } of memberships) leave(h, me);
      // Confirm before releasing their Restock number: once Photon releases it, texts on it can't reach them.
      try {
        await respond(
          `Done. Your Restock data is deleted: you've left ${memberships.length > 1 ? "all your households" : "the household"}, your Restock number is released, and any saved card is removed. ` +
            `You won't get more texts from me. To come back, sign up again at ${config.publicBaseUrl}/start. Thanks for trying Restock!`,
        );
      } finally {
        for (const { me } of memberships) await forgetPerson(me);
      }
      return true;
    }

    if (command.type === "invite") {
      if (member.id !== household.ownerId) {
        await respond("Only the budget owner can invite people. Ask them for the invite link.");
        return true;
      }
      const code = command.reset ? resetInvite(household, member.id) : inviteCodeFor(household, member.id);
      await respond(
        `${command.reset ? "New invite link (the old one no longer works)" : "Your invite link"}: ${config.publicBaseUrl}/join/${code}\n` +
          `Share it with your roommates. It works for 7 days; text "reset invite" to turn it off.`,
      );
      return true;
    }

    // Inviting and removing people changes who shares the bill: owner only, checked here in code.
    if (command.type === "remove_everyone" || command.type === "delete_household" || command.type === "remove_member") {
      // After a "yes", act on the household the owner was warned about, even if they switched since.
      const target = command.householdId ? db.households.get(command.householdId) : household;
      if (!target) {
        await respond("That household is already gone.");
        return true;
      }
      const owner = target.members.find((m) => m.phone === fromPhone);
      if (!owner || owner.id !== target.ownerId) {
        await respond(
          command.type === "delete_household" ? "Only the budget owner can delete the household." : "Only the budget owner can invite or remove people.",
        );
        return true;
      }
      return await handleRemoval(command, target, owner, fromPhone, respond);
    }

    if (member.id !== household.ownerId) {
      await respond("Only the budget owner can invite or remove people.");
      return true;
    }

    if (command.type === "add_member") {
      const name = cleanName(command.name);
      const phone = normalizePhone(command.phone);
      if (!name || !phone) {
        await respond('I couldn\'t read that. Use "invite <first name> <phone number>", with a 10-digit US number.');
        return true;
      }
      // Reserves them a Restock number: Photon only accepts texts from phones that have one.
      const { line } = await inviteToHousehold(household, name, phone);
      await respond(
        `Invited ${name} (${last4(phone)}). Ask ${name} to text "hi" to ${prettyLine(line)}. That's their Restock number, ` +
          `and they'll join the household when they text it. I can't text them first. The invite lasts 7 days.`,
      );
      return true;
    }
    return false;
  } catch (err) {
    if (err instanceof MembershipError || err instanceof LineUnavailableError) {
      await respond(err.message);
      return true;
    }
    throw err;
  }
}

type Removal = Extract<MembershipCommand, { type: "remove_member" | "remove_everyone" | "delete_household" }>;
export type RemovalKind = "member" | "everyone" | "household";

/** Who would leave, the open debts involved, and the question to ask the owner. Shared by chat and the dashboard. */
export type RemovalPlan = { kind: RemovalKind; household: Household; owner: Member; leaving: Member[]; balances: Debt[]; question: string; warning: string };

/**
 * Work out a removal without doing it. Throws MembershipError if there's nobody to remove. Open debts never block
 * it: `warning` says who owes whom and recommends settling up first; the owner can still go ahead.
 */
export function planRemoval(kind: RemovalKind, household: Household, owner: Member, target?: Member): RemovalPlan {
  const title = householdName(household);
  if (kind === "member" && (!target || !household.members.includes(target))) throw new MembershipError(`I couldn't find that person in ${title}.`);
  if (kind === "member" && target!.id === owner.id) throw new MembershipError("The budget owner can't be removed.");
  const leaving = kind === "member" ? [target!] : household.members.filter((m) => m.id !== owner.id);
  if (kind === "everyone" && !leaving.length) throw new MembershipError(`There's nobody else in ${title} to remove.`);
  const affected = kind === "household" ? household.members : leaving;
  const balances = openBalancesOf(affected.map((m) => m.id));
  const names = leaving.map((m) => m.name).join(", ");
  const question =
    kind === "household"
      ? `Delete ${title}? This removes everyone${names ? ` (${names})` : ""}, clears the cart and can't be undone.`
      : kind === "everyone"
        ? `Remove everyone else from ${title} (${names})? You'll stay as the budget owner.`
        : `Remove ${names} from ${title}?`;
  const warning = balances.length
    ? `Heads up, there are open balances:\n${describeBalances(balances)}\n` +
      `I recommend settling up first (text "what do I owe?"). If you go ahead, these stay on the ledger and can still be paid back at ${config.publicBaseUrl}/pay.`
    : "";
  return { kind, household, owner, leaving, balances, question, warning };
}

/**
 * Do a planned removal: text each person who's leaving, take them out (debts stay on the ledger), cancel open
 * invites when removing everyone, and release what Restock holds for them. Returns the owner's confirmation.
 * `beforeForget` runs after the household change but before the owner's own records are released.
 */
export async function carryOutRemoval(plan: RemovalPlan, beforeForget: (done: string) => Promise<void>): Promise<void> {
  const { kind, household, owner, leaving } = plan;
  const title = householdName(household);
  // Tell each person first: once they're out of the household, Restock can't look up where to text them.
  for (const m of leaving) {
    const owes = openDebtsFor(m.id).reduce((sum, d) => sum + d.cents, 0);
    await sendPrivate(m.id, removedFromHousehold(owner.name, title, kind === "household", owes, `${config.publicBaseUrl}/pay`), `removed:${household.id}:${m.id}`).catch(
      (err) => console.warn("removal notice failed:", err instanceof Error ? err.message : err),
    );
  }
  if (kind !== "member") for (const p of invitedTo(household.id)) await cancelInvite(household.id, p.name);

  let done: string;
  if (kind === "member") {
    removeMember(household, leaving[0]!.name, { keepBalances: true });
    done = `Removed ${leaving[0]!.name} from ${title}.`;
  } else if (kind === "everyone") {
    removeEveryone(household);
    done = `Done. Removed ${leaving.map((m) => m.name).join(", ")} from ${title}. You're still its budget owner.`;
  } else {
    deleteHousehold(household);
    const next = activeHousehold(owner.phone);
    done = `Done. ${title} is deleted and its cart is cleared.` + (next ? ` Texts to me now go to ${householdName(next)}.` : ` To start a new one, sign up again at ${config.publicBaseUrl}/start.`);
  }
  try {
    await beforeForget(done);
  } finally {
    for (const m of kind === "household" ? [...leaving, owner] : leaving) await forgetPerson(m);
  }
}

/**
 * The owner removing one person, everyone, or deleting the whole household by text. Removing everyone and
 * deleting always ask first; removing one person asks first when money is still owed. The owner has to say
 * "yes" to go ahead. The debts stay on the ledger and can still be paid back.
 */
async function handleRemoval(command: Removal, household: Household, owner: Member, fromPhone: string, respond: (text: string) => Promise<void>): Promise<boolean> {
  let target: Member | undefined;
  if (command.type === "remove_member") {
    target = household.members.find((m) => m.name.toLowerCase() === command.name.trim().toLowerCase());
    // Not a member yet, but invited: take the invite back.
    if (!target) {
      const cancelled = await cancelInvite(household.id, command.name);
      await respond(cancelled ? `Cancelled ${cancelled}'s invite.` : `I couldn't find ${command.name.trim()} in your household.`);
      return true;
    }
  }
  const kind: RemovalKind = command.type === "remove_member" ? "member" : command.type === "remove_everyone" ? "everyone" : "household";
  const plan = planRemoval(kind, household, owner, target);
  if ((kind !== "member" || plan.balances.length) && !command.confirmed) {
    proposeAction(fromPhone, { kind: "membership", command: { ...command, confirmed: true, householdId: household.id } });
    const verb = kind === "household" ? "delete it" : "remove";
    await respond(
      `${plan.question}${plan.warning ? `\n${plan.warning}` : ""}\nReply "yes" to ${plan.balances.length ? `${verb} anyway` : "confirm"} or "no" to cancel.`,
    );
    return true;
  }
  await carryOutRemoval(plan, respond);
  return true;
}

/** "+12065550142" -> "(206) 555-0142"; other numbers as they are. */
function prettyLine(line: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(line);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : line;
}
