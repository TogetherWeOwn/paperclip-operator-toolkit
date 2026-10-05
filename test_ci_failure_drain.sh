#!/usr/bin/env bash
# Regression suite for ci_failure_drain.sh — the CI failure log-drain.
#
# THE BUG THIS EXISTS FOR. When a CI run goes red, triage means opening every
# failed job and paging through thousands of log lines to find the one that
# names the cause. Reviewers re-run or guess instead. The drain bundles each
# failed job's trimmed log plus a one-line summary naming the job, the failed
# step, and the cause — so a red run triages from the summary in minutes.
#
# HERMETIC BY CONSTRUCTION. Recorded jobs-list fixtures plus recorded per-job
# log files, invoked via --jobs-json/--logs-dir. No network, no credential,
# nothing leaves the loopback. Requires bash, jq, curl (curl only for the
# live path, which this suite never takes).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/ci_failure_drain.sh"
FIXTURES="$HERE/test/fixtures/ci_failure_drain"
RED="$FIXTURES/jobs-red.json"
GREEN="$FIXTURES/jobs-green.json"
LOGS="$FIXTURES/logs"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ONE label per assertion, printed identically green or red — the ci.yml
# mutation gate pins tests by label, so a label that changes with the outcome
# cannot be pinned by any mutation (exit-zero reporting).
assert() {
  local status="$1" label="$2" diag="${3:-}"
  if [[ "$status" -eq 0 ]]; then ok "$label"; else bad "$label"; [[ -n "$diag" ]] && printf '        %s\n' "$diag"; fi
  return 0
}

command -v jq >/dev/null 2>&1 || { echo "test_ci_failure_drain: jq is required" >&2; exit 2; }
[[ -x "$TOOL" ]] || { echo "test_ci_failure_drain: $TOOL is not executable" >&2; exit 2; }
# A missing fixture is a hard error, never a skip. A skipped test is a deleted
# test that still prints a zero exit.
for f in "$RED" "$GREEN" "$LOGS/9002.log" "$LOGS/9003.log"; do
  [[ -s "$f" ]] || { echo "test_ci_failure_drain: recorded fixture missing or empty: $f" >&2; exit 2; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
hdr "The red fixture — what a failing run must produce"

OUT="$("$TOOL" drain --jobs-json "$RED" --logs-dir "$LOGS" --out-dir "$TMP/drain" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a red run still exits 0" \
  "got exit $RC — the drain must not replace the real failure's attribution"

[[ -s "$TMP/drain/failure-summary.md" ]]
assert $? "the drain writes a failure-summary.md" \
  "no summary file; there is nothing to triage from"

grep -q 'broker-suite' "$TMP/drain/failure-summary.md"
assert $? "the summary names the failing broker-suite job" \
  "the failing job is not named, so triage starts with a blind hunt"

grep -q 'capture-suite' "$TMP/drain/failure-summary.md"
assert $? "the summary names the failing capture-suite job" \
  "the second failing job is not named"

grep -q 'Broker suite' "$TMP/drain/failure-summary.md"
assert $? "the summary names the step that failed" \
  "no failed step attributed; the reader goes back to bisecting a log"

[[ -s "$TMP/drain/broker-suite.log" ]] && [[ -s "$TMP/drain/capture-suite.log" ]]
assert $? "each failed job gets its own trimmed log file" \
  "a per-job log is missing, so the bundle is a summary with no evidence"

# The one-line cause must name something that broke, not teardown noise.
grep -qi 'refuses an unknown credential source\|expected refusal' "$TMP/drain/failure-summary.md"
assert $? "the summary line carries the error-shaped cause" \
  "no cause line; the summary says which job failed but not why"

grep -q '::error title=' <<< "$OUT"
assert $? "a red drain emits a ::error annotation so it surfaces on the run summary" \
  "no ::error annotation; the drain is only visible to someone opening the artifact"

grep -q 'Offline suites' <<< "$OUT"; [[ $? -ne 0 ]]
assert $? "the drain does not name jobs that passed" \
  "a passing job appears in the failure drain, which trains reviewers to ignore it"

# ---------------------------------------------------------------------------
hdr "The green fixture — a clean run stays quiet"

OUT_G="$("$TOOL" drain --jobs-json "$GREEN" --logs-dir "$LOGS" --out-dir "$TMP/green" 2>&1)"; RC_G=$?
[[ "$RC_G" -eq 0 ]]
assert $? "a green run still exits 0" \
  "got exit $RC_G on a run with no failures"

grep -qi 'no failed jobs' "$TMP/green/failure-summary.md"
assert $? "a green run reports no failed jobs" \
  "the summary does not say the run was clean"

grep -q '::error title=' <<< "$OUT_G"; [[ $? -ne 0 ]]
assert $? "a green run raises no error annotation" \
  "an annotation on a clean run is a warning reviewers learn to scroll past"

# ---------------------------------------------------------------------------
hdr "Refusal — a drain that measured nothing must not read as clean"

OUT_E="$("$TOOL" drain --jobs-json /dev/null --logs-dir "$LOGS" --out-dir "$TMP/empty" 2>&1)"; RC_E=$?
[[ "$RC_E" -eq 3 ]]
assert $? "an empty jobs file REFUSES" "got exit $RC_E"

printf '{"jobs":[]}' > "$TMP/nojobs.json"
OUT_N="$("$TOOL" drain --jobs-json "$TMP/nojobs.json" --logs-dir "$LOGS" --out-dir "$TMP/nojobs" 2>&1)"; RC_N=$?
[[ "$RC_N" -eq 3 ]]
assert $? "a jobs response with no jobs REFUSES" "got exit $RC_N"

# Half a fixture is a lie: jobs without logs (or logs without jobs) must not
# produce a partial bundle that reads as complete.
OUT_H="$("$TOOL" drain --jobs-json "$RED" --out-dir "$TMP/half" 2>&1)"; RC_H=$?
[[ "$RC_H" -ne 0 ]]
assert $? "jobs-json without logs-dir is a usage error, not a partial drain" "got exit $RC_H"

mkdir -p "$TMP/thinlogs"; cp "$LOGS/9002.log" "$TMP/thinlogs/"
OUT_T="$("$TOOL" drain --jobs-json "$RED" --logs-dir "$TMP/thinlogs" --out-dir "$TMP/thin" 2>&1)"; RC_T=$?
[[ "$RC_T" -eq 3 ]]
assert $? "a missing log for a failed job REFUSES" "got exit $RC_T"

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ "$PASS" -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
