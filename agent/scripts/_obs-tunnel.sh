#!/bin/bash
# A public bridge to the API for launch day: a Cloudflare quick tunnel to the
# local dashboard port. The public URL is random per run and printed to the
# log (grep trycloudflare.com); a named tunnel on the site's own domain, or
# the hosted runner in DEPLOY.md, replaces this for good.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && source .env; set +a
PORT="${OBS_DASHBOARD_PORT:-4671}"
echo "=== tunnel $(date) -> http://127.0.0.1:$PORT ==="
exec cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT"
