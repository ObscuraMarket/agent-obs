#!/bin/bash
# Copy the desk's data from the Railway volume to a local directory, for the
# replay and any other offline look: the tapes, the thoughts, the trades, the
# launch reads, the live state. Then build the pool map (pool id to symbol and
# launch time) from the launch watcher's feed on this Mac.
#   scripts/railway-pull-data.sh [dest dir]     default: ./data-railway
# Railway's ssh joins its arguments and the container's shell re-parses them,
# so nothing here relies on quotes reaching the container: the packer is
# written by a heredoc, the archive is read back in short lines with sed, and
# the command is passed to ssh directly, never through sh -c.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/data-railway}"
mkdir -p "$DEST/tape"
cd "$ROOT/ops/railway" || exit 1

PACK='const fs=require("fs"),z=require("zlib");
const o={};
for(const f of fs.readdirSync("/app/data/tape")) o["tape/"+f]=fs.readFileSync("/app/data/tape/"+f,"utf8");
for(const f of ["obs-thoughts.jsonl","obs-live.json","obs-trades.jsonl","obs-launches.jsonl","obs-wallet-trades.jsonl","obs-trade-memory.jsonl","obs-trade-entries.jsonl"]) { try { o[f]=fs.readFileSync("/app/data/"+f,"utf8"); } catch {} }
const b="BEGIN"+z.gzipSync(Buffer.from(JSON.stringify(o))).toString("base64")+"END";
for(let i=0;i<b.length;i+=4000)process.stdout.write(b.slice(i,i+4000)+"\n");'

echo "== packing on Railway"
N=$(railway ssh -s desk -- sh -c "cat > /tmp/pack.js <<'EOF'
$PACK
EOF
node /tmp/pack.js > /tmp/pack.b64; wc -l < /tmp/pack.b64" 2>&1 | tr -dc '0-9\n' | grep -E '^[0-9]+$' | tail -1)
[ -n "$N" ] && [ "$N" -gt 0 ] || { echo "packing failed (no line count)"; exit 1; }
echo "archive: $N lines of 4,000 characters"

echo "== fetching"
: > "$DEST/pack.b64"
STEP=120; i=1; short=0
while [ "$i" -le "$N" ]; do
  j=$((i+STEP-1)); [ "$j" -gt "$N" ] && j=$N
  want=$((j-i+1)); got=0; tries=0
  while [ "$got" -ne "$want" ] && [ "$tries" -lt 3 ]; do
    chunk=$(railway ssh -s desk -- sed -n ${i},${j}p /tmp/pack.b64 2>&1 | tr -d '\r' | grep -E '^[A-Za-z0-9+/=]{100,}$')
    got=$(printf '%s\n' "$chunk" | grep -c .)
    tries=$((tries+1))
  done
  [ "$got" -ne "$want" ] && { echo "chunk $i-$j short: $got of $want"; short=$((short+1)); }
  printf '%s\n' "$chunk" >> "$DEST/pack.b64"
  i=$((j+1))
done
[ "$short" = 0 ] || { echo "$short chunks came up short; run again"; exit 1; }

echo "== unpacking"
python3 - "$DEST" <<'PY'
import sys,re,base64,gzip,json,os
dest=sys.argv[1]
s=open(dest+'/pack.b64').read().replace('\n','')
m=re.search(r'BEGIN([A-Za-z0-9+/=]+)END',s)
if not m: print('no payload'); sys.exit(1)
data=json.loads(gzip.decompress(base64.b64decode(m.group(1))))
for k,v in data.items():
    p=os.path.join(dest,k); os.makedirs(os.path.dirname(p),exist_ok=True); open(p,'w').write(v)
print('files',len(data),'tapes',sum(1 for k in data if k.startswith('tape/')),'bytes',sum(len(v) for v in data.values()))
PY
rm -f "$DEST/pack.b64"

echo "== pool map from the feed"
FEED=$(grep -E '^OBS_CANDIDATE_FEED=' "$ROOT/agent/.env" 2>/dev/null | cut -d= -f2- | tr -d '"')
if [ -n "$FEED" ] && [ -f "$FEED" ]; then
python3 - "$FEED" "$DEST/poolmap.json" <<'PY'
import sys,json
feed,out=sys.argv[1],sys.argv[2]
tok2sym={}; pool2sym={}; pool2launch={}
with open(feed,'rb') as fh:
    for raw in fh:
        try: r=json.loads(raw)
        except Exception: continue
        k=r.get('kind')
        ts=r.get('ts'); ts=ts*1000 if ts and ts<1e11 else ts
        if k=='launch':
            t=(r.get('token') or '').lower(); s=r.get('symbol') or ''
            if t and s: tok2sym[t]=s
            cp=(r.get('curvePoolId') or '').lower()
            if cp: pool2sym[cp]=s; pool2launch[cp]=ts
        elif k=='side-pool':
            pid=(r.get('id') or '').lower(); t=(r.get('token') or '').lower()
            if pid and t in tok2sym: pool2sym[pid]=tok2sym[t]; pool2launch.setdefault(pid, ts)
        elif k=='candidate':
            pid=(r.get('poolId') or '').lower(); s=r.get('symbol')
            if pid and s: pool2sym.setdefault(pid,s)
json.dump({p:{'symbol':s,'launchAt':pool2launch.get(p)} for p,s in pool2sym.items()},open(out,'w'))
print('pools mapped',len(pool2sym))
PY
else
  echo "no feed on this Mac; the replay will name pools by id"
fi
echo "done: $DEST"
echo "replay: cd agent && npm run replay:entries -- $DEST/tape $DEST/poolmap.json"
