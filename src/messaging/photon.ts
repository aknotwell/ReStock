// Owner: Person 1. Photon 2.0 transport (Beta platform, @photon-ai/api, https://photon.codes/docs/beta).
// Without PHOTON_API_KEY + PHOTON_PROJECT_ID it runs in console mode: sends are printed, nothing is received.
import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError, Photon } from "@photon-ai/api";
import { config } from "../config.js";
import { registerState } from "../core/persist.js";
import { householdName } from "../core/households.js";
import { findMember, getHousehold, householdsForPhone } from "../core/store.js";
import { forgetLineTextedBy, rememberLineTextedBy, rememberRestockLine } from "./photonLines.js";
import { redact } from "../safety/redact.js";

/** Normalized inbound message, independent of Photon's wire format. */
export type InboundMessage = {
  messageId: string;
  spaceId: string;
  spaceKind: "direct" | "group";
  fromPhone: string; // sender handle (E.164 phone or iMessage email)
  text: string;
  agentUserId?: string; // Photon user ID of our agent in this space (receivedBy.id)
  agentLine?: string; // the Restock number the text was sent to (receivedBy.handle), when Photon says
};

const photon =
  config.photonApiKey && config.photonProjectId
    ? new Photon({ headers: { Authorization: `Bearer ${config.photonApiKey}` } })
    : undefined;

export const photonEnabled = () => photon !== undefined;

// Learned from inbound traffic: which agent identity answers in each space, and each person's DM space.
const agentBySpace = new Map<string, string>();
const dmByHandle = new Map<string, string>();

// People who texted STOP: no texts until they text START. Saved so it survives restarts.
const muted = new Set<string>(); // phone handles
registerState("muted", { dump: () => [...muted], load: (data) => { muted.clear(); for (const p of data as string[]) muted.add(p); } });
export const isMuted = (phone: string) => muted.has(phone);
export const mute = (phone: string) => void muted.add(phone);
export const unmute = (phone: string) => void muted.delete(phone);
/**
 * Forget what we learned from Photon about this phone ("delete my data", or removed from a household):
 * its DM space and any private texts held for it. The STOP opt-out is kept, so they stay unsubscribed.
 */
export function forgetHandle(phone: string): void {
  forgetLineTextedBy(phone);
  dmByHandle.delete(phone);
  pendingByHandle.delete(phone);
}
export function resetMuted(): void {
  muted.clear();
}

/**
 * Can a private text reach this phone right now? Shared lines can't start chats, so only once the person has
 * texted us one-on-one (or in console mode, or while capturing). STOP turns this off.
 */
export function canTextPrivately(phone: string): boolean {
  if (muted.has(phone)) return false;
  return !photon || capture.getStore() !== undefined || dmByHandle.has(phone);
}

/** A text that was captured instead of sent. Private texts carry `memberId`; the rest carry the space they were for. */
export type CapturedText = { text: string; spaceId?: string; memberId?: string };

// Private texts for people who haven't DM'd the agent yet (shared lines can't start a chat). Delivered
// the next time they text us directly. Kept in memory only, never saved: message text isn't stored.
const PENDING_KEEP = 20;
const pendingByHandle = new Map<string, { text: string; key: string }[]>();

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
// When set, outbound texts are collected here instead of sent (used by POST /api/agent).
const capture = new AsyncLocalStorage<CapturedText[]>();

/** Run `fn` and return every text it would have sent, without sending anything. */
export async function captureOutbound(fn: () => Promise<void>): Promise<string[]> {
  return (await captureOutboundDetailed(fn)).map((c) => c.text);
}

/** Like captureOutbound, but also says where each text was going. */
export async function captureOutboundDetailed(fn: () => Promise<void>): Promise<CapturedText[]> {
  const out: CapturedText[] = [];
  await capture.run(out, fn);
  return out;
}

export function rememberInbound(msg: InboundMessage): void {
  if (msg.agentUserId) agentBySpace.set(msg.spaceId, msg.agentUserId);
  if (msg.spaceKind === "direct") dmByHandle.set(msg.fromPhone, msg.spaceId);
  rememberRestockLine(msg.agentLine);
  if (msg.spaceKind === "direct") rememberLineTextedBy(msg.fromPhone, msg.agentLine);
}

