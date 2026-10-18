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
  /** Re-seed the demo household even if the database already has one. */
  demoReset: process.env.DEMO_RESET === "1",
  // SQLite file for the store. Railway sets RAILWAY_VOLUME_MOUNT_PATH when a volume is attached.
  // Unset = in-memory only (tests and quick local runs).
  databasePath:
    optional("DATABASE_PATH") ??
    (process.env.RAILWAY_VOLUME_MOUNT_PATH ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/restock.db` : undefined),
  agentApiToken: optional("AGENT_API_TOKEN"),
  stripeSecretKey: optional("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: optional("STRIPE_WEBHOOK_SECRET"),
  // Live store prices for "Which one?" options (src/deals/live.ts). Unset = catalog prices only.
  serpapiKey: optional("SERPAPI_KEY"),
  /** SerpApi location for local prices, e.g. "Seattle, Washington, United States". */
  dealsLocation: optional("DEALS_LOCATION"),
  /** Most live searches per day, so a loop can't spend the free monthly quota (250 searches). */
  dealsDailyLimit: Number(process.env.DEALS_DAILY_LIMIT ?? 25),
  /** 1 = show listings from any seller, not just the major retailers we recognize. */
  dealsAnyStore: process.env.DEALS_ANY_STORE === "1",
};

// Hard guard: we only ever run Stripe in test mode (AGENTS.md).
if (config.stripeSecretKey && !config.stripeSecretKey.startsWith("sk_test_")) {
  throw new Error("STRIPE_SECRET_KEY must be a test key (sk_test_...). Live keys are not allowed.");
}
