import type { RequestHandler } from "express";
import { handleInbound } from "./inbound.js";
import { normalizePhotonMessage, photonConnection, rememberSpace } from "./photon.js";

export const photonWebhook: RequestHandler = async (req, res) => {
  if (!process.env.SPECTRUM_PROJECT_ID || !process.env.SPECTRUM_PROJECT_SECRET || !process.env.SPECTRUM_WEBHOOK_SECRET) {
    res.status(503).json({ error: "Photon is not configured" }); return;
  }
  if (!Buffer.isBuffer(req.body)) { res.sendStatus(400); return; }
  // Accept only native signed Spectrum deliveries, not unauthenticated normalized JSON.
  if (typeof req.headers["x-spectrum-signature"] !== "string" || typeof req.headers["x-spectrum-timestamp"] !== "string") {
    res.sendStatus(401); return;
  }
  try {
    const { app } = await photonConnection();
    const headers = Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const result = await app.webhook({ body: req.body, headers }, async (space, message) => {
      const normalized = normalizePhotonMessage(space, message);
      if (!normalized) return;
      rememberSpace(space);
      try { await handleInbound(normalized); }
      catch { console.error("Photon reply delivery failed; pending replies retained in memory."); }
    });
    res.status(result.status).set(result.headers).send(Buffer.from(result.body));
  } catch {
    // Do not log SDK errors: they can contain request data or credentials.
    console.error("Photon webhook processing failed.");
    res.sendStatus(503);
  }
};
