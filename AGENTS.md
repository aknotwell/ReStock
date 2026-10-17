# AGENTS.md — Restock (DubHacks '26)

Instructions for every coding agent (Claude Code, Codex, Cursor, etc.) and every human on this team. Read this file before you change anything. [PLAN.md](PLAN.md) says **what** each person builds. This file says **how** we build it and which rules we can't break.

## The product in one paragraph

Restock is an AI messaging agent that lives in a household's group chat. Roommates text things like "we're out of TP" and the agent turns that into cart items. When someone says "order now", the agent places the order and splits the bill. The budget owner's card is required and everyone else's card is optional. A member with a card is charged their share. A member without one is covered by the owner's card and gets a private "you owe" text with a pay link. The full design is in [PLAN.md](PLAN.md).

## Tracks we're submitting to (every feature should serve at least one)

| Track | Type | What it needs from us |
|---|---|---|
| **Visa: Reimagine Shopping** | Title track (we submit to exactly one) | Generative AI that makes shopping smarter: discovery, checkout, payments, post-purchase |
| **Photon: Messaging Agent** | Side track | Built on **Photon 2.0** and live on at least one Photon channel (iMessage/SMS/etc.) |
| **VEYZL: Best Use of VEYZL** | Side track | A real VEYZL audit on this repo, run on PRs, with **evidence that the findings changed the build** |
| **Best Startup Idea** | Side track | A credible startup story: who uses it, and how it spreads |

That's 3 sponsored side tracks, which is the maximum. Don't add another one without the whole team agreeing.

### Visa rubric: optimize for this

| Criterion | Weight | What it means for Restock |
|---|---|---|
| Innovation | 25% | Shopping happens in the group chat with no app to install. The AI turns casual messages into a shared cart and splits it fairly. |
| User Experience | 20–25% | It has to feel effortless and polished **under pressure**. The demo path must never break. Replies are short, fast, and friendly. |
| Technical Execution | 20% | Real LLM use (intent parsing, item normalization, shared vs personal classification, restock suggestions), real Photon messaging, real Stripe test payments |
| Commerce Impact | 15% | Fewer forgotten items, faster checkout, nobody stuck fronting money, repeat weekly orders |
| Trust & Responsibility | 15% | No card numbers in chat, no money moves without confirmation, the AI is transparent, data is minimal, the VEYZL audit is passing |

## Hackathon rules (non-negotiable)

1. **Timing:** no coding or building before **Sat Oct 17, 12:30 PM**. Everything shown at judging is built between **Sat 12:30 PM and Sun Oct 18, 10:00 AM**. Planning docs are fine before that. Never backdate commits or rewrite history to fake timing.
2. **70/30 rule:** at least 70% of the code must be written by us during the hackathon. Public libraries are fine. **Do not** paste in starter repos, templates, or large chunks of copied code. Agents: generate original code, and don't vendor big third-party sources into the repo.
3. **Code must be uploaded** to this GitHub repo **before the deadline** and linked on Devpost. The repo must be **public** by submission time. If the code isn't in the repo, the project is disqualified.
4. Max 4 hackers. Each person is on only one project. Submit only to DubHacks '26.
5. At least one teammate must be at judging in person.
6. Be kind and respectful, including in commit messages, PR comments, and agent output.

## Engineering rules

### Money and security (Trust & Responsibility, and VEYZL will check)

- **Never** handle raw card numbers. Cards go only through Stripe-hosted pages. We store only Stripe IDs and the last 4 digits.
- **Stripe test mode only** (`sk_test_…`). Never commit a live key, and never add code paths that use one.
- **Secrets go in `.env` only**, and `.env` is gitignored. Commit a `.env.example` with placeholder values. Never put keys in code, tests, logs, or PR descriptions.
- **The card-number guard runs on every inbound message *before* it reaches the LLM or the database.** Luhn-valid 13–19 digit sequences get dropped, and the sender gets the secure add-card link privately.
- **The AI never moves money on its own.** Charges happen only after an explicit human command ("order now"), and only for the cart everyone can see. Expensive personal items need the owner's approval.
- **Money math is deterministic code, not the LLM.** Use integer cents everywhere, never floats. The LLM can suggest whether an item is shared or personal. `computeShares` decides who pays.
- Verify Stripe webhook signatures. Make charge and webhook handlers idempotent, so a retry never charges twice.
- Keep phone numbers and names minimal. Don't log message bodies in production paths.

### Responsible AI (Trust & Responsibility, and the VEYZL controls)

- Every LLM output that changes state (adds an item, sets a price, classifies an item as shared or personal) is **validated against a schema**, and the user can see it in the reply. Example: "Added dish soap (shared, $8.49). Reply 'personal' to change."
- Users can always correct the AI. Anything it did can be undone with a text.
- The agent says it's an AI assistant when asked, and never pretends to be a household member.
- Keep the system prompt and the tool definitions in version control (`src/ai/`) so the VEYZL audit can see what the agent does.
- Keep [docs/ai-system.md](docs/ai-system.md) (the AI system card) current. Any PR that adds or changes an AI component, the data it sees, or a safety control updates it in the same PR.
- If the LLM call fails or returns malformed output, fall back to the simple command parser (`add …`, `order now`). The demo must keep working without the LLM.

