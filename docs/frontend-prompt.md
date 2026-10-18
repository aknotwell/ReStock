# Prompt: building the frontend on top of payments

How to use this: copy everything in the box below and paste it into Claude (Claude Code works best, opened in this repo). It explains how Restock's payments work and which APIs exist, so the frontend matches the backend.

Written by Person 3 (payments, Amber) on Oct 17, 2026, against `main` at PR #48. If something here disagrees with the code, the code wins: ask Amber.

---

````text
I'm building the web frontend for Restock (DubHacks '26). Read AGENTS.md and PLAN.md first, then
src/web/routes.ts, src/web/appState.ts and the pages in src/web/public/. Below is how payments work,
so the UI matches what the backend actually does. Ask me before changing anything under
src/payments/, src/core/ or src/messaging/ (those belong to teammates: payments is Amber, Person 3).

## What Restock is
An AI agent in a household's group chat (iMessage via Photon). Roommates text things like "we're out
of TP", items go into a shared cart, someone texts "order now", and Restock charges everyone's share
and texts receipts. The web frontend is a companion: it shows the household, the cart, who pays for
what, who owes what, and lets people pay back or add a card. Texting stays the main way to use Restock.

## Stack and conventions
- Express server (src/server.ts) serves static pages from src/web/public/ and JSON APIs from
  src/web/routes.ts. The existing pages are plain HTML + vanilla JS with inline CSS, no build step;
  keep that style unless the team agrees otherwise.
- Mobile-first: most pages open from a text message on a phone.
- TypeScript strict for server code. Small PRs on a branch (never push to main); every PR runs the
  VEYZL check. Run `npm run typecheck` and `npm test` before saying anything is done.
- 70/30 rule: write original code, no pasted templates or big copied UI kits.

## How payments work (the important part)
Money:
- All amounts are integer cents everywhere. Format as dollars only for display. NEVER compute charges
  or splits in the browser: show the numbers the server returns.
- Stripe TEST MODE only. Cards are typed only on Stripe-hosted pages. Our code and our pages never
  see, store, or send card numbers. We store only Stripe IDs and the card's last 4 digits.

Who pays:
- Each household has one OWNER (the budget owner). The owner MUST have a card on file; an order is
  blocked until they do (the owner gets a private add-card link).
- Every other MEMBER's card is OPTIONAL. Anyone can join and add items right away without a card.
- When someone texts "order now", each person's share is computed and:
  - a member WITH a card is charged their own share on their own card;
  - a member WITHOUT a card has their share put on the OWNER's card, and a DEBT is recorded
    (member owes owner). They get a private "you owe" text with a pay-back link and an add-card link;
  - a member whose card is DECLINED is treated the same way: the owner covers it and a debt is recorded.
  So orders never get blocked by people without cards.
- Charges are "hold, then capture": every share is authorized first and only captured if everything
  succeeded, so nobody is charged for an order that didn't go through. Retries never double-charge.
- After an order, everyone gets a private text that LISTS THEIR ITEMS and what they paid for each:
  card holders a receipt, the owner a receipt that also names who their card covered, and members who
  owe a "you owe" text. Example:
    Receipt: your share is $46.95, charged to your card ending 1881.
    • Dish soap, 3 pack (split 3 ways) $2.83
    • Air fryer (approved by Sam) $32.00

How items are split (rule "smart", the default). An item is paid for by one of:
- EVERYONE (shared): the default for a new item. Split evenly across all members.
- PERSONAL: only the person who added it pays the full price.
- SOME PEOPLE: split evenly between exactly the people named, e.g. "add oat milk for me and Jake".
In every case, leftover cents go one each to the first members in household order, so shares always
add up exactly. The data:
- Item has `shared: boolean` and an optional `splitWith?: MemberId[]`.
  - splitWith set           -> split between exactly those members (members who left are skipped)
  - no splitWith, shared    -> everyone
  - no splitWith, !shared   -> just the person who added it
- Whoever is chosen is decided by CODE from people's texts (src/messaging/splitWith.ts), checked
  against the household's members; the AI never decides who pays. Unknown or vague names ("the guys")
  are asked about, never guessed.
- In the chat, people control it with: "add X for me and Jake", "split with Priya", "between Jake and
  Priya", "for everyone but me" (when adding); "just me and Alex", "only Priya", "everyone",
  "personal", "shared" (changes their newest item); "not me" / "not me for the chips" (takes
  themselves off an item someone else put them on).
- The dashboard API returns `splitWith` as NAMES (or null). Show it, e.g. "Oat milk · Sam + Jake".
- Expensive items can need approval (`needsApproval`); they're left out of an order until approved.

Paying back a debt (two ways, both built):
1. Texted link `/p/<token>`: opens ONE Stripe page for EVERYTHING that person owes the owner, across
   all orders, one line per order. Any of their pay links opens the same total.
2. The `/pay` site: log in with a texted 6-digit code, see your own open debts, pay one at a time,
   optionally saving the card for next time.
