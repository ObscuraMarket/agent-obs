#!/bin/bash
# Arm or disarm the desk on Railway. Deliberate and reversible.
#   scripts/railway-arm.sh on     put the key (from ~/.obs/wallet/obs-wallet.json) and OBS_TRADING=on on the desk service
#   scripts/railway-arm.sh off    OBS_TRADING=off (the key variable stays; remove it with `railway variables -s desk --unset OBS_WALLET_JSON`)
# Each change redeploys the desk; the live watch and the API come back within a minute.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/../ops/railway" || exit 1
case "${1:-}" in
  on)
    KEY="${OBS_WALLET_FILE:-$HOME/.obs/wallet/obs-wallet.json}"
    [ -f "$KEY" ] || { echo "no key file at $KEY"; exit 1; }
    python3 - "$KEY" <<'PY'
import json,sys,subprocess
key=open(sys.argv[1]).read().strip(); json.loads(key)
r=subprocess.run(["railway","variables","-s","desk","--set",f"OBS_WALLET_JSON={key}","--set","OBS_TRADING=on"],capture_output=True,text=True)
print("armed: OBS_WALLET_JSON set, OBS_TRADING=on" if r.returncode==0 else "failed: "+(r.stderr or r.stdout)[-200:])
PY
    ;;
  off)
    railway variables -s desk --set OBS_TRADING=off >/dev/null && echo "disarmed: OBS_TRADING=off"
    ;;
  *) echo "usage: $0 on|off"; exit 1;;
esac
