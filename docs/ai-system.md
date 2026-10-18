# Restock AI system card

What the AI in Restock does, what data it uses, and what controls keep it safe. It's kept current for judges, for the VEYZL audit (EU AI Act, NIST AI RMF, ISO/IEC 42001), and for the team.

## Summary

| | |
|---|---|
| **System type** | Hybrid AI: a hosted LLM API (Claude) plus a curated product dataset and deterministic business logic |
| **Model** | Anthropic Claude, `claude-opus-5-5`, through the Messages API (`@anthropic-ai/sdk`), with structured outputs validated by Zod |
| **Where it runs** | Server side, in `src/ai/`. The client and model are configured in `src/ai/client.ts`. |
| **Users** | Members of a household group chat (roommates, families) texting through Photon (iMessage/SMS) |
| **Purpose** | Turn casual chat into a shared shopping cart, match requests to real products, and suggest restocks |
| **Not used for** | Moving money, setting prices, deciding who pays, or making any decision about a person |

## AI components

| Component | File | Input | Output (schema-validated) | Fallback without AI |
|---|---|---|---|---|
| Intent parsing | `src/ai/parseMessage.ts`, prompt in `src/ai/prompt.ts` | One guarded chat message; a generic member label | Intents: `add_item`, `remove_item`, `set_shared`, `what_do_i_owe`, `help`, `question`, `unknown`; checkout/approval are deterministic commands | Command parser (`src/messaging/commands.ts`) |
| Product matching | `src/ai/matchItem.ts` | The requested item text | A `productId` from the catalog, plus a confidence level. Code then lists up to 3 options from that product's group, ranked by price per unit, for the member to choose (`src/messaging/options.ts`) | Keyword and alias match (`src/core/catalog.ts`) |
| Restock suggestions | `src/ai/suggestRestock.ts` | Purchase history (product IDs and dates), the current cart, today's date | Up to 3 due catalog products, each with a calculated reason | Restock-interval rule (`dueByInterval`) |
| General questions | `src/ai/answerQuestion.ts` | One guarded question | Reviewed fact with a fixed source citation, exact catalog price, or fixed uncertainty/refusal | Same deterministic behavior |

## Data

- **Product catalog:** `data/catalog.json`. A curated demo dataset of household products with prices in integer cents, aliases, categories, and typical restock intervals. Products with a `group` are alternatives (e.g. bulk or fragrance-free) to the product with that id. `units` and `unit` give the pack size (12 rolls, 64 loads) so options can be compared by price per unit. The AI may only choose IDs from this dataset. **Names and prices always come from the dataset, never from the model.**
- **Sent to the model:** the guarded text of one chat message, product IDs, and purchase dates. Member names are not sent by the intent parser.
- **Never sent to the model:** card numbers (removed by the Luhn guard in `src/messaging/guard.ts` before the AI sees anything), phone numbers, payment data, Stripe IDs, or other households' data.
- **Stored:** cart items, orders, shares, and debts (`src/core/store.ts`), saved to a SQLite file on the server (`src/core/persist.ts`) along with texted link tokens, reply routing (which chat to answer in), open "Which one?" questions, and the IDs of messages already handled. We don't store message bodies, model prompts, or responses, and a test checks the database file never contains message text.

## Human oversight and controls

