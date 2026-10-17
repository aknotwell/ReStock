// Owner: Person 3. Stripe client — TEST MODE ONLY (enforced in config.ts).
import Stripe from "stripe";
import { config } from "../config.js";

export const stripe =config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : undefined;

export function requireStripe(): Stripe {
  if (!stripe) throw new Error("STRIPE_SECRET_KEY (sk_test_...) is not set");
  return stripe;
}
