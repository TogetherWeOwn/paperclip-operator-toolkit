#!/usr/bin/env bash
# ===========================================================================
# test_cold_start_detector.sh — offline suite for the cold-start detector
# (TOG-487).
#
# No database, no network, no host files: the pace window arrives through
# PACE_WINDOW_CMD and the recovery actions through RECOVERY_SOURCE_CMD, the
# same way liveness arrives through LIVENESS_SOURCE_CMD in
# test_queue_liveness.sh. That is what lets CI run this.
#
# THE PACE WINDOW BELOW IS REAL. Section 1 replays
# /paperclip/operator-handoff/quota-pacing.jsonl for 2026-08-25 14:30Z-17:00Z
# — the tail of the outage and the recovery after it. Every `ts`,
# `five_hour`, `pool_verdict` and `runs_in_flight` is verbatim from that feed;
# the two account NAMES are replaced with acct-a/acct-b because they are the
# owner's personal mail addresses and this repo does not carry those. The
# other keys the pacer writes (burn ratios, pace lines, notional spend) are
# elided — the detector reads none of them, and a fixture carrying fields the
# subject ignores invites someone to "fix" the detector to read them.
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * A NULL FIVE-HOUR WINDOW READ AS ZERO. `[[ "" -eq 0 ]]` is TRUE in bash,
#    so the shortest possible headroom test fires on missing data. This is not
#    theoretical: the real feed has `five_hour: null` at 15:00:11Z and again
#    at 15:45:21Z. Section 2 pins that the 15:00Z sample — where the only
#    numeric reading is 1 and the other account is null — is NOT headroom. A
#    detector that scored null as zero would fire there, 45 minutes early, off
#    a hole in the data.
#
#  * A MONITOR THAT READS GREEN WHILE BLIND. Section 5 asserts that an
#    unreadable pace window, an unreadable recovery source, a dead pacer feed
#    and an unparseable timestamp all exit 5 — never 0. Zero stranded actions
#    counted from a source that never answered is "never ran", not "clean".
#
#  * A THREE-OUTCOME ABSENCE ASSERTION. "nothing stranded", "could not count"
#    and "stranded but suppressed" are three different answers and section 4
#    pins all three separately. Asserting only exit 0 versus exit 3 would let
#    the unmeasured case pass as the clean one, which is the entire failure
#    mode this tool exists to end one level up.
#
#  * ADJACENCY. Several inputs below would also be refused by a neighbouring
#    guard, which is how an exit-code-only assertion goes green for the wrong
#    reason. Every verdict assertion pins the REASON string, not just the exit
#    status, so a refusal from the wrong branch fails the test.
#
#  * A SILENTLY TRUNCATED PLAN. Section 6 asserts the cap is obeyed AND that
#    exceeding it prints WITHHELD. A capped plan that does not say it is
#    capped reads as complete coverage of the outage.
# ===========================================================================
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/cold_start_detector.sh"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# ---------------------------------------------------------------------------
# The recorded window. `mk_pace <last-ts>` emits every sample up to and
# including that timestamp, oldest first, exactly as the tool expects.
PACE_RECORD() {
  cat <<'EOF'
{"ts":"2026-08-25T14:30:10Z","pool_verdict":"THROTTLE","runs_in_flight":0,"accounts":[{"name":"acct-a","five_hour":1},{"name":"acct-b","five_hour":0.99}]}
{"ts":"2026-08-25T14:45:10Z","pool_verdict":"HOLD_5H","runs_in_flight":0,"accounts":[{"name":"acct-a","five_hour":1},{"name":"acct-b","five_hour":0.99}]}
{"ts":"2026-08-25T15:00:11Z","pool_verdict":"ON_PACE","runs_in_flight":0,"accounts":[{"name":"acct-a","five_hour":1},{"name":"acct-b","five_hour":null}]}
{"ts":"2026-08-25T15:15:12Z","pool_verdict":"ON_PACE","runs_in_flight":0,"accounts":[{"name":"acct-a","five_hour":1},{"name":"acct-b","five_hour":0}]}
{"ts":"2026-08-25T15:30:18Z","pool_verdict":"ON_PACE","runs_in_flight":0,"accounts":[{"name":"acct-a","five_hour":1},{"name":"acct-b","five_hour":0}]}
{"ts":"2026-08-25T15:45:21Z","pool_verdict":"AHEAD","runs_in_flight":0,"accounts":[{"name":"acct-a","five_hour":null},{"name":"acct-b","five_hour":0}]}
{"ts":"2026-08-25T16:00:24Z","pool_verdict":"AHEAD","runs_in_flight":0,"accounts":[{"name":"acct-a","five_hour":0},{"name":"acct-b","five_hour":0}]}
{"ts":"2026-08-25T16:15:31Z","pool_verdict":"AHEAD","runs_in_flight":0,"accounts":[{"name":"acct-a","five_hour":0},{"name":"acct-b","five_hour":0}]}
{"ts":"2026-08-25T16:30:34Z","pool_verdict":"AHEAD","runs_in_flight":0,"accounts":[{"name":"acct-a","five_hour":0},{"name":"acct-b","five_hour":0}]}
{"ts":"2026-08-25T16:45:37Z","pool_verdict":"AHEAD","runs_in_flight":0,"accounts":[{"name":"acct-a","five_hour":0},{"name":"acct-b","five_hour":0}]}
EOF
}

