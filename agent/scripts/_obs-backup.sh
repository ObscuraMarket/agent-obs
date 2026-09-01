#!/bin/bash
# Snapshot OBS's memory and action ledgers into his PRIVATE memory repo so
# they survive this machine WITHOUT being public. Self-throttles to ~once a
# day (FORCE=1 overrides).
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
AGENT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${OBS_DATA_DIR:-$AGENT/data}"
MEM="${OBS_MEMORY_REPO_DIR:-}"
STAMP="$HOME/.obs-backup-stamp"

if [ -z "$MEM" ] || [ ! -d "$MEM/.git" ]; then
  echo "obs memory: no private memory checkout configured (OBS_MEMORY_REPO_DIR), skipping backup"
  exit 0
fi
if [ "$FORCE" != "1" ] && [ -f "$STAMP" ] && [ $(( $(date +%s) - $(cat "$STAMP" 2>/dev/null || echo 0) )) -lt 72000 ]; then
  exit 0
fi
# The journal is the one that matters most: it holds every note OBS has
# written to himself, and the voice generates its callbacks out of it. The
# others cost a duplicate reply if lost; this one costs continuity.
cp -f "$DATA"/*-journal.jsonl "$DATA/obs-decisions.jsonl" "$DATA/x-posts.jsonl" "$DATA/x-replies.jsonl" "$DATA/obs-engage-state.json" "$MEM/" 2>/dev/null
cd "$MEM" || exit 1
git add -A >/dev/null 2>&1
if ! git diff --cached --quiet; then
  git commit -q -m "obs memory $(date +%F_%H%M)"
  git push -q -u origin HEAD 2>/dev/null && echo "obs memory backed up to PRIVATE repo"
fi
date +%s > "$STAMP"
