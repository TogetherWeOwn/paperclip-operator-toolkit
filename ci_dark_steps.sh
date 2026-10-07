#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# Report the steps a fail-fast job REGISTERED BUT NEVER RAN  (TOG-910)
#
# THE BUG THIS EXISTS FOR. `offline-suites` has 89 named steps, no `if:` and no
# `continue-on-error`, so it is strictly fail-fast: the first red aborts every
# step after it. On 2026-09-03T00:00:00Z the OmniRoute rehearsal package's
# `expiresAt` lapsed. That step is number 12 of 89. For the next ~21 hours every
# run of the job died in about 60 seconds having executed 12 steps and SKIPPED
# 79 — including `Secret scan` and every `Prove the suite still detects...`
# mutation gate, i.e. the vacuity protection for the whole repo.
#
# Nothing told anybody. The PR check surface says `Offline suites — failing`,
# and a reviewer reading "14 of 16 checks green" cannot see that one of the two
# reds took 77 other suites down with it. Two steps merged during that window
# (TOG-890's sweep suite and its mutation gate, plus the TOG-833 co-tenancy
# probe) went into `main` having never executed in CI anywhere -- `grep -c` for
# their commands in their own PR's job log returns 0.
#
# WHY THIS IS A REPORTING FIX AND NOT AN ORDERING FIX. The tempting repair is to
# move the calendar-sensitive suite to the end of the job, or to give it
# `continue-on-error`. Both are worse. Fail-fast is the reason a red step is
# loud, and a suite that is allowed to fail quietly is a suite that stops being
# a gate -- exactly the merge-over-red habit this card exists to end. Moving one
# step also fixes nothing for the other 88: whichever step is first to fail
# still silently buries everything behind it. So the defect is not WHERE the
# rehearsal suite sits, it is that "this run measured 12 of 89 things" is
# knowable from the API and is shown to nobody. This tool shows it, for every
# step, whichever one fails.
#
# WHY IT MUST RUN UNDER `if: always()`. A reporter that is itself a plain step
# in a fail-fast job is skipped by the very abort it exists to describe -- it
# would print only on the runs that do not need it. `if: always()` is therefore
# load-bearing, not decoration, and test_ci_dark_steps.sh pins the ci.yml wiring
# so it cannot be dropped.
#
# WHY IT NEVER FAILS THE BUILD. The job's real verdict is the failing suite. If
# this reporter exited non-zero it would replace an attributable failure ("the
# rehearsal package expired") with an unattributable one ("dark-step report
# failed"), which is the TOG-339 attribution problem. It annotates and returns
# 0. The one exception is a REFUSAL (exit 3): if it cannot observe the step
# list at all it says so loudly rather than printing "0 dark steps", because a
# check that did not happen must never read as a clean answer (TOG-357).
#
# Reads: GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_JOB,
#        GITHUB_JOB_NAME, GITHUB_STEP_SUMMARY, GH_TOKEN (needs actions:read).
# Requires curl and jq; live API retries also require sleep. Credentials stay in a header file.
# ===========================================================================

ME="$(basename "${BASH_SOURCE[0]}")"

usage() {
  cat <<'USAGE'
  ./ci_dark_steps.sh report                 # annotate the running job (CI use)
  ./ci_dark_steps.sh report --job-json FILE # report a saved job with this reporter step
  ./ci_dark_steps.sh help

Reports the steps a job registered but never executed, because a fail-fast
abort skipped them.

EXIT CODES
  0  reported (whether or not dark steps were found)
  2  usage error
  3  REFUSED — the step list could not be observed. Never confused with "clean".
USAGE
}

die()    { printf '%s: %s\n' "$ME" "$1" >&2; exit "${2:-2}"; }
refuse() { printf '%s: REFUSED: %s\n' "$ME" "$1" >&2; exit 3; }

# --- argument parsing ---------------------------------------------------------
[[ $# -ge 1 ]] || { usage >&2; exit 2; }
CMD="$1"; shift
case "$CMD" in
  help|--help|-h) usage; exit 0 ;;
  report) ;;
  *) usage >&2; exit 2 ;;
esac

JOB_JSON=""
API="${GITHUB_API_URL:-https://api.github.com}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --job-json) [[ $# -ge 2 ]] || die "--job-json needs a path"; JOB_JSON="$2"; shift 2 ;;
    *) die "unexpected argument: $1" ;;
  esac
done