# mk_pace <cutoff-ts> [jq-filter-applied-to-each-record]
# Returns the path to an executable emitting that window.
mk_pace() {
  local cutoff="$1" filter="${2:-.}" f="$WORK/pace_$RANDOM$RANDOM.sh"
  { echo '#!/usr/bin/env bash'; echo 'cat <<'"'"'JSONL'"'"''
    PACE_RECORD | jq -c --arg c "$cutoff" "select(.ts <= \$c) | $filter"
    echo 'JSONL'; } > "$f"
  chmod +x "$f"; printf '%s' "$f"
}

# ---------------------------------------------------------------------------
# The 38 stranded actions. Shape and timestamps follow the real set: created
# 10:48Z-13:41Z, attempt_count 1, spread across the owners that actually held
# them, with the President & COO holding the largest share — which is what
# makes the plan's ordering rule land on a dispatch owner without anyone
# hardcoding a role.
mk_actions() {
  local f="$WORK/act_$RANDOM$RANDOM.sh"
  { echo '#!/usr/bin/env bash'; echo 'cat <<'"'"'TSV'"'"''
    local i
    for i in $(seq 1 21); do
      printf 'act-coo-%02d\tissue-coo-%02d\tagent-coo\tPresident & Chief Operating Officer\t2026-08-25T10:48:17Z\t1\n' "$i" "$i"
    done
    for i in $(seq 1 10); do
      printf 'act-cto-%02d\tissue-cto-%02d\tagent-cto\tCTO & Chief AI Officer\t2026-08-25T11:44:39Z\t1\n' "$i" "$i"
    done
    for i in $(seq 1 5); do
      printf 'act-doe-%02d\tissue-doe-%02d\tagent-doe\tDirector of Engineering\t2026-08-25T12:10:02Z\t1\n' "$i" "$i"
    done
    for i in $(seq 1 2); do
      printf 'act-emw-%02d\tissue-emw-%02d\tagent-emw\tEngineering Manager, Web Platform\t2026-08-25T13:41:17Z\t1\n' "$i" "$i"
    done
    echo 'TSV'; } > "$f"
  chmod +x "$f"; printf '%s' "$f"
}

# A source emitting arbitrary TSV lines.
mk_tsv() { local f="$WORK/tsv_$RANDOM$RANDOM.sh"; { echo '#!/usr/bin/env bash'; printf 'cat <<%s\n' "'TSV'"; cat; echo 'TSV'; } > "$f"; chmod +x "$f"; printf '%s' "$f"; }

ACTIONS="$(mk_actions)"

