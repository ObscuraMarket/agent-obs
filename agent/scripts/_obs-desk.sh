#!/bin/bash
# OBS desk cycle (called by launchd on a cadence): public thoughts, the book,
# an equity snapshot. Records proposals; executes nothing.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && source .env; set +a
echo "=== $(date) ==="
./node_modules/.bin/tsx src/desk/cycle.ts
