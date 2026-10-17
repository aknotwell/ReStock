import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { normalizePhotonMessage } from "../src/messaging/photon.js";
import { photonWebhook } from "../src/messaging/webhook.js";

const incoming = { id: "message", direction: "inbound" as const, platform: "imessage", sender: { id: "+15550000001", __platform: "imessage" }, content: { type: "text" as const, text: "add dish soap" } };
afterEach(() => vi.unstubAllEnvs());
describe("Photon boundary", () => {
  it("maps a verified message to the application contract", () => {
    expect(normalizePhotonMessage({ id: "group" }, incoming)).toEqual({ id: "message", groupChatId: "group", fromPhone: "+15550000001", text: "add dish soap" });
  });
  it("ignores outbound echoes, bot senders and missing sender identity", () => {
    expect(normalizePhotonMessage({ id: "group" }, { ...incoming, direction: "outbound" })).toBeUndefined();
    expect(normalizePhotonMessage({ id: "group" }, { ...incoming, sender: { ...incoming.sender, kind: "agent" } })).toBeUndefined();
    expect(normalizePhotonMessage({ id: "group" }, { ...incoming, sender: undefined })).toBeUndefined();
    expect(normalizePhotonMessage({ id: "group" }, { ...incoming, sender: { ...incoming.sender, id: "not-a-phone" } })).toBeUndefined();
  });
  it("rejects unsigned requests before connecting to Photon", async () => {
    vi.stubEnv("SPECTRUM_PROJECT_ID", "test-project");
    vi.stubEnv("SPECTRUM_PROJECT_SECRET", "test-only-placeholder");
    vi.stubEnv("SPECTRUM_WEBHOOK_SECRET", "test-only-placeholder");
    const res = { sendStatus: vi.fn() };
    await photonWebhook({ body: Buffer.from("{}"), headers: {} } as Request, res as unknown as Response, vi.fn());
    expect(res.sendStatus).toHaveBeenCalledWith(401);
  });
  it("fails closed when unconfigured", async () => {
    vi.stubEnv("SPECTRUM_PROJECT_ID", "");
    const json = vi.fn(); const res = { status: vi.fn(() => ({ json })) };
    await photonWebhook({ body: Buffer.from("{}"), headers: {} } as Request, res as unknown as Response, vi.fn());
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
