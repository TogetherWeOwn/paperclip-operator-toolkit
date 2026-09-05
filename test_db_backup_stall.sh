#!/usr/bin/env bash
# ===========================================================================
# test_db_backup_stall.sh — regression suite for the TOG-831 stall detector.
#
# The detector's load-bearing properties, in the order they matter:
#
#   1. It FIRES on the real 2026-08-30 shape: a completion followed by skips.
#   2. It STAYS QUIET on a healthy log. A detector that cannot return 0 is not
#      a detector, it is an alarm that is always on -- and it would be trivially
#      "passed" by a broken implementation that hardcodes exit 1.
#   3. It FAILS CLOSED. An unanchored window is exit 2 (inconclusive), never
#      exit 0. Reporting health from a window too small to contain an anchor is
#      the exact failure that let the real incident run 92 hours unnoticed.
#   4. /api/health reading "ok" NEVER clears a detected stall.
#
# Fully offline: every log is a fixture, no server and no network required.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${DB_BACKUP_STALL_SH:-$HERE/db_backup_stall.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -x "$TOOL" ]] || { echo "ERROR: $TOOL is not executable" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_db_backup_stall.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/empty"

C='INFO: Automatic database backup complete: /d/paperclip-20260903-061709.sql.gz (130.8M)'
S='WARN: Skipping scheduled database backup because a previous backup is still running'
T='INFO: Automatic database backup starting {"trigger":"scheduled"}'
N='INFO: some unrelated server line'

# run <log> <extra args...> -> sets RC and OUT
run() {
  local log="$1"; shift
  OUT="$("$TOOL" --log "$log" --backup-dir "$WORK/empty" --no-health "$@" 2>&1)"
  RC=$?
}

# --- 1. the real incident shape --------------------------------------------
hdr "Fires on the 2026-08-30 shape (completion, then suppression)"
{ echo "$N"; echo "[08:37:42] $T"; echo "[08:38:11] $C"; echo "[09:37:42] $T"
  for _ in $(seq 1 12); do echo "[10:37:43] $S"; done; } > "$WORK/stall.log"
run "$WORK/stall.log"
(( RC == 1 )) && ok "exit 1 on suppression" || bad "expected exit 1, got $RC"
grep -q "SUPPRESSION" <<<"$OUT" && ok "names the suppression signal" || bad "no SUPPRESSION reason"

# --- 2. the negative control -----------------------------------------------
# This is the test that keeps the suite honest. A hardcoded `exit 1` passes
# every other case here and fails only this one.
hdr "Stays quiet on a healthy log (negative control)"
{ echo "$N"; echo "[06:37:42] $T"; echo "[06:38:11] $C"; echo "$N"; } > "$WORK/healthy.log"
run "$WORK/healthy.log"
(( RC == 0 )) && ok "exit 0 when the newest event is a completion" || bad "expected exit 0, got $RC ($OUT)"
grep -q "No backup stall detected" <<<"$OUT" && ok "says no stall" || bad "did not report healthy"

hdr "Old skips followed by a completion are recovery, not a stall"
# This is the CURRENT live shape: the wedge ended, a backup landed after it.
# Ordering, not raw counts, is what distinguishes recovered from wedged.
{ echo "[19:37:43] $S"; echo "[20:37:43] $S"; echo "[05:17:09] $T"; echo "[06:17:47] $C"; } > "$WORK/recovered.log"
run "$WORK/recovered.log"
(( RC == 0 )) && ok "exit 0 when skips PRECEDE the last completion" || bad "expected exit 0, got $RC"
grep -q "skips in window    2" <<<"$OUT" && ok "still reports the historical skip count" || bad "lost the skip count"

# --- 3. fail closed --------------------------------------------------------
hdr "Fails CLOSED when the window has no anchor"
{ echo "$N"; echo "$N"; } > "$WORK/noanchor.log"
run "$WORK/noanchor.log"
(( RC == 2 )) && ok "exit 2 (inconclusive) with no completion anchor" || bad "expected exit 2, got $RC"
grep -q "UNANCHORED" <<<"$OUT" && ok "explains the window was unanchored" || bad "no UNANCHORED note"
grep -q "No backup stall detected" <<<"$OUT" && bad "claimed health from an unanchored window" || ok "never claims health when unanchored"

hdr "A too-small window is inconclusive, not green"
# The anchor exists but falls outside the byte window -- the precise way a
# multi-gigabyte log could otherwise produce a false green.
{ echo "[06:38:11] $C"; for _ in $(seq 1 400); do echo "$N padding padding padding padding"; done; } > "$WORK/small.log"
run "$WORK/small.log" --window-bytes 500
(( RC == 2 )) && ok "exit 2 when the anchor is outside the window" || bad "expected exit 2, got $RC"

