// Owner: Person 1. HTTP entry point to the agent, for the VEYZL API audit and local testing.
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

/** Accept the common request shapes audit tools send: {message}, {prompt}, {input}, {text}, or {messages:[...]}. */
export function extractText(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" ? body : undefined;
  const b = body as Record<string, unknown>;
  for (const key of ["message", "prompt", "input", "text", "query"]) {
    if (typeof b[key] === "string") return b[key];
  }
  if (Array.isArray(b.messages)) {
    const last = [...b.messages].reverse().find((m) => m && typeof m === "object" && (m as { role?: unknown }).role !== "assistant");
    const content = (last as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") return content;
  }
  return undefined;
}

function authorized(req: Request): boolean {
  if (!config.agentApiToken) return true;
  const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(config.agentApiToken);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function agentApi(req: Request, res: Response): Promise<void> {
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
  res.json({ reply, response: reply, output: reply });
}
