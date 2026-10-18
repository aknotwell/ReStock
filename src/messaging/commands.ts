// Owner: Person 1. Simple command parser used when the LLM is unavailable.
import type { Intent } from "../ai/intent.js";
import { keywordMatch } from "../core/catalog.js";

const none = { itemName: null, quantity: null, shared: null } as const;

// "Are you a bot?", "is this a real person?", "who is this" — the agent must always say it's an AI (AGENTS.md).
const IDENTITY =
  /^(?:who (?:are you|is this|am i (?:talking|texting|chatting) (?:to|with))|who's this|what are you|are you (?:an? )?(?:real |actual )?(?:person|human|bot|robot|ai|a\.i\.|machine|computer|chat ?bot|real)|is this (?:an? )?(?:real |actual )?(?:person|human|bot|robot|ai|a\.i\.|machine|chat ?bot|automated)|am i (?:talking|texting|chatting) (?:to|with) (?:an? )?(?:real |actual )?(?:person|human|bot|robot|ai|machine))[?!. ]*$/;

export function isIdentityQuestion(text: string): boolean {
  return IDENTITY.test(text.trim().toLowerCase().replace(/[’]/g, "'"));
}

// Everyday ways of saying "add this", so the most common message works even when the LLM is down.
// Except for the explicit "add X to the list", a phrasing counts only when at least one item matches a catalog
// product, so ordinary chat ("I'm out of town", "we need to talk", "short on time") is never taken as an order
// and falls through to the LLM instead. A question counts only as a request ("can we get TP?").
const LEAD = String.raw`^(?:(?:hey|hi|ugh|so|ok|okay|oh|um|fyi|btw|heads up|psa)[,!.]?\s+)*(?:restock[,:]?\s+)?`;
const phrase = (p: string) => new RegExp(`${LEAD}(?:${p})\\s+(.+)$`);
const STATEMENTS = [
  String.raw`(?:we(?:'re| are)|i(?:'m| am)|were|im)\s+(?:all\s+|completely\s+|totally\s+)?(?:out|outta)\s+of`,
  String.raw`(?:we(?:'re| are)\s+|i(?:'m| am)\s+)?(?:running|getting|kinda|pretty|really)?\s*(?:low|short)\s+on`,
  String.raw`(?:we(?:'re| are)\s+|i(?:'m| am)\s+)?running\s+out\s+of`,
  String.raw`(?:we\s+|i\s+)?(?:just\s+)?ran\s+out\s+of`,
  String.raw`(?:we(?:'ve| have)\s+|we\s+)?(?:got\s+)?no\s+more`,
  String.raw`(?:all\s+)?out\s+of`,
  String.raw`(?:we|i)\s+(?:really\s+)?need(?:\s+to\s+(?:get|buy|order|grab))?`,
  String.raw`need(?:\s+to\s+(?:get|buy|order|grab))?`,
  String.raw`(?:please\s+)?(?:get|grab|buy|pick\s+up)`,
  String.raw`(?:let's|lets)\s+(?:get|grab|buy|order)`,
].map(phrase);
const REQUESTS = [
  String.raw`(?:can|could|should)\s+(?:we|you|someone|somebody|u)\s+(?:please\s+)?(?:get|grab|buy|order|pick\s+up)`,
].map(phrase);
// "add X to the list" / "put X on the list": explicit, so no catalog check.
const LIST_ADD = new RegExp(`${LEAD}(?:add|put)\\s+(.+?)\\s+(?:to|on)\\s+(?:the|our|my)\\s+(?:list|cart|order)$`);

/** "some more TP please" -> "tp"; drops quantifiers, filler, and a trailing "for me". */
function cleanItem(raw: string): string {
  return raw
    .replace(/\b(?:please|pls|plz|asap|again|lol|thx|thanks|for the house|for everyone|for us|for me|personal)\b/g, " ")
    .replace(/^(?:some|more|any|a|an|the|new|another|extra)\s+/, "")
    .replace(/^(?:some|more|any)\s+/, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.!-]+|[\s,;:.!?-]+$/g, "");
}

/** "tp, dish soap and eggs" -> ["tp", "dish soap", "eggs"]. */
function splitItems(raw: string): string[] {
  return raw
    .split(/\s*(?:,|&|\+|\band also\b|\band\b|\bplus\b)\s*/)
    .map(cleanItem)
    .filter((s) => s.length > 0 && s.length <= 60)
    .slice(0, 10);
}

function naturalAdd(text: string): Intent[] | undefined {
  const question = text.endsWith("?");
  const t = text.replace(/[.!?]+$/, "");
  const shared = /\b(?:for me|personal)\b/.test(t) ? false : null;
  const toIntents = (items: string[]) => items.map((itemName): Intent => ({ type: "add_item", itemName, quantity: null, shared }));
  const explicit = question ? undefined : LIST_ADD.exec(t)?.[1];
  if (explicit) {
    const items = splitItems(explicit);
    return items.length ? toIntents(items) : undefined;
  }
  const raw = (question ? REQUESTS : [...REQUESTS, ...STATEMENTS]).map((re) => re.exec(t)?.[1]).find(Boolean);
  if (!raw) return undefined;
  const items = splitItems(raw);
  return items.some((i) => keywordMatch(i)) ? toIntents(items) : undefined;
}

export function parseCommand(text: string): Intent[] {
  const t = text.trim().toLowerCase().replace(/[’‘]/g, "'");

  if (t === "order now") return [{ type: "order_now", ...none }];
  if (t === "yes" || t === "approve" || t === "approved") return [{ type: "approve", ...none }];
  if (/what do i owe|my balance/.test(t)) return [{ type: "what_do_i_owe", ...none }];
  if (t === "help" || isIdentityQuestion(t)) return [{ type: "help", ...none }];
  if (/^(add|update|set up) (a |my )?card$/.test(t)) return [{ type: "add_card", ...none }];

  const natural = naturalAdd(t);
  if (natural) return natural;

  const add = /^add\s+(.+?)(\s+(personal|for me))?$/.exec(t);
  if (add?.[1]) {
    return [{ type: "add_item", itemName: add[1], quantity: null, shared: add[2] ? false : null }];
  }

  if (t === "personal" || t === "shared") return [{ type: "set_shared", itemName: null, quantity: null, shared: t === "shared" }];
  const remove = /^remove\s+(.+)$/.exec(t);
  if (remove?.[1]) return [{ type: "remove_item", itemName: remove[1], quantity: null, shared: null }];
  if (t.endsWith("?")) return [{ type: "question", ...none }];

  return [{ type: "unknown", ...none }];
}
