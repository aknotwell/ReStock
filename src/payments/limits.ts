// Stripe's limits, kept out of stripe.ts so tests can fake the client without them.

/** Stripe won't charge less than $0.50 USD. */
export const STRIPE_MIN_CHARGE_CENTS = 50;
