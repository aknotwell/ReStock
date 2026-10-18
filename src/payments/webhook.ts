// Owner: Person 3. Stripe webhooks — signature verified, idempotent.
import type { Request, Response } from "express";
import type Stripe from "stripe";
import { config } from "../config.js";
import { markDebtPaid } from "../core/ledger.js";
import { db, findMember } from "../core/store.js";
import { sendPrivate } from "../messaging/photon.js";
import { cardAdded } from "../messaging/templates.js";
import { settlePayBack } from "./payback.js";
import { payBackDebtsForSession } from "./links.js";
import { requireStripe } from "./stripe.js";

export async function stripeWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers["stripe-signature"];
  if (!config.stripeWebhookSecret || typeof signature !== "string") {
    res.status(400).send("Missing webhook secret or signature");
    return;
  }

  let event;
  try {
    // req.body is the raw Buffer (express.raw is mounted on this route in server.ts)
    event = requireStripe().webhooks.constructEvent(req.body as Buffer, signature, config.stripeWebhookSecret);
  } catch {
    res.status(400).send("Invalid signature");
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        if (event.data.object.mode === "setup") await saveCardFromSetupSession(event.data.object);
        else if (event.data.object.mode === "payment" && event.data.object.payment_status === "paid") {
          if (event.data.object.metadata?.memberId) await settlePayBack(event.data.object);
          else markDebtPaidFromSession(event.data.object);
        }
        break;
      // Bank payments (offered through Link) finish Checkout as "processing" and clear days later.
      case "checkout.session.async_payment_succeeded":
        if (event.data.object.mode === "payment") {
          if (event.data.object.metadata?.memberId) await settlePayBack(event.data.object);
          else markDebtPaidFromSession(event.data.object);
        }
        break;
      default:
        break;
    }
  } catch (err) {
    // A 500 makes Stripe retry later. Log only the message, never the event body.
    console.error(`stripe webhook ${event.type} failed:`, err instanceof Error ? err.message : err);
    res.status(500).send("Webhook handler failed");
    return;
  }
  res.json({ received: true });
}

/**
 * A member finished a pay-back page. Mark their Debt paid.
 * Idempotent: marking a paid debt paid again changes nothing.
 */
export function markDebtPaidFromSession(
  session: Stripe.Checkout.Session,
): "paid" | "not_a_pay_back" | "unknown_debt" | "not_paid" | "amount_mismatch" {
  // Which debts this page paid: our own record first, then the metadata copy, then the older
  // one-debt-per-page format. Sessions we didn't create (e.g. `stripe trigger`) have none: ignore them.
  const debtIds =
    payBackDebtsForSession(session.id) ??
    session.metadata?.debtIds?.split(",") ??
    (session.metadata?.debtId ? [session.metadata.debtId] : undefined);
  if (!debtIds?.length) return "not_a_pay_back";
  const debts = debtIds.map((id) => db.debts.get(id));
  if (debts.some((d) => !d)) {
    console.warn("pay-back completed for a debt we don't know; ignoring");
    return "unknown_debt";
  }
  if (session.payment_status !== "paid") return "not_paid";
  const total = debts.reduce((sum, d) => sum + d!.cents, 0);
  if (session.amount_total !== total) {
    // We set the amount from these debts, so this shouldn't happen. Don't guess; leave them open and log.
    console.error(`pay-back amount ${session.amount_total} doesn't match its ${debts.length} debt(s) (${total})`);
    return "amount_mismatch";
  }
  for (const id of debtIds) markDebtPaid(id);
  // TODO(P1): text the creditor "{debtor} paid you back {amount}".
  return "paid";
}

/**
 * A member finished the add-card page. Save the card's Stripe ID and last 4 digits on the Member.
 * Idempotent: if Stripe delivers the same event twice, we save the same values twice.
 * Returns what happened so tests and logs can tell the cases apart.
 */
export async function saveCardFromSetupSession(
  session: Stripe.Checkout.Session,
): Promise<"saved" | "unknown_member" | "no_card"> {
  // Sessions we didn't create (e.g. `stripe trigger`) have no memberId. Ignore them.
  const memberId = session.metadata?.memberId;
  const found = memberId ? findMember(memberId) : undefined;
  if (!found) {
    console.warn("card setup completed for a member we don't know; ignoring");
    return "unknown_member";
  }

  const setupIntentId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  if (!setupIntentId) return "no_card";

  // The session only has the SetupIntent ID. Ask Stripe for the card it saved.
  const setupIntent = await requireStripe().setupIntents.retrieve(setupIntentId, { expand: ["payment_method"] });
  const paymentMethod = setupIntent.payment_method;
  if (!paymentMethod || typeof paymentMethod === "string" || !paymentMethod.card) return "no_card";

  // TODO(P2): replace with an updateMember() in store.ts once there is one.
  const { member } = found;
  if (typeof session.customer === "string") member.stripeCustomerId = session.customer;
  member.paymentMethodId = paymentMethod.id;
  member.cardLast4 = paymentMethod.card.last4;
  await sendPrivate(member.id, cardAdded(member.cardLast4), `card-added:${setupIntentId}`).catch((err) =>
    console.warn("card-added text failed:", err instanceof Error ? err.message : err),
  );
  return "saved";
}
