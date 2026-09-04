#!/bin/bash
# The live watch (launchd, kept alive): the desk in real time. Follows the
# pool of every token in play a few seconds apart, reads each swap as it
# lands, and runs a desk cycle the moment a held token's tape breaks, an
# entry appears, or a held token is due a review. Replaces the five-minute
# tick; the 30-minute full read stays as the board-wide sweep.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && source .env; set +a
echo "=== live watch start $(date) ==="
exec ./node_modules/.bin/tsx src/desk/live.ts
