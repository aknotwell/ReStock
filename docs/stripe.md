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
stripe listen --forward-to localhost:3000/webhooks/stripe
```

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
| Add-card link (`createCardSetupLink`) | Not built yet | |
| Owner card gate | Not built yet | |
| Charging an order (`chargeOrder`) | Not built yet | |
| Pay-back link (`createPayBackLink`) | Not built yet | |
| Short URLs (`/c/:token`, `/p/:token`) | Not built yet | |
