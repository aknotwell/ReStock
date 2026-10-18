// Owner: Person 1. One place for the Gemini client and model, so every AI call is easy to audit.
// Calls the Gemini REST API directly with structured (JSON Schema) output; no SDK needed.
import { z } from "zod";
import { config } from "../config.js";
import { GeminiApiError, GeminiConnectionError } from "./errors.js";

export const MODEL = config.geminiModel;

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 20_000;
// Finish reasons that mean Gemini declined to answer, so callers use the deterministic fallback.
const REFUSALS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

export type GenerateRequest = {
  system: string;
  user: string;
  /** The output must match this schema. It is sent to Gemini as JSON Schema; callers still validate the result. */
  schema: z.ZodType;
  maxOutputTokens: number;
};

export type GenerateResult = {
  /** true only when the model stopped normally (not cut off or blocked). */
  finished: boolean;
  /** true when Gemini blocked the prompt or the answer for safety. */
  refused: boolean;
  /** The parsed JSON output, unvalidated. undefined if there was none or it wasn't JSON. */
  output: unknown;
};

export type GeminiClient = { generate(req: GenerateRequest): Promise<GenerateResult> };

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * These are small classification tasks, so keep thinking low. Only 2.5 Flash can turn it off with a budget;
 * Gemini 3 models use thinking levels whose options vary by model (3.5 Flash-Lite defaults to minimal),
 * and 2.5 Pro can't turn thinking off, so every other model keeps its default.
 */
export function thinkingConfig(model: string): { thinkingConfig?: { thinkingBudget: number } } {
  return /^gemini-2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {};
}

function createClient(apiKey: string, model: string): GeminiClient {
  return {
    async generate({ system, user, schema, maxOutputTokens }) {
      let res: Response;
      try {
        res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: jsonSchema(schema),
              maxOutputTokens,
              ...thinkingConfig(model),
            },
          }),
          // Never follow a redirect: it would carry the API key and the member's text somewhere else.
          redirect: "error",
        });
      } catch (err) {
        throw new GeminiConnectionError(err instanceof Error && err.name === "TimeoutError");
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => undefined)) as { error?: { status?: string } } | undefined;
        throw new GeminiApiError(res.status, body?.error?.status);
      }

      const data = (await res.json()) as GeminiResponse;
      const candidate = data.candidates?.[0];
      const refused = !!data.promptFeedback?.blockReason || REFUSALS.has(candidate?.finishReason ?? "");
      const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      let output: unknown;
      try { output = text ? JSON.parse(text) : undefined; } catch { output = undefined; }
      return { finished: candidate?.finishReason === "STOP", refused, output };
    },
  };
}

export const gemini: GeminiClient | undefined = config.geminiApiKey
  ? createClient(config.geminiApiKey, MODEL)
  : undefined;
