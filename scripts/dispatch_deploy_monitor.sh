#!/usr/bin/env bash
# ===========================================================================
# dispatch_deploy_monitor.sh — one complete cycle of the TOG-2307 dispatch-src
# drift monitor.
# ---------------------------------------------------------------------------
# dispatch_deploy.sh's `status` subcommand is a correct drift detector and
# CI proves it is not vacuous (test_dispatch_deploy.sh, verification/
# tog-2307-dispatch-deploy-mutation-gate.sh). But CI only ever exercises it
# against fixture repos under mktemp; nothing runs it against the real
# /paperclip/plugin-packages-root/dispatch-src checkout on any clock. TOG-2295
# (119 commits stale, found only by an operator going looking) is exactly the
# failure mode this closes: without this wrapper, "is the live checkout
# drifted or the pin gone" depends on the same archaeology that let it drift
# 119 commits in the first place.
#
# This wrapper does the other half of the loop in one command:
#
#   1. run `dispatch_deploy.sh status` against the real live checkout;
#   2. post the measured verdict to the dedicated monitor issue;
#   3. re-arm that issue's native monitor for the next cycle.
#
# Run this from the monitor issue's heartbeat:
#
#   ./dispatch_deploy_monitor.sh
#
# INTERVAL. Deploys here are rare and deliberate (an explicit --commit, never
# automatic), so the normal interval is 24 hours -- drift or a stray checkout
# is caught within a day rather than depending on someone noticing. Detected
# drift or a refusal (record absent/corrupt/pin-gone) re-checks in 2 hours,
# because both are live incidents whose clearing should be noticed promptly.
#
# INCONCLUSIVE IS NOT HEALTHY. status exit 2 means it refused to trust the
# record (absent, corrupt, or the pin itself is gone) -- this wrapper never
# converts that into a clean cycle.
#
# This script writes only to the dedicated monitor issue: one comment plus its
# next monitor timestamp. The existing execution policy is preserved; only
# `.monitor` is replaced. The Paperclip bearer travels in a 0600 curl config,
# never argv.
#
# Exit status is status's own exit code after the monitor has been re-armed:
#   0 no drift
#   1 drift detected (stray checkout or moved anchor ref)
#   2 refused (absent/corrupt record, pin gone) or monitor/Paperclip failure.
#     A failed re-arm is always exit 2.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH_DEPLOY="${DISPATCH_DEPLOY_SH:-$HERE/dispatch_deploy.sh}"
ISSUE_ID="${PAPERCLIP_TASK_ID:-}"
INTERVAL_HOURS=24
DRIFT_RETRY_HOURS=2
ERROR_RETRY_HOURS=2