# detect <now> <pace> <actions> [env assignments...] -> sets OUT/RC/ERRTXT
detect() {
  local now="$1" pace="$2" acts="$3"; shift 3
  ERRTXT="$WORK/err.$$"
  OUT="$(env COLD_START_NOW="$now" PACE_WINDOW_CMD="$pace" RECOVERY_SOURCE_CMD="$acts" "$@" \
         "$TOOL" detect 2>"$ERRTXT")"; RC=$?
  VERDICT=""; REASON=""
  IFS=$'\x1f' read -r VERDICT REASON _ HELD INFLIGHT COUNTS <<<"${OUT//$'\t'/$'\x1f'}"
}

# assert <label> <expected_rc> <expected_verdict> <expected_reason>
assert() {
  local label="$1" xrc="$2" xv="$3" xr="$4"
  if [[ "$RC" == "$xrc" && "$VERDICT" == "$xv" && "$REASON" == "$xr" ]]; then ok "$label"
  else bad "$label" "expected rc=$xrc verdict=$xv reason=$xr; got rc=$RC verdict='$VERDICT' reason='$REASON'"; fi
}

# EVERY assertion goes through a helper that takes its label ONCE.
#
# This is not tidiness. verification/tog-487-mutation-gate.sh requires that a
# named mutation reddens the case that CLAIMS to cover it, and it matches on
# the printed label. Hand-written `... && ok "the long name" || bad "short"`
# pairs print a different string on failure, so the gate cannot attribute the
# red — it reported five such cases when this suite was first written, which
# is exactly the "went red for the wrong reason" failure the gate exists to
# catch. One label per assertion makes that structural.
#
# want <label> <expected> <actual>
want() {
  local label="$1" exp="$2" act="$3"
  if [[ "$act" == "$exp" ]]; then ok "$label"; else bad "$label" "expected '$exp', got '$act'"; fi
}
# want_in <label> <pattern> <text>   — fixed-string containment
want_in() {
  local label="$1" pat="$2" txt="$3"
  if [[ "$txt" == *"$pat"* ]]; then ok "$label"; else bad "$label" "expected to contain '$pat'; got: $(head -c 300 <<<"$txt")"; fi
}
# run_rc <cmd...> -> prints the exit status, so `want` can compare it
run_rc() { "$@" >/dev/null 2>&1; printf '%s' "$?"; }

# plan <actions-source> <max> -> sets PLANOUT/PLANRC
plan() {
  PLANOUT="$(env COLD_START_NOW=2026-08-25T16:45:50Z PACE_WINDOW_CMD="$(mk_pace 2026-08-25T16:45:37Z)" \
    RECOVERY_SOURCE_CMD="$1" "${@:3}" "$TOOL" plan --max "$2" 2>&1)"; PLANRC=$?
}


echo "== 1. the recorded 2026-08-25 outage window =="

# THE ACCEPTANCE CASE. 16:45:37Z: the quota has been back for 90 minutes, 38
# recovery actions have not been touched since 13:41Z at the latest, and
# nothing is running. This is the state that persisted for 3h20m on the day
# with nothing detecting it.
detect 2026-08-25T16:45:50Z "$(mk_pace 2026-08-25T16:45:37Z)" "$ACTIONS"
assert "16:45Z on the real feed fires cold_with_headroom (exit 3)" 3 cold_with_headroom stranded_work_and_headroom
want "all 38 actions counted as stranded" "38/38" "$COUNTS"
want "headroom is measured as held for 90m, from 15:15:12Z" "90m" "$HELD"

# The whole reason this is worth building: it fires long before the company
# actually came back by hand at 17:07Z.
detect 2026-08-25T15:45:30Z "$(mk_pace 2026-08-25T15:45:21Z)" "$ACTIONS"
assert "15:45:21Z is the FIRST sample that fires — 1h22m before the company resumed" 3 cold_with_headroom stranded_work_and_headroom

