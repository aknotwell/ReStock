# Hosting (Railway)

`main` is deployed to **Railway** at a stable HTTPS URL, so VEYZL, Photon and Stripe always have something to reach, and nobody's laptop has to stay awake. Every merge to `main` redeploys automatically.

**Why Railway:** it deploys straight from GitHub on every push to `main`, and the service stays running. Free tiers that put idle apps to sleep (such as Render's free plan) can make a VEYZL audit time out during a cold start. Config: [`railway.json`](../railway.json) starts Node directly (`node --import tsx src/server.ts`, not `npm start`, so Railway's shutdown signal reaches the app and it saves before exiting), uses `/health` as the health check, and restarts on failure.

## Live links

The deploy runs at **https://restock.select**. The original Railway address, https://restock-production-daab.up.railway.app, still works too, and VEYZL and the Stripe webhook still use it.

**Custom domain:** `restock.select` is registered at Porkbun. Its DNS has an `ALIAS` record (blank host) pointing at the target Railway shows under the service's **Settings** → **Networking** → **Custom Domain**, plus the `_railway-verify` `TXT` record Railway asks for. Porkbun's parking records (anything pointing at `pixie.porkbun.com`) were deleted. Railway issues the HTTPS certificate. `PUBLIC_BASE_URL=https://restock.select` is set in Railway's Variables so the links Restock texts (invites, add-card and pay-back pages, Stripe return pages) use the custom domain.

| Page | URL | Who uses it |
|---|---|---|
| Sign up: start a household | `/start` | New people: get a Restock number, then text "hi" to activate |
| Sign up: join with an invite | `/join/<code>` | Roommates invited by the owner |
| Terms and privacy | `/privacy` | Linked from the sign-up consent box |
| Dashboard (texted-code login) | `/dashboard` | Members: a live, read-only view of their household |
| Pay back (texted-code login) | `/pay` | Members who owe: settle on Stripe's page |
| Add-card / pay-back links | `/c/<token>`, `/p/<token>` | Opened from Restock's texts; they redirect to Stripe |
| Stripe return pages | `/card/success`, `/pay/success`, `/cancel` | After Stripe Checkout |
| Health | `/health` | Uptime checks |
| Stripe webhook | `POST /webhooks/stripe` | Stripe (register this URL in the Stripe dashboard) |
| VEYZL audit endpoint | `POST /api/agent` | VEYZL (its Backend URL is the root URL above) |

