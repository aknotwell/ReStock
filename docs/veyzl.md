# VEYZL audit log

This is the evidence for the "Best Use of VEYZL" track: every VEYZL finding, and how it changed what we shipped. The process is in [AGENTS.md → Tracking VEYZL-driven changes](../AGENTS.md#tracking-veyzl-driven-changes-required-for-humans-and-agents). Owner: Person 4, but whoever fixes a finding logs it, in the same PR as the fix.

**Rules:**

- IDs are sequential (`V-001`, `V-002`, …). Claim the next free one.
- Every commit that fixes a finding ends with the trailer `VEYZL: V-###`.
- CI fails a PR whose tagged commits aren't logged here.

## What the judges want (keep all four true)

- [ ] **A working AI project.** The agent parses messages with Claude (`src/ai/`) and acts on them live.
- [ ] **A real VEYZL audit on the repo.** GitHub is connected, the VEYZL check runs on every PR, and its result is visible on the PR. VEYZL is a **required status check** on `main`, so a failing audit blocks the merge.
- [ ] **Evidence the findings changed the build.** Each entry below links the failing check run, the "before" commit, and the fix commit. A screenshot of a passing check isn't enough.
- [ ] **A short demo** that walks through one issue, the fix, and why it matters (see [Demo story](#demo-story)).

## Index

| ID | Status | Control / framework | Finding (one line) | PR | Failing check run | Fix commit(s) |
|---|---|---|---|---|---|---|
| <!-- V-001 --> | <!-- fixed / accepted / open --> | <!-- e.g. NIST AI RMF MANAGE-2.4 --> | | <!-- #12 --> | <!-- link to the VEYZL check run --> | <!-- abc1234 --> |

## Entries

<!--
Copy this template for each finding, newest at the bottom.

### V-###: <short title>

- **Status:** fixed | accepted | open
- **Found:** <date/time>, PR #<n>, by <who / which agent>
- **Control:** <EU AI Act / NIST AI RMF / ISO/IEC 42001 reference, as VEYZL reported it>
- **Check run:** <link to the failing VEYZL check on the PR> → <link to the passing re-run>
- **What VEYZL said:** <paste or summarize the finding>
- **Before:** <commit sha> — <what the code did>
- **After:** <commit sha(s)> — <what we changed>
- **Why it matters:** <user/trust impact, in one or two sentences, for the pitch>
- **Demo-worthy:** yes | no
-->

## Demo story

Pick the best `Demo-worthy: yes` entry and fill this in before judging. It should take about 60 seconds.

1. **The issue:** what the agent did before, and the VEYZL finding (show the failing check on the PR).
2. **The fix:** the diff in the fix commit (`git show <sha>`).
3. **Why it matters:** the risk to a real household (money, privacy, oversight), and the control it maps to.
4. **Proof:** the passing re-run on the same PR, and the merge that was blocked until it passed.

Likely candidates in Restock: charging without explicit human confirmation, unvalidated LLM output changing the cart, card numbers or phone numbers reaching the LLM or logs, and the agent not saying it's an AI.
