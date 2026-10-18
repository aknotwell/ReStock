import express from "express";
import { randomUUID } from "node:crypto";
import { attachDemoCards } from "../scripts/demoCards.js";
import { seedDemo } from "../scripts/seed.js";
import { config } from "./config.js";
import { handleInbound } from "./messaging/inbound.js";
import { rememberInbound, startPolling, type InboundMessage } from "./messaging/photon.js";
import { stripeWebhook } from "./payments/webhook.js";
import { agentApi, agentApiInfo } from "./web/agentApi.js";
import { devChat } from "./web/devChat.js";
import { webRoutes } from "./web/routes.js";

if (config.demoSeed) {
  const h = seedDemo();
  console.log(`Seeded demo household ${h.id} (${h.members.map((m) => m.name).join(", ")})`);
  await attachDemoCards(h); // real sandbox cards for Sam and Jake when a Stripe test key is set
}

const app = express();

// Stripe needs the raw body for signature verification — mount before express.json().
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);

app.use(express.json());

// Local simulator: pretend a text arrived, without Photon. Off unless DEV_INBOUND=1 — it is unauthenticated.
if (config.devInbound) {
  app.post("/dev/inbound", async (req, res) => {
    const body = req.body as Partial<InboundMessage>;
    if (!body.fromPhone || !body.text) {
      res.status(400).json({ error: "fromPhone and text are required" });
      return;
    }
    const msg: InboundMessage = {
      messageId: body.messageId ?? randomUUID(),
      spaceId: body.spaceId ?? "dev-group",
      spaceKind: body.spaceKind ?? "group",
      fromPhone: body.fromPhone,
      text: body.text,
      agentUserId: body.agentUserId ?? "dev-agent",
    };
    rememberInbound(msg);
    await handleInbound(msg);
    res.sendStatus(200);
  });
  app.use(devChat); // dashboard "Test chat" tab: /dev/state, /dev/chat, /dev/reset
  console.warn("DEV_INBOUND=1: POST /dev/inbound is enabled. Never enable this on a public deploy.");
}

// The same audit pipeline at every path an audit tool might use (VEYZL only takes a base URL).
for (const path of ["/api/agent", "/v1/chat/completions", "/chat/completions", "/v1/messages", "/"]) {
  app.post(path, agentApi);
}
app.get(["/api/agent", "/v1/chat/completions"], agentApiInfo);

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(webRoutes);

app.listen(config.port, () => {
  console.log(`Restock listening on ${config.publicBaseUrl}`);
  startPolling(handleInbound);
});
