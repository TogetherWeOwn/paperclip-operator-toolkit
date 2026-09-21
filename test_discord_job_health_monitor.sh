#!/usr/bin/env bash
# Regression suite for the TOG-676 scheduled monitor wrapper.
#
# The wrapper's load-bearing properties are that a FAILING detector never
# becomes a healthy claim, that an unmeasurable detector is never scored clean,
# and that every outcome re-arms a native Paperclip issue monitor. Offline:
# detector and curl are recording stubs, and the clock is fixed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${DISCORD_JOB_HEALTH_MONITOR_SH:-$HERE/discord_job_health_monitor.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -x "$TOOL" ]] || { echo "ERROR: $TOOL is not executable" >&2; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_discord_job_health_monitor.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat > "$WORK/issue.json" <<'EOF'
{
  "id":"issue-monitor",
  "identifier":"TOG-676",
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

# The detector stub stands in for `node scripts/discord_job_health.js`. The
# wrapper invokes it as `$NODE_BIN $DETECTOR --json ...`, so the stub is the
# node binary and ignores argv.
cat > "$WORK/bin/fakenode" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$DETECTOR_JSON"
exit "$DETECTOR_RC"
STUB
chmod +x "$WORK/bin/fakenode"

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
else
  cp "$body" "$PATCH_LOG"
  # Model the REAL server: `executionPolicy.monitor` is echoed back verbatim,
  # but the authoritative top-level `monitorNextCheckAt` column is a timestamp
  # rendered at millisecond precision. So a request for `...:41Z` reads back as
  # `...:41.000Z`. Echoing the request string instead would make this stub
  # agree with any string compare and hide the exact defect measured against
  # production on 2026-08-30 (TOG-718).
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
printf 200
STUB
chmod +x "$WORK/bin/curl"

FAILING_JSON='{"plugin":"paperclip-plugin-discord","windowHours":48,"jobs":[
 {"jobKey":"check-budget-thresholds","schedule":"*/5 * * * *","enabled":true,"runs":481,"succeeded":481,"scopeDenied":0,"otherFailures":0,"deliveryMetric":null,"sendOpportunities":0,"delivered":0,"verdict":"healthy","latestError":null},
 {"jobKey":"discord-daily-digest","schedule":"0 * * * *","enabled":true,"runs":40,"succeeded":39,"scopeDenied":1,"otherFailures":0,"deliveryMetric":"discord_digest_sent","sendOpportunities":2,"delivered":0,"verdict":"FAILING","latestError":"company context is required"}]}'

HEALTHY_JSON='{"plugin":"paperclip-plugin-discord","windowHours":48,"jobs":[
 {"jobKey":"discord-daily-digest","schedule":"0 * * * *","enabled":true,"runs":40,"succeeded":40,"scopeDenied":0,"otherFailures":0,"deliveryMetric":"discord_digest_sent","sendOpportunities":2,"delivered":2,"verdict":"healthy","latestError":null}]}'

run_case() {
  : > "$WORK/argv.log"; : > "$WORK/cfg.log"; : > "$WORK/requests.log"; : > "$WORK/patch.json"
  env -i PATH="$WORK/bin:$PATH" HOME="$WORK" TMPDIR="$WORK" \
    PAPERCLIP_API_URL="https://paperclip.invalid/api" \
    PAPERCLIP_API_KEY="pc_CANARY_monitor_key" \
    PAPERCLIP_TASK_ID="issue-monitor" \
    DISCORD_JOB_HEALTH_MONITOR_NOW="2026-08-30T00:00:00Z" \
    DISCORD_JOB_HEALTH_NODE="$WORK/bin/fakenode" \
    DISCORD_JOB_HEALTH_JS="$WORK/detector.js" \
    DETECTOR_JSON="$1" DETECTOR_RC="$2" \
    ARGV_LOG="$WORK/argv.log" CFG_LOG="$WORK/cfg.log" \
    REQUEST_LOG="$WORK/requests.log" PATCH_LOG="$WORK/patch.json" ISSUE_SRC="$WORK/issue.json" \
    MONITOR_STORED_NEXT_OVERRIDE="${MONITOR_STORED_NEXT_OVERRIDE:-}" \
    MONITOR_OMIT_STORED_COLUMN="${MONITOR_OMIT_STORED_COLUMN:-}" \
    "$TOOL" > "$WORK/out.txt" 2> "$WORK/err.txt"
  CASE_RC=$?
}
: > "$WORK/detector.js"

