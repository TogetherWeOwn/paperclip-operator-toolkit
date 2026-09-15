#!/usr/bin/env bash
# Regression suite for the TOG-1129 backup stall monitor wrapper.
#
# The wrapper's load-bearing properties are that a STALLED detector never
# becomes a healthy claim, that an unmeasurable detector is never scored clean,
# and that every outcome re-arms a native Paperclip issue monitor. Offline:
# detector and curl are recording stubs, and the clock is fixed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${DB_BACKUP_STALL_MONITOR_SH:-$HERE/db_backup_stall_monitor.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -x "$TOOL" ]] || { echo "ERROR: $TOOL is not executable" >&2; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_db_backup_stall_monitor.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat > "$WORK/issue.json" <<'EOF'
{
  "id":"issue-monitor",
  "identifier":"TOG-1144",
  "status":"in_progress",
  "monitorNextCheckAt":null,
  "executionPolicy":{
    "mode":"normal",
    "commentRequired":true,
    "stages":[],
    "maxReviewRounds":null,
    "monitor":null
  }
}
EOF

# The detector stub stands in for ./db_backup_stall.sh. The wrapper invokes it
# as `$DETECTOR --json ...`, so the stub ignores argv beyond recording it.
cat > "$WORK/bin/fakedetector" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DETECTOR_ARGV_LOG"
[[ -z "${DETECTOR_STDERR:-}" ]] || printf '%s\n' "$DETECTOR_STDERR" >&2
printf '%s\n' "$DETECTOR_JSON"
exit "$DETECTOR_RC"
STUB
chmod +x "$WORK/bin/fakedetector"

cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
cfg=""
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "--config" ]]; then j=$((i+1)); cfg="${!j}"; fi
done
[[ -n "$cfg" ]] || exit 90
tr '\0' '\n' < "/proc/$$/cmdline" >> "$ARGV_LOG"
cat "$cfg" >> "$CFG_LOG"
url="$(sed -n 's/^url = "\(.*\)"$/\1/p' "$cfg")"
method="$(sed -n 's/^request = "\(.*\)"$/\1/p' "$cfg")"
out="$(sed -n 's/^output = "\(.*\)"$/\1/p' "$cfg")"
body="$(sed -n 's/^data-binary = "@\(.*\)"$/\1/p' "$cfg")"
printf '%s\t%s\t%s\n' "$method" "$url" "$body" >> "$REQUEST_LOG"
if [[ "$method" == GET ]]; then
  cp "$ISSUE_SRC" "$out"
  http_status="${CURL_GET_HTTP_STATUS:-${CURL_HTTP_STATUS:-200}}"
else
  cp "$body" "$PATCH_LOG"
  patch_count="$(grep -c '^PATCH' "$REQUEST_LOG")"
  if [[ "$patch_count" -eq 1 ]]; then
    http_status="${CURL_PATCH_FIRST_HTTP_STATUS:-${CURL_HTTP_STATUS:-200}}"
  else
    http_status="${CURL_PATCH_RETRY_HTTP_STATUS:-${CURL_HTTP_STATUS:-200}}"
  fi
  # Model the REAL server: `executionPolicy.monitor` is echoed back verbatim,
  # but the authoritative top-level `monitorNextCheckAt` column is rendered at
  # millisecond precision. So a request for `...:00Z` reads back as
  # `...:00.000Z`. Echoing the request string instead would make this stub
  # agree with any string compare and hide the defect TOG-718 measured.
  requested="$(jq -r '.executionPolicy.monitor.nextCheckAt' "$body")"
  stored="${MONITOR_STORED_NEXT_OVERRIDE:-${requested/%Z/.000Z}}"
  if [[ "${MONITOR_OMIT_STORED_COLUMN:-}" == 1 ]]; then
    jq --slurpfile p "$body" '. + {executionPolicy:$p[0].executionPolicy} | del(.monitorNextCheckAt)' \
      "$ISSUE_SRC" > "$out"
  else
    jq --slurpfile p "$body" --arg stored "$stored" \
      '. + {executionPolicy:$p[0].executionPolicy, monitorNextCheckAt:$stored}' \
      "$ISSUE_SRC" > "$out"
  fi
