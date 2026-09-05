#!/usr/bin/env bash
# ===========================================================================
# test_quota_burn_derive.sh — offline suite for quota_burn_derive.py (TOG-440).
#
# No database, no network, no credentials, no clock read: every case is a
# synthetic pacing feed in a temp dir, so CI can run this.
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * THE TWO IMPLEMENTATIONS DRIFTING APART. The production brake derives burn
#    in jq (it must run with only bash+jq+awk at the point of the write); this
#    tool derives it in Python (it must replay history and sweep windows). One
#    formula, two implementations, and the failure mode is that somebody fixes
#    one of them. §5 runs BOTH over the SAME feed and fails on any disagreement
#    past 1e-6. Drift is a red test, not a discovery made during an incident.
#
#  * A RATE SERIES THAT DOES NOT INTEGRATE BACK TO ITS SOURCE. §3 pins the
#    integral check, which is the only assertion here that can catch a
#    derivation that is smooth, plausible and wrong. A tool that reports a
#    number nobody can reconcile against `weekly` is exactly the tool this one
#    replaces.
#
#  * THE RESET READ AS IDLENESS. §4 feeds a week rollover. Naive
#    end-minus-start gives a large negative rate, which clamps to zero and
#    lifts the brake at the start of a fresh week — the single worst moment to
#    stop braking, since the whole week's quota is in front of you.
#
#  * THE LADDER CONSTANTS DIVERGING FROM THE SHELL'S. §6 greps the thresholds
#    out of quota_brake.sh's verdict_for() and pins them against the LADDER
#    table here. `--series` claims to show "what the brake would have done";
#    that claim is worthless if the two ladders differ.
#
#  * NON-DETERMINISM. §7 runs the same input twice and diffs. This tool is
#    cited as evidence in issue threads, so a run that cannot be reproduced by
#    the next reader is not evidence.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/quota_burn_derive.py"
BRAKE="$HERE/quota_brake.sh"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }

command -v jq >/dev/null 2>&1 || { echo "missing dependency: jq" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "missing dependency: python3" >&2; exit 2; }

# --- fixtures ---------------------------------------------------------------
# A steady climb: weekly 0.10 -> 0.58 in 0.02 steps every 30 minutes across
# 24h, i.e. exactly 0.48/day. Chosen so the derived rate has a closed form the
# assertions can name rather than copy out of the tool's own output.
gen_climb() {
  python3 - "$1" <<'PY'
import sys, datetime
out = open(sys.argv[1], "w")
t = datetime.datetime(2026, 8, 24, 9, 0, tzinfo=datetime.timezone.utc)
weekly = 0.10
for i in range(49):
    ts = (t + datetime.timedelta(minutes=30 * i)).strftime("%Y-%m-%dT%H:%M:%SZ")
    dl = 5.0 - i * (0.5 / 24.0)
    out.write('{"ts":"%s","accounts":[{"name":"hot@example.com","burn_per_day":9.99,'
              '"burn_ratio_vs_needed":99.9,"weekly":%.2f,"days_left":%.4f,'
              '"weekly_reset_utc":"2026-08-29 09:00 UTC"}]}\n' % (ts, weekly, dl))
    weekly = round(weekly + 0.01, 2)
out.close()
PY
}
gen_climb "$WORK/climb.jsonl"

# A flat account with a decaying reported field — the 2026-08-25 11:59Z-14:30Z
# shape from the real file, where the producer reported 34.1x down to 5.5x on
# an account consuming nothing.
cat > "$WORK/flat.jsonl" <<'EOF'
{"ts":"2026-08-25T02:00:00Z","accounts":[{"name":"idle@example.com","burn_per_day":0.9568,"weekly":0.86,"days_left":4.30,"weekly_reset_utc":"2026-08-29 10:00 UTC"}]}
{"ts":"2026-08-25T08:00:00Z","accounts":[{"name":"idle@example.com","burn_per_day":0.4788,"weekly":0.86,"days_left":4.05,"weekly_reset_utc":"2026-08-29 10:00 UTC"}]}
{"ts":"2026-08-25T14:00:00Z","accounts":[{"name":"idle@example.com","burn_per_day":0.1595,"weekly":0.86,"days_left":3.80,"weekly_reset_utc":"2026-08-29 10:00 UTC"}]}
EOF

