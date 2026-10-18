// Owner: Person 3. "delete my data" also deletes the person's Stripe Customer, which removes their saved card.
// Stripe keeps its own records of past payments either way; this only stops it holding a card for us.
import Stripe from "stripe";
import { registerState } from "../core/persist.js";
import { stripe } from "./stripe.js";

// Customers whose deletion failed (Stripe unreachable). Retried by the sweep in server.ts.
const failed = new Set<string>();
registerState("stripe-deletions", {
  dump: () => [...failed],
  load: (data) => {
    failed.clear();
    for (const id of data as string[]) failed.add(id);
  },
});

/** Delete a Stripe Customer. Already gone counts as done. A failure is saved and retried later. */
export async function deleteStripeCustomer(customerId: string): Promise<boolean> {
  if (!stripe) return true; // no Stripe key: nothing was ever created there
  try {
    await stripe.customers.del(customerId);
    failed.delete(customerId);
    return true;
  } catch (err) {
    if (err instanceof Stripe.errors.StripeInvalidRequestError && err.code === "resource_missing") {
      failed.delete(customerId);
      return true;
    }
    console.warn("Stripe customer deletion failed:", err instanceof Error ? err.message : err);
    failed.add(customerId);
    return false;
  }
}

/** Retry deletions that failed earlier. */
export async function retryCustomerDeletions(): Promise<void> {
  for (const id of [...failed]) await deleteStripeCustomer(id);
}

export const pendingCustomerDeletions = () => [...failed];

export function resetCustomerDeletions(): void {
  failed.clear();
}
