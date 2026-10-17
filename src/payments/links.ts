// Owner: Person 3. Secure links texted to members. Card data only ever touches Stripe's pages.
import { config } from "../config.js";

/** Link to a Stripe Checkout session in `setup` mode (Apple Pay + card form). */
export async function createCardSetupLink(memberId: string): Promise<string> {
  // TODO(P3): create the Checkout session and return a short redirect URL (/c/:token)
  return `${config.publicBaseUrl}/c/${encodeURIComponent(memberId)}`;
}

/** Link to a Stripe Checkout `payment` session for an open debt. */
export async function createPayBackLink(debtId: string): Promise<string> {
  // TODO(P3): create the Checkout session and return a short redirect URL (/p/:token)
  return `${config.publicBaseUrl}/p/${encodeURIComponent(debtId)}`;
}
