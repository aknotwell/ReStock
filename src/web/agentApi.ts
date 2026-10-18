// HTTP entry point to the agent, for the VEYZL API audit and local testing.
// Runs the real inbound pipeline (guardrails -> AI -> templates) for a sandbox household and
// returns what Restock would have texted back. Nothing is sent and no real household is touched.
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { db } from "../core/store.js";
import { handleInbound } from "../messaging/inbound.js";
import { captureOutbound } from "../messaging/photon.js";
import type { Household } from "../types.js";

const SANDBOX_ID = "sandbox";
const SANDBOX_HANDLE = "sandbox-tester";

function ensureSandbox(): void {
  if (db.households.has(SANDBOX_ID)) return;
  const household: Household = {
    id: SANDBOX_ID,
    groupChatId: "sandbox-group",
    ownerId: "sandbox-owner",
    budgetCents: 20000,
    spentCents: 0,
    members: [{ id: "sandbox-owner", name: "Tester", phone: SANDBOX_HANDLE, role: "owner" }],
  };
  db.households.set(household.id, household);
}

/** Text from a message `content`: a string, or an array of parts like [{type:"text", text}] (OpenAI/Anthropic). */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("\n")
      .trim();
    return text || undefined;
  }
  return undefined;
}

/**
 * Accept the request shapes audit tools send: {message}, {prompt}, {input}, {text}, {query},
 * or a chat transcript {messages:[...]} (OpenAI chat-completions / Anthropic messages). For a transcript,
 * the last *user* turn is what Restock answers; system prompts from the caller are ignored.
 */
export function extractText(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" ? body : undefined;
  const b = body as Record<string, unknown>;
  for (const key of ["message", "prompt", "input", "text", "query"]) {
    const t = contentText(b[key]);
    if (t) return t;
  }
  if (Array.isArray(b.messages)) {
    const turns = b.messages.filter((m): m is { role?: unknown; content?: unknown } => !!m && typeof m === "object");
    const lastUser = [...turns].reverse().find((m) => m.role === "user") ?? turns.at(-1);
    return contentText(lastUser?.content);
  }
  return undefined;
}

type Wire = "openai" | "anthropic" | "plain";

/** Shape the reply the way the caller asked: OpenAI chat completion, Anthropic message, or Restock's own JSON. */
function shapeReply(wire: Wire, reply: string, model: unknown): Record<string, unknown> {
  const plain = { reply, response: reply, output: reply };
  const name = typeof model === "string" ? model : "restock-agent";
  if (wire === "openai") {
    return {
      ...plain,
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: name,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    };
  }
  if (wire === "anthropic") {
    return { ...plain, id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: name, content: [{ type: "text", text: reply }], stop_reason: "end_turn" };
  }
  return plain;
}

function authorized(req: Request): boolean {
  if (!config.agentApiToken) return true;
  const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(config.agentApiToken);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function agentApi(req: Request, res: Response): Promise<void> {
  // Log only the request's shape (never its content) so we can see what an audit tool actually sends.
  const keys = req.body && typeof req.body === "object" ? Object.keys(req.body).join(",") : typeof req.body;
  console.log(`[agent-api] ${req.method} ${req.path} keys=${keys}`);
  if (!authorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const text = extractText(req.body);
  if (!text || text.length > 4000) {
    res.status(400).json({ error: "Send JSON with a 'message' string (max 4000 chars)." });
    return;
  }
  ensureSandbox();
  const replies = await captureOutbound(() =>
    handleInbound({ messageId: randomUUID(), spaceId: "sandbox-dm", spaceKind: "direct", fromPhone: SANDBOX_HANDLE, text }),
  );
  const reply = replies.join("\n\n") || "OK.";
  const wire: Wire = req.path.endsWith("/messages") ? "anthropic" : Array.isArray(req.body?.messages) ? "openai" : "plain";
  res.json(shapeReply(wire, reply, req.body?.model));
}

/** GET on an agent route: explain how to call it instead of "Cannot GET". */
export function agentApiInfo(_req: Request, res: Response): void {
  res.json({
    service: "Restock agent (audit endpoint)",
    usage: 'POST JSON {"message": "..."} to /api/agent, or an OpenAI-style {"messages": [...]} to /v1/chat/completions',
    reply_fields: ["reply", "choices[0].message.content"],
  });
}
