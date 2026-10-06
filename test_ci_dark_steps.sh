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
# with the test author, not with GitHub. Both fixtures are the verbatim
# `actions/jobs/{id}` response for the two runs named in TOG-910:
#
#   job-100695318458-dark.json    pristine main e9dea118 — 13 success, 1 failure,
#                                 79 skipped. The outage itself. Two of the 93
#                                 are runner teardown (`Post ...`), which the
#                                 gate set excludes, so the tool reports 78 dark
#                                 of 91 gate steps with a 12/1/78 tally. One of the 79 is
#                                 the runner's `Post Run actions/setup-node@v4`
#                                 teardown, which TOG-13080 exempts from the dark
#                                 set (teardown is not a gate), so the tool
#                                 reports 78 dark here.
#   job-100786202472-green.json   PR #198 d794f39c — 95 steps, 0 skipped. The
#                                 same job once the expiry was re-issued.
#   job-105959891748-abort-null.json  run 35466576547, Offline suites, TOG-3427:
#                                 80 success, 1 failure, 55 conclusions still
#                                 `null` — the at-report-time view of a fail-fast
#                                 abort. CONSTRUCTED, not recorded: the finalised
#                                 job object rewrites those nulls to "skipped",
#                                 which is exactly the state that hid the bug, so
#                                 re-recording this fixture from the API would
#                                 un-write the test. Counts match the card.
#   job-live-green-reporter-inflight.json  TOG-13080: the at-report-time view of
#                                 a GREEN job — 3 success, the reporter itself
#                                 still in_progress (conclusion null), 2 `Post`
#                                 teardown steps still queued. CONSTRUCTED: the
#                                 finalised job object rewrites those nulls, so
#                                 re-recording it from the API would un-write the
#                                 test. Must read 0 dark with no ::error.
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
for f in "$DARK" "$GREEN" "$ABORT_NULL" "$LIVE_GREEN"; do
  [[ -s "$f" ]] || { echo "test_ci_dark_steps: recorded fixture missing or empty: $f" >&2; exit 2; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
hdr "The outage fixture — what a dark run must say"

OUT="$("$TOOL" report --job-json "$DARK" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a dark run still exits 0" \
  "got exit $RC — the reporter must not replace the real failure's attribution"

# 91 gate steps (93 registered minus 2 `Post` teardowns): 12 passed, 1 failed,
# 78 dark. The tally must add up over the same set the banner counts.
grep -q '78 of 91 steps never ran' <<< "$OUT"
assert $? "the dark run names the count of steps that did not execute" \
  "expected '78 of 91 steps never ran'"

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

# 12 + 1 + 78 = 91: the tally adds up over the gate set (one of the 13
# recorded successes is an exempted `Post` teardown). If the arithmetic drifts,
# the report is worse than nothing because it looks authoritative.
grep -q 'Executed: 12 passed, 1 failed. Not run: 78.' <<< "$OUT"
assert $? "the executed/not-run tally is reported exactly" \
  "tally line missing or wrong"

grep -q '2 non-gate steps excluded' <<< "$OUT"
assert $? "the dark report discloses the excluded non-gate steps" \
  "the exemption is silent, so the banner looks like it covers all 93 steps"

# ---------------------------------------------------------------------------
hdr "The fail-fast abort as the reporter sees it — null conclusions are dark (TOG-3427)"

OUT_A="$("$TOOL" report --job-json "$ABORT_NULL" 2>&1)"; RC=$?
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

grep -q 'Executed: 80 passed, 1 failed. Not run: 55.' <<< "$OUT_A"
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

OUT_G="$("$TOOL" report --job-json "$GREEN" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]]
assert $? "a fully-executed run exits 0" "got exit $RC"

! grep -q '::error' <<< "$OUT_G"
assert $? "a fully-executed run raises no error annotation" \
  "the reporter cries wolf on a clean run, which trains reviewers to ignore it"

! grep -qi 'never ran' <<< "$OUT_G"
assert $? "a fully-executed run reports no un-run steps" \
  "a clean run is being described as dark"

grep -q 'all 93 steps executed' <<< "$OUT_G"
assert $? "a fully-executed run states the number of steps it confirmed" \
  "the positive confirmation is missing, so 'no news' is ambiguous"

grep -q '2 non-gate steps excluded' <<< "$OUT_G"
assert $? "a fully-executed run discloses the excluded non-gate steps" \
  "the banner claims 93 while the job registered 95"

# ---------------------------------------------------------------------------
hdr "The live view — the reporter exempts itself and teardown (TOG-13080)"

# At report time the live job object always holds the reporter's OWN step
# (in_progress, conclusion null) plus queued `Post` teardown steps. Before the
# exemption every green job printed an ::error annotation about itself — the
# cry-wolf failure this entire tool exists to prevent.
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

grep -q '3 non-gate steps excluded' <<< "$OUT_L"
assert $? "a live green run with the reporter in flight discloses the excluded non-gate steps" \
  "the banner claims 3 while the job registered 6"

# ---------------------------------------------------------------------------
hdr "Refusal — a check that did not happen must never read as clean (TOG-357)"

echo '{"name":"x","steps":[]}' > "$TMP/empty.json"
OUT_E="$("$TOOL" report --job-json "$TMP/empty.json" 2>&1)"; RC=$?
[[ "$RC" -eq 3 ]]
assert $? "an empty step list REFUSES rather than reporting zero dark steps" \
  "got exit $RC — 'no steps skipped' out of no data is a false green"
grep -q 'REFUSED' <<< "$OUT_E"
assert $? "the refusal says so in words" "refusal is not labelled"

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
else
  bad "ci.yml is readable for the wiring assertions"
fi

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ "$PASS" -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
