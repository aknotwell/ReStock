// Owner: Person 1. Photon 2.0 transport (Beta platform, @photon-ai/api, https://photon.codes/docs/beta).
// Without PHOTON_API_KEY + PHOTON_PROJECT_ID it runs in console mode: sends are printed, nothing is received.
import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError, Photon } from "@photon-ai/api";
import { config } from "../config.js";
import { registerState } from "../core/persist.js";
import { findMember, getHousehold } from "../core/store.js";
import { redact } from "../safety/redact.js";

/** Normalized inbound message, independent of Photon's wire format. */
export type InboundMessage = {
  messageId: string;
  spaceId: string;
  spaceKind: "direct" | "group";
  fromPhone: string; // sender handle (E.164 phone or iMessage email)
  text: string;
  agentUserId?: string; // Photon user ID of our agent in this space (receivedBy.id)
};

const photon =
  config.photonApiKey && config.photonProjectId
    ? new Photon({ headers: { Authorization: `Bearer ${config.photonApiKey}` } })
    : undefined;

export const photonEnabled = () => photon !== undefined;

// Learned from inbound traffic: which agent identity answers in each space, and each person's DM space.
const agentBySpace = new Map<string, string>();
const dmByHandle = new Map<string, string>();

// Polling position. Saved so texts that arrive during a restart are answered once, not twice or never.
const POLL_RESUME_LIMIT_MS = 10 * 60 * 1000; // after a longer outage, skip the backlog instead of replaying it
const SEEN_KEEP = 500;
const poll = { since: "", seen: [] as string[] };

registerState("photon", {
  dump: () => ({ agentBySpace: [...agentBySpace], dmByHandle: [...dmByHandle], since: poll.since, seen: poll.seen }),
  load: (data) => {
    const saved = data as { agentBySpace?: [string, string][]; dmByHandle?: [string, string][]; since?: string; seen?: string[] };
    for (const [k, v] of saved.agentBySpace ?? []) agentBySpace.set(k, v);
    for (const [k, v] of saved.dmByHandle ?? []) dmByHandle.set(k, v);
    poll.since = saved.since ?? "";
    poll.seen = (saved.seen ?? []).slice(-SEEN_KEEP);
  },
});

/** Where polling starts: the saved position if it's recent, otherwise a few seconds ago. */
export function pollStart(now = Date.now()): string {
  const saved = Date.parse(poll.since);
  return Number.isFinite(saved) && now - saved <= POLL_RESUME_LIMIT_MS ? poll.since : new Date(now - 5_000).toISOString();
}

// When set, outbound texts are collected here instead of sent (used by POST /api/agent).
const capture = new AsyncLocalStorage<string[]>();

/** Run `fn` and return every text it would have sent, without sending anything. */
export async function captureOutbound(fn: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  await capture.run(out, fn);
  return out;
}

export function rememberInbound(msg: InboundMessage): void {
  if (msg.agentUserId) agentBySpace.set(msg.spaceId, msg.agentUserId);
  if (msg.spaceKind === "direct") dmByHandle.set(msg.fromPhone, msg.spaceId);
}

async function send(spaceId: string, rawText: string, idempotencyKey: string): Promise<void> {
  const text = redact(rawText); // V-002: no personal data or secrets leave the service
  const captured = capture.getStore();
  if (captured) {
    captured.push(text);
    return;
  }
  if (!photon || !config.photonProjectId) {
    console.log(`[photon:console → ${spaceId}]\n${text}\n`);
    return;
  }
  const senderId = agentBySpace.get(spaceId);
  if (!senderId) throw new Error(`No agent identity known for space ${spaceId} yet (it must message us first)`);
  await photon.projects.sendMessage({
    path: { id: config.photonProjectId },
    headers: { "idempotency-key": idempotencyKey },
    body: { spaceId, senderId, content: { type: "text", format: "plain", text } },
  });
}

/** Reply in the same chat a message came from. Idempotent per inbound message. */
export async function reply(msg: InboundMessage, text: string, part = 0): Promise<void> {
  await send(msg.spaceId, text, `restock-reply:${msg.messageId}:${part}`);
}

export async function sendGroup(householdId: string, text: string, key: string = crypto.randomUUID()): Promise<void> {
  await send(getHousehold(householdId).groupChatId, text, `restock-group:${key}`);
}

