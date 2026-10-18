// The pay-back site (/pay) for members who owe the main card and have no card on file.
//
// 1. Log in: they type their phone number and we text a 6-digit code through Restock. No passwords.
// 2. They see only their own open debts.
// 3. Paying opens a Stripe Checkout `payment` session. The card is typed on Stripe's page, never ours.
//    They can also save the card so their share is charged automatically from the next order on.
// 4. Stripe's webhook marks the debt paid and texts the person who was paid back.
import { createHash, randomInt, randomBytes, timingSafeEqual } from "node:crypto";
import type Stripe from "stripe";
import { config } from "../config.js";
import { markDebtPaid, openDebtsFor } from "../core/ledger.js";
import { db, findMember } from "../core/store.js";
import { registerState } from "../core/persist.js";
import { canTextPrivately, sendPrivate } from "../messaging/photon.js";
import { fmt, paidBack } from "../messaging/templates.js";
import type { Debt, Member } from "../types.js";
import { claimDebtsForNewPage, ensureStripeCustomer, registerPayBackPage } from "./links.js";
import { requireStripe } from "./stripe.js";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_CODE_TRIES = 5;

// Saved with the rest of the store so a deploy doesn't log everyone out. Only hashes are kept:
// the saved database never holds a usable login code or session token.
const codes = new Map<string, { code: string; expiresAt: number; tries: number }>(); // memberId -> sha256(code)
const sessions = new Map<string, { memberId: string; expiresAt: number }>(); // sha256(token) -> member
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
registerState("login", {
  dump: () => ({ codes: [...codes], sessions: [...sessions] }),
  load: (data) => {
    const saved = data as { codes?: [string, { code: string; expiresAt: number; tries: number }][]; sessions?: [string, { memberId: string; expiresAt: number }][] };
    const now = Date.now();
    codes.clear();
    sessions.clear();
    for (const [k, v] of saved.codes ?? []) if (v.expiresAt > now) codes.set(k, v);
    for (const [k, v] of saved.sessions ?? []) if (v.expiresAt > now) sessions.set(k, v);
  },
});

/** Match what someone typed to a member: phone numbers by their last 10 digits, iMessage emails exactly. */
export function findMemberByHandle(input: string): Member | undefined {
  const typed = input.trim().toLowerCase();
  const digits = typed.replace(/\D/g, "");
  for (const household of db.households.values()) {
    for (const m of household.members) {
      const handle = m.phone.toLowerCase();
      if (typed.includes("@") ? handle === typed : digits.length >= 10 && handle.replace(/\D/g, "").endsWith(digits.slice(-10))) return m;
    }
  }
  return undefined;
}

/**
 * Make a fresh login code for this member and hand the text carrying it to `send`. The new code replaces
 * any earlier one, but if sending fails the earlier code is put back, so a code they already have keeps working.
 */
export async function sendLoginCode(member: Member, send: (text: string) => Promise<unknown>, now = Date.now()): Promise<void> {
  const previous = codes.get(member.id);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const entry = { code: hash(code), expiresAt: now + CODE_TTL_MS, tries: 0 };
  codes.set(member.id, entry);
  try {
    await send(`Your Restock code is ${code}. It expires in 10 minutes. Don't share it with anyone.`);
  } catch (err) {
    if (codes.get(member.id) === entry) {
      if (previous) codes.set(member.id, previous);
      else codes.delete(member.id);
    }
    throw err;
  }
}

/**
 * Text a login code to the member with this phone number. Says nothing about whether the number
 * belongs to anyone, so the site can't be used to look people up. Restock can't text someone first, so
 * if they've never texted it one-on-one the code isn't held for later (it would expire and the group would
 * be nudged); the page tells them to text "code" instead, and that reply carries one.
 */
