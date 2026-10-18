// Owner: Person 1. Chat commands for starting a household and managing who's in it.
// Deterministic and authorized in code (owner-only changes); the AI never decides membership.
import {
  activeHousehold, cleanHouseholdName, cleanName, createHousehold, findMyHousehold, householdName, MembershipError, normalizePhone, removeMember,
  setActiveHousehold,
} from "../core/households.js";
import { db, householdsForPhone } from "../core/store.js";
import type { Household, Member } from "../types.js";
import { cancelInvite, invitedTo, inviteCodeFor, inviteToHousehold, releaseLineFor, resetInvite } from "../core/signups.js";
import { LineUnavailableError } from "./photonLines.js";
import { deleteHousehold } from "../core/households.js";
import { openDebtsFor, owedTo } from "../core/ledger.js";
import { config } from "../config.js";
import { forgetHandle } from "./photon.js";
import { deleteStripeCustomer } from "../payments/deleteCustomer.js";

export type MembershipCommand =
  | { type: "start"; name: string | null; householdName?: string | null }
  | { type: "households" }
  | { type: "switch"; query: string }
  | { type: "rename"; name: string }
  | { type: "leave"; householdId?: string }
  | { type: "add_member"; name: string; phone: string }
  | { type: "remove_member"; name: string }
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
  if (householdsForPhone(member.phone).length) return;
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

/** The person's own name, from any household they're in (so starting another one doesn't ask again). */
const knownName = (phone: string) => householdsForPhone(phone).flatMap((h) => h.members).find((m) => m.phone === phone)?.name;

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

    // Not a member yet, but invited: take the invite back.
    if (!household.members.some((m) => m.name.toLowerCase() === command.name.trim().toLowerCase())) {
      const cancelled = await cancelInvite(household.id, command.name);
      if (cancelled) {
        await respond(`Cancelled ${cancelled}'s invite.`);
        return true;
      }
    }
    const removed = removeMember(household, command.name);
    await forgetPerson(removed);
    await respond(`Removed ${removed.name} from ${householdName(household)}.`);
    return true;
  } catch (err) {
    if (err instanceof MembershipError || err instanceof LineUnavailableError) {
      await respond(err.message);
      return true;
    }
    throw err;
  }
}

/** "+12065550142" -> "(206) 555-0142"; other numbers as they are. */
function prettyLine(line: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(line);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : line;
}
