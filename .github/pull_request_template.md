## What

<!-- What changed, and which person's area (P1–P4) -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass
- [ ] No secrets, live keys, or real card data
- [ ] Money math stays in integer cents, in code (not the LLM)
- [ ] Demo path still works (if touched)

## VEYZL

<!-- Did the VEYZL check flag anything on this PR? -->
- [ ] VEYZL passed with no findings
- [ ] VEYZL flagged findings. Each one is fixed in its own commit ending with a `VEYZL: V-###` trailer and logged in `docs/veyzl.md`:
  - `V-###`: <finding> → <what changed>
