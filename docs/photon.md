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

## Known limits (please verify on the real line)

- **Shared lines can't start conversations.** A person has to text the agent first. If a member hasn't DM'd the agent, a private message becomes a group nudge asking them to text it directly.
- **Shared-line assignments are per sender.** Each teammate needs their own assignment, and each may get a different agent number. **We haven't confirmed that a group chat works on shared lines.** If it doesn't, the demo falls back to each person DMing the agent. Ask the Photon sponsor reps about groups on shared lines.
- **Polling adds up to 2 seconds of delay.** Photon's Socket.IO event stream (`/docs/beta/websocket`) can replace it later.