usage() {
  cat >&2 <<'EOF'
usage: dispatch_deploy_monitor.sh [--issue ISSUE_ID]
                                   [--interval-hours N]
                                   [--drift-retry-hours N]
                                   [--error-retry-hours N]

Runs ./dispatch_deploy.sh status, comments the result on the monitor issue,
and re-arms its native Paperclip monitor. Defaults to $PAPERCLIP_TASK_ID.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) shift; [[ $# -gt 0 ]] || { echo "ERROR: --issue needs a value" >&2; exit 2; }; ISSUE_ID="$1" ;;
    --interval-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --interval-hours needs a value" >&2; exit 2; }; INTERVAL_HOURS="$1" ;;
    --drift-retry-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --drift-retry-hours needs a value" >&2; exit 2; }; DRIFT_RETRY_HOURS="$1" ;;
    --error-retry-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --error-retry-hours needs a value" >&2; exit 2; }; ERROR_RETRY_HOURS="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

[[ -n "$ISSUE_ID" ]] || { echo "ERROR: set PAPERCLIP_TASK_ID or pass --issue" >&2; exit 2; }
[[ "$ISSUE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] \
  || { echo "ERROR: issue id contains characters that could change the API route" >&2; exit 2; }
for n in "$INTERVAL_HOURS" "$DRIFT_RETRY_HOURS" "$ERROR_RETRY_HOURS"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: intervals must be positive whole hours" >&2; exit 2; }
done
for tool in curl jq date; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done
[[ -x "$DISPATCH_DEPLOY" ]] || { echo "ERROR: dispatch_deploy.sh not found or not executable: $DISPATCH_DEPLOY" >&2; exit 2; }
: "${PAPERCLIP_API_URL:?missing PAPERCLIP_API_URL}"
: "${PAPERCLIP_API_KEY:?missing PAPERCLIP_API_KEY}"

BASE="${PAPERCLIP_API_URL%/}"; BASE="${BASE%/api}"
WORK="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/dispatch_deploy_monitor.XXXXXXXX")" \
  || { echo "ERROR: could not create private work directory" >&2; exit 2; }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# request <METHOD> <URL> <response-file> [body-file]
# Prints only the HTTP status. The bearer and body contents stay out of argv.
request() {
  local method="$1" url="$2" response="$3" body="${4:-}" cfg status
  cfg="$(umask 077; mktemp "$WORK/curlcfg.XXXXXXXX")" || return 1
  chmod 0600 "$cfg"
  {
    printf 'url = "%s"\n' "$url"
    printf 'request = "%s"\n' "$method"
    printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY"
    printf 'header = "Content-Type: application/json"\n'
    [[ -z "${PAPERCLIP_RUN_ID:-}" ]] \
      || printf 'header = "X-Paperclip-Run-Id: %s"\n' "$PAPERCLIP_RUN_ID"
    printf 'output = "%s"\n' "$response"
    printf 'write-out = "%%{http_code}"\n'
    printf 'silent\nshow-error\n'
    [[ -z "$body" ]] || printf 'data-binary = "@%s"\n' "$body"
  } > "$cfg"
  status="$(curl --config "$cfg")" || { rm -f "$cfg"; return 1; }
  rm -f "$cfg"
  printf '%s' "$status"
}

STATUS_OUT="$WORK/status.txt"
"$DISPATCH_DEPLOY" status > "$STATUS_OUT" 2>&1
STATUS_RC=$?

case "$STATUS_RC" in
  0) NEXT_HOURS="$INTERVAL_HOURS" ;;
  1) NEXT_HOURS="$DRIFT_RETRY_HOURS" ;;
  *) STATUS_RC=2; NEXT_HOURS="$ERROR_RETRY_HOURS" ;;
esac

# Test seam: a fixed instant makes both the schedule and its assertion stable.
NOW="${DISPATCH_DEPLOY_MONITOR_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
NOW_EPOCH="$(date -u -d "$NOW" +%s 2>/dev/null)" \
  || { echo "ERROR: could not parse monitor clock '$NOW'" >&2; exit 2; }
NEXT_EPOCH=$((NOW_EPOCH + NEXT_HOURS * 3600))
NEXT_CHECK="$(date -u -d "@$NEXT_EPOCH" +%Y-%m-%dT%H:%M:%SZ)" \
  || { echo "ERROR: could not compute next monitor time" >&2; exit 2; }

COMMENT="$WORK/comment.md"
{
  echo "## dispatch-src pinned deploy: drift monitor"
  echo
  case "$STATUS_RC" in
    0) echo "**No drift: live HEAD, the deployment record, and both anchor refs agree.**" ;;
    1) echo "**DRIFT DETECTED — live HEAD or an anchor ref no longer matches the deployment record.**" ;;
    2) echo "**REFUSED — the deployment record is absent, corrupt, or a recorded SHA is no longer a reachable commit (pin gone).**" ;;
  esac
  echo
  echo "| Field | Value |"
  echo "|---|---|"
  echo "| status exit code | \`$STATUS_RC\` |"
  echo "| Next check | **$NEXT_CHECK** |"
  echo
  echo '```'
  cat "$STATUS_OUT"
  echo '```'
  if [[ "$STATUS_RC" -eq 1 ]]; then
    echo
    echo "> A stray checkout (live HEAD moved outside dispatch_deploy.sh) is recoverable: the pinned commit is still reachable. Compare against \`docs/runbooks/dispatch-src-pinned-deploy.md\` and either restore HEAD to the recorded \`deployedSha\` or run a deliberate \`deploy\`/\`rollback\` to record the new state."
  fi
  if [[ "$STATUS_RC" -eq 2 ]]; then
    echo
    echo "> This is the unrecoverable case: the record cannot be trusted, or a pinned SHA is no longer a reachable commit object (e.g. gc reclaimed it because it was never anchored). Do not run further deploys until this is resolved by hand; see \`docs/runbooks/dispatch-src-pinned-deploy.md\`."
  fi
} > "$COMMENT"

