#!/usr/bin/env bash
# ===========================================================================
# gh_scope_residue_monitor.sh — one complete cycle of the TOG-398 monitor.
# ---------------------------------------------------------------------------
# gh_scope_residue.sh is a standing detector, but a detector nobody schedules
# is still discovered by the agent whose checkout is already broken. Paperclip
# issue monitors provide the clock this repo can actually reach: they wake the
# assignee once, then clear themselves before the run starts. This wrapper does
# the other half of the loop in one command:
#
#   1. run the credential-free board detector;
#   2. post the measured floor to the dedicated monitor issue;
#   3. re-arm that issue's native monitor for the next cycle.
#
# Run this from the monitor issue's heartbeat:
#
#   ./gh_scope_residue_monitor.sh
#
# The normal interval is six hours. A detector/API failure retries in one hour.
# Those numbers live here rather than in issue prose so every run makes the same
# decision. Override them only for a deliberate one-off with --interval-hours /
# --error-retry-hours.
#
# IMPORTANT: --board is text-only. A zero is INCONCLUSIVE, never proof that no
# project-less issue needs git. An issue that names no repo and has not pushed a
# branch is invisible. Every comment this script emits repeats that limitation.
#
# This script does not attach issues, mint a GitHub token, or list branches. It
# writes only to the dedicated monitor issue: one comment plus its next monitor
# timestamp. The existing execution policy is preserved; only `.monitor` is
# replaced. The Paperclip bearer travels in a 0600 curl config, never argv.
#
# Exit status is the detector's status after the monitor has been re-armed:
#   1 known residue found · 3 no text-visible residue (inconclusive)
#   2 detector or Paperclip failure. A failed re-arm is always exit 2.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECTOR="${GH_SCOPE_RESIDUE_SH:-$HERE/gh_scope_residue.sh}"
ISSUE_ID="${PAPERCLIP_TASK_ID:-}"
INTERVAL_HOURS=6
ERROR_RETRY_HOURS=1

