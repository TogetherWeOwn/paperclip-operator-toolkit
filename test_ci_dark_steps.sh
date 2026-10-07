#!/usr/bin/env bash
# Regression suite for ci_dark_steps.sh — the dark-step reporter (TOG-910).
#
# THE BUG THIS EXISTS FOR. `offline-suites` is fail-fast with 89 named steps.
# When the OmniRoute rehearsal package expired on 2026-09-03T00:00:00Z, step 12
# went red and 79 steps were skipped — `Secret scan` and every mutation gate
# among them — for ~21 hours, across every PR, while the check surface said
# nothing more specific than "Offline suites: failing". Two suites merged into
# `main` in that window having never executed in CI at all.
#
# WHY THE FIXTURES ARE RECORDED, NOT WRITTEN. A hand-authored job object is one
# that matches whatever the tool happens to read — it proves the tool agrees
# with the test author, not with GitHub. The two historical snapshots below are
# verbatim `actions/jobs/{id}` responses for the original outage and recovery runs. They
# predate this reporter, so the suite adds a synthetic boundary before testing.
#
#   job-100695318458-dark.json    pristine main e9dea118 — 13 success, 1 failure,
#                                 79 skipped across 93 source steps. The synthetic
#                                 reporter boundary is inserted before `Post ...`
#                                 teardown and `Complete job`; one teardown was
#                                 skipped and three lifecycle steps succeeded.
#                                 The tool reports 78 dark of 89 gates with a
#                                 10/1/78 passed/failed/not-run tally.
#   job-100786202472-green.json   PR #198 d794f39c — 95 source steps, 0 skipped.
#                                 With the synthetic reporter boundary, the tool
#                                 reports 91 gate steps passed after the expiry
#                                 was re-issued.
#   job-105959891748-abort-null.json  run 35466576547, Offline suites, TOG-3427:
#                                 80 success, 1 failure, 55 conclusions still
#                                 `null` — the at-report-time view of a fail-fast
#                                 abort. CONSTRUCTED, not recorded: the finalised
#                                 job object rewrites those nulls to "skipped",
#                                 which is exactly the state that hid the bug. The
#                                 suite adds the reporter marker at the end of this
#                                 in-progress snapshot before running the tool.
#   job-live-green-reporter-inflight.json  The at-report-time view of
#                                 a GREEN job — `Set up job`, 3 gates, the
#                                 reporter in_progress, and 2 queued `Post`
#                                 teardown steps. CONSTRUCTED: the finalised job
#                                 object rewrites those nulls, so re-recording it
#                                 from the API would un-write the test. Must read
#                                 0 dark with no ::error.
#   job-live-green-gate-inflight.json  Constructed live view: `Set up job`, 4
#                                 gates concluded successfully, and one in_progress
#                                 with a null conclusion when the reporter runs.
#                                 Queued `Post ...` and `Complete job` steps are
#                                 excluded.
#
# Re-record with:
#   gh api repos/TogetherWeOwn/paperclip-ops-tooling/actions/jobs/<id> > <fixture>
#
# THE ASSERTION THAT MATTERS MOST is not "it counts 79". It is that the reporter
# stays SILENT on the green fixture. A reporter that warns on every run is one
# every reviewer learns to scroll past, which is the same failure as not having
# it. So the green case is pinned as hard as the dark one.
#
# Offline by construction: file fixtures use --job-json, and the live API
# polling cases use PATH-stubbed curl/sleep with a dummy token. No network or
# real credential. Requires jq.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/ci_dark_steps.sh"
FIXTURES="$HERE/test/fixtures/ci_dark_steps"
DARK="$FIXTURES/job-100695318458-dark.json"
GREEN="$FIXTURES/job-100786202472-green.json"
ABORT_NULL="$FIXTURES/job-105959891748-abort-null.json"
LIVE_GREEN="$FIXTURES/job-live-green-reporter-inflight.json"
LIVE_GATE_INFLIGHT="$FIXTURES/job-live-green-gate-inflight.json"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ONE label per assertion, printed identically green or red — the ci.yml
# mutation gate pins tests by label, so a label that changes with the outcome
# cannot be pinned by any mutation (TOG-339).
assert() {
  local status="$1" label="$2" diag="${3:-}"
  if [[ "$status" -eq 0 ]]; then ok "$label"; else bad "$label"; [[ -n "$diag" ]] && printf '        %s\n' "$diag"; fi
  return 0
}