hdr "Fails CLOSED on an unreadable log"
run "$WORK/does-not-exist.log"
(( RC == 2 )) && ok "exit 2 on a missing log" || bad "expected exit 2, got $RC"
grep -q "not readable" <<<"$OUT" && ok "says the log was unreadable" || bad "no unreadable note"

# --- 4. unsettled backup ---------------------------------------------------
hdr "Detects an unsettled backup before the next tick fires"
{ echo "[06:38:11] $C"; echo "[09:37:42] $T"; } > "$WORK/unsettled.log"
run "$WORK/unsettled.log"
(( RC == 1 )) && ok "exit 1 on a start with no completion after it" || bad "expected exit 1, got $RC"
grep -q "UNSETTLED" <<<"$OUT" && ok "names the unsettled signal" || bad "no UNSETTLED reason"

# --- 5. orphan signal ------------------------------------------------------
hdr "Orphaned .sql detection respects the minimum age"
mkdir -p "$WORK/bk"
: > "$WORK/bk/paperclip-20260830-093742.sql"
touch -d "@$(( $(date -u +%s) - 7200 ))" "$WORK/bk/paperclip-20260830-093742.sql"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$WORK/bk" --no-health 2>&1)"; RC=$?
(( RC == 1 )) && ok "exit 1 on a stale unpaired .sql" || bad "expected exit 1, got $RC"
grep -q "ORPHAN" <<<"$OUT" && ok "names the orphan signal" || bad "no ORPHAN reason"

# A gzipped pair is a SUCCESSFUL backup, never an orphan.
: > "$WORK/bk/paperclip-20260830-093742.sql.gz"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$WORK/bk" --no-health 2>&1)"; RC=$?
(( RC == 0 )) && ok "paired .sql/.sql.gz is not an orphan" || bad "expected exit 0, got $RC"

# An in-progress backup younger than the threshold is not yet an orphan.
rm -f "$WORK/bk/paperclip-20260830-093742.sql.gz"
touch "$WORK/bk/paperclip-20260830-093742.sql"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$WORK/bk" --no-health 2>&1)"; RC=$?
(( RC == 0 )) && ok "a fresh in-progress .sql is not an orphan" || bad "expected exit 0, got $RC"

# --- 6. JSON contract ------------------------------------------------------
hdr "JSON output is well-formed and carries the verdict"
J="$("$TOOL" --log "$WORK/stall.log" --backup-dir "$WORK/empty" --no-health --json 2>/dev/null)"
if command -v python3 >/dev/null 2>&1; then
  if python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["verdict"]=="stall"; assert d["exitCode"]==1; assert d["windowAnchored"] is True; assert d["skipCountInWindow"]==12' <<<"$J" 2>/dev/null; then
    ok "stall JSON parses with the expected fields"
  else
    bad "stall JSON malformed or wrong: $J"
  fi
  JH="$("$TOOL" --log "$WORK/noanchor.log" --backup-dir "$WORK/empty" --no-health --json 2>/dev/null)"
  if python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["verdict"]=="inconclusive"; assert d["windowAnchored"] is False' <<<"$JH" 2>/dev/null; then
    ok "inconclusive JSON reports windowAnchored=false"
  else
    bad "inconclusive JSON wrong: $JH"
  fi
  # A log line containing quotes and backslashes must not break the JSON.
  { echo '[06:38:11] '"$C"; echo '[09:00:00] INFO: Automatic database backup starting {"path":"C:\\dir\\"x"}'; } > "$WORK/quotes.log"
  JQ="$("$TOOL" --log "$WORK/quotes.log" --backup-dir "$WORK/empty" --no-health --json 2>/dev/null)"
  python3 -c 'import json,sys; json.load(sys.stdin)' <<<"$JQ" 2>/dev/null \
    && ok "quotes and backslashes in log lines stay valid JSON" || bad "escaping broke JSON"
else
  bad "python3 unavailable -- JSON contract unverified"
fi

# --- 7. argument validation ------------------------------------------------
hdr "Rejects bad arguments instead of guessing"
"$TOOL" --window-bytes 0 >/dev/null 2>&1; (( $? == 2 )) && ok "rejects --window-bytes 0" || bad "accepted a zero window"
"$TOOL" --prefix 'a/../b' >/dev/null 2>&1; (( $? == 2 )) && ok "rejects a path-escaping prefix" || bad "accepted a path-escaping prefix"
"$TOOL" --bogus >/dev/null 2>&1; (( $? == 2 )) && ok "rejects an unknown flag" || bad "accepted an unknown flag"

printf '\n\033[1mTOTAL\033[0m  %d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
