#!/bin/bash
# Withdraw the desk's open proposals on Railway: a cancelled row per proposal,
# reason written down, nothing else touched. Run before arming, so the armed
# desk does not start by reading a stack of dead proposals as "awaiting the
# operator". Pass --dry to list them without writing.
#   scripts/railway-withdraw.sh --dry
#   scripts/railway-withdraw.sh
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/../ops/railway" || exit 1
railway ssh -s desk -- env OBS_DATA_DIR=/app/data npx tsx scripts/withdrawProposals.ts "$@" 2>&1 | tr -d '\r'
