#!/bin/bash
# The desk on a server, as plain services. Run as root on a fresh Ubuntu
# 24.04 box after scripts/server/sync-to-server.sh has copied the checkouts
# to /srv/obs. Idempotent: run it again after every sync.
#
# What it installs: Node 22, Postgres (the gateway's store), Caddy (TLS in
# front of the API), and these services for the obs user:
#   obs-gateway   the model gateway from its source checkout, port 4000, local only
#   obs-api       the read-only dashboard API, port 4671, local only (Caddy fronts it)
#   obs-live      the live watch, the desk in real time
#   obs-desk      the 30-minute desk cycle plus the memory backup (a timer)
#   obs-x, obs-engage   the voice, timers left disabled unless OBS_VOICE=on
# Needs OBS_PUBLIC_HOSTNAME (the API's public name, an A record to this box).
# Nothing here arms execution: that is OBS_TRADING=on plus the key file at
# /srv/obs/wallet, both the operator's.
set -euo pipefail
DEST=/srv/obs
HOST="${OBS_PUBLIC_HOSTNAME:?set OBS_PUBLIC_HOSTNAME to the API's public hostname}"
log() { echo "[bootstrap] $*"; }
export DEBIAN_FRONTEND=noninteractive

log "packages"
apt-get update -qq
apt-get install -y -qq curl git rsync ca-certificates gnupg postgresql postgresql-contrib ufw debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
log "node $(node -v), postgres $(psql --version | awk '{print $3}'), caddy $(caddy version | awk '{print $1}')"

log "the obs user and the tree"
id obs >/dev/null 2>&1 || useradd -r -m -d /home/obs -s /bin/bash obs
mkdir -p "$DEST"/{agent-obs,openhermit,feed,memory,wallet,state}
chmod 700 "$DEST/wallet"

# From a bare box (RUNBOOK.md): clone what the sync did not copy.
if [ ! -f "$DEST/agent-obs/agent/package.json" ]; then
  : "${OBS_REPO_URL:?no checkout at $DEST/agent-obs; set OBS_REPO_URL (a URL this box can read) or run scripts/server/sync-to-server.sh from the Mac}"
  git clone -q "$OBS_REPO_URL" "$DEST/agent-obs" && log "cloned this repo"
fi
if [ ! -f "$DEST/openhermit/package.json" ]; then
  git clone -q "${OPENHERMIT_REPO_URL:-https://github.com/HCF-STUDIOS/openhermit.git}" "$DEST/openhermit" && log "cloned the gateway"
fi
[ -f "$DEST/agent-obs/agent/.env" ] || { echo "[bootstrap] no $DEST/agent-obs/agent/.env; copy agent/.env.example and fill it in (RUNBOOK.md, step 4)"; exit 1; }
[ -f "$DEST/openhermit/.env" ] || { echo "[bootstrap] no $DEST/openhermit/.env; the gateway needs one (RUNBOOK.md, step 3)"; exit 1; }

log "the memory repo's deploy key"
if [ ! -f "$DEST/state/id_ed25519" ]; then
  ssh-keygen -q -t ed25519 -N "" -f "$DEST/state/id_ed25519" -C "obs-server"
fi
mkdir -p /home/obs/.ssh
cp "$DEST/state/id_ed25519" /home/obs/.ssh/id_ed25519
cp "$DEST/state/id_ed25519.pub" /home/obs/.ssh/id_ed25519.pub
ssh-keyscan -t ed25519 github.com 2>/dev/null > /home/obs/.ssh/known_hosts
chmod 700 /home/obs/.ssh; chmod 600 /home/obs/.ssh/id_ed25519 /home/obs/.ssh/known_hosts
chown -R obs:obs /home/obs/.ssh "$DEST"

log "postgres for the gateway"
DB_URL="$(grep -E '^DATABASE_URL=' "$DEST/openhermit/.env" | cut -d= -f2- | tr -d '"' || true)"
if [ -n "$DB_URL" ]; then
  DB_USER="$(echo "$DB_URL" | sed -E 's#^[a-z]+://([^:/@]+).*#\1#')"
  DB_PASS="$(echo "$DB_URL" | sed -nE 's#^[a-z]+://[^:/@]+:([^@]*)@.*#\1#p')"
  DB_NAME="$(echo "$DB_URL" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')"
  systemctl enable -q --now postgresql
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || sudo -u postgres psql -qc "CREATE ROLE \"$DB_USER\" LOGIN PASSWORD '$DB_PASS'"
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || sudo -u postgres psql -qc "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\""
  log "database $DB_NAME for $DB_USER ready (the gateway runs its own migrations at start)"
