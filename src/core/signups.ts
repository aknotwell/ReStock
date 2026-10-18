// Owner: Person 1/4. Web sign-up and invite links.
//
// Flow: someone signs up on the web (to start a household, or through an owner's invite link) -> we assign
// their phone a Restock iMessage number (Photon shared line) -> they text "hi" to it -> that first text
// proves they own the phone and activates them. Unactivated sign-ups expire and free their line.
// Saved with the rest of the store (persist.ts). We keep names, phones and line IDs; never message text.
import { randomBytes } from "node:crypto";
import { addMember, ALREADY_USES_RESTOCK, cleanName, createHousehold, MembershipError, normalizePhone } from "./households.js";
import { registerState } from "./persist.js";
import { db, householdsForPhone } from "./store.js";
import { assignLine, releaseLine, releaseLinesForHandle } from "../messaging/photonLines.js";
import type { Household, Member } from "../types.js";

export const SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_OPEN_SIGNUPS = 20; // each holds one Photon seat (25 on the free plan)
export const MAX_MEMBERS = 9;

export class SignupError extends Error {}

type Invite = { code: string; householdId: string; createdBy: string; expiresAt: number };
type Pending = { phone: string; name: string; householdId: string | null; assignmentId: string; line: string; expiresAt: number };
type Line = { assignmentId: string; line: string };

const invites = new Map<string, Invite>(); // code -> invite (at most one live code per household)
const pending = new Map<string, Pending>(); // phone -> sign-up waiting for its first text
const lines = new Map<string, Line>(); // phone -> the Restock number this member texts
const unreleased = new Map<string, string>(); // assignmentId -> phone: deleted data whose Photon release failed, retried

registerState("signups", {
  dump: () => ({ invites: [...invites.values()], pending: [...pending.values()], lines: [...lines], unreleased: [...unreleased] }),
  load: (data) => {
    const d = data as { invites?: Invite[]; pending?: Pending[]; lines?: [string, Line][]; unreleased?: [string, string][] };
    invites.clear();
    pending.clear();
    lines.clear();
    unreleased.clear();
    for (const i of d.invites ?? []) invites.set(i.code, i);
    for (const p of d.pending ?? []) pending.set(p.phone, p);
    for (const [k, v] of d.lines ?? []) lines.set(k, v);
    for (const [k, v] of d.unreleased ?? []) unreleased.set(k, v);
  },
});

// ---------- Invites ----------

/** The household's live invite code, creating one if needed. Owner-only (checked by the caller). */
export function inviteCodeFor(household: Household, createdBy: string, now = Date.now()): string {
  for (const i of invites.values()) if (i.householdId === household.id && i.expiresAt > now) return i.code;
  return newInvite(household, createdBy, now);
}

/** Turn off the old link and make a new one ("reset invite link"). */
export function resetInvite(household: Household, createdBy: string, now = Date.now()): string {
  for (const [code, i] of invites) if (i.householdId === household.id) invites.delete(code);
  return newInvite(household, createdBy, now);
}

function newInvite(household: Household, createdBy: string, now: number): string {
  const code = randomBytes(12).toString("base64url"); // 96 bits: not guessable
  invites.set(code, { code, householdId: household.id, createdBy, expiresAt: now + INVITE_TTL_MS });
  return code;
}

export function householdForInvite(code: string, now = Date.now()): Household | undefined {
  const invite = invites.get(code);
  if (!invite || invite.expiresAt <= now) return undefined;
  return db.households.get(invite.householdId);
}

// ---------- Sign-up ----------

export type SignupResult = { line: string; householdName: string | null };

/**
 * Reserve a Restock number for this person. `inviteCode` = join that household; none = start a new one.
 * Nothing is created until they text the number (activateFromFirstText).
 */
