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

# Write a plausible backup archive: comfortably over the 1 KiB usability floor
# and mtime-now, so it satisfies both the truncation and the staleness rules.
mkgz() { head -c 4096 /dev/zero > "$1"; }

# The log-signal cases below are about the LOG, so they get a backup directory
# that is unambiguously healthy -- otherwise signal 3 (no usable backup) fires
# on the empty directory and every log assertion is measuring the wrong thing.
# An empty backup directory really is a stall in production; that is asserted
# on its own in section 5c rather than smuggled into these fixtures.
mkdir -p "$WORK/good"
mkgz "$WORK/good/paperclip-20260905-051709.sql.gz"

C='INFO: Automatic database backup complete: /d/paperclip-20260903-061709.sql.gz (130.8M)'
S='WARN: Skipping scheduled database backup because a previous backup is still running'
T='INFO: Automatic database backup starting {"trigger":"scheduled"}'
N='INFO: some unrelated server line'

# run <log> <extra args...> -> sets RC and OUT
run() {
  local log="$1"; shift
  OUT="$("$TOOL" --log "$log" --backup-dir "$WORK/good" --no-health "$@" 2>&1)"
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

# A pair whose .gz is a REAL archive is a successful backup, never an orphan.
# NOTE the sibling must be written with real content. The original version of
# this test created the .gz with `: >` -- a ZERO-byte file -- and asserted exit
# 0, which encoded the 2026-09-05 false green as the expected behaviour.
mkgz "$WORK/bk/paperclip-20260830-093742.sql.gz"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$WORK/bk" --no-health 2>&1)"; RC=$?
(( RC == 0 )) && ok "paired .sql/real .sql.gz is not an orphan" || bad "expected exit 0, got $RC ($OUT)"

# An in-progress backup younger than the threshold is not yet an orphan. Keep a
# fresh good archive present so signal 3 (staleness) does not fire instead --
# this case is about the orphan rule alone.
rm -f "$WORK/bk/paperclip-20260830-093742.sql.gz"
touch "$WORK/bk/paperclip-20260830-093742.sql"
mkgz "$WORK/bk/paperclip-20260830-100000.sql.gz"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$WORK/bk" --no-health 2>&1)"; RC=$?
(( RC == 0 )) && ok "a fresh in-progress .sql is not an orphan" || bad "expected exit 0, got $RC ($OUT)"

# --- 5b. THE 2026-09-05 REGRESSION -----------------------------------------
# The exact shape the detector missed on the live host: a big orphaned .sql
# next to a 20-byte .sql.gz. The pre-fix detector returned exit 0 here, because
# it tested for the sibling's EXISTENCE rather than its usability.
hdr "A TRUNCATED .sql.gz sibling is a stall, not a success (TOG-1129)"
TR="$WORK/truncated"; mkdir -p "$TR"
mkgz "$TR/paperclip-20260905-051709.sql.gz"   # a fresh last-good backup, so that
                                              # staleness stays quiet and this
                                              # case measures truncation alone
head -c 4096 /dev/zero > "$TR/paperclip-20260905-063644.sql"
head -c 20   /dev/zero > "$TR/paperclip-20260905-063644.sql.gz"   # empty gzip frame
# Older than --orphan-min-age-minutes. That screen is deliberately kept for the
# truncated case: gzip creates its output file when compression STARTS, so a
# backup legitimately mid-compress also has a short-lived tiny .gz. Age is what
# separates "compressing right now" from "died while compressing". On the real
# host this dump was 681 minutes old.
touch -d "@$(( $(date -u +%s) - 2 * 3600 ))" "$TR/paperclip-20260905-063644.sql" \
                                             "$TR/paperclip-20260905-063644.sql.gz"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$TR" --no-health 2>&1)"; RC=$?
(( RC == 1 )) && ok "exit 1 on a 20-byte .sql.gz beside a real .sql" || bad "FALSE GREEN: expected exit 1, got $RC ($OUT)"
grep -q "TRUNCATED" <<<"$OUT" && ok "names the truncation signal" || bad "no TRUNCATED reason"

# The complement: raising the floor below the sibling's size must clear it.
# Without this, a detector that simply calls every pair truncated also passes.
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$TR" --no-health --min-backup-bytes 10 2>&1)"; RC=$?
(( RC == 0 )) && ok "a .gz above the floor is accepted (floor is really consulted)" || bad "expected exit 0, got $RC ($OUT)"

# --- 5c. staleness, the signal that survives losing the log -----------------
hdr "A backup directory whose newest archive is old is a stall (TOG-1129)"
ST="$WORK/stale"; mkdir -p "$ST"
mkgz "$ST/paperclip-20260905-051709.sql.gz"
touch -d "@$(( $(date -u +%s) - 3 * 3600 ))" "$ST/paperclip-20260905-051709.sql.gz"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$ST" --no-health 2>&1)"; RC=$?
(( RC == 1 )) && ok "exit 1 when the newest good archive is 3h old" || bad "expected exit 1, got $RC ($OUT)"
grep -q "STALE" <<<"$OUT" && ok "names the staleness signal" || bad "no STALE reason"

# Negative control for the same rule: a fresh archive must NOT trip it.
touch "$ST/paperclip-20260905-051709.sql.gz"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$ST" --no-health 2>&1)"; RC=$?
(( RC == 0 )) && ok "a fresh archive does not trip staleness" || bad "expected exit 0, got $RC ($OUT)"

hdr "A directory with no usable archive at all is a stall"
NB="$WORK/nogood"; mkdir -p "$NB"
head -c 20 /dev/zero > "$NB/paperclip-20260905-063644.sql.gz"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$NB" --no-health 2>&1)"; RC=$?
(( RC == 1 )) && ok "exit 1 when every archive is truncated" || bad "expected exit 1, got $RC ($OUT)"
grep -q "NO USABLE BACKUP" <<<"$OUT" && ok "names the no-usable-backup signal" || bad "no NO USABLE BACKUP reason"

# --- 5d. a DEAD log cannot testify to health -------------------------------
# The second half of the live miss: server.log stopped being written at 05:33,
# so the suppression scan anchored on a 12-hour-old completion and saw no skips
# after it. An anchor from a dead log must never produce a green.
hdr "A stale log is inconclusive, never green (TOG-1129)"
DL="$WORK/deadlog"; mkdir -p "$DL"
mkgz "$DL/paperclip-20260905-051709.sql.gz"                  # backups are FINE
cp "$WORK/healthy.log" "$WORK/dead.log"
touch -d "@$(( $(date -u +%s) - 12 * 3600 ))" "$WORK/dead.log"
OUT="$("$TOOL" --log "$WORK/dead.log" --backup-dir "$DL" --no-health 2>&1)"; RC=$?
(( RC == 2 )) && ok "exit 2 when the log is 12h stale but backups are fresh" || bad "expected exit 2, got $RC ($OUT)"
grep -q "No backup stall detected" <<<"$OUT" && bad "claimed health from a dead log" || ok "never claims health from a dead log"
# And the same log, freshly written, must still be able to go green -- otherwise
# this rule is just a second always-on alarm.
touch "$WORK/dead.log"
OUT="$("$TOOL" --log "$WORK/dead.log" --backup-dir "$DL" --no-health 2>&1)"; RC=$?
(( RC == 0 )) && ok "a current log with fresh backups is still green" || bad "expected exit 0, got $RC ($OUT)"

# --- 5e. the runbook must not advertise an unreachable exit 0 --------------
# The detector's dead-log rule (5d) is correct and deliberate. The hazard is
# what the RUNBOOK and the operator card tell a human to expect from it: on
# this installation the default log path stopped being written at 05:33Z, three
# minutes before the 05:36:14Z container restart, and the current container
# logs to stdout. So a bare `./db_backup_stall.sh` cannot return 0 here even
# after a flawless recovery -- it returns 2 by design.
#
# An operator handed "must be 0" as the acceptance criterion is being asked for
# something unachievable, and will either conclude the restart failed or "fix"
# it by relaxing the staleness rule -- which is exactly the green-from-a-dead-
# log that cost 92 hours on 2026-08-30. This asserts the docs stay honest.
hdr "The runbook never advertises a bare exit 0 as the recovery check (TOG-1129)"
RB="$HERE/docs/runbooks/database-backup-stall.md"
if [[ -r "$RB" ]]; then
  # Any line invoking the detector with no --log, yet claiming it must be 0.
  if grep -nE '^\s*\./db_backup_stall\.sh\s*(#.*)?$' "$RB" | grep -qE '(must be|must exit)\s*0'; then
    bad "runbook advertises a bare invocation returning 0 -- unreachable on this host"
  else
    ok "no bare invocation is documented as returning 0"
  fi
  grep -q 'exit 0 is unreachable without it' "$RB" \
    && ok "runbook states why --log is mandatory for the recovery check" \
    || bad "runbook does not explain that the default log path is dead"
  # The monitor wrapper passes no --log, so post-recovery it reports
  # inconclusive rather than green. That must be written down, or the flip
  # from stall to inconclusive reads as recovery.
  grep -q 'flips from `stall` straight to `inconclusive`' "$RB" \
    && ok "runbook warns the monitor flips to inconclusive, not to green" \
    || bad "runbook does not warn about the post-restart inconclusive flip"
else
  bad "runbook $RB not readable -- documentation assertions unverified"
fi

# --- 6. JSON contract ------------------------------------------------------
hdr "JSON output is well-formed and carries the verdict"
J="$("$TOOL" --log "$WORK/stall.log" --backup-dir "$WORK/good" --no-health --json 2>/dev/null)"
if command -v python3 >/dev/null 2>&1; then
  if python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["verdict"]=="stall"; assert d["exitCode"]==1; assert d["windowAnchored"] is True; assert d["skipCountInWindow"]==12' <<<"$J" 2>/dev/null; then
    ok "stall JSON parses with the expected fields"
  else
    bad "stall JSON malformed or wrong: $J"
  fi
  JH="$("$TOOL" --log "$WORK/noanchor.log" --backup-dir "$WORK/good" --no-health --json 2>/dev/null)"
  if python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["verdict"]=="inconclusive"; assert d["windowAnchored"] is False' <<<"$JH" 2>/dev/null; then
    ok "inconclusive JSON reports windowAnchored=false"
  else
    bad "inconclusive JSON wrong: $JH"
  fi
  # A log line containing quotes and backslashes must not break the JSON.
  { echo '[06:38:11] '"$C"; echo '[09:00:00] INFO: Automatic database backup starting {"path":"C:\\dir\\"x"}'; } > "$WORK/quotes.log"
  JQ="$("$TOOL" --log "$WORK/quotes.log" --backup-dir "$WORK/good" --no-health --json 2>/dev/null)"
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

# --- 8. --staleness-only (TOG-2370) -----------------------------------------
# Once host_db_backup.sh can also write into this directory, signal 1
# (log suppression) is permanently tripped by a wedged in-server scheduler
# and can never clear again (TOG-1138). --staleness-only answers a narrower,
# always-answerable question: is there a recent usable archive at all,
# regardless of which script wrote it. It must never read the log.
hdr "--staleness-only ignores the log and answers only 'is there a recent usable archive'"
SO="$WORK/staleness-only"; mkdir -p "$SO"
mkgz "$SO/paperclip-20260913-000000.sql.gz"
OUT="$("$TOOL" --log "$WORK/stall.log" --backup-dir "$SO" --no-health --staleness-only 2>&1)"; RC=$?
(( RC == 0 )) && ok "a fresh archive is healthy even with a stalled log fixture" || bad "expected exit 0, got $RC ($OUT)"
grep -q "server log and the orphan/truncation signal were not evaluated" <<<"$OUT" \
  && ok "says the log was not evaluated" || bad "did not disclose that the log was skipped"

hdr "--staleness-only: a host-authored -hostcron archive counts as usable"
HC="$WORK/staleness-hostcron"; mkdir -p "$HC"
mkgz "$HC/paperclip-20260913-010000-hostcron.sql.gz"
OUT="$("$TOOL" --backup-dir "$HC" --no-health --staleness-only 2>&1)"; RC=$?
(( RC == 0 )) && ok "a -hostcron archive alone clears staleness" || bad "expected exit 0, got $RC ($OUT)"

hdr "--staleness-only: a stale archive is still a stall"
touch -d "@$(( $(date -u +%s) - 3 * 3600 ))" "$SO/paperclip-20260913-000000.sql.gz"
OUT="$("$TOOL" --backup-dir "$SO" --no-health --staleness-only 2>&1)"; RC=$?
(( RC == 1 )) && ok "a 3h-old archive still trips staleness" || bad "expected exit 1, got $RC ($OUT)"
grep -q "STALE" <<<"$OUT" && ok "names the staleness signal" || bad "no STALE reason"

hdr "--staleness-only: an unreadable backup directory is inconclusive, not healthy"
OUT="$("$TOOL" --backup-dir "$WORK/no-such-dir" --no-health --staleness-only 2>&1)"; RC=$?
(( RC == 2 )) && ok "a missing backup dir is exit 2, never 0 or silently healthy" || bad "expected exit 2, got $RC ($OUT)"

hdr "--staleness-only: JSON reports stalenessOnly:true and skips log fields"
JSO="$("$TOOL" --backup-dir "$SO" --no-health --staleness-only --json 2>/dev/null)"
if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["stalenessOnly"] is True; assert d["verdict"]=="stall"' <<<"$JSO" 2>/dev/null \
    && ok "JSON stalenessOnly flag set on a staleness-only run" || bad "stalenessOnly JSON field wrong: $JSO"
fi

# --- 9. producer filter: a -hostcron archive must not answer for the -------
#        in-server scheduler in DEFAULT (combined) mode (TOG-2998)
# db_backup_stall.sh globs "$PREFIX"-*.sql.gz with PREFIX=paperclip, and
# host_db_backup.sh writes paperclip-<ts>-hostcron.sql.gz into the SAME
# directory -- so before this fix, a host-side archive alone cleared signal 3
# even though the in-server scheduler had produced nothing. This is the RED
# case from the issue: it must read as a stall in default mode, against a
# directory where the in-server scheduler is by construction 100% absent.
hdr "Default mode: a hostcron-only directory is a stall, not health (TOG-2998)"
HO="$WORK/hostcron-only"; mkdir -p "$HO"
mkgz "$HO/paperclip-20260916-162700-hostcron.sql.gz"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$HO" --no-health 2>&1)"; RC=$?
(( RC == 1 )) && ok "a fresh -hostcron-only archive still reports a stall in default mode" || bad "expected exit 1, got $RC ($OUT)"
grep -q "NO USABLE BACKUP" <<<"$OUT" && ok "names the no-usable-backup signal" || bad "no NO USABLE BACKUP reason"
grep -q "excluded from this verdict" <<<"$OUT" && ok "surfaces the excluded host archive as a note" || bad "did not disclose the excluded host archive"

# Negative control for the same rule: a fresh IN-SERVER archive alongside the
# hostcron one must still clear it -- proving the filter excludes only the
# tagged producer, not the whole directory.
mkgz "$HO/paperclip-20260916-162700.sql.gz"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$HO" --no-health 2>&1)"; RC=$?
(( RC == 0 )) && ok "an in-server archive alongside a hostcron one clears the stall" || bad "expected exit 0, got $RC ($OUT)"

hdr "Default mode: --include-all-producers restores the legacy all-writers view"
IA="$WORK/include-all"; mkdir -p "$IA"
mkgz "$IA/paperclip-20260916-162700-hostcron.sql.gz"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$IA" --no-health --include-all-producers 2>&1)"; RC=$?
(( RC == 0 )) && ok "--include-all-producers lets a hostcron archive clear the verdict" || bad "expected exit 0, got $RC ($OUT)"

hdr "--exclude-suffix accepts a custom producer tag"
CT="$WORK/custom-tag"; mkdir -p "$CT"
mkgz "$CT/paperclip-20260916-162700-nightly.sql.gz"
OUT="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$CT" --no-health --exclude-suffix nightly 2>&1)"; RC=$?
(( RC == 1 )) && ok "a custom --exclude-suffix excludes its own tagged archive" || bad "expected exit 1, got $RC ($OUT)"
"$TOOL" --exclude-suffix '../escape' >/dev/null 2>&1; (( $? == 2 )) && ok "rejects a path-escaping exclude-suffix" || bad "accepted a path-escaping exclude-suffix"

hdr "JSON reports excludeEnabled, excludeSuffix and the host archive's own freshness"
JHD="$WORK/hostcron-only-json"; mkdir -p "$JHD"
mkgz "$JHD/paperclip-20260916-162700-hostcron.sql.gz"
JHO="$("$TOOL" --log "$WORK/healthy.log" --backup-dir "$JHD" --no-health --json 2>/dev/null)"
if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import json,sys
d=json.load(sys.stdin)
assert d["excludeEnabled"] is True
assert d["excludeSuffix"] == "hostcron"
assert d["newestHostArchive"].endswith("-hostcron.sql.gz")
assert d["newestHostArchiveAgeMinutes"] >= 0
assert d["newestUsableBackup"] == "none"' <<<"$JHO" 2>/dev/null \
    && ok "JSON exposes the excluded host archive without counting it toward the verdict" || bad "producer-filter JSON fields wrong: $JHO"
fi

printf '\n\033[1mTOTAL\033[0m  %d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
