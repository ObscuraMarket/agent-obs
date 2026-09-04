#!/bin/bash
# The public bridge to the API. Two shapes:
#   OBS_TUNNEL_TOKEN set: a named Cloudflare tunnel on the site's own domain
#     (the site team creates it in their Cloudflare zone, routes a hostname
#     such as obs-api.obscura.market to http://127.0.0.1:4671, and hands over
#     the token). Stable hostname, no interstitial, the stream passes.
#   otherwise: a quick tunnel with a random trycloudflare.com hostname,
#     printed to the log. Fine for a test; the hostname changes on restart.
# Any account certificate on this machine is hidden from the quick tunnel,
# because with one present cloudflared registers the tunnel under that
# account without a DNS route and the hostname answers 404.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && source .env; set +a
PORT="${OBS_DASHBOARD_PORT:-4671}"
if [ -n "${OBS_TUNNEL_TOKEN:-}" ]; then
  echo "=== named tunnel $(date) -> http://127.0.0.1:$PORT ==="
  exec cloudflared tunnel --no-autoupdate run --token "$OBS_TUNNEL_TOKEN" --url "http://127.0.0.1:$PORT"
fi
echo "=== quick tunnel $(date) -> http://127.0.0.1:$PORT ==="
# Both the machine's cloudflared config and its account certificate are
# bypassed; with either in play the "quick" tunnel registers under that
# account without a route and its hostname answers 404 at the edge.
export TUNNEL_ORIGIN_CERT=/nonexistent
exec cloudflared --config "$PWD/scripts/cloudflared-quick.yml" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT"