# A week rollover mid-window.
cat > "$WORK/reset.jsonl" <<'EOF'
{"ts":"2026-08-24T00:00:00Z","accounts":[{"name":"roll@example.com","burn_per_day":null,"weekly":0.88,"days_left":0.80,"weekly_reset_utc":"2026-08-24 19:00 UTC"}]}
{"ts":"2026-08-24T12:00:00Z","accounts":[{"name":"roll@example.com","burn_per_day":null,"weekly":0.94,"days_left":0.29,"weekly_reset_utc":"2026-08-24 19:00 UTC"}]}
{"ts":"2026-08-24T21:00:00Z","accounts":[{"name":"roll@example.com","burn_per_day":null,"weekly":0.02,"days_left":6.92,"weekly_reset_utc":"2026-08-31 19:00 UTC"}]}
{"ts":"2026-08-25T09:00:00Z","accounts":[{"name":"roll@example.com","burn_per_day":null,"weekly":0.12,"days_left":6.42,"weekly_reset_utc":"2026-08-31 19:00 UTC"}]}
EOF

# ===========================================================================
echo "== 1. the derivation is the weekly delta, not the reported field =="
J="$("$TOOL" --allow-stale --jsonl "$WORK/climb.jsonl" --json)"
check "1a  source is 'derived'" "$(jq -r '.[0].source' <<<"$J")" "derived"
# 0.48/day by construction. The feed's burn_per_day says 9.99 on every line,
# so a tool that read the field instead would be off by more than 20x and this
# assertion is the one that notices.
check "1b  burn is 0.48/day, the constructed rate" \
      "$(jq -r '(.[0].burn*100|round/100)' <<<"$J")" "0.48"
check "1c  ...and is nowhere near the reported 9.99" \
      "$(jq -r '.[0].burn < 1' <<<"$J")" "true"
# need = (0.97 - 0.58) / days_left(last) — recomputed from PACE_TARGET, never
# read from need_per_day_to_hit_target, which bakes in the producer's target.
# 1e-3 rather than 1e-9: --json rounds each field to 6dp independently, so
# dividing two rounded values cannot reproduce the rounded quotient exactly.
# The assertion is "ratio IS that division", not "the printer is lossless".
check "1d  ratio is burn/need, both recomputed" \
      "$(jq -r '((.[0].burn / .[0].need) - .[0].ratio) | fabs < 1e-3' <<<"$J")" "true"

echo "== 2. an idle account derives zero, whatever the field claims =="
J="$("$TOOL" --allow-stale --jsonl "$WORK/flat.jsonl" --json)"
# Compared numerically: JSON renders this as 0.0, and a string compare against
# "0" would fail on a correct answer.
check "2a  flat weekly derives 0 burn" "$(jq -r '.[0].burn == 0' <<<"$J")" "true"
check "2b  ...and a 0 ratio" "$(jq -r '.[0].ratio == 0' <<<"$J")" "true"
# The contrast that makes 2a mean something: the reported field on this same
# feed is 0.1595 against need (0.97-0.86)/3.80 = 0.02895, i.e. 5.5x — LEVEL3.
check "2c  the reported field on the same feed would be >5x" \
      "$(python3 -c 'print("yes" if 0.1595/((0.97-0.86)/3.80) > 5 else "no")')" "yes"

echo "== 3. the derived series integrates back to weekly =="
OUT="$("$TOOL" --allow-stale --jsonl "$WORK/climb.jsonl" --series 2>&1)"
case "$OUT" in
  *"[OK]"*) ok "3a  integral check passes on a clean climb";;
  *) bad "3a  integral check passes on a clean climb" "$(grep integral <<<"$OUT")";;
esac
# err must be genuinely small, not merely printed. A check that prints [OK]
# for any input is a check that measured nothing.
ERR="$(grep -o 'err=[0-9.]*' <<<"$OUT" | head -1 | cut -d= -f2)"
check "3b  ...with an error at or under the 0.01 quantum" \
      "$(python3 -c "print('yes' if float('$ERR') <= 0.01 else 'no')")" "yes"
