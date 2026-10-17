# Restock

An AI agent in your household group chat that keeps shared supplies stocked and splits the bill. Built at DubHacks '26.

- **What we're building and who owns what:** [PLAN.md](PLAN.md)
- **Rules for humans and coding agents:** [AGENTS.md](AGENTS.md)
- **How the AI works (system card):** [docs/ai-system.md](docs/ai-system.md)

## Quick start

```bash
npm install
cp .env.example .env   # fill in test keys only
npm run dev            # http://localhost:3000/health
npm test
npm run typecheck
npm run seed           # demo household (Sam, Jake, Priya)
```

## Layout

| Path | Owner | What |
|---|---|---|
| `src/types.ts` | Person 2 | Shared contracts. Everyone codes against these. |
| `src/core/` | Person 2 | Store, split engine, `placeOrder`, ledger |
| `src/messaging/` | Person 1 | Photon transport, inbound pipeline, card-number guard, templates, fallback parser |
| `src/ai/` | Person 1 | Claude: intent parsing, product matching, restock suggestions |
| `data/catalog.json` | Person 2 | Product catalog dataset the AI matches against |
| `src/payments/` | Person 3 | Stripe (test mode), charges, links, webhooks |
| `src/web/`, `scripts/seed.ts` | Person 4 | Landing pages, demo seed |
| `docs/veyzl.md` | Person 4 | VEYZL findings → fixes log |

Stubs are marked `TODO(P1)`–`TODO(P4)`. Find yours with `grep -rn "TODO(P2)" src scripts test`.