for c in jq curl; do
  command -v "$c" >/dev/null 2>&1 || die "$c is required"
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- obtain the job object ----------------------------------------------------
# Either from a reporter-instrumented file (tests and re-analysis of a run with
# this reporter) or from the API for the job this script is running inside.
LIVE_API=0
fetch_api_job() {
  local -a timeout_args=()
  if [[ $# -gt 0 ]]; then
    timeout_args=(--connect-timeout "$1" --max-time "$1")
  fi
  CODE="$(curl "${timeout_args[@]}" -sS -o "$TMP/jobs.json" -w '%{http_code}' -H @"$HDR" "$URL" 2>"$TMP/curl.err")"
  [[ "$CODE" == "200" ]] || refuse "listing jobs returned HTTP $CODE (actions:read missing?)"

  if [[ -n "${API_JOB_ID:-}" ]]; then
    jq --arg id "$API_JOB_ID" \
       '[.jobs[] | select((.id | tostring) == $id)] | first // empty' \
       "$TMP/jobs.json" > "$TMP/job.json"
  else
    # Match by the workflow KEY where the API exposes it, else by display name.
    # `GITHUB_JOB` is the key (`offline-suites`); `.name` is the display name
    # ("Offline suites"), so try both rather than assuming they match.
    jq --arg key "$GITHUB_JOB" --arg nm "${GITHUB_JOB_NAME:-}" \
       '[.jobs[] | select(.name == $key or .name == $nm)] | first // empty' \
       "$TMP/jobs.json" > "$TMP/job.json"
    if [[ ! -s "$TMP/job.json" ]]; then
      # Fall back to the only still-running job, which is this one.
      jq '[.jobs[] | select(.status != "completed")] | first // empty' \
         "$TMP/jobs.json" > "$TMP/job.json"
    fi
  fi
  [[ -s "$TMP/job.json" ]] || refuse "could not identify job '${GITHUB_JOB:-?}' in run ${GITHUB_RUN_ID:-?}"
}

validate_job() {
  jq -e 'has("steps") and (.steps | type == "array") and (.steps | length > 0)' \
     "$TMP/job.json" >/dev/null 2>&1 \
    || refuse "the job object carries no step list; nothing was measured"
}

if [[ -n "$JOB_JSON" ]]; then
  [[ -s "$JOB_JSON" ]] || refuse "job json is missing or empty: $JOB_JSON"
  cp "$JOB_JSON" "$TMP/job.json"
else
  : "${GITHUB_REPOSITORY:?}" 2>/dev/null || refuse "GITHUB_REPOSITORY is unset; not running in Actions"
  [[ -n "${GITHUB_RUN_ID:-}" ]]  || refuse "GITHUB_RUN_ID is unset"
  [[ -n "${GITHUB_JOB:-}" ]]     || refuse "GITHUB_JOB is unset"
  [[ -n "${GH_TOKEN:-}" ]]       || refuse "GH_TOKEN is unset; actions:read is required to list job steps"

  LIVE_API=1
  ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
  # The token goes in a header FILE, never in argv — /proc/*/cmdline is
  # world-readable and this host is shared (TOG-200).
  HDR="$TMP/hdr"; umask 077
  printf 'Authorization: Bearer %s\n' "$GH_TOKEN" > "$HDR"
  printf 'Accept: application/vnd.github+json\n' >> "$HDR"

  URL="$API/repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$ATTEMPT/jobs?per_page=100"
  fetch_api_job 5
  API_JOB_ID="$(jq -r '.id // empty' "$TMP/job.json")"
fi

validate_job

# --- classify -----------------------------------------------------------------
# Every count below is taken over workflow gates: steps before the reporter,
# minus runner setup (`Set up job` at step 1). The reporter is the last
# configured workflow step in each instrumented job, so runner-generated
# post-action and completion steps follow it. Use the position boundary rather
# than a `Post ` name prefix: a workflow gate can legitimately start with that.
# TOTAL and DARK must use the same set; otherwise the outage fixture reports a
# dark count that cannot be reconciled with its executed-step tally.
load_gate_set() {
  REPORTER_NO="$(jq -r '[.steps[] | select(.name == "Report steps that never ran") | .number] | last // empty' "$TMP/job.json")"
  REPORTER_STATUS="$(jq -r '[.steps[] | select(.name == "Report steps that never ran") | .status] | last // empty' "$TMP/job.json")"
  REPORTER_VALID=0
  if [[ "$REPORTER_NO" =~ ^[1-9][0-9]*$ ]]; then
    if [[ "$LIVE_API" -eq 0 || "$REPORTER_STATUS" == "in_progress" ]]; then
      REPORTER_VALID=1
    fi
  fi
  if [[ "$REPORTER_VALID" -ne 1 ]]; then
    [[ "$LIVE_API" -eq 1 ]] \
      || refuse "the reporter step is missing; runner lifecycle boundary is unknown"
    : > "$TMP/gate.json"
    TOTAL=0
    return 0
  fi
  jq --argjson reporter "$REPORTER_NO" \
    '[.steps[] | select((.name != "Set up job" or .number != 1) and .number < $reporter)]' \
    "$TMP/job.json" > "$TMP/gate.json"
  TOTAL="$(jq 'length' "$TMP/gate.json")"
  [[ "$TOTAL" -gt 0 ]] || refuse "the gate set is empty; nothing was measured"
}

has_ambiguous_gate() {
  if [[ "$LIVE_API" -eq 1 && "$REPORTER_VALID" -ne 1 ]]; then
    return 0
  fi
  jq -e '[.[] | select(.conclusion == null)] | length > 0' \
    "$TMP/gate.json" >/dev/null
}

load_gate_set
if [[ "$LIVE_API" -eq 1 ]] && has_ambiguous_gate; then
  command -v sleep >/dev/null 2>&1 || refuse "sleep is required to settle live step data"
  # A null conclusion can mean an unreached fail-fast gate or a just-run gate
  # whose API update has not landed yet. The reporter runs after every gate, so
  # even an in_progress gate status may be stale. Re-read the live view five
  # times. Only stable nulls after a confirmed failed gate are safe to call dark;
  # otherwise refuse rather than emit a false error on a green job. Five
  # 1-second sleeps and 2-second request limits bound refreshes to 15 seconds.
  previous_signature="$(jq -c '[.steps[] | [.number, .name, .status, .conclusion]]' "$TMP/job.json")"
  stable_repeats=0
  settled=0
  for ((poll=1; poll<=5; poll++)); do
    sleep 1
    fetch_api_job 2
    validate_job
    load_gate_set
    if ! has_ambiguous_gate; then
      settled=1
      break
    fi

    signature="$(jq -c '[.steps[] | [.number, .name, .status, .conclusion]]' "$TMP/job.json")"
    if [[ "$signature" == "$previous_signature" ]]; then
      stable_repeats=$((stable_repeats + 1))
    else
      stable_repeats=0
    fi
    previous_signature="$signature"
  done
  if [[ "$stable_repeats" -ge 2 ]]; then
    [[ "$REPORTER_VALID" -eq 1 ]] \
      || refuse "reporter boundary did not settle within 15 seconds; refusing to guess which steps are gates"
    jq -e '
      . as $steps
      | ([$steps[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "startup_failure")] | first | .number) as $abort
      | $abort != null
        and ([$steps[] | select(.conclusion == null)] | all(.number > $abort and .status != "in_progress"))
    ' "$TMP/gate.json" >/dev/null \
      || refuse "stable null gate steps do not follow a confirmed abort; refusing to classify them as dark"
    settled=1
  fi
  [[ "$settled" -eq 1 ]] \
    || refuse "gate steps did not settle within 15 seconds; refusing to guess which null conclusions are dark"
fi

JOB_NAME="$(jq -r '.name // "?"' "$TMP/job.json")"
FULL="$(jq '[.steps[]] | length' "$TMP/job.json")"
RAN="$(jq '[.[] | select(.conclusion == "success")] | length' "$TMP/gate.json")"
FAILED="$(jq '[.[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "startup_failure")] | length' "$TMP/gate.json")"
# Dark means "registered but never executed": a skipped step, or a null
# conclusion on a step that has not started. A live in-progress step has
# started and may only be awaiting its final API update. Completed timeouts and
# other nonstandard conclusions are surfaced separately, not called dark.
IN_PROGRESS="$(jq '[.[] | select(.status == "in_progress" and .conclusion == null)] | length' "$TMP/gate.json")"
DARK_FILTER='select(.conclusion == "skipped" or (.conclusion == null and .status != "in_progress"))'
DARK="$(jq '[.[] | '"$DARK_FILTER"'] | length' "$TMP/gate.json")"
OTHER_FILTER='select(.conclusion != null and .conclusion != "success" and .conclusion != "failure" and .conclusion != "timed_out" and .conclusion != "startup_failure" and .conclusion != "skipped")'
OTHER="$(jq '[.[] | '"$OTHER_FILTER"'] | length' "$TMP/gate.json")"
EXEMPT="$((FULL - TOTAL))"

CULPRIT="$(jq -r '[.[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "startup_failure")] | first | .name // ""' "$TMP/gate.json")"
CULPRIT_NO="$(jq -r '[.[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "startup_failure")] | first | .number // ""' "$TMP/gate.json")"

jq -r '[.[] | '"$DARK_FILTER"'][] | "  \(.number)\t\(.name)"' \
   "$TMP/gate.json" > "$TMP/dark.txt"
jq -r '[.[] | '"$OTHER_FILTER"'][] | "  \(.number)\t\(.name)\t\(.conclusion)"' \
   "$TMP/gate.json" > "$TMP/other.txt"

# --- report -------------------------------------------------------------------
emit() { printf '%s\n' "$1"; [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; return 0; }

emit_other() {
  [[ "$OTHER" -gt 0 ]] || return 0
  emit ""
  emit '<details><summary>Steps with other conclusions</summary>'
  emit ""
  emit '```'
  while IFS=$'\t' read -r num name conclusion; do
    emit "$(printf '%-4s %s (%s)' "${num# }" "$name" "$conclusion")"
  done < "$TMP/other.txt"
  emit '```'
  emit '</details>'
}

if [[ "$DARK" -eq 0 ]]; then
  if [[ "$IN_PROGRESS" -gt 0 ]]; then
    STEP_WORD="steps"; [[ "$IN_PROGRESS" -eq 1 ]] && STEP_WORD="step"
    emit "### ⏳ ${JOB_NAME}: ${IN_PROGRESS} gate ${STEP_WORD} still in progress"
    emit ""
    emit "No gate step was identified as never started. Any in-progress gate step began but had not reached a verdict when this report ran."
  elif [[ "$OTHER" -gt 0 ]]; then
    OTHER_WORD="steps"; OTHER_VERB="have"
    if [[ "$OTHER" -eq 1 ]]; then OTHER_WORD="step"; OTHER_VERB="has"; fi
    emit "### ⚠️ ${JOB_NAME}: ${OTHER} gate ${OTHER_WORD} ${OTHER_VERB} nonstandard conclusions"
    emit ""
    emit "No gate step was identified as never started, but these outcomes are not counted as passed, failed, or not run."
  else
    emit "### ✅ ${JOB_NAME}: all ${TOTAL} steps executed"
    emit ""
    emit "No gate step was skipped, so every gate in this job is load-bearing on this run."
  fi
  emit ""
  emit "Executed: ${RAN} passed, ${FAILED} failed. In progress: ${IN_PROGRESS}. Not run: ${DARK}. Other outcomes: ${OTHER}."
  emit_other
  if [[ "$EXEMPT" -gt 0 ]]; then
    emit ""
    emit "(${EXEMPT} non-gate steps excluded from this count: reporter and runner lifecycle.)"
  fi
  exit 0
fi

# A dark run is the whole point of this tool, so make it impossible to miss on
# the Actions UI: a ::error annotation appears on the run summary itself.
printf '::error title=%s::%s of %s steps never ran%s\n' \
  "$DARK dark steps in $JOB_NAME" "$DARK" "$TOTAL" \
  "${CULPRIT:+ — aborted at step $CULPRIT_NO, \"$CULPRIT\"}"

emit "### ⚠️ ${JOB_NAME}: ${DARK} of ${TOTAL} steps never ran"
emit ""
if [[ -n "$CULPRIT" ]]; then
  emit "The job is fail-fast. It aborted at step **${CULPRIT_NO} — ${CULPRIT}**, so the"
  emit "**${DARK}** steps below were registered but never executed. Whatever they"
  emit "assert was **not** checked on this run, and a green tick elsewhere on this"
  emit "PR does not cover them."
else
  emit "**${DARK}** steps were registered but never executed on this run."
fi
emit ""
emit "Executed: ${RAN} passed, ${FAILED} failed. In progress: ${IN_PROGRESS}. Not run: ${DARK}. Other outcomes: ${OTHER}."
emit_other
if [[ "$EXEMPT" -gt 0 ]]; then
  emit ""
  emit "(${EXEMPT} non-gate steps excluded from this count: reporter and runner lifecycle.)"
fi
emit ""
emit '<details><summary>Steps that did not run</summary>'
emit ""
emit '```'
while IFS=$'\t' read -r num name; do
  emit "$(printf '%-4s %s' "${num# }" "$name")"
done < "$TMP/dark.txt"
emit '```'
emit '</details>'

exit 0
