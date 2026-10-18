// Secure links texted to members. Card data only ever touches Stripe's pages.
import { randomInt } from "node:crypto";
import { config } from "../config.js";
import { registerState } from "../core/persist.js";
import { db, findMember } from "../core/store.js";
import type { Debt, Member } from "../types.js";
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
export async function ensureStripeCustomer(member: Member): Promise<string> {
  if (member.stripeCustomerId) return member.stripeCustomerId;
  const customer = await requireStripe().customers.create(
    { name: member.name, metadata: { memberId: member.id } },
    // Two quick taps on the link must not create two customers.
    { idempotencyKey: `restock-customer-${member.id}` },
  );
  // TODO: replace with an updateMember() in store.ts once there is one. Members are live objects
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

/** Order dates on the Stripe page. DubHacks is in Seattle, so show Pacific time. */
const ORDER_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Los_Angeles",
});

// Short-link token -> the debt it was texted for. Any link pays everything that debtor owes that creditor.
const payBackTokens = new Map<string, { debtId: string; expiresAt: number }>();
// "debtor->creditor" -> their open Checkout session and exactly which debts it pays.
type PayBackSession = { sessionId: string; debtIds: string[] };
const payBackSessions = new Map<string, PayBackSession>();
const pairKey = (debtorId: string, creditorId: string) => `${debtorId}->${creditorId}`;
// debtId -> the one Stripe page that can currently pay it, from either pay-back path (texted link
// or the /pay site). Before any new page is made, older pages for the same debts are cancelled.
const pageByDebt = new Map<string, string>();

// Links already texted to people must keep working after a restart or redeploy.
type SavedLinks = {
  card: [string, { memberId: string; expiresAt: number }][];
  payBack: [string, { debtId: string; expiresAt: number }][];
  sessions: [string, PayBackSession | string][]; // a string is the older one-session-per-debt format
  pages?: [string, string][];
};
registerState("payment-links", {
  dump: (): SavedLinks => ({ card: [...cardLinkTokens], payBack: [...payBackTokens], sessions: [...payBackSessions], pages: [...pageByDebt] }),
  load: (data) => {
    const saved = data as SavedLinks;
    const now = Date.now();
    cardLinkTokens.clear();
    payBackTokens.clear();
    payBackSessions.clear();
    pageByDebt.clear();
    for (const [debtId, sessionId] of saved.pages ?? []) pageByDebt.set(debtId, sessionId);
    for (const [token, link] of saved.card ?? []) if (link.expiresAt > now) cardLinkTokens.set(token, link);
    for (const [token, link] of saved.payBack ?? []) if (link.expiresAt > now) payBackTokens.set(token, link);
    // Older saves mapped one debt to one session; those sessions still carry debtId in their metadata.
    for (const [key, s] of saved.sessions ?? []) if (typeof s === "object") payBackSessions.set(key, s);
    // Saves from before pageByDebt existed: their combined pages still count as the page for those debts.
    for (const s of payBackSessions.values()) for (const id of s.debtIds) if (!pageByDebt.has(id)) pageByDebt.set(id, s.sessionId);
  },
});

/**
 * Short link (/p/:token) for paying back. Tapping it pays **everything** the debtor currently owes
 * that creditor, not just this debt. Like the add-card link, no Stripe call happens until it's tapped.
 */
export async function createPayBackLink(debtId: string, now = Date.now()): Promise<string> {
  if (!db.debts.has(debtId)) throw new Error(`Unknown debt ${debtId}`);
  const token = newLinkToken();
  payBackTokens.set(token, { debtId, expiresAt: now + PAY_BACK_LINK_TTL_MS });
  return `${config.publicBaseUrl}/p/${token}`;
}

/** Open debts from debtor to creditor, oldest order first. */
export function openDebtsBetween(debtorId: string, creditorId: string): Debt[] {
  const placedAt = (d: Debt) => db.orders.get(d.orderId)?.createdAt ?? "";
  return [...db.debts.values()]
    .filter((d) => d.debtorId === debtorId && d.creditorId === creditorId && d.status === "open")
    .sort((a, b) => placedAt(a).localeCompare(placedAt(b)));
}

/**
 * Call before making any pay-back page. Cancels older open pages that could pay any of these debts,
 * so no debt can be paid twice. Returns the debts that may go on the new page: those whose older
 * page was already paid (its webhook may still be on the way) are left out.
 */
export async function claimDebtsForNewPage(debtIds: string[]): Promise<string[]> {
  const bySession = new Map<string, string[]>();
  for (const id of debtIds) {
    const sessionId = pageByDebt.get(id);
    if (sessionId) bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), id]);
  }
  if (bySession.size === 0) return debtIds;

  const stripe = requireStripe();
  const alreadyPaid = new Set<string>();
  for (const [sessionId, ids] of bySession) {
    let session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === "open") {
      // If it was paid a moment ago, Stripe refuses to cancel it; then we see "complete" below.
      session = await stripe.checkout.sessions.expire(sessionId).catch(() => stripe.checkout.sessions.retrieve(sessionId));
    }
    if (session.status === "complete") for (const id of ids) alreadyPaid.add(id);
    for (const id of ids) if (pageByDebt.get(id) === sessionId) pageByDebt.delete(id);
  }
  return debtIds.filter((id) => !alreadyPaid.has(id));
}

