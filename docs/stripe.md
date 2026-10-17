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
stripe listen --events checkout.session.completed --forward-to localhost:3000/webhooks/stripe
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
| Owner card gate | Not built yet | |
| Charging an order (`chargeOrder`) | Not built yet | |
| Pay-back link (`createPayBackLink`) | Not built yet | |
| Short URLs (`/c/:token`, `/p/:token`) | `/c` built, `/p` not yet | `/c/:token` is tested with the add-card link. A made-up token like `/c/abc` shows "This add-card link has expired" (404). |

### Add-card link

How it works: `createCardSetupLink` makes a short link with a random token (`/c/Xk3...`) and doesn't call Stripe yet. When someone taps it, the server creates their Stripe Customer if they don't have one, creates a fresh Checkout session in `setup` mode, and redirects to it. When they finish, Stripe sends `checkout.session.completed`. Our webhook asks Stripe which card was saved and stores only `paymentMethodId` and `cardLast4` on the member.

1. Stop `npm run dev` if it's running. Start the server with the demo household loaded: `npx tsx scripts/try-card-link.ts priya`. It prints an add-card link for Priya, who has no card in the demo.
2. In a second terminal, run `stripe listen --events checkout.session.completed --forward-to localhost:3000/webhooks/stripe`.
3. Open the printed link in your browser. You should land on a Stripe page with a **Sandbox** badge and a **Save** button. No amount is shown, because nothing is charged.
4. Enter test card `4242 4242 4242 4242`, any future expiry, any CVC, and any ZIP. Uncheck "Save with Link". Click **Save**.
5. You should land on our "Card added" page.
6. Terminal 2 shows `checkout.session.completed` with `[200]`. Terminal 1 prints `priya: paymentMethodId=pm_... cardLast4=4242`.
7. Retry safety: copy the `evt_...` ID from Terminal 2 and run `stripe events resend evt_...`. You should get another `[200]`, and the member's card stays the same.
8. In the Stripe dashboard (sandbox), **Customers** shows "Priya" with a Visa ending 4242.

If step 6 shows `[400]`, your `STRIPE_WEBHOOK_SECRET` doesn't match `stripe listen --print-secret`. Redo setup step 3, then restart the server. Links only last until the server restarts, because tokens are kept in memory for now.
