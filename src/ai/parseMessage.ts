import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../config.js";
import { parseCommand } from "../messaging/commands.js";
import { containsCardNumber } from "../messaging/guard.js";
import { CATALOG } from "./catalog.js";
import { ParsedMessageSchema, type Intent } from "./intent.js";
import { SYSTEM_PROMPT } from "./prompt.js";

export type ParseContext = { cart: { name: string; shared: boolean }[] };
export type ModelParser = (text: string, context?: ParseContext) => Promise<unknown>;

export function createMessageParser(model?: ModelParser) {
  return async (text: string, _senderName: string, context?: ParseContext): Promise<Intent[]> => {
    if (containsCardNumber(text)) return [];
    const fallback = parseCommand(text);
    const checked = ParsedMessageSchema.safeParse({ intents: fallback });
    if (!checked.success) return [{ type: "clarify", itemName: null, quantity: null, shared: null }];
    if (fallback[0]?.type !== "unknown" || !model) return fallback;
    try {
      const parsed = ParsedMessageSchema.parse(await model(text, context));
      return parsed.intents.filter((intent) => intent.type !== "order_now" && intent.type !== "approve");
    } catch {
      // Provider errors can contain request content. Never log the error or message.
      console.warn("AI parsing unavailable; using command parser.");
      return fallback;
    }
  };
}

const client = config.anthropicApiKey
  ? new Anthropic({ apiKey: config.anthropicApiKey, timeout: 8000, maxRetries: 0 })
  : undefined;

export const parseMessage = createMessageParser(client ? async (text, context) => {
  const response = await client.messages.parse({
    model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify({ text, catalog: CATALOG.map((p) => p.name), cart: context?.cart ?? [] }) }],
    output_config: { effort: "low", format: zodOutputFormat(ParsedMessageSchema) },
  });
  if (response.stop_reason !== "end_turn") throw new Error("Incomplete AI response");
  return response.parsed_output;
} : undefined);