usage() {
  cat >&2 <<'EOF'
usage: gh_scope_residue_monitor.sh [--issue ISSUE_ID]
                                   [--interval-hours N]
                                   [--error-retry-hours N]

Runs gh_scope_residue.sh --board --json, comments the result on the monitor
issue, and re-arms its native Paperclip monitor. Defaults to $PAPERCLIP_TASK_ID.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) shift; [[ $# -gt 0 ]] || { echo "ERROR: --issue needs a value" >&2; exit 2; }; ISSUE_ID="$1" ;;
    --interval-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --interval-hours needs a value" >&2; exit 2; }; INTERVAL_HOURS="$1" ;;
    --error-retry-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --error-retry-hours needs a value" >&2; exit 2; }; ERROR_RETRY_HOURS="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

[[ -n "$ISSUE_ID" ]] || { echo "ERROR: set PAPERCLIP_TASK_ID or pass --issue" >&2; exit 2; }
[[ "$ISSUE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] \
  || { echo "ERROR: issue id contains characters that could change the API route" >&2; exit 2; }
for n in "$INTERVAL_HOURS" "$ERROR_RETRY_HOURS"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: intervals must be positive whole hours" >&2; exit 2; }
done
for tool in curl jq date; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done
[[ -x "$DETECTOR" ]] || { echo "ERROR: detector is not executable: $DETECTOR" >&2; exit 2; }
: "${PAPERCLIP_API_URL:?missing PAPERCLIP_API_URL}"
: "${PAPERCLIP_API_KEY:?missing PAPERCLIP_API_KEY}"

BASE="${PAPERCLIP_API_URL%/}"; BASE="${BASE%/api}"
WORK="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/gh_scope_residue_monitor.XXXXXXXX")" \
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

RESULT="$WORK/residue.json"
DETECTOR_ERR="$WORK/detector.err"
"$DETECTOR" --board --json > "$RESULT" 2> "$DETECTOR_ERR"
DETECTOR_RC=$?

MEASURED=yes
case "$DETECTOR_RC" in
  0|1|3) ;;
  *) MEASURED=no ;;
esac
if [[ "$MEASURED" == yes ]] && ! jq -e '
    type == "object"
    and (.count | type == "number")
    and (.residue | type == "array")
    and (.coverage | type == "string")
  ' "$RESULT" >/dev/null 2>&1; then
  MEASURED=no
  DETECTOR_RC=2
fi

if [[ "$MEASURED" == yes ]]; then
  NEXT_HOURS="$INTERVAL_HOURS"
else
  NEXT_HOURS="$ERROR_RETRY_HOURS"
fi

# Test seam: a fixed instant makes both the schedule and its assertion stable.
NOW="${SCOPE_RESIDUE_MONITOR_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
NOW_EPOCH="$(date -u -d "$NOW" +%s 2>/dev/null)" \
  || { echo "ERROR: could not parse monitor clock '$NOW'" >&2; exit 2; }
NEXT_EPOCH=$((NOW_EPOCH + NEXT_HOURS * 3600))
NEXT_CHECK="$(date -u -d "@$NEXT_EPOCH" +%Y-%m-%dT%H:%M:%SZ)" \
  || { echo "ERROR: could not compute next monitor time" >&2; exit 2; }

COMMENT="$WORK/comment.md"
if [[ "$MEASURED" == yes ]]; then
  COUNT="$(jq -r '.count' "$RESULT")"
  COVERAGE="$(jq -r '.coverage' "$RESULT")"
  {
    echo "## Scope-residue monitor"
    echo
    if [[ "$COUNT" -gt 0 ]]; then
      echo "**Finding: $COUNT open project-less issue(s) are known to need a repository in this installation.**"
      echo
      echo '| Issue | Status | Repository | Attach to | Evidence |'
      echo '|---|---|---|---|---|'
      jq -r '.residue[] | "| TOG-\(.issue) | \(.status) | `\(.repo)` | \(.project) | `\(.via)` |"' "$RESULT"
    else
      echo "**Inconclusive: no text-visible residue was found. This is not a clean-board proof.**"
    fi
    echo
    echo "- Detector: \`./gh_scope_residue.sh --board --json\` (exit $DETECTOR_RC)"
    echo "- Coverage: **$COVERAGE** — board text only; no GitHub token was minted or used"
    echo "- Next check: **$NEXT_CHECK**"
    echo
    echo "> This result is a floor, not proof. An issue that names no repo and has not pushed a branch is invisible to this scheduled check."
  } > "$COMMENT"
else
  {
    echo "## Scope-residue monitor"
    echo
    echo "**UNKNOWN: the detector did not produce a valid measurement.**"
    echo
    echo "- Detector exit: $DETECTOR_RC"
    echo "- Retry scheduled: **$NEXT_CHECK** (the shorter ${ERROR_RETRY_HOURS}h error interval)"
    echo
    echo "> Nothing was scored clean. Inspect this run's detector stderr; the monitor was re-armed before this command exited."
  } > "$COMMENT"
fi

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
  --arg next "$NEXT_CHECK" \
  --arg interval "$INTERVAL_HOURS" '
  ($issue[0].executionPolicy // {}) as $policy
  | {
      comment: $comment,
      executionPolicy: ($policy + {
        monitor: {
          nextCheckAt: $next,
          notes: ("Run ./gh_scope_residue_monitor.sh; normal interval " + $interval + "h. A zero is a floor, never proof."),
          scheduledBy: "assignee",
          kind: "external_service",
          serviceName: "Paperclip project-less GitHub scope residue",
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
STORED_NEXT="$(jq -r '.monitorNextCheckAt // .executionPolicy.monitor.nextCheckAt // empty' "$PATCH_RESPONSE" 2>/dev/null)"
if [[ "$STORED_NEXT" != "$NEXT_CHECK" ]]; then
  echo "ERROR: Paperclip returned HTTP $PATCH_STATUS but did not store nextCheckAt=$NEXT_CHECK" >&2
  exit 2
fi

echo "scope-residue monitor: result=$DETECTOR_RC next=$NEXT_CHECK issue=$ISSUE_ID"
exit "$DETECTOR_RC"
