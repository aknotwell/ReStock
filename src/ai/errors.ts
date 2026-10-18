// Owner: Person 1 (drafted by Person 3). Why a Gemini call failed, for logs, without anything private.
// Kept apart from client.ts so tests that fake the client don't need to fake this too.
import { config } from "../config.js";

/** The Gemini API answered with an HTTP error. Only the status and Google's status code are kept, never the message. */
export class GeminiApiError extends Error {
  override name = "GeminiApiError";
  constructor(readonly status: number, readonly code: string | undefined) {
    super(`Gemini API error ${status}`);
  }
}

/** The request never got an answer (network failure or timeout). */
export class GeminiConnectionError extends Error {
  override name = "GeminiConnectionError";
  constructor(readonly timedOut: boolean) {
    super(timedOut ? "Gemini API timed out" : "couldn't reach the Gemini API");
  }
}

// What to check for each kind of failure, so the log line says what to fix.
const HINTS: Record<number, string> = {
  400: "the request was rejected; check GEMINI_API_KEY (an invalid key returns 400), the model and parameters",
  401: "the API key is wrong or revoked; check GEMINI_API_KEY",
  403: "this key isn't allowed to use this model or project; check GEMINI_API_KEY",
  404: `model "${config.geminiModel}" wasn't found for this key; check GEMINI_MODEL`,
  413: "the request was too large",
  429: "rate limited or out of free-tier quota; slow down or wait for the quota to reset",
  503: "the model is overloaded; it should recover on its own",
};

/**
 * A failed Gemini call, summarized for logs: HTTP status, Google's status code, and a hint.
 * Never includes the error message or anything from the member's text (AGENTS.md: no message bodies in logs).
 */
export function aiErrorSummary(err: unknown): string {
  if (err instanceof GeminiConnectionError) return err.timedOut ? "timed out reaching the Gemini API" : "couldn't reach the Gemini API (network)";
  if (err instanceof GeminiApiError) {
    const hint = HINTS[err.status] ?? (err.status >= 500 ? "a temporary API error" : undefined);
    return `${err.status} ${err.code ?? "error"}${hint ? ` (${hint})` : ""}`;
  }
  return err instanceof Error ? err.name : "unknown error";
}
