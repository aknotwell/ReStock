import express from "express";
import { config } from "./config.js";
import { photonWebhook } from "./messaging/webhook.js";
import { stripeWebhook } from "./payments/webhook.js";
import { webRoutes } from "./web/routes.js";

const app = express();

// Stripe needs the raw body for signature verification — mount before express.json().
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);

// Signature verification must receive the original bytes, before any JSON parser.
app.post("/webhooks/photon", express.raw({ type: "*/*", limit: "64kb" }), photonWebhook);
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(webRoutes);

app.listen(config.port, () => {
  console.log(`Restock listening on ${config.publicBaseUrl}`);
});
