#!/bin/bash
# Is the desk on Railway ready to trade? Read-only checks, nothing changed.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
R="${OBS_RAILWAY_URL:-https://desk-production-18ad.up.railway.app}"
cd "$(dirname "$0")/../ops/railway" || exit 1
j() { curl -s -m 25 "$R$1"; }
echo "== desk at $R"
j /api/obs/health | python3 -c "import json,sys;d=json.load(sys.stdin);print('health:',d.get('status'))"
j /api/obs/status | python3 -c "
import json,sys;d=json.load(sys.stdin);k=d.get('desk',{})
print('equity: $%.2f | net capital: $%.2f | pnl: $%.2f' % (k.get('equityUsd') or 0, k.get('netCapitalUsd') or 0, k.get('pnlUsd') or 0))
print('trades:', k.get('trades'), '| armed (canExecute):', k.get('canExecute'))
print('wallet:', (d.get('wallet') or {}).get('address'))"
j /api/obs/live | python3 -c "
import json,sys,time;d=json.load(sys.stdin)
print('live watch:', 'fresh' if d.get('live') else 'STALE', '| block', d.get('block'), '| looks %.1f s' % ((d.get('lookMs') or 0)/1000), '| watching', len(d.get('watching',[])), '| cycles run', d.get('cycles'))"
echo "== variables that decide arming"
railway variables -s desk --kv 2>/dev/null | grep -E "^(OBS_TRADING|OBS_WALLET_ADDRESS|OBS_WALLET_DIR|OBS_WALLET_JSON|OBS_PAPER|OBS_VENUE|OBS_BASE|OBS_MAX_SWAP_USD|OBS_DAILY_SWAP_USD|OBS_PROBE_USD|OBS_DAILY_LOSS_USD|OBS_DAILY_LOSS_PCT|ROBINHOOD_RPC_URL|OBS_MEMORY_REPO_URL)=" | sed -E 's/^(OBS_WALLET_JSON|OBS_MEMORY_REPO_URL)=.*/\1=<set>/; s/^(ROBINHOOD_RPC_URL)=(.{28}).*/\1=\2.../' | sort
echo "== inside the container"
railway ssh -s desk -- sh -c 'echo "key file: $( [ -f /app/data/wallet/obs-wallet.json ] && echo present || echo ABSENT )"; echo "feed: $(wc -c < /app/data/feed/launch-watch.jsonl 2>/dev/null || echo 0) bytes, last line $(tail -c 200 /app/data/feed/launch-watch.jsonl 2>/dev/null | tail -1 | cut -c1-60)"; echo "gateway: $(wget -qO- http://gateway.railway.internal:4000/health 2>/dev/null | cut -c1-40 || echo unreachable)"; echo "lock: $( [ -f /app/data/obs-cycle.lock ] && echo held || echo free )"' 2>/dev/null
echo "== the Mac"
launchctl list | grep -E "obsdesk|obslive" >/dev/null && echo "WARNING: the Mac still runs a desk (obsdesk/obslive loaded); two desks must never share one wallet" || echo "no desk on the Mac (obsdesk and obslive are out)"
