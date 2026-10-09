#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# CI status reader that FAILS CLOSED  (TOG-247)
#
# The problem this exists for. An agent pushes a branch, opens a PR, and wants
# to know whether CI passed before asking anyone to merge. The obvious call is
#
#     GET /repos/{o}/{r}/commits/{sha}/check-runs
#
# and the obvious gate is "every run concluded success". That gate is WRONG in
# three distinct ways. Two of them read as green:
#
#   1. DENIED.   A broker token without `checks:read` gets 403. A gate that
#      only inspects `.check_runs[]` sees an empty array in the parse and
#      concludes "no CI configured, nothing to wait for".
#   2. VACUOUS.  Even WITH `checks:read`, a ref that has no check runs yet
#      returns 200 with `total_count: 0`. That happens for a commit pushed
#      seconds ago — the runs have not been created — and for a commit that
#      genuinely predates CI. "All zero runs succeeded" is trivially true.
#
# The third does not read as green. It reads as RED, which is worse, because a
# red is a believable answer and nobody looks twice:
#
#   3. NON-STARTED (TOG-381). A job blocked at the ACCOUNT level — failed
#      payment, spending limit — is reported by the Checks API as
#      `status: completed, conclusion: failure`. Every field this reader
#      inspected was identical to a job that ran and genuinely failed. So a
#      total Actions outage across the org was indistinguishable from "your
#      tests are broken", and on 2026-08-25 it stayed that way for 21 minutes
#      while four commits merged on the misread.
#
#      These are not the same instruction to a human. "Fix your code" is
#      actionable by the author. "The suite does not exist right now, and every
#      mutation gate in this repo is currently unenforced" is an escalation,
#      and it means no merge gate in the org is load-bearing until it clears.
#
# Measured on TogetherWeOwn/paperclip-ops-tooling, 2026-08-24:
#
#   token permissions                     check-runs @ 829b4e4
#   ------------------------------------  ---------------------------
#   contents,pull_requests,issues,metadata  403 not accessible
#   + workflows:write                       403 not accessible   <- no help
#   + checks:read, statuses:read            200 total_count: 6   <- the default
#   + actions:read, checks:read             200 total_count: 6
#   (checks:read, commit predating CI)      200 total_count: 0   <- vacuous
#   (checks:read, SHA not in repo)          422 no commit found
#
# So on THIS installation a denial is a loud 403 rather than the silent empty
# list the issue predicted — but the vacuous case is real, survives granting
# the permission, and produces the same false green. Hence: three states, never
# two. "I could not observe CI" is a distinct answer from "CI passed", and this
# tool will not collapse them however inconvenient that is at a merge gate.
#
# Since the TOG-247 decision the broker's default profile grants `checks:read`
# and `statuses:read`, so a normally-minted agent token reaches `pass`/`fail`
# here rather than `unknown`. Both remaining reasons for `unknown` are still
# live and still matter: `actions:read` is deliberately NOT granted (it also
# grants workflow LOG download), and the vacuous case above is unaffected by
# any permission. Keep gating on the exit code, not on the presence of a token.
#
# ---------------------------------------------------------------------------
# HOW A NON-START IS RECOGNISED, AND WHY NOT BY DURATION
#
# Two signals separate a non-start from a real red. Both are readable with
# `checks:read` alone — we do NOT have `actions:read` on this installation and
# neither signal below needs it (the annotations endpoint was measured 200 with
# a checks:read-only mint on 2026-08-25).
#
#   DURATION (completed_at - started_at). Measured on this repo, 2026-08-25:
#
#     24f0d30  real, post-recovery   4x success   317s / 51s / 15s / 12s
#     205635c  real, pre-outage      4x success   281s / 51s / 15s / 11s
#     4fd26c0  real red build        2x failure   39s / 41s
#     4f2bea9  non-start             4x failure   3s / 3s / 2s / 2s
#     ae85924  non-start             4x failure   14s / 2s / 2s / 1s
#
#   ANNOTATION. `GET /repos/{o}/{r}/check-runs/{id}/annotations`, which on a
#   non-start carries, at annotation_level `failure`:
#
#     "The job was not started because recent account payments have failed or
#      your spending limit needs to be increased. Please check the 'Billing &
#      plans' section in your settings"
#
#   while the real red build at 4fd26c0 carries "Process completed with exit
#   code 1." at the same level.
#
# The classification is made ON THE ANNOTATION TEXT ONLY. Duration is used
# solely as the cheap prefilter deciding whether to spend the extra API call,
# and it is deliberately GENEROUS, because the two error directions are not
# symmetric:
#
#   prefilter too generous  -> one wasted API call per failed run.
#   prefilter too tight     -> a non-start is silently reported as a red build,
#                              which is the entire bug this exists to fix.
#
# The ranges also overlap in both directions and cannot be separated by a
# threshold even in principle. `ae85924` above contains a non-start that took
# 14 SECONDS, and the `bash -n` syntax scan in our own ci.yml can fail
# legitimately in about 2. Anyone tempted to drop the annotation call and keep
# only the duration test should read those two facts together first.
#
# Wrong in the safe direction, in every case: a red we could not classify —
# annotations denied, endpoint erroring, text we do not recognise — stays
# `fail`. A genuine failure alongside a non-start also stays `fail`, because
# there is real code to fix; the non-starts are still named in the JSON.
# ---------------------------------------------------------------------------
#
# USAGE
#   ./gh_ci_status.sh <owner>/<repo> <ref>
#   ./gh_ci_status.sh TogetherWeOwn/paperclip-ops-tooling 829b4e4
#   ./gh_ci_status.sh --quiet TogetherWeOwn/paperclip-ops-tooling main
#
# EXIT CODES — the whole point. Gate on these, not on stdout.
#   0  pass     at least one CI signal was observed, and all of them succeeded
#   1  fail     a signal was observed and it failed
#   2  pending  a signal was observed and it has not concluded
#   3  unknown  CI could NOT be observed: denied, no signal, or no such ref
#   4  usage    bad arguments / missing token
#   5  non-started  every observed failure is a job GitHub never ran. Not a
#                red build: there is nothing in the diff to fix, and no gate in
#                this repo is being enforced right now. ESCALATE — the fix is
#                account-level (billing / spending limit), not a code change.
#
# Note that 3 is not 0, and neither is 5. If you find yourself writing
# `|| true` around this, the thing you actually want is for a human to look.
# A caller that only understands pass/not-pass is still correct with 5 — it is
# non-zero. A caller that branches on 1 to say "fix your code" is not, which is
# exactly why 5 is its own code and not another 1.
#
# ENVIRONMENT
#   GH_TOKEN     required. Any token: a broker mint, an App installation token,
#                a PAT. Never placed in argv — passed to curl via a header file.
#   GH_API_URL   optional, defaults to https://api.github.com. This is the test
#                seam, same convention as gh-app-token.js.
#   GH_CI_NONSTART_MAX_SECONDS
#                optional, defaults to 60. The duration prefilter above. Raise
#                it freely; the only cost is API calls. Setting it to 0 does
#                NOT disable the feature — it probes every failure.
# ===========================================================================