fi
printf '%s' "$http_status"
STUB
chmod +x "$WORK/bin/curl"

# The live 2026-09-05 wedge, as the detector actually emitted it.
STALL_JSON='{"verdict":"stall","checkedAt":"2026-09-05T19:34:47Z","logFile":"/x/server.log","windowAnchored":true,"skipCountInWindow":0,"orphanCount":1,"logStale":true,"newestUsableBackup":"paperclip-20260905-051709.sql.gz","newestUsableBackupAgeMinutes":856,"minBackupBytes":1024,"maxBackupAgeHours":2,"healthStatus":"ok","reasons":["TRUNCATED: paperclip-20260905-063644.sql is 777 minutes old and its .sql.gz sibling is only 20 bytes","STALE: the newest usable backup is 856 minutes old"],"notes":["/api/health reports databaseBackup.status=ok while this detector sees a stall."],"exitCode":1}'

OK_JSON='{"verdict":"ok","checkedAt":"2026-09-05T19:34:47Z","logFile":"/x/server.log","windowAnchored":true,"skipCountInWindow":0,"orphanCount":0,"logStale":false,"newestUsableBackup":"paperclip-20260905-191709.sql.gz","newestUsableBackupAgeMinutes":17,"minBackupBytes":1024,"maxBackupAgeHours":2,"healthStatus":"ok","reasons":[],"notes":[],"exitCode":0}'

INCONCLUSIVE_JSON='{"verdict":"inconclusive","checkedAt":"2026-09-05T19:34:47Z","reasons":[],"notes":["log unreadable"],"exitCode":2}'

run_case() {
  : > "$WORK/argv.log"; : > "$WORK/cfg.log"; : > "$WORK/requests.log"
  : > "$WORK/patch.json"; : > "$WORK/detector-argv.log"
  env -i PATH="$WORK/bin:$PATH" HOME="$WORK" TMPDIR="$WORK" \
    PAPERCLIP_API_URL="https://paperclip.invalid/api" \
    PAPERCLIP_API_KEY="pc_CANARY_backup_monitor_key" \
    PAPERCLIP_TASK_ID="issue-monitor" \
    DB_BACKUP_STALL_MONITOR_NOW="2026-09-05T20:00:00Z" \
    DB_BACKUP_STALL_SH="$WORK/bin/fakedetector" \
    DETECTOR_JSON="$1" DETECTOR_RC="$2" \
    DETECTOR_STDERR="${DETECTOR_STDERR:-}" \
    ARGV_LOG="$WORK/argv.log" CFG_LOG="$WORK/cfg.log" \
    REQUEST_LOG="$WORK/requests.log" PATCH_LOG="$WORK/patch.json" \
    DETECTOR_ARGV_LOG="$WORK/detector-argv.log" ISSUE_SRC="$WORK/issue.json" \
    CURL_HTTP_STATUS="${CURL_HTTP_STATUS:-200}" \
    CURL_GET_HTTP_STATUS="${CURL_GET_HTTP_STATUS:-}" \
    CURL_PATCH_FIRST_HTTP_STATUS="${CURL_PATCH_FIRST_HTTP_STATUS:-}" \
    CURL_PATCH_RETRY_HTTP_STATUS="${CURL_PATCH_RETRY_HTTP_STATUS:-}" \
    MONITOR_STORED_NEXT_OVERRIDE="${MONITOR_STORED_NEXT_OVERRIDE:-}" \
    MONITOR_OMIT_STORED_COLUMN="${MONITOR_OMIT_STORED_COLUMN:-}" \
    "$TOOL" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" > "$WORK/out.txt" 2> "$WORK/err.txt"
  CASE_RC=$?
}
EXTRA_ARGS=()