command -v jq >/dev/null 2>&1 || { echo "test_ci_dark_steps: jq is required" >&2; exit 2; }
[[ -x "$TOOL" ]] || { echo "test_ci_dark_steps: $TOOL is not executable" >&2; exit 2; }
# A missing fixture is a hard error, never a skip. A skipped test is a deleted
# test that still prints a zero exit (TOG-339).
for f in "$DARK" "$GREEN" "$ABORT_NULL" "$LIVE_GREEN" "$LIVE_GATE_INFLIGHT"; do
  [[ -s "$f" ]] || { echo "test_ci_dark_steps: recorded fixture missing or empty: $f" >&2; exit 2; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The archived outage/green snapshots predate this reporter step. Add a
# synthetic marker at the known boundary before their runner post-actions;
# the raw recorded fixtures stay unchanged. The live fixtures carry the real
# reporter marker and exercise the current API shape directly.
with_reporter_boundary() {
  local src="$1" dst="$2"
  jq '
    .steps as $steps
    | ([$steps | to_entries[] | select(.value.name | startswith("Post Run ")) | .key] | first // ($steps | length)) as $i
    | (($steps[0:$i] | map(.number) | max) + 1) as $reporter_no
    | .steps = ($steps[0:$i] + [{"conclusion":"success","name":"Report steps that never ran","number":$reporter_no,"status":"completed"}] + $steps[$i:])
  ' "$src" > "$dst"
}

DARK_REPORTABLE="$TMP/dark-with-reporter.json"
GREEN_REPORTABLE="$TMP/green-with-reporter.json"
ABORT_NULL_REPORTABLE="$TMP/abort-null-with-reporter.json"
with_reporter_boundary "$DARK" "$DARK_REPORTABLE"
with_reporter_boundary "$GREEN" "$GREEN_REPORTABLE"
with_reporter_boundary "$ABORT_NULL" "$ABORT_NULL_REPORTABLE"

# ---------------------------------------------------------------------------
hdr "The outage fixture — what a dark run must say"

OUT="$("$TOOL" report --job-json "$DARK_REPORTABLE" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a dark run still exits 0" \
  "got exit $RC — the reporter must not replace the real failure's attribution"

# 89 gate steps (the 93-step source plus a reporter marker, minus setup,
# reporter, 2 `Post` teardowns, and `Complete job`): 10 passed, 1 failed,
# 78 dark. The tally must match the banner.
grep -q '78 of 89 steps never ran' <<< "$OUT"
assert $? "the dark run names the count of steps that did not execute" \
  "expected '78 of 89 steps never ran'"

grep -q 'OmniRoute rehearsal package suite' <<< "$OUT"
assert $? "the dark run names the step that aborted the job" \
  "the culprit step is not attributed"

grep -q '::error title=' <<< "$OUT"
assert $? "a dark run emits a ::error annotation so it surfaces on the run summary" \
  "no ::error annotation; the report would only be visible to someone opening the log"

# The whole point of the card: these specific gates were dark and nobody knew.
grep -q 'Secret scan' <<< "$OUT"
assert $? "the dark list names Secret scan" \
  "Secret scan is missing from the report of un-run steps"

grep -qi 'mutation-gated' <<< "$OUT"
assert $? "the dark list names the mutation gates" \
  "no mutation-gated step is reported, so vacuity protection looks intact when it is not"

# 10 + 1 + 78 = 89: the tally adds up over the gate set. Three successful
# runner lifecycle steps and one skipped Post teardown are excluded.
grep -q 'Executed: 10 passed, 1 failed. In progress: 0. Not run: 78. Other outcomes: 0.' <<< "$OUT"
assert $? "the executed/not-run tally is reported exactly" \
  "tally line missing or wrong"

grep -q '5 non-gate steps excluded' <<< "$OUT"
assert $? "the dark report discloses the excluded non-gate steps" \
  "the exemption is silent, so the banner looks like it covers all 94 steps"

# A step that timed out ran far enough to produce a failure, so it is not dark.
jq '(.steps[] | select(.name == "OmniRoute rehearsal package suite") | .conclusion) = "timed_out"' \
  "$DARK_REPORTABLE" > "$TMP/timeout.json"
OUT_T="$("$TOOL" report --job-json "$TMP/timeout.json" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a timed-out gate run still exits 0" "got exit $RC"

grep -q '78 of 89 steps never ran' <<< "$OUT_T"
assert $? "a completed timeout is not counted as a never-run step" \
  "the timeout was included in the dark count"

grep -q 'aborted at step .*OmniRoute rehearsal package suite' <<< "$OUT_T"
assert $? "a timed-out gate is attributed as the aborting step" \
  "the timeout culprit is missing from the report"

grep -q 'Executed: 10 passed, 1 failed. In progress: 0. Not run: 78. Other outcomes: 0.' <<< "$OUT_T"
assert $? "a timeout is counted as failed, not dark" \
  "the timeout is missing from the executed-step tally"

# ---------------------------------------------------------------------------
hdr "The fail-fast abort as the reporter sees it — null conclusions are dark (TOG-3427)"

OUT_A="$("$TOOL" report --job-json "$ABORT_NULL_REPORTABLE" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "an aborted run still exits 0" \
  "got exit $RC — the reporter must not replace the real failure's attribution"

grep -q '55 of 136 steps never ran' <<< "$OUT_A"
assert $? "the abort names the count of steps that did not execute" \
  "expected '55 of 136 steps never ran'"

grep -q 'Rehearsal package expiry probe' <<< "$OUT_A"
assert $? "the abort names the step that aborted the job" \
  "the culprit step is not attributed"

grep -q '::error title=' <<< "$OUT_A"
assert $? "an aborted run emits a ::error annotation so it surfaces on the run summary" \
  "no ::error annotation; the report would only be visible to someone opening the log"

grep -q 'Secret scan' <<< "$OUT_A"
assert $? "the abort list names Secret scan" \
  "Secret scan is missing from the report of un-run steps"

grep -qi 'mutation-gated' <<< "$OUT_A"
assert $? "the abort list names the mutation gates" \
  "no mutation-gated step is reported, so vacuity protection looks intact when it is not"

grep -q 'Executed: 80 passed, 1 failed. In progress: 0. Not run: 55. Other outcomes: 0.' <<< "$OUT_A"
assert $? "the executed/not-run tally is reported exactly" \
  "tally line missing or wrong"

# The false green this card exists to kill: the old `conclusion=="skipped"`
# selector reads ZERO dark here (all unreached steps are still null), so the
# DARK -eq 0 branch prints "all N steps executed" over a 55-step abort.
! grep -q 'all .* steps executed' <<< "$OUT_A"
assert $? "an aborted run never prints the clean banner" \
  "the false green is back: 'all N steps executed' over unreached steps"

# ---------------------------------------------------------------------------
hdr "The green fixture — silence is the feature"

OUT_G="$("$TOOL" report --job-json "$GREEN_REPORTABLE" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a fully-executed run exits 0" "got exit $RC"

! grep -q '::error' <<< "$OUT_G"
assert $? "a fully-executed run raises no error annotation" \
  "the reporter cries wolf on a clean run, which trains reviewers to ignore it"

! grep -qi 'never ran' <<< "$OUT_G"
assert $? "a fully-executed run reports no un-run steps" \
  "a clean run is being described as dark"

grep -q 'all 91 steps executed' <<< "$OUT_G"
assert $? "a fully-executed run states the number of steps it confirmed" \
  "the positive confirmation is missing, so 'no news' is ambiguous"

grep -q '5 non-gate steps excluded' <<< "$OUT_G"
assert $? "a fully-executed run discloses the excluded non-gate steps" \
  "the banner claims 91 while the reportable job has 96 steps"

# Other completed conclusions must be visible without being called dark or clean.
jq '(.steps[] | select(.name == "Syntax check every script") | .conclusion) = "cancelled"' "$GREEN_REPORTABLE" > "$TMP/other-outcome.json"
OUT_O="$("$TOOL" report --job-json "$TMP/other-outcome.json" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a completed nonstandard outcome still exits 0" "got exit $RC"

! grep -qi 'never ran' <<< "$OUT_O"
assert $? "a completed nonstandard outcome is not called never run" \
  "the report treated a concluded step as dark"

grep -q 'Other outcomes: 1.' <<< "$OUT_O"
assert $? "a completed nonstandard outcome is tallied separately" \
  "the report omitted the nonstandard conclusion"

grep -q 'Syntax check every script (cancelled)' <<< "$OUT_O"
assert $? "a completed nonstandard outcome is named" \
  "the report did not identify the step with another conclusion"

! grep -q 'all 91 steps executed' <<< "$OUT_O"
assert $? "a nonstandard conclusion is not reported as fully executed" \
  "the report claimed a clean execution despite an unclassified outcome"

# ---------------------------------------------------------------------------
hdr "The live view — runner lifecycle steps are not gates"

# At report time the live job object holds `Set up job`, the reporter's OWN
# step (in_progress, conclusion null), and queued `Post` teardown steps. Before
# the exemption every green job printed an ::error annotation about itself —
# the cry-wolf failure this entire tool exists to prevent.
OUT_L="$("$TOOL" report --job-json "$LIVE_GREEN" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a live green run with the reporter in flight exits 0" "got exit $RC"

! grep -q '::error' <<< "$OUT_L"
assert $? "a live green run with the reporter in flight raises no error annotation" \
  "the reporter annotates itself on a clean run, which trains reviewers to ignore it"

! grep -qi 'never ran' <<< "$OUT_L"
assert $? "a live green run with the reporter in flight reports no un-run steps" \
  "the reporter counts itself or teardown as dark"

grep -q 'all 3 steps executed' <<< "$OUT_L"
assert $? "a live green run with the reporter in flight states the number of gate steps it confirmed" \
  "the positive confirmation is missing, so 'no news' is ambiguous"

grep -q '4 non-gate steps excluded' <<< "$OUT_L"
assert $? "a live green run with the reporter in flight discloses the excluded non-gate steps" \
  "the banner claims 3 while the job registered 6"

# A workflow gate may use the same `Post ...` prefix as runner-generated
# teardown steps. It is before the reporter boundary and must remain countable.
jq '.steps = (.steps[0:4] + [{"conclusion":"skipped","name":"Post deploy verification","number":5,"status":"completed"}] + (.steps[4:] | map(.number += 1)))' \
  "$LIVE_GREEN" > "$TMP/live-post-gate.json"
OUT_P="$("$TOOL" report --job-json "$TMP/live-post-gate.json" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a gate named Post deploy verification still reports normally" "got exit $RC"
grep -q '1 of 4 steps never ran' <<< "$OUT_P"
assert $? "a Post-named workflow gate remains in the gate count" \
  "the gate was filtered as runner teardown"
grep -q 'Post deploy verification' <<< "$OUT_P"
assert $? "a Post-named workflow gate appears in the dark-step list" \
  "the skipped gate is missing from the report"

# A gate can also share the reporter's display name. The last matching step is
# the configured reporter; an earlier same-named gate remains inside its boundary.
jq '.steps = (.steps[0:4] + [{"conclusion":"skipped","name":"Report steps that never ran","number":5,"status":"completed"}] + (.steps[4:] | map(.number += 1)))' \
  "$LIVE_GREEN" > "$TMP/live-reporter-name-gate.json"
OUT_R="$("$TOOL" report --job-json "$TMP/live-reporter-name-gate.json" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a workflow gate sharing the reporter name still reports normally" "got exit $RC"
grep -q '1 of 4 steps never ran' <<< "$OUT_R"
assert $? "a same-named reporter label gate remains in the gate count" \
  "the earlier gate was mistaken for the reporter boundary"

# ---------------------------------------------------------------------------
hdr "A live gate step already in progress is not dark"

OUT_I="$("$TOOL" report --job-json "$LIVE_GATE_INFLIGHT" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a live gate step in progress exits 0" "got exit $RC"

! grep -q '::error' <<< "$OUT_I"
assert $? "an in-progress gate step is not reported as dark" \
  "a started gate step was treated as never run"

! grep -qi 'never ran' <<< "$OUT_I"
assert $? "an in-progress gate step is not listed as never run" \
  "the report says a started gate step never ran"

grep -q '1 gate step still in progress' <<< "$OUT_I"
assert $? "the live view discloses the in-progress gate step" \
  "the report does not distinguish a live step from a dark step"

grep -q 'Executed: 4 passed, 0 failed. In progress: 1. Not run: 0. Other outcomes: 0.' <<< "$OUT_I"
assert $? "the live view tally separates completed, in-progress, and dark steps" \
  "the three gate states do not add up to the five-gate total"

grep -q '5 non-gate steps excluded' <<< "$OUT_I"
assert $? "runner setup and completion are excluded from the gate count" \
  "the runner's Set up job or Complete job step was counted as a gate"

! grep -q 'all 5 steps executed' <<< "$OUT_I"
assert $? "an in-progress gate step is not claimed as fully executed" \
  "the report claims a verdict before the live step has one"

jq '.steps = (.steps[0:6] + [{"conclusion":null,"name":"Unstarted gate step","number":7,"status":"pending"}] + (.steps[6:] | map(.number += 1)))' \
  "$LIVE_GATE_INFLIGHT" > "$TMP/live-inflight-with-dark.json"
OUT_M="$("$TOOL" report --job-json "$TMP/live-inflight-with-dark.json" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a mixed live view still reports its dark gate" "got exit $RC"

grep -q '1 of 6 steps never ran' <<< "$OUT_M"
assert $? "the mixed live view counts only the unstarted gate as dark" \
  "expected one dark gate among six gate steps"

grep -q 'Unstarted gate step' <<< "$OUT_M"
assert $? "the mixed live view lists the unstarted gate" \
  "the actual dark step is missing from the report"

! grep -q 'Finalize operator report' <<< "$OUT_M"
assert $? "the mixed live view omits its in-progress gate from the dark list" \
  "a started gate is listed as never run"

grep -q 'Executed: 4 passed, 0 failed. In progress: 1. Not run: 1. Other outcomes: 0.' <<< "$OUT_M"
assert $? "the mixed live view tally separates all gate states" \
  "the tally does not account for four passed, one running, and one dark gate"

# ---------------------------------------------------------------------------
hdr "The live API — allow completed gate updates to settle before classifying"

mkdir -p "$TMP/mock-bin"
cat > "$TMP/mock-bin/curl" <<'CURL_STUB'
#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "${CURL_ARGS_FILE:?}"
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$out" ]] || exit 97
count=0
if [[ -s "${CURL_COUNT_FILE:?}" ]]; then
  IFS= read -r count < "$CURL_COUNT_FILE"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$CURL_COUNT_FILE"
case "$count" in
  1) response="${CURL_FIRST_RESPONSE:?}" ;;
  2) response="${CURL_SECOND_RESPONSE:?}" ;;
  *)
    if [[ "${CURL_ALTERNATE_RESPONSES:-}" == "1" ]] && (( count % 2 == 0 )); then
      response="${CURL_SECOND_RESPONSE:?}"
    else
      response="${CURL_REST_RESPONSE:-${CURL_SECOND_RESPONSE:?}}"
    fi
    ;;
