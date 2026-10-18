// Giving people a Restock iMessage number: Photon "shared line assignments".
// Photon's shared lines only accept texts from assigned handles, so web sign-up assigns the person's phone
// to a pooled line and shows them which Restock number to text. Without Photon keys (tests, local dev) it
// hands out a fixed fake number so the rest of the flow still runs.
import { randomUUID } from "node:crypto";
import { ApiError, Photon } from "@photon-ai/api";
import { config } from "../config.js";
import { registerState } from "../core/persist.js";

export type LineAssignment = { assignmentId: string; line: string }; // line: the Restock number to text, E.164

export class LineUnavailableError extends Error {}

const photon =
  config.photonApiKey && config.photonProjectId
    ? new Photon({ headers: { Authorization: `Bearer ${config.photonApiKey}` } })
    : undefined;

export const CONSOLE_LINE = "+16285550100"; // used only when Photon isn't configured

// Restock's own numbers seen so far: lines handed out at sign-up, and every line a text arrived on.
// Used so a "save restock as a contact" card is only ever made for a real Restock number.
const knownLines = new Set<string>();
registerState("restock-lines", {
  dump: () => [...knownLines],
  load: (data) => {
    knownLines.clear();
    for (const line of data as string[]) knownLines.add(line);
  },
});

/** Note a number as one of Restock's lines (an assigned line, or the line a text arrived on). */
export function rememberRestockLine(line: string | undefined): void {
  if (line && /^\+\d{10,15}$/.test(line)) knownLines.add(line);
}

/** Whether this number is one of Restock's own lines. Without Photon, the fake console line counts. */
export function isRestockLine(line: string): boolean {
  return knownLines.has(line) || (!photon && line === CONSOLE_LINE);
}

type Assignment = { assignmentId: string; assignedPhoneNumber: string; handle: string; releasedAt?: string | undefined };
// Every line we hand out is one of Restock's own numbers (see rememberRestockLine).
const toLine = (a: Assignment): LineAssignment => {
  rememberRestockLine(a.assignedPhoneNumber);
  return { assignmentId: a.assignmentId, line: a.assignedPhoneNumber };
};
const problemCode = (err: ApiError) => (err.body as { code?: unknown } | undefined)?.code;

/**
 * Connect this phone to a Restock number in Photon and return the number to text. Always asks Photon, even
 * when we saved a number for this phone before, so the connection exists when we show the number: texts from a
 * phone Photon hasn't connected get its own "not connected to an agent yet" reply and never reach Restock.
 * Never returns a released assignment. `saved` is only used if Photon says the phone is already connected,
 * the lookup of which number fails, and Photon confirms `saved` is that phone's live assignment.
 */
export async function assignLine(phone: string, firstName: string, idempotencyKey: string, saved?: LineAssignment): Promise<LineAssignment> {
  if (!photon || !config.photonProjectId) {
    console.warn("sign-up line: Photon isn't configured (PHOTON_API_KEY / PHOTON_PROJECT_ID), so this is a placeholder number nobody can text.");
    return { assignmentId: `console-${phone}`, line: CONSOLE_LINE };
  }
  const projectId = config.photonProjectId;
  const who = `…${phone.slice(-4)}`;
  const create = (key: string) =>
    photon.projects.platforms.imessage.assignments.create({ path: { id: projectId }, headers: { idempotencyKey: key }, body: { handle: phone, firstName } });
  try {
    let a = await create(idempotencyKey);
    // A key Photon has seen before replays its first answer, even if that assignment was released since.
    if (a.releasedAt) a = await create(`${idempotencyKey}:${randomUUID()}`);
    if (a.releasedAt) throw new LineUnavailableError("Restock couldn't set up a number for you right now. Please try again in a minute.");
    console.log(`sign-up line: connected ${who} to Restock number …${a.assignedPhoneNumber.slice(-4)} in Photon`);
    return toLine(a);
  } catch (err) {
    if (err instanceof ApiError && problemCode(err) === "ASSIGNMENT_EXISTS") {
      // This phone is already connected (an earlier sign-up, or one added in the Photon dashboard). Use that number:
      // a second one would be refused anyway.
      const existing = await activeAssignmentFor(phone).catch((e) => {
        console.warn("sign-up line: couldn't look up the existing connection:", e instanceof ApiError ? `${e.status}` : e instanceof Error ? e.message : e);
        return undefined;
      });
      if (existing) {
        console.log(`sign-up line: ${who} was already connected to Restock number …${existing.assignedPhoneNumber.slice(-4)} in Photon`);
        return toLine(existing);
      }
      // The saved number counts only if Photon confirms it's this phone's live assignment: an old, released one
      // would send them to a number Photon no longer connects to their phone.
      if (saved && (await isLiveFor(saved.assignmentId, phone))) {
        console.log(`sign-up line: ${who} is already connected in Photon to the saved number …${saved.line.slice(-4)}`);
        return saved;
      }
    }
    if (err instanceof ApiError) {
      console.error(`Photon line assignment failed: ${err.status} ${String(problemCode(err) ?? "")} (request ${err.requestId ?? "unknown"})`);
      throw new LineUnavailableError(
        err.status === 403
          ? "Restock can't create new lines right now (the server's Photon key needs platforms:write)."
          : "Restock couldn't set up a number for you right now. Please try again in a minute.",
      );
    }
    throw err;
  }
}

