// Owner: Person 1. Natural language -> validated intents, with a deterministic fallback.
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { parseCommand } from "../messaging/commands.js";
import { ParsedMessageSchema, type Intent } from "./intent.js";
import { anthropic as client, MODEL } from "./client.js";
import { checkInput } from "../safety/guardrails.js";
import { SYSTEM_PROMPT, wrapUntrusted } from "./prompt.js";

export async function parseMessage(text: string, senderName: string): Promise<Intent[]> {
  if (checkInput(text)) return [];
  const fallback = parseCommand(text);
  // Explicit commands, especially checkout, are interpreted by code alone.
  if (!client || fallback.some((i) => i.type !== "unknown")) return fallback;

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: wrapUntrusted("member", text) }],
      output_config: {
        effort: "low",
        format: zodOutputFormat(ParsedMessageSchema),
      },
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return parseCommand(text);
    }
    const parsed = ParsedMessageSchema.safeParse(response.parsed_output);
    if (!parsed.success || response.stop_reason !== "end_turn") return fallback;
    return parsed.data.intents.filter((intent) =>
      intent.type !== "order_now" && intent.type !== "approve"
      && (!intent.itemName || !checkInput(intent.itemName)),
    );
  } catch {
    // The demo must keep working without the LLM (AGENTS.md).
    console.warn("AI parse failed; using command parser.");
    return parseCommand(text);
  }
}
