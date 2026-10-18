// Owner: Person 1. Giving people a Restock iMessage number: Photon "shared line assignments".
// Photon's shared lines only accept texts from assigned handles, so web sign-up assigns the person's phone
// to a pooled line and shows them which Restock number to text. Without Photon keys (tests, local dev) it
// hands out a fixed fake number so the rest of the flow still runs.
import { ApiError, Photon } from "@photon-ai/api";
import { config } from "../config.js";

export type LineAssignment = { assignmentId: string; line: string }; // line: the Restock number to text, E.164

export class LineUnavailableError extends Error {}

const photon =
  config.photonApiKey && config.photonProjectId
    ? new Photon({ headers: { Authorization: `Bearer ${config.photonApiKey}` } })
    : undefined;

export const CONSOLE_LINE = "+16285550100"; // used only when Photon isn't configured

export async function assignLine(phone: string, firstName: string, idempotencyKey: string): Promise<LineAssignment> {
  if (!photon || !config.photonProjectId) return { assignmentId: `console-${phone}`, line: CONSOLE_LINE };
  try {
    const a = await photon.projects.platforms.imessage.assignments.create({
      path: { id: config.photonProjectId },
      headers: { idempotencyKey },
      body: { handle: phone, firstName },
    });
    return { assignmentId: a.assignmentId, line: a.assignedPhoneNumber };
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Photon line assignment failed: ${err.status} (request ${err.requestId ?? "unknown"})`);
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