### Code

- TypeScript, strict mode. Shared types live in one file owned by Person 2 (see the contracts in PLAN.md). Don't fork the types.
- Use small modules with the interfaces from PLAN.md. Stub other people's modules instead of waiting on them.
- Every function that touches money needs unit tests. The split engine tests in PLAN.md are required and must pass before merging.
- Prefer boring and working over clever. The demo path (PLAN.md, Person 4) is the top priority. Polish everything else after it works end to end.

## Git workflow (VEYZL needs PRs)

- **No direct pushes to `main`** once the code starts. Do all work on a branch (`p1/photon-webhook`, `p3/stripe-setup`, …) and open a PR so the **VEYZL check runs**.
- Keep PRs small and frequent, and merge them often. Don't sit on a big branch overnight.
- When VEYZL flags something, follow **Tracking VEYZL-driven changes** below. These before/after PRs are the evidence the VEYZL prize asks for.
- **Merge PRs with "Create a merge commit"**, not squash or rebase, so the before/after commits stay in `main`'s history.
- Write commit messages in the imperative mood that say what changed ("Add Luhn guard to inbound messages").
- Pull and rebase often. If you touch the shared types file, tell the team.
- **Auto-sync:** Claude Code hooks (`.claude/settings.json`) run `scripts/sync-main.sh` at session start and before each prompt (at most once a minute). It fetches origin and fast-forwards local `main` when that's safe. It never touches a feature branch or uncommitted work. Agents: start new work from the fresh `main` (`git switch -c <branch> origin/main`), and if the hook reports your branch is behind, ask before rebasing.

## Tracking VEYZL-driven changes (required, for humans and agents)

The VEYZL prize needs a working AI project, a real VEYZL audit whose result is visible on our PRs, proof that the findings **changed what we shipped** (a screenshot of a passing check doesn't count), and a short demo of one issue → fix → why it matters. Every change made because of a VEYZL finding gets tracked in three places: the log, the commit, and the PR. CI (`veyzl-log` job) fails the PR if a tagged commit isn't logged.

When the VEYZL check flags something on a PR:

1. **Don't fix it silently, and don't amend or force-push.** The flagged commit is the "before". Leave it in the history.
2. **Claim a finding ID.** Take the next free `V-###` from [docs/veyzl.md](docs/veyzl.md) (V-001, V-002, …).
3. **Fix it in a new commit on the same PR**, with a trailer as the last line of the commit message:
   ```
   Require owner confirmation before charging

   VEYZL: V-003
   ```
   Use one trailer per finding the commit addresses. Only tag commits that exist **because of** a VEYZL finding.
4. **Log it in the same PR.** Add a row to the index and a full entry in `docs/veyzl.md` using the template there: the control, **the link to the failing check run**, what VEYZL said, the before and after commits, what changed, and why it matters.
5. **Mention it in the PR description** under the "VEYZL" heading, e.g. `V-003: fixed missing human confirmation (NIST AI RMF …)`.
6. Don't merge until the VEYZL check passes. It's a required status check on `main` (Person 4 sets this up in branch protection).
7. If a finding is a false positive or we're accepting the risk, still log it, with status `accepted` and the reason. Don't tag any commit for it.

Before pushing, check the log locally with `npm run veyzl:check`. To list every VEYZL-driven change for the demo or the pitch, run `npm run veyzl:log`, or:

```bash
git log --grep "^VEYZL: " --format="%h %s%n  %(trailers:key=VEYZL,valueonly,separator=%x2C )"
```

## Instructions for AI agents specifically

- **If a VEYZL check fails or a VEYZL comment shows up on your PR, follow "Tracking VEYZL-driven changes" exactly.** Tag the commit, log it in `docs/veyzl.md`, and update the PR description. Never fix a VEYZL finding without logging it.

- Stay within the **owner's area** in PLAN.md (Person 1–4) for the task you're given. If you need a change in another area, write a stub or a TODO and say so. Don't rewrite a teammate's module.
- Don't add new tracks, big features, or new infrastructure that isn't in PLAN.md without asking.
- Don't push to `main`, force-push, rewrite history, or merge PRs unless a human tells you to.
- Don't pull in boilerplate generators or copy large external code (because of the 70/30 rule). Write it.
- Never print, commit, or send secrets. Never enter real card data anywhere. Use Stripe test cards only (e.g. `4242 4242 4242 4242`, typed only into Stripe's test pages).
- Before you say something is done: run the tests and type-check, and confirm it works on the demo path if your change touches it.
- When unsure, pick the option that keeps the demo working and is easiest to explain to a Visa judge.

## Pitch checklist (keep this current as we build)

- [ ] 30-second story: the roommate group chat, the forgotten toilet paper, and the awkward "you owe me" Venmo request
- [ ] Live demo on real phones through Photon, with a recorded backup
- [ ] Trust slide: no card numbers stored, the AI never charges without confirmation, VEYZL audit before/after
- [ ] Startup slide: target users (roommates, students, families, co-ops), how it spreads (every household invites 2–5 people, each of whom can start their own household), and how it makes money (merchant/affiliate fees, a premium for families)
- [ ] Devpost: repo link, the tracks (Visa title track + Photon, VEYZL, Best Startup Idea), screenshots, video