else
  log "no DATABASE_URL in the gateway's .env; the gateway will not start"
fi

log "dependencies"
sudo -u obs bash -c "cd $DEST/openhermit && npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null"
sudo -u obs bash -c "cd $DEST/agent-obs/agent && npm ci --no-audit --no-fund >/dev/null"
mkdir -p /home/obs/.openhermit
[ -d "$DEST/state/workspaces" ] && rsync -a "$DEST/state/workspaces/" /home/obs/.openhermit/workspaces/
chown -R obs:obs /home/obs/.openhermit "$DEST"

log "services"
# Each unit sources its .env the way the Mac scripts do, so quoting rules match.
unit() { # name, description, workdir, command, [After]
  cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target ${5:-}
Wants=network-online.target

[Service]
User=obs
Group=obs
WorkingDirectory=$3
ExecStart=/bin/bash -c 'set -a; [ -f .env ] && . ./.env; set +a; exec $4'
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
}
unit obs-gateway "OBS model gateway" "$DEST/openhermit" "node -C development --import tsx apps/gateway/src/index.ts"
unit obs-api "OBS dashboard API" "$DEST/agent-obs/agent" "./node_modules/.bin/tsx src/server.ts" "obs-gateway.service"
unit obs-live "OBS live watch" "$DEST/agent-obs/agent" "./node_modules/.bin/tsx src/desk/live.ts" "obs-gateway.service"
# The desk cycle and the backup: a oneshot on a timer.
cat > /etc/systemd/system/obs-desk.service <<EOF
[Unit]
Description=OBS desk cycle and memory backup
After=obs-gateway.service

[Service]
Type=oneshot
User=obs
Group=obs
WorkingDirectory=$DEST/agent-obs/agent
ExecStart=/bin/bash -c 'set -a; . ./.env; set +a; ./node_modules/.bin/tsx src/desk/cycle.ts; bash scripts/_obs-backup.sh'
EOF
cat > /etc/systemd/system/obs-desk.timer <<'EOF'
[Unit]
Description=OBS desk cycle every 30 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=30min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF
# The voice, off unless the operator enables the timers.
cat > /etc/systemd/system/obs-x.service <<EOF
[Unit]
Description=OBS post cycle (draft-first unless X_LIVE=true)
After=obs-gateway.service

[Service]
Type=oneshot
User=obs
Group=obs
WorkingDirectory=$DEST/agent-obs/agent
ExecStart=/bin/bash -c 'set -a; . ./.env; set +a; ./node_modules/.bin/tsx src/autopilot.ts'
EOF
cat > /etc/systemd/system/obs-x.timer <<'EOF'
[Unit]
Description=OBS post cycle every 2 hours

[Timer]
OnBootSec=10min
OnUnitActiveSec=2h

[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/obs-engage.service <<EOF
[Unit]
Description=OBS engage cycle
After=obs-gateway.service

[Service]
Type=oneshot
User=obs
Group=obs
WorkingDirectory=$DEST/agent-obs/agent
ExecStart=/bin/bash -c 'set -a; . ./.env; set +a; ./node_modules/.bin/tsx src/engage.ts'
EOF
cat > /etc/systemd/system/obs-engage.timer <<'EOF'
[Unit]
Description=OBS engage cycle every 10 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable -q --now obs-gateway
for i in $(seq 1 30); do curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:4000/health | grep -q 200 && break; sleep 2; done
log "gateway: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/health)"
sudo -u obs bash -c "cd $DEST/agent-obs/agent && set -a && . ./.env && set +a && node scripts/ohsetup.mjs" || log "persona setup did not complete; run it again once the gateway answers"
systemctl enable -q --now obs-api obs-live obs-desk.timer
systemctl restart obs-api obs-live
if grep -qE '^OBS_VOICE=on' "$DEST/agent-obs/agent/.env"; then systemctl enable -q --now obs-x.timer obs-engage.timer; fi

log "caddy: https://$HOST -> 127.0.0.1:4671"
cat > /etc/caddy/Caddyfile <<EOF
$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:4671 {
		flush_interval -1
	}
}
EOF
systemctl enable -q --now caddy
systemctl reload caddy || systemctl restart caddy

log "firewall: ssh, http, https only"
ufw --force enable >/dev/null
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null

log "state"
systemctl --no-pager --plain list-units 'obs-*' | awk '{print "  " $1, $3, $4}'
echo "  api: $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:4671/api/obs/health) local; https://$HOST/api/obs/health once the certificate is issued"
echo "  deploy key for the memory repo: $(cat "$DEST/state/id_ed25519.pub")"
