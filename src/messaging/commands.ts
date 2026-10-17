// Owner: Person 1. Simple command parser used when the LLM is unavailable.
import type { Intent } from "../ai/intent.js";

const none = { itemName: null, quantity: null, shared: null } as const;

export function parseCommand(text: string): Intent[] {
  const t = text.trim().toLowerCase();

  if (t === "order now") return [{ type: "order_now", ...none }];
  if (t === "yes" || t === "approve" || t === "approved") return [{ type: "approve", ...none }];
  if (/what do i owe|my balance/.test(t)) return [{ type: "what_do_i_owe", ...none }];
  if (t === "help") return [{ type: "help", ...none }];

  const add = /^add\s+(.+?)(\s+(personal|for me))?$/.exec(t);
  if (add?.[1]) {
    return [{ type: "add_item", itemName: add[1], quantity: null, shared: add[2] ? false : null }];
  }

  // TODO(P1): remove_item, set_shared ("make the chips personal")
  return [{ type: "unknown", ...none }];
}
