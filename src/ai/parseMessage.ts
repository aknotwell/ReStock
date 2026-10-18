// Owner: Person 1. Natural language -> validated intents, with a deterministic fallback.
import { parseCommand } from "../messaging/commands.js";
import { ParsedMessageSchema, type Intent } from "./intent.js";
import { gemini as client } from "./client.js";
import { aiErrorSummary } from "./errors.js";
import { checkInput } from "../safety/guardrails.js";
import { SYSTEM_PROMPT, wrapUntrusted } from "./prompt.js";

export async function parseMessage(text: string, senderName: string): Promise<Intent[]> {
  if (checkInput(text)) return [];
  const fallback = parseCommand(text);
  // Explicit commands, especially checkout, are interpreted by code alone.
  if (!client || fallback.some((i) => i.type !== "unknown")) return fallback;

  try {
    const response = await client.generate({
      system: SYSTEM_PROMPT,
      user: wrapUntrusted("member", text),
      schema: ParsedMessageSchema,
      maxOutputTokens: 2048,
    });

    if (response.refused || response.output === undefined) {
      return parseCommand(text);
    }
    const parsed = ParsedMessageSchema.safeParse(response.output);
    if (!parsed.success || !response.finished) return fallback;
    return parsed.data.intents.filter((intent) =>
      intent.type !== "order_now" && intent.type !== "approve"
      && (!intent.itemName || !checkInput(intent.itemName)),
    );
  } catch (err) {
    // The demo must keep working without the LLM (AGENTS.md). The log says why, never what was said.
    console.warn(`AI parse failed: ${aiErrorSummary(err)}. Using the command parser.`);
    return parseCommand(text);
  }
}