detect 2026-08-25T14:30:20Z "$(mk_pace 2026-08-25T14:30:10Z)" "$ACTIONS"
assert "14:30Z, mid-drain with five_hour=1, is quiet" 0 quiet no_headroom

echo "== 2. a null five_hour is NOT zero =="

# 15:00:11Z, verbatim: acct-a five_hour=1, acct-b five_hour=null. The only
# numeric reading is 1. Headroom is FALSE. Score the null as zero — which is
# what `[[ "$fh" -lt 1 ]]` does — and this fires 45 minutes early on an
# account whose window was never measured.
detect 2026-08-25T15:00:20Z "$(mk_pace 2026-08-25T15:00:11Z)" "$ACTIONS"
assert "15:00:11Z (five_hour=[1,null]) is NOT headroom" 0 quiet no_headroom

# 15:45:21Z, verbatim the other way round: acct-a null, acct-b 0. One NUMERIC
# reading at 0 is genuine headroom and must still fire. Pinning only the case
# above would be satisfied by a detector that rejected every record
# containing any null at all, which would have delayed the alarm by 15
# minutes on the real data.
detect 2026-08-25T15:45:30Z "$(mk_pace 2026-08-25T15:45:21Z)" "$ACTIONS"
assert "15:45:21Z (five_hour=[null,0]) IS headroom — one numeric reading suffices" 3 cold_with_headroom stranded_work_and_headroom

# Every account null: nothing was measured, so neither "headroom" nor "no
# headroom" is an honest answer.
P="$(mk_pace 2026-08-25T16:45:37Z '.accounts = [{"name":"acct-a","five_hour":null},{"name":"acct-b","five_hour":null}]')"
detect 2026-08-25T16:45:50Z "$P" "$ACTIONS"
assert "no account with a numeric five_hour is unknown, not quiet (exit 5)" 5 unknown five_hour_unmeasured

# five_hour arriving as a STRING is the same hole wearing a different hat: jq
# would compare "0" < 0.10 as false, but a bash-side test would coerce it.
P="$(mk_pace 2026-08-25T16:45:37Z '.accounts = [{"name":"acct-a","five_hour":"0"},{"name":"acct-b","five_hour":"0"}]')"
detect 2026-08-25T16:45:50Z "$P" "$ACTIONS"
assert "a stringified five_hour is not a numeric reading (exit 5)" 5 unknown five_hour_unmeasured

echo "== 3. headroom must have HELD, and BEHIND overrides it =="

detect 2026-08-25T15:15:20Z "$(mk_pace 2026-08-25T15:15:12Z)" "$ACTIONS"
assert "the first headroom sample alone is warming, not an alarm" 0 warming headroom_too_new
want_in "warming says so on stderr rather than passing as quiet" "WARMING:" "$(cat "$ERRTXT")"

detect 2026-08-25T15:30:25Z "$(mk_pace 2026-08-25T15:30:18Z)" "$ACTIONS"
assert "15m of headroom is still short of the 20m floor" 0 warming headroom_too_new

# pool_verdict=BEHIND vetoes headroom however good the account readings look.
P="$(mk_pace 2026-08-25T16:45:37Z '.pool_verdict = "BEHIND"')"
detect 2026-08-25T16:45:50Z "$P" "$ACTIONS"
assert "pool_verdict=BEHIND is not headroom even at five_hour=0" 0 quiet no_headroom

echo "== 4. three outcomes, not two =="

# (a) measured, and genuinely nothing stranded.
EMPTY="$(printf '' | mk_tsv)"
detect 2026-08-25T16:45:50Z "$(mk_pace 2026-08-25T16:45:37Z)" "$EMPTY"
assert "no active actions at all is quiet — and says WHY" 0 quiet nothing_stranded

# (b) active actions that are FRESH. Not stranded, and not the same answer as
# not having any: an action touched two minutes ago is being worked.
FRESH="$(printf 'act-1\tissue-1\tagent-coo\tPresident\t2026-08-25T16:44:00Z\t1\n' | mk_tsv)"
detect 2026-08-25T16:45:50Z "$(mk_pace 2026-08-25T16:45:37Z)" "$FRESH"
assert "an action touched 2m ago is not stranded" 0 quiet nothing_stranded