esac
cp "$response" "$out"
printf '200'
CURL_STUB
cat > "$TMP/mock-bin/sleep" <<'SLEEP_STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SLEEP_ARGS_FILE:?}"
exit 0
SLEEP_STUB
chmod +x "$TMP/mock-bin/curl" "$TMP/mock-bin/sleep"

# If a stale live step list omits the running reporter but contains a
# same-named workflow gate, that gate is not a safe lifecycle boundary.
jq '(.steps[] | select(.name == "Finalize operator report")) |= (.status = "completed" | .conclusion = "success") | .id=41' \
  "$LIVE_GATE_INFLIGHT" > "$TMP/reporter-settled-job.json"
jq '{jobs:[.]}' "$TMP/reporter-settled-job.json" > "$TMP/reporter-settled-jobs.json"
jq -n '{jobs:[{id:41,name:"Operator runbook gates",status:"in_progress",conclusion:null,steps:[{conclusion:"success",name:"Set up job",number:1,status:"completed"},{conclusion:"success",name:"Checkout",number:2,status:"completed"},{conclusion:"success",name:"Report steps that never ran",number:3,status:"completed"},{conclusion:"skipped",name:"Late workflow gate",number:4,status:"completed"},{conclusion:null,name:"Post Run cleanup",number:5,status:"queued"},{conclusion:null,name:"Complete job",number:6,status:"queued"}]}]}' \
  > "$TMP/stale-reporter-jobs.json"
