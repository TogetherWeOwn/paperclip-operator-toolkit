#!/usr/bin/env bash
# ===========================================================================
# discord_job_health_monitor.sh — one complete cycle of the TOG-676 monitor.
# ---------------------------------------------------------------------------
# scripts/discord_job_health.js is a standing detector, and CI already proves it
# is not vacuous. But CI runs it only against the fixture seam: the workflow has
# no database, so every CI execution measures a recorded fixture and never this
# installation. Nothing runs the detector against production on any clock.
#
# That matters here more than usual, because the defect it watches is silent by
# construction. `discord-daily-digest` is time-gated: 23 of every 24 runs return
# at the hour gate and record `succeeded` having posted nothing. A human glancing
# at job status sees green. The detector is the only thing that reads the
# delivery metric instead, and a detector nobody schedules is discovered by
# whoever eventually notices the digest was never in Discord.
#
# This wrapper does the other half of the loop in one command:
#
#   1. run the detector against this installation;
#   2. post the measured verdict when its state changes;
#   3. re-arm that issue's native monitor for the next cycle.
#
# Run this from the monitor issue's heartbeat:
#
#   ./discord_job_health_monitor.sh
#
# The normal interval is six hours. A detector/API failure retries in one hour.
# Those numbers live here rather than in issue prose so every run makes the same
# decision. Override them only for a deliberate one-off with --interval-hours /
# --error-retry-hours.
#
# IMPORTANT: this monitor never converts a failing detector into a resolved
# card. TOG-676 is a vendor defect with no host-side or config-side fix that
# does not leak other companies' data, so the expected steady state is exit 1
# every cycle until a vendor release lands. The comment says so explicitly, so
# a long run of failures reads as "still waiting on the vendor" rather than as
# an unattended alarm — and so that silencing it requires deleting the monitor
# rather than letting it quietly go green.
#
# This script writes only to the dedicated monitor issue. It always advances the
# next monitor timestamp, but comments only when the measured state changes so a
# standing clock cannot grow its own wake payload until Linux rejects it with
# E2BIG. The existing execution policy is preserved; only `.monitor` is replaced.
# The Paperclip bearer travels in a 0600 curl config, never argv.
#
# Exit status is the detector's status after the monitor has been re-armed:
#   0 every job healthy and every gated job proved a delivery
#   1 at least one job is FAILING or NOT_DELIVERED
#   2 detector or Paperclip failure. A failed re-arm is always exit 2.
#   5 the detector could not measure — never scored clean
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECTOR="${DISCORD_JOB_HEALTH_JS:-$HERE/scripts/discord_job_health.js}"
NODE_BIN="${DISCORD_JOB_HEALTH_NODE:-node}"
ISSUE_ID="${PAPERCLIP_TASK_ID:-}"
INTERVAL_HOURS=6
ERROR_RETRY_HOURS=1
WINDOW_HOURS=48

usage() {
  cat >&2 <<'EOF'
usage: discord_job_health_monitor.sh [--issue ISSUE_ID]
                                     [--interval-hours N]
                                     [--error-retry-hours N]
                                     [--window-hours N]

Runs scripts/discord_job_health.js --json, comments when the measured state
changes, and re-arms the native monitor. Defaults to $PAPERCLIP_TASK_ID.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) shift; [[ $# -gt 0 ]] || { echo "ERROR: --issue needs a value" >&2; exit 2; }; ISSUE_ID="$1" ;;
    --interval-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --interval-hours needs a value" >&2; exit 2; }; INTERVAL_HOURS="$1" ;;
    --error-retry-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --error-retry-hours needs a value" >&2; exit 2; }; ERROR_RETRY_HOURS="$1" ;;
    --window-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --window-hours needs a value" >&2; exit 2; }; WINDOW_HOURS="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

[[ -n "$ISSUE_ID" ]] || { echo "ERROR: set PAPERCLIP_TASK_ID or pass --issue" >&2; exit 2; }
[[ "$ISSUE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] \
  || { echo "ERROR: issue id contains characters that could change the API route" >&2; exit 2; }
for n in "$INTERVAL_HOURS" "$ERROR_RETRY_HOURS" "$WINDOW_HOURS"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: intervals must be positive whole hours" >&2; exit 2; }
done
for tool in curl jq date sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "ERROR: node is required" >&2; exit 2; }
[[ -f "$DETECTOR" ]] || { echo "ERROR: detector not found: $DETECTOR" >&2; exit 2; }
: "${PAPERCLIP_API_URL:?missing PAPERCLIP_API_URL}"
: "${PAPERCLIP_API_KEY:?missing PAPERCLIP_API_KEY}"

BASE="${PAPERCLIP_API_URL%/}"; BASE="${BASE%/api}"
WORK="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/discord_job_health_monitor.XXXXXXXX")" \
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

RESULT="$WORK/health.json"
DETECTOR_ERR="$WORK/detector.err"
"$NODE_BIN" "$DETECTOR" --json --window-hours "$WINDOW_HOURS" > "$RESULT" 2> "$DETECTOR_ERR"
DETECTOR_RC=$?

# Exit 5 is the detector's own "could not measure". Treat anything outside its
# documented codes as unmeasured too: an unknown status is not a pass.
MEASURED=yes
case "$DETECTOR_RC" in
  0|1) ;;
  *) MEASURED=no ;;
