// Why a Claude call failed, for logs, without anything private.
// Kept apart from client.ts so tests that fake the client don't need to fake this too.
import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./client.js";

// What to check for each kind of failure, so the log line says what to fix.
const HINTS: Record<number, string> = {
  400: "the request was rejected; check the model and parameters",
  401: "the API key is wrong or revoked; check ANTHROPIC_API_KEY",
  402: "the Anthropic account is out of credits; check billing in the Claude Console",
  403: "this key isn't allowed to use this model or workspace",
  404: `model "${MODEL}" wasn't found for this key`,
  413: "the request was too large",
  429: "rate limited; slow down or raise the limit",
  529: "the API is overloaded; it should recover on its own",
};

/**
 * A failed Claude call, summarized for logs: HTTP status, error type, request ID, and a hint.
 * Never includes the error message or anything from the member's text (AGENTS.md: no message bodies in logs).
 */
export function aiErrorSummary(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timed out reaching the Claude API";
  if (err instanceof Anthropic.APIConnectionError) return "couldn't reach the Claude API (network)";
  if (err instanceof Anthropic.APIError) {
    const hint = err.status !== undefined ? HINTS[err.status] ?? (err.status >= 500 ? "a temporary API error" : undefined) : undefined;
    return `${err.status ?? "?"} ${err.type ?? "error"}${hint ? ` (${hint})` : ""}, request ${err.requestID ?? "unknown"}`;
  }
  return err instanceof Error ? err.name : "unknown error";
}