1. **No autonomous spending.** The AI can't place an order or charge anyone. Charges happen only after a member explicitly texts "order now", and only for the cart everyone can see. Expensive personal items need the budget owner to approve them.
2. **The money math is deterministic.** Shares are computed by `computeShares` in `src/core/split.ts`, in integer cents, never by the model.
3. **The member chooses the product.** A generic request ("add TP") gets three numbered catalog options. Code (not the model) sorts them by price per unit, shows each unit price, and labels the cheapest "best value" when the options share a unit; the household's last purchase, if any, stays at the top. Nothing is added until the person who asked replies 1, 2 or 3 (the question expires after 10 minutes, and "cancel" drops it). Replies are parsed by code, never by the model, and a pick never places an order. "The usual" adds the household's most recent purchase from that group, found in its own order history by code; if there is none, the agent says so and shows the options.
4. **Transparent results.** Every change the AI makes is echoed back, e.g. "Added Dish soap, 3 pack (shared, $8.49). Reply 'personal' to change." Users can correct or undo it with a text.
5. **Output validation.** Every model response must match a Zod schema, and product IDs must exist in the catalog. Low-confidence matches, refusals, malformed output, and API errors all fall back to deterministic code.
6. **AI disclosure.** The agent tells users it's an AI assistant (the "help" reply, `helpMessage` in `src/messaging/templates.ts`) and never poses as a household member. Identity questions ("are you a bot?", "is this a real person?", "who is this") are matched in code (`isIdentityQuestion` in `src/messaging/commands.ts`) and get the same reply with or without the LLM; `answerQuestion` checks them too in case the model labels one a question.
7. **Prompt-injection resistance.** Parser output cannot authorize checkout or approval. The inbound handler independently requires the exact `order now` command from a household member before calling the order module.  The system prompts tell the model to ignore instructions inside chat messages, and the model has no tools that could act on them.
8. **Deterministic guardrails before the model** (`src/safety/guardrails.ts`):
   - Self-harm gets a fixed crisis-resource reply.
   - Disallowed content (weapons, drugs, malware, violence) gets a fixed refusal.
   - Prompt injection and data-exfiltration attempts get a fixed refusal.
   - Fabrication requests get a fixed refusal.
   - SSNs and card-shaped numbers get a fixed refusal and are never echoed.
9. **Output redaction** (`src/safety/redact.ts`): every outbound text is stripped of emails, phone numbers, IDs, card numbers, and API keys.
10. **Factual grounding.** General answers use only reviewed facts with versioned sources or exact demo catalog lookups. Unsupported questions get a fixed uncertainty reply. Restock reasons are computed from purchase dates rather than copied from model prose. The currently reviewed general fact is France’s capital, verified against the EU country profile on 2026-10-17. This is deliberately limited coverage, not a general knowledge assistant.
11. **Audit endpoint** (`POST /api/agent`): runs the real pipeline for a sandbox household so VEYZL can test it. Optionally protected with a bearer token (`AGENT_API_TOKEN`).
12. **Sensitive data protection.** The card-number guard runs before the AI, and adding a card happens only on Stripe-hosted pages, in test mode.

## Known risks and mitigations

| Risk | Mitigation |
|---|---|
| The model misreads a message and adds the wrong item | Every addition is echoed back and can be changed with a reply. Nothing is bought until "order now". |
| The model invents a product or price | Only catalog IDs are accepted, and the price comes from the catalog |
| The model triggers an order on its own | `order_now` is acted on only when the message explicitly asks. Charging is deterministic code behind that command. |
| A member pastes a card number | The Luhn guard drops the message before the AI or the database sees it, and the member gets a private secure link instead. Digit groups may be split by any whitespace (tabs, newlines, repeated spaces), dots, slashes, underscores, or dashes, and a card followed by its expiry/CVC is still caught |
| The LLM is unavailable during the demo | Every component has a deterministic fallback, covered by tests in `test/ai-fallbacks.test.ts` |
| Unfair splits | Split rules are explicit and visible in the group summary, and covered by unit tests |

## Evaluation

- Unit tests: `npm test` (fallback paths, card-number guard, command parser, split engine).
- VEYZL audits every PR. Findings and fixes are logged in [docs/veyzl.md](veyzl.md).
- To do (P1): a small labeled set of household messages with expected intents, to measure parsing accuracy.

## Follow-up audit validation (V-007)

`test/audit-pipeline.test.ts` runs all ten reported probes through the inbound and output paths without model credentials or external sends. `test/model-boundaries.test.ts` covers malicious/malformed model output, sensitive inputs, sanitized provider errors, and computed restock reasons. `test/checkout-authorization.test.ts` verifies the command/member gate and the checkout handoff with a mocked order service.

These are local regressions, not proof of a passing remote VEYZL audit. Existing split-engine tests remain skipped and the real Stripe/merchant checkout demo is not verified here. Regex moderation is defense in depth and cannot detect every paraphrase or encoding. No raw model-written answer is sent from the general-question path.
