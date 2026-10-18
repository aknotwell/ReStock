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
| Intent parsing | `src/ai/parseMessage.ts`, prompt in `src/ai/prompt.ts` | One chat message and the sender's first name | Intents: `add_item`, `remove_item`, `set_shared`, `order_now`, `what_do_i_owe`, `approve`, `help`, `unknown` | Command parser (`src/messaging/commands.ts`) |
| Product matching | `src/ai/matchItem.ts` | The requested item text | A `productId` from the catalog, plus a confidence level | Keyword and alias match (`src/core/catalog.ts`) |
| Restock suggestions | `src/ai/suggestRestock.ts` | Purchase history (product IDs and dates), the current cart, today's date | Up to 3 catalog products, each with a one-line reason | Restock-interval rule (`dueByInterval`) |

## Data

- **Product catalog:** `data/catalog.json`. A curated demo dataset of household products with prices in integer cents, aliases, categories, and typical restock intervals. The AI may only choose IDs from this dataset. **Names and prices always come from the dataset, never from the model.**
- **Sent to the model:** the text of one chat message, the sender's first name, product IDs, and purchase dates.
- **Never sent to the model:** card numbers (removed by the Luhn guard in `src/messaging/guard.ts` before the AI sees anything), phone numbers, payment data, Stripe IDs, or other households' data.
- **Stored:** cart items, orders, shares, and debts (`src/core/store.ts`). We don't store message bodies, model prompts, or responses.

## Human oversight and controls

1. **No autonomous spending.** The AI can't place an order or charge anyone. The inbound handler parses the exact human command "order now" deterministically, bypassing the AI, and rejects any `order_now` intent from other text. Expensive personal items need the budget owner to approve them.
2. **The money math is deterministic.** Shares are computed by `computeShares` in `src/core/split.ts`, in integer cents, never by the model.
3. **Transparent results.** Every change the AI makes is echoed back, e.g. "Added Dish soap, 3 pack (shared, $8.49). Reply 'personal' to change." Users can correct or undo it with a text.
4. **Output validation.** Every model response must match a Zod schema, and product IDs must exist in the catalog. Low-confidence matches, refusals, malformed output, and API errors all fall back to deterministic code.
5. **AI disclosure.** The agent tells users it's an AI assistant (the "help" reply, `helpMessage` in `src/messaging/templates.ts`) and never poses as a household member.
6. **Prompt-injection resistance.** The system prompts tell the model to ignore instructions inside chat messages, and the model has no tools that could act on them.
7. **Sensitive data protection.** The card-number guard runs before any household lookup or AI call, and adding a card happens only on Stripe-hosted pages, in test mode. AI fallback warnings do not print exception details that could contain message text.

## Known risks and mitigations

| Risk | Mitigation |
|---|---|
| The model misreads a message and adds the wrong item | Every addition is echoed back and can be changed with a reply. Nothing is bought until "order now". |
| The model invents a product or price | Only catalog IDs are accepted, and the price comes from the catalog |
| The model triggers an order on its own | `order_now` is acted on only when the message explicitly asks. Charging is deterministic code behind that command. |
| A member pastes a card number | The Luhn guard drops the message before the AI or the database sees it, and the member gets a private secure link instead |
| The LLM is unavailable during the demo | Every component has a deterministic fallback, covered by tests in `test/ai-fallbacks.test.ts` |
| Unfair splits | Split rules are explicit and visible in the group summary, and covered by unit tests |

## Evaluation

- Unit tests: `npm test` (fallback paths, card-number guard, command parser, split engine).
- VEYZL audits every PR. Findings and fixes are logged in [docs/veyzl.md](veyzl.md).
- To do (P1): a small labeled set of household messages with expected intents, to measure parsing accuracy.
