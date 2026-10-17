import "dotenv/config";

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Railway sets RAILWAY_PUBLIC_DOMAIN on deployed services; PUBLIC_BASE_URL overrides it.
  publicBaseUrl:
    process.env.PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "http://localhost:3000"),
  anthropicApiKey: optional("ANTHROPIC_API_KEY"),
  photonApiKey: optional("PHOTON_API_KEY"),
  photonProjectId: optional("PHOTON_PROJECT_ID"),
  photonPlatform: (process.env.PHOTON_PLATFORM ?? "imessage") as "imessage" | "sms" | "whatsapp" | "telegram",
  devInbound: process.env.DEV_INBOUND === "1",
  demoSeed: process.env.DEMO_SEED === "1",
  agentApiToken: optional("AGENT_API_TOKEN"),
  stripeSecretKey: optional("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: optional("STRIPE_WEBHOOK_SECRET"),
};

// Hard guard: we only ever run Stripe in test mode (AGENTS.md).
if (config.stripeSecretKey && !config.stripeSecretKey.startsWith("sk_test_")) {
  throw new Error("STRIPE_SECRET_KEY must be a test key (sk_test_...). Live keys are not allowed.");
}
