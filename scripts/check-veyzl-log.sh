#!/usr/bin/env bash
# Fails if any commit in BASE..HEAD carries a `VEYZL: V-###` trailer that has no
# matching `### V-###` entry in docs/veyzl.md. See AGENTS.md → Tracking VEYZL-driven changes.
# Usage: scripts/check-veyzl-log.sh [base-ref]   (default: origin/main)
set -euo pipefail

base="${1:-origin/main}"
log="docs/veyzl.md"

ids=$(git log --format='%(trailers:key=VEYZL,valueonly)' "$base"..HEAD | tr ',' '\n' | tr -d ' ' | grep -E '^V-[0-9]{3}$' | sort -u || true)

if [ -z "$ids" ]; then
  echo "No VEYZL-tagged commits in $base..HEAD."
  exit 0
fi

missing=0
for id in $ids; do
  if grep -qE "^### ${id}:" "$log"; then
    echo "ok: $id is logged in $log"
  else
    echo "::error file=$log::$id is tagged in a commit but has no '### $id:' entry in $log"
    missing=1
  fi
done

bad=$(git log --format='%(trailers:key=VEYZL,valueonly)' "$base"..HEAD | tr ',' '\n' | tr -d ' ' | grep -v '^$' | grep -vE '^V-[0-9]{3}$' || true)
if [ -n "$bad" ]; then
  echo "::error::Malformed VEYZL trailer value(s): $bad (expected V-###)"
  missing=1
fi

exit $missing
