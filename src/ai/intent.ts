// Shared between the AI parser and the fallback command parser. Owner: Person 1.
import { z } from "zod";

export const IntentSchema = z.object({
  type: z.enum(["add_item", "remove_item", "set_shared", "order_now", "what_do_i_owe", "approve", "help", "question", "unknown"]),
  itemName: z.string().min(1).max(200).nullable().describe("Normalized product name, e.g. 'Toilet paper, 12 rolls'"),
  quantity: z.number().int().min(1).max(20).nullable(),
  shared: z.boolean().nullable().describe("true = household item, false = personal item, null = not stated"),
});

export const ParsedMessageSchema = z.object({
  intents: z.array(IntentSchema).max(20),
});

export type Intent = z.infer<typeof IntentSchema>;
export type ParsedMessage = z.infer<typeof ParsedMessageSchema>;