OUT_STALE_REPORTER="$(
  env -u BASH_ENV \
  PATH="$TMP/mock-bin:$PATH" \
  CURL_FIRST_RESPONSE="$TMP/stale-reporter-jobs.json" \
  CURL_SECOND_RESPONSE="$TMP/reporter-settled-jobs.json" \
  CURL_REST_RESPONSE="$TMP/reporter-settled-jobs.json" \
  CURL_COUNT_FILE="$TMP/stale-reporter-count" \
  CURL_ARGS_FILE="$TMP/stale-reporter-args" \
  SLEEP_ARGS_FILE="$TMP/stale-reporter-sleeps" \
  GH_TOKEN="test-token" \
  GITHUB_REPOSITORY="TogetherWeOwn/paperclip-operator-toolkit" \
  GITHUB_RUN_ID="4" \
  GITHUB_RUN_ATTEMPT="1" \
  GITHUB_JOB="operator-runbook-gates" \
  GITHUB_JOB_NAME="Operator runbook gates" \
  GITHUB_API_URL="https://api.github.test" \
  "$TOOL" report 2>&1
)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a stale same-named gate is not accepted as the running reporter" "got exit $RC"
! grep -q '::error' <<< "$OUT_STALE_REPORTER"
assert $? "a stale reporter boundary is refreshed before dark-step classification" \
  "the reporter classified the step list using a same-named gate"
grep -q 'all 5 steps executed' <<< "$OUT_STALE_REPORTER"
assert $? "the refreshed reporter boundary includes every workflow gate" \
  "the report used the stale, earlier name match as its boundary"
[[ "$(<"$TMP/stale-reporter-count")" -eq 2 ]]
assert $? "a stale reporter boundary settles after one refresh" \
  "expected an initial read and one refreshed API view"
[[ "$(<"$TMP/stale-reporter-sleeps")" == "1" ]]
assert $? "the stale reporter boundary waits before refreshing" \
  "the reporter boundary was retried without a one-second wait"

# A reporter marker that remains stale through the bounded window is refused,
# not mistaken for the live reporter or reported as a clean gate set.
OUT_UNSETTLED_REPORTER="$(
  env -u BASH_ENV \
  PATH="$TMP/mock-bin:$PATH" \
  CURL_FIRST_RESPONSE="$TMP/stale-reporter-jobs.json" \
  CURL_SECOND_RESPONSE="$TMP/stale-reporter-jobs.json" \
  CURL_REST_RESPONSE="$TMP/stale-reporter-jobs.json" \
  CURL_COUNT_FILE="$TMP/stale-reporter-stable-count" \
  CURL_ARGS_FILE="$TMP/stale-reporter-stable-args" \
  SLEEP_ARGS_FILE="$TMP/stale-reporter-stable-sleeps" \
  GH_TOKEN="test-token" \
  GITHUB_REPOSITORY="TogetherWeOwn/paperclip-operator-toolkit" \
  GITHUB_RUN_ID="6" \
  GITHUB_RUN_ATTEMPT="1" \
  GITHUB_JOB="operator-runbook-gates" \
  GITHUB_JOB_NAME="Operator runbook gates" \
  GITHUB_API_URL="https://api.github.test" \
  "$TOOL" report 2>&1
)"; RC=$?
[[ "$RC" -eq 3 ]]
assert $? "a reporter boundary that stays stale is refused" "got exit $RC"
grep -q 'reporter boundary did not settle' <<< "$OUT_UNSETTLED_REPORTER"
assert $? "the unsettled reporter boundary explains the refusal" \
  "the refusal did not identify the missing live reporter marker"
