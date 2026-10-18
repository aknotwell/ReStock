// One place for the Claude client and model, so every AI call is easy to audit.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export const MODEL = "claude-opus-5-5";

export const anthropic: Anthropic | undefined = config.anthropicApiKey
  // A stuck call shouldn't hold up a text reply: give up after 20 s and one retry, then the command parser answers.
  ? new Anthropic({ apiKey: config.anthropicApiKey, timeout: 20_000, maxRetries: 1 })
  : undefined;
