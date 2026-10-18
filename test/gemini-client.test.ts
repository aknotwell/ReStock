import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
vi.hoisted(() => { process.env.GEMINI_API_KEY = "test-key"; process.env.GEMINI_MODEL = "gemini-test"; });
import { gemini, thinkingConfig } from "../src/ai/client.js";
import { aiErrorSummary, GeminiApiError } from "../src/ai/errors.js";

const schema = z.object({ productId: z.string().nullable() });
const req = { system: "SYSTEM", user: "USER", schema, maxOutputTokens: 64 };
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("Gemini client", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("sends the key in a header and the schema as JSON Schema", async () => {
    const fetch = reply(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"productId":"tp-12"}' }] } }] });
    vi.stubGlobal("fetch", fetch);
    expect(await gemini!.generate(req)).toEqual({ finished: true, refused: false, output: { productId: "tp-12" } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(String(init.body));
    expect(body.systemInstruction.parts[0].text).toBe("SYSTEM");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema.properties.productId).toBeDefined();
    expect(body.generationConfig.responseJsonSchema.$schema).toBeUndefined();
    // Redirects would carry the key elsewhere, so fetch must refuse them.
    expect(init.redirect).toBe("error");
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("turns thinking off only on 2.5 Flash, where a zero budget is allowed", () => {
    expect(thinkingConfig("gemini-2.5-flash")).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
    expect(thinkingConfig("gemini-2.5-flash-lite")).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
    expect(thinkingConfig("gemini-2.5-pro")).toEqual({});
    expect(thinkingConfig("gemini-3.5-flash-lite")).toEqual({});
    expect(thinkingConfig("gemini-3.8-flash")).toEqual({});
  });

  it("reports blocked and cut-off answers so callers fall back", async () => {
    vi.stubGlobal("fetch", reply(200, { promptFeedback: { blockReason: "SAFETY" } }));
    expect(await gemini!.generate(req)).toEqual({ finished: false, refused: true, output: undefined });
    vi.stubGlobal("fetch", reply(200, { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"produc' }] } }] }));
    expect(await gemini!.generate(req)).toEqual({ finished: false, refused: false, output: undefined });
  });

  it("keeps only the status and code of an API error, never its message", async () => {
    vi.stubGlobal("fetch", reply(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "PRIVATE_PROVIDER_PAYLOAD" } }));
    const err = await gemini!.generate(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiApiError);
    const summary = aiErrorSummary(err);
    expect(summary).toMatch(/^429 RESOURCE_EXHAUSTED \(rate limited/);
    expect(summary).not.toContain("PRIVATE_PROVIDER_PAYLOAD");
    expect(JSON.stringify(err)).not.toContain("PRIVATE_PROVIDER_PAYLOAD");
  });

  it("treats a refused redirect like a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (init.redirect === "error") throw new TypeError("fetch failed: redirect mode is set to error");
      return new Response("{}", { status: 200 });
    }));
    expect(aiErrorSummary(await gemini!.generate(req).catch((e: unknown) => e))).toBe("couldn't reach the Gemini API (network)");
  });

  it("turns network failures into a connection error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(aiErrorSummary(await gemini!.generate(req).catch((e: unknown) => e))).toBe("couldn't reach the Gemini API (network)");
  });
});
