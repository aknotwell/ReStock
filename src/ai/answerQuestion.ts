// Owner: Person 1. Only reviewed, source-backed facts may leave this path.
// No model-written factual prose or model-supplied citations are trusted.
import { catalog } from "../core/catalog.js";
import { checkInput, FABRICATION_REPLY } from "../safety/guardrails.js";

export { FABRICATION_REPLY };
export const UNSURE_REPLY = "I can't verify that from my reviewed sources, so I won't guess. I can help with household shopping and demo catalog prices.";
export const OFFLINE_REPLY = "I can only help with your household's shopping list, orders, and bill right now.";

// Reviewed 2026-10-17 against the EU's official country profile. Extend only
// with reviewed facts and narrow query matches; never treat arbitrary text as evidence.
const FACTS = [{
  query: /^(?:what(?: is|'s) (?:the )?capital (?:city )?of france|what is france's capital|capital of france)[?.!]*$/i,
  answer: "The capital of France is Paris.",
  source: "https://european-union.europa.eu/principles-countries-history/eu-countries/france_en",
}];

export async function answerQuestion(question: string, _senderName: string): Promise<string> {
  const hit = checkInput(question);
  if (hit) return hit.reply ?? "Please don't share card numbers in chat.";
  const query = question.trim().replace(/[’]/g, "'");
  const fact = FACTS.find((entry) => entry.query.test(query));
  if (fact) return `${fact.answer} Source: ${fact.source}`;
  const price = /^(?:how much (?:is|does)|what is the (?:demo )?price of) (.+?)(?: cost)?[?!.]*$/i.exec(query);
  if (price?.[1]) {
    const name = price[1].toLowerCase().replace(/[?!.]+$/, "");
    const product = catalog.find((p) => [p.name, ...p.aliases].some((alias) => alias.toLowerCase() === name));
    if (product) return `${product.name}: $${(product.cents / 100).toFixed(2)}. Source: Restock demo catalog (data/catalog.json, ${product.id}); not a live merchant quote.`;
  }
  return UNSURE_REPLY;
}