next_at() { jq -r '.executionPolicy.monitor.nextCheckAt' "$WORK/patch.json"; }
comment()  { jq -r '.comment' "$WORK/patch.json"; }

hdr "1. A live stall is reported and re-armed"
run_case "$STALL_JSON" 1
[[ "$CASE_RC" -eq 1 ]] && ok "preserves detector exit 1 after a successful re-arm" || bad "expected exit 1, got $CASE_RC"
[[ "$(next_at)" == "2026-09-05T21:00:00Z" ]] \
  && ok "a stall re-checks in one hour, not the normal two" || bad "stall interval was $(next_at)"
comment | grep -q "STALL DETECTED" \
  && ok "the comment leads with the stall, not a table" || bad "comment did not announce the stall"
comment | grep -q "856" \
  && ok "carries the measured backup age" || bad "comment lost the measured age"
comment | grep -qi "expected steady state" \
  && ok "says a repeating stall is expected until TOG-1138" || bad "missing the expected-steady-state notice"
comment | grep -q "TOG-1138" \
  && ok "names the operator card that actually clears it" || bad "did not name TOG-1138"

hdr "2. The /api/health blind spot is never allowed to read as reassurance"
comment | grep -qi "blind spot" \
  && ok "flags health=ok during a stall as the documented blind spot" || bad "health ok was not flagged"
comment | grep -qi "never use it to clear" \
  && ok "states health must not clear the finding" || bad "missing the do-not-clear instruction"

hdr "3. A clean measurement is reported and re-armed on the normal interval"
run_case "$OK_JSON" 0
[[ "$CASE_RC" -eq 0 ]] && ok "preserves detector exit 0" || bad "expected exit 0, got $CASE_RC"
[[ "$(next_at)" == "2026-09-05T22:00:00Z" ]] \
  && ok "normal outcome re-arms exactly two hours later" || bad "normal interval was $(next_at)"
comment | grep -q "No stall" \
  && ok "reports the clean verdict" || bad "clean verdict not reported"
comment | grep -qi "expected steady state" \
  && bad "a clean cycle must not carry the stall boilerplate" || ok "clean cycle omits the stall boilerplate"

hdr "4. An unmeasurable detector is never scored clean"
run_case "$INCONCLUSIVE_JSON" 2
[[ "$CASE_RC" -eq 2 ]] && ok "inconclusive stays exit 2" || bad "expected exit 2, got $CASE_RC"
comment | grep -q "UNKNOWN" \
  && ok "inconclusive is reported as UNKNOWN, not as health" || bad "inconclusive was not marked UNKNOWN"
comment | grep -qi "not a passing backup" \
  && ok "states an inconclusive cycle is not a verified backup" || bad "missing the not-a-pass statement"
[[ "$(next_at)" == "2026-09-06T02:00:00Z" ]] \
  && ok "an error retries on the six-hour interval, not hourly against a dead source" || bad "error interval was $(next_at)"

hdr "5. An undocumented exit code is treated as unmeasured, not as a pass"
run_case "$OK_JSON" 7
[[ "$CASE_RC" -eq 2 ]] && ok "exit 7 is normalised to 2, never to 0" || bad "expected exit 2, got $CASE_RC"
comment | grep -q "UNKNOWN" \
  && ok "an unknown status is reported UNKNOWN even with a healthy-looking payload" \
  || bad "unknown status leaked a healthy claim"
# Normalising must not be achieved by discarding the evidence: the operator
# still needs the code the detector actually returned. Paired with the
# assertion above, this pins the fix to "report raw, exit normalised" rather
# than either alone.
comment | grep -q "Detector exit: 7" \
  && ok "reports the RAW code 7 while exiting 2" || bad "the raw detector code was lost from the report"

hdr "6. A payload disagreeing with its exit code is not trusted"
# The dangerous direction: exit 0 (healthy) carrying a stall verdict, or a
# stall payload returned with exit 0. Either means we do not understand the
# detector, and neither may score clean.
run_case "$STALL_JSON" 0
[[ "$CASE_RC" -eq 2 ]] && ok "a stall payload returned with exit 0 is rejected, not believed" \
  || bad "a stall payload with exit 0 scored $CASE_RC"
