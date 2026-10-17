import "dotenv/config";

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
  anthropicApiKey: optional("ANTHROPIC_API_KEY"),
  photonApiKey: optional("PHOTON_API_KEY"),
  photonWebhookSecret: optional("PHOTON_WEBHOOK_SECRET"),
  stripeSecretKey: optional("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: optional("STRIPE_WEBHOOK_SECRET"),
};

// Hard guard: we only ever run Stripe in test mode (AGENTS.md).
if (config.stripeSecretKey && !config.stripeSecretKey.startsWith("sk_test_")) {
  throw new Error("STRIPE_SECRET_KEY must be a test key (sk_test_...). Live keys are not allowed.");
}
