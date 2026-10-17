// Person 1: dependable commands remain available without an LLM.
import type { Intent } from "../ai/intent.js";

export const emptyFields = { itemName: null, quantity: null, shared: null } as const;
export const isOrderCommand = (text: string): boolean => /^order now[.!]?$/i.test(text.trim());
export const isApprovalCommand = (text: string): boolean => /^(?:yes|approved|approve(?:\s+.+)?)[.!]?$/i.test(text.trim());

export function parseCommand(text: string): Intent[] {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  const simple = (type: Intent["type"]): Intent[] => [{ type, ...emptyFields }];
  if (isOrderCommand(text)) return simple("order_now");
  if (/^(yes|approve|approved)$/.test(t)) return simple("approve");
  if (/^(what do i owe|my balance)$/.test(t)) return simple("what_do_i_owe");
  if (/^(cart|show cart|what'?s in (?:the |our )?cart)$/.test(t)) return simple("show_cart");
  if (/^(help|who are you|are you (?:an? )?(?:ai|bot))$/.test(t)) return simple("help");
  if (/^(cancel|never mind|nevermind|no)$/.test(t)) return simple("cancel");
  if (/^(add card|add a card)$/.test(t)) return simple("add_card");
  const approval = /^approve\s+(.+)$/.exec(t);
  if (approval?.[1]) return [{ ...emptyFields, type: "approve", itemName: approval[1] }];
  const remove = /^(?:remove|delete)\s+(.+)$/.exec(t);
  if (remove?.[1]) return [{ ...emptyFields, type: "remove_item", itemName: remove[1] }];
  const classification = /^(?:make\s+(?:the\s+)?(.+?)\s+)?(personal|shared)$/.exec(t);
  if (classification) return [{ ...emptyFields, type: "set_shared", itemName: classification[1] ?? null, shared: classification[2] === "shared" }];
  const add = /^(?:add|restock|we(?:'re| are) out of|we need|can we get)\s+(.+)$/.exec(t);
  if (add?.[1]) {
    const personal = /\s+(personal|for me)$/.test(add[1]);
    return add[1].replace(/\s+(personal|for me)$/, "").split(/\s+and\s+/).map((part) => {
      const measurement = /^\d+[-\s]+(?:rolls?|oz|ounces?|liters?|litres?|ml|grams?|kg)\b/.test(part);
      const quantity = measurement ? null : /^(\d+)\s+(?:(?:packs?|bottles?)\s+of\s+)?(.+)$/.exec(part);
      return { type: "add_item", itemName: quantity?.[2] ?? part, quantity: quantity ? Number(quantity[1]) : null, shared: personal ? false : null };
    });
  }
  return simple("unknown");
}
