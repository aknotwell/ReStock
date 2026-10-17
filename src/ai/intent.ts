// Shared between the AI parser and the fallback command parser. Owner: Person 1.
import { z } from "zod";

export const IntentSchema = z.object({
  type: z.enum(["add_item", "remove_item", "set_shared", "order_now", "what_do_i_owe", "approve", "show_cart", "add_card", "cancel", "clarify", "help", "unknown"]),
  itemName: z.string().trim().min(1).max(160).nullable().describe("Product request retaining brand, size and preferences; null for a pronoun"),
  quantity: z.number().int().min(1).max(20).nullable(),
  shared: z.boolean().nullable().describe("true = household item, false = personal item, null = not stated"),
}).strict();

export const ParsedMessageSchema = z.object({
  intents: z.array(IntentSchema).max(10),
}).strict();

export type Intent = z.infer<typeof IntentSchema>;
export type ParsedMessage = z.infer<typeof ParsedMessageSchema>;
