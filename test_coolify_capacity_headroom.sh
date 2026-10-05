#!/usr/bin/env bash
# ===========================================================================
# test_coolify_capacity_headroom.sh — offline suite for the Coolify
# decommission capacity check.
#
# No network, no host, no credential, no gh call: every sample below is a
# fabricated jobs array written under mktemp, with runner names and clocks
# invented for the test. The tool reads only the file it is given.
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * A NO-RUNNER QUEUE ARTIFACT COUNTED AS COMPUTE. The reference
#    12h sample held ~15,730 no-runner timestamp minutes beside ~17,037 real
#    runner minutes. Section 1 pins that three 30-minute queued/cancelled jobs
#    with empty runner_name contribute 0.00 minutes while one 10-minute
#    coolify job contributes 10.00. A counter that summed timestamp span
#    regardless of runner assignment would report 100.00 here and pass a
#    capacity verdict off queue artifacts.
#
#  * A HOST CLASS MISREAD. `ci-rbx1-iso-1` and `garm-two-abc` must not land in
#    the coolify bucket: section 2 pins the per-class split, so a glob that
#    matched every self-hosted name as Coolify load fails the test.
#
#  * A THIN SAMPLE REPORTED AS GO. Section 3 pins INCONCLUSIVE on a 2-job
#    sample even when the peak fits, per the trial adequacy rule (>=24h
#    span and >=10 matched attempts). A verdict that skipped adequacy would
#    read GO here.
#
#  * A PEAK THAT FITS REPORTED, AND ONE THAT DOES NOT. Sections 4-5 pin GO
#    (peak 2 <= 3 slots) and NO-GO (peak 4 > 3 slots) with the reason naming
#    the peak and the slot count, not just the exit status — an exit-code-only
#    assertion would let a refusal from the wrong branch pass as a verdict.
#
#  * AN UNMEASURED POOL REPORTED HEALTHY. Section 6 asserts refusal (exit 2)
#    on an empty array, a non-array, a missing file, and a sample with zero
#    runner-assigned jobs. Zero measured jobs is "never ran", not "fits".
# ===========================================================================
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/coolify_capacity_headroom.sh"
PASS=0; FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# mk_jobs <file> — fabricated 30-day-span jobs; callers slice what they need.
mk_jobs() {
  cat > "$1" <<'EOF'
[
  {"name": "suite-a", "runner_name": "coolify-vps-2", "started_at": "2026-09-03T10:00:00Z", "completed_at": "2026-09-03T10:10:00Z", "conclusion": "success", "labels": ["self-hosted", "two-isolated"]},
  {"name": "queued-never-landed", "runner_name": "", "started_at": "2026-09-03T10:00:00Z", "completed_at": "2026-09-03T10:30:00Z", "conclusion": "cancelled", "labels": ["self-hosted", "two-isolated"]},
  {"name": "cancelled-no-runner", "runner_name": "", "started_at": "2026-09-04T10:00:00Z", "completed_at": "2026-09-04T10:30:00Z", "conclusion": "cancelled", "labels": ["self-hosted", "two-isolated"]},
  {"name": "gitleaks-cancel-no-runner", "runner_name": "", "started_at": "2026-09-05T10:00:00Z", "completed_at": "2026-09-05T10:30:00Z", "conclusion": "cancelled", "labels": ["self-hosted", "two-selfhosted"]},
  {"name": "suite-b", "runner_name": "ci-rbx1-iso-1", "started_at": "2026-09-10T10:00:00Z", "completed_at": "2026-09-10T10:20:00Z", "conclusion": "success", "labels": ["self-hosted", "two-isolated"]},
  {"name": "suite-c", "runner_name": "garm-two-abc", "started_at": "2026-09-20T10:00:00Z", "completed_at": "2026-09-20T10:05:00Z", "conclusion": "success", "labels": ["self-hosted", "two-ephemeral"]},
  {"name": "suite-d", "runner_name": "coolify-vps-3", "started_at": "2026-10-03T09:00:00Z", "completed_at": "2026-10-03T09:15:00Z", "conclusion": "success", "labels": ["self-hosted", "two-isolated"]},
  {"name": "suite-e", "runner_name": "coolify-vps-4", "started_at": "2026-10-03T09:05:00Z", "completed_at": "2026-10-03T09:25:00Z", "conclusion": "success", "labels": ["self-hosted", "two-isolated"]},
  {"name": "suite-f", "runner_name": "coolify-vps-5", "started_at": "2026-10-03T11:00:00Z", "completed_at": "2026-10-03T11:10:00Z", "conclusion": "success", "labels": ["self-hosted", "two-isolated"]},
  {"name": "suite-g", "runner_name": "coolify-vps-6", "started_at": "2026-10-03T12:00:00Z", "completed_at": "2026-10-03T12:10:00Z", "conclusion": "success", "labels": ["self-hosted", "two-isolated"]},
  {"name": "suite-h", "runner_name": "coolify-vps-7", "started_at": "2026-10-03T13:00:00Z", "completed_at": "2026-10-03T13:10:00Z", "conclusion": "success", "labels": ["self-hosted", "two-isolated"]},
  {"name": "skewed-clock", "runner_name": "coolify-vps-1", "started_at": "2026-10-03T14:10:00Z", "completed_at": "2026-10-03T14:00:00Z", "conclusion": "success", "labels": ["self-hosted", "two-isolated"]}
]
EOF
}