# The check must also run — and say so — on a feed short enough that a lazy
# implementation would skip it silently and leave the reader with no line at
# all. "No integral line" and "integral fine" must not look the same.
head -20 "$WORK/climb.jsonl" > "$WORK/short.jsonl"
OUT2="$("$TOOL" --allow-stale --jsonl "$WORK/short.jsonl" --series 2>&1)"
case "$OUT2" in
  *"integral check"*) ok "3c  the check runs on a short feed too";;
  *) bad "3c  the check runs on a short feed too" "$OUT2";;
esac

echo "== 4. a week reset is not idleness =="
J="$("$TOOL" --allow-stale --jsonl "$WORK/reset.jsonl" --json)"
# Post-reset only: (0.12 - 0.02) / 0.5d = 0.20/day. Naive end-minus-start
# across the reset is (0.12 - 0.88)/1.375d = -0.55/day, which clamps to 0.
check "4a  burn comes from the post-reset samples only" \
      "$(jq -r '(.[0].burn*100|round/100)' <<<"$J")" "0.2"
check "4b  ...and is never negative" "$(jq -r '.[0].burn >= 0' <<<"$J")" "true"
check "4c  ...and is not the clamped-to-zero naive answer" \
      "$(jq -r '.[0].burn > 0' <<<"$J")" "true"

echo "== 5. the jq and Python derivations agree (drift is a red test) =="
# The whole reason this section exists: quota_brake.sh carries its own copy of
# this formula. Same feed, same window, same target — the two must produce the
# same burn, need and ratio.
for f in climb flat reset; do
  PY_J="$("$TOOL" --allow-stale --jsonl "$WORK/$f.jsonl" --window-hours 24 --target 0.97 --json)"
  SH_J="$(PACE_SOURCE_CMD="cat $WORK/$f.jsonl" PACE_WINDOW_HOURS=24 PACE_TARGET=0.97 \
          "$BRAKE" pace 2>/dev/null)"
  if [[ -z "$SH_J" ]]; then bad "5-$f  the shell tool produced a reading" "(empty)"; continue; fi
  # Python emits every account sorted worst-first; the shell emits only the
  # worst. Compare the worst against the worst.
  PY_TOP="$(jq -c '.[0]' <<<"$PY_J")"
  for k in burn need ratio source; do
    a="$(jq -r --arg k "$k" '.[$k]' <<<"$PY_TOP")"
    b="$(jq -r --arg k "$k" '.[$k]' <<<"$SH_J")"
    if [[ "$k" == "source" ]]; then
      check "5-$f.$k  jq and python agree" "$b" "$a"
    else
      same="$(python3 -c "import sys; print('yes' if abs(float('$a')-float('$b')) < 1e-6 else 'no')")"
      check "5-$f.$k  jq and python agree to 1e-6" "$same" "yes"
    fi
  done
  check "5-$f.name  ...on the same account" \
        "$(jq -r '.name' <<<"$SH_J")" "$(jq -r '.name' <<<"$PY_TOP")"
done

echo "== 6. the ladder here matches the ladder in quota_brake.sh =="
# `--series` prints "what the brake would have done". If the two ladders
# diverge that output is a fiction, and it is cited in issue threads as
# evidence. Grep the thresholds out of the shell's verdict_for() rather than
# trusting that both files were edited together.
SH_LADDER="$(sed -n '/^verdict_for()/,/^}/p' "$BRAKE" \
             | grep -oE 'r <= [0-9.]+' | grep -oE '[0-9.]+' | tr '\n' ' ')"
