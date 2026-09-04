#!/bin/bash
# A paper trading session: the desk decides on its own, at real size, with
# nothing sent, on a fixed cadence for a fixed time, then reports.
#   npm run paper:session -- <minutes> <cadence minutes>     (defaults 60 and 10)
# Each cycle is `npm run paper` (OBS_PAPER=on, the pacing floor lifted). The
# real timer keeps running alongside; paper thoughts are flagged in the ledger.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
MIN="${1:-60}"; EVERY="${2:-10}"
LOG="${OBS_DATA_DIR:-data}/obs-paper-session.log"
START=$(date +%s); END=$((START + MIN * 60)); N=0
echo "=== paper session: ${MIN} min, a cycle every ${EVERY} min, started $(date) ===" | tee "$LOG"
while [ "$(date +%s)" -lt "$END" ]; do
  N=$((N + 1))
  echo "--- cycle $N at $(date +%H:%M:%S) ---" | tee -a "$LOG"
  npm run paper 2>&1 | grep -E "^\[desk\] (decision|analysis|paper exit|recorded)|paper trade|refused" | cut -c1-400 | tee -a "$LOG"
  NEXT=$(( $(date +%s) + EVERY * 60 ))
  [ "$NEXT" -ge "$END" ] && break
  sleep $((EVERY * 60))
done
echo "=== session over after $N cycles, $(date) ===" | tee -a "$LOG"
npm run paper:report 2>&1 | tail -12 | tee -a "$LOG"
