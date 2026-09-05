#!/bin/bash
# The latest desk cycle and the live watch, as plain text for a model's context.
#   obs-read.sh            the latest cycle: verdict, headline, the agent's lines, each token's status
#   obs-read.sh --live     what the watch is following right now
#   obs-read.sh --signals  every read behind the next decision, compact
#   OBS_API=https://... obs-read.sh   another desk running the same API
API="${OBS_API:-https://obs-api.obscura.markets}"
get() { curl -s -m 20 "$API$1"; }
case "${1:-}" in
  --live)
    get /api/obs/live | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("live" if d.get("live") else "stale", "| block", d.get("block"), "| look %.1f s" % ((d.get("lookMs") or 0)/1000))
for w in d.get("watching", []):
    print("  %s: %s, %s, %s, %s" % (w.get("symbol"), w.get("role"), "ENTRY" if w.get("entryOk") else w.get("entryState"), w.get("trend"), w.get("why")))
if d.get("lastTrigger"): print("last trigger:", d["lastTrigger"])'
    ;;
  --signals)
    get /api/obs/signals | python3 -c '
import json,sys
d=json.load(sys.stdin)
for c in d.get("candidates", []): print("candidate %s: grade %s, cap $%s, %s" % (c.get("symbol"), c.get("grade"), c.get("capUsd"), c.get("why")))
for e in d.get("early", []): print("early %s: %s min old, gate %s, tax %s bps, %s" % (e.get("symbol"), e.get("ageMin"), "ok" if e.get("gateOk") else "failed", e.get("creatorTaxBps"), ("tradable via " + str(e.get("via"))) if e.get("tradable") else "not tradable"))
for t in d.get("tapes", []):
    en=t.get("entry") or {}
    print("tape %s: %s swaps, %s%% buy pressure, %s, entry %s %s" % (t.get("symbol"), t.get("swaps"), t.get("buyPressurePct"), t.get("trend"), en.get("state"), "ALLOWED" if en.get("ok") else "no"))
l=d.get("launch") or {}
if l.get("line"): print(l["line"])'
    ;;
  *)
    get "/api/obs/thoughts?limit=1" | python3 -c '
import json,sys,datetime
t=json.load(sys.stdin)["items"][0]
g=t.get("digest") or {}
print(datetime.datetime.utcfromtimestamp(t["at"]/1000).strftime("%Y-%m-%d %H:%MZ"), "|", (g.get("verdict") or t["decision"]["kind"]).upper())
print(g.get("headline") or t["decision"].get("reason") or "")
for l in t.get("thoughts", []): print("  ", l)
for x in g.get("tokens", []): print("  ", x["symbol"] + ":", x["line"])
b=g.get("board")
if b: print("   board:", b["early"], "early launches,", b["probeAllowed"], "probe-allowed,", b["gateFailed"], "failed the gate;", b["graded"], "graded,", b["belowBar"], "below the bar")
a=g.get("argument")
if a:
    print("   thesis:", a["thesis"])
    for e in a.get("evidence", []): print("   evidence:", e)
    print("   wrong if:", a.get("invalidation"), "| conviction", a.get("conviction"))'
    ;;
esac
