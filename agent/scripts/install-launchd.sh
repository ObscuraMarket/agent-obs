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
echo "            launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obslive.plist     (the live watch: the desk in real time, kept alive; log in ~/Library/Logs/obs-live.log)"
echo "Timers:     launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obsdesk.plist"
echo "            launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obsfeedsync.plist  (the launch feed to the server, every minute; needs OBS_SERVER in .env)"
echo "            launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obsvercel.plist    (keeps obs-api.obscura.markets pointed at the bridge, every 2 min)"
echo "            launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obssite.plist      (the fork's main to obscura.markets when it moves, every 10 min)"
echo "            (com.obscura.obstick, the old five-minute tick, is superseded by obslive; load one or the other)"
echo "            launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obsx.plist"
echo "            launchctl bootstrap gui/\$(id -u) $OUT/com.obscura.obsengage.plist"
echo "To stop:    launchctl bootout gui/\$(id -u)/com.obscura.obsx"
echo "Run once:   launchctl kickstart -k gui/\$(id -u)/com.obscura.obsx"
echo "Logs:       ~/Library/Logs/obs-autopilot.log, ~/Library/Logs/obs-engage.log"