API="${GH_API_URL:-https://api.github.com}"
QUIET=0

# The duration prefilter for the non-start probe. Generous on purpose — see the
# header. `<= 0` means "probe every failure", which is the correct setting for
# anyone who would rather pay the API calls than reason about a threshold.
NONSTART_MAX_SECONDS="${GH_CI_NONSTART_MAX_SECONDS:-60}"
[[ "$NONSTART_MAX_SECONDS" =~ ^-?[0-9]+$ ]] || NONSTART_MAX_SECONDS=60

# The one string that licenses the NON_STARTED verdict. Matched case-insensitively
# as a substring, against `failure`-level annotations only: a green run carries
# annotations too (24f0d30's Offline suites has a Node 20 deprecation WARNING),
# so "has annotations" is not the signal — this text at this level is.
NONSTART_ANNOTATION_RE='the job was not started because'

# A check-run id is the only remote-supplied value this tool ever puts in a
# request path. Kept as its own predicate so ci.yml can mutate it in isolation.
is_check_run_id() { [[ "$1" =~ ^[0-9]+$ ]]; }

die() { echo "gh_ci_status: $*" >&2; exit 4; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet|-q) QUIET=1; shift;;
    # Prints USAGE through the end of the banner. The line numbers are asserted
    # by test_gh_ci_status.sh so this cannot silently drift onto the wrong text.
    -h|--help) sed -n '110,140p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    -*) die "unknown flag $1";;
    *) break;;
  esac
