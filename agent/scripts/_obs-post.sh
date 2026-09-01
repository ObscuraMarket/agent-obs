#!/bin/bash
# OBS X runner (called by launchd on a cadence). Draft-first: X_LIVE comes
# from .env and is never forced here. Then back up his memory (self-throttled).
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && source .env; set +a
echo "=== $(date) ==="
./node_modules/.bin/tsx src/autopilot.ts
bash scripts/_obs-backup.sh