# (c) THE BASELINE ACCEPTANCE CASE: stranded work, real headroom, but the
# company is running. Quiet by contract — and loudly so.
P="$(mk_pace 2026-08-25T16:45:37Z '.runs_in_flight = 7')"
detect 2026-08-25T16:45:50Z "$P" "$ACTIONS"
assert "runs_in_flight=7 suppresses the alarm (exit 0)" 0 suppressed runs_in_flight
want_in "suppression prints the counts it swallowed, on stderr" "SUPPRESSED: 38 of 38" "$(cat "$ERRTXT")"
want_in "suppression names its own known false negative" "watchdog" "$(cat "$ERRTXT")"

# runs_in_flight=1 is the boundary, and it is the REAL false negative: on the
# day, the only runs during the dark window were the watchdog's own review
# issues. Pinned so that the contract is explicit rather than incidental.
P="$(mk_pace 2026-08-25T16:45:37Z '.runs_in_flight = 1')"
detect 2026-08-25T16:45:50Z "$P" "$ACTIONS"
assert "a single run in flight suppresses — the known false negative, pinned" 0 suppressed runs_in_flight

# A MISSING runs_in_flight must not read as zero. Reading absence as "nothing
# running" is how this alarm would fire into a busy company.
P="$(mk_pace 2026-08-25T16:45:37Z 'del(.runs_in_flight)')"
detect 2026-08-25T16:45:50Z "$P" "$ACTIONS"
want "a missing runs_in_flight is unknown, not zero (exit 5)" 5 "$RC"

echo "== 5. a check that measured nothing must not read green =="

detect 2026-08-25T16:45:50Z /bin/false "$ACTIONS"
want "an unreadable pace window is exit 5" 5 "$RC"

detect 2026-08-25T16:45:50Z "$(mk_pace 2026-08-25T16:45:37Z)" /bin/false
want "an unreadable recovery source is exit 5, NOT 'zero stranded'" 5 "$RC"

# A pace file whose every line is garbage is an unreadable window, not an
# empty one. Returning nothing here would let the caller read "no headroom".
GARBAGE="$WORK/garbage.sh"
printf '#!/usr/bin/env bash\nprintf "not json\\nalso not json\\n"\n' > "$GARBAGE"; chmod +x "$GARBAGE"
detect 2026-08-25T16:45:50Z "$GARBAGE" "$ACTIONS"
want "a pace window of unparseable lines is exit 5" 5 "$RC"

# RULE 2: a pacer that STOPPED. Its last record says AHEAD forever; a detector
# keyed on the newest record alone stays quiet exactly when the company is
# darkest.
detect 2026-08-25T21:45:50Z "$(mk_pace 2026-08-25T16:45:37Z)" "$ACTIONS"
want "a pace feed 5h stale is exit 5, not 'no headroom'" 5 "$RC"
want_in "the stale-feed refusal says it is not a clean result" "This is NOT" "$(cat "$ERRTXT")"

# The actual frozen outage feed takes the file path (shared-guard) path, not the
# synthetic command seam, and must fail closed before recovery-action logic.
DEAD="$HERE/tests/dead-feed-2026-08-26.jsonl"
ERRTXT="$WORK/dead.err"
OUT="$(env COLD_START_NOW=2026-09-04T16:00:00Z QUOTA_PACING_FILE="$DEAD" PACE_WINDOW_CMD="" \
  RECOVERY_SOURCE_CMD="$ACTIONS" "$TOOL" detect 2>"$ERRTXT")"; RC=$?
want "the real dead feed is UNKNOWN through the shared guard" 5 "$RC"
want "the real dead feed emits no confident detector verdict" "" "$OUT"
want_in "the real dead-feed reason names UNKNOWN" "UNKNOWN" "$(cat "$ERRTXT")"