hdr "1. A failing job is reported and re-armed"
run_case "$FAILING_JSON" 1
[[ "$CASE_RC" -eq 1 ]] && ok "preserves detector exit 1 after a successful re-arm" || bad "expected exit 1, got $CASE_RC"
[[ "$(jq -r '.executionPolicy.monitor.nextCheckAt' "$WORK/patch.json")" == "2026-08-30T06:00:00Z" ]] \
  && ok "normal outcome re-arms exactly six hours later" || bad "normal interval was not six hours"
[[ "$(jq -r '.executionPolicy.mode' "$WORK/patch.json")" == normal ]] \
  && ok "preserves the existing execution policy outside .monitor" || bad "existing execution policy was replaced"
[[ "$(jq -r '.executionPolicy.monitor.serviceName' "$WORK/patch.json")" == "Discord scheduled-job delivery" ]] \
  && ok "stores a named monitor service" || bad "monitor service name missing"
comment="$(jq -r '.comment' "$WORK/patch.json")"
grep -qF '1 Discord scheduled job(s) are not delivering' <<<"$comment" && ok "comment names the broken job count" || bad "comment omitted the broken count"
grep -qF 'discord-daily-digest' <<<"$comment" && ok "comment names the failing job" || bad "comment omitted the failing job"
grep -qF '0 / 2 opportunities' <<<"$comment" && ok "comment reports delivery against send opportunities" || bad "comment omitted the delivery column"
grep -qF 'succeeded' <<<"$comment" && ok "comment warns a succeeded row is not a post" || bad "comment omitted the time-gate warning"
grep -qF 'until a vendor release lands' <<<"$comment" && ok "comment states the failure is the expected steady state" || bad "comment omitted the steady-state note"

hdr "2. A healthy measurement is allowed to say so"
run_case "$HEALTHY_JSON" 0
[[ "$CASE_RC" -eq 0 ]] && ok "preserves detector exit 0" || bad "expected exit 0, got $CASE_RC"
comment="$(jq -r '.comment' "$WORK/patch.json")"
grep -qF 'All Discord scheduled jobs healthy' <<<"$comment" && ok "healthy run reports healthy" || bad "healthy run did not report healthy"
grep -qF 'until a vendor release lands' <<<"$comment" && bad "healthy run wrongly carried the steady-state failure note" || ok "healthy run omits the steady-state failure note"

hdr "3. An unmeasurable detector is never scored clean"
run_case '' 5
[[ "$CASE_RC" -eq 5 ]] && ok "preserves the unmeasurable exit 5" || bad "expected exit 5, got $CASE_RC"
comment="$(jq -r '.comment' "$WORK/patch.json")"
grep -qF 'UNKNOWN' <<<"$comment" && ok "unmeasurable run says UNKNOWN" || bad "unmeasurable run did not say UNKNOWN"
# Assert on the affirmative claim, not the bare word: the UNKNOWN comment says
# "Nothing was scored healthy", which is a denial and must stay allowed.
grep -qF 'All Discord scheduled jobs healthy' <<<"$comment" \
  && bad "unmeasurable run made an affirmative healthy claim" \
  || ok "unmeasurable run never claims healthy"
grep -qF 'Nothing was scored healthy' <<<"$comment" \
  && ok "unmeasurable run explicitly denies a healthy result" \
  || bad "unmeasurable run omitted the explicit denial"
