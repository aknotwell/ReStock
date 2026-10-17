# Restock — Build Plan

Source: the "Who pays for the household order" design note ([artifact](https://claude.ai/artifact/G5ejBnkYfSPQjuwNd81JrQ)).

## What we're building

Restock is a household group chat for restocking supplies. Roommates add items by text, someone says "order now", and Restock places the order and splits the bill.

**Payment model (decided):** the budget owner's card is required. Everyone else's card is optional.

- **Member with a card:** their share is charged to their own card automatically.
- **Member without a card:** the owner's card covers their share, and Restock privately texts them what they owe, with a pay-back link and an add-a-card link.
- Orders never get stuck on missing cards, and anyone can join the chat and add items right away.
- We are **not** building a shared household balance or pot (Option 3).

**Split rules** (one per order, default is the first):

| Rule | Behavior |
|---|---|
| `smart` (default) | Shared items split evenly across all members. Personal items go to whoever added them. |
| `even` | Every item split evenly. |
| `adder` | Each person pays for what they added. |

Even splits are done in **integer cents**. The remainder cents go one each to the first members in member order, so the shares always add up to the order total.

**Hard rule:** card numbers never go in the chat or in a text. Cards are added only through Stripe. We store only Stripe references (customer ID, payment method ID, last 4).

> Stack suggestions (change them if the team prefers something else): TypeScript/Node, Twilio for SMS, Stripe in test mode, SQLite or Postgres, and a small web server for the `/card` and `/pay` pages.

---

## Shared contracts (agree on these first, about 30 min, all four people)

Everyone codes against these. Person 2 owns the file, and changes go through them.

```ts
type Member = {
  id: string; name: string; phone: string;
  role: "owner" | "member";
  stripeCustomerId?: string;
  paymentMethodId?: string;   // set = "card on file"
  cardLast4?: string;
};

type Household = { id: string; groupChatId: string; ownerId: string; budgetCents: number; members: Member[] };

type Item = { id: string; householdId: string; name: string; addedBy: string; cents: number; shared: boolean; status: "pending" | "ordered" };

type SplitRule = "smart" | "even" | "adder";

type Order = { id: string; householdId: string; itemIds: string[]; totalCents: number; rule: SplitRule; createdAt: string; eta?: string };

type Charge = { orderId: string; memberId: string; cents: number;
  paidBy: string;             // memberId whose card was charged
  stripePaymentIntentId?: string; status: "succeeded" | "failed" };

type Debt = { id: string; orderId: string; debtorId: string; creditorId: string; cents: number; status: "open" | "paid" };
```

Module interfaces:

```ts
// Person 2
computeShares(items: Item[], members: Member[], rule: SplitRule): Record<memberId, cents>
// Person 3
chargeOrder(order: Order, shares: Record<memberId, cents>): Promise<{ charges: Charge[]; debts: Debt[] }>
createCardSetupLink(memberId): Promise<url>
createPayBackLink(debtId): Promise<url>
// Person 1
sendGroup(householdId, text): Promise<void>
sendPrivate(memberId, text): Promise<void>
```

---

## Person 1: Messaging and the chat bot

You own everything that comes in or goes out as a text.

- [ ] Set up the SMS provider (e.g. Twilio): the number, the inbound webhook, and group chat (MMS group or one thread per household).
- [ ] Implement `sendGroup` and `sendPrivate`.
- [ ] Parse inbound commands:
  - adding an item ("add dish soap", optionally with "personal" or "for me" to mark it personal)
  - `order now` triggers the checkout flow (call Person 2's `placeOrder`)
  - joining the household: an unknown number texting the group becomes a member with no card
- [ ] **Card-number guard:** detect anything that looks like a card number (13–19 digits, Luhn check) in any message. Don't store or echo it. Privately reply with the secure add-card link from Person 3.
- [ ] Message templates. The wording must match the design note:
  - **Group summary:** `Ordered! {n} items, {total}, {rule text}.` / `Sam $X · Jake $Y · Priya $Z` / `Arrives {eta}. Household budget left: {remaining}`
  - **Owner receipt:** `Receipt: your share is $X, charged to your Visa ending 4242.` Add `Your card also covered $Y for roommates without a card. I'll remind them to pay you back.` when Y > 0.
  - **Member with card:** `Receipt: your share is $X, charged to your card ending 1881.`
  - **Member without card:** `Your share of this week's order is $X. Sam's card covered it.` / `Pay Sam back: {payLink}` / `Or add a card so it's paid automatically next time: {cardLink}`
  - **Invite on join:** `Add a card so your share is paid automatically.` plus the card link
- [ ] Payback reminder: re-text open debts after N hours (optional).

**Done when:** texting the number can add items, "order now" kicks off checkout, and every text above arrives on the right phone.

---

## Person 2: Core data, split engine, and the order flow

You own the data and the money math. Everyone else depends on you, so publish the types file and a stub DB first.

- [ ] Database schema and data-access layer for Household, Member, Item, Order, Charge, and Debt (the contracts above).
- [ ] `computeShares(items, members, rule)` for `smart`, `even`, and `adder`, in integer cents with deterministic remainder handling.
- [ ] Unit tests for the split engine. Must include:
  - The demo household (Person 4's seed) under all three rules, with the shares adding up exactly to $72.75. Expected `smart` result (remainder cents assigned per item): Sam $15.65, Jake $46.95, Priya $10.15
  - Flipping one item between shared and personal
  - Uneven remainders, e.g. $10.00 split 3 ways gives 334/333/333
- [ ] `placeOrder(householdId)`:
  1. Collect pending items.
  2. Create the Order.
  3. Run `computeShares`.
  4. Call Person 3's `chargeOrder`.
  5. Mark items as ordered.
  6. Update the remaining budget.
  7. Hand the results to Person 1's templates.
- [ ] Household budget: track the monthly budget and the remaining amount. The owner approves personal items above a threshold (the "air fryer (approved by Sam)" case). Approval can be a simple "yes" reply from the owner.
- [ ] Ledger queries: what each member owes and to whom, and marking a debt paid (Person 3's webhook calls this).

**Done when:** `placeOrder` on seeded data produces the correct Order, shares, charges, and debts, and the tests pass.

---

## Person 3: Payments (Stripe)

You own every interaction with Stripe. Test mode only, with fake cards.

- [ ] Create a Stripe Customer for each member when they join.
- [ ] **Add-card flow** (`createCardSetupLink`): a Stripe Checkout session in `setup` mode, with Apple Pay and a card form. On `checkout.session.completed` or `setup_intent.succeeded`, save `paymentMethodId` and `cardLast4` on the Member. Restock never sees the card number.
- [ ] Owner gate: a household can't place an order until the owner has a card on file. Give Person 2 a clear error to text back if it's missing.
- [ ] `chargeOrder`, for each member's share:
  - With a card: an off-session PaymentIntent on their own card.
  - Without a card: add their share to the **owner's** charge, and create a `Debt(debtor → owner)`.
  - If a member's card fails: fall back to the owner's card and create a Debt.
- [ ] **Pay-back flow** (`createPayBackLink`): a Stripe Checkout `payment` session or Payment Link for the debt amount. The webhook marks the Debt paid through Person 2.
  - Stretch: actually send the money to the owner (e.g. Stripe Connect). For the hackathon, it's fine to only record that it was paid.
- [ ] Webhook endpoint with signature verification.
- [ ] Short URLs: `restock.link/card` and `restock.link/pay` (or `/c/:token` and `/p/:token` on our server) that redirect to the Stripe sessions.

**Done when:** a test card can be added from a texted link, an order charges Sam and Jake separately while Priya's share lands on Sam with a Debt, and paying the Debt link marks it paid.

---

## Person 4: Web pages, demo setup, and pitch

You own what judges see outside the texts, and you make the demo run without a hitch.

- [ ] Simple branded landing pages for the `/card` and `/pay` redirects: success and cancel pages ("Card added. Your share will be paid automatically from the next order.", "Thanks, Sam has been paid back."). These are mobile-first, since they open from a text.
- [ ] Optional household dashboard: items in the cart, who added each one, shared vs personal toggle, split rule picker, live per-person totals, and owes/owed. The design note's calculator is the reference UI.
- [ ] **Demo seed script** that creates this household:
  - Sam: owner, Stripe test card `4242` on file
  - Jake: roommate, test card on file (ending 1881)
  - Priya: roommate, **no card**
  - Items:

    | Item | Added by | Type | Price |
    |---|---|---|---|
    | Toilet paper, 12 rolls | Priya | shared | $11.99 |
    | Dish soap, 3 pack | Jake | shared | $8.49 |
    | Paper towels, 6 rolls | Priya | shared | $9.99 |
    | Air fryer (approved by Sam) | Jake | personal | $32.00 |
    | Tortilla chips | Jake | personal | $4.79 |
    | Oat milk | Sam | personal | $5.49 |

  - Order total: $72.75
- [ ] **Demo script** that shows both payment paths, using the `smart` rule:
  1. Roommates add items in the group chat.
  2. "order now" sends the group summary.
  3. Sam's and Jake's private receipts arrive.
  4. Priya gets "you owe Sam" with a pay link.
  5. Priya taps the link and pays, and the debt is marked paid.
  6. The air fryer lands on Jake alone, which shows the split is smart.
- [ ] Pitch slides and talking points for the **Visa track**: real split payments at checkout; Restock never stores card numbers (only Stripe tokens); the card-number guard in chat.
- [ ] End-to-end QA in the hour before the demo, with backup screenshots or a recording in case the SMS provider is slow.

**Done when:** the seed script plus the demo script run cleanly end to end on real phones.

---

## Dependencies and order of work

1. **All four:** agree on the contracts. **Person 2** pushes the types and stub DB.
2. In parallel:
   - Person 1 builds messaging against stubbed `placeOrder`, `chargeOrder`, and links.
   - Person 2 builds the split engine and its tests.
   - Person 3 builds the Stripe flows against a stub Member store.
   - Person 4 builds the pages and the seed script.
3. **Integration:**
   - Person 2 wires `placeOrder`, which calls Person 3's `chargeOrder`, then Person 1's templates.
   - Person 3's webhooks call Person 2's ledger.
4. **Person 4** runs the full demo. Everyone fixes what breaks.
