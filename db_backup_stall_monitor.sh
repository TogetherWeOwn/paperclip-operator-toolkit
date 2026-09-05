#!/usr/bin/env bash
# ===========================================================================
# db_backup_stall_monitor.sh — one complete cycle of the TOG-1129 backup
# stall monitor.
# ---------------------------------------------------------------------------
# db_backup_stall.sh is a correct detector and CI proves it is not vacuous
# (test_db_backup_stall.sh, registered at .github/workflows/ci.yml:1738). But
# CI runs it against fixture directories only: the workflow has no Paperclip
# installation, so every CI execution measures a recording and never this host.
# Nothing runs the detector against production on any clock.
#
# That is not a theoretical gap. On 2026-09-05 the scheduler wedged at 06:36Z
# and was found by a human operator at 17:45Z — ELEVEN HOURS later, and only
# because someone went looking. The 2026-08-30 occurrence (TOG-831) ran 92
# hours and lost 90 backups. Both times the detector-shaped evidence was
# sitting on disk the whole time with nothing reading it.
#
# `/api/health` cannot close this gap and must never be mistaken for it: it
# only stats .sql.gz mtimes, so it reported `databaseBackup.status=ok` at the
# 13-hour mark of a dead scheduler, because the wedge leaves a 20-byte .gz
# whose mtime is fresh. The detector is the only thing that reads usability.
#
# This wrapper does the other half of the loop in one command:
#
#   1. run the detector against this installation;
#   2. post the measured verdict to the dedicated monitor issue;
#   3. re-arm that issue's native monitor for the next cycle.
#
# Run this from the monitor issue's heartbeat:
#
#   ./db_backup_stall_monitor.sh
#
# INTERVAL. Backups are hourly and the detector's staleness threshold is 2h, so
# the normal interval is 2 hours: a wedge is caught within one threshold window
# instead of eleven hours. A detected stall re-checks in 1 hour, because a
# stall is a live incident whose clearing (an operator restart) should be
# noticed promptly rather than up to a full cycle later. A detector or API
# failure also retries in 1 hour. Those numbers live here rather than in issue
# prose so every run makes the same decision.
#
# THIS MONITOR IS EXPECTED TO EXIT 1 UNTIL AN OPERATOR RESTARTS THE SERVER.
# The wedged flag lives in process memory; no code change and no file on disk
# clears it (TOG-1138). So a run of failing cycles is the expected steady state
# of a known-open incident, not a broken monitor — the comment says so, so that
# silencing it requires deleting the monitor rather than letting it go quietly
# green.
#
# INCONCLUSIVE IS NOT HEALTHY. The detector's exit 2 means it could not measure
# — an unreadable log, an unanchored window. This wrapper never converts that
# into a clean cycle, and it never scores an unparseable payload as a pass.
#
# This script writes only to the dedicated monitor issue: one comment plus its
# next monitor timestamp. The existing execution policy is preserved; only
# `.monitor` is replaced. The Paperclip bearer travels in a 0600 curl config,
# never argv.
#
# Exit status is the detector's status after the monitor has been re-armed:
#   0 no stall
#   1 STALL detected
#   2 inconclusive, detector failure, or Paperclip failure. A failed re-arm is
#     always exit 2.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECTOR="${DB_BACKUP_STALL_SH:-$HERE/db_backup_stall.sh}"
ISSUE_ID="${PAPERCLIP_TASK_ID:-}"
INTERVAL_HOURS=2
STALL_RETRY_HOURS=1
ERROR_RETRY_HOURS=1
DETECTOR_ARGS=()