- The server guarantees at most one live Stripe page per debt (it cancels older pages), so a debt
  can't be paid twice, even across the two paths. Don't build any client-side workaround for this.
- After paying, Stripe redirects to `/pay/success`. Stripe's webhook then marks the debt(s) paid (can
  take a few seconds) and texts the owner "<name> paid you back $X". So after redirecting back,
  refetch state; don't assume it's instantly updated.

Adding a card:
- Texted link `/c/<token>` -> Stripe's card page (setup mode, nothing charged) -> `/card/success`. The
  webhook saves the card and texts "Card added, ending 4242". In the chat, "add card" sends the link.
- There is NO web endpoint yet for a logged-in member to start adding a card. If the UI needs an "Add
  card" button, the backend needs a small authenticated endpoint (for example `POST /app/api/card-link`)
  that returns `createCardSetupLink(me.id)` from src/payments/links.ts; the browser then just navigates
  to that URL. Check with Amber (Person 3) before adding it; she can build it quickly.

## APIs that exist today (src/web/routes.ts)
Login (shared by /pay and the dashboard): a texted code, then an HttpOnly session cookie.
- POST /pay/api/start  {handle}         -> {ok:true} (same answer whether or not the number exists)
- POST /pay/api/verify {handle, code}   -> sets the session cookie, {ok:true} or 401 {error}
- POST /pay/api/logout                  -> clears it
- GET  /pay/api/me -> {name, cardLast4|null, debts:[{id, to, cents, amount, orderDate?}]}
- POST /pay/api/checkout {debtId, saveCard} -> {url} (redirect the browser to it)
- GET  /app/api/state -> HouseholdView (read-only, the logged-in member's own household):
    me: {id, name, role, cardLast4|null}
    household: {name, budgetCents|null, spentCents, approvalOverCents|null}
    members: [{id, name, role, hasCard, isMe}]
    items: [{id, name, cents, shared, splitWith (names)|null, addedBy (name), needsApproval}]  // pending cart
    sharesIfOrderedNow: {memberName: cents}                              // server-computed preview
    openDebts: [{from, to, cents}]
- POST /app/api/invite {reset?} -> {url, expiresInDays} (owner only)
- Sign-up: GET /start, GET /join/:code, GET /signup/api/invite/:code, POST /signup/api/start
- Pages: /dashboard, /pay, /pay/success, /card/success, /cancel, /privacy
The dashboard is READ-ONLY today: changing the cart, who pays for an item, or ordering happens by
text. Any write action from the web (pick who pays with checkboxes, toggle personal, remove an item,
order now) needs new backend endpoints; propose them to the team instead of calling internal
functions from the browser. "order now" must always stay an explicit human action; never trigger
charges automatically.

## Privacy and trust rules the UI must follow
- Never show phone numbers. Show other members' cards only as "has a card"; last 4 digits are shown
  only to their owner.
- Show only the logged-in member's own household and only their own debts on /pay.
- Be transparent: show who pays for each item (everyone / personal / which people), each person's
  share, who the owner is covering, and who owes whom. Restock is an AI assistant; don't present it
  as a person.

## Ideas for what the UI should make clear
- Cart: each item with price, who added it, who pays (Everyone / Personal / named people), approval state.
- "If we ordered now": each person's share (from sharesIfOrderedNow), and a badge for who has a card.
- For members without a card: a friendly note that the owner covers them and they'll owe the owner,
  with "Pay back" and "Add a card" actions.
- For the owner: how much they're covering for others, and open debts owed to them.
- Balances: who owes whom, with a Pay back button for the logged-in member's own debts.

## Testing locally
- `.env` needs sk_test_ / whsec_ keys (docs/stripe.md). Run `DEMO_SEED=1 DEV_INBOUND=1 npm run dev`
  (never enable DEV_INBOUND on a public deploy). Without Photon keys, texts (including login codes)
  are printed in the server log, so you can log in to /pay with a demo member's phone number.
- Simulate a text: curl -X POST localhost:3000/dev/inbound -H 'content-type: application/json'
  -d '{"fromPhone":"+15550000001","text":"add oat milk for me and jake","spaceId":"dev-group"}'
  (then send "1" to pick an option, and "order now" from the same number).
- Stripe test cards (type them only on Stripe's pages): 4242 4242 4242 4242 succeeds;
  4000 0000 0000 0341 saves fine but every charge is declined (shows the owner-covers fallback).
- To see webhooks locally: `stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to localhost:3000/webhooks/stripe`.

Start by reading the files above and summarizing what the current pages already do, then propose a
plan for the frontend before writing code.
````

---

## What changed since the first version of this prompt

- **Splitting with some people is built** (PR #48). It used to say "planned". The dashboard API now returns `splitWith` names per item.
- **Receipts list items** (PR #47). The owner's receipt names who their card covered.
- **The owner gets a "paid you back" text** (PR #42). A debt can't be paid twice across the texted link and `/pay` (PR #46).