[[ "$(jq -r '.executionPolicy.monitor.nextCheckAt' "$WORK/patch.json")" == "2026-08-30T01:00:00Z" ]] \
  && ok "failure retries on the shorter one-hour interval" || bad "error retry was not one hour"

hdr "4. A zero exit with a garbage payload is a failure, not a pass"
run_case 'not json at all' 0
[[ "$CASE_RC" -eq 2 ]] && ok "garbage payload with exit 0 becomes exit 2" || bad "expected exit 2, got $CASE_RC"
comment="$(jq -r '.comment' "$WORK/patch.json")"
grep -qF 'UNKNOWN' <<<"$comment" && ok "garbage payload reports UNKNOWN" || bad "garbage payload did not report UNKNOWN"

hdr "5. A well-formed payload with no jobs is not a pass"
run_case '{"plugin":"paperclip-plugin-discord","jobs":[]}' 0
[[ "$CASE_RC" -eq 2 ]] && ok "empty job list is refused rather than scored clean" || bad "expected exit 2, got $CASE_RC"

hdr "6. The bearer token never reaches argv"
run_case "$FAILING_JSON" 1
grep -qF 'pc_CANARY_monitor_key' "$WORK/argv.log" && bad "bearer token appeared in curl argv" || ok "bearer token stays out of argv"
grep -qF 'pc_CANARY_monitor_key' "$WORK/cfg.log" && ok "bearer token travels in the curl config" || bad "bearer token was not in the curl config"

hdr "7. The monitor is re-armed even when the detector fails"
run_case '' 5
grep -q 'PATCH' "$WORK/requests.log" && ok "a failed measurement still issues the re-arm PATCH" || bad "no PATCH after a failed measurement"

# --- TOG-718: the arming verification itself, measured against production ----
# Case 1 above already proves the happy path survives the server's millisecond
# normalisation, because the stub now normalises. These cases pin the two ways
# the check can go wrong in the other direction.

hdr "8. A stored instant that differs only in precision is the same moment"
run_case "$FAILING_JSON" 1
[[ "$CASE_RC" -eq 1 ]] \
  && ok "millisecond-normalised readback preserves the detector verdict" \
  || bad "expected the detector's exit 1, got $CASE_RC (a string compare would give 2)"
grep -qF 'did not store' "$WORK/err.txt" \
  && bad "a correctly armed monitor was reported as unstored" \
  || ok "a correctly armed monitor reports no storage error"

hdr "9. A genuinely different stored instant is still caught"
MONITOR_STORED_NEXT_OVERRIDE="2026-08-30T09:00:00.000Z" run_case "$FAILING_JSON" 1
[[ "$CASE_RC" -eq 2 ]] \
  && ok "a wrong stored instant fails the run" || bad "expected exit 2 for a wrong instant, got $CASE_RC"

hdr "10. An absent monitorNextCheckAt column is never satisfied by the echoed policy"
MONITOR_OMIT_STORED_COLUMN=1 run_case "$FAILING_JSON" 1
[[ "$CASE_RC" -eq 2 ]] \
  && ok "the nested executionPolicy echo cannot stand in for the column" \
  || bad "expected exit 2 when the column is missing, got $CASE_RC (the nested fallback fails open)"

# --- TOG-720: the re-arm must not overwrite the card's own warning ----------
# The notes this wrapper PATCHes replace the card's monitorNotes every cycle.
# The heartbeat operator reads that field to decide how to invoke the monitor.
# Telling them to run the bare `./discord_job_health_monitor.sh` is the one
# instruction that is known to exit 127 in the shared workspace -- and a cycle
# that exits 127 never re-arms, so the clock stops permanently and silently.
# The wrapper must therefore write back guidance that still routes through
# `git show origin/main:`.