# An action whose updated_at will not parse cannot be aged. Dropping it would
# make the count silently one short; guessing it is fresh would hide it.
BADTS="$(printf 'act-1\tissue-1\tagent-coo\tPresident\tnot-a-timestamp\t1\n' | mk_tsv)"
detect 2026-08-25T16:45:50Z "$(mk_pace 2026-08-25T16:45:37Z)" "$BADTS"
want "an unparseable action timestamp is exit 5, not a silently shorter count" 5 "$RC"

# An empty leading TSV field must not shift every column left. `IFS=$'\t'
# read` collapses runs of tab because tab is IFS whitespace, so an action with
# no id has its issue id parsed as its id, its owner as its issue, and its
# owner NAME parsed as its timestamp.
#
# ASSERTED ON THE OWNER, NOT ON THE VERDICT, and that distinction was measured
# rather than guessed. Under the shift the timestamp column holds the literal
# `1`, and `date -u -d 1` parses — it means 01:00 today — so the row still
# ages as stale and `detect` still returns cold_with_headroom. The verdict is
# blind to the corruption. What is NOT blind is who the plan then names:
# unshifted the mention targets `agent://agent-coo`, shifted it targets
# `agent://President`, i.e. the re-drive wakes nobody. The mutation gate found
# this: an assertion on the verdict alone stayed green with the translation
# removed.
NOID="$(printf '\tissue-1\tagent-coo\tPresident\t2026-08-25T10:48:17Z\t1\n' | mk_tsv)"
plan "$NOID" 12
want_in "an empty leading TSV field does not shift the columns" "agent://agent-coo" "$PLANOUT"

echo "== 6. the plan is capped, ordered, and says what it withheld =="

plan "$ACTIONS" 12
want "plan exits 0" 0 "$PLANRC"
# Ordering: the owner holding the most stranded issues comes first. On the
# real set that is the President & COO, which is the dispatch owner TOG-487
# asked to prefer — reached from the data, not from a hardcoded role list.
want "one command per owner, not per action" 4 "$(grep -c '^curl' <<<"$PLANOUT")"
want_in "the owner holding the most stranded issues is first" "President" "$(grep -m1 '^# *1\.' <<<"$PLANOUT")"

plan "$ACTIONS" 2
want "--max 2 emits exactly two commands" 2 "$(grep -c '^curl' <<<"$PLANOUT")"
want_in "a truncated plan says how many owners it withheld" "WITHHELD: 2 further owner" "$PLANOUT"

# NOTHING IN plan MAY WRITE. The commands are printed for a human to run; a
# future edit that "helpfully" executes them turns a false positive into the
# storm this tool detects. Asserted on the emitted text, which is the only
# thing a caller can act on.
want "plan prints commands and performs no request of its own" 0 \
  "$(grep -v '^curl -sS -X POST' <<<"$PLANOUT" | grep -cE '^[[:space:]]*(curl|wget)')"

# An action with no owner cannot be woken by mention and must be reported
# rather than dropped.
ORPHAN="$(printf 'act-1\tissue-1\t\t\t2026-08-25T10:48:17Z\t1\nact-2\tissue-2\tagent-coo\tPresident\t2026-08-25T10:48:17Z\t1\n' | mk_tsv)"
plan "$ORPHAN" 12
want_in "an ownerless stranded action is reported, not dropped" "WARNING: 1 stranded action" "$PLANOUT"

echo "== 7. dispatch =="

want "an unknown subcommand is refused (exit 2)" 2 "$(run_rc "$TOOL" bogus)"
want "an unknown detect flag is refused (exit 2)" 2 "$(run_rc "$TOOL" detect --nonsense)"
want "--max 0 is refused" 2 "$(run_rc "$TOOL" plan --max 0)"
want "a non-numeric --max is refused" 2 "$(run_rc "$TOOL" plan --max abc)"
want "--help exits 0" 0 "$(run_rc "$TOOL" --help)"

echo ""
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" == 0 ]] || exit 1
exit 0
