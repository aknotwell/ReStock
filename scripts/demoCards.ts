// Owner: Person 3 (for Person 4's demo seed). Gives the seeded Sam and Jake real cards in our Stripe
// sandbox, so "order now" on the demo household charges for real (test mode). Priya stays card-less.
// Uses Stripe's built-in test PaymentMethods only: no card numbers in code.
import type Stripe from "stripe";
import { stripe as stripeClient } from "../src/payments/stripe.js";
import type { Household, Member } from "../src/types.js";

/** Which Stripe test card each demo member gets. */
export const DEMO_TEST_CARDS: Record<string, string> = {
  sam: "pm_card_visa", // Visa 4242
  jake: "pm_card_visa_debit", // Visa debit 5556 (Stripe has no built-in test card ending 1881)
};

/**
 * Finds or creates each demo member's sandbox Customer and saved card, and writes the real Stripe IDs
 * and last 4 onto the seeded members. Safe to run on every server start: it reuses what exists.
 * Without a Stripe key, or if Stripe can't be reached, it logs and keeps the placeholder card IDs.
 */
export async function attachDemoCards(household: Household, stripe: Stripe | null = stripeClient ?? null): Promise<void> {
  if (!stripe) {
    console.log("Demo cards: no STRIPE_SECRET_KEY, so Sam and Jake keep placeholder cards.");
    return;
  }
  try {
    for (const member of household.members) {
      const testCard = DEMO_TEST_CARDS[member.id];
      if (testCard) await attachCard(stripe, member, testCard);
    }
    const withCards = household.members.filter((m) => DEMO_TEST_CARDS[m.id]);
    console.log(`Demo cards: ${withCards.map((m) => `${m.name} ending ${m.cardLast4}`).join(", ")} (Stripe sandbox)`);
  } catch (err) {
    console.warn("Demo cards: couldn't set up sandbox cards:", err instanceof Error ? err.message : err);
  }
}

async function attachCard(stripe: Stripe, member: Member, testCard: string): Promise<void> {
  // A fixed, non-routable email lets us find the same Customer again after a restart.
  // (Customer search by metadata can lag by a minute; listing by email is immediate.)
  const email = `${member.id}@demo.restock.invalid`;
  const existing = (await stripe.customers.list({ email, limit: 1 })).data[0];
  const customer =
    existing ?? (await stripe.customers.create({ name: member.name, email, metadata: { memberId: member.id, restockDemo: "true" } }));

  const saved = (await stripe.paymentMethods.list({ customer: customer.id, type: "card", limit: 1 })).data[0];
  const card = saved ?? (await stripe.paymentMethods.attach(testCard, { customer: customer.id }));

  member.stripeCustomerId = customer.id;
  member.paymentMethodId = card.id;
  member.cardLast4 = card.card?.last4;
}