usage() {
  cat >&2 <<'EOF'
usage: db_backup_stall_monitor.sh [--issue ISSUE_ID]
                                  [--interval-hours N]
                                  [--stall-retry-hours N]
                                  [--error-retry-hours N]
                                  [-- DETECTOR_ARGS...]

Runs ./db_backup_stall.sh --json, comments the result on the monitor issue, and
re-arms its native Paperclip monitor. Defaults to $PAPERCLIP_TASK_ID.

Anything after `--` is passed through to the detector, e.g.
  ./db_backup_stall_monitor.sh -- --backup-dir /path/to/backups
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) shift; [[ $# -gt 0 ]] || { echo "ERROR: --issue needs a value" >&2; exit 2; }; ISSUE_ID="$1" ;;
    --interval-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --interval-hours needs a value" >&2; exit 2; }; INTERVAL_HOURS="$1" ;;
    --stall-retry-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --stall-retry-hours needs a value" >&2; exit 2; }; STALL_RETRY_HOURS="$1" ;;
    --error-retry-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --error-retry-hours needs a value" >&2; exit 2; }; ERROR_RETRY_HOURS="$1" ;;
    --) shift; DETECTOR_ARGS=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

[[ -n "$ISSUE_ID" ]] || { echo "ERROR: set PAPERCLIP_TASK_ID or pass --issue" >&2; exit 2; }
[[ "$ISSUE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] \
  || { echo "ERROR: issue id contains characters that could change the API route" >&2; exit 2; }
for n in "$INTERVAL_HOURS" "$STALL_RETRY_HOURS" "$ERROR_RETRY_HOURS"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: intervals must be positive whole hours" >&2; exit 2; }
done
for tool in curl jq date; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done
[[ -x "$DETECTOR" ]] || { echo "ERROR: detector not found or not executable: $DETECTOR" >&2; exit 2; }
: "${PAPERCLIP_API_URL:?missing PAPERCLIP_API_URL}"
: "${PAPERCLIP_API_KEY:?missing PAPERCLIP_API_KEY}"

BASE="${PAPERCLIP_API_URL%/}"; BASE="${BASE%/api}"
WORK="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/db_backup_stall_monitor.XXXXXXXX")" \
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

RESULT="$WORK/stall.json"
DETECTOR_ERR="$WORK/detector.err"
"$DETECTOR" --json "${DETECTOR_ARGS[@]+"${DETECTOR_ARGS[@]}"}" > "$RESULT" 2> "$DETECTOR_ERR"
DETECTOR_RC=$?

# Exit 2 is the detector's own "could not measure". Treat anything outside its
# documented codes as unmeasured too: an unknown status is not a pass.
#
# The raw code is kept for the report, but the code this wrapper EXITS with is
# normalised to 2. Propagating an undocumented status verbatim would let a
# caller that tests `rc == 1` read exit 7 as "no stall" -- an unmeasured cycle
# scoring as health, which is the exact failure this monitor exists to prevent.
DETECTOR_RAW_RC="$DETECTOR_RC"
MEASURED=yes
case "$DETECTOR_RC" in
  0|1) ;;
  *) MEASURED=no; DETECTOR_RC=2 ;;
esac

# A documented exit code is not proof of a usable payload. Require the fields
# the comment actually reads before believing the measurement, and require the
# verdict to AGREE with the exit code -- a payload saying "ok" alongside exit 1
# is a detector we do not understand, not a healthy installation.
if [[ "$MEASURED" == yes ]] && ! jq -e --argjson rc "$DETECTOR_RC" '
    type == "object"
    and (.verdict | type == "string")
    and (.reasons | type == "array")
    and (.checkedAt | type == "string")
    and ((.verdict == "stall") == ($rc == 1))
  ' "$RESULT" >/dev/null 2>&1; then
  MEASURED=no
  DETECTOR_RC=2
fi

if [[ "$MEASURED" != yes ]]; then
  NEXT_HOURS="$ERROR_RETRY_HOURS"
elif [[ "$DETECTOR_RC" -eq 1 ]]; then
  NEXT_HOURS="$STALL_RETRY_HOURS"
else
  NEXT_HOURS="$INTERVAL_HOURS"
fi

# Test seam: a fixed instant makes both the schedule and its assertion stable.
NOW="${DB_BACKUP_STALL_MONITOR_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
NOW_EPOCH="$(date -u -d "$NOW" +%s 2>/dev/null)" \
  || { echo "ERROR: could not parse monitor clock '$NOW'" >&2; exit 2; }
NEXT_EPOCH=$((NOW_EPOCH + NEXT_HOURS * 3600))
NEXT_CHECK="$(date -u -d "@$NEXT_EPOCH" +%Y-%m-%dT%H:%M:%SZ)" \
  || { echo "ERROR: could not compute next monitor time" >&2; exit 2; }

