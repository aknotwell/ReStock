import express from "express";
import { randomUUID } from "node:crypto";
import { attachDemoCards } from "../scripts/demoCards.js";
import { seedDemo } from "../scripts/seed.js";
import { anthropic, MODEL } from "./ai/client.js";
import { config } from "./config.js";
import { openDatabase, saveNow, startAutosave } from "./core/persist.js";
import { handleInbound } from "./messaging/inbound.js";
import { rememberInbound, startPolling, type InboundMessage } from "./messaging/photon.js";
import { stripeWebhook } from "./payments/webhook.js";
import { agentApi, agentApiInfo } from "./web/agentApi.js";
import { rateLimiter } from "./web/rateLimit.js";
import { sweepExpiredSignups } from "./core/signups.js";
import { retryCustomerDeletions } from "./payments/deleteCustomer.js";

const agentLimit = rateLimiter(60, 60 * 1000);
import { webRoutes } from "./web/routes.js";

// Load saved data before anything else touches the store.
const restored = config.databasePath ? openDatabase(config.databasePath) : false;
if (config.databasePath) {
  console.log(restored ? `Restored saved data from ${config.databasePath}` : `Saving data to ${config.databasePath}`);
} else {
  console.warn("DATABASE_PATH is not set: data lives in memory only and is lost on restart.");
}

// Don't overwrite a saved household with a fresh seed unless asked (DEMO_RESET=1).
if (config.demoSeed && (!restored || config.demoReset)) {
  const h = seedDemo();
  console.log(`Seeded demo household ${h.id} (${h.members.map((m) => m.name).join(", ")})`);
  await attachDemoCards(h); // real sandbox cards for Sam and Jake when a Stripe test key is set
}
saveNow();
startAutosave();

const app = express();
app.set("trust proxy", 1); // Railway sits behind one proxy: use the real client IP for rate limits

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
  console.warn("DEV_INBOUND=1: POST /dev/inbound is enabled. Never enable this on a public deploy.");
}

// The same audit pipeline at every path an audit tool might use (VEYZL only takes a base URL).
for (const path of ["/api/agent", "/v1/chat/completions", "/chat/completions", "/v1/messages", "/"]) {
  // Public and it spends Claude credits: limit each IP (a full VEYZL audit is ~15 requests).
  app.post(path, (req, res, next) => (agentLimit(req.ip ?? "unknown") ? next() : res.status(429).json({ error: "Too many requests. Try again in a minute." })), agentApi);
}
app.get(["/api/agent", "/v1/chat/completions"], agentApiInfo);

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(webRoutes);

app.listen(config.port, () => {
  console.log(`Restock listening on ${config.publicBaseUrl}`);
  console.log(anthropic ? `Claude AI: on (${MODEL})` : "Claude AI: off (ANTHROPIC_API_KEY not set), so the command parser handles every message");
  startPolling(handleInbound);
  // Sign-ups that never texted "hi" give their Photon seat back.
  // Deletions that Stripe couldn't take the first time are retried on the same timer.
  setInterval(() => {
    void sweepExpiredSignups().catch((err) => console.warn("sign-up sweep failed:", err));
    void retryCustomerDeletions().catch((err) => console.warn("Stripe deletion retry failed:", err));
  }, 10 * 60 * 1000).unref();
});