# ---------------------------------------------------------------- section 1
# no-runner minutes are queue artifacts, not compute.
F="$WORK/s1.json"; mk_jobs "$F"
OUT="$("$TOOL" --jobs "$F" --min-hours 700 --min-attempts 100 2>/dev/null)"
if [[ "$OUT" == *"runner_minutes_total=100.00"* && "$OUT" == *"coolify=75.00"* \
   && "$OUT" == *"excluded_no_runner=3"* && "$OUT" == *"excluded_clock=1"* ]]; then
  ok "1 no-runner queue/cancel minutes excluded; skewed clock excluded by cause"
else
  bad "1 no-runner exclusion" "$OUT"
fi

# ---------------------------------------------------------------- section 2
# Host-class split: rbx1 and garm minutes must not read as Coolify load.
if [[ "$OUT" == *"rbx1=20.00"* && "$OUT" == *"garm=5.00"* && "$OUT" == *"other=0.00"* ]]; then
  ok "2 per-class split pins rbx1 and garm outside the coolify bucket"
else
  bad "2 per-class split" "$OUT"
fi

# ---------------------------------------------------------------- section 3
# Thin sample is INCONCLUSIVE even when the peak fits.
F="$WORK/s3.json"
cat > "$F" <<'EOF'
[
  {"name": "one", "runner_name": "coolify-vps-1", "started_at": "2026-10-03T10:00:00Z", "completed_at": "2026-10-03T10:10:00Z", "conclusion": "success"},
  {"name": "two", "runner_name": "coolify-vps-2", "started_at": "2026-10-03T11:00:00Z", "completed_at": "2026-10-03T11:10:00Z", "conclusion": "success"}
]
EOF
OUT="$("$TOOL" --jobs "$F" 2>/dev/null)"; CODE=$?
if (( CODE == 0 )) && [[ "$OUT" == *"verdict=INCONCLUSIVE"* && "$OUT" == *"adequacy bound"* ]]; then
  ok "3 thin sample INCONCLUSIVE with adequacy reason, still exit 0"
else
  bad "3 thin-sample INCONCLUSIVE" "code=$CODE out=$OUT"
fi

# ---------------------------------------------------------------- section 4
# GO: coolify peak 2 fits 3 slots; reason names peak and slots.
OUT="$("$TOOL" --jobs "$WORK/s1.json" --rbx1-max 1 --oldctl-max 2 --min-hours 700 --min-attempts 7 2>/dev/null)"; CODE=$?
if (( CODE == 0 )) && [[ "$OUT" == *"verdict=GO"* && "$OUT" == *"coolify peak 2 fits 3 GARM slots"* ]]; then
  ok "4 GO names the fitting peak and slot count"
else
  bad "4 GO verdict" "code=$CODE out=$OUT"
fi

# ---------------------------------------------------------------- section 5
# NO-GO: same load against 1 slot; a measured NO-GO is still exit 0.
OUT="$("$TOOL" --jobs "$WORK/s1.json" --rbx1-max 1 --oldctl-max 0 --min-hours 700 --min-attempts 7 2>/dev/null)"; CODE=$?
if (( CODE == 0 )) && [[ "$OUT" == *"verdict=NO-GO"* && "$OUT" == *"exceeds 1 GARM slots"* ]]; then
  ok "5 NO-GO names the exceeding peak and slot count"
else
  bad "5 NO-GO verdict" "code=$CODE out=$OUT"
fi

# ---------------------------------------------------------------- section 6
# Refusals: empty, non-array, missing, and all-no-runner inputs exit 2.
echo '[]' > "$WORK/empty.json"
echo '{"jobs": []}' > "$WORK/empty-obj.json"
echo '[1,2]' > "$WORK/nonobj.json"
cat > "$WORK/norunner.json" <<'EOF'
[{"name": "queued", "runner_name": "", "started_at": "2026-10-03T10:00:00Z", "completed_at": "2026-10-03T10:30:00Z", "conclusion": "cancelled"}]
EOF
REF_OK=1
for bad_in in "$WORK/empty.json" "$WORK/empty-obj.json" "$WORK/nonobj.json" "$WORK/norunner.json" "$WORK/does-not-exist.json"; do
  "$TOOL" --jobs "$bad_in" >/dev/null 2>&1; CODE=$?
  (( CODE == 2 )) || REF_OK=0
done
if (( REF_OK == 1 )); then
  ok "6 empty/non-array/missing/all-no-runner inputs refuse with exit 2"
else
  bad "6 refusal cases" "at least one bad input did not exit 2"
fi

# ---------------------------------------------------------------- section 7
# The `gh api .../jobs` object shape is accepted, not just a bare array.
python3 -c "import json; print(json.dumps({'jobs': json.load(open('$WORK/s1.json'))}))" > "$WORK/obj.json"
OUT_BARE="$("$TOOL" --jobs "$WORK/s1.json" --min-hours 700 --min-attempts 100 2>/dev/null)"
OUT_OBJ="$("$TOOL" --jobs "$WORK/obj.json" --min-hours 700 --min-attempts 100 2>/dev/null)"
if [[ "$OUT_BARE" == "$OUT_OBJ" ]]; then
  ok "7 object-with-jobs shape measures identically to the bare array"
else
  bad "7 jobs-object shape" "bare: $OUT_BARE | obj: $OUT_OBJ"
fi

printf '\ncoolify headroom suite: %d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
