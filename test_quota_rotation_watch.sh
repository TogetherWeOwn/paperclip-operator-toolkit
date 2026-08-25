#!/usr/bin/env bash
# ===========================================================================
# test_quota_rotation_watch.sh — offline suite for quota_rotation_watch.py
# (TOG-425).
#
# No database, no network, no credentials: every case is a synthetic
# quota-pacing feed written into a temp dir, so CI can run this.
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * THE LYING FIELD. `is_current` does not track which account is serving.
#    Section 2 feeds a case where `is_current` points at the IDLE account the
#    whole time -- exactly the shape measured on 2026-08-24T15:07Z -- and
#    asserts the verdict still follows the burn delta. A watcher rewritten to
#    read `is_current` (which is what TOG-425 step 2 literally asks for)
#    fails here.
#
#  * THE WRONG THRESHOLD. 0.95 is OUR pause gate; 0.98 is teamclaude's
#    `switchThreshold`. Section 3 pins a feed that peaks at 0.96: conclusive
#    at 0.95, invisible at 0.98. Silently watching our own brake and calling
#    it their rotation is the single easiest way to get this wrong.
#
#  * A MONITOR THAT READS GREEN WHILE BLIND. Sections 4 and 5 assert that a
#    feed with no episode, and an episode with an idle fleet, exit 4 -- never
#    0. Zero rotations observed from zero traffic is "never ran", not "works".
#
#  * A DEFECT REPORTED AS A PASS. Section 6 pins the failure direction: a
#    spent account that keeps burning must exit 3 and say NO_ROTATION.
#
#  * A SPLIT EPISODE. The feed emits `five_hour: null` while a bucket rolls
#    over. Section 7 asserts a null in the middle does not cut one episode
#    into two sub-minimum halves that both get dropped.
#
#  * ADJACENCY. Exit codes alone would let a refusal from the wrong branch
#    read as a pass, so every assertion below pins the VERDICT string too.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/quota_rotation_watch.py"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# sample <file> <ts> <runs> <r_5h> <r_wk> <r_cur> <p_5h> <p_wk> <p_cur>
# `null` is passed through unquoted so the JSON carries a real null.
sample() {
  local f=$1 ts=$2 runs=$3 r5=$4 rw=$5 rc=$6 p5=$7 pw=$8 pc=$9
  printf '{"ts":"%s","runs_in_flight":%s,"accounts":[' "$ts" "$runs" >>"$f"
  printf '{"name":"1856877+Rick7C2@users.noreply.github.com","five_hour":%s,"weekly":%s,"is_current":%s},' "$r5" "$rw" "$rc" >>"$f"
  printf '{"name":"pisnrzrs@two.gg","five_hour":%s,"weekly":%s,"is_current":%s}]}\n' "$p5" "$pw" "$pc" >>"$f"
}

# run <file> [extra args...] -> sets OUT and CODE
run() {
  local f=$1; shift
  OUT="$(python3 "$TOOL" --jsonl "$f" "$@" 2>&1)"; CODE=$?
}

assert() { # assert <label> <want_code> <want_substr>
  local label=$1 want=$2 substr=$3
  if [ "$CODE" -ne "$want" ]; then
    bad "$label" "exit $CODE, wanted $want"
  elif ! grep -q -- "$substr" <<<"$OUT"; then
    bad "$label" "output missing '$substr'"
  else
    ok "$label"
  fi
}

echo "== 1. the real shape: spent account freezes, the other absorbs =="
F="$WORK/rotate.jsonl"; : >"$F"
sample "$F" 2026-08-24T15:40:00Z 12 0.73 0.35 false 0    0.73 true
sample "$F" 2026-08-24T15:55:00Z 7  0.86 0.36 false 0    0.73 true
sample "$F" 2026-08-24T16:10:00Z 8  0.98 0.38 false 0.06 0.74 true
sample "$F" 2026-08-24T16:25:00Z 11 0.98 0.38 false 0.24 0.75 true
sample "$F" 2026-08-24T16:40:00Z 3  0.99 0.38 false 0.42 0.77 true
sample "$F" 2026-08-24T16:55:00Z 2  1.0  0.38 false 0.44 0.78 true
run "$F"
assert "rotation is detected"            0 "ROTATED"
assert "and named on the 5h bucket"      0 "spent on five_hour"

echo "== 2. THE LYING FIELD: is_current points at the idle account throughout =="
# rick burns 0.28 -> 0.38 with is_current=false; pisnrzrs is is_current=true
# and burns nothing. A watcher keyed on is_current reports the opposite.
F="$WORK/liar.jsonl"; : >"$F"
sample "$F" 2026-08-24T15:07:00Z 11 0.04 0.28 false 0    0.73 true
sample "$F" 2026-08-24T15:25:00Z 17 0.48 0.32 false 0    0.73 true
sample "$F" 2026-08-24T15:55:00Z 7  0.86 0.36 false 0    0.73 true
sample "$F" 2026-08-24T16:10:00Z 8  0.98 0.38 false 0.06 0.74 true
sample "$F" 2026-08-24T16:40:00Z 3  0.99 0.38 false 0.42 0.77 true
run "$F"
assert "verdict follows burn, not is_current" 0 "ROTATED"
# The spent account must be the one that was BURNING (rick), even though
# is_current said pisnrzrs the whole time.
if grep -q "1856877+Rick7C2@users.noreply.github.com spent" <<<"$OUT"; then
  ok "the burning account is the one reported spent"
else
  bad "the burning account is the one reported spent" "$(grep -m1 spent <<<"$OUT")"
fi

