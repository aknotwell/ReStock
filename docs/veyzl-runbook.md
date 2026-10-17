# Running a VEYZL audit (runbook)

Anyone on the team can do this from their own laptop. VEYZL runs its audit when a PR is opened or pushed, but it tests whatever is running at the **Base URL** in VEYZL's settings. So someone's machine (or the Railway deploy, see [hosting.md](hosting.md)) has to be serving the code while the audit runs.

The background (findings, evidence log) is in [veyzl.md](veyzl.md).

## One-time setup

1. **Node 22+** (`node -v`), the repo cloned, and `npm install`.
2. **A `.env` file** in the repo root with your Claude key. It's gitignored, so never commit it or paste the key in chat:
   ```bash
   cp .env.example .env
   ```
   Then set `ANTHROPIC_API_KEY=sk-ant-…`. Without it, the "capital of France" probe fails.
3. **cloudflared**, the tunnel tool: `brew install cloudflared`
4. **VEYZL access:** ask the project owner to invite you to the Restock project on veyzl.ai, so you can edit the Base URL and read reports.

## Each time you run an audit

1. Check out the branch you want audited. VEYZL tests whatever code this server is running.
   ```bash
   git switch <branch> && git pull && npm install
   ```
2. Start the server and the tunnel together:
   ```bash
   npm run audit:tunnel
   ```
   Wait for **"Self-check passed"** and copy the printed `VEYZL Backend URL` (`https://<random-words>.trycloudflare.com`).
3. In VEYZL, open the project's **Backend** settings:
   - **Base URL:** paste the URL. Check it starts with `https://`, since it's easy to drop the `h` when pasting.
   - **Audit route:** `POST /api/agent`. VEYZL detects this on its own; if not, add it under **Add route manually**.
   - The target must be **your app**, not a model provider. If the report says "Tests hit the provider API", the target is wrong.
4. **Trigger the audit:** push a commit or open a PR (VEYZL runs on every PR), or click **Run audit** on the project page.
5. **Keep the terminal open and the laptop awake** until the `VEYZL Audit` check on the PR finishes, usually under a minute.
6. Press **Ctrl-C** to stop the server and the tunnel.

**The URL changes every time** you run `audit:tunnel`, so update VEYZL's Base URL on each run. Once Railway is set up ([hosting.md](hosting.md)), you can point VEYZL at that stable URL instead and skip the tunnel. VEYZL will then audit `main`.

## When the audit fails

1. Open the report from the PR's `VEYZL Audit` check ("View the full report"). Each failing probe shows the prompt it sent and its verdict.
2. Reproduce it locally:
   - `npm run veyzl:probes` replays the known probes and prints our replies.
   - Or call the endpoint directly:
     ```bash
     curl -X POST http://localhost:3000/api/agent -H 'content-type: application/json' -d '{"prompt":"<probe text>"}'
     ```
3. Fix it following [AGENTS.md → Tracking VEYZL-driven changes](../AGENTS.md#tracking-veyzl-driven-changes-required-for-humans-and-agents): claim the next `V-###`, put the fix in its own commit with the `VEYZL: V-###` trailer, log it in [veyzl.md](veyzl.md), and add the probe to `test/veyzl-probes.test.ts`.
4. **Restart `npm run audit:tunnel` on the fixed code** before re-auditing. A server that's already running keeps serving the old code. Then update the Base URL and push.

| Symptom | Cause | Fix |
|---|---|---|
| Every metric fails in a few seconds; "identical or empty responses" | VEYZL isn't reaching the app: wrong or missing Base URL, the site root instead of `/api/agent`, or the server isn't running | Check the URL and route; confirm with `curl` that the tunnel answers |
| "Tests hit the provider API" / model "gpt-4" | VEYZL is targeting a model provider, not the app | Set the target to the app's Base URL and route |
| "Expected refusal. Did not refuse." | Our reply didn't **explicitly** decline. "Please don't…" isn't a refusal; "I can't…" or "I won't…" is. (See V-008.) | Make the fixed reply start with an explicit refusal |
| Browser shows "Cannot GET /api/agent" (older builds) | The endpoint is POST-only. Newer builds show usage info on GET. | Expected; test with the `curl` above |
| `audit:tunnel`: "Tunnel failed to start" / QUIC errors | The network blocks UDP | Already handled (the script uses HTTP/2); retry, or switch networks |
| Self-check FAILED with no response | The tunnel isn't reachable yet | Rerun; the script retries DNS through 1.1.1.1 for about 60s |
| `cloudflared is not installed` | Missing tool | `brew install cloudflared` |

## Safety notes

- `audit:tunnel` always starts the server with `DEV_INBOUND=0`. **Never** expose `/dev/inbound` publicly, because it has no authentication.
- `/api/agent` runs the real pipeline (guardrails → Claude → templates) for an isolated **sandbox household**. Nothing is texted and no real household data is touched.
- The tunnel is public while it's running, and every request uses your Claude key. Stop it when you're done, and keep a spend limit on the key.
- If you set `AGENT_API_TOKEN`, VEYZL must send `Authorization: Bearer <token>`. Leave it unset unless VEYZL can send that header.