comment | grep -q "UNKNOWN" \
  && ok "the disagreeing cycle is reported UNKNOWN" || bad "disagreement not surfaced"
run_case "$OK_JSON" 1
[[ "$CASE_RC" -eq 2 ]] && ok "an ok payload returned with exit 1 is also rejected" \
  || bad "an ok payload with exit 1 scored $CASE_RC"

hdr "7. Garbage payloads never become a healthy claim"
run_case 'not json at all' 0
[[ "$CASE_RC" -eq 2 ]] && ok "unparseable output is exit 2" || bad "unparseable output scored $CASE_RC"
run_case '{"verdict":"ok"}' 0
[[ "$CASE_RC" -eq 2 ]] && ok "a payload missing reasons/checkedAt is rejected" \
  || bad "an incomplete payload scored $CASE_RC"
run_case '[]' 0
[[ "$CASE_RC" -eq 2 ]] && ok "a JSON array is rejected" || bad "an array scored $CASE_RC"

hdr "8. The monitor is armed against the authoritative column, not our own echo"
MONITOR_OMIT_STORED_COLUMN=1 run_case "$OK_JSON" 0
[[ "$CASE_RC" -eq 2 ]] \
  && ok "a 200 that stores no monitorNextCheckAt column is a failed re-arm" \
  || bad "an unarmed issue scored $CASE_RC"
unset MONITOR_OMIT_STORED_COLUMN
grep -qi "stored no monitorNextCheckAt" "$WORK/err.txt" \
  && ok "says which column was missing" || bad "unhelpful failed-re-arm error"

MONITOR_STORED_NEXT_OVERRIDE="2026-09-05T23:30:00.000Z" run_case "$OK_JSON" 0
[[ "$CASE_RC" -eq 2 ]] \
  && ok "a column storing a DIFFERENT instant is a failed re-arm" \
  || bad "a wrong stored instant scored $CASE_RC"
unset MONITOR_STORED_NEXT_OVERRIDE

hdr "9. Millisecond normalisation is not mistaken for a failed write"
# The real server returns `...:00.000Z` for a requested `...:00Z`. A string
# compare would report exit 2 over the detector's real verdict every cycle.
run_case "$STALL_JSON" 1
[[ "$CASE_RC" -eq 1 ]] \
  && ok "millisecond-normalised readback is accepted as the same instant" \
  || bad "ms normalisation was scored a failure ($CASE_RC)"

hdr "10. Paperclip failures use the six-hour error cadence"
CURL_PATCH_FIRST_HTTP_STATUS=500 CURL_PATCH_RETRY_HTTP_STATUS=200 run_case "$OK_JSON" 0
[[ "$CASE_RC" -eq 2 ]] && ok "a recovered Paperclip failure stays exit 2" || bad "recovered PATCH failure scored $CASE_RC"
[[ "$(grep -c '^PATCH' "$WORK/requests.log")" -eq 2 ]] \
  && ok "a failed normal-cadence write gets one bounded recovery write" \
  || bad "expected two PATCH attempts"
[[ "$(next_at)" == "2026-09-06T02:00:00Z" ]] \
  && ok "the recovery write re-arms at six hours, not the clean detector's two" \
  || bad "Paperclip failure retry interval was $(next_at)"
comment | grep -q "Next check | \*\*2026-09-06T02:00:00Z\*\*" \
  && ok "the recovered clean-cycle comment reports the stored six-hour time" \
  || bad "the recovered clean-cycle comment disagrees with the stored cadence"

CURL_PATCH_FIRST_HTTP_STATUS=500 CURL_PATCH_RETRY_HTTP_STATUS=200 run_case "$STALL_JSON" 1
[[ "$CASE_RC" -eq 2 ]] && ok "a recovered stall write also stays exit 2" || bad "recovered stall PATCH failure scored $CASE_RC"
[[ "$(next_at)" == "2026-09-06T02:00:00Z" ]] \
  && ok "the recovered stall write replaces its one-hour cadence with six hours" \
  || bad "recovered stall retry interval was $(next_at)"
