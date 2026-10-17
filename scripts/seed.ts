// Owner: Person 4. Demo household from PLAN.md. Fake data only.
import { addItem, db, resetStore, UNBOUND_GROUP } from "../src/core/store.js";
import type { Household, Member } from "../src/types.js";

export const DEMO_HOUSEHOLD_ID = "demo-house";

export function seedDemo(): Household {
  resetStore();

  // Placeholder card IDs keep this function fast and offline for tests. With DEMO_SEED=1 and a Stripe
  // test key, the server swaps in real sandbox cards for Sam and Jake (scripts/demoCards.ts).
  const members: Member[] = [
    { id: "sam", name: "Sam", phone: process.env.DEMO_PHONE_SAM || "+15550000001", role: "owner", paymentMethodId: "pm_test_sam", cardLast4: "4242" },
    { id: "jake", name: "Jake", phone: process.env.DEMO_PHONE_JAKE || "+15550000002", role: "member", paymentMethodId: "pm_test_jake", cardLast4: "1881" },
    { id: "priya", name: "Priya", phone: process.env.DEMO_PHONE_PRIYA || "+15550000003", role: "member" }, // no card
  ];

  const household: Household = {
    id: DEMO_HOUSEHOLD_ID,
    groupChatId: process.env.DEMO_GROUP_SPACE_ID || UNBOUND_GROUP, // bound by the first group text if unset
    ownerId: "sam",
    budgetCents: 18515, // leaves $112.40 after the $72.75 demo order
    spentCents: 0,
    members,
  };
  db.households.set(household.id, household);

  const items: [string, string, number, boolean][] = [
    ["Toilet paper, 12 rolls", "priya", 1199, true],
    ["Dish soap, 3 pack", "jake", 849, true],
    ["Paper towels, 6 rolls", "priya", 999, true],
    ["Air fryer (approved by Sam)", "jake", 3200, false],
    ["Tortilla chips", "jake", 479, false],
    ["Oat milk", "sam", 549, false],
  ];
  for (const [name, addedBy, cents, shared] of items) {
    addItem({ householdId: household.id, name, addedBy, cents, shared });
  }
  return household;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const h = seedDemo();
  console.log(`Seeded ${h.id}: ${h.members.length} members, ${db.items.size} items`);
}