# The case above is necessary but NOT sufficient: inside that episode the
# spent account is both non-burning AND non-current, so burn and is_current
# happen to agree and a watcher keyed on the wrong one still passes. This
# second feed makes them DISAGREE inside the episode -- the spent account
# carries is_current=true throughout while the other one does all the burning
# (the field lags a switch by up to a sample, measured 2026-08-24T20:11Z).
# Burn says ROTATED; is_current says the spent account is still serving.
F="$WORK/liar2.jsonl"; : >"$F"
sample "$F" 2026-08-24T16:10:00Z 8 0.98 0.38 true 0.06 0.74 false
sample "$F" 2026-08-24T16:25:00Z 9 0.99 0.38 true 0.24 0.75 false
sample "$F" 2026-08-24T16:40:00Z 9 1.0  0.38 true 0.42 0.77 false
run "$F"
assert "burn wins when is_current CONTRADICTS it" 0 "ROTATED"

echo "== 3. THE WRONG THRESHOLD: 0.95 is our gate, 0.98 is theirs =="
F="$WORK/thresh.jsonl"; : >"$F"
sample "$F" 2026-08-24T16:10:00Z 8 0.96 0.38 false 0    0.73 true
sample "$F" 2026-08-24T16:25:00Z 9 0.96 0.38 false 0.20 0.75 true
sample "$F" 2026-08-24T16:40:00Z 9 0.96 0.38 false 0.40 0.77 true
run "$F"
assert "a 0.96 peak is INVISIBLE at teamclaude's 0.98" 4 "NOT_OBSERVED"
run "$F" --threshold 0.95
assert "the same feed is conclusive at our 0.95 gate"  0 "ROTATED"

echo "== 4. nothing ever reached the threshold: NOT a pass =="
F="$WORK/quiet.jsonl"; : >"$F"
sample "$F" 2026-08-25T08:58:00Z 1 0.34 0.61 true 0 0.78 false
sample "$F" 2026-08-25T09:13:00Z 3 0.37 0.61 true 0 0.78 false
run "$F"
assert "no episode exits 4, not 0"        4 "NOT_OBSERVED"
assert "and says so in words"             4 "NOT evidence that rotation works"
run "$F" --window-close 2026-08-29T10:00:00Z --now 2026-08-30T00:00:00Z
assert "past the window it is EXPIRED"    5 "EXPIRED"
run "$F" --window-close 2026-08-29T10:00:00Z --now 2026-08-26T00:00:00Z
assert "inside the window it is not yet"  4 "NOT_OBSERVED"

echo "== 5. spent, but the fleet was idle: proves nothing =="
F="$WORK/idle.jsonl"; : >"$F"
sample "$F" 2026-08-24T17:25:00Z 0 1.0 0.38 false 0.44 0.78 true
sample "$F" 2026-08-24T17:40:00Z 0 1.0 0.38 false 0.44 0.78 true
sample "$F" 2026-08-24T17:55:00Z 0 1.0 0.38 false 0.44 0.78 true
run "$F"
assert "idle fleet is INCONCLUSIVE_IDLE"  4 "INCONCLUSIVE_IDLE"
assert "and never reads as a rotation"    4 "OVERALL: NOT_OBSERVED"

echo "== 6. the defect direction: spent account keeps burning =="
F="$WORK/defect.jsonl"; : >"$F"
sample "$F" 2026-08-26T08:00:00Z 6 0.50 0.98 true 0 0.78 false
sample "$F" 2026-08-26T08:15:00Z 6 0.52 0.99 true 0 0.78 false
sample "$F" 2026-08-26T08:30:00Z 6 0.55 1.00 true 0 0.78 false
run "$F"
assert "a spent account still burning exits 3" 3 "NO_ROTATION"
assert "named as a defect to report"           3 "DEFECT"
assert "detected on the weekly bucket"         3 "spent on weekly"

echo "== 7. a null bucket must not split one episode in two =="
# 4 samples >= 0.98 with a null in the middle. With --min-samples 4 the
# episode only survives if the null is treated as neutral.
F="$WORK/null.jsonl"; : >"$F"
sample "$F" 2026-08-24T18:00:00Z 5 0.99 0.38 false 0.10 0.74 true
sample "$F" 2026-08-24T18:15:00Z 5 1.0  0.38 false 0.20 0.75 true
sample "$F" 2026-08-24T18:30:00Z 5 null 0.38 false 0.30 0.76 true
sample "$F" 2026-08-24T18:45:00Z 5 1.0  0.38 false 0.40 0.77 true
sample "$F" 2026-08-24T19:00:00Z 5 1.0  0.38 false 0.44 0.78 true
run "$F" --min-samples 4
assert "null is neutral, episode stays whole" 0 "ROTATED"

echo "== 8. unreadable input fails loudly, never green =="
run "$WORK/does-not-exist.jsonl"
assert "missing file exits 2"             2 "FATAL"
: >"$WORK/empty.jsonl"
run "$WORK/empty.jsonl"
assert "empty file exits 2, not 0"        2 "NOT a pass"
printf 'not json at all\n{"ts":"bogus"}\n' >"$WORK/junk.jsonl"
run "$WORK/junk.jsonl"
assert "all-unparseable exits 2"          2 "FATAL"

echo "== 9. determinism and the JSON contract =="
run "$WORK/rotate.jsonl" --json
A="$OUT"
run "$WORK/rotate.jsonl" --json
if [ "$A" = "$OUT" ] && [ -n "$A" ]; then ok "same input, byte-identical output"
else bad "same input, byte-identical output" "outputs differed"; fi
if python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
assert d['overall']=='ROTATED', d['overall']
assert d['exit']==0
assert d['episodes'][0]['bucket']=='five_hour'
assert d['episodes'][0]['spent_weekly_delta']==0.0
" <<<"$OUT" 2>/dev/null; then ok "JSON carries verdict, bucket and deltas"
else bad "JSON carries verdict, bucket and deltas" "schema assertion failed"; fi

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
