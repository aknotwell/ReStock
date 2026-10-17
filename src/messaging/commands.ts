// Owner: Person 1. Simple command parser used when the LLM is unavailable.
import type { Intent } from "../ai/intent.js";

const none = { itemName: null, quantity: null, shared: null } as const;

// "Are you a bot?", "is this a real person?", "who is this" — the agent must always say it's an AI (AGENTS.md).
const IDENTITY =
  /^(?:who (?:are you|is this|am i (?:talking|texting|chatting) (?:to|with))|who's this|what are you|are you (?:an? )?(?:real |actual )?(?:person|human|bot|robot|ai|a\.i\.|machine|computer|chat ?bot|real)|is this (?:an? )?(?:real |actual )?(?:person|human|bot|robot|ai|a\.i\.|machine|chat ?bot|automated)|am i (?:talking|texting|chatting) (?:to|with) (?:an? )?(?:real |actual )?(?:person|human|bot|robot|ai|machine))[?!. ]*$/;

export function isIdentityQuestion(text: string): boolean {
  return IDENTITY.test(text.trim().toLowerCase().replace(/[’]/g, "'"));
}

export function parseCommand(text: string): Intent[] {
  const t = text.trim().toLowerCase();

  if (t === "order now") return [{ type: "order_now", ...none }];
  if (t === "yes" || t === "approve" || t === "approved") return [{ type: "approve", ...none }];
  if (/what do i owe|my balance/.test(t)) return [{ type: "what_do_i_owe", ...none }];
  if (t === "help" || isIdentityQuestion(t)) return [{ type: "help", ...none }];
  if (/^(add|update|set up) (a |my )?card$/.test(t)) return [{ type: "add_card", ...none }];

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
