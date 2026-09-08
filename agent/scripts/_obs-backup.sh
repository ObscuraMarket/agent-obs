#!/bin/bash
# Snapshot OBS's memory and action ledgers into his PRIVATE memory repo so
# they survive this machine WITHOUT being public. Self-throttles to ~once a
# day (FORCE=1 overrides).
#
# A failure here used to be silent, and once the memory repo diverged it was
# permanent: every push after it was refused and nothing said so (2026-09-08).
# Now the script pulls with a rebase before it commits, bounds the network
# calls, and leaves a marker file the dashboard raises as an alert. A failed
# run tries again in an hour rather than tomorrow.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
AGENT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${OBS_DATA_DIR:-$AGENT/data}"
# Absolute before the cd into the memory checkout, or a relative OBS_DATA_DIR would put the stamp and the marker there.
DATA="$(cd "$DATA" 2>/dev/null && pwd || echo "$DATA")"
MEM="${OBS_MEMORY_REPO_DIR:-}"
# The stamp lives with the data, not under HOME: the runner drops to the obs
# user, whose HOME is not where the stamp was looked for, so the throttle
# never held and the stamp was never found (2026-09-08).
STAMP="$DATA/.backup-stamp"
# The marker the dashboard's heartbeat check reads (src/desk/alerts.ts). Present only while the last run failed.
FAILED="$DATA/obs-backup-failed.json"
# git must never sit on a prompt from an unattended runner; a missing credential is a failure, not a hang.
export GIT_TERMINAL_PROMPT=0

if [ -z "$MEM" ] || [ ! -d "$MEM/.git" ]; then
  # A missing checkout is a failed backup, marked for the health route like a refused push: it exited quietly
  # while the followers' ledgers went unbacked for an afternoon (audit, 2026-09-08). Skipped only where backups
  # were never configured at all (no directory and no URL), which is a development machine.
  if [ -z "$MEM" ] && [ -z "${OBS_MEMORY_REPO_URL:-}" ]; then echo "obs memory: no private memory checkout configured (OBS_MEMORY_REPO_DIR), skipping backup"; exit 0; fi
  echo "obs memory: the checkout at ${MEM:-<unset>} is missing; the ledgers are not leaving this machine" >&2
  printf '{"at":%s000,"step":"checkout","error":"no memory checkout at %s; the clone at boot did not happen"}\n' "$(date +%s)" "${MEM:-<unset>}" > "$FAILED"
  exit 1
fi
# Hourly, not daily: with outside users' agents trading real money, the follow ledgers (who follows, at what size,
# each agent wallet's record, every funding and trade) changed all afternoon while the 20-hour throttle held the
# last backup at 11:00Z (2026-09-08). The runner calls this every 30 minutes; 55 minutes here makes it hourly.
if [ "$FORCE" != "1" ] && [ -f "$STAMP" ] && [ $(( $(date +%s) - $(cat "$STAMP" 2>/dev/null || echo 0) )) -lt 3300 ]; then
  exit 0
fi

