#!/bin/bash
# Generate the per-machine launchd jobs from the templates (absolute paths are
# filled in here, never committed) and print the commands to load them. Does
# not load anything itself: starting the timers is the operator's call.
set -e
AGENT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HOME/Library/LaunchAgents"
mkdir -p "$OUT"
for t in "$AGENT"/scripts/launchd/*.plist.template; do
  name="$(basename "$t" .template)"
  sed -e "s|__AGENT_DIR__|$AGENT|g" -e "s|__HOME__|$HOME|g" "$t" > "$OUT/$name"
  echo "wrote $OUT/$name"
done
echo
echo "Services:   launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obsapi.plist      (the dashboard API, kept alive)"
echo "            launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obsawake.plist    (keeps the Mac awake on power)"
echo "            launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obstunnel.plist   (public bridge; URL in ~/Library/Logs/obs-tunnel.log)"
echo "Timers:     launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obsdesk.plist"
echo "            launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obstick.plist      (the fast tick, every 5 min, cheap unless a token is in play)"
echo "            launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obsx.plist"
echo "            launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obsengage.plist"
echo "To stop:    launchctl bootout gui/\$(id -u)/com.obscura.obsx"
echo "Run once:   launchctl kickstart -k gui/\$(id -u)/com.obscura.obsx"
echo "Logs:       ~/Library/Logs/obs-autopilot.log, ~/Library/Logs/obs-engage.log"