esac

# A documented exit code is not proof of a usable payload. Require the fields
# the comment actually reads before believing the measurement.
if [[ "$MEASURED" == yes ]] && ! jq -e '
    type == "object"
    and (.jobs | type == "array")
    and (.jobs | length > 0)
    and (.jobs | all(has("jobKey") and has("verdict")))
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
NOW="${DISCORD_JOB_HEALTH_MONITOR_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
NOW_EPOCH="$(date -u -d "$NOW" +%s 2>/dev/null)" \
  || { echo "ERROR: could not parse monitor clock '$NOW'" >&2; exit 2; }
NEXT_EPOCH=$((NOW_EPOCH + NEXT_HOURS * 3600))
NEXT_CHECK="$(date -u -d "@$NEXT_EPOCH" +%Y-%m-%dT%H:%M:%SZ)" \
  || { echo "ERROR: could not compute next monitor time" >&2; exit 2; }

COMMENT="$WORK/comment.md"
if [[ "$MEASURED" == yes ]]; then
  BROKEN_COUNT="$(jq -r '[.jobs[] | select(.verdict | test("healthy|DISABLED"; "i") | not)] | length' "$RESULT")"
  {
    echo "## Discord scheduled-job delivery monitor"
    echo
    if [[ "$BROKEN_COUNT" -gt 0 ]]; then
      echo "**Finding: $BROKEN_COUNT Discord scheduled job(s) are not delivering.**"
    else
      echo "**All Discord scheduled jobs healthy, and every time-gated job proved a delivery.**"
    fi
    echo
    echo '| Job | Schedule | Enabled | Verdict | Runs | Succeeded | Scope-denied | Delivered |'
    echo '|---|---|---|---|---|---|---|---|'
    jq -r '.jobs[] | "| `\(.jobKey)` | `\(.schedule // "—")` | \(.enabled) | \(.verdict) | \(.runs) | \(.succeeded) | \(.scopeDenied) | \(if .deliveryMetric then "\(.delivered) / \(.sendOpportunities) opportunities" else "n/a" end) |"' "$RESULT"
    echo
    echo "- Detector: \`node scripts/discord_job_health.js --json\` (exit $DETECTOR_RC), window **${WINDOW_HOURS}h**"
    echo "- Next check: **$NEXT_CHECK**"
    if [[ "$BROKEN_COUNT" -gt 0 ]]; then
      echo
      echo "> A \`succeeded\` row is not a post. \`discord-daily-digest\` is time-gated, so 23 of every 24 runs succeed at the hour gate having sent nothing; only the \`discord_digest_sent\` delivery column above is evidence."
      echo ">"
      echo "> **Expected steady state.** TOG-676 is an unfixed vendor defect with no host-side or config-side workaround that does not leak other companies' data into our private channel. This monitor is expected to report exit 1 every cycle until a vendor release lands. It is a standing measurement, not an unattended alarm — do not silence it, and do not read a long run of failures as this monitor being broken."
    fi
  } > "$COMMENT"
else
  {
    echo "## Discord scheduled-job delivery monitor"
    echo
    echo "**UNKNOWN: the detector did not produce a valid measurement.**"
    echo
    echo "- Detector exit: $DETECTOR_RC"
    echo "- Retry scheduled: **$NEXT_CHECK** (the shorter ${ERROR_RETRY_HOURS}h error interval)"
    echo
    echo "> Nothing was scored healthy. Inspect this run's detector stderr; the monitor was re-armed before this command exited."
  } > "$COMMENT"
fi

