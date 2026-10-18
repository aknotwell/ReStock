// Owner: Person 3. Secure links texted to members. Card data only ever touches Stripe's pages.
import { randomInt } from "node:crypto";
import { config } from "../config.js";
import { registerState } from "../core/persist.js";
import { db, findMember } from "../core/store.js";
import type { Member } from "../types.js";
import { STRIPE_MIN_CHARGE_CENTS } from "./limits.js";
import { requireStripe } from "./stripe.js";

/** How long a texted add-card link keeps working. */
export const CARD_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Short-link token -> member. A random token keeps member IDs out of texted URLs.
// Saved to the database (see the registerState call below), so texted links survive a restart.
const cardLinkTokens = new Map<string, { memberId: string; expiresAt: number }>();

/**
 * Short link (/c/:token) that opens a Stripe Checkout session in `setup` mode (Apple Pay + card form).
 * No Stripe call happens here. The session is created when the link is tapped (see openCardSetupLink),
 * so a link sent hours earlier never points at an expired session, and texting a link never fails
 * because Stripe is slow.
 */
export async function createCardSetupLink(memberId: string, now = Date.now()): Promise<string> {
  if (!findMember(memberId)) throw new Error(`Unknown member ${memberId}`);
  const token = newLinkToken();
  cardLinkTokens.set(token, { memberId, expiresAt: now + CARD_LINK_TTL_MS });
  return `${config.publicBaseUrl}/c/${token}`;
}

/**
 * Called when a member taps /c/:token. Makes sure they have a Stripe Customer, then creates the
 * Checkout session and returns its URL to redirect to. Returns undefined for an unknown or expired token.
 */
export async function openCardSetupLink(token: string, now = Date.now()): Promise<string | undefined> {
  const entry = cardLinkTokens.get(token);
  if (!entry || entry.expiresAt < now) return undefined;
  const found = findMember(entry.memberId);
  if (!found) return undefined;

  const { member } = found;
  const customerId = await ensureStripeCustomer(member);
  const session = await requireStripe().checkout.sessions.create({
    mode: "setup",
    currency: "usd",
    allowed_payment_method_types: ["card"], // cards, plus Apple Pay / Google Pay wallets
    customer: customerId,
    client_reference_id: member.id,
    metadata: { memberId: member.id },
    setup_intent_data: { metadata: { memberId: member.id } },
    success_url: `${config.publicBaseUrl}/card/success`,
    cancel_url: `${config.publicBaseUrl}/cancel`,
  });
  if (!session.url) throw new Error("Stripe returned a Checkout session without a URL");
  return session.url;
}

/** Create the member's Stripe Customer the first time we need it. We send Stripe only their name. */
async function ensureStripeCustomer(member: Member): Promise<string> {
  if (member.stripeCustomerId) return member.stripeCustomerId;
  const customer = await requireStripe().customers.create(
    { name: member.name, metadata: { memberId: member.id } },
    // Two quick taps on the link must not create two customers.
    { idempotencyKey: `restock-customer-${member.id}` },
  );
  // TODO(P2): replace with an updateMember() in store.ts once there is one. Members are live objects
  // in the in-memory store, so setting the field saves it.
  member.stripeCustomerId = customer.id;
  return customer.id;
}

const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 22 random letters and digits (~131 bits). No "-" or "_": those could form something like "-pm_x",
 * which the outbound redact() filter would replace as a Stripe ID, breaking the link.
 */
function newLinkToken(): string {
  return Array.from({ length: 22 }, () => TOKEN_CHARS[randomInt(TOKEN_CHARS.length)]).join("");
}

/** Test helper: forget every issued token. */
export function resetCardLinks(): void {
  cardLinkTokens.clear();
}

/** Pay-back links stay valid longer than add-card links: people settle up when they get around to it. */
export const PAY_BACK_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Short-link token -> debt, and debt -> its Checkout session (so every tap reuses one payable page).
const payBackTokens = new Map<string, { debtId: string; expiresAt: number }>();
const payBackSessions = new Map<string, string>();

