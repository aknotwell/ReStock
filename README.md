# Restock

**An AI agent that lives in your household's group chat. It keeps shared supplies stocked, places the order, and splits the bill fairly, so nobody is stuck fronting the money or chasing roommates on Venmo.**

Built at **DubHacks '26**.

> Tracks: **Visa: Reimagine Shopping** (title track) · **Photon: Messaging Agent** · **VEYZL: Best Use of VEYZL** · **Best Startup Idea**

## Try it live

| | Link |
|---|---|
| **Home**: see how Restock works | [restock-production-daab.up.railway.app](https://restock-production-daab.up.railway.app/) |
| **Start or join a household** | [restock-production-daab.up.railway.app/start](https://restock-production-daab.up.railway.app/start) |
| **Dashboard**: switch between your Personal space and all your Groups | [restock-production-daab.up.railway.app/dashboard](https://restock-production-daab.up.railway.app/dashboard) |
| Privacy | [restock-production-daab.up.railway.app/privacy](https://restock-production-daab.up.railway.app/privacy) |
| Health check | [restock-production-daab.up.railway.app/health](https://restock-production-daab.up.railway.app/health) |

**Sign up on the web:**
1. **Start a household** at [restock-production-daab.up.railway.app/start](https://restock-production-daab.up.railway.app/start): enter your first name and mobile number and give consent. Restock gives you **your own Restock iMessage number**.
2. **Text "hi" to that number** (the page has an *Open Messages* button). Your first text activates you as the budget owner, and Restock replies with an invite link.
3. **Invite roommates** with that link (or text Restock `invite`). They open `/join/<code>`, sign up, and text "hi" to join. Everyone hears "Amber joined the household."
4. **Add your card:** text `add card` and use the secure Stripe link (test mode).
5. **Log in to the [dashboard](https://restock-production-daab.up.railway.app/dashboard)** with the same phone number. Restock texts you a 6-digit code. Use the Groups and Personal navigation to switch between spaces.

Each person texts their own Restock number, and Restock relays household news (items added, orders, who joined) to everyone's thread. Text `STOP` to stop texts and `delete my data` to leave. Orders are a demo: nothing ships, and payments are Stripe test mode.

---

## The problem

Every shared household has the same loop. Someone notices the toilet paper is gone, someone else buys it, and then there's an awkward "you owe me $3.99" text. Personal items get mixed in with shared ones. One person always ends up fronting the money.

## What Restock does

You text Restock the way you'd text your roommates, on iMessage, through **Photon 2.0**. No app to install.

Here's the demo household (Sam is the budget owner; Jake and Priya are roommates). The replies are Restock's real wording:

```
Priya:    we're out of dish soap
Restock:  Which one?
          1. Dish soap, 3 pack: $8.49 ($2.83/bottle, best value)
          2. Dish soap, single 24 oz bottle: $3.49 ($3.49/bottle)
          3. Dish soap, plant-based, 2 pack: $9.99 ($5.00/bottle)
          Reply 1, 2 or 3, or "cancel".
Priya:    1
Restock:  Added Dish soap, 3 pack (shared, $8.49). Reply "personal" to change.
Jake:     personal            (about his tortilla chips)
Restock:  Tortilla chips is now personal (just Jake).
Sam:      order now
Restock:  Ordered! 6 items, $72.75, shared items split evenly, personal items paid by whoever added them.
          Sam $15.65 · Jake $46.95 · Priya $10.15
          Arrives Thursday. Household budget left: $112.40
          (Demo order: nothing ships, and payments are Stripe test mode.)
```

Then everyone gets a **private** text:

```
→ Sam:    Receipt: your share is $15.65, charged to your Visa ending 4242.
          Your card also covered $10.15 for roommates without a card. I'll remind them to pay you back.
→ Jake:   Receipt: your share is $46.95, charged to your card ending 5556.
→ Priya:  Your share of this week's order is $10.15. Sam's card covered it.
          Pay Sam back: https://…/p/<token>
          Or add a card so it's paid automatically next time: https://…/c/<token>
```

Natural phrasing like "we're out of dish soap" is understood by Gemini. Without an API key, Restock falls back to exact commands like `add dish soap`.

**The payment model:** only the budget owner has to add a card. Everyone else can join and start adding items right away; their share is covered and tracked until they pay back or add a card. Orders never get stuck.

### What you can text

| Text | What happens |
|---|---|
| `start household as Alex` | Creates a household with you as budget owner |
| `add member Amber 425-555-0123` | Owner only: adds a roommate (no card needed) |
| "we're out of TP" / `add dish soap` | AI matches it to the catalog. Three options, ranked by price per unit, with the best value labeled. |
| `personal` / `shared` | Flips your last item between split-with-everyone and just-you |
| `order now` | Places the order (explicit command only) and charges everyone's share |
| `what do I owe?` | Your balance, privately |
| `add card` | A private, secure Stripe link. Card numbers never go through chat. |
| `members`, `remove member …`, `help` | Household management and an AI disclosure |

---

## How it maps to the tracks

### Visa: Reimagine Shopping
| Rubric | How Restock answers it |
|---|---|
| **Innovation** | Shopping moves into the group chat people already use. The AI turns casual messages ("we're out of TP") into a shared cart and splits it by who added what. |
| **User experience** | No app to install: after joining through a web invite, roommates use text. Only the owner needs a card. Every action is confirmed in plain language and can be undone by replying. |
| **Technical execution** | Gemini (structured outputs, validated against schemas) for intent parsing, catalog matching and grounded answers. A real Photon 2.0 iMessage integration. Real Stripe (test mode) hold-then-capture charges per member. |
| **Commerce impact** | Fewer forgotten essentials, faster checkout, value-ranked options, and no one fronting money: unpaid shares are tracked and paid back with one link. |
| **Trust & responsibility** | See [Trust and safety](#trust-and-safety) and the VEYZL audit below. |

### Photon: Messaging Agent
- Built on the **Photon 2.0** API (`@photon-ai/api`), live on **iMessage** through Photon's shared lines.
- The agent participates in the household's conversation: it confirms adds, asks which product you mean, posts the order summary, and sends private receipts and "you owe" texts.
- Setup, the full command list, and known limits are in [docs/photon.md](docs/photon.md).

### VEYZL: Best Use of VEYZL
VEYZL's API audit probes the deployed app on `main`, not the files changed in a pull request, so even a documentation-only PR can fail on live agent behavior. Our `veyzl-probes` CI job separately checks each PR's code. **VEYZL's findings changed what we shipped:**

| ID | What VEYZL found | What we changed |
|---|---|---|
| V-001 | SSN and card number echoed back | Fixed refusals in code; card-shaped numbers caught even when they fail the Luhn check |
| V-002 | No output filter | Every outbound text is redacted (emails, phone numbers, IDs, keys) |
| V-003 | Self-harm not refused | Deterministic crisis response (988 / findahelpline.com), never generated by the model |
| V-004 | Harmful instructions not refused | Code-level refusals for weapons, drugs, malware, violence |
| V-005 | Prompt injection and data exfiltration | Code-level refusals; chat text passed to the model as untrusted data |
| V-006 | Fabrication and accuracy | Grounded answer schema; fabrication refused in code |
| V-007 | Authorization and grounding | Orders need an explicit command; source-backed answers |
| V-008 | Card reply wasn't an explicit refusal | "I can't confirm, store, or repeat card numbers…" |

Our first audits failed **8 metrics**. We fixed each finding in code, got VEYZL testing the live deployed app, and fixed one more issue that only showed up there (V-008). The audit then passed **all 11 gated metrics (14 probes)**. Every fix is a commit tagged `VEYZL: V-###`, with before/after evidence and audit links in **[docs/veyzl.md](docs/veyzl.md)**. Our own CI also replays VEYZL's probes against every PR's code (`veyzl-probes`).

### Best Startup Idea
- **Who it's for:** roommates, students, couples, and families. Anyone who shares supplies and a bill.
- **How it spreads:** every household brings in 2–9 people, and every member is one text away from starting their own household. Growth happens inside group chats that already exist.
- **How it makes money:** merchant and retail partnerships on the orders it places, and a premium tier for larger households (budgets, recurring restocks, analytics).
- **Why now:** messaging agents (Photon) and dependable structured LLM output make "shopping in the chat" practical, and split payments remove the main social friction of shared buying.

---

## Trust and safety

The AI understands messages. **Code** handles money, membership and safety.

- **The AI never moves money.** Charges happen only after an explicit `order now`, and only for the cart everyone can see. Expensive personal items need the owner's approval.
- **Money math is deterministic:** integer cents, split per item, with remainders assigned in a fixed way so shares always add up exactly ([`src/core/split.ts`](src/core/split.ts)).
- **No card numbers, ever.** A card-number guard runs before the AI or the database sees a message. Cards are added only on Stripe-hosted pages, and we store only Stripe IDs and the last 4 digits.
- **Guardrails before the model:** fixed responses for self-harm, disallowed content, injection and exfiltration, fabrication, and sensitive IDs ([`src/safety/`](src/safety)).
- **Output redaction:** no emails, phone numbers, IDs or keys leave the service, and our own links stay intact.
- **Membership is code, not AI:** only the owner can add or remove people. Replies show only the last 4 digits of a phone number.
- **Transparent:** Restock says it's an AI, echoes every change it makes, and lets you undo with a reply.
- **Stripe test mode only:** the server refuses to start with a live key.

The full AI system card (components, data, controls, risks) is in **[docs/ai-system.md](docs/ai-system.md)**.

---

## How it works

```mermaid
flowchart LR
  P[Phones · iMessage] <--> PH[Photon 2.0]
  PH <-->|poll + send| S[Restock server · Railway]
  S --> G[Guardrails<br/>card guard · crisis · injection]
  G --> M[Membership commands<br/>owner-only, in code]
  G --> AI[Gemini<br/>intents · catalog match · answers]
  AI --> C[(Catalog dataset)]
  S --> SP[Split engine<br/>integer cents]
  SP --> ST[Stripe test mode<br/>hold → capture per member]
  ST -->|webhooks| S
  S --> DB[(SQLite)]
  S --> R[Redaction → replies]
  V[VEYZL audit] -->|POST /api/agent| S
```

| Layer | Tech |
|---|---|
| Messaging | Photon 2.0 (`@photon-ai/api`), iMessage shared lines, polling |
| AI | Google Gemini (REST API, JSON-Schema structured output), validated by Zod |
| Data | A 39-product catalog (`data/catalog.json`); SQLite persistence |
| Payments | Stripe test mode: Checkout for adding cards and paying back, PaymentIntents (hold then capture) for orders |
| Server | TypeScript, Node 22+, Express, deployed on Railway |
| Quality | Vitest; CI runs type-check, tests, the VEYZL log check and VEYZL probes on every PR |

---

## Run it locally

```bash
npm install
cp .env.example .env   # test keys only; see docs/hosting.md for every variable
npm run dev            # http://localhost:3000/health
npm test               # hermetic: never calls Photon, Stripe or Gemini
npm run test:probes    # VEYZL probes with the real model (needs GEMINI_API_KEY)
npm run seed           # demo household (Sam, Jake, Priya)
```

- `http://localhost:3000/` serves the landing page (`src/web/public/landing.html`).
- `http://localhost:3000/dashboard` serves the dashboard (`src/web/public/dashboard.html`). Log in with your phone to see your personal space and group chats, including carts, spending, splits, member card status, approvals, and debts. Live dashboard data is read-only; **Try the demo** previews sample spaces without sending or saving anything.
- `http://localhost:3000/start` starts the web signup flow; invitees use `/join/<code>`.
- Without API keys, everything falls back to deterministic code (command parser, keyword catalog match), so the demo still works.

## Repo map

| Path | What |
|---|---|
| [`src/messaging/`](src/messaging) | Photon transport, the inbound pipeline, membership commands, product options, receipts and "you owe" texts |
| [`src/ai/`](src/ai) | Gemini intent parsing, catalog matching, grounded answers, restock suggestions |
| [`src/safety/`](src/safety) | Input guardrails and output redaction |
| [`src/core/`](src/core) | Store, households, split engine, orders, ledger, SQLite persistence |
| [`src/payments/`](src/payments) | Stripe charges, the owner card gate, add-card and pay-back links, webhooks |
| [`src/web/`](src/web) | Dashboard, landing pages, and the `/api/agent` audit endpoint |
| [`docs/`](docs) | [AI system card](docs/ai-system.md) · [VEYZL evidence](docs/veyzl.md) · [VEYZL runbook](docs/veyzl-runbook.md) · [Photon](docs/photon.md) · [Stripe](docs/stripe.md) · [Hosting](docs/hosting.md) |
| [`PLAN.md`](PLAN.md), [`AGENTS.md`](AGENTS.md) | Team plan and the rules every human and coding agent followed |

## How we built it

- **About 30 merged PRs in one weekend**, each through CI. VEYZL ran on every PR, and VEYZL-driven fixes are tagged in git (`npm run veyzl:log`).
- Four people working in parallel on messaging, core and splits, payments, and demo and web, against shared types in [`src/types.ts`](src/types.ts).
- All code was written during DubHacks '26. We use public npm libraries (listed above), as the rules allow.

## Team

Alex · Abdul · David · Amber
