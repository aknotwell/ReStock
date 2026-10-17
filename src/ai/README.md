# Restock agent (Person 1)

## Try the conversation locally

```sh
npm ci
npm run agent:demo
# Or replay the six-item $72.75 scenario:
npm run agent:demo -- --script
# Opt in to Claude for requests outside the fallback grammar:
npm run agent:demo -- --ai
```

The harness uses fake household members, local terminal replies and a checkout handoff stub. It never sends a real text or charges a card. `example.test` links are intentionally nonfunctional. Prefix input with `sam:`, `jake:` or `priya:`. The default speaker is Priya. Use `exit` to stop.

Try `add 2 dish soap`, `add fragrance-free dish soap`, `yes`, `make chips shared`, `remove chips`, `cart`, `approve air fryer`, `order now`, `what do i owe`, `add card`, and `cancel`. `yes` can answer the sender's pending product question or the owner's most recent unexpired approval request; it never places an order. Clarifications expire after ten minutes. Catalog quantities count packs, not rolls within a pack. Unknown or constrained products require the user to accept a specific catalog alternative. The catalog is demo data, not live retailer stock or prices.

## AI and application boundary

`parseMessage.ts` uses the existing Anthropic SDK with schema-constrained output, an eight-second timeout, no automatic retries, and a command-parser fallback. Set `ANTHROPIC_API_KEY` in `.env`; `ANTHROPIC_MODEL` optionally overrides the existing default. Explicit commands run deterministically even when AI is configured. Provider error bodies are never logged. `prompt.ts` and `intent.ts` hold the instructions and action schema. Runtime schema validation remains mandatory at the executor boundary.

`inbound.ts` serializes messages per household, binds questions to the member, deduplicates message IDs, and retains unsent replies in an in-memory outbox. The card guard runs before household lookup or parsing. Model output cannot authorize money movement or approve an item. Only the literal `order now` command reaches checkout; the displayed cart fingerprint must still match the cart, membership and budget. Personal lines over $25 need owner approval. Only the adder or owner can edit an item. The app reports demo fulfillment honestly and sends debt information privately.

## Photon 2.0 cloud wiring

The integration uses the `spectrum-ts` cloud iMessage provider. Source contracts: [Spectrum getting started](https://photon.codes/docs/spectrum-ts/getting-started), [iMessage](https://photon.codes/docs/spectrum-ts/providers/imessage), [signed webhooks](https://photon.codes/docs/spectrum-ts/webhooks).

1. Set `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, and `SPECTRUM_WEBHOOK_SECRET` in `.env` from the Photon project.
2. Register the public HTTPS `/webhooks/photon` endpoint. It accepts raw signed native Spectrum deliveries, never arbitrary normalized JSON. The SDK verifies HMAC signatures and timestamp freshness.
3. Provision the household with the real Photon group space ID and E.164 member numbers through Person 2's data setup. The current store is in-memory: `npm run seed` in a separate process does not populate the running server. Person 2/4 must seed or load the household in the server process. Do not use the fake seed's card IDs for a live Stripe test.
4. Start `npm run dev`. Text from the registered group. The agent ignores outbound echoes and nontext events. Private receipts use a Spectrum DM. Photon account/line permissions must permit the intended recipients and group.

Credential-free tests exercise message normalization and the unsigned-request rejection. Actual signed cloud delivery, Claude requests and Stripe payments still require a configured account and must be verified on the demo phones. No external messages or payments were sent during development.

## Integration handoffs and limits

- **Person 2:** `computeShares` is still a stub, and its six existing tests remain skipped. Implement it and enable those tests. Replace the agent's narrow store adapter in `messaging/cart.ts` and member join mutation with durable store operations. The agent does not fork shared types or implement a competing split engine.
- **Person 2/3:** `placeOrder`/`chargeOrder` must durably track an order attempt and per-member idempotency keys, reconcile partial payments, and verify successful funding before returning. `chargeOrder` and the secure link functions are still stubs. The agent catches failures, never emits a success receipt for a thrown error, and pauses further checkout on uncertain outcomes.
- **Person 3:** implement signed Stripe webhooks and actual test-mode hosted card/payback links. Owner coverage, failed-card fallback and debt creation belong here. Receipt templates consume the agreed `OrderResult`.
- **Person 4:** supply real test customer/payment method IDs and the in-process demo seed; run the real-phone demonstration and VEYZL PR check. This work does not claim a VEYZL audit result.
- Actual retailer purchasing is not implemented. The agent explicitly describes fulfillment as simulated and does not invent an ETA. A merchant order integration requires an agreed expansion to PLAN.md.
- Session state, approvals, dedupe records and outbox entries currently live for the process lifetime. Restarting loses them; multiple server processes do not coordinate. Spectrum dispatches webhook handlers asynchronously, so delivery failure after HTTP acknowledgement needs explicit replay/reconciliation. Before deployment beyond the hackathon, Person 2 must provide durable event/outbox storage, checkout locks and recovery. Do not enable production payments.
- `@opentelemetry/core` is overridden to 2.8.0 to fix GHSA-8988-4f7v-96qf in the Photon dependency tree. Telemetry is disabled; keep the override until the upstream dependency is patched.

## Verification

```sh
npm test
npm run typecheck
npm run agent:demo -- --script
```

Agent tests cover product clarification, sender binding and expiry, deterministic prices, edit permissions, owner approval, cart changes, budgets, card guarding, duplicate/retried messages, uncertain checkout and private receipts. The six-item integration test injects a fake checkout with the agreed $72.75 split to test the handoff and messaging; it does not validate the unimplemented split engine or Stripe integration.
