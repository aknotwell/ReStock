// Owner: Person 3. Dev helper for testing the pay-back flow by hand (see docs/stripe.md).
// Loads the demo household, adds the demo debt (Priya owes Sam $10.15, as after the demo order),
// starts the server in this same process (the store is in memory), and prints a pay-back link.
// Usage: npx tsx scripts/try-pay-back-link.ts
import { seedDemo } from "./seed.js";
import { db } from "../src/core/store.js";
import { createPayBackLink } from "../src/payments/links.js";

seedDemo();
const debt = { id: "demo-debt-priya", orderId: "demo-order", debtorId: "priya", creditorId: "sam", cents: 1015, status: "open" as const };
db.debts.set(debt.id, { ...debt });
await import("../src/server.js");

console.log(`\nPay-back link for Priya ($10.15 to Sam): ${await createPayBackLink(debt.id)}`);
console.log("Open it, pay with test card 4242 4242 4242 4242, then come back here.\n");

// Print the debt's status whenever it changes so you can watch the webhook land.
let last = "";
setInterval(() => {
  const now = db.debts.get(debt.id)?.status ?? "missing";
  if (now !== last) console.log(`debt ${debt.id}: ${now}`);
  last = now;
}, 2000);
