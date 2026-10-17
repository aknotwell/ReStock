import { defineConfig } from "vitest/config";

// Tests are hermetic by default: a developer's .env key must not change results or spend credits.
// Set RUN_MODEL_TESTS=1 (npm run test:probes, or the veyzl-probes CI job) to let the real
// ANTHROPIC_API_KEY through for the model-backed probes.
export default defineConfig({
  test: {
    env: process.env.RUN_MODEL_TESTS === "1" ? {} : { ANTHROPIC_API_KEY: "" },
  },
});
