import { defineConfig } from "vitest/config";

// Tests are hermetic: a developer's .env must never make tests call real services (Photon would send
// real texts; Stripe would create test-mode objects) or change results (real demo phone numbers).
// Set RUN_MODEL_TESTS=1 (npm run test:probes, or the veyzl-probes CI job) to let ANTHROPIC_API_KEY through
// for the model-backed probes. Photon, Stripe and demo identities are always blanked.
const BLANKED = [
  "PHOTON_API_KEY",
  "PHOTON_PROJECT_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "DEMO_PHONE_SAM",
  "DEMO_PHONE_JAKE",
  "DEMO_PHONE_PRIYA",
  "DEMO_GROUP_SPACE_ID",
  "AGENT_API_TOKEN",
  "DEV_INBOUND",
];

const hermetic: Record<string, string> = {
  ...Object.fromEntries(BLANKED.map((k) => [k, ""])),
  PUBLIC_BASE_URL: "http://localhost:3000", // links in test output must be absolute and local
};

export default defineConfig({
  test: {
    env: process.env.RUN_MODEL_TESTS === "1" ? hermetic : { ...hermetic, ANTHROPIC_API_KEY: "" },
  },
});