hdr "11. The re-arm never tells the next operator to run the bare command"
run_case "$FAILING_JSON" 1
notes="$(jq -r '.executionPolicy.monitor.notes' "$WORK/patch.json")"
grep -qE '(^|[^-])Run \./discord_job_health_monitor\.sh' <<<"$notes" \
  && bad "re-arm notes instruct the bare invocation that exits 127 and stops the clock" \
  || ok "re-arm notes never instruct the bare invocation"
grep -qF 'card description' <<<"$notes" \
  && ok "re-arm notes route the operator to the card description that holds the command" \
  || bad "re-arm notes omit the pointer to the recorded command"
grep -qF 'git-show' <<<"$notes" \
  && ok "re-arm notes name the git-show mechanism" \
  || bad "re-arm notes omit the git-show mechanism"

hdr "12. The re-arm notes fit the 500-char monitorNotes cap"
# Over the cap the server 400s the WHOLE arming PATCH: nextCheckAt never lands
# either, so an over-long notes string silently leaves this card unarmed.
notes="$(jq -r '.executionPolicy.monitor.notes' "$WORK/patch.json")"
[[ "${#notes}" -le 500 ]] \
  && ok "re-arm notes are ${#notes} chars, within the 500-char cap" \
  || bad "re-arm notes are ${#notes} chars, over the 500-char cap: the whole arming PATCH would 400"
[[ "${#notes}" -gt 0 ]] && ok "re-arm notes are non-empty" || bad "re-arm notes are empty"

hdr "13. The re-arm still carries the two standing facts"
notes="$(jq -r '.executionPolicy.monitor.notes' "$WORK/patch.json")"
grep -qF 'discord_digest_sent' <<<"$notes" \
  && ok "re-arm notes keep the delivery-metric fact" || bad "re-arm notes dropped the delivery-metric fact"
grep -qiF 'expected' <<<"$notes" \
  && ok "re-arm notes keep the expected-steady-state fact" || bad "re-arm notes dropped the steady-state fact"

# --- TOG-3775: a standing monitor must not grow until wakes hit E2BIG --------
# Counts naturally slide inside the 48h window; they are evidence in a posted
# verdict, but not a reason to add another verdict. The notes carry a short hash
# of the qualitative state so unchanged cycles can re-arm without commenting.

hdr "14. Unchanged state re-arms without another comment"
run_case "$FAILING_JSON" 1
jq --slurpfile patch "$WORK/patch.json" \
  '.executionPolicy = $patch[0].executionPolicy' \
  "$WORK/issue.json" > "$WORK/issue.next.json"
mv "$WORK/issue.next.json" "$WORK/issue.json"
shifted_json="$(jq -c '.jobs[0].runs = 500 | .jobs[0].succeeded = 500 | .jobs[1].runs = 41' <<<"$FAILING_JSON")"
run_case "$shifted_json" 1
jq -e 'has("comment") | not' "$WORK/patch.json" >/dev/null \
  && ok "sliding run counts do not append a duplicate status comment" \
  || bad "unchanged verdict appended another status comment"
grep -qF 'comment=no' "$WORK/out.txt" \
  && ok "stdout reports that the unchanged comment was suppressed" \
  || bad "stdout did not report comment suppression"
[[ "$(jq -r '.executionPolicy.monitor.nextCheckAt' "$WORK/patch.json")" == "2026-08-30T06:00:00Z" ]] \
  && ok "suppressed-comment cycle still re-arms the monitor" \
  || bad "suppressed-comment cycle did not re-arm"

hdr "15. A qualitative state change posts a fresh verdict"
changed_json="$(jq -c '.jobs[1].latestError = "different failure class"' <<<"$FAILING_JSON")"
run_case "$changed_json" 1
jq -e 'has("comment") and (.comment | contains("Discord scheduled-job delivery monitor"))' "$WORK/patch.json" >/dev/null \
  && ok "changed error signature posts a new status comment" \
  || bad "changed error signature was silently suppressed"
grep -qF 'comment=yes' "$WORK/out.txt" \
  && ok "stdout reports that the changed comment was posted" \
  || bad "stdout did not report the changed comment"

printf '\npassed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