! grep -q '::error' <<< "$OUT_UNSETTLED_REPORTER"
assert $? "an unsettled reporter boundary is not misreported as a dark-step finding" \
  "the reporter classified gates using a stale boundary"
[[ "$(<"$TMP/stale-reporter-stable-count")" -eq 6 ]]
assert $? "the stale reporter boundary stops after the bounded refresh window" \
  "expected an initial read plus five refreshes"

jq '(.steps[] | select(.name == "Finalize operator report")) |= (.status = "pending" | .conclusion = null)' \
  "$LIVE_GATE_INFLIGHT" > "$TMP/lagging-job.json"
jq '.id=41' "$TMP/lagging-job.json" > "$TMP/lagging-job-id.json"
jq '{jobs:[.]}' "$TMP/lagging-job-id.json" > "$TMP/lagging-jobs-first.json"
jq '(.steps[] | select(.name == "Finalize operator report")) |= (.status = "completed" | .conclusion = "success")' \
  "$LIVE_GATE_INFLIGHT" > "$TMP/settled-job.json"
jq -n --slurpfile target "$TMP/lagging-job-id.json" '{jobs:[($target[0] | .id=42), $target[0]]}' \
  > "$TMP/lagging-jobs-decoy.json"
jq '.id=41' "$TMP/settled-job.json" > "$TMP/settled-job-id.json"
jq -n --slurpfile target "$TMP/settled-job-id.json" '{jobs:[($target[0] | .id=42), $target[0]]}' \
  > "$TMP/settled-jobs-decoy.json"
jq '.id=41' "$LIVE_GATE_INFLIGHT" > "$TMP/inprogress-job-id.json"
jq '{jobs:[.]}' "$TMP/inprogress-job-id.json" > "$TMP/inprogress-jobs-first.json"

# Clear shell startup hooks so the test curl/sleep stubs stay first on PATH.
OUT_POLL="$(
  env -u BASH_ENV \
  PATH="$TMP/mock-bin:$PATH" \
  CURL_FIRST_RESPONSE="$TMP/lagging-jobs-first.json" \
  CURL_SECOND_RESPONSE="$TMP/lagging-jobs-decoy.json" \
  CURL_REST_RESPONSE="$TMP/settled-jobs-decoy.json" \
  CURL_COUNT_FILE="$TMP/lag-poll-count" \
  CURL_ARGS_FILE="$TMP/lag-curl-args" \
  SLEEP_ARGS_FILE="$TMP/lag-sleep-args" \
  GH_TOKEN="test-token" \
  GITHUB_REPOSITORY="TogetherWeOwn/paperclip-operator-toolkit" \
  GITHUB_RUN_ID="1" \
  GITHUB_RUN_ATTEMPT="1" \
  GITHUB_JOB="operator-runbook-gates" \
  GITHUB_JOB_NAME="Operator runbook gates" \
  GITHUB_API_URL="https://api.github.test" \
  "$TOOL" report 2>&1
)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "the live API settles a lagging pending/null gate before reporting" "got exit $RC: $OUT_POLL"

! grep -q '::error' <<< "$OUT_POLL"
assert $? "a lagging pending/null API view does not raise a false error" \
  "the reporter called a completed gate dark"
grep -q 'all 5 steps executed' <<< "$OUT_POLL"
assert $? "a lagging pending/null API view is retried before dark classification" \
  "the settled green gate was not confirmed"
grep -q 'Executed: 5 passed, 0 failed. In progress: 0. Not run: 0. Other outcomes: 0.' <<< "$OUT_POLL"
assert $? "the settled API view reports the completed gate as passed" \
  "the post-poll tally does not match the settled gate state"
LAG_CALLS="$(<"$TMP/lag-poll-count")"
[[ "$LAG_CALLS" -ge 3 ]]
assert $? "the API view is checked again after repeated stale snapshots" \
  "expected at least 3 calls, got $LAG_CALLS"
grep -q -- '--connect-timeout 5 --max-time 5' "$TMP/lag-curl-args"
assert $? "the initial live API request has a finite timeout" \
  "the first request did not carry its five-second timeout"
[[ "$(grep -c -- '--connect-timeout 2 --max-time 2' "$TMP/lag-curl-args")" -eq 2 ]]
assert $? "each live refresh request has a finite timeout" \
  "expected two two-second refreshes in: $(<"$TMP/lag-curl-args")"
[[ "$(<"$TMP/lag-sleep-args")" == $'1\n1' ]]
assert $? "the live refresh waits one second between requests" \
  "unexpected refresh delays: $(<"$TMP/lag-sleep-args")"

# A preceding gate still marked in progress while the reporter is running is
# another stale live view; refresh until that gate reaches its verdict.
OUT_INFLIGHT_API="$(
  env -u BASH_ENV \
  PATH="$TMP/mock-bin:$PATH" \
  CURL_FIRST_RESPONSE="$TMP/inprogress-jobs-first.json" \
  CURL_SECOND_RESPONSE="$TMP/settled-jobs-decoy.json" \
  CURL_REST_RESPONSE="$TMP/settled-jobs-decoy.json" \
  CURL_COUNT_FILE="$TMP/inprogress-poll-count" \
  CURL_ARGS_FILE="$TMP/inprogress-curl-args" \
  SLEEP_ARGS_FILE="$TMP/inprogress-sleep-args" \
  GH_TOKEN="test-token" \
  GITHUB_REPOSITORY="TogetherWeOwn/paperclip-operator-toolkit" \
  GITHUB_RUN_ID="5" \
  GITHUB_RUN_ATTEMPT="1" \
  GITHUB_JOB="operator-runbook-gates" \
  GITHUB_JOB_NAME="Operator runbook gates" \
  GITHUB_API_URL="https://api.github.test" \
  "$TOOL" report 2>&1
)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a live in-progress gate is refreshed before reporting" "got exit $RC"
! grep -q '::error' <<< "$OUT_INFLIGHT_API"
assert $? "a stale in-progress gate does not raise a false error" \
  "the reporter classified a gate before its API status settled"