/** Record that this Stripe page can pay these debts. Call right after creating it. */
export function registerPayBackPage(sessionId: string, debtIds: string[]): void {
  for (const id of debtIds) pageByDebt.set(id, sessionId);
}

/** Which debts a pay-back Checkout session pays, if we created it. Used by the webhook. */
export function payBackDebtsForSession(sessionId: string): string[] | undefined {
  for (const s of payBackSessions.values()) if (s.sessionId === sessionId) return s.debtIds;
  return undefined;
}

export type PayBackPage =
  | { kind: "checkout"; url: string } // send them to Stripe
  | { kind: "paid" } // nothing left to pay
  | { kind: "too_small"; cents: number; creditorName: string } // under Stripe's $0.50 minimum
  | { kind: "not_found" }; // unknown or expired token

/**
 * Called when a debtor taps /p/:token. Returns where to send them: one Stripe page for the total of
 * every open debt they owe that creditor, itemized by order. Taps reuse that page while it still
 * matches what they owe, and a page can only be paid once, so they can't pay twice. If a new order
 * added a debt, the old page is cancelled first, so a stale total can never be paid.
 */
export async function openPayBackLink(token: string, now = Date.now()): Promise<PayBackPage> {
  const entry = payBackTokens.get(token);
  const anchor = entry && entry.expiresAt >= now ? db.debts.get(entry.debtId) : undefined;
  if (!anchor) return { kind: "not_found" };
  const creditor = findMember(anchor.creditorId)?.member;
  const debtor = findMember(anchor.debtorId)?.member;
  if (!creditor || !debtor) return { kind: "not_found" };

  const key = pairKey(debtor.id, creditor.id);
  let open = openDebtsBetween(debtor.id, creditor.id);

  const existing = payBackSessions.get(key);
  // Nothing owed and no page out there: no need to ask Stripe anything.
  if (!existing && open.length === 0) return { kind: "paid" };
  const total0 = open.reduce((sum, d) => sum + d.cents, 0);
  if (!existing && total0 < STRIPE_MIN_CHARGE_CENTS) return { kind: "too_small", cents: total0, creditorName: creditor.name };

  const stripe = requireStripe();
  if (existing) {
    let session = await stripe.checkout.sessions.retrieve(existing.sessionId);
    if (session.status === "open" && session.url && sameSet(existing.debtIds, open.map((d) => d.id))) {
      return { kind: "checkout", url: session.url };
    }
    if (session.status === "open") {
      // What they owe changed since this page was made. Cancel it so the old total can't be paid.
      // If it was paid in the meantime, Stripe refuses to cancel it; then we see "complete" below.
      session = await stripe.checkout.sessions
        .expire(existing.sessionId)
        .catch(() => stripe.checkout.sessions.retrieve(existing.sessionId));
    }
    if (session.status === "complete") {
      // Paid; the webhook marks those debts (it may still be on its way). Only the rest needs a page.
      open = open.filter((d) => !existing.debtIds.includes(d.id));
    }
    payBackSessions.delete(key);
    for (const id of existing.debtIds) if (pageByDebt.get(id) === existing.sessionId) pageByDebt.delete(id);
  }

  // A page from the /pay site may also cover some of these debts: cancel it, or skip debts it just paid.
  const claimable = await claimDebtsForNewPage(open.map((d) => d.id));
  open = open.filter((d) => claimable.includes(d.id));

  if (open.length === 0) return { kind: "paid" };
  const total = open.reduce((sum, d) => sum + d.cents, 0);
  if (total < STRIPE_MIN_CHARGE_CENTS) return { kind: "too_small", cents: total, creditorName: creditor.name };

  const debtIds = open.map((d) => d.id);
  const idList = debtIds.join(",");
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    allowed_payment_method_types: ["card"], // cards, plus Apple Pay / Google Pay wallets
    customer: debtor.stripeCustomerId, // prefills their details if they have one; optional
    // One line per order, so the total on Stripe's page is easy to check against the texts.
    line_items: open.map((d) => {
      const placed = db.orders.get(d.orderId)?.createdAt;
      const when = placed ? ` on ${ORDER_TIME.format(new Date(placed))}` : "";
      return {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: d.cents,
          product_data: { name: `Pay ${creditor.name} back: your share of the order${when}` },
        },
      };
    }),
    client_reference_id: debtor.id,
    // The server keeps the debt list (payBackSessions); metadata repeats it when it fits Stripe's 500-char limit.
    metadata: { payBack: "1", debtorId: debtor.id, creditorId: creditor.id, ...(idList.length <= 500 ? { debtIds: idList } : {}) },
    payment_intent_data: { metadata: { payBack: "1", debtorId: debtor.id, creditorId: creditor.id } },
    success_url: `${config.publicBaseUrl}/pay/success`,
    cancel_url: `${config.publicBaseUrl}/cancel`,
  });
  if (!session.url) throw new Error("Stripe returned a Checkout session without a URL");
  payBackSessions.set(key, { sessionId: session.id, debtIds });
  registerPayBackPage(session.id, debtIds);
  return { kind: "checkout", url: session.url };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Test helper: forget every issued pay-back token and session. */
export function resetPayBackLinks(): void {
  payBackTokens.clear();
  payBackSessions.clear();
  pageByDebt.clear();
}
