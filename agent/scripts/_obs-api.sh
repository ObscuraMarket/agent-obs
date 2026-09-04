#!/bin/bash
# The dashboard API as a service (launchd keeps it alive). Read-only JSON and
# the event stream on OBS_DASHBOARD_PORT (4671). Sources .env for the port,
# the CORS origins and the rate limits; loads no key.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && source .env; set +a
echo "=== api $(date) ==="
exec ./node_modules/.bin/tsx src/server.ts
