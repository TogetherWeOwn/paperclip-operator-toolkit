#!/usr/bin/env bash
# =====================================================================================
# cold-start-detector-mutation-gate.sh — proof that test_cold_start_detector.sh is not vacuous.
#
# The detector's whole value is that it refuses to guess: a null five-hour reading is
# not zero, a stopped pacer is not "no headroom", an unreadable source is not "nothing
# stranded". Every one of those refusals is a limb that a reasonable person would
# simplify away, and each simplification leaves a suite that still passes unless a case
# is specifically pinned to it.
#
# So each mutation below removes exactly ONE limb from a staged copy of the detector and
# asserts that the NAMED cases go red. The unmutated copy is asserted green FIRST, in
# the same staging directory: "the mutated suite failed" is unattributable without it —
# a staging error produces the same red.
#
#   ./verification/cold-start-detector-mutation-gate.sh
#
# Exit 0 = every mutation was detected by the case that claims to cover it.
# =====================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
SRC="$ROOT/cold_start_detector.sh"
SUITE="$ROOT/test_cold_start_detector.sh"
[ -f "$SRC" ]   || { echo "FATAL: cannot find cold_start_detector.sh above $HERE" >&2; exit 4; }
[ -f "$SUITE" ] || { echo "FATAL: cannot find test_cold_start_detector.sh above $HERE" >&2; exit 4; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$SRC" "$STAGE/cold_start_detector.sh"
cp "$SUITE" "$STAGE/test_cold_start_detector.sh"
cp "$ROOT/pacing_verdict.py" "$STAGE/pacing_verdict.py"
mkdir -p "$STAGE/tests"
cp "$ROOT/tests/dead-feed-2026-08-26.jsonl" "$STAGE/tests/"
chmod +x "$STAGE"/*.sh "$STAGE/pacing_verdict.py"

pass=0; fail=0
red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }

# --- BASELINE. Without this, every "the mutated suite went red" below is unattributable.
echo "=== baseline: the UNMUTATED copy passes in this same staging directory ==="
base_out="$("$STAGE/test_cold_start_detector.sh" 2>&1)" && base_rc=0 || base_rc=$?
if [ "$base_rc" = "0" ]; then
  grn "  PASS  unmutated copy: suite green in $STAGE"; pass=$((pass+1))
else
  red "  FAIL  unmutated copy is ALREADY RED (rc=$base_rc) — every mutation below would"
  red "        go red for that reason instead of the mutation. Staging is broken."
  printf '%s\n' "$base_out" | grep -E '^\s+FAIL' || true
  exit 1
fi
# A suite that scored zero assertions is not a green suite.
if grep -qE '^0 passed' <<<"$base_out"; then
  red "  FAIL  baseline ran ZERO assertions — nothing below could be detected"; exit 1
else
  grn "  PASS  baseline ran $(printf '%s' "$base_out" | grep -oE '^[0-9]+ passed' | head -1)"; pass=$((pass+1))
fi
echo

# mutate <name> <old-literal> <new-literal> <case-that-must-go-red>...
#
# The trailing arguments are case NAMES that must flip to FAIL. A mutation that merely
# makes the suite red SOMEWHERE is not evidence for the case under test — that is how a
# gate passes while the case it names covers nothing.
mutate() {
  local name="$1" old="$2" new="$3"; shift 3
  cp "$SRC" "$STAGE/cold_start_detector.sh"; chmod +x "$STAGE/cold_start_detector.sh"
  OLD="$old" NEW="$new" F="$STAGE/cold_start_detector.sh" python3 - <<'PY' || { red "  FAIL  $name: mutation did not apply"; fail=$((fail+1)); return; }
import os, sys
f = os.environ["F"]; old = os.environ["OLD"]; new = os.environ["NEW"]
s = open(f).read()
if s.count(old) != 1:
    print(f"mutation target appears {s.count(old)} times, expected exactly 1", file=sys.stderr)
    sys.exit(1)
open(f, "w").write(s.replace(old, new))
PY
  local out rc=0
  out="$("$STAGE/test_cold_start_detector.sh" 2>&1)" || rc=$?
  if [ "$rc" = "0" ]; then
    red "  FAIL  $name: suite stayed GREEN with this limb removed — nothing covers it"
    fail=$((fail+1)); return
  fi
  local case_name ok=1
  for case_name in "$@"; do
    if grep -qF "FAIL $case_name" <<<"$out"; then :; else
      red "  FAIL  $name: suite went red, but NOT on the case that claims to cover it:"
      red "        expected a red on: $case_name"
      ok=0
    fi
  done
  if [ "$ok" = "1" ]; then grn "  PASS  $name"; pass=$((pass+1)); else fail=$((fail+1)); fi
}

echo "=== each limb of the detector, removed one at a time ==="

# 1. THE ONE THAT MATTERS MOST. `[[ "" -eq 0 ]]` is true in bash, and the real feed
#    carries `five_hour: null` twice inside the window this tool exists to read. A
#    detector that coalesces the null to zero fires 45 minutes early on missing data.
mutate "a null five_hour coalesced to zero" \
  'elif ($f | map(select(type=="number" and . <= $lim)) | length) > 0 then "yes"' \
  'elif ($f | map(select((. // 0) <= $lim)) | length) > 0 then "yes"' \
  "15:00:11Z (five_hour=[1,null]) is NOT headroom"

# 2. The same hole on the other side: if no account reported a number at all, the input
#    the alarm turns on was never measured.
mutate "an all-null window treated as measured" \
  'if ($f | map(select(type=="number")) | length) == 0 then "unmeasured"' \
  'if false then "unmeasured"' \
  "no account with a numeric five_hour is unknown, not quiet (exit 5)" \
  "a stringified five_hour is not a numeric reading (exit 5)"

# 3. A missing runs_in_flight defaulted to zero. This is the one that would fire the
#    alarm INTO a busy company, which is how a monitor gets muted.
mutate "a missing runs_in_flight defaulted to zero" \
  'PACE_INFLIGHT="$(jq -r '"'"'if (.runs_in_flight | type) == "number" then (.runs_in_flight|floor) else "" end'"'"' <<<"$newest")"' \
  'PACE_INFLIGHT="$(jq -r '"'"'(.runs_in_flight // 0) | floor'"'"' <<<"$newest")"' \
  "a missing runs_in_flight is unknown, not zero (exit 5)"

# 4. An unreadable recovery source falling through to an empty list. Zero stranded
#    actions counted from a source that never answered is "never ran", not "clean".
mutate "an unreadable recovery source read as zero stranded" \
  '    || unknown "cannot read the recovery actions (RECOVERY_SOURCE_CMD or lib/pcsql.sh) — nothing was examined."' \
  '    || rows=""' \
  "an unreadable recovery source is exit 5, NOT 'zero stranded'"

# 5. The dead-feed gate. A pacer that stopped mid-outage leaves a last record that says
#    THROTTLE forever; without this gate the detector stays quiet exactly when the
#    company is darkest.
mutate "the stale-pace-feed gate removed" \
  'if (( age_min > PACER_MAX_AGE_MIN )); then' \
  'if false; then' \
  "a pace feed 5h stale is exit 5, not 'no headroom'"

# 6. The hold requirement. One sample of a five-hour window at 0 between two throttled
#    samples is a blip, not a recovery.
mutate "the headroom-must-have-held floor removed" \
  '  elif (( HEADROOM_MIN_HELD < HEADROOM_MIN_MINUTES )); then' \
  '  elif false; then' \
  "the first headroom sample alone is warming, not an alarm" \
  "15m of headroom is still short of the 20m floor"

# 7. The suppression gate itself — the detector's stated contract. Pinned so that removing it
#    is a red build rather than a behaviour change nobody notices.
mutate "the runs_in_flight suppression removed" \
  '  elif (( PACE_INFLIGHT > 0 )); then' \
  '  elif false; then' \
  "runs_in_flight=7 suppresses the alarm (exit 0)" \
  "a single run in flight suppresses — the known false negative, pinned"

# 8. The staleness threshold. Without it every active action counts as stranded and the
#    alarm fires on work that is being done right now.
mutate "the action staleness threshold removed" \
  '    if (( u < cutoff )); then' \
  '    if true; then' \
  "an action touched 2m ago is not stranded"

# 9. `IFS=$'\t' read` instead of the separator translation. Tab is IFS whitespace, so
#    bash collapses runs of it and an empty leading field shifts every column left.
mutate "TSV split reverted to IFS=tab" \
  'tsv_read() { local l="$1"; shift; IFS=$'"'"'\x1f'"'"' read -r "$@" <<<"${l//$'"'"'\t'"'"'/$'"'"'\x1f'"'"'}"; }' \
  'tsv_read() { local l="$1"; shift; IFS=$'"'"'\t'"'"' read -r "$@" <<<"$l"; }' \
  "an empty leading TSV field does not shift the columns"

# 10. NO SILENT CAPS. A plan that truncates without saying so reads as full coverage of
#     the outage, which is how twelve of forty owners look like all of them.
mutate "the WITHHELD notice removed from a capped plan" \
  '    echo "# WITHHELD: $(( ${#owners[@]} - cap )) further owner(s) are NOT in this plan. Re-run after these land."' \
  '    :' \
  "a truncated plan says how many owners it withheld"

echo
echo "$pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
exit 0
