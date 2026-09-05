#!/bin/bash
# Put a provider RPC endpoint on the desk, after proving it is Robinhood Chain.
#   scripts/railway-rpc.sh <https url with the key>     check it, set ROBINHOOD_RPC_URL on Railway and in agent/.env
#   scripts/railway-rpc.sh --check <url>                 check only, change nothing
# The check: eth_chainId must be 4663, the head block must be recent, and an
# eth_getLogs over the PoolManager must answer (the live watch is one every
# three seconds). Setting the variable redeploys the desk; the API is back
# within a minute. The key is never printed.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_ONLY=0
[ "$1" = "--check" ] && { CHECK_ONLY=1; shift; }
URL="${1:-}"
[ -n "$URL" ] || { echo "usage: $0 [--check] <rpc url>"; exit 1; }
mask() { sed -E 's#(/v2/|/rpc/|key=|/)[A-Za-z0-9_-]{16,}#\1<key>#g'; }
call() { curl -s -m 20 -X POST "$URL" -H 'content-type: application/json' -d "$1"; }

echo "== checking $(echo "$URL" | mask)"
CHAIN=$(call '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | python3 -c "import json,sys;print(int(json.load(sys.stdin).get('result','0x0'),16))" 2>/dev/null)
[ "$CHAIN" = "4663" ] || { echo "FAIL: chain id is '${CHAIN:-none}', Robinhood Chain is 4663"; exit 1; }
echo "chain id 4663: ok"
HEAD=$(call '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}' | python3 -c "
import json,sys,time;b=json.load(sys.stdin).get('result') or {}
n=int(b.get('number','0x0'),16); age=time.time()-int(b.get('timestamp','0x0'),16)
print(f'{n} {age:.0f}')" 2>/dev/null)
set -- $HEAD
[ -n "${1:-}" ] && [ "${2:-999}" -lt 120 ] || { echo "FAIL: head block ${1:-unread}, ${2:-?} s old"; exit 1; }
echo "head block $1, $2 s old: ok"
# 300 blocks: the PoolManager logs about seven events a block and the native RPC caps a query at 10,000 logs.
FROM=$(printf '0x%x' $(( $1 - 300 )))
LOGS=$(call "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{\"fromBlock\":\"$FROM\",\"toBlock\":\"latest\",\"address\":\"0x8366a39cc670b4001a1121b8f6a443a643e40951\"}]}")
echo "$LOGS" | python3 -c "
import json,sys;d=json.load(sys.stdin)
if 'error' in d: print('FAIL: eth_getLogs:', str(d['error'])[:160]); sys.exit(1)
print(f'eth_getLogs over 300 blocks: ok ({len(d.get(\"result\",[]))} logs)')" || exit 1
[ "$CHECK_ONLY" = 1 ] && { echo "check only; nothing changed"; exit 0; }

echo "== setting ROBINHOOD_RPC_URL"
cd "$ROOT/ops/railway" || exit 1
railway variables -s desk --set "ROBINHOOD_RPC_URL=$URL" >/dev/null && echo "Railway desk: set (redeploying)" || { echo "Railway: failed"; exit 1; }
ENV="$ROOT/agent/.env"
if [ -f "$ENV" ]; then
  if grep -q '^ROBINHOOD_RPC_URL=' "$ENV"; then
    python3 - "$ENV" "$URL" <<'PY'
import sys,re
p,u=sys.argv[1],sys.argv[2]
s=open(p).read()
s=re.sub(r'^ROBINHOOD_RPC_URL=.*$', 'ROBINHOOD_RPC_URL='+u, s, count=1, flags=re.M)
open(p,'w').write(s)
PY
  else
    printf '\nROBINHOOD_RPC_URL=%s\n' "$URL" >> "$ENV"
  fi
  echo "agent/.env on this Mac: set (the watcher's API picks it up on its next restart)"
fi
echo "done; run scripts/railway-preflight.sh in a minute"