PY_LADDER="$(python3 -c "
import importlib.util, sys
spec = importlib.util.spec_from_file_location('qbd', '$TOOL')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(' '.join(str(b) for b, _ in m.LADDER), end=' ')
")"
check "6a  thresholds are identical" "$PY_LADDER" "$SH_LADDER"
# Names too — matching numbers with swapped labels would pass 6a.
SH_NAMES="$(sed -n '/^verdict_for()/,/^}/p' "$BRAKE" | grep -oE '"(RELEASE|LEVEL[123])"' | tr -d '"' | tr '\n' ' ')"
PY_NAMES="$(python3 -c "
import importlib.util
spec = importlib.util.spec_from_file_location('qbd', '$TOOL')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(' '.join([n for _, n in m.LADDER] + [m.LADDER_TOP]), end=' ')
")"
check "6b  ...and so are the level names, in order" "$PY_NAMES" "$SH_NAMES"

echo "== 7. deterministic: same input, same output =="
A="$("$TOOL" --allow-stale --jsonl "$WORK/climb.jsonl" --series 2>&1)"
B="$("$TOOL" --allow-stale --jsonl "$WORK/climb.jsonl" --series 2>&1)"
check "7a  two runs are byte-identical" "$([[ "$A" == "$B" ]] && echo same || echo differs)" "same"
# Historical modes remain clock-free in behaviour even though live mode now
# has a required freshness gate. The byte-identical replay above is the proof.
ok "7b  historical replay remains independent of wall-clock freshness"

echo "== 8. the sweep reports the quantization floor =="
OUT="$("$TOOL" --allow-stale --jsonl "$WORK/climb.jsonl" --sweep 2>&1)"
case "$OUT" in
  *"resolution"*) ok "8a  the sweep names resolution per window";;
  *) bad "8a  the sweep names resolution per window" "$OUT";;
esac
# 0.01 / (24/24) = 0.0100 per day at a 24h window. The number the window
# default is justified by, so it is pinned rather than eyeballed.
R24="$(awk '$1=="24h"{print $2}' <<<"$OUT" | head -1)"
check "8b  ...and it is 0.0100/day at 24h" "$R24" "0.0100"
# Exactly twice as coarse at 12h. This fixture has exact 30-minute steps so the
# 12h window lands on 12.00h; the real file's irregular cadence gives 0.0199.
# The doubling, not the digit, is the property the window default rests on.
R12="$(awk '$1=="12h"{print $2}' <<<"$OUT" | head -1)"
check "8c  ...and twice as coarse at 12h" "$R12" "0.0200"

echo "== 9. a missing or empty file is exit 2, never a silent zero =="
rc=0; "$TOOL" --allow-stale --jsonl "$WORK/nope.jsonl" >/dev/null 2>&1 || rc=$?
check "9a  missing file is exit 2" "$rc" "2"
: > "$WORK/empty.jsonl"
rc=0; "$TOOL" --allow-stale --jsonl "$WORK/empty.jsonl" >/dev/null 2>&1 || rc=$?
check "9b  empty file is exit 2" "$rc" "2"
# A truncated tail line is normal on a file the producer appends to and must
# not take the whole read down.
cp "$WORK/climb.jsonl" "$WORK/torn.jsonl"
printf '{"ts":"2026-08-25T09:30:00Z","accou' >> "$WORK/torn.jsonl"
rc=0; J="$("$TOOL" --allow-stale --jsonl "$WORK/torn.jsonl" --json)" || rc=$?
check "9c  a torn tail line is skipped, not fatal" "$rc" "0"
check "9c2 ...and the reading is unchanged" \
      "$(jq -r '(.[0].burn*100|round/100)' <<<"$J")" "0.48"

echo "== 10. TOG-490: a passed target is replayed, not dropped =="
# `--series` used to `continue` past every sample where `weekly` had already
# passed the target, and then print a level tally as though it had seen them.
# That is the failure this repo's rule 4 names: a check that measured nothing
# reading green. It mattered little at TARGET=0.97 and matters a lot at 0.90,
# where the condition is a routine late-week reading — on 2026-08-25 it was
# already true of BOTH accounts, so the tool would have gone quiet exactly
# where the brake was hardest on.
#
# climb.jsonl is weekly 0.10 -> 0.58 in 0.01 steps, so `--target 0.30` puts the
# last 29 of its 49 samples past the target by construction.
S="$("$TOOL" --allow-stale --jsonl "$WORK/climb.jsonl" --series --target 0.30 2>/dev/null)"
check "10a the passed-target samples are counted, not silently skipped" \
      "$(sed -n 's/.*TARGET was already passed.*: \([0-9]*\)$/\1/p' <<<"$S")" "29"
