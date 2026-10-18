# Hosting (Railway)

`main` is deployed to **Railway** at a stable HTTPS URL, so VEYZL, Photon and Stripe always have something to reach, and nobody's laptop has to stay awake. Every merge to `main` redeploys automatically.

**Why Railway:** it deploys straight from GitHub on every push to `main`, and the service stays running. Free tiers that put idle apps to sleep (such as Render's free plan) can make a VEYZL audit time out during a cold start. Config: [`railway.json`](../railway.json) starts Node directly (`node --import tsx src/server.ts`, not `npm start`, so Railway's shutdown signal reaches the app and it saves before exiting), uses `/health` as the health check, and restarts on failure.

## One-time setup (a human does this: Claude can't create accounts or enter keys)

1. **Create the account:** go to [railway.com](https://railway.com) → **Login with GitHub**. Railway's free trial credit is enough for a hackathon weekend; check the current plan terms on their pricing page.
2. **Create the service:** **New Project** → **Deploy from GitHub repo** → `aknotwell/ReStock`. If asked, give the Railway GitHub app access to this repo only. Railway detects Node and reads `railway.json`.
3. **Set the variables** in the service → **Variables**. Paste the values there, not in chat or code:

   | Variable | Value | Needed for |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | Your Claude key. Ideally a **separate** key with its own spend limit, so you can revoke it after the event. | AI parsing and answers (the VEYZL "Paris" probe) |
   | `DEMO_SEED` | `1` | Seeds Sam, Jake and Priya on the first start. Once the database has a household, later starts keep the saved data instead. |
   | `DEMO_RESET` | *(only when you want a clean slate)* `1` | Re-seeds the demo household even though saved data exists. Remove it again afterwards, or every deploy wipes the demo. |
   | `DEMO_MEMBERS` | *(optional)* the real demo household as JSON, replacing Sam/Jake/Priya. See [photon.md](photon.md#demo-household). | Live demo with your own phones |
   | `AGENT_API_TOKEN` | *(optional)* a long random string | Locks `/api/agent`. Only set this if VEYZL can send `Authorization: Bearer …`. |
   | `PHOTON_API_KEY`, `PHOTON_PROJECT_ID` | *(see warning below)* | Real iMessage |
   | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `sk_test_…` / `whsec_…` only. The app refuses live keys. The `whsec_` here comes from a **dashboard webhook endpoint for this domain**, not from `stripe listen`. See [Webhooks on Railway](stripe.md#webhooks-on-railway-the-deployed-demo). | Payments: charging, add-card and pay-back links |

   Don't set `PORT`, because Railway provides it. `PUBLIC_BASE_URL` is optional: the app uses Railway's domain automatically. **Never set `DEV_INBOUND`**, because that route has no authentication.
4. **Get a public URL:** service → **Settings** → **Networking** → **Generate Domain**. You'll get something like `restock-production.up.railway.app`.
5. **Add a volume so data survives deploys:** service → **Settings** → **Volumes** (or right-click the service → **Attach Volume**) → mount path `/data`. Railway then sets `RAILWAY_VOLUME_MOUNT_PATH`, and the app saves to `/data/restock.db` automatically. To use a different file, set `DATABASE_PATH`. On the next deploy the log should say `Saving data to /data/restock.db`, and after that `Restored saved data from …`. Keep the service at **one replica**: two copies would each keep their own cart.
6. **Check it:** open `https://<domain>/health`, which should return `{"ok":true}`.
7. **Point VEYZL at it:** set the **Backend URL** to `https://<domain>` (endpoint `POST /api/agent`), then re-run an audit.
8. **Branch settings:** in Railway, keep auto-deploy on for `main` only.

## Things to know

- **Only one environment should poll Photon.** If both Railway and a laptop have `PHOTON_API_KEY`, both will answer every text. Put the Photon keys on Railway for the demo, and leave them out of local `.env` files, or use a separate Photon project for local development.
- **VEYZL audits what's deployed, which is `main`.** A PR's own code is checked by our CI job `veyzl-probes`, which replays the same probes against `POST /api/agent` on every push.
- **Data is saved to SQLite** (`src/core/persist.ts`) once a volume is attached: households, carts, orders, charges, debts, texted add-card and pay-back links, open "Which one?" questions, and where Photon polling left off. It's saved within a second of every change and again on shutdown, so a redeploy or crash loses at most the last second. Without a volume (or `DATABASE_PATH`) the log warns that data lives in memory only, and every deploy resets it. To start the demo over, deploy once with `DEMO_RESET=1`, then remove it. Message text is never stored.
- **GitHub secret for CI:** add `ANTHROPIC_API_KEY` under repo **Settings → Secrets and variables → Actions → New repository secret**, so the `veyzl-probes` job also runs the model-backed probe. Without it, that probe is skipped and the other 9 still run.