! grep -q 'still in progress' <<< "$OUT_INFLIGHT_API"
assert $? "a live in-progress gate is not left stale in the final report" \
  "the settled gate is still reported as in progress"
grep -q 'all 5 steps executed' <<< "$OUT_INFLIGHT_API"
assert $? "a live in-progress gate resolves to the settled gate count" \
  "the reporter did not confirm all five completed gates"
[[ "$(<"$TMP/inprogress-poll-count")" -eq 2 ]]
assert $? "the live in-progress gate settles after one refresh" \
  "expected initial and one refreshed API read"

# A real fail-fast abort remains dark when its null-conclusion snapshot is
# stable across repeated reads.
jq '(.steps[] | select(.name == "Report steps that never ran")) |= (.status = "in_progress") | {jobs:[.]}' \
  "$ABORT_NULL_REPORTABLE" > "$TMP/abort-jobs.json"
OUT_ABORT_API="$(
  env -u BASH_ENV \
  PATH="$TMP/mock-bin:$PATH" \
  CURL_FIRST_RESPONSE="$TMP/abort-jobs.json" \
  CURL_SECOND_RESPONSE="$TMP/abort-jobs.json" \
  CURL_REST_RESPONSE="$TMP/abort-jobs.json" \
  CURL_COUNT_FILE="$TMP/abort-poll-count" \
  CURL_ARGS_FILE="$TMP/abort-curl-args" \
  SLEEP_ARGS_FILE="$TMP/abort-sleep-args" \
  GH_TOKEN="test-token" \
  GITHUB_REPOSITORY="TogetherWeOwn/paperclip-operator-toolkit" \
  GITHUB_RUN_ID="2" \
  GITHUB_RUN_ATTEMPT="1" \
  GITHUB_JOB="offline-suites" \
  GITHUB_JOB_NAME="Offline suites" \
  GITHUB_API_URL="https://api.github.test" \
  "$TOOL" report 2>&1
)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a stable abort-null API view still exits 0" "got exit $RC"
grep -q '55 of 136 steps never ran' <<< "$OUT_ABORT_API"
assert $? "pending/null steps remain dark after the API view stabilizes" \
  "the reporter lost the fail-fast abort's unrun gates"
grep -q '::error' <<< "$OUT_ABORT_API"
assert $? "a stable abort-null API view keeps its error annotation" \
  "the abort was silently presented as clean"
ABORT_CALLS="$(<"$TMP/abort-poll-count")"
[[ "$ABORT_CALLS" -eq 6 ]]
assert $? "the stable abort-null view is checked for the full bounded refresh window" \
  "expected the initial read plus five refreshes, got $ABORT_CALLS calls"
[[ "$(grep -c -- '--connect-timeout 2 --max-time 2' "$TMP/abort-curl-args")" -eq 5 ]]
assert $? "every abort-null refresh remains time-bounded" \
  "expected five two-second refresh requests"
[[ "$(grep -c '^1$' "$TMP/abort-sleep-args")" -eq 5 ]]
assert $? "a stable abort-null view waits through the full refresh window" \
  "expected five one-second waits"

# A stable pending/null view without a preceding gate failure could still be a
# green run whose API updates are delayed; refuse rather than call it dark.
jq '(.steps[] | select(.name == "Finalize operator report")) |= (.status = "pending" | .conclusion = null) | .id=41' \
  "$LIVE_GATE_INFLIGHT" > "$TMP/stale-green-job-id.json"
jq '{jobs:[.]}' "$TMP/stale-green-job-id.json" > "$TMP/stale-green-jobs.json"
OUT_STALE_GREEN="$(
  env -u BASH_ENV \
  PATH="$TMP/mock-bin:$PATH" \
  CURL_FIRST_RESPONSE="$TMP/stale-green-jobs.json" \
  CURL_SECOND_RESPONSE="$TMP/stale-green-jobs.json" \
  CURL_REST_RESPONSE="$TMP/stale-green-jobs.json" \
  CURL_COUNT_FILE="$TMP/stale-green-poll-count" \
  CURL_ARGS_FILE="$TMP/stale-green-curl-args" \
  SLEEP_ARGS_FILE="$TMP/stale-green-sleep-args" \
  GH_TOKEN="test-token" \
  GITHUB_REPOSITORY="TogetherWeOwn/paperclip-operator-toolkit" \
  GITHUB_RUN_ID="7" \
  GITHUB_RUN_ATTEMPT="1" \
  GITHUB_JOB="operator-runbook-gates" \
  GITHUB_JOB_NAME="Operator runbook gates" \
  GITHUB_API_URL="https://api.github.test" \
  "$TOOL" report 2>&1
)"; RC=$?
[[ "$RC" -eq 3 ]]
assert $? "a stable stale-green API view is refused rather than called dark" "got exit $RC"
grep -q 'do not follow a confirmed abort' <<< "$OUT_STALE_GREEN"
assert $? "a stable stale-green refusal requires a confirmed failed gate" \
  "the reporter treated an unresolved green view as a fail-fast abort"
! grep -q '::error' <<< "$OUT_STALE_GREEN"
assert $? "a stable stale-green view raises no dark-step error annotation" \
  "stale pending/null data was reported as a real dark-step finding"
[[ "$(<"$TMP/stale-green-poll-count")" -eq 6 ]]
assert $? "a stable stale-green view waits through the bounded refresh window" \
  "expected an initial read plus five refreshes"

