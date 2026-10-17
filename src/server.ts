import express from "express";
import { config } from "./config.js";
import { handleInbound } from "./messaging/inbound.js";
import { stripeWebhook } from "./payments/webhook.js";
import { webRoutes } from "./web/routes.js";

const app = express();

// Stripe needs the raw body for signature verification — mount before express.json().
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);

app.use(express.json());

// TODO(P1): verify PHOTON_WEBHOOK_SECRET and map Photon's payload to InboundMessage.
app.post("/webhooks/photon", async (req, res) => {
  try {
    await handleInbound(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("inbound failed:", err instanceof Error ? err.message : err);
    res.sendStatus(500);
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(webRoutes);

app.listen(config.port, () => {
  console.log(`Restock listening on ${config.publicBaseUrl}`);
});
