// Sign-up must never show a Restock number Photon no longer links to the phone. Texts to a released
// assignment get Photon's own "not connected to an agent yet" reply and never reach Restock.
import { beforeEach, describe, expect, it, vi } from "vitest";

const assignments = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), list: vi.fn(), release: vi.fn() }));
vi.mock("../src/config.js", async (orig) => {
  const real = (await orig<{ config: object }>()).config;
  return { config: { ...real, photonApiKey: "pho_sk_test", photonProjectId: "pho_prj_test" } };
});
vi.mock("@photon-ai/api", async (orig) => ({
  ...(await orig<object>()),
  Photon: class {
    projects = { platforms: { imessage: { assignments } } };
  },
}));

import { ApiError } from "@photon-ai/api";
import { assignLine, isLineActive } from "../src/messaging/photonLines.js";

const PHONE = "+14255550102";
const row = (id: string, line: string, releasedAt?: string) => ({ assignmentId: id, assignedPhoneNumber: line, handle: PHONE, ...(releasedAt ? { releasedAt } : {}) });
const apiError = (status: number, code: string) =>
  new ApiError(code, { status, headers: new Headers(), body: { code, status } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("assignLine", () => {
  it("returns the new assignment", async () => {
    assignments.create.mockResolvedValueOnce(row("asg_1", "+16285550111"));
    expect(await assignLine(PHONE, "Amber", "k1")).toEqual({ assignmentId: "asg_1", line: "+16285550111" });
  });

  it("a replayed key that returns a released assignment gets a fresh one instead", async () => {
    assignments.create
      .mockResolvedValueOnce(row("asg_old", "+16285550111", "2026-10-16T00:00:00Z"))
      .mockResolvedValueOnce(row("asg_new", "+16285550122"));
    expect(await assignLine(PHONE, "Amber", "k1")).toEqual({ assignmentId: "asg_new", line: "+16285550122" });
    const keys = assignments.create.mock.calls.map(([input]) => (input as { headers: { idempotencyKey: string } }).headers.idempotencyKey);
    expect(keys[0]).toBe("k1");
    expect(keys[1]).not.toBe("k1");
  });

  it("a phone that already has a live assignment reuses it instead of failing", async () => {
    assignments.create.mockRejectedValueOnce(apiError(409, "ASSIGNMENT_EXISTS"));
    assignments.list.mockResolvedValueOnce({ assignments: [row("asg_gone", "+16285550100", "2026-10-01T00:00:00Z"), row("asg_live", "+16285550133")] });
    expect(await assignLine(PHONE, "Amber", "k1")).toEqual({ assignmentId: "asg_live", line: "+16285550133" });
  });

  it("other Photon errors still show a friendly message", async () => {
    assignments.create.mockRejectedValueOnce(apiError(503, "SHARED_LINE_POOL_EXHAUSTED"));
    await expect(assignLine(PHONE, "Amber", "k1")).rejects.toThrow(/couldn't set up a number/);
  });
});

describe("isLineActive", () => {
  it("is false for a released or missing assignment", async () => {
    assignments.get.mockResolvedValueOnce(row("asg_1", "+16285550111", "2026-10-16T00:00:00Z"));
    expect(await isLineActive("asg_1")).toBe(false);
    assignments.get.mockRejectedValueOnce(apiError(404, "ASSIGNMENT_NOT_FOUND"));
    expect(await isLineActive("asg_1")).toBe(false);
  });

  it("is true for a live one, and when Photon can't be reached (keep the saved number)", async () => {
    assignments.get.mockResolvedValueOnce(row("asg_1", "+16285550111"));
    expect(await isLineActive("asg_1")).toBe(true);
    assignments.get.mockRejectedValueOnce(apiError(503, "UPSTREAM_UNAVAILABLE"));
    expect(await isLineActive("asg_1")).toBe(true);
  });
});