async function send(spaceId: string, rawText: string, idempotencyKey: string): Promise<void> {
  const text = redact(rawText); // V-002: no personal data or secrets leave the service
  const captured = capture.getStore();
  if (captured) {
    captured.push({ text, spaceId });
    return;
  }
  if (!photon || !config.photonProjectId) {
    console.log(`[photon:console → ${spaceId}]\n${text}\n`);
    return;
  }
  const senderId = agentBySpace.get(spaceId);
  if (!senderId) throw new Error(`No agent identity known for space ${spaceId} yet (it must message us first)`);
  console.log(`[photon] sending reply to ${spaceId.slice(0, 12)}…`);
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
 * Private text to one member. Uses their DM space if they've texted the agent directly. Otherwise
 * holds the text until they do (see deliverPending) and, if the group chat works, asks them there to
 * DM the agent (shared lines can't start new chats). Returns "queued" when the text is being held.
 */
export async function sendPrivate(memberId: string, rawText: string, key: string = crypto.randomUUID()): Promise<"sent" | "queued"> {
  const found = findMember(memberId);
  // Someone in several households gets all of them in one thread with Restock: say which one this is about.
  const label = found && householdsForPhone(found.member.phone).length > 1 ? `${householdName(found.household)}: ` : "";
  const text = redact(label + rawText); // V-002
  const captured = capture.getStore();
  if (captured) {
    captured.push({ text, memberId });
    return "sent";
  }
  if (!found) throw new Error(`Unknown member ${memberId}`);
  if (muted.has(found.member.phone)) return "sent"; // they texted STOP: drop it silently
  const dm = dmByHandle.get(found.member.phone);
  if (dm) {
    await send(dm, text, `restock-dm:${key}`);
    return "sent";
  }

  if (!photon) {
    console.log(`[photon:console → ${found.member.name} (private)]\n${text}\n`);
    return "sent";
  }
  const queue = pendingByHandle.get(found.member.phone) ?? [];
  queue.push({ text, key });
  pendingByHandle.set(found.member.phone, queue.slice(-PENDING_KEEP));
  console.warn(`No DM space for ${found.member.name}; holding their private text until they DM us.`);
  // Best effort: a nudge in the group. With no working group chat, they get the text when they DM us.
  await sendGroup(
    found.household.id,
    `${found.member.name}, I have something private for you. Text me directly and I'll send it there.`,
    `nudge:${key}`,
  ).catch((err) => console.warn("group nudge failed:", err instanceof Error ? err.message : err));
  return "queued";
}

/** Send any private texts held for this sender, now that they've DM'd us. Call after rememberInbound. */
export async function deliverPending(msg: InboundMessage): Promise<void> {
  if (msg.spaceKind !== "direct") return;
  const queue = pendingByHandle.get(msg.fromPhone);
  if (!queue?.length) return;
  pendingByHandle.delete(msg.fromPhone);
  for (const [i, item] of queue.entries()) {
    try {
      await send(msg.spaceId, item.text, `restock-dm:${item.key}`);
    } catch (err) {
      // Keep what's left for their next DM, so nothing is lost to a temporary Photon error.
      pendingByHandle.set(msg.fromPhone, queue.slice(i));
      console.warn("held private text failed to send:", err instanceof Error ? err.message : err);
      return;
    }
  }
  console.log(`[photon] delivered ${queue.length} held private text(s) to …${msg.fromPhone.slice(-4)}`);
}

/** Test helper: forget held private texts. */
export function resetPendingPrivate(): void {
  pendingByHandle.clear();
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
    agentLine: receivedBy && receivedBy.platform !== "UNKNOWN" ? receivedBy.handle : undefined,
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
          // Traffic log for debugging live tests: chat type and the sender's last 4 digits only, never content.
          console.log(`[photon] received ${msg.spaceKind} message from …${msg.fromPhone.slice(-4)}`);
          await deliverPending(msg); // receipts and links held until they texted us directly
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
