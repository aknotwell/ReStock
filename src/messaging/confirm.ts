// Confirm-to-act: when Claude reads a casual message as a sensitive action (placing an
// order, changing who's in the household), Restock asks back and only the person's explicit "yes" runs it.
// The model can propose; it can never act. One pending question per phone number, expiring after 10 minutes.
import { registerState } from "../core/persist.js";
import type { MembershipCommand } from "./membership.js";

export const CONFIRM_TTL_MS = 10 * 60 * 1000;

/** `householdId`: the cart they were shown and said yes to (they may be in several). */
export type ConfirmAction = { kind: "order"; householdId?: string } | { kind: "membership"; command: MembershipCommand };
type Pending = { action: ConfirmAction; expires: number };

const pending = new Map<string, Pending>(); // key: sender phone

registerState("confirmations", {
  dump: () => [...pending],
  load: (data) => {
    pending.clear();
    for (const [k, p] of data as [string, Pending][]) if (p.expires > Date.now()) pending.set(k, p);
  },
});

export function proposeAction(phone: string, action: ConfirmAction, now = Date.now()): void {
  pending.set(phone, { action, expires: now + CONFIRM_TTL_MS });
}

/** The live pending action for this phone, if any (expired ones are dropped). */
export function peekAction(phone: string, now = Date.now()): ConfirmAction | undefined {
  const p = pending.get(phone);
  if (!p) return undefined;
  if (p.expires <= now) {
    pending.delete(phone);
    return undefined;
  }
  return p.action;
}

export function clearAction(phone: string): void {
  pending.delete(phone);
}

/** Drop a pending order when the person has moved on. Membership questions stay until yes or no. */
export function clearOrderConfirmation(phone: string, now = Date.now()): void {
  if (peekAction(phone, now)?.kind === "order") clearAction(phone);
}

export function resetConfirmations(): void {
  pending.clear();
}

// "yes, delete" / "yes remove them" also count, so the owner can answer a removal warning in its own words.
const YES = /^(?:yes|y|yep|yeah|yup|sure|confirm|confirmed|do it|go ahead|ok|okay)(?:,?\s+(?:delete|remove)(?:\s+(?:it|them|everyone|anyway))*)?[.!]*$/i;
const NO = /^(?:no|n|nope|nah|cancel|never ?mind|stop|don't)[.!]*$/i;
export const isYes = (text: string) => YES.test(text.trim());
export const isNo = (text: string) => NO.test(text.trim());