# A changing ambiguous view must refuse rather than guess that it is dark.
jq '(.steps[] | select(.name == "Finalize operator report")) |= (.status = "queued" | .conclusion = null)' \
  "$LIVE_GATE_INFLIGHT" > "$TMP/unstable-job-queued.json"
jq '.id=41' "$TMP/unstable-job-queued.json" > "$TMP/unstable-job-queued-id.json"
jq '{jobs:[.]}' "$TMP/lagging-job-id.json" > "$TMP/unstable-jobs-pending.json"
jq '{jobs:[.]}' "$TMP/unstable-job-queued-id.json" > "$TMP/unstable-jobs-queued.json"
OUT_UNSTABLE="$(
  env -u BASH_ENV \
  PATH="$TMP/mock-bin:$PATH" \
  CURL_FIRST_RESPONSE="$TMP/unstable-jobs-pending.json" \
  CURL_SECOND_RESPONSE="$TMP/unstable-jobs-queued.json" \
  CURL_REST_RESPONSE="$TMP/unstable-jobs-pending.json" \
  CURL_ALTERNATE_RESPONSES="1" \
  CURL_COUNT_FILE="$TMP/unstable-poll-count" \
  CURL_ARGS_FILE="$TMP/unstable-curl-args" \
  SLEEP_ARGS_FILE="$TMP/unstable-sleep-args" \
  GH_TOKEN="test-token" \
  GITHUB_REPOSITORY="TogetherWeOwn/paperclip-operator-toolkit" \
  GITHUB_RUN_ID="3" \
  GITHUB_RUN_ATTEMPT="1" \
  GITHUB_JOB="operator-runbook-gates" \
  GITHUB_JOB_NAME="Operator runbook gates" \
  GITHUB_API_URL="https://api.github.test" \
  "$TOOL" report 2>&1
)"; RC=$?
[[ "$RC" -eq 3 ]]
assert $? "a changing ambiguous API view refuses to guess" "got exit $RC"
grep -q 'gate steps did not settle within 15 seconds' <<< "$OUT_UNSTABLE"
assert $? "the unsettled API view explains why classification was refused" \
  "the refusal does not name the unsettled gate data"
! grep -q '::error' <<< "$OUT_UNSTABLE"
assert $? "an unsettled API view is not mislabeled as a dark-step finding" \
  "the reporter classified an API view that never stabilized"
[[ "$(<"$TMP/unstable-poll-count")" -eq 6 ]]
assert $? "the unsettled API view stops after the bounded refresh window" \
  "expected one initial read plus five refreshes"

# ---------------------------------------------------------------------------
hdr "Refusal — a check that did not happen must never read as clean (TOG-357)"

echo '{"name":"x","steps":[]}' > "$TMP/empty.json"
OUT_E="$("$TOOL" report --job-json "$TMP/empty.json" 2>&1)"; RC=$?
[[ "$RC" -eq 3 ]]
assert $? "an empty step list REFUSES rather than reporting zero dark steps" \
  "got exit $RC — 'no steps skipped' out of no data is a false green"
grep -q 'REFUSED' <<< "$OUT_E"
assert $? "the refusal says so in words" "refusal is not labelled"

jq -n '{name:"x",steps:[{conclusion:"success",name:"Set up job",number:1,status:"completed"},{conclusion:null,name:"Report steps that never ran",number:2,status:"in_progress"},{conclusion:null,name:"Post Run cleanup",number:3,status:"queued"},{conclusion:null,name:"Complete job",number:4,status:"queued"}]}' \
  > "$TMP/no-gates.json"
OUT_NG="$("$TOOL" report --job-json "$TMP/no-gates.json" 2>&1)"; RC=$?
[[ "$RC" -eq 3 ]]
assert $? "a job with only runner lifecycle steps REFUSES" "got exit $RC"

jq -n '{name:"x",steps:[{conclusion:"success",name:"Set up job",number:1,status:"completed"},{conclusion:"skipped",name:"Set up job",number:2,status:"completed"},{conclusion:null,name:"Report steps that never ran",number:3,status:"in_progress"},{conclusion:null,name:"Post Run cleanup",number:4,status:"queued"},{conclusion:null,name:"Complete job",number:5,status:"queued"}]}' \
  > "$TMP/gate-named-like-setup.json"
OUT_DUP="$("$TOOL" report --job-json "$TMP/gate-named-like-setup.json" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a same-named workflow gate is retained" "got exit $RC"
grep -q '1 of 1 steps never ran' <<< "$OUT_DUP"
assert $? "a same-named workflow gate is reported as dark" \
  "the workflow step was masked by the runner setup step"
grep -q 'Set up job' <<< "$OUT_DUP"
assert $? "the same-named workflow gate appears in the dark list" \
  "the workflow step is missing from the dark-step list"

jq -n '{name:"x",steps:[{conclusion:"success",name:"Set up job",number:1,status:"completed"},{conclusion:"skipped",name:"Post deploy verification",number:2,status:"completed"},{conclusion:null,name:"Post Run cleanup",number:3,status:"queued"},{conclusion:null,name:"Complete job",number:4,status:"queued"}]}' \
  > "$TMP/no-reporter.json"
OUT_NR="$("$TOOL" report --job-json "$TMP/no-reporter.json" 2>&1)"; RC=$?
[[ "$RC" -eq 3 ]]
assert $? "a saved job without this reporter refuses its unknown lifecycle boundary" \
  "got exit $RC — the tool must not guess which Post-named steps are runner teardown"

echo '{"name":"x"}' > "$TMP/nosteps.json"
OUT_N="$("$TOOL" report --job-json "$TMP/nosteps.json" 2>&1)"; RC=$?
[[ "$RC" -eq 3 ]]
assert $? "a job object with no steps key REFUSES" "got exit $RC"

OUT_M="$("$TOOL" report --job-json "$TMP/does-not-exist.json" 2>&1)"; RC=$?
[[ "$RC" -eq 3 ]]
assert $? "a missing job file REFUSES" "got exit $RC"

