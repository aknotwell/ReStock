// A text is marked seen only after it is handled, so a failure can be retried without skipping it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlePolledItem, pollCursor, resetPollDelivery, type InboundMessage } from "../src/messaging/photon.js";

const msg = (id: string): InboundMessage => ({
  messageId: id,
  spaceId: "dm",
  spaceKind: "direct",
  fromPhone: "+15550000001",
  text: "hi",
});

beforeEach(() => {
  resetPollDelivery();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Photon polling", () => {
  it("keeps a failed text unseen until the third try", async () => {
    const seen = new Set<string>();
    const cursor = { since: "2026-10-01T00:00:00.000Z" };
    const item = { id: "m1", createdAt: "2026-10-01T00:01:00.000Z", msg: msg("m1") };
    const fail = async () => {
      throw new Error("boom");
    };

    await expect(handlePolledItem(item, fail, seen, cursor)).resolves.toBe("retry");
    expect(seen.has("m1")).toBe(false);
    expect(cursor.since).toBe("2026-10-01T00:00:00.000Z");
    expect(pollCursor().seen).not.toContain("m1");
    expect(pollCursor().since).toBe("");

    await expect(handlePolledItem(item, fail, seen, cursor)).resolves.toBe("retry");
    expect(seen.has("m1")).toBe(false);
    expect(cursor.since).toBe("2026-10-01T00:00:00.000Z");

    await expect(handlePolledItem(item, fail, seen, cursor)).resolves.toBe("ok");
    expect(seen.has("m1")).toBe(true);
    expect(cursor.since).toBe(item.createdAt);
    expect(pollCursor().seen).toContain("m1");
    expect(pollCursor().since).toBe(item.createdAt);
  });

  it("marks a non-text seen without calling the handler", async () => {
    const seen = new Set<string>();
    const cursor = { since: "2026-10-01T00:00:00.000Z" };
    const run = vi.fn(async () => {});
    await expect(
      handlePolledItem({ id: "m2", createdAt: "2026-10-01T00:02:00.000Z", msg: undefined }, run, seen, cursor),
    ).resolves.toBe("ok");
    expect(run).not.toHaveBeenCalled();
    expect(seen.has("m2")).toBe(true);
    expect(cursor.since).toBe("2026-10-01T00:02:00.000Z");
  });
});
