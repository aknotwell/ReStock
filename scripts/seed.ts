// Owner: Person 4. Demo household from PLAN.md. Fake data only, unless DEMO_MEMBERS names real testers.
import { addItem, db, resetStore, UNBOUND_GROUP } from "../src/core/store.js";
import type { Household, Member } from "../src/types.js";

export const DEMO_HOUSEHOLD_ID = "demo-house";

/**
 * Optional real household for live demos, as JSON in DEMO_MEMBERS, e.g.
 *   [{"name":"YourName","phone":"+12065550100","owner":true,"card":true},
 *    {"name":"David","phone":"+12065550101","card":true},
 *    {"name":"Amber","phone":"+12065550102"},
 *    {"name":"Abdul","phone":"+12065550103"}]
 * Exactly one owner (defaults to the first person). "card": true gives them a Stripe sandbox card at
 * startup (scripts/demoCards.ts). Without DEMO_MEMBERS, the PLAN.md household (Sam, Jake, Priya) is used.
 */
type DemoMemberInput = { name: string; phone: string; owner?: boolean; card?: boolean };

export function parseDemoMembers(raw: string | undefined): Member[] | undefined {
  if (!raw?.trim()) return undefined;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    console.warn("DEMO_MEMBERS is not valid JSON; using the default demo household.");
    return undefined;
  }
  const valid = (m: unknown): m is DemoMemberInput =>
    !!m && typeof m === "object" && typeof (m as DemoMemberInput).name === "string" && typeof (m as DemoMemberInput).phone === "string";
  if (!Array.isArray(list) || list.length === 0 || !list.every(valid)) {
    console.warn('DEMO_MEMBERS must be a non-empty JSON array of {"name","phone"} objects; using the default demo household.');
    return undefined;
  }
  const ownerIndex = Math.max(0, list.findIndex((m) => m.owner));
  const used = new Set<string>();
  return list.map((m, i) => {
    let id = m.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `member-${i + 1}`;
    while (used.has(id)) id += "-2";
    used.add(id);
    const member: Member = { id, name: m.name.trim(), phone: m.phone.trim(), role: i === ownerIndex ? "owner" : "member" };
    // Placeholder card until attachDemoCards swaps in a real sandbox card. The owner always needs one.
    if (m.card || i === ownerIndex) Object.assign(member, { paymentMethodId: `pm_test_${id}`, cardLast4: "4242" });
    return member;
  });
}

export function seedDemo(): Household {
  resetStore();

  // Placeholder card IDs keep this function fast and offline for tests. With DEMO_SEED=1 and a Stripe
  // test key, the server swaps in real sandbox cards (scripts/demoCards.ts).
  const members: Member[] = parseDemoMembers(process.env.DEMO_MEMBERS) ?? [
    { id: "sam", name: "Sam", phone: process.env.DEMO_PHONE_SAM || "+15550000001", role: "owner", paymentMethodId: "pm_test_sam", cardLast4: "4242" },
    { id: "jake", name: "Jake", phone: process.env.DEMO_PHONE_JAKE || "+15550000002", role: "member", paymentMethodId: "pm_test_jake", cardLast4: "1881" },
    { id: "priya", name: "Priya", phone: process.env.DEMO_PHONE_PRIYA || "+15550000003", role: "member" }, // no card
  ];
  const owner = members.find((m) => m.role === "owner")!;
  // The demo cart's three roles (PLAN.md): owner, a roommate with a card, a roommate without one.
  const second = members.find((m) => m.id !== owner.id) ?? owner;
  const third = members.find((m) => m.id !== owner.id && m.id !== second.id) ?? second;

  const household: Household = {
    id: DEMO_HOUSEHOLD_ID,
    groupChatId: process.env.DEMO_GROUP_SPACE_ID || UNBOUND_GROUP, // bound by the first group text if unset
    ownerId: owner.id,
    budgetCents: 18515, // leaves $112.40 after the $72.75 demo order
    spentCents: 0,
    members,
  };
  db.households.set(household.id, household);

  const items: [string, Member, number, boolean][] = [
    ["Toilet paper, 12 rolls", third, 1199, true],
    ["Dish soap, 3 pack", second, 849, true],
    ["Paper towels, 6 rolls", third, 999, true],
    [`Air fryer (approved by ${owner.name})`, second, 3200, false],
    ["Tortilla chips", second, 479, false],
    ["Oat milk", owner, 549, false],
  ];
  for (const [name, by, cents, shared] of items) {
    addItem({ householdId: household.id, name, addedBy: by.id, cents, shared });
  }
  return household;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const h = seedDemo();
  console.log(`Seeded ${h.id}: ${h.members.map((m) => `${m.name}${m.role === "owner" ? " (owner)" : ""}`).join(", ")}; ${db.items.size} items`);
}