comment | grep -q "Next check | \*\*2026-09-06T02:00:00Z\*\*" \
  && ok "the recovered stall comment reports the stored six-hour time" \
  || bad "the recovered stall comment disagrees with the stored cadence"

CURL_PATCH_FIRST_HTTP_STATUS=500 CURL_PATCH_RETRY_HTTP_STATUS=500 run_case "$OK_JSON" 0
[[ "$CASE_RC" -eq 2 ]] && ok "a persistent HTTP 500 from Paperclip is exit 2" || bad "HTTP 500 scored $CASE_RC"
[[ "$(grep -c '^PATCH' "$WORK/requests.log")" -eq 2 ]] \
  && ok "a persistent failure is attempted at most twice" || bad "persistent failure attempt count was $(grep -c '^PATCH' "$WORK/requests.log")"

hdr "11. The bearer token never reaches argv"
run_case "$STALL_JSON" 1
grep -q "pc_CANARY_backup_monitor_key" "$WORK/argv.log" \
  && bad "the API key appeared in curl argv" || ok "the API key never appears in curl argv"
grep -q "pc_CANARY_backup_monitor_key" "$WORK/cfg.log" \
  && ok "the key travels in the curl config file instead" || bad "the key was not in the config file"

hdr "12. The existing execution policy is preserved, not replaced"
run_case "$STALL_JSON" 1
[[ "$(jq -r '.executionPolicy.mode' "$WORK/patch.json")" == "normal" ]] \
  && ok "keeps sibling executionPolicy keys" || bad "clobbered the execution policy"
[[ "$(jq -r '.executionPolicy.monitor.kind' "$WORK/patch.json")" == "external_service" ]] \
  && ok "uses the only accepted monitor kind enum" || bad "monitor kind is not external_service"
[[ "$(jq -r '.executionPolicy.monitor.scheduledBy' "$WORK/patch.json")" == "assignee" ]] \
  && ok "scheduledBy is assignee" || bad "scheduledBy is wrong"
[[ "$(jq -r '.executionPolicy.monitor.notes' "$WORK/patch.json" | wc -c)" -le 500 ]] \
  && ok "notes stay under the 500-char cap that voids the whole write" || bad "notes exceed the 500-char cap"
[[ "$(jq -r '.executionPolicy.monitor.notes' "$WORK/patch.json")" == *"error 6h"* ]] \
  && ok "notes advertise the new 6h error cadence" || bad "notes still advertise the old error cadence"

hdr "13. Detector passthrough and argument hygiene"
EXTRA_ARGS=(-- --backup-dir /somewhere)
run_case "$OK_JSON" 0
grep -q -- "--backup-dir /somewhere" "$WORK/detector-argv.log" \
  && ok "passes through detector args after --" || bad "detector args were dropped"
grep -q -- "--json" "$WORK/detector-argv.log" \
  && ok "always requests --json" || bad "did not request --json"
EXTRA_ARGS=()

EXTRA_ARGS=(--interval-hours 0)
run_case "$OK_JSON" 0
[[ "$CASE_RC" -eq 2 ]] && ok "rejects --interval-hours 0" || bad "accepted a zero interval"
EXTRA_ARGS=(--issue "../../etc/passwd")
run_case "$OK_JSON" 0
[[ "$CASE_RC" -eq 2 ]] && ok "rejects a path-escaping issue id" || bad "accepted a route-changing issue id"
EXTRA_ARGS=(--nonsense)
run_case "$OK_JSON" 0
[[ "$CASE_RC" -eq 2 ]] && ok "rejects an unknown flag instead of ignoring it" || bad "silently ignored an unknown flag"
EXTRA_ARGS=()

printf '\n\033[1mTOTAL\033[0m  %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
