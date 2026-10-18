# Photon 2.0 setup

Restock talks to people through **Photon 2.0**, Photon's Beta platform: the `@photon-ai/api` client and `https://api.photon.codes/v1`. Docs: https://photon.codes/docs/beta. Don't use the older Spectrum SDK (`spectrum-ts`). That's Photon's Stable product, and the track requires 2.0.

## One-time setup (Person 1)

1. Open the [Photon Beta dashboard](https://app.beta.photon.codes). Create an organization and a project, then copy the **Project ID** (`pho_prj_…`) from **Settings**.
2. Under **API keys**, create a key with `project:read` and `project:write`. It's shown only once.
3. Under **iMessage**, add each teammate's own iMessage phone number as a sender, and assign a number from the shared pool. That assigned number is the agent's number. The free plan includes 25 shared assignments.
4. Put the values in `.env`, which is never committed:
   ```
   PHOTON_API_KEY=pho_sk_...
   PHOTON_PROJECT_ID=pho_prj_...
   DEMO_SEED=1
   DEMO_PHONE_SAM=+1...     # the real handles of the people playing Sam, Jake and Priya
   DEMO_PHONE_JAKE=+1...
   DEMO_PHONE_PRIYA=+1...
   ```
5. Run `npm run dev`. The server polls Photon every 2 seconds for new messages, so it **doesn't need a public URL**.
6. Text the agent's number "help" from one of those phones.

## How it works

- **Inbound:** `startPolling` in `src/messaging/photon.ts` lists received messages, turns each one into an `InboundMessage`, and calls `handleInbound` (`src/messaging/inbound.ts`).
- **Group binding:** the demo household starts unbound. The first group text from a member links the household to that group chat. To skip this step, set `DEMO_GROUP_SPACE_ID=pho_spc_…`.
- **Direct messages:** a member who texts the agent one-to-one gets private replies there. Later private messages, like receipts and "you owe" texts, go to that DM.
- **Outbound:** replies use the agent identity that received the message (`receivedBy.id`), with an idempotency key per inbound message, so retries don't send duplicates.
- **Local testing without Photon:** set `DEV_INBOUND=1`, then:
  ```bash
  curl -X POST localhost:3000/dev/inbound -H 'content-type: application/json' -d '{"fromPhone":"+15550000001","text":"add tp"}'
  ```
  Replies are printed to the console. Never enable this on a public deploy, because the route has no authentication.

## Demo household

Households can be created over chat (`start household as …`, then `add member …`, see the table below). For a pre-built demo household instead, the seed creates Sam (owner), Jake and Priya with fake numbers, or set **`DEMO_MEMBERS`** on Railway to a JSON list (one line):

```json
[{"name":"YourName","phone":"+1206XXXXXXX","owner":true,"card":true},{"name":"David","phone":"+1…","card":true},{"name":"Amber","phone":"+1…"},{"name":"Abdul","phone":"+1…"}]
```

- `phone` must exactly match the number that person added in the Photon dashboard (`+1` plus 10 digits).
- `owner`: exactly one person, the budget owner. If nobody is marked, it's the first person. The owner always gets a card.
- `card: true` gives that person a Stripe sandbox card at startup (with `STRIPE_SECRET_KEY` set). Leave at least one person **without** a card to show the "you owe" path.
- The starter cart is spread across the owner, the first carded member, and the next member.
- When `DEMO_MEMBERS` is set, the `DEMO_PHONE_*` variables are ignored. Invalid JSON logs a warning and falls back to Sam/Jake/Priya.

## What people can text

**Casual phrasing works.** With `ANTHROPIC_API_KEY` set, Claude understands everyday wording ("yo we're out of tp", "how much do i owe rn", "who lives here again"). For anything that **spends money or changes who's in the household**, Restock asks back and acts only on your **"yes"** (within 10 minutes, and only from the person asked):

| Casual text | Restock asks | "yes" does |
|---|---|---|
| "ok let's just order everything" | *Place the order now? 6 items, $72.75.* | Places the order |
| "make me a household, I'm Alex" | *Start a household with you (Alex) as the budget owner?* | Creates it |
| "add my roommate amber, her number is 425 555 0123" | *Add Amber (phone ending 0123) to the household?* | Adds her (owner only) |
| "take jake off the house" | *Remove Jake from the household?* | Removes him (owner only) |

"no" cancels. Phone numbers are pulled out in code before Claude sees the message. The exact commands below still work instantly.

The AI understands natural phrasing. The fallback parser, used when there's no API key, understands these exact forms:

| Text | What happens | Where the reply goes |
|---|---|---|
| `start household as Alex` | Creates a household with the sender as **budget owner** (anyone not already in one) | Same chat (DM) |
| `add member Amber 425-555-0123` | **Owner only.** Adds Amber (no card yet). She must text her Restock number first. | Same chat |
| `remove member Amber` | **Owner only.** Removes her, unless she has an open balance. Never the owner. | Same chat |
| `members` | Lists names, the owner, and who has a card (no phone numbers) | Same chat |
| `add dish soap` / "we're out of TP" | Matched to the catalog and added (shared by default) | Same chat |
| `personal` / `shared` | Flips the sender's most recent item | Same chat |
| `remove dish soap` | Removes that item from the cart | Same chat |
| `order now` | Places the order and posts a summary to the group | Group; then **private** receipts, and a "you owe" text with pay-back and add-card links for members without a card |
| `what do I owe?` | The sender's own balances only | **Private** |
| `yes` (owner only) | Approves items waiting for approval | Same chat |
| `add card` | A secure Stripe add-card link | **Private** |
| `help` | What Restock is (an AI) and how it works | Same chat |

When a member adds a card, the Stripe webhook texts them "Card added, ending 4242" privately.

 (please verify on the real line)

- **Shared lines can't start conversations.** A person has to text the agent first. If a member hasn't DM'd the agent, a private message becomes a group nudge asking them to text it directly.
- **Shared-line assignments are per sender.** Each teammate needs their own assignment, and each may get a different agent number. **We haven't confirmed that a group chat works on shared lines.** If it doesn't, the demo falls back to each person DMing the agent. Ask the Photon sponsor reps about groups on shared lines.
- **Polling adds up to 2 seconds of delay.** Photon's Socket.IO event stream (`/docs/beta/websocket`) can replace it later.
