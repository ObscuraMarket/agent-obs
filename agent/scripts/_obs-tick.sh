#!/bin/bash
# The fast tick (launchd, every few minutes): a desk cycle that only spends a
# model call when a token is in play, an ignited launch in the window or a
# held launch token, and exits quietly otherwise. Forced exits on held
# tokens run every time when armed. The 30-minute desk cycle stays as is.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && source .env; set +a
export OBS_TICK=fast
export OBS_MIN_THOUGHT_GAP_MIN="${OBS_TICK_MIN_GAP_MIN:-4}"
echo "=== tick $(date) ==="
./node_modules/.bin/tsx src/desk/cycle.ts