# The network calls run under a deadline: a push that hangs on a dead remote held the desk's runner loop for
# good (2026-09-08). coreutils and busybox both ship timeout; a Mac without it runs the call unbounded.
timed() {
  if command -v timeout >/dev/null 2>&1; then timeout 120 "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout 120 "$@"
  else "$@"
  fi
}
# One line of JSON the alert can carry: whitespace collapsed, cut short, then quotes and backslashes escaped.
# The cut comes before the escape, or it could land between a backslash and its quote and break the file.
json_text() { printf '%s' "$1" | tr '\n\r\t' '   ' | cut -c1-500 | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# What git said, for a person: its "hint:" lines and blanks dropped, the last few lines kept, on one line. The
# hints alone filled the note and pushed the line that mattered ("! [rejected]", "CONFLICT") out of it.
git_said() { grep -v '^hint:' | grep -v '^[[:space:]]*$' | tail -n 4 | tr '\n' ' ' | sed 's/[[:space:]]*$//'; }
FAIL_STEP=""; FAIL_ERROR=""; PULL_NOTE=""
# The first failure is the one that is reported; a later one is appended so nothing is hidden.
fail() {
  if [ -z "$FAIL_STEP" ]; then FAIL_STEP="$1"; FAIL_ERROR="$2"; else FAIL_ERROR="$FAIL_ERROR; then $1: $2"; fi
  echo "obs memory: $1 failed: $2" >&2
}

cd "$MEM" || { fail "cd" "cannot enter $MEM"; }
if [ -z "$FAIL_STEP" ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
  # Pull first, on a clean tree, so the commit lands on the remote's head. A rebase that will not apply is
  # abandoned and the commit goes on the current head instead: the copied files are never inside a rebase, and a
  # push that is then refused says so through the marker. A pull that fails on its own is a warning here; the
  # push decides whether the backup landed.
  if ! PULL_OUT="$(timed git -c rebase.autoStash=false pull -q --rebase origin "$BRANCH" 2>&1)"; then
    git rebase --abort >/dev/null 2>&1
    PULL_NOTE="$(printf '%s\n' "$PULL_OUT" | git_said)"
    echo "obs memory: the pull before the commit failed, committing on the current head: $PULL_NOTE" >&2
  fi
fi
if [ -z "$FAIL_STEP" ]; then
  # Two kinds of memory ride along. The journal holds every note OBS has
  # written to himself and the voice generates its callbacks out of it: losing
  # it costs continuity. The desk ledgers hold the book itself, what was
  # deposited, every trade and its status, every public thought and every
  # equity mark: losing them costs the track record. The X ledgers cost a
  # duplicate reply if lost. Copy whatever exists; a missing file is fine.
  # Every ledger and state file, not a named few: the named list missed the credits, the agent wallets and their
  # funding, the follower trades, the accounts and the trade memory, every one of them someone's money or the
  # desk's own record (2026-09-08). Caches rebuilt from the chain (the tapes, the holder scans, the token catalogue)
  # and the live heartbeat stay out. The backup's own marker stays out too: it is this machine's state, not memory.
  for f in "$DATA"/*.jsonl "$DATA"/*.json; do
    case "$(basename "$f")" in
      obs-live.json|obs-known-tokens.json|obs-explorer.json|obs-launchpull.json|obs-wallet-trades.jsonl|obs-token-samples.jsonl|obs-backup-failed.json) continue ;;
    esac
    [ -f "$f" ] || continue
    cp -f "$f" "$MEM/" 2>/dev/null || fail "copy" "could not copy $(basename "$f")"
  done
  git add -A >/dev/null 2>&1
  if ! git diff --cached --quiet; then
    COMMIT_OUT="$(git commit -q -m "obs memory $(date +%F_%H%M)" 2>&1)" || fail "commit" "$COMMIT_OUT"
  fi
fi
if [ -z "$FAIL_STEP" ] || [ "$FAIL_STEP" = "copy" ]; then
  # Always push, even with nothing new committed: a commit left behind by a refused push must go out on the next
  # run, and an up-to-date branch is a free round trip.
  if PUSH_OUT="$(timed git push -q -u origin HEAD 2>&1)"; then
    echo "obs memory backed up to PRIVATE repo"
  else
    PUSH_SAID="$(printf '%s\n' "$PUSH_OUT" | git_said)"
    [ -n "$PULL_NOTE" ] && PUSH_SAID="$PUSH_SAID (the pull before it failed too: $PULL_NOTE)"
    fail "push" "$PUSH_SAID"
  fi
fi

NOW="$(date +%s)"
if [ -n "$FAIL_STEP" ]; then
  printf '{"at":%s000,"step":"%s","error":"%s"}\n' "$NOW" "$(json_text "$FAIL_STEP")" "$(json_text "$FAIL_ERROR")" > "$FAILED"
  # Try again in fifteen minutes, not in an hour: the stamp is backdated so the throttle opens sooner.
  echo $(( NOW - 3300 + 900 )) > "$STAMP"
  exit 1
fi
rm -f "$FAILED"
echo "$NOW" > "$STAMP"
