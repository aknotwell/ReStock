// Owner: Person 3. Stripe webhooks — signature verified, idempotent.
import type { Request, Response } from "express";
import { config } from "../config.js";
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

  switch (event.type) {
    case "checkout.session.completed":
      // TODO(P3): setup mode -> save paymentMethodId + cardLast4 on the Member
      // TODO(P3): payment mode -> markDebtPaid(debtId) from core/ledger.ts
      break;
    default:
      break;
  }
  res.json({ received: true });
}