# Counts slide on every 48h window, so they are not state. Fingerprint the job
# enabled states, verdicts, failure classes, delivery evidence, and errors. The
# short hash is stored in monitor notes, which are readable on the next cycle;
# externalRef cannot carry it because Paperclip deliberately redacts that field.
STATE_JSON="$WORK/state.json"
if [[ "$MEASURED" == yes ]]; then
  jq -cS '{
    measured: true,
    jobs: ([.jobs[] | {
      jobKey,
      enabled,
      verdict,
      scopeDenied: ((.scopeDenied // 0) > 0),
      otherFailures: ((.otherFailures // 0) > 0),
      deliveryMetric: (.deliveryMetric // null),
      delivery: (if .deliveryMetric then {
        delivered: (.delivered // 0),
        opportunities: (.sendOpportunities // 0)
      } else null end),
      latestError: (.latestError // null)
    }] | sort_by(.jobKey))
  }' "$RESULT" > "$STATE_JSON" \
    || { echo "ERROR: could not fingerprint detector result" >&2; exit 2; }
else
  jq -cn --argjson rc "$DETECTOR_RC" --rawfile stderr "$DETECTOR_ERR" \
    '{measured:false, detectorExit:$rc, stderr:$stderr}' > "$STATE_JSON" \
    || { echo "ERROR: could not fingerprint detector failure" >&2; exit 2; }
fi
STATE_HASH="$(sha256sum "$STATE_JSON")" \
  || { echo "ERROR: could not hash detector state" >&2; exit 2; }
STATE_HASH="${STATE_HASH%% *}"
STATE_KEY="${STATE_HASH:0:16}"

ISSUE_JSON="$WORK/issue.json"
GET_STATUS="$(request GET "$BASE/api/issues/$ISSUE_ID" "$ISSUE_JSON")" \
  || { echo "ERROR: could not read monitor issue" >&2; exit 2; }
case "$GET_STATUS" in
  2*) ;;
  *) echo "ERROR: monitor issue read returned HTTP $GET_STATUS" >&2; exit 2 ;;
esac
jq -e 'type == "object" and (.id | type == "string")' "$ISSUE_JSON" >/dev/null 2>&1 \
  || { echo "ERROR: monitor issue response was not an issue" >&2; exit 2; }
PREVIOUS_STATE_KEY="$(jq -r '
  try (.executionState.monitor.notes // .executionPolicy.monitor.notes // "" | capture("state=(?<key>[0-9a-f]{16})").key)
  catch ""
' "$ISSUE_JSON")" \
  || { echo "ERROR: could not read prior monitor state" >&2; exit 2; }
COMMENT_CHANGED=yes
[[ "$PREVIOUS_STATE_KEY" == "$STATE_KEY" ]] && COMMENT_CHANGED=no

PATCH_BODY="$WORK/patch.json"
jq -n \
  --slurpfile issue "$ISSUE_JSON" \
  --rawfile comment "$COMMENT" \
  --arg next "$NEXT_CHECK" \
  --arg interval "$INTERVAL_HOURS" \
  --arg retry "$ERROR_RETRY_HOURS" \
  --arg state "$STATE_KEY" \
  --arg commentChanged "$COMMENT_CHANGED" '
  ($issue[0].executionPolicy // {}) as $policy
  | {
      executionPolicy: ($policy + {
        monitor: {
          nextCheckAt: $next,
          notes: ("Run the card description git-show block; never run ./discord_job_health_monitor.sh from the shared checkout (exit 127 does not re-arm). Normal " + $interval + "h; detector/API errors " + $retry + "h. Exit 1 is expected until TOG-676 is fixed. A succeeded row is not delivery; only discord_digest_sent is. state=" + $state),
          scheduledBy: "assignee",
          kind: "external_service",
          serviceName: "Discord scheduled-job delivery",
          recoveryPolicy: "wake_owner"
        }
      })
    }
  | if $commentChanged == "yes" then . + {comment: $comment} else . end
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
# scheduler queries (server heartbeat.js selects on `issues.monitorNextCheckAt`);
# `executionPolicy.monitor` is the write-side shape and is echoed back verbatim
# whether or not the column was set. Falling back to the nested path therefore
# accepts our own request as evidence of the write it was supposed to verify —
# an unarmed issue would score armed.
STORED_NEXT="$(jq -r '.monitorNextCheckAt // empty' "$PATCH_RESPONSE" 2>/dev/null)"
if [[ -z "$STORED_NEXT" ]]; then
  echo "ERROR: Paperclip returned HTTP $PATCH_STATUS but stored no monitorNextCheckAt column" >&2
  exit 2
fi

# Compare the INSTANT, not the string. The server normalises to millisecond
# precision, so a request for `2026-08-30T14:49:41Z` reads back as
# `2026-08-30T14:49:41.000Z`. Those are the same moment; a string compare calls
# a correct arming a failure, and reports exit 2 over the detector's real
# verdict on every single cycle.
STORED_EPOCH="$(date -u -d "$STORED_NEXT" +%s 2>/dev/null)" \
  || { echo "ERROR: Paperclip stored an unparseable monitorNextCheckAt: $STORED_NEXT" >&2; exit 2; }
if [[ "$STORED_EPOCH" != "$NEXT_EPOCH" ]]; then
  echo "ERROR: Paperclip returned HTTP $PATCH_STATUS but stored nextCheckAt=$STORED_NEXT, not $NEXT_CHECK" >&2
  exit 2
fi

echo "discord job health monitor: result=$DETECTOR_RC next=$NEXT_CHECK comment=$COMMENT_CHANGED issue=$ISSUE_ID"
exit "$DETECTOR_RC"
