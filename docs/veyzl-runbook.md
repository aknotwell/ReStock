# Running a VEYZL audit (runbook)

VEYZL audits run on their own, from GitHub, for anyone on the team. Every PR push triggers an audit against the **Railway deploy of `main`**. Nobody's laptop needs to be on.

The background (findings, evidence log) is in [veyzl.md](veyzl.md). Hosting is covered in [hosting.md](hosting.md).

## How it works

| Check | Runs on | Tests |
|---|---|---|
| **VEYZL Audit** (VEYZL's GitHub App) | Every PR push | Whatever is deployed at the Base URL: `https://restock-production-daab.up.railway.app`, `POST /api/agent`. That's **`main`**, not the PR. |
| **`veyzl-probes`** (our CI) | Every PR push | VEYZL's probes against **the PR's own code**, through `POST /api/agent`. |

So a PR's code is checked by `veyzl-probes` before merge, and by VEYZL once it's merged and deployed (Railway redeploys `main` automatically).

## VEYZL settings (one-time, already done)

In the VEYZL project's **Backend** settings:
- **Base URL:** `https://restock-production-daab.up.railway.app`. Check it starts with `https://`.
- **Audit route:** `POST /api/agent`.
- **Target:** your app, not a model provider. If a report says "Tests hit the provider API", the target is wrong.

To edit settings or read reports, ask the project owner to invite you to the Restock project on veyzl.ai.

## Re-running an audit

- Push a commit to any open PR, or click **Run audit** on the VEYZL project page.
- After merging a fix, wait for Railway to finish deploying `main` (check `https://restock-production-daab.up.railway.app/health`), then re-run. Until the deploy finishes, VEYZL is still testing the old code.

## When the audit fails

1. Open the report from the PR's `VEYZL Audit` check ("View the full report"). Each failing probe shows the prompt and the verdict.
2. Reproduce it:
   - Locally: `npm run veyzl:probes` replays the known probes, or run `npm run dev` and `curl -X POST http://localhost:3000/api/agent -H 'content-type: application/json' -d '{"prompt":"<probe text>"}'`.
   - Against the deploy: the same `curl` with `https://restock-production-daab.up.railway.app/api/agent`.
3. Fix it following [AGENTS.md → Tracking VEYZL-driven changes](../AGENTS.md#tracking-veyzl-driven-changes-required-for-humans-and-agents): claim the next `V-###`, put the fix in its own commit with the `VEYZL: V-###` trailer, log it in [veyzl.md](veyzl.md), and add the probe to `test/veyzl-probes.test.ts`.
4. Merge, wait for the Railway deploy, then re-run the audit and add the passing link to the log entry.

| Symptom | Cause | Fix |
|---|---|---|
| Every metric fails in a few seconds; "identical or empty responses" | VEYZL can't reach the app: the deploy is down, or the Base URL or route is wrong | Check `/health` on Railway, and the Base URL and route in VEYZL |
| "Tests hit the provider API" / model "gpt-4" | VEYZL is targeting a model provider | Set the target to the app's Base URL and route |
| "Expected refusal. Did not refuse." | Our reply didn't **explicitly** decline. "Please don't…" isn't a refusal; "I can't…" or "I won't…" is. (See V-008.) | Make the fixed reply start with an explicit refusal |
| Model-backed probes fail ("capital of France") | `GEMINI_API_KEY` is missing on Railway, or the free-tier quota ran out (deploy log shows `429 RESOURCE_EXHAUSTED`) | Add it under the Railway service's **Variables** |
| A fix is merged but the audit still fails the same way | Railway hasn't redeployed yet | Wait for the deploy, then re-run |

## Safety notes

- Never set `DEV_INBOUND` on Railway. That route has no authentication.
- `/api/agent` uses an isolated **sandbox household**. Nothing is texted and no real household data is touched.
- The deploy is public, and every request uses the Gemini key set on Railway. The free tier has no bill, but its per-minute and daily quota is shared by every caller.