COMMENT="$WORK/comment.md"
if [[ "$MEASURED" == yes ]]; then
  NEWEST="$(jq -r '.newestUsableBackup // "none"' "$RESULT")"
  AGE_MIN="$(jq -r '.newestUsableBackupAgeMinutes // "unknown"' "$RESULT")"
  HEALTH="$(jq -r '.healthStatus // "unknown"' "$RESULT")"
  {
    echo "## Database backup stall monitor"
    echo
    if [[ "$DETECTOR_RC" -eq 1 ]]; then
      echo "**STALL DETECTED — scheduled database backups are not landing.**"
    else
      echo "**No stall: the newest usable backup is within threshold.**"
    fi
    echo
    echo "| Field | Value |"
    echo "|---|---|"
    echo "| Verdict | \`$(jq -r '.verdict' "$RESULT")\` (exit $DETECTOR_RC) |"
    echo "| Checked at | $(jq -r '.checkedAt' "$RESULT") |"
    echo "| Newest usable \`.sql.gz\` | \`$NEWEST\`, **${AGE_MIN} min** old |"
    echo "| Orphaned / truncated | $(jq -r '.orphanCount // 0' "$RESULT") |"
    echo "| Skips in log window | $(jq -r '.skipCountInWindow // 0' "$RESULT") |"
    echo "| Log anchor stale | $(jq -r '.logStale // false' "$RESULT") |"
    echo "| \`/api/health\` says | \`$HEALTH\` |"
    echo "| Next check | **$NEXT_CHECK** |"
    if [[ "$(jq -r '.reasons | length' "$RESULT")" -gt 0 ]]; then
      echo
      echo "**Findings**"
      echo
      jq -r '.reasons[] | "- " + .' "$RESULT"
    fi
    if [[ "$(jq -r '.notes | length' "$RESULT")" -gt 0 ]]; then
      echo
      echo "**Notes**"
      echo
      jq -r '.notes[] | "- " + .' "$RESULT"
    fi
    if [[ "$DETECTOR_RC" -eq 1 ]]; then
      echo
      echo "> **Expected steady state while TOG-1138 is open.** The in-flight flag lives in the server process's memory; no code change and no file on disk clears it. Until an operator restarts the server at a quiet window, this monitor is expected to report a stall every cycle. It is a standing measurement of a known-open incident, not an unattended alarm — do not silence it, and do not read a run of failures as this monitor being broken."
      echo ">"
      echo "> Recovery is proved by the **next hourly tick landing a \`>1 MB\` \`.sql.gz\`**, not by the restart completing. Runbook: \`docs/runbooks/database-backup-stall.md\`."
      if [[ "$HEALTH" == "ok" ]]; then
        echo ">"
        echo "> \`/api/health\` reporting \`ok\` here is the documented blind spot, not a contradiction: it stats \`.sql.gz\` mtimes only, and the wedge leaves a fresh-mtime 20-byte frame. Never use it to clear this finding."
      fi
    fi
  } > "$COMMENT"
else
  {
    echo "## Database backup stall monitor"
    echo
    echo "**UNKNOWN: the detector did not produce a valid measurement.**"
    echo
    echo "- Detector exit: $DETECTOR_RAW_RC"
    echo "- Retry scheduled: **$NEXT_CHECK** (the shorter ${ERROR_RETRY_HOURS}h error interval)"
    echo
    echo '```'
    tail -c 1500 "$DETECTOR_ERR" 2>/dev/null || true
    echo '```'
    echo
    echo "> Nothing was scored healthy. An inconclusive detector is not a passing backup: treat this exactly as an unverified backup schedule until a cycle measures cleanly."
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
  --arg next "$NEXT_CHECK" '
  ($issue[0].executionPolicy // {}) as $policy
  | {
      comment: $comment,
      executionPolicy: ($policy + {
        monitor: {
          nextCheckAt: $next,
          notes: "Do NOT run ./db_backup_stall_monitor.sh from the shared workspace: it sits on whatever branch the last run left, the script may be absent, and the exit 127 never re-arms this clock. Run the git-show block in this card description verbatim. Normal 2h, stall 1h, error 1h. A STALL every cycle is EXPECTED until the TOG-1138 operator restart. /api/health says ok during this wedge and must never clear it.",
          scheduledBy: "assignee",
          kind: "external_service",
          serviceName: "Paperclip database backup scheduler",
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
# echoed back verbatim whether or not the column was set. Falling back to the
# nested path would accept our own request as evidence of the write it was
# supposed to verify -- an unarmed issue would score armed.
STORED_NEXT="$(jq -r '.monitorNextCheckAt // empty' "$PATCH_RESPONSE" 2>/dev/null)"
if [[ -z "$STORED_NEXT" ]]; then
  echo "ERROR: Paperclip returned HTTP $PATCH_STATUS but stored no monitorNextCheckAt column" >&2
  exit 2
fi

# Compare the INSTANT, not the string. The server normalises to millisecond
# precision, so a request for `2026-09-05T20:00:00Z` reads back as
# `2026-09-05T20:00:00.000Z`. Those are the same moment; a string compare calls
# a correct arming a failure and reports exit 2 over the detector's real
# verdict on every single cycle.
STORED_EPOCH="$(date -u -d "$STORED_NEXT" +%s 2>/dev/null)" \
  || { echo "ERROR: Paperclip stored an unparseable monitorNextCheckAt: $STORED_NEXT" >&2; exit 2; }
if [[ "$STORED_EPOCH" != "$NEXT_EPOCH" ]]; then
  echo "ERROR: Paperclip returned HTTP $PATCH_STATUS but stored nextCheckAt=$STORED_NEXT, not $NEXT_CHECK" >&2
  exit 2
fi

echo "db backup stall monitor: result=$DETECTOR_RC next=$NEXT_CHECK issue=$ISSUE_ID"
exit "$DETECTOR_RC"