ISSUE_JSON="$WORK/issue.json"
GET_STATUS="$(request GET "$BASE/api/issues/$ISSUE_ID" "$ISSUE_JSON")" \
  || { echo "ERROR: could not read monitor issue" >&2; exit 2; }
case "$GET_STATUS" in
  2*) ;;
  *) echo "ERROR: monitor issue read returned HTTP $GET_STATUS" >&2; exit 2 ;;
esac
jq -e 'type == "object" and (.id | type == "string")' "$ISSUE_JSON" >/dev/null 2>&1 \
  || { echo "ERROR: monitor issue response was not an issue" >&2; exit 2; }

PATCH_BODY="$WORK/patch.json"
jq -n \
  --slurpfile issue "$ISSUE_JSON" \
  --rawfile comment "$COMMENT" \
  --arg next "$NEXT_CHECK" '
  ($issue[0].executionPolicy // {}) as $policy
  | {
      comment: $comment,
      executionPolicy: ($policy + {
        monitor: {
          nextCheckAt: $next,
          notes: "Do NOT run ./dispatch_deploy_monitor.sh from the shared workspace against a stale checkout of this repo; use the pinned scripts/dispatch_deploy_monitor.sh and scripts/dispatch_deploy.sh from this issue'\''s own run. Normal 24h, drift/refused retry 2h. Runbook: docs/runbooks/dispatch-src-pinned-deploy.md.",
          scheduledBy: "assignee",
          kind: "external_service",
          serviceName: "dispatch-src pinned checkout",
          recoveryPolicy: "wake_owner"
        }
      })
    }
  ' > "$PATCH_BODY" \
  || { echo "ERROR: could not build monitor update" >&2; exit 2; }

PATCH_RESPONSE="$WORK/patch-response.json"
PATCH_STATUS="$(request PATCH "$BASE/api/issues/$ISSUE_ID" "$PATCH_RESPONSE" "$PATCH_BODY")" \
  || { echo "ERROR: could not update monitor issue" >&2; exit 2; }
case "$PATCH_STATUS" in
  2*) ;;
  *)
    echo "ERROR: monitor update returned HTTP $PATCH_STATUS" >&2
    jq -c '{error,details}' "$PATCH_RESPONSE" 2>/dev/null >&2 || true
    exit 2
    ;;
esac

# Verify the artifact returned by the write, not merely the request we intended.
#
# Read ONLY the top-level `monitorNextCheckAt` column. That column is what the
# scheduler queries; `executionPolicy.monitor` is the write-side shape and is
# echoed back verbatim whether or not the column was actually set. Falling
# back to the nested path would accept our own request as evidence of the
# write it was supposed to verify -- an unarmed issue would score armed.
STORED_NEXT="$(jq -r '.monitorNextCheckAt // empty' "$PATCH_RESPONSE" 2>/dev/null)"
if [[ -z "$STORED_NEXT" ]]; then
  echo "ERROR: Paperclip returned HTTP $PATCH_STATUS but stored no monitorNextCheckAt column" >&2
  exit 2
fi

# Compare the INSTANT, not the string. The server normalises to millisecond
# precision, so a request for `2026-09-05T20:00:00Z` reads back as
# `2026-09-05T20:00:00.000Z`. Those are the same moment; a string compare
# calls a correct arming a failure and reports exit 2 over the real verdict
# on every single cycle.
STORED_EPOCH="$(date -u -d "$STORED_NEXT" +%s 2>/dev/null)" \
  || { echo "ERROR: Paperclip stored an unparseable monitorNextCheckAt: $STORED_NEXT" >&2; exit 2; }
if [[ "$STORED_EPOCH" != "$NEXT_EPOCH" ]]; then
  echo "ERROR: Paperclip returned HTTP $PATCH_STATUS but stored nextCheckAt=$STORED_NEXT, not $NEXT_CHECK" >&2
  exit 2
fi

echo "dispatch-src drift monitor: result=$STATUS_RC next=$NEXT_CHECK issue=$ISSUE_ID"
exit "$STATUS_RC"
