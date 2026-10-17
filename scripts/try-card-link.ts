// Owner: Person 3. Dev helper for testing the add-card flow by hand (see docs/stripe.md).
// Loads the demo household, starts the server in this same process (the store is in memory),
// and prints an add-card link. Usage: npx tsx scripts/try-card-link.ts [memberId]   (default: priya)
import { seedDemo } from "./seed.js";
import { findMember } from "../src/core/store.js";
import { createCardSetupLink } from "../src/payments/links.js";

const memberId = process.argv[2] ?? "priya";
seedDemo();
await import("../src/server.js");

console.log(`\nAdd-card link for ${memberId}: ${await createCardSetupLink(memberId)}`);
console.log("Open it, pay with test card 4242 4242 4242 4242, then come back here.\n");

// Print the member's saved card fields every few seconds so you can watch the webhook land.
let last = "";
setInterval(() => {
  const member = findMember(memberId)?.member;
  const now = `paymentMethodId=${member?.paymentMethodId ?? "-"} cardLast4=${member?.cardLast4 ?? "-"}`;
  if (now !== last) console.log(`${memberId}: ${now}`);
  last = now;
}, 2000);
