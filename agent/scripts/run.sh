#!/bin/bash
# The hosted runner: one process that does what launchd does on a Mac. It
# restores the ledgers from the private memory repo on first boot, provisions
# the personas on the gateway, serves the read-only API, and runs the desk
# cycle on an interval with the daily memory backup behind it. The voice
# loops stay off unless OBS_VOICE=on. Nothing here arms execution: that is
# OBS_TRADING=on plus a mounted key, both the operator's, never this file's.
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$PWD/node_modules/.bin:$PATH"
DATA="${OBS_DATA_DIR:-$PWD/data}"
MEM="${OBS_MEMORY_REPO_DIR:-}"
DESK_EVERY="${OBS_DESK_INTERVAL_SEC:-1800}"
POST_EVERY="${OBS_POST_INTERVAL_SEC:-7200}"
ENGAGE_EVERY="${OBS_ENGAGE_INTERVAL_SEC:-600}"
VOICE="${OBS_VOICE:-off}"
mkdir -p "$DATA"
log() { echo "[run] $(date -u +%FT%TZ) $*"; }

# 1. Memory. Clone the private repo when a URL is given and no checkout
#    exists; when the data dir is empty, seed it from the checkout so the
#    book, the thoughts and the journal continue instead of starting over.
if [ -n "$MEM" ] && [ ! -d "$MEM/.git" ] && [ -n "${OBS_MEMORY_REPO_URL:-}" ]; then
  git clone -q "$OBS_MEMORY_REPO_URL" "$MEM" && log "cloned the memory repo into $MEM"
fi
if [ -n "$MEM" ] && [ -d "$MEM/.git" ]; then
  git -C "$MEM" config user.name "${OBS_GIT_NAME:-obs}"
  git -C "$MEM" config user.email "${OBS_GIT_EMAIL:-obs@users.noreply.github.com}"
  if [ ! -f "$DATA/obs-thoughts.jsonl" ] && ls "$MEM"/*.jsonl >/dev/null 2>&1; then
    cp -n "$MEM"/*.jsonl "$DATA/" 2>/dev/null
    cp -n "$MEM"/*.json "$DATA/" 2>/dev/null
    log "restored the ledgers from the memory repo"
  fi
else
  log "no memory checkout (OBS_MEMORY_REPO_DIR / OBS_MEMORY_REPO_URL); backups will be skipped"
fi

# 2. Personas on the gateway. Idempotent; a gateway that is not up yet is not fatal.
node scripts/ohsetup.mjs || log "persona setup skipped; is the gateway reachable at ${OPENHERMIT_GATEWAY_URL:-unset}?"

# 2b. A key handed in as a variable (hosts without a mount): written once, read only at signing time.
if [ -n "${OBS_WALLET_JSON:-}" ] && [ ! -f "${OBS_WALLET_DIR:-/wallet}/obs-wallet.json" ]; then
  mkdir -p "${OBS_WALLET_DIR:-/wallet}" && umask 077 && printf '%s' "$OBS_WALLET_JSON" > "${OBS_WALLET_DIR:-/wallet}/obs-wallet.json" && log "wallet file written from OBS_WALLET_JSON"
fi

# 3. The read-only API, the live watch and the feed puller, in the background.
tsx src/server.ts &
API=$!
tsx src/desk/live.ts &
LIVE=$!
tsx src/desk/feedpull.ts &
FEED=$!
tsx src/desk/screenerpull.ts &
SCREENER=$!
tsx src/desk/launchpull.ts &
LAUNCH=$!
trap 'log "stopping"; kill $API $LIVE $FEED $SCREENER $LAUNCH 2>/dev/null; exit 0' TERM INT

# 4. The loops, on a one-minute tick so each cadence keeps its own clock.
next_desk=0; next_post=0; next_engage=0
while true; do
  now=$(date +%s)
  if (( now >= next_desk )); then
    log "desk cycle"
    tsx src/desk/cycle.ts
    bash scripts/_obs-backup.sh
    next_desk=$(( now + DESK_EVERY ))
  fi
  if [ "$VOICE" = "on" ]; then
    if (( now >= next_post )); then log "post cycle"; tsx src/autopilot.ts; next_post=$(( now + POST_EVERY )); fi
    if (( now >= next_engage )); then log "engage cycle"; tsx src/engage.ts; next_engage=$(( now + ENGAGE_EVERY )); fi
  fi
  if ! kill -0 $API 2>/dev/null; then log "API exited; restarting it"; tsx src/server.ts & API=$!; fi
  if ! kill -0 $LIVE 2>/dev/null; then log "live watch exited; restarting it"; tsx src/desk/live.ts & LIVE=$!; fi
  if ! kill -0 $FEED 2>/dev/null; then log "feed puller exited; restarting it"; tsx src/desk/feedpull.ts & FEED=$!; fi
  if ! kill -0 $SCREENER 2>/dev/null; then log "screener poller exited; restarting it"; tsx src/desk/screenerpull.ts & SCREENER=$!; fi
  if ! kill -0 $LAUNCH 2>/dev/null; then log "launch poller exited; restarting it"; tsx src/desk/launchpull.ts & LAUNCH=$!; fi
  sleep 60 &
  wait $!
done