done

[[ $# -eq 2 ]] || die "usage: gh_ci_status.sh [--quiet] <owner>/<repo> <ref>"
SLUG="$1"; REF="$2"
[[ "$SLUG" == */* ]] || die "expected owner/repo, got \"$SLUG\""
[[ "$SLUG" != *..* && "$REF" != *..* ]] || die "refusing a coordinate containing .."
[[ -n "${GH_TOKEN:-}" ]] || die "GH_TOKEN is not set; refusing to probe anonymously (an anonymous read of a private repo is a 404, which is not 'no CI')"

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq   >/dev/null 2>&1 || die "jq is required"

# The token goes in a 0600 header file, never on a command line: argv is world
# readable through /proc, which is the TOG-200 class of bug.
HDRS="$(mktemp)"; chmod 600 "$HDRS"
trap 'rm -f "$HDRS" "$BODY" 2>/dev/null' EXIT
BODY="$(mktemp)"
{
  printf 'Authorization: Bearer %s\n' "$GH_TOKEN"
  printf 'Accept: application/vnd.github+json\n'
  printf 'X-GitHub-Api-Version: 2022-11-28\n'
} > "$HDRS"

# Fetch one endpoint. Echoes the HTTP status; leaves the body in $BODY.
api() { curl -sS -o "$BODY" -w '%{http_code}' -H "@$HDRS" "$API$1" 2>/dev/null || echo 000; }

# --- source 1: check runs (GitHub Actions and any Checks-API app) -------------
# Needs `checks:read`. This is the source our own CI populates.
# Paged: the endpoint returns at most 100 rows per page, and total_count is
# the authority on how many exist. A single-page read of a 101-run head
# reports pass while a failure sits unread on page 2, so every page is read
# until the rows seen match total_count. A short read is truncation, not
# evidence, and forces `unknown` below — never `pass`.
CHECKS_STATE="unreadable"; CHECKS_N=0; CHECKS_FAIL=""; CHECKS_PENDING=""
CHECKS_NONSTART=""; NONSTART_PROBE="not-needed"
CHECKS_TOTAL=0; CHECKS_READ=0; CHECKS_TRUNCATED=0; FAILED_RUNS=""
_checks_page=1
while true; do
  code="$(api "/repos/$SLUG/commits/$REF/check-runs?per_page=100&page=$_checks_page")"
  case "$code" in
    200)
      if [[ "$_checks_page" -eq 1 ]]; then
        CHECKS_STATE="read"
        CHECKS_TOTAL="$(jq -r '.total_count // (.check_runs|length) // 0' "$BODY")"
        [[ "$CHECKS_TOTAL" =~ ^[0-9]+$ ]] || CHECKS_TOTAL=0
      fi
      _page_n="$(jq -r '.check_runs | length' "$BODY" 2>/dev/null)"
      [[ "$_page_n" =~ ^[0-9]+$ ]] || _page_n=0
      CHECKS_READ=$((CHECKS_READ + _page_n))
      _page_pending="$(jq -r '[.check_runs[]? | select(.status!="completed") | .name] | join(", ")' "$BODY" 2>/dev/null)"
      if [[ -n "$_page_pending" ]]; then
        if [[ -n "$CHECKS_PENDING" ]]; then CHECKS_PENDING="$CHECKS_PENDING, $_page_pending"; else CHECKS_PENDING="$_page_pending"; fi
      fi
      # Failures are carried as id/duration/name triples rather than just names,
      # because the id is what the annotations probe below needs.
      _page_failed="$(jq -r '
        .check_runs[]?
        | select(.status=="completed")
        | select((.conclusion // "") | IN("failure","timed_out","cancelled","action_required","startup_failure"))
        | ( if (.started_at != null and .completed_at != null)
            then ((.completed_at|fromdateiso8601) - (.started_at|fromdateiso8601))
            else 0 end ) as $d
        | "\(.id)\t\($d)\t\(.name)"' "$BODY" 2>/dev/null)"
      if [[ -n "$_page_failed" ]]; then
        if [[ -n "$FAILED_RUNS" ]]; then FAILED_RUNS="$FAILED_RUNS"$'\n'"$_page_failed"; else FAILED_RUNS="$_page_failed"; fi
      fi
      if [[ "$CHECKS_READ" -ge "$CHECKS_TOTAL" ]]; then break; fi
      if [[ "$_page_n" -eq 0 ]]; then break; fi
      _checks_page=$((_checks_page + 1))
      if [[ "$_checks_page" -gt 100 ]]; then CHECKS_TRUNCATED=1; break; fi
      ;;
    403) if [[ "$_checks_page" -eq 1 ]]; then CHECKS_STATE="denied"; else CHECKS_TRUNCATED=1; fi; break;;
    404|422) if [[ "$_checks_page" -eq 1 ]]; then CHECKS_STATE="no-such-ref"; else CHECKS_TRUNCATED=1; fi; break;;
    *) if [[ "$_checks_page" -eq 1 ]]; then CHECKS_STATE="error-$code"; else CHECKS_TRUNCATED=1; fi; break;;
  esac
done
if [[ "$CHECKS_STATE" == "read" ]]; then
  CHECKS_N="$CHECKS_READ"
  if [[ "$CHECKS_READ" -lt "$CHECKS_TOTAL" ]]; then CHECKS_TRUNCATED=1; fi
fi

# --- source 1b: is a failure actually a job that GitHub never ran? (TOG-381) --
# Only reached when source 1 saw a failure. Needs `checks:read` — the same
# permission that produced the failure we are classifying, so this never widens
# the token. Never lets a run out of the failure bucket unless the annotation
# says so IN SO MANY WORDS: a denied, erroring, empty or unrecognised
# annotations response leaves the run exactly where it was, a plain red.
if [[ "$CHECKS_STATE" == "read" && -n "${FAILED_RUNS:-}" ]]; then
  NONSTART_PROBE="clean"
  while IFS=$'\t' read -r run_id dur run_name; do
    [[ -n "$run_id" ]] || continue

    # $run_id is interpolated into a URL PATH on an authenticated call, and it
    # arrives from the response body rather than from us. Digits only: the same
    # refusal the `..` check above makes for the coordinate, applied to the one
    # other place a remote value reaches the request line. A run we cannot
    # address is a run we cannot classify, so it stays a plain failure.
    if ! is_check_run_id "$run_id"; then
      [[ "$NONSTART_PROBE" == "clean" ]] && NONSTART_PROBE="incomplete-bad-id"
      CHECKS_FAIL="${CHECKS_FAIL:+$CHECKS_FAIL, }$run_name"
      continue
    fi

    # The prefilter. A long red is a job that ran; do not spend the call.
    if [[ "$NONSTART_MAX_SECONDS" -gt 0 ]] && [[ "${dur%%.*}" -gt "$NONSTART_MAX_SECONDS" ]]; then
      CHECKS_FAIL="${CHECKS_FAIL:+$CHECKS_FAIL, }$run_name"
      continue
    fi

    acode="$(api "/repos/$SLUG/check-runs/$run_id/annotations?per_page=100")"
    if [[ "$acode" != "200" ]]; then
      # Could not classify. Safe direction: it stays a failure. Recorded so the
      # output never implies the question was asked and answered "no".
      [[ "$NONSTART_PROBE" == "clean" ]] && NONSTART_PROBE="incomplete-$acode"
      CHECKS_FAIL="${CHECKS_FAIL:+$CHECKS_FAIL, }$run_name"
      continue
    fi

    if jq -e --arg re "$NONSTART_ANNOTATION_RE" '
          [ .[]? | select(.annotation_level == "failure")
                 | select((.message // "" | ascii_downcase) | contains($re)) ] | length > 0
        ' "$BODY" >/dev/null 2>&1; then
      CHECKS_NONSTART="${CHECKS_NONSTART:+$CHECKS_NONSTART, }$run_name"
    else
      CHECKS_FAIL="${CHECKS_FAIL:+$CHECKS_FAIL, }$run_name"
    fi
  done <<< "$FAILED_RUNS"
fi

# --- source 2: combined commit status (external CI that posts statuses) -------
# Needs `statuses:read`, which is a SEPARATE permission from `checks:read` —
# granting checks does not grant this. Measured: 403 even on a token holding
# actions:read + checks:read. A repo whose CI posts commit statuses rather than
# check runs is invisible to source 1 entirely, so it is asked about separately.
STATUS_STATE="unreadable"; STATUS_STATE_VAL=""; STATUS_N=0
code="$(api "/repos/$SLUG/commits/$REF/status")"
case "$code" in
  200)
    STATUS_STATE="read"
    STATUS_N="$(jq -r '.statuses | length' "$BODY")"
    STATUS_STATE_VAL="$(jq -r '.state // ""' "$BODY")"
    ;;
  403) STATUS_STATE="denied";;
  404|422) STATUS_STATE="no-such-ref";;
  *) STATUS_STATE="error-$code";;
esac

# --- source 3: workflow runs (corroboration) ----------------------------------
# Needs `actions:read`. Not redundant with source 1: a workflow that fails
# BEFORE it can create check runs — an invalid ci.yml, a startup failure — shows
# up here and nowhere else. Without it, "0 check runs" cannot be distinguished
# from "the workflow file is broken", and the broken case is the one that
# matters.
RUNS_STATE="unreadable"; RUNS_N=0; RUNS_FAIL=""; RUNS_PENDING=""
RUNS_TOTAL=0; RUNS_READ=0; RUNS_TRUNCATED=0
_runs_page=1
while true; do
  code="$(api "/repos/$SLUG/actions/runs?head_sha=$REF&per_page=100&page=$_runs_page")"
  case "$code" in
    200)
      if [[ "$_runs_page" -eq 1 ]]; then
        RUNS_STATE="read"
        RUNS_TOTAL="$(jq -r '.total_count // (.workflow_runs|length) // 0' "$BODY")"
        [[ "$RUNS_TOTAL" =~ ^[0-9]+$ ]] || RUNS_TOTAL=0
      fi
      _rpage_n="$(jq -r '.workflow_runs | length' "$BODY" 2>/dev/null)"
      [[ "$_rpage_n" =~ ^[0-9]+$ ]] || _rpage_n=0
      RUNS_READ=$((RUNS_READ + _rpage_n))
      _rpage_fail="$(jq -r '[.workflow_runs[]? | select(.status=="completed") | select((.conclusion // "") | IN("failure","timed_out","cancelled","action_required","startup_failure")) | .name] | join(", ")' "$BODY" 2>/dev/null)"
      if [[ -n "$_rpage_fail" ]]; then
        if [[ -n "$RUNS_FAIL" ]]; then RUNS_FAIL="$RUNS_FAIL, $_rpage_fail"; else RUNS_FAIL="$_rpage_fail"; fi
      fi
      _rpage_pending="$(jq -r '[.workflow_runs[]? | select(.status!="completed") | .name] | join(", ")' "$BODY" 2>/dev/null)"
      if [[ -n "$_rpage_pending" ]]; then
        if [[ -n "$RUNS_PENDING" ]]; then RUNS_PENDING="$RUNS_PENDING, $_rpage_pending"; else RUNS_PENDING="$_rpage_pending"; fi
      fi
      if [[ "$RUNS_READ" -ge "$RUNS_TOTAL" ]]; then break; fi
      if [[ "$_rpage_n" -eq 0 ]]; then break; fi
      _runs_page=$((_runs_page + 1))
      if [[ "$_runs_page" -gt 100 ]]; then RUNS_TRUNCATED=1; break; fi
      ;;
    403) if [[ "$_runs_page" -eq 1 ]]; then RUNS_STATE="denied"; else RUNS_TRUNCATED=1; fi; break;;
    404|422) if [[ "$_runs_page" -eq 1 ]]; then RUNS_STATE="no-such-ref"; else RUNS_TRUNCATED=1; fi; break;;
    *) if [[ "$_runs_page" -eq 1 ]]; then RUNS_STATE="error-$code"; else RUNS_TRUNCATED=1; fi; break;;
  esac
done
if [[ "$RUNS_STATE" == "read" ]]; then
  RUNS_N="$RUNS_READ"
  if [[ "$RUNS_READ" -lt "$RUNS_TOTAL" ]]; then RUNS_TRUNCATED=1; fi
fi

# --- verdict ------------------------------------------------------------------
# Order matters, and the ordering IS the fail-closed property:
#
#   fail        beats everything. One observed failure is decisive.
#   truncated beats everything except an observed fail. A short read (rows
#           seen < total_count) with no observed failure is `unknown`: the
#           unread pages may hold a red, so neither `pass`, `pending`, nor
#           `non-started` may be claimed.
#   non-started beats fail ONLY when nothing else failed. A genuine red
#           alongside a non-start is still a genuine red — there is code to fix
#           — so `fail` wins and the non-starts are named in the JSON instead.
#           It beats pending, though: "the CI system is not running jobs"
#           supersedes "one job has not finished", because that job will not.
#   pending beats pass. Do not merge a half-finished run.
#   unknown beats pass. This is the line the naive gate crosses: it is only
#           legitimate to say "pass" if a signal was actually SEEN. Zero
#           signals from a readable source is `no-signal`, not success.
#
# A source that is denied contributes nothing at all — in particular it never
# contributes evidence of success.
READABLE=0
for s in "$CHECKS_STATE" "$STATUS_STATE" "$RUNS_STATE"; do
  [[ "$s" == "read" ]] && READABLE=$((READABLE+1))
done

SIGNALS=$((CHECKS_N + STATUS_N + RUNS_N))
FAILED="$(printf '%s' "${CHECKS_FAIL}${CHECKS_FAIL:+, }${RUNS_FAIL}" | sed 's/, $//')"
PENDING="$(printf '%s' "${CHECKS_PENDING}${CHECKS_PENDING:+, }${RUNS_PENDING}" | sed 's/, $//')"

# The combined commit status has its own vocabulary and is authoritative for
# source 2 when it has any statuses at all.
case "$STATUS_STATE_VAL" in
  failure|error) [[ "$STATUS_N" -gt 0 ]] && FAILED="${FAILED:+$FAILED, }commit-status:$STATUS_STATE_VAL";;
  pending)       [[ "$STATUS_N" -gt 0 ]] && PENDING="${PENDING:+$PENDING, }commit-status:pending";;
esac

# Source 3's failures are NOT independent evidence against a non-start: a
# workflow run is the same jobs seen from a different endpoint, so during an
# account-level block it reds for exactly the reason the check runs did.
# Counting it as a genuine failure would make this whole classification dead on
# any installation that happens to hold actions:read. Source 2 is different —
# external CI posting commit statuses is a separate system, unaffected by a
# GitHub Actions block, so a red there really is a red.
EXT_FAILED=""
case "$STATUS_STATE_VAL" in
  failure|error) [[ "$STATUS_N" -gt 0 ]] && EXT_FAILED="commit-status:$STATUS_STATE_VAL";;
esac

TRUNCATED=0
[[ "${CHECKS_TRUNCATED:-0}" -eq 1 || "${RUNS_TRUNCATED:-0}" -eq 1 ]] && TRUNCATED=1
TRUNC_DETAIL=""
if [[ "$CHECKS_TRUNCATED" -eq 1 ]]; then TRUNC_DETAIL="check runs ${CHECKS_READ:-0} of ${CHECKS_TOTAL:-0}"; fi
if [[ "$RUNS_TRUNCATED" -eq 1 ]]; then
  [[ -n "$TRUNC_DETAIL" ]] && TRUNC_DETAIL="$TRUNC_DETAIL; "
  TRUNC_DETAIL="${TRUNC_DETAIL}workflow runs ${RUNS_READ:-0} of ${RUNS_TOTAL:-0}"
fi

if [[ "$CHECKS_STATE" == "no-such-ref" && "$STATUS_STATE" == "no-such-ref" ]]; then
  VERDICT="unknown"; REASON="no-such-ref"; EXIT=3
elif [[ "$TRUNCATED" -eq 1 && -z "$FAILED" && -z "$EXT_FAILED" && -z "$CHECKS_FAIL" ]]; then
  # A short read is truncation, not evidence: a failure may sit on an unread
  # page. Fail still wins above (an observed red is decisive), but a short
  # read with no observed failure is `unknown` — never `pass`, never
  # `non-started`, never `pending` — because each of those claims the unread
  # rows contain nothing worse than what was seen.
  VERDICT="unknown"; REASON="truncated: only $TRUNC_DETAIL read; a failure may sit on an unread page. This is NOT a pass."; EXIT=3
elif [[ -n "$CHECKS_NONSTART" && -z "$CHECKS_FAIL" && -z "$EXT_FAILED" ]]; then
  VERDICT="non-started"
  REASON="not started: $CHECKS_NONSTART — GitHub reported these jobs as completed/failure but they never ran (account-level block: failed payment or spending limit). This is NOT a red build: there is nothing in the diff to fix, and every CI-enforced gate on this repo is currently unenforced."
  EXIT=5
elif [[ -n "$FAILED" ]]; then
  VERDICT="fail"; REASON="failed: $FAILED"; EXIT=1
  # A real red and a non-start at once. The red wins the exit code, but say the
  # other part out loud: the suite that is red is also only partly running.
  [[ -n "$CHECKS_NONSTART" ]] && REASON="$REASON (and these never started at all: $CHECKS_NONSTART)"
elif [[ -n "$PENDING" ]]; then
  VERDICT="pending"; REASON="not concluded: $PENDING"; EXIT=2
elif [[ "$READABLE" -eq 0 ]]; then
  VERDICT="unknown"; REASON="denied: this token cannot read any CI source (needs checks:read for check runs, actions:read for workflow runs, statuses:read for commit statuses)"; EXIT=3
elif [[ "$SIGNALS" -eq 0 ]]; then
  VERDICT="unknown"; REASON="no-signal: every readable source reported zero results. CI may not be configured for this ref, or it may not have started yet. This is NOT a pass."; EXIT=3
else
  VERDICT="pass"; REASON="$SIGNALS signal(s) observed, all succeeded"; EXIT=0
fi

jq -n \
  --arg repo "$SLUG" --arg ref "$REF" \
  --arg verdict "$VERDICT" --arg reason "$REASON" \
  --arg checks "$CHECKS_STATE" --arg statuses "$STATUS_STATE" --arg runs "$RUNS_STATE" \
  --arg nonstart "$CHECKS_NONSTART" --arg probe "$NONSTART_PROBE" \
  --argjson signals "$SIGNALS" --argjson exit "$EXIT" \
  --argjson checksTotal "${CHECKS_TOTAL:-0}" --argjson checksRead "${CHECKS_READ:-0}" \
  --argjson checksTruncated "${CHECKS_TRUNCATED:-0}" \
  --argjson runsTotal "${RUNS_TOTAL:-0}" --argjson runsRead "${RUNS_READ:-0}" \
  --argjson runsTruncated "${RUNS_TRUNCATED:-0}" --argjson truncated "$TRUNCATED" \
  '{repo:$repo, ref:$ref, verdict:$verdict, reason:$reason,
    sources:{checkRuns:$checks, commitStatuses:$statuses, workflowRuns:$runs},
    nonStarted: ($nonstart | if . == "" then [] else split(", ") end),
    nonStartedProbe: $probe,
    signalsObserved:$signals, exitCode:$exit,
    checkRunsTotal:$checksTotal, checkRunsRead:$checksRead, checkRunsTruncated:($checksTruncated==1),
    workflowRunsTotal:$runsTotal, workflowRunsRead:$runsRead, workflowRunsTruncated:($runsTruncated==1),
    truncated:($truncated==1)}'

if [[ "$QUIET" -eq 0 ]]; then
  case "$VERDICT" in
    pass)    printf '\033[32mCI pass\033[0m     %s @ %s — %s\n' "$SLUG" "$REF" "$REASON" >&2;;
    fail)    printf '\033[31mCI FAIL\033[0m     %s @ %s — %s\n' "$SLUG" "$REF" "$REASON" >&2;;
    non-started)
             printf '\033[35mCI NOT RUN\033[0m %s @ %s — %s\n\n  Do not read this as a red build and do not go looking for the commit that broke it.\n  GitHub never ran these jobs, so this repo has no CI right now and no gate here is\n  being enforced. The fix is account-level (Billing & plans), not a code change.\n' "$SLUG" "$REF" "$REASON" >&2;;
    pending) printf '\033[33mCI pending\033[0m  %s @ %s — %s\n' "$SLUG" "$REF" "$REASON" >&2;;
    unknown) printf '\033[33mCI UNKNOWN\033[0m  %s @ %s — %s\n\n  This is not a pass. Have a human check the PR before merging.\n' "$SLUG" "$REF" "$REASON" >&2;;
  esac
fi

exit "$EXIT"
