// Owner: Person 1. Giving people a Restock iMessage number: Photon "shared line assignments".
// Photon's shared lines only accept texts from assigned handles, so web sign-up assigns the person's phone
// to a pooled line and shows them which Restock number to text. Without Photon keys (tests, local dev) it
// hands out a fixed fake number so the rest of the flow still runs.
import { randomUUID } from "node:crypto";
import { ApiError, Photon } from "@photon-ai/api";
import { config } from "../config.js";

export type LineAssignment = { assignmentId: string; line: string }; // line: the Restock number to text, E.164

export class LineUnavailableError extends Error {}

const photon =
  config.photonApiKey && config.photonProjectId
    ? new Photon({ headers: { Authorization: `Bearer ${config.photonApiKey}` } })
    : undefined;

export const CONSOLE_LINE = "+16285550100"; // used only when Photon isn't configured

type Assignment = { assignmentId: string; assignedPhoneNumber: string; handle: string; releasedAt?: string | undefined };
const toLine = (a: Assignment): LineAssignment => ({ assignmentId: a.assignmentId, line: a.assignedPhoneNumber });
const problemCode = (err: ApiError) => (err.body as { code?: unknown } | undefined)?.code;

/**
 * Give this phone a Restock number it can text. Never returns a released assignment: Photon answers texts
 * to one of those with its own "not connected to an agent yet" reply, and Restock never sees them.
 */
export async function assignLine(phone: string, firstName: string, idempotencyKey: string): Promise<LineAssignment> {
  if (!photon || !config.photonProjectId) return { assignmentId: `console-${phone}`, line: CONSOLE_LINE };
  const projectId = config.photonProjectId;
  const create = (key: string) =>
    photon.projects.platforms.imessage.assignments.create({ path: { id: projectId }, headers: { idempotencyKey: key }, body: { handle: phone, firstName } });
  try {
    let a = await create(idempotencyKey);
    // A key Photon has seen before replays its first answer, even if that assignment was released since.
    if (a.releasedAt) a = await create(`${idempotencyKey}:${randomUUID()}`);
    if (a.releasedAt) throw new LineUnavailableError("Restock couldn't set up a number for you right now. Please try again in a minute.");
    return toLine(a);
  } catch (err) {
    if (err instanceof ApiError && problemCode(err) === "ASSIGNMENT_EXISTS") {
      // This phone already has a live Restock number (from an earlier sign-up we lost track of, or one added
      // in the Photon dashboard). Use it: a second number would be refused anyway.
      const existing = await activeAssignmentFor(phone).catch(() => undefined);
      if (existing) return toLine(existing);
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

/**
 * Is this assignment still live in Photon? Checked before showing someone a number we saved earlier. Only a
 * clear "released" or "not found" counts as gone; if Photon can't be reached we keep the saved number.
 */
export async function isLineActive(assignmentId: string): Promise<boolean> {
  if (!photon || !config.photonProjectId || assignmentId.startsWith("console-")) return true;
  try {
    const a = await photon.projects.platforms.imessage.assignments.get({ path: { id: config.photonProjectId, assignmentId } });
    return !a.releasedAt;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    console.warn("Photon line check failed:", err instanceof ApiError ? `${err.status}` : err instanceof Error ? err.message : err);
    return true;
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
