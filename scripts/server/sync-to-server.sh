#!/bin/bash
# Move the desk to a server, from this Mac. Copies the two source checkouts
# (this repo and the model gateway), the gateway's state, the environment
# with the server's overrides, and on the first run the ledgers; then runs
# the server-side bootstrap (or restarts the services on later runs).
#
#   scripts/server/sync-to-server.sh root@1.2.3.4 obs-api.example.com [--seed-data] [--with-wallet]
#
#   --seed-data    copy agent/data (the ledgers and tapes) once; after the
#                  server has run, its own data is the truth and this is skipped
#   --with-wallet  copy the desk's key file too (needed only to arm on the server)
#
# Needs: ssh access to the server as root with this Mac's key, gh logged in
# (to add the memory repo's deploy key). Nothing here touches this Mac's
# services; the Mac keeps running until you stop it.
set -euo pipefail
SERVER="${1:?usage: sync-to-server.sh user@host hostname [--seed-data] [--with-wallet]}"
HOSTNAME_="${2:?usage: sync-to-server.sh user@host hostname [--seed-data] [--with-wallet]}"
shift 2
SEED=0; WALLET=0
for a in "$@"; do case "$a" in --seed-data) SEED=1;; --with-wallet) WALLET=1;; esac; done
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GATEWAY_SRC="${OPENHERMIT_SRC:-$HOME/OpenHermit}"
MEM_SRC="$(grep -E '^OBS_MEMORY_REPO_DIR=' "$ROOT/agent/.env" | cut -d= -f2- || true)"
DEST=/srv/obs
RS="rsync -az --delete"
log() { echo "[sync] $*"; }

ssh "$SERVER" "mkdir -p $DEST/agent-obs $DEST/openhermit $DEST/feed $DEST/memory $DEST/wallet $DEST/state"

log "this repo"
$RS --exclude node_modules --exclude .git --exclude 'agent/data' --exclude 'dashboard/angular/node_modules' --exclude '*.log' "$ROOT/" "$SERVER:$DEST/agent-obs/"

log "the gateway source"
$RS --exclude node_modules --exclude .git --exclude 'apps/*/dist' --exclude 'packages/*/dist' "$GATEWAY_SRC/" "$SERVER:$DEST/openhermit/"
$RS "$HOME/.openhermit/workspaces/" "$SERVER:$DEST/state/workspaces/" 2>/dev/null || true

log "the environment, with the server's overrides"
{
  grep -vE '^(OBS_CANDIDATE_FEED|OBS_MEMORY_REPO_DIR|OPENHERMIT_GATEWAY_URL|OBS_TUNNEL_TOKEN|OBS_DATA_DIR|OBS_WALLET_DIR|OBS_TRADING|OBS_SERVER|OBS_PUBLIC_HOSTNAME)=' "$ROOT/agent/.env"
  echo "OBS_CANDIDATE_FEED=$DEST/feed/launch-watch.jsonl"
  echo "OBS_MEMORY_REPO_DIR=$DEST/memory"
  echo "OPENHERMIT_GATEWAY_URL=http://127.0.0.1:4000"
  echo "OBS_WALLET_DIR=$DEST/wallet"
  echo "OBS_PUBLIC_HOSTNAME=$HOSTNAME_"
  echo "OBS_TRADING=off"
} > /tmp/obs-server.env
scp -q /tmp/obs-server.env "$SERVER:$DEST/agent-obs/agent/.env"; rm -f /tmp/obs-server.env
scp -q "$GATEWAY_SRC/.env" "$SERVER:$DEST/openhermit/.env"

if [ -n "$MEM_SRC" ] && [ -d "$MEM_SRC/.git" ]; then
  log "the memory repo checkout"
  $RS "$MEM_SRC/" "$SERVER:$DEST/memory/"
fi

if [ "$SEED" = 1 ]; then
  log "the ledgers (seed)"
  rsync -az "$ROOT/agent/data/" "$SERVER:$DEST/agent-obs/agent/data/"
fi

if [ "$WALLET" = 1 ]; then
  log "the key file"
  scp -q "$HOME/.obs/wallet/obs-wallet.json" "$SERVER:$DEST/wallet/obs-wallet.json"
fi

log "bootstrap on the server"
ssh "$SERVER" "OBS_PUBLIC_HOSTNAME=$HOSTNAME_ bash $DEST/agent-obs/scripts/server/bootstrap.sh"

# The memory repo pushes from the server over its own deploy key, scoped to that one repo.
PUB="$(ssh "$SERVER" 'cat /srv/obs/state/id_ed25519.pub')"
REPO="$(git -C "$MEM_SRC" remote get-url origin 2>/dev/null | sed -E 's#(https://github.com/|git@github.com:)##; s#\.git$##' || true)"
if [ -n "$REPO" ] && ! gh repo deploy-key list --repo "$REPO" 2>/dev/null | grep -q "obs-server"; then
  echo "$PUB" > /tmp/obs-server-key.pub
  gh repo deploy-key add /tmp/obs-server-key.pub --repo "$REPO" --title "obs-server" --allow-write && log "deploy key added to $REPO"
  rm -f /tmp/obs-server-key.pub
fi
ssh "$SERVER" "git -C $DEST/memory remote set-url origin git@github.com:${REPO}.git; chown -R obs:obs $DEST/memory"

# This Mac keeps the launch watcher; its feed mirrors to the server every minute.
if ! grep -qE "^OBS_SERVER=" "$ROOT/agent/.env"; then echo "OBS_SERVER=$SERVER" >> "$ROOT/agent/.env"; else sed -i '' -E "s#^OBS_SERVER=.*#OBS_SERVER=$SERVER#" "$ROOT/agent/.env"; fi
bash "$ROOT/agent/scripts/_obs-feedsync.sh" && log "feed mirrored once; the launchd job com.obscura.obsfeedsync keeps it current (install-launchd.sh writes it)"

log "done. Health: https://$HOSTNAME_/api/obs/health (allow a minute for the certificate)"