/** Whether this assignment is live and belongs to this phone. Anything Photon can't confirm counts as no. */
async function isLiveFor(assignmentId: string, phone: string): Promise<boolean> {
  if (!photon || !config.photonProjectId) return false;
  try {
    const a = await photon.projects.platforms.imessage.assignments.get({ path: { id: config.photonProjectId, assignmentId } });
    return a.handle === phone && !a.releasedAt;
  } catch (err) {
    console.warn("sign-up line: couldn't confirm the saved number:", err instanceof ApiError ? `${err.status}` : err instanceof Error ? err.message : err);
    return false;
  }
}

/** The phone's active assignment, if Photon has one. */
async function activeAssignmentFor(phone: string): Promise<Assignment | undefined> {
  if (!photon || !config.photonProjectId) return undefined;
  let pageToken: string | undefined;
  do {
    const page = await photon.projects.platforms.imessage.assignments.list({
      path: { id: config.photonProjectId },
      query: { pageSize: 100, ...(pageToken ? { pageToken } : {}) },
    });
    const found = page.assignments.find((a) => a.handle === phone && !a.releasedAt);
    if (found) return found;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return undefined;
}

/**
 * Free the seat when a sign-up expires or someone leaves. Photon keeps the released row for audit and
 * repeating the call is safe. Returns false when Photon couldn't be reached, so the caller can retry.
 */
export async function releaseLine(assignmentId: string): Promise<boolean> {
  if (!photon || !config.photonProjectId || assignmentId.startsWith("console-")) return true;
  try {
    await photon.projects.platforms.imessage.assignments.release({ path: { id: config.photonProjectId, assignmentId } });
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return true; // already gone
    console.warn("Photon line release failed:", err instanceof ApiError ? `${err.status}` : err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Release every active assignment Photon has for this phone, including ones we lost track of (a demo
 * reset, or a sign-up made before a restart). Needs platforms:read to list; returns false if it couldn't.
 */
export async function releaseLinesForHandle(phone: string): Promise<boolean> {
  if (!photon || !config.photonProjectId) return true;
  const ids: string[] = [];
  try {
    let pageToken: string | undefined;
    do {
      const page = await photon.projects.platforms.imessage.assignments.list({
        path: { id: config.photonProjectId },
        query: { pageSize: 100, ...(pageToken ? { pageToken } : {}) },
      });
      for (const a of page.assignments) if (a.handle === phone && !a.releasedAt) ids.push(a.assignmentId);
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.warn("Photon line lookup failed:", err instanceof ApiError ? `${err.status}` : err instanceof Error ? err.message : err);
    return false;
  }
  let ok = true;
  for (const id of ids) ok = (await releaseLine(id)) && ok;
  return ok;
}