export async function startSignup(input: { name: string; phone: string; inviteCode?: string }, now = Date.now()): Promise<SignupResult> {
  await sweepExpiredSignups(now); // frees the seats of sign-ups that never texted
  const name = cleanName(input.name);
  const phone = normalizePhone(input.phone);
  if (!name) throw new SignupError("Please enter your first name (letters only).");
  if (!phone) throw new SignupError("Please enter a 10-digit US mobile number.");
  if (householdsForPhone(phone).length) throw new SignupError(ALREADY_USES_RESTOCK);

  let household: Household | undefined;
  if (input.inviteCode) {
    household = householdForInvite(input.inviteCode, now);
    if (!household) throw new SignupError("This invite link has expired or was reset. Ask for a new one.");
    if (household.members.length >= MAX_MEMBERS) throw new SignupError("This household is full (9 people).");
    if (household.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      throw new SignupError(`There's already a ${name} in this household. Add your last initial, like "${name} B".`);
    }
  }

  const existing = pending.get(phone);
  if (!existing && pending.size >= MAX_OPEN_SIGNUPS) {
    throw new SignupError("Restock is at capacity for new sign-ups right now. Please try again later.");
  }
  // Reuse the line already reserved for this phone (signing up twice shouldn't use two seats).
  const assignment = existing ?? lines.get(phone) ?? (await assignLine(phone, name, signupKey(phone, now)));
  pending.set(phone, {
    phone,
    name,
    householdId: household?.id ?? null,
    assignmentId: assignment.assignmentId,
    line: assignment.line,
    expiresAt: now + SIGNUP_TTL_MS,
  });
  return { line: assignment.line, householdName: household ? ownerName(household) : null };
}

export type Activation = { household: Household; member: Member; joined: boolean };

/** The first text from a signed-up phone: create their household or add them to the invited one. */
export function activateFromFirstText(phone: string, now = Date.now()): Activation | undefined {
  const p = pending.get(phone);
  if (!p || p.expiresAt <= now) return undefined;
  pending.delete(phone);
  lines.set(phone, { assignmentId: p.assignmentId, line: p.line });
  try {
    if (!p.householdId) {
      const household = createHousehold(p.name, phone);
      return { household, member: household.members[0]!, joined: false };
    }
    const household = db.households.get(p.householdId);
    if (!household) return undefined;
    const member = addMember(household, p.name, phone);
    return { household, member, joined: true };
  } catch (err) {
    if (err instanceof MembershipError) return undefined; // e.g. the household filled up meanwhile
    throw err;
  }
}

export function isPendingSignup(phone: string, now = Date.now()): boolean {
  const p = pending.get(phone);
  return !!p && p.expiresAt > now;
}

export function lineFor(phone: string): string | undefined {
  return lines.get(phone)?.line ?? pending.get(phone)?.line;
}

/**
 * Forget a phone's line (leaving / deleting data) and release it in Photon too, so Photon no longer maps
 * this phone to a Restock number. Also releases any assignment for the phone we lost track of. A failed
 * release is kept and retried by the sweep, so deleting data never silently leaves the phone in Photon.
 */
export async function releaseLineFor(phone: string): Promise<void> {
  const held = lines.get(phone) ?? pending.get(phone);
  lines.delete(phone);
  pending.delete(phone);
  if (held && !(await releaseLine(held.assignmentId))) unreleased.set(held.assignmentId, phone);
  await releaseLinesForHandle(phone);
}

/** Release lines of sign-ups that were never activated, and retry failed releases. Runs on every sign-up and on a timer. */
export async function sweepExpiredSignups(now = Date.now()): Promise<number> {
  const expired = sweepExpiredSync(now);
  for (const p of expired) if (!(await releaseLine(p.assignmentId))) unreleased.set(p.assignmentId, p.phone);
  for (const [assignmentId, phone] of [...unreleased]) {
    // They signed up again meanwhile: that assignment may be in use again, so leave it alone.
    const inUse = lines.get(phone)?.assignmentId === assignmentId || pending.get(phone)?.assignmentId === assignmentId;
    if (inUse || (await releaseLine(assignmentId))) unreleased.delete(assignmentId);
  }
  return expired.length;
}

/** Photon releases still waiting for a retry (for tests and the health of "delete my data"). */
export const unreleasedLines = () => [...unreleased.keys()];

function sweepExpiredSync(now: number): Pending[] {
  const expired = [...pending.values()].filter((p) => p.expiresAt <= now);
  for (const p of expired) pending.delete(p.phone);
  for (const [code, i] of invites) if (i.expiresAt <= now) invites.delete(code);
  return expired;
}

// Dedupes a double-tapped "Get my number" but not a later sign-up: after "delete my data" releases the
// line, reusing a key Photon has already seen would hand back the released assignment.
const signupKey = (phone: string, now: number) => `restock-signup:${phone}:${Math.floor(now / 60_000)}`;

const ownerName = (h: Household) => `${h.members.find((m) => m.id === h.ownerId)?.name ?? "Your"}'s household`;

export function resetSignups(): void {
  invites.clear();
  pending.clear();
  lines.clear();
  unreleased.clear();
}
