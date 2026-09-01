#!/bin/bash
# OBS mention replies (called by launchd every few minutes). Draft-first.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && source .env; set +a
./node_modules/.bin/tsx src/engage.ts
