// Owner: Person 1. Natural language -> validated intents, with a deterministic fallback.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../config.js";
import { parseCommand } from "../messaging/commands.js";
import { ParsedMessageSchema, type Intent } from "./intent.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const MODEL = "claude-opus-5-5";

const client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : undefined;

export async function parseMessage(text: string, senderName: string): Promise<Intent[]> {
  if (!client) return parseCommand(text);

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `${senderName}: ${text}` }],
      output_config: {
        effort: "low",
        format: zodOutputFormat(ParsedMessageSchema),
      },
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return parseCommand(text);
    }
    return response.parsed_output.intents;
  } catch (err) {
    // The demo must keep working without the LLM (AGENTS.md).
    console.warn("AI parse failed, using fallback parser:", err instanceof Error ? err.message : err);
    return parseCommand(text);
  }
}