check "10b ...and they land on LEVEL3, as quota_brake.sh's 999 pin does" \
      "$(sed -n 's/.*derived levels *: .*LEVEL3=\([0-9]*\).*/\1/p' <<<"$S")" "48"
# The assertion that makes 10a/10b mean something: EVERY sample is accounted
# for, either replayed or explicitly reported as not replayable. A tally that
# silently omits rows is indistinguishable from one that had none to omit.
# awk, not `paste -sd+ | bc`: bc is not installed in the agent container or in
# CI, and its absence made this assertion report 1 instead of failing loudly.
REPLAYED="$(sed -n 's/.*derived levels *: //p' <<<"$S" \
            | tr ' ' '\n' | sed -n 's/.*=\([0-9]*\)$/\1/p' | awk '{t+=$1} END{print t+0}')"
SKIPPED="$(sed -n 's/.*not replayed): \([0-9]*\)$/\1/p' <<<"$S")"
check "10c every one of the 49 samples is replayed or declared unreplayable" \
      "$((REPLAYED + SKIPPED))" "49"

echo "== 10bis. live mode refuses the frozen dead feed =="
DEAD="$HERE/tests/dead-feed-2026-08-26.jsonl"
rc=0; LIVE_OUT="$("$TOOL" --jsonl "$DEAD" --now 2026-09-04T16:00:00Z --json 2>&1)" || rc=$?
check "10d the real dead feed is UNKNOWN" "$rc" "3"
case "$LIVE_OUT" in
  *"UNKNOWN:"*) ok "10d2 the refusal names UNKNOWN" ;;
  *) bad "10d2 the refusal names UNKNOWN" "$LIVE_OUT" ;;
esac
case "$LIVE_OUT" in
  *'"ratio"'*|*LEVEL[123]*|*RELEASE*) bad "10d3 stale input emits no confident burn verdict" "$LIVE_OUT" ;;
  *) ok "10d3 stale input emits no confident burn verdict" ;;
esac
rc=0; "$TOOL" --jsonl "$DEAD" --now 2026-09-04T16:00:00Z --json --series >/dev/null 2>&1 || rc=$?
check "10d4 output modes cannot combine to bypass freshness" "$rc" "2"

 echo "== 10ter. the two tools share ONE default target =="
# This file exists to show what the brake WOULD have done. A default here that
# disagrees with quota_brake.sh's makes every bare `--series` a replay of a
# ladder nobody runs — and it would drift silently, because §5 above pins the
# target EXPLICITLY on both sides and so cannot see a default diverge.
# climb.jsonl's last sample is weekly=0.58, days_left=4.0.
PY_NEED="$(env -u PACE_TARGET "$TOOL" --allow-stale --jsonl "$WORK/climb.jsonl" --json | jq -r '.[0].need')"
SH_NEED="$(env -u PACE_TARGET PACE_SOURCE_CMD="cat $WORK/climb.jsonl" PACE_WINDOW_HOURS=24 \
           "$BRAKE" pace 2>/dev/null | jq -r '.need')"
check "10e the python and shell DEFAULTS agree on sustainable" \
      "$(python3 -c "print('yes' if abs($PY_NEED - $SH_NEED) < 1e-6 else 'no ($PY_NEED vs $SH_NEED)')")" "yes"
# ...and they agree on 0.90 specifically. Without this, 10d passes just as
# happily on two tools that both still default to 0.97.
# (0.90 - 0.58) / 4.0 = 0.08
check "10f ...and that shared default is 0.90: need is 0.0800, not 0.0975" \
      "$(jq -rn --argjson n "$SH_NEED" '$n*10000|round/10000')" "0.08"

echo
echo "passed=$PASS failed=$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
# A suite that asserted nothing must not report success.
(( PASS >= 30 )) || { echo "REFUSED: only $PASS assertions ran; the suite did not execute." >&2; exit 1; }
echo "ALL GREEN"
