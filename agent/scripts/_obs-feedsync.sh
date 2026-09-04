#!/bin/bash
# Mirror the launch watcher's feed from this Mac to the server, every minute
# (launchd). The feed is append-only, so rsync sends only the new tail.
# Needs OBS_SERVER (user@host) in agent/.env and the Mac's ssh key on the
# server. Quiet when nothing changed.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && source .env; set +a
[ -n "${OBS_SERVER:-}" ] || { echo "OBS_SERVER not set; nothing to mirror"; exit 0; }
[ -f "${OBS_CANDIDATE_FEED:-}" ] || { echo "feed not found at ${OBS_CANDIDATE_FEED:-<unset>}"; exit 0; }
rsync -az --append-verify -e "ssh -o BatchMode=yes -o ConnectTimeout=10" "$OBS_CANDIDATE_FEED" "$OBS_SERVER:/srv/obs/feed/launch-watch.jsonl"
