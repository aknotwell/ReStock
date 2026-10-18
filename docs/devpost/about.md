## Inspiration

Every shared home has the same group chat. Someone texts *"we're out of toilet paper"*, three people react with 👍, and nobody buys it. When someone finally does, they're stuck sending an awkward *"you owe me \$14.37"* Venmo request, and chasing it for a week.

The shopping already happens in the group chat. It just doesn't end in a cart, a fair split, or anyone getting paid back. We wanted the group chat itself to do the shopping.

## What it does

Restock is an AI assistant that lives in your household's iMessage group chat. There's no app to install.

- Roommates text in plain language: *"we're out of TP and dish soap."* Restock turns that into cart items and offers up to three options, ranked by price per unit, comparing live store listings with its own catalog.
- Anyone can steer it: *"cheapest TP under \$15 from Target"*, *"make the chips personal"*, *"what do I owe?"*
- When someone texts "order now", Restock checks out the shared cart and splits the bill. Shared items are split evenly, and personal items go to whoever wanted them.
- Each roommate's card is charged their own share automatically. Anyone without a card on file gets a private *"you owe Sam \$10.15"* text with a one-tap pay link.
- Card numbers never touch the chat. Cards are added only through Stripe's hosted pages, and if someone pastes a card number anyway, Restock refuses it.

## How we built it

- Messaging: Photon 2.0 for iMessage. Group chat for the household, direct messages for anything private (receipts, balances, card links).
- AI layer: Claude reads each message into schema-validated intents (`add_item`, `set_shared`, `what_do_i_owe`…) and matches casual names ("TP") to catalog products. Every model output is validated with Zod, and every component has a deterministic fallback, so the demo works even with the LLM turned off.
- Live deals: SerpApi's Google Shopping engine supplies real store listings. Code (never the model) reads pack sizes from titles, filters out accessories and outliers, keeps major retailers, and ranks everything by price per unit. The built-in catalog is a demo dataset, and live listings are shown for comparison: payments run in Stripe test mode, and Restock doesn't place real retailer orders yet.
- Payments: Stripe in test mode. Each member's share is charged with a hold-then-capture PaymentIntent and an idempotency key per *(order, member)*, so a retry can never charge twice. Pay-back links are Stripe Checkout sessions, and signed webhooks mark debts paid.
- Splitting the bill: deterministic code, never the LLM, working in whole cents so the shares always add up exactly to the order total. Our demo order of \$72.75 splits into Sam \$15.65, Jake \$46.95 and Priya \$10.15, and unit tests check it to the cent.
- Data: TypeScript on Node, an in-memory store saved to SQLite on a Railway volume every second. We store Stripe IDs and the last four card digits, and never message text.
- Responsible AI: a VEYZL audit runs on every pull request. It flagged eight issues, and we fixed each one in a tagged commit and logged it as evidence.

## Challenges we ran into

- Keeping the AI away from the money: an LLM is great at reading *"grab some chips for me"* and terrible at being trusted with a charge. We split responsibilities strictly: the model may *suggest* an item or whether it's shared, but checkout only happens on an exact "order now" command, and shares come from deterministic code.
- Card numbers in disguise: people paste cards as `4242-4242 4242.4242`, across line breaks, or followed by an expiry date. The guard has to catch all of them without flagging ordinary numbers like phone numbers.
- Messy real-world shopping data: store titles rarely state a plain pack size. Our first parser read *"Tough Guy 38C405 Toilet Paper Roll"* as 405 rolls and declared it the best deal. Titles like *"8 Triple Rolls"* or a 40 fl oz bottle can't be compared per unit with regular rolls or the catalog's bottles. We learned to compare only like with like, and to say "no per-unit price" rather than guess.
- Private texts in group chats: iMessage won't let a bot start a private conversation, so "you owe" texts are held until each person messages Restock directly once, and one failed text never blocks the others.


## What we learned

- We treated trust as a design constraint. The things judges and users care about (no card numbers, no surprise charges, transparent AI) shaped the architecture from the start.
- Use AI where language is messy, and code where correctness matters. Claude reads human intent; integer arithmetic moves money.
- Audits are only useful if they change the build. VEYZL caught gaps, including echoing sensitive data back and missing refusals. Logging each fix as a before/after commit made the improvement concrete.
- Test on real data early. Every unit test passed before our first live SerpApi call, and that first call still exposed three bugs.

## What's next

Real retailer checkout instead of comparison-only prices, recurring restock suggestions ("you usually order paper towels every two weeks"), and household budgets that the whole group can see. Every household brings in 2 to 5 people, and every one of them can start their own household, which is how Restock spreads.