/**
 * Private text to one member. Uses their DM space if they've texted the agent directly;
 * otherwise asks them in the group to DM the agent (shared lines can't start new chats).
 */
export async function sendPrivate(memberId: string, rawText: string, key: string = crypto.randomUUID()): Promise<void> {
  const text = redact(rawText); // V-002
  const captured = capture.getStore();
  if (captured) {
    captured.push(text);
    return;
  }
  const found = findMember(memberId);
  if (!found) throw new Error(`Unknown member ${memberId}`);
  const dm = dmByHandle.get(found.member.phone);
  if (dm) return send(dm, text, `restock-dm:${key}`);

  if (!photon) {
    console.log(`[photon:console → ${found.member.name} (private)]\n${text}\n`);
    return;
  }
  console.warn(`No DM space for ${found.member.name}; nudging them in the group instead.`);
  await sendGroup(
    found.household.id,
    `${found.member.name}, I have something private for you. Text me directly and I'll send it there.`,
    `nudge:${key}`,
  );
}

type PhotonMessage = Awaited<ReturnType<Photon["projects"]["listMessages"]>>["items"][number];
type ChatPlatform = "imessage" | "sms" | "whatsapp" | "telegram";
type KnownMessage = Extract<PhotonMessage, { platform: ChatPlatform }>;

// Newer API versions may add platforms the client doesn't know yet; skip those.
function isKnown(m: PhotonMessage): m is KnownMessage {
  const p = (m as { platform?: unknown }).platform;
  return p === "imessage" || p === "sms" || p === "whatsapp" || p === "telegram";
}

function toInbound(m: KnownMessage): InboundMessage | undefined {
  const { sentBy, space, receivedBy } = m;
  if (m.status !== "received" || sentBy.platform === "UNKNOWN" || space.platform === "UNKNOWN") return undefined;
  if (sentBy.kind !== "human") return undefined;
  const c = m.content;
  if (c.type !== "text") return undefined; // TODO(P1): attachments, reactions
  return {
    messageId: m.id,
    spaceId: space.id,
    spaceKind: space.kind === "direct" ? "direct" : "group",
    fromPhone: sentBy.handle,
    text: c.text,
    agentUserId: receivedBy && receivedBy.platform !== "UNKNOWN" ? receivedBy.id : undefined,
  };
}

/**
 * Poll Photon for new inbound messages and hand each one to `handle`, oldest first.
 * Polling needs no public URL, so it works from a laptop during the hackathon.
 * TODO(P1): switch to the Socket.IO event stream (photon.codes/docs/beta/websocket) for lower latency.
 */
export function startPolling(handle: (msg: InboundMessage) => Promise<void>, intervalMs = 2000): () => void {
  if (!photon || !config.photonProjectId) {
    console.log("Photon not configured (PHOTON_API_KEY / PHOTON_PROJECT_ID); inbound polling is off.");
    return () => {};
  }
  const projectId = config.photonProjectId;
  const seen = new Set<string>(poll.seen);
  let since = pollStart();
  let stopped = false;

  const tick = async () => {
    try {
      let pageToken: string | undefined;
      do {
        const page = await photon.projects.listMessages({
          path: { id: projectId },
          query: {
            createdSince: since,
            direction: "received",
            order: "asc",
            pageSize: 100,
            platform: config.photonPlatform,
            ...(pageToken ? { pageToken } : {}),
          },
        });
        for (const m of page.items) {
          if (!isKnown(m) || seen.has(m.id)) continue;
          seen.add(m.id);
          if (m.createdAt > since) since = m.createdAt;
          poll.since = since;
          poll.seen.push(m.id);
          if (poll.seen.length > SEEN_KEEP) poll.seen.splice(0, poll.seen.length - SEEN_KEEP);
          const msg = toInbound(m);
          if (!msg) continue;
          rememberInbound(msg);
          await handle(msg).catch((err) => console.error("handler failed:", err instanceof Error ? err.message : err));
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (err) {
      if (err instanceof ApiError) console.error(`Photon API error ${err.status} (request ${err.requestId ?? "unknown"})`);
      else console.error("Photon poll failed:", err instanceof Error ? err.message : err);
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };

  console.log(`Polling Photon (${config.photonPlatform}) every ${intervalMs}ms`);
  void tick();
  return () => {
    stopped = true;
  };
}
