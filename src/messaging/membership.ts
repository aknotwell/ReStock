// Owner: Person 1. Chat commands for starting a household and managing who's in it.
// Deterministic and authorized in code (owner-only changes); the AI never decides membership.
import { addMember, cleanName, createHousehold, MembershipError, normalizePhone, removeMember } from "../core/households.js";
import type { Household, Member } from "../types.js";

export type MembershipCommand =
  | { type: "start"; name: string | null }
  | { type: "add_member"; name: string; phone: string }
  | { type: "remove_member"; name: string }
  | { type: "members" };

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
        await respond(`You're already in ${household.members.find((m) => m.id === household.ownerId)?.name ?? "a"}'s household.`);
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