OUT_U="$("$TOOL" 2>&1)"; RC=$?
[[ "$RC" -eq 2 ]]
assert $? "no arguments is a usage error" "got exit $RC"
OUT_B="$("$TOOL" bogus 2>&1)"; RC=$?
[[ "$RC" -eq 2 ]]
assert $? "an unknown subcommand is a usage error" "got exit $RC"

# ---------------------------------------------------------------------------
hdr "The credential never reaches argv (TOG-200)"

! grep -qE 'curl[^|]*(Authorization|\$GH_TOKEN|\$\{GH_TOKEN)' "$TOOL"
assert $? "the token is passed via a header file, never in argv" \
  "the token appears on a curl command line, where /proc exposes it"

# ---------------------------------------------------------------------------
hdr "The ci.yml wiring is load-bearing"

CI="$HERE/.github/workflows/ci.yml"
if [[ -s "$CI" ]]; then
  # Anchor on the STEP DEFINITION at its exact step indentation, not merely on
  # the step's name. The name also appears inside the mutation gate's own sed
  # expression earlier in this same file, and that text contains the literal
  # `if: always()` the assertion is looking for — so a loose /- name: .../ range
  # matches the gate that is testing this assertion and passes by reading it,
  # staying green after the real wiring has lost its `if:`. The gate caught
  # exactly that. Keep the `^      - name:` anchor.
  STEP="$(awk '/^      - name: Report steps that never ran$/,/^$/' "$CI")"

  [[ -n "$STEP" ]]
  assert $? "the reporter step is present in ci.yml at step indentation" \
    "no step definition found, so the wiring assertions below would be vacuous"

  # A reporter that is an ordinary step in a fail-fast job is skipped by the
  # very abort it exists to describe. `if: always()` is the feature.
  grep -q 'if: always()' <<< "$STEP"
  assert $? "the reporter step is wired with if: always()" \
    "without it the reporter is skipped on exactly the runs that need it"

  grep -q 'ci_dark_steps.sh' <<< "$STEP"
  assert $? "the reporter step invokes ci_dark_steps.sh" "the step does not call the tool"

  # Each reporter step must carry its containing job's DISPLAY name. GITHUB_JOB
  # is the key (`offline-suites`) while the API lists the display name
  # (`Offline suites`); without GITHUB_JOB_NAME the key-vs-name match misses
  # and the fallback reports on whichever parallel job is still running — a
  # cross-job annotation that says nothing true about either job. The expected
  # name is read from the job itself, so renaming the job (or the env) fails
  # this assertion instead of silently misreporting.
  WIRING="$(awk '
    /^  [A-Za-z0-9_-]+:/ { job=$1; sub(/:$/, "", job); jname="" }
    /^    name: / { jname=$0; sub(/^    name: /, "", jname) }
    /^      - name: Report steps that never ran$/ { inrep=1; repjob=job; repname=jname; n=0; val=""; always=0; token=0; command=0 }
    inrep == 1 { n++
      if ($0 ~ /GITHUB_JOB_NAME:/) { val=$0; sub(/^.*GITHUB_JOB_NAME:[ ]*/, "", val) }
      if ($0 ~ /if: always\(\)/) always=1
      if ($0 ~ /GH_TOKEN: \$\{\{ github.token \}\}/) token=1
      if ($0 ~ /run: \.\/ci_dark_steps\.sh report \|\| true/) command=1
      if (n >= 8) { print repjob "|" repname "|" val "|" always "|" token "|" command; inrep=0 }
    }
  ' "$CI")"

  [[ -n "$WIRING" ]]
  assert $? "every reporter step resolves to the job that contains it" \
    "no reporter wiring found, so the job-name assertions below would be vacuous"

  WIRING_COUNT="$(printf '%s\n' "$WIRING" | wc -l)"
  [[ "$WIRING_COUNT" -eq 2 ]]
  assert $? "both reporter wirings carry a job-name pin" \
    "expected 2 reporter steps, found $WIRING_COUNT — a wiring was added or removed without a pin"

  while IFS='|' read -r rj rn vv has_always has_token has_command; do
    [[ -n "$vv" ]]
    assert $? "the $rj reporter step sets GITHUB_JOB_NAME" \
      "without it the tool falls back to whichever parallel job is still running"
    [[ -n "$rn" && "$vv" == "$rn" ]]
    assert $? "the $rj reporter step names its job's display name" \
      "sets '$vv' but the job is named '$rn' — the key-vs-name match misses"
    [[ "$has_always" == 1 ]]
    assert $? "the $rj reporter step is wired with if: always()" \
      "without it the reporter is skipped on exactly the runs that need it"
    [[ "$has_token" == 1 ]]
    assert $? "the $rj reporter step receives the Actions token" \
      "without GH_TOKEN the reporter cannot list its job steps"
    [[ "$has_command" == 1 ]]
    assert $? "the $rj reporter step invokes ci_dark_steps.sh" \
      "the reporter command is missing from this job"
  done <<< "$WIRING"

  ACTIONS_READ="$(awk '
    /^permissions:$/ { inperm=1; next }
    inperm && /^[^ ]/ { inperm=0 }
    inperm && /^  actions: read$/ { found=1 }
    END { print found+0 }
  ' "$CI")"
  [[ "$ACTIONS_READ" == 1 ]]
  assert $? "the workflow grants actions: read for the live reporter" \
    "the reporter cannot list job steps without the read-only Actions permission"

  AFTER_REPORTER="$(awk '
    /^  [A-Za-z0-9_-]+:/ { job=$1; sub(/:$/, "", job); checking=0 }
    /^      - name: Report steps that never ran$/ { reporter=job; checking=1; next }
    checking && /^      - / { print reporter; checking=0 }
  ' "$CI")"
  [[ -z "$AFTER_REPORTER" ]]
  assert $? "each reporter is the last configured workflow step" \
    "a workflow step follows the reporter, so its position cannot mark runner teardown"
else
  bad "ci.yml is readable for the wiring assertions"
fi

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ "$PASS" -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