export async function startLogin(handle: string, now = Date.now()): Promise<void> {
  const member = findMemberByHandle(handle);
  if (!member) {
    console.log("login code: no member with that number");
    return;
  }
  const last4 = member.phone.slice(-4);
  if (!canTextPrivately(member.phone)) {
    console.log(`login code: not sent to …${last4}, no one-on-one chat with Restock yet (or they texted STOP). They can text "code".`);
    return;
  }
  try {
    await sendLoginCode(member, (text) => sendPrivate(member.id, text, `login:${member.id}:${now}`), now);
  } catch (err) {
    console.log(`login code: failed to send to …${last4}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  console.log(`login code: sent to …${last4}`);
}

/** Check the code. Returns a session token on success. A code works once and only for a few tries. */
export function verifyLogin(handle: string, code: string, now = Date.now()): string | undefined {
  const member = findMemberByHandle(handle);
  const entry = member && codes.get(member.id);
  if (!member || !entry || entry.expiresAt < now) return undefined;
  entry.tries += 1;
  if (entry.tries > MAX_CODE_TRIES) {
    codes.delete(member.id);
    return undefined;
  }
  const given = Buffer.from(hash(code.trim()));
  const want = Buffer.from(entry.code);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
  codes.delete(member.id);
  const token = randomBytes(24).toString("base64url");
  sessions.set(hash(token), { memberId: member.id, expiresAt: now + SESSION_TTL_MS });
  return token;
}

export function sessionMember(token: string | undefined, now = Date.now()): Member | undefined {
  const s = token ? sessions.get(hash(token)) : undefined;
  if (!s || s.expiresAt < now) return undefined;
  return findMember(s.memberId)?.member;
}

export function logout(token: string | undefined): void {
  if (token) sessions.delete(hash(token));
}

export type DebtView = { id: string; to: string; cents: number; amount: string; orderDate?: string };

/** The logged-in member's open debts, with who they owe. Nothing about anyone else. */
export function myDebts(member: Member): DebtView[] {
  return openDebtsFor(member.id).map((d) => ({
    id: d.id,
    to: findMember(d.creditorId)?.member.name ?? "your household",
    cents: d.cents,
    amount: fmt(d.cents),
    orderDate: db.orders.get(d.orderId)?.createdAt,
  }));
}

/** Stripe Checkout session for one of the member's own open debts. Returns the URL to send them to. */
export async function createPayBackCheckout(member: Member, debtId: string, saveCard: boolean): Promise<string> {
  const debt = db.debts.get(debtId);
  if (!debt || debt.debtorId !== member.id || debt.status !== "open") throw new Error("That pay-back isn't open for you.");
  // Cancel any other open page that could pay this debt (a texted pay link, or an earlier click here).
  const [claimable] = await claimDebtsForNewPage([debt.id]);
  if (!claimable) throw new Error("That pay-back was just paid.");
  const creditor = findMember(debt.creditorId)?.member;
  const customer = await ensureStripeCustomer(member);
  const metadata = { debtId: debt.id, memberId: member.id };
  const session = await requireStripe().checkout.sessions.create({
    mode: "payment",
    customer,
    client_reference_id: member.id,
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: debt.cents, product_data: { name: `Pay ${creditor?.name ?? "your household"} back` } } }],
    payment_intent_data: { metadata, ...(saveCard ? { setup_future_usage: "off_session" as const } : {}) },
    metadata: { ...metadata, saveCard: saveCard ? "1" : "0" },
    success_url: `${config.publicBaseUrl}/pay/success`,
    cancel_url: `${config.publicBaseUrl}/pay`,
  });
  if (!session.url) throw new Error("Stripe returned a Checkout session without a URL");
  registerPayBackPage(session.id, [debt.id]);
  return session.url;
}

/**
 * Webhook: a pay-back Checkout session finished. Marks the debt paid, saves the card if they asked,
 * and texts the person who was paid back. Idempotent: a repeated event finds the debt already paid.
 */
export async function settlePayBack(session: Stripe.Checkout.Session): Promise<"paid" | "already_paid" | "unknown_debt"> {
  const debtId = session.metadata?.debtId;
  const debt: Debt | undefined = debtId ? db.debts.get(debtId) : undefined;
  if (!debt || session.metadata?.memberId !== debt.debtorId) return "unknown_debt";
  if (debt.status === "paid") return "already_paid";
  markDebtPaid(debt.id);

  const debtor = findMember(debt.debtorId)?.member;
  if (debtor && session.metadata?.saveCard === "1" && session.payment_intent) {
    const intentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id;
    const intent = await requireStripe().paymentIntents.retrieve(intentId, { expand: ["payment_method"] });
    const pm = intent.payment_method;
    if (pm && typeof pm !== "string" && pm.card) {
      // TODO: replace with an updateMember() in store.ts once there is one.
      if (typeof session.customer === "string") debtor.stripeCustomerId = session.customer;
      debtor.paymentMethodId = pm.id;
      debtor.cardLast4 = pm.card.last4;
    }
  }
  if (debtor) {
    await sendPrivate(debt.creditorId, paidBack(debtor.name, debt.cents, 1), `paid-back:${debt.id}`).catch((err) =>
      console.warn("paid-back text failed:", err instanceof Error ? err.message : err),
    );
  }
  return "paid";
}

/** Test helper. */
export function resetPayBack(): void {
  codes.clear();
  sessions.clear();
}
