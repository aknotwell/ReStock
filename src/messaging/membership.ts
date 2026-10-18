// Owner: Person 1. Chat commands for starting a household and managing who's in it.
// Deterministic and authorized in code (owner-only changes); the AI never decides membership.
import { addMember, cleanName, createHousehold, MembershipError, normalizePhone, removeMember } from "../core/households.js";
import type { Household, Member } from "../types.js";
import { inviteCodeFor, releaseLineFor, resetInvite } from "../core/signups.js";
import { deleteHousehold } from "../core/households.js";
import { openDebtsFor, owedTo } from "../core/ledger.js";
import { config } from "../config.js";

export type MembershipCommand =
  | { type: "start"; name: string | null }
  | { type: "add_member"; name: string; phone: string }
  | { type: "remove_member"; name: string }
  | { type: "members" }
  | { type: "invite"; reset: boolean }
  | { type: "delete_self" };

export function parseMembershipCommand(text: string): MembershipCommand | undefined {
  const t = text.trim().replace(/[.!]+$/, "");
  const start = /^(?:start|create|make|new)\s+(?:a\s+|my\s+)?(?:household|house|home|group)(?:\s+as\s+(.+))?$/i.exec(t);
  if (start) return { type: "start", name: start[1] ?? null };
  // "add member Amber 425-829-9688" / "add Amber +14258299688": a name followed by a phone number.
  // The name must start with a letter, and the number must be a real phone number, so "add 4242 4242…" is never this.
  const add = /^add\s+(?:member\s+|roommate\s+)?(\p{L}[\p{L}'. -]{0,29}?)\s+(\+?[\d(][\d\s().-]{8,18}\d)$/iu.exec(t);
  if (add?.[1] && add[2] && normalizePhone(add[2])) return { type: "add_member", name: add[1], phone: add[2] };
  const remove = /^remove\s+(?:member|roommate)\s+(.+)$/i.exec(t);
  if (remove?.[1]) return { type: "remove_member", name: remove[1] };
  if (/^(?:delete my (?:data|account|info)|leave (?:the |my |this )?(?:household|house|group))$/i.test(t)) return { type: "delete_self" };
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

const last4 = (phone: string) => `phone ending ${phone.slice(-4)}`;

/** Handles a membership command. Returns true if it replied (the caller stops processing). */
export async function handleMembershipCommand({ command, fromPhone, spaceKind, household, member, respond }: Ctx): Promise<boolean> {
  try {
    if (command.type === "start") {
      if (member && household) {
        await respond(
          household.kind === "personal"
            ? 'You already have a personal space with me, and one-on-one texts go there. To start a household instead, text "delete my data" first.'
            : `You're already in ${household.members.find((m) => m.id === household.ownerId)?.name ?? "a"}'s household. Each number can be in one household for now.`,
        );
        return true;
      }
      if (spaceKind !== "direct") {
        await respond("Text me directly to start a household.");
        return true;
      }
      const name = command.name ? cleanName(command.name) : undefined;
      if (!name) {
        await respond('What should I call you? Text "start household as <your first name>", e.g. "start household as Alex".');
        return true;
      }
      createHousehold(name, fromPhone);
      await respond(
        `Done, ${name}! You started a household and you're the budget owner.\n` +
          `Add roommates: "add member <first name> <phone number>".\n` +
          `Add your card so orders can go through: "add card".`,
      );
      return true;
    }

    // Everything else needs an existing household.
    if (!household || !member) {
      await respond('You\'re not in a household yet. Text "start household as <your name>" to start one, or ask your household\'s budget owner to add you.');
      return true;
    }

    if (command.type === "members") {
      const lines = household.members.map(
        (m) => `• ${m.name}${m.id === household.ownerId ? " (budget owner)" : ""}${m.paymentMethodId ? ", card on file" : ", no card yet"}`,
      );
      await respond(`Your household:\n${lines.join("\n")}`);
      return true;
    }

    if (command.type === "delete_self") {
      // Runs only after the person's explicit "yes" (inbound asks first). Plain code; frees their Photon line.
      const others = household.members.filter((m) => m.id !== member.id);
      if (member.id === household.ownerId && others.length) {
        await respond(`You're the budget owner, so remove the others first ("remove member ${others[0]!.name}"), then text "delete my data" again.`);
        return true;
      }
      if (openDebtsFor(member.id).length || owedTo(member.id).length) {
        await respond("You still have an open balance. Settle up first (text \"what do I owe?\"), then text \"delete my data\" again.");
        return true;
      }
      if (member.id === household.ownerId) deleteHousehold(household);
      else removeMember(household, member.name);
      await releaseLineFor(fromPhone);
      await respond("Done. You've left Restock and your data is deleted. Thanks for trying it!");
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

    // Adding and removing people changes who shares the bill: owner only, checked here in code.
    if (member.id !== household.ownerId) {
      await respond("Only the budget owner can add or remove people.");
      return true;
    }

    if (command.type === "add_member") {
      const name = cleanName(command.name);
      const phone = normalizePhone(command.phone);
      if (!name || !phone) {
        await respond('I couldn\'t read that. Use "add member <first name> <phone number>", with a 10-digit US number.');
        return true;
      }
      const added = addMember(household, name, phone);
      await respond(
        `Added ${added.name} (${last4(added.phone)}). Ask ${added.name} to text "hi" to their Restock number to get started. ` +
          `I can't text them first.`,
      );
      return true;
    }

    const removed = removeMember(household, command.name);
    await respond(`Removed ${removed.name} from the household.`);
    return true;
  } catch (err) {
    if (err instanceof MembershipError) {
      await respond(err.message);
      return true;
    }
    throw err;
  }
}
