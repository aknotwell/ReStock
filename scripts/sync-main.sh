#!/usr/bin/env bash
# Keep the local checkout current with merged PRs. Run by Claude Code hooks (.claude/settings.json)
# at session start and before each prompt; safe to run by hand too.
#
# - Always fetches origin (throttled to once per 60s, except at session start).
# - Fast-forwards local `main` to origin/main, but only when that's a pure fast-forward.
# - If you're ON main with a clean tree, updates the working tree too.
# - Never merges, rebases, stashes, or touches a feature branch or uncommitted work.
# Prints one short line only when something changed or needs attention (Claude sees it as context).
set -u

repo=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$repo" || exit 0

stamp="$(git rev-parse --git-common-dir)/restock-last-sync"
if [ "${1:-}" != "--force" ] && [ -f "$stamp" ] && [ $(( $(date +%s) - $(cat "$stamp" 2>/dev/null || echo 0) )) -lt 60 ]; then
  exit 0
fi
date +%s > "$stamp"

git fetch --quiet --prune origin 2>/dev/null || exit 0
git rev-parse --verify --quiet origin/main >/dev/null || exit 0

branch=$(git branch --show-current)
before=$(git rev-parse --verify --quiet main || echo none)
after=$(git rev-parse origin/main)
[ "$before" = "$after" ] && behind_msg="" || behind_msg="yes"

if [ "$branch" = "main" ]; then
  if [ -n "$behind_msg" ]; then
    if [ -z "$(git status --porcelain --untracked-files=no)" ] && git merge --ff-only --quiet origin/main 2>/dev/null; then
      echo "Synced main to origin/main ($(git log --oneline "$before..$after" | wc -l | tr -d ' ') new commit(s) from merged PRs)."
    else
      echo "origin/main has new merged commits, but local main couldn't fast-forward (uncommitted changes or diverged history). Not touched."
    fi
  fi
else
  # Update the local main ref without checking it out (only if it's a fast-forward).
  if [ -n "$behind_msg" ] && { [ "$before" = none ] || git merge-base --is-ancestor main origin/main; }; then
    git update-ref refs/heads/main "$after" 2>/dev/null
    echo "Updated local main to origin/main. You're on '$branch'; it's $(git rev-list --count "$branch..origin/main") commit(s) behind main (not rebased automatically)."
  fi
fi
exit 0
