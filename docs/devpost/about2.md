## Inspiration

Every shared apartment has the same group chat. *"We're out of toilet paper."* *"Can someone grab dish soap?"* *"Who bought the paper towels last time?"* Then, three days later, the awkward one: *"Hey, you owe me $14.62 for the trash bags"*

Restocking a household is a shopping problem, a coordination problem, and a money problem all at once, and we handle it today with three separate apps: a group chat to notice, a store app to buy, and Venmo or Splitwise to chase people afterwards. Someone always ends up fronting the money, and someone always forgets to pay them back.

We wanted texting itself to do the shopping. You text like you already do, *"we're out of TP"*, and the household's cart fills itself. Anyone texts **"order now"**, and the order is placed **and paid fairly at checkout**, so nobody fronts money and nobody has to chase anyone.

## What it does

**Restock** is an AI assistant that lives in your household's iMessage thread.

- **Text it like a roommate.** *"im out of dish soap and we need TP"* becomes two cart items. It understands casual phrasing, typos, and "for me and Jake".
- **It finds the deal.** Each request gets up to three options with real store prices, sorted by price per unit, and your household's usual pick stays at the top. You reply 1, 2 or 3.
- **Shared vs. personal is handled for you.** Toilet paper is split across everyone. The air fryer Jake added goes to Jake alone. Every decision is shown in the reply ("Added dish soap, shared, $8.49. Reply 'personal' to change"), so anyone can correct it.
- **"order now" checks out and splits the bill.** Members with a card on file are charged their own share. Members without one are covered by the owner's card and get a private *"you owe Sam $10.15"* text with a one-tap pay-back link. An order never gets stuck waiting on someone's card.
- **One person, many households.** Roommates, family, a soccer team: switch between them by text, or manage them from a web dashboard.

## How we built it

- **Messaging: Photon 2.0 (iMessage).** Each person gets their own Restock number on Photon's shared lines. Group news like "Jake added chips" or "order placed" is relayed to every member's thread.
- **AI layer: the Claude API.** Claude parses intents, matches items to products, answers questions, and picks the best deals from live listings. **Every state-changing output is validated against a schema** before we act on it. If the model fails or returns something malformed, a deterministic command parser (`add …`, `order now`) takes over, so the demo never depends on the LLM being up.
- **Live prices.** SerpApi's Google Shopping results are filtered to major retailers, checked against what the person asked for, and ranked by unit price in code. Store listings are treated as untrusted input, and the model can only reply with listing numbers.
- **Money: Stripe test mode.** Cards are added only through Stripe-hosted Checkout in setup mode. Each person's share is an off-session PaymentIntent on their own card, held first and captured only once every share is authorized, and pay-back uses Checkout payment links. Restock stores only Stripe IDs and the last 4 digits.
- **The split engine is plain TypeScript, never the LLM.** All money is integer cents. Splitting an item of \\(c\\) cents across \\(n\\) people gives each person \\(\lfloor c/n \rfloor\\) cents, and the \\(c \bmod n\\) leftover cents go one each to the first members in order. That way the shares always add up exactly to the order total. Example: $10.00 three ways is 334 / 333 / 333.
- **Backend:** Node + TypeScript (strict), Express, SQLite persistence, deployed on Railway at restock.select. The web pages (sign-up, invite links, dashboard, pay-back) are mobile-first, because they open from a text.
- **Responsible AI, audited.** We ran a **VEYZL** audit on every pull request. Its findings changed what we shipped: one led us to redact personal data and Stripe IDs from every outgoing message, and another made the reply to a pasted card number fixed text with no links in it. Each fix is tagged in git history and logged in `docs/veyzl.md`.

## Trust by design

- **No card numbers, ever.** A Luhn-check guard runs on every incoming message *before* the AI or the database sees it. A pasted card number is dropped, and the sender is told privately how to add a card safely.
- **The AI never moves money.** Only an explicit "order now" from a household member places an order, and only for the cart everyone can see. Expensive personal items wait for an approver's "yes".
- **Undo by text.** Anything the AI decided can be changed with a reply.
- **Honest about being an AI.** Ask "are you a bot?" and it tells you, with or without the LLM.

## Challenges we ran into

- **We had to pivot away from the group chat.** Our design put Restock inside the household's iMessage group chat, but adding an agent to a group chat needs Photon's paid plan, a $250 subscription. On the free plan's shared lines, the bot also can't text first: it can only reply to people who have messaged it. We built sign-up links and invite links that give each person their own Restock number, plus a relay that keeps every member's thread in sync. Private messages to someone who hasn't texted yet are queued until they do.
- **Money has to be exactly right under retries.** Webhooks get delivered twice, servers restart mid-order, and people double-tap. We made charges and webhook handlers idempotent so a retry can never charge anyone twice, and wrote tests for it, including across restarts.
- **Webhooks fail silently.** In testing, a card saved on Stripe's page sometimes never reached us. We now confirm the card directly with Stripe when you return from checkout and keep the webhook as a backup.
- **One person, many households.** Once a phone could belong to several households, every incoming text became a question: *which cart is this for?* We added an "active household", a picker when it's ambiguous, and one card per person, so a card added in one household works in all of them.
- **People don't text like a command line.** *"im out of fucking dish soap"* has to mean "add dish soap". *"I'm out"* in a conversation about splitting a bill doesn't. Getting the AI parsing, the deterministic fallbacks, and the guardrails to agree took many rounds of tests. We ended with over 670 automated tests.

## Accomplishments that we're proud of

- A real end-to-end flow on real phones: text an item, pick a deal, "order now", separate Stripe charges, a private "you owe" text, and a pay-back link that marks the debt paid.
- A split engine with exact integer-cent results. The demo order of $72.75 splits into exactly Sam $15.65, Jake $46.95 and Priya $10.15.
- An AI agent that's genuinely useful but **structurally unable** to spend money on its own.

## What we learned

- **Put the LLM where it's strong and keep it away from where it's dangerous.** Claude is excellent at turning messy human text into structured intent. It should never decide who pays, how much, or when a charge happens. Keeping that line strict made both the product and the audit far easier.
- **Fallbacks are a feature.** Designing every AI path with a deterministic fallback meant the app kept working when the model, the store search, or a webhook didn't.
- **Trust is UX.** Echoing every AI decision back in the reply, with a one-word way to undo it, did more for how the product feels than any amount of polish.
- **Messaging platforms shape the product.** Constraints like "the bot can't text first" forced design decisions such as personal numbers, invite links, and relays that we wouldn't have planned for on paper.

## What's next

- A shared group chat: move Restock into the household's iMessage group chat on Photon's paid plan. The code already binds a household to a group chat, so it's an upgrade, not a rewrite.
- Real merchant checkout (an affiliate or retailer API) in place of simulated orders.
- Restock reminders from purchase history: *"You usually order paper towels every two weeks. Add them?"*
- Paying the owner back directly through Stripe Connect, instead of only recording that it was paid.
- More channels (SMS, WhatsApp) through Photon, so any group chat can use it.