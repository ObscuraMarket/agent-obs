#!/bin/bash
# Root for one thing: a mounted volume arrives owned by root, and the desk
# runs as obs. Own the data, memory and wallet paths, then drop privileges.
set -e
for d in "${OBS_DATA_DIR:-/app/data}" "${OBS_MEMORY_REPO_DIR:-/memory}" "${OBS_WALLET_DIR:-/wallet}"; do
  mkdir -p "$d" && chown -R obs:obs "$d"
done
exec su-exec obs "$@"