// Links already texted to people must keep working after a restart or redeploy.
type SavedLinks = {
  card: [string, { memberId: string; expiresAt: number }][];
  payBack: [string, { debtId: string; expiresAt: number }][];
  sessions: [string, string][];
};
registerState("payment-links", {
  dump: (): SavedLinks => ({ card: [...cardLinkTokens], payBack: [...payBackTokens], sessions: [...payBackSessions] }),
  load: (data) => {
    const saved = data as SavedLinks;
    const now = Date.now();
    cardLinkTokens.clear();
    payBackTokens.clear();
    payBackSessions.clear();
    for (const [token, link] of saved.card ?? []) if (link.expiresAt > now) cardLinkTokens.set(token, link);
    for (const [token, link] of saved.payBack ?? []) if (link.expiresAt > now) payBackTokens.set(token, link);
    for (const [debtId, sessionId] of saved.sessions ?? []) payBackSessions.set(debtId, sessionId);
  },
});

/**
 * Short link (/p/:token) for paying back an open debt. Like the add-card link, no Stripe call
 * happens until it's tapped (see openPayBackLink).
 */
export async function createPayBackLink(debtId: string, now = Date.now()): Promise<string> {
  if (!db.debts.has(debtId)) throw new Error(`Unknown debt ${debtId}`);
  const token = newLinkToken();
  payBackTokens.set(token, { debtId, expiresAt: now + PAY_BACK_LINK_TTL_MS });
  return `${config.publicBaseUrl}/p/${token}`;
}

export type PayBackPage =
  | { kind: "checkout"; url: string } // send them to Stripe
  | { kind: "paid" } // nothing left to pay
  | { kind: "too_small"; cents: number; creditorName: string } // under Stripe's $0.50 minimum
  | { kind: "not_found" }; // unknown or expired token

/**
 * Called when a debtor taps /p/:token. Returns where to send them. Every tap for the same debt
 * reuses one Checkout session while it's open, and a session can only be paid once, so tapping
 * twice (or opening two tabs) can't pay the debt twice.
 */
export async function openPayBackLink(token: string, now = Date.now()): Promise<PayBackPage> {
  const entry = payBackTokens.get(token);
  const debt = entry && entry.expiresAt >= now ? db.debts.get(entry.debtId) : undefined;
  if (!debt) return { kind: "not_found" };
  if (debt.status === "paid") return { kind: "paid" };

  const creditor = findMember(debt.creditorId)?.member;
  const debtor = findMember(debt.debtorId)?.member;
  if (!creditor || !debtor) return { kind: "not_found" };
  if (debt.cents < STRIPE_MIN_CHARGE_CENTS) return { kind: "too_small", cents: debt.cents, creditorName: creditor.name };

  const stripe = requireStripe();
  const existingId = payBackSessions.get(debt.id);
  if (existingId) {
    const existing = await stripe.checkout.sessions.retrieve(existingId);
    if (existing.status === "complete") return { kind: "paid" }; // paid; the webhook may still be on its way
    if (existing.status === "open" && existing.url) return { kind: "checkout", url: existing.url };
    // expired: make a new one below
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    allowed_payment_method_types: ["card"], // cards, plus Apple Pay / Google Pay wallets
    customer: debtor.stripeCustomerId, // prefills their details if they have one; optional
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: debt.cents,
          product_data: { name: `Pay ${creditor.name} back for your share of the household order` },
        },
      },
    ],
    client_reference_id: debt.id,
    metadata: { debtId: debt.id },
    payment_intent_data: { metadata: { debtId: debt.id, orderId: debt.orderId } },
    success_url: `${config.publicBaseUrl}/pay/success`,
    cancel_url: `${config.publicBaseUrl}/cancel`,
  });
  if (!session.url) throw new Error("Stripe returned a Checkout session without a URL");
  payBackSessions.set(debt.id, session.id);
  return { kind: "checkout", url: session.url };
}

/** Test helper: forget every issued pay-back token and session. */
export function resetPayBackLinks(): void {
  payBackTokens.clear();
  payBackSessions.clear();
}
