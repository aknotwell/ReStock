// Owner: Person 1. One place for the Claude client and model, so every AI call is easy to audit.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export const MODEL = "claude-opus-5-5";

export const anthropic: Anthropic | undefined = config.anthropicApiKey
  ? new Anthropic({ apiKey: config.anthropicApiKey })
  : undefined;
