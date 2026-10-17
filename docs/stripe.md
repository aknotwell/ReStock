# Stripe: setup and testing (Person 3)

How to run and test the payments code in `src/payments/` on your own machine. **Test mode only.** Never use a live key, and never type a real card number anywhere.

## One-time setup

1. **Get a test secret key.**
   - Log in at [dashboard.stripe.com](https://dashboard.stripe.com).
   - Click the account name in the top-left corner and switch to a **sandbox**. Newer Stripe accounts have sandboxes instead of a "Test mode" toggle. Create one if you don't have one.
   - Go to **Developers → API keys** and copy the **Secret key**. It must start with `sk_test_`.
   - Put it in `.env` as `STRIPE_SECRET_KEY`. If you see `sk_live_`, you're in the live account: stop and switch to the sandbox.

2. **Install the Stripe CLI and log in.** You need it to forward webhooks to your machine.

   ```bash
   # Windows
   winget install Stripe.StripeCLI
   # macOS
   brew install stripe/stripe-cli/stripe

   stripe login
   ```

   When it asks you to choose an environment, pick **the same sandbox your `sk_test_` key came from**. If they don't match, webhook events never reach your server. Never pick the live account.

3. **Get the webhook signing secret.**

   ```bash
   stripe listen --print-secret
   ```

   Put the `whsec_...` value in `.env` as `STRIPE_WEBHOOK_SECRET`. It's the same value every time for your CLI login, so you only do this once.

## Running locally

Use two terminals:

```bash
# Terminal 1: the server
npm run dev

# Terminal 2: forward Stripe events to our webhook route
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to localhost:3000/webhooks/stripe
```

Newer Stripe CLI versions refuse to start unless `--events` names the events to forward. Add more names, separated by commas, when we handle more events.

If `npm run dev` crashes with `EADDRINUSE`, or the server prints "listening" but your changes don't seem to take effect, an old server is still holding port 3000. Close the old terminal, or end the stray `node` process in Task Manager.

Check that Terminal 2 says `Ready!` and that `http://localhost:3000/health` returns `{"ok":true}`.

**Smoke test for webhooks.** With both terminals running:

```bash
stripe trigger checkout.session.completed
```

Terminal 2 should show the events with `[200]` next to them. A `[400]` means the signing secret in `.env` doesn't match your CLI login. Redo step 3 and restart `npm run dev`.

## Test cards

Type these only into Stripe's own hosted pages, never into the chat or our code. Any future expiry date, any 3-digit CVC, and any ZIP work.

| Card number | What happens |
|---|---|
| `4242 4242 4242 4242` | Succeeds (Sam's card in the demo) |
| `4000 0000 0000 0002` | Declined, to test falling back to the owner's card |
| `4000 0025 0000 3155` | Asks for 3D Secure authentication |

Full list: [docs.stripe.com/testing](https://docs.stripe.com/testing).

## Feature test steps

Each payments PR adds its steps here.

| Feature | Status | How to test |
|---|---|---|
| Add-card link (`createCardSetupLink`) | Built | See **Add-card link** below. Unit tests: `npx vitest run test/card-setup.test.ts` |
| Owner card gate | Built | `npx vitest run test/owner-gate.test.ts`. It runs "order now" through the real message pipeline with Sam's card removed. Expect: the group gets "Sam needs to add a card before I can order. Sam, I've texted you a secure link.", Sam alone gets the `/c/` link, and no order is created. If Sam texts "order now" directly, he gets the link once, in that chat. The demo seed gives Sam a card, so the gate stays out of the way on the demo path. |
| Charging an order (`chargeOrder`) | Built | See **Charging an order** below. Unit tests: `npx vitest run test/charge-order.test.ts` |
| Pay-back link (`createPayBackLink`) | Built | See **Pay-back link** below. Unit tests: `npx vitest run test/pay-back.test.ts` |
| Short URLs (`/c/:token`, `/p/:token`) | Built | Tested with the add-card and pay-back links. A made-up token like `/c/abc` or `/p/abc` shows "This … link has expired" (404). |

### Add-card link

How it works: `createCardSetupLink` makes a short link with a random token (`/c/Xk3...`) and doesn't call Stripe yet. When someone taps it, the server creates their Stripe Customer if they don't have one, creates a fresh Checkout session in `setup` mode, and redirects to it. When they finish, Stripe sends `checkout.session.completed`. Our webhook asks Stripe which card was saved and stores only `paymentMethodId` and `cardLast4` on the member.

1. Stop `npm run dev` if it's running. Start the server with the demo household loaded: `npx tsx scripts/try-card-link.ts priya`. It prints an add-card link for Priya, who has no card in the demo.
2. In a second terminal, run `stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to localhost:3000/webhooks/stripe`.
3. Open the printed link in your browser. You should land on a Stripe page with a **Sandbox** badge and a **Save** button. No amount is shown, because nothing is charged.
4. Enter test card `4242 4242 4242 4242`, any future expiry, any CVC, and any ZIP. Uncheck "Save with Link". Click **Save**.
5. You should land on our "Card added" page.
6. Terminal 2 shows `checkout.session.completed` with `[200]`. Terminal 1 prints `priya: paymentMethodId=pm_... cardLast4=4242`.
7. Retry safety: copy the `evt_...` ID from Terminal 2 and run `stripe events resend evt_...`. You should get another `[200]`, and the member's card stays the same.
8. In the Stripe dashboard (sandbox), **Customers** shows "Priya" with a Visa ending 4242.

If step 6 shows `[400]`, your `STRIPE_WEBHOOK_SECRET` doesn't match `stripe listen --print-secret`. Redo setup step 3, then restart the server. Links only last until the server restarts, because tokens are kept in memory for now.

### Charging an order

How it works, in two steps, so nobody is charged for an order that doesn't go through:

1. **Hold.** Each member with a card gets a hold for their share on their own card. A hold is like a hotel hold: the money is set aside but not taken. Then the owner gets one hold for their own share **plus** the shares of anyone their card is covering:
   - members with no card
   - members whose card was declined or needs 3D Secure (they aren't there to approve it)
   - shares under $0.50, which is Stripe's minimum charge
2. **Capture.** Only when every hold succeeded do we take the money. If the owner's card fails, or Stripe can't be reached, every hold is released and nobody pays.

Everyone the owner covered gets a `Debt` (member → owner), which the pay-back link will settle. Each Stripe request uses an idempotency key built from the order and the member (`restock-hold-<orderId>-<memberId>`), so retrying the same order never charges twice.

Test cards for this, saved to a Customer through Stripe's test PaymentMethods (never type card numbers into our code):

| PaymentMethod | Card | What happens |
|---|---|---|
| `pm_card_visa` | 4242 4242 4242 4242 | Charges succeed |
| `pm_card_chargeCustomerFail` | 4000 0000 0000 0341 | Saves fine, but every charge is declined. Use it to test falling back to the owner's card. |

Expected results for the demo order ($72.75, smart split: Sam $15.65, Jake $46.95, Priya $10.15). Check them in the dashboard under **Payments**:

| Scenario | Stripe dashboard |
|---|---|
| Everyone's card works | Jake **$46.95 succeeded**. Sam **$25.80 succeeded** ($15.65 + Priya's $10.15). Priya owes Sam $10.15. |
| Jake's card declines | Jake $46.95 **incomplete** (never charged). Sam **$72.75 succeeded**. Jake owes Sam $46.95, Priya owes Sam $10.15. |
| Sam's card declines | Jake $46.95 **canceled** (hold released, $0 taken). Sam $25.80 incomplete. The order isn't placed, and the group gets "Sam's card didn't go through… Nobody was charged." |

The "incomplete" entries are attempts that were declined. No money moved, and they don't need cleaning up.

### Pay-back link

How it works: `createPayBackLink(debtId)` makes a short `/p/<token>` link and doesn't call Stripe yet. When the debtor taps it, the server creates a Stripe Checkout **payment** page for exactly the debt amount and redirects there.

- **Can't be paid twice.** Every tap for the same debt, even from a newer link, reuses the same Stripe page while it's open, and a Stripe page can only be paid once. If that page expires (after 24 hours), the next tap makes a fresh one.
- **Already paid.** If the debt is already paid, or Stripe says the page was paid and our webhook just hasn't arrived yet, the link goes straight to our "Thanks!" page.
- **Webhook.** When they pay, Stripe sends `checkout.session.completed`. We check that it's paid and that the amount matches the debt, then mark the debt paid with `markDebtPaid`. Bank payments offered through Link clear days later and arrive as `checkout.session.async_payment_succeeded`, which is handled the same way.
- **Debts under $0.50** can't go through Stripe. The link shows a short page asking them to settle it with the owner directly.
- **Where the money goes:** into our Stripe account, not the owner's bank. Sending it on to the owner needs Stripe Connect, which PLAN.md lists as a stretch goal. For the hackathon we record the debt as paid.

Steps:

1. Stop `npm run dev` if it's running. Run `npx tsx scripts/try-pay-back-link.ts`. It loads the demo household, adds the demo debt (Priya owes Sam $10.15), and prints a pay-back link.
2. In a second terminal, run `stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to localhost:3000/webhooks/stripe`.
3. Open the link. You should land on a Stripe **Sandbox** page showing **$10.15**.
4. Open the link again in another tab. It should be the same page (same `cs_test_...` in the address bar).
5. Pay with `4242 4242 4242 4242`, any future expiry, any CVC, and any ZIP. Uncheck "Save with Link". You should land on our "Thanks!" page.
6. Terminal 2 shows `checkout.session.completed` `[200]`, and Terminal 1 prints `debt demo-debt-priya: paid`.
7. Open the link once more. It goes straight to "Thanks!" without a new Stripe page.

If step 6 shows nothing in Terminal 2, the CLI missed the event (we saw this happen once). Run `stripe events list --limit 5`, find the `checkout.session.completed` event, and run `stripe events resend evt_...`. Resending is also how to check retries: you get another `[200]` and the debt stays paid.
