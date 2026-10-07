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
# Offline by construction: every case is served from a recorded file via
# --job-json. No network, no credential. Requires jq.
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
OUT_R="$($TOOL report --job-json "$TMP/live-reporter-name-gate.json" 2>&1)"; RC=$?
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
    /^      - name: Report steps that never ran$/ { inrep=1; repjob=job; repname=jname; n=0; val="" }
    inrep == 1 { n++
      if ($0 ~ /GITHUB_JOB_NAME:/) { val=$0; sub(/^.*GITHUB_JOB_NAME:[ ]*/, "", val) }
      if (n >= 8) { print repjob "|" repname "|" val; inrep=0 }
    }
  ' "$CI")"

  [[ -n "$WIRING" ]]
  assert $? "every reporter step resolves to the job that contains it" \
    "no reporter wiring found, so the job-name assertions below would be vacuous"

  WIRING_COUNT="$(printf '%s\n' "$WIRING" | wc -l)"
  [[ "$WIRING_COUNT" -eq 2 ]]
  assert $? "both reporter wirings carry a job-name pin" \
    "expected 2 reporter steps, found $WIRING_COUNT — a wiring was added or removed without a pin"

  while IFS='|' read -r rj rn vv; do
    [[ -n "$vv" ]]
    assert $? "the $rj reporter step sets GITHUB_JOB_NAME" \
      "without it the tool falls back to whichever parallel job is still running"
    [[ -n "$rn" && "$vv" == "$rn" ]]
    assert $? "the $rj reporter step names its job's display name" \
      "sets '$vv' but the job is named '$rn' — the key-vs-name match misses"
  done <<< "$WIRING"

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
