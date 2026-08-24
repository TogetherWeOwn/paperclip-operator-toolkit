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
# two distinct ways, and both of them read as green:
#
#   1. DENIED.   A broker token without `checks:read` gets 403. A gate that
#      only inspects `.check_runs[]` sees an empty array in the parse and
#      concludes "no CI configured, nothing to wait for".
#   2. VACUOUS.  Even WITH `checks:read`, a ref that has no check runs yet
#      returns 200 with `total_count: 0`. That happens for a commit pushed
#      seconds ago — the runs have not been created — and for a commit that
#      genuinely predates CI. "All zero runs succeeded" is trivially true.
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
#
# Note that 3 is not 0. If you find yourself writing `|| true` around this, the
# thing you actually want is for a human to look.
#
# ENVIRONMENT
#   GH_TOKEN     required. Any token: a broker mint, an App installation token,
#                a PAT. Never placed in argv — passed to curl via a header file.
#   GH_API_URL   optional, defaults to https://api.github.com. This is the test
#                seam, same convention as gh-app-token.js.
# ===========================================================================

API="${GH_API_URL:-https://api.github.com}"
QUIET=0

die() { echo "gh_ci_status: $*" >&2; exit 4; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet|-q) QUIET=1; shift;;
    -h|--help) sed -n '4,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
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
CHECKS_STATE="unreadable"; CHECKS_N=0; CHECKS_FAIL=""; CHECKS_PENDING=""
code="$(api "/repos/$SLUG/commits/$REF/check-runs?per_page=100")"
case "$code" in
  200)
    CHECKS_STATE="read"
    CHECKS_N="$(jq -r '.total_count // (.check_runs|length) // 0' "$BODY")"
    CHECKS_FAIL="$(jq -r '[.check_runs[]? | select(.status=="completed") | select((.conclusion // "") | IN("failure","timed_out","cancelled","action_required","startup_failure")) | .name] | join(", ")' "$BODY")"
    CHECKS_PENDING="$(jq -r '[.check_runs[]? | select(.status!="completed") | .name] | join(", ")' "$BODY")"
    ;;
  403) CHECKS_STATE="denied";;
  404|422) CHECKS_STATE="no-such-ref";;
  *) CHECKS_STATE="error-$code";;
esac

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
code="$(api "/repos/$SLUG/actions/runs?head_sha=$REF&per_page=100")"
case "$code" in
  200)
    RUNS_STATE="read"
    RUNS_N="$(jq -r '.total_count // 0' "$BODY")"
    RUNS_FAIL="$(jq -r '[.workflow_runs[]? | select(.status=="completed") | select((.conclusion // "") | IN("failure","timed_out","cancelled","action_required","startup_failure")) | .name] | join(", ")' "$BODY")"
    RUNS_PENDING="$(jq -r '[.workflow_runs[]? | select(.status!="completed") | .name] | join(", ")' "$BODY")"
    ;;
  403) RUNS_STATE="denied";;
  404|422) RUNS_STATE="no-such-ref";;
  *) RUNS_STATE="error-$code";;
esac

# --- verdict ------------------------------------------------------------------
# Order matters, and the ordering IS the fail-closed property:
#
#   fail    beats everything. One observed failure is decisive.
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

if [[ "$CHECKS_STATE" == "no-such-ref" && "$STATUS_STATE" == "no-such-ref" ]]; then
  VERDICT="unknown"; REASON="no-such-ref"; EXIT=3
elif [[ -n "$FAILED" ]]; then
  VERDICT="fail"; REASON="failed: $FAILED"; EXIT=1
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
  --argjson signals "$SIGNALS" --argjson exit "$EXIT" \
  '{repo:$repo, ref:$ref, verdict:$verdict, reason:$reason,
    sources:{checkRuns:$checks, commitStatuses:$statuses, workflowRuns:$runs},
    signalsObserved:$signals, exitCode:$exit}'

if [[ "$QUIET" -eq 0 ]]; then
  case "$VERDICT" in
    pass)    printf '\033[32mCI pass\033[0m     %s @ %s — %s\n' "$SLUG" "$REF" "$REASON" >&2;;
    fail)    printf '\033[31mCI FAIL\033[0m     %s @ %s — %s\n' "$SLUG" "$REF" "$REASON" >&2;;
    pending) printf '\033[33mCI pending\033[0m  %s @ %s — %s\n' "$SLUG" "$REF" "$REASON" >&2;;
    unknown) printf '\033[33mCI UNKNOWN\033[0m  %s @ %s — %s\n\n  This is not a pass. Have a human check the PR before merging.\n' "$SLUG" "$REF" "$REASON" >&2;;
  esac
fi

exit "$EXIT"
