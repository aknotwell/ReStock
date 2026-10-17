// Owner: Person 3. Secure links texted to members. Card data only ever touches Stripe's pages.
import { randomInt } from "node:crypto";
import { config } from "../config.js";
import { findMember } from "../core/store.js";
import type { Member } from "../types.js";
import { requireStripe } from "./stripe.js";

/** How long a texted add-card link keeps working. */
export const CARD_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Short-link token -> member. A random token keeps member IDs out of texted URLs.
// TODO(P2/P3): move into the database when store.ts does, so links survive a server restart.
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

/** Link to a Stripe Checkout `payment` session for an open debt. */
export async function createPayBackLink(debtId: string): Promise<string> {
  // TODO(P3): create the Checkout session and return a short redirect URL (/p/:token)
  return `${config.publicBaseUrl}/p/${encodeURIComponent(debtId)}`;
}