People sign up on the web (`/start`, or an owner's `/join/<code>` link) and activate by texting "hi" to the Restock number they're given. The website's "Text me a code" only reaches people who have texted their Restock number one-on-one at least once, because Photon's shared lines can't text first. Anyone can text **code** to their Restock number instead, and the reply carries a login code. The deploy logs show one `login code:` line per request (sent, not sent and why, or no member with that number), with only the last 4 digits.

## Real-user checklist

- **Photon key needs `platforms:write` and `platforms:read`** (as well as `project:read` and `project:write`). `platforms:write` lets web sign-up assign each person a Restock line; without it, sign-up shows "Restock can't create new lines right now". Deleting an account ("delete my data", or the owner's "remove member") releases that person's line in Photon too, and `platforms:read` lets it also find and release lines Restock lost track of. A release that fails is retried every 10 minutes.
- **Attach a Railway volume** to the service (any mount path). The server then saves to `<mount>/restock.db` automatically (`RAILWAY_VOLUME_MOUNT_PATH`), so deploys and restarts keep households.
- **Capacity:** each person uses one Photon shared-line seat (25 on the free plan, 100 on Pro). Sign-ups that never text "hi" are freed after 24 hours, and at most 20 can be waiting at once.
- **Limits:** sign-up is limited to 10 per IP and 5 per phone per hour, and `/api/agent` to 60 requests per IP per minute.

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
   | `SERPAPI_KEY` | *(optional)* your [SerpApi](https://serpapi.com) key (free plan: 250 searches/month). Spell the name exactly; the app ignores anything else. | Live store prices in the "Which one?" options. Without it, options come from the catalog. |
   | `DEALS_LOCATION`, `DEALS_DAILY_LIMIT`, `DEALS_ANY_STORE` | *(optional)* e.g. `Seattle, Washington, United States` / `25` / `1` | Local prices, the daily search cap (default 25), and including small sellers (default: major retailers only). See [.env.example](../.env.example). |
   | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `sk_test_…` / `whsec_…` only. The app refuses live keys. The `whsec_` here comes from a **dashboard webhook endpoint for this domain**, not from `stripe listen`. See [Webhooks on Railway](stripe.md#webhooks-on-railway-the-deployed-demo). | Payments: charging, add-card and pay-back links |

   Don't set `PORT`, because Railway provides it. `PUBLIC_BASE_URL` is optional: the app uses Railway's domain automatically. **Never set `DEV_INBOUND`**, because that route has no authentication.
4. **Get a public URL:** service → **Settings** → **Networking** → **Generate Domain**. You'll get something like `restock-production.up.railway.app`.
5. **Add a volume so data survives deploys:** service → **Settings** → **Volumes** (or right-click the service → **Attach Volume**) → mount path `/data`. Railway then sets `RAILWAY_VOLUME_MOUNT_PATH`, and the app saves to `/data/restock.db` automatically. To use a different file, set `DATABASE_PATH`. On the next deploy the log should say `Saving data to /data/restock.db`, and after that `Restored saved data from …`. Keep the service at **one replica**: two copies would each keep their own cart.
6. **Check it:** open `https://<domain>/health`, which should return `{"ok":true}`. If you set `SERPAPI_KEY`, also send `curl -X POST https://<domain>/api/agent -H 'content-type: application/json' -d '{"prompt":"add tp from Target"}'`: a working key shows a Target listing and "Store prices checked just now". Catalog-only options with "Nothing matched from Target" mean the app doesn't have the key (check the variable's spelling, and that you're in the project that owns this domain), then send `cancel`. Every price lookup also writes one `[serpapi]` line to the deploy logs: `ok` with status, time and result counts (plus `skipped=` with why rows didn't become listings: `malformed`, `noPrice`, `blocked`, `outOfRange`, `duplicate`), `cache hit`, `listings kept=…` (how many survived the filters), `failed reason=…` (timeout, HTTP error, or SerpApi's own error message), `skipped: daily cap reached`, or, once, `off: SERPAPI_KEY is not set` the first time someone asks for an item without a key. The key and request URL are never logged.
7. **Point VEYZL at it:** set the **Backend URL** to `https://<domain>` (endpoint `POST /api/agent`), then re-run an audit.
8. **Branch settings:** in Railway, keep auto-deploy on for `main` only.

## Things to know

- **Only one environment should poll Photon.** If both Railway and a laptop have `PHOTON_API_KEY`, both will answer every text. Put the Photon keys on Railway for the demo, and leave them out of local `.env` files, or use a separate Photon project for local development.
- **VEYZL audits what's deployed, which is `main`.** A PR's own code is checked by our CI job `veyzl-probes`, which replays the same probes against `POST /api/agent` on every push.
- **Data is saved to SQLite** (`src/core/persist.ts`) once a volume is attached: households, carts, orders, charges, debts, texted add-card and pay-back links, open "Which one?" questions, and where Photon polling left off. It's saved within a second of every change and again on shutdown, so a redeploy or crash loses at most the last second. Without a volume (or `DATABASE_PATH`) the log warns that data lives in memory only, and every deploy resets it. To start the demo over, deploy once with `DEMO_RESET=1`, then remove it. Message text is never stored.
- **GitHub secret for CI:** add `ANTHROPIC_API_KEY` under repo **Settings → Secrets and variables → Actions → New repository secret**, so the `veyzl-probes` job also runs the model-backed probe. Without it, that probe is skipped and the other 9 still run.
