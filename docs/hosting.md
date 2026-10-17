# Hosting (Railway)

`main` is deployed to **Railway** at a stable HTTPS URL, so VEYZL, Photon and Stripe always have something to reach, and nobody's laptop has to stay awake. Every merge to `main` redeploys automatically.

**Why Railway:** it deploys straight from GitHub on every push to `main`, and the service stays running. Free tiers that put idle apps to sleep (such as Render's free plan) can make a VEYZL audit time out during a cold start. Config: [`railway.json`](../railway.json) runs `npm start`, uses `/health` as the health check, and restarts on failure.

## One-time setup (a human does this: Claude can't create accounts or enter keys)

1. **Create the account:** go to [railway.com](https://railway.com) → **Login with GitHub**. Railway's free trial credit is enough for a hackathon weekend; check the current plan terms on their pricing page.
2. **Create the service:** **New Project** → **Deploy from GitHub repo** → `aknotwell/ReStock`. If asked, give the Railway GitHub app access to this repo only. Railway detects Node and reads `railway.json`.
3. **Set the variables** in the service → **Variables**. Paste the values there, not in chat or code:

   | Variable | Value | Needed for |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | Your Claude key. Ideally a **separate** key with its own spend limit, so you can revoke it after the event. | AI parsing and answers (the VEYZL "Paris" probe) |
   | `DEMO_SEED` | `1` | Seeds Sam, Jake and Priya at startup (the store is in memory) |
   | `AGENT_API_TOKEN` | *(optional)* a long random string | Locks `/api/agent`. Only set this if VEYZL can send `Authorization: Bearer …`. |
   | `PHOTON_API_KEY`, `PHOTON_PROJECT_ID` | *(see warning below)* | Real iMessage |
   | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `sk_test_…` / `whsec_…` only. The app refuses live keys. | Payments, once P3 lands |

   Don't set `PORT`, because Railway provides it. `PUBLIC_BASE_URL` is optional: the app uses Railway's domain automatically. **Never set `DEV_INBOUND`**, because that route has no authentication.
4. **Get a public URL:** service → **Settings** → **Networking** → **Generate Domain**. You'll get something like `restock-production.up.railway.app`.
5. **Check it:** open `https://<domain>/health`, which should return `{"ok":true}`.
6. **Point VEYZL at it:** set the **Backend URL** to `https://<domain>` (endpoint `POST /api/agent`), then re-run an audit.
7. **Branch settings:** in Railway, keep auto-deploy on for `main` only.

## Things to know

- **Only one environment should poll Photon.** If both Railway and a laptop have `PHOTON_API_KEY`, both will answer every text. Put the Photon keys on Railway for the demo, and leave them out of local `.env` files, or use a separate Photon project for local development.
- **VEYZL audits what's deployed, which is `main`.** A PR's own code is checked by our CI job `veyzl-probes`, which replays the same probes against `POST /api/agent` on every push.
- **Data resets on every deploy and restart** (in-memory store). `DEMO_SEED=1` brings the demo household back, and with `STRIPE_SECRET_KEY` set it also gives Sam and Jake their sandbox cards again (see [docs/stripe.md](stripe.md#demo-household-cards)).
- **GitHub secret for CI:** add `ANTHROPIC_API_KEY` under repo **Settings → Secrets and variables → Actions → New repository secret**, so the `veyzl-probes` job also runs the model-backed probe. Without it, that probe is skipped and the other 9 still run.
