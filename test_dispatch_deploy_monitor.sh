#!/usr/bin/env bash
# Regression suite for the TOG-2307 dispatch-src drift monitor wrapper.
#
# The wrapper's load-bearing properties are that drift or a refusal never
# becomes a healthy claim, and that every outcome re-arms a native Paperclip
# issue monitor. Offline: dispatch_deploy.sh and curl are recording stubs,
# and the clock is fixed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${DISPATCH_DEPLOY_MONITOR_SH:-$HERE/scripts/dispatch_deploy_monitor.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -x "$TOOL" ]] || { echo "ERROR: $TOOL is not executable" >&2; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_dispatch_deploy_monitor.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat > "$WORK/issue.json" <<'EOF'
{
  "id":"issue-monitor",
  "identifier":"TOG-2307",
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

# The status stub stands in for ./dispatch_deploy.sh status.
cat > "$WORK/bin/fakedispatch" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STATUS_ARGV_LOG"
printf '%s\n' "$STATUS_OUTPUT"
exit "$STATUS_RC"
STUB
chmod +x "$WORK/bin/fakedispatch"

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
  printf "${GET_HTTP_STATUS:-${CURL_HTTP_STATUS:-200}}"
else
  cp "$body" "$PATCH_LOG"
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
  printf "${PATCH_HTTP_STATUS:-${CURL_HTTP_STATUS:-200}}"
fi
STUB
chmod +x "$WORK/bin/curl"

NO_DRIFT_OUTPUT='record:          /fake/dispatch-src.deployment.json
recorded current: 7a2de4cf0519ea8602ec11bad80c6f7eb860edb8
live HEAD:        7a2de4cf0519ea8602ec11bad80c6f7eb860edb8
OK: live HEAD, recorded state, and anchor refs agree'

DRIFT_OUTPUT='record:          /fake/dispatch-src.deployment.json
recorded current: 7a2de4cf0519ea8602ec11bad80c6f7eb860edb8
live HEAD:        e0ed21e3af4380954f7d4cc70eed83614ae5ac3c
DRIFT: live HEAD does not match the recorded deployedSha (stray checkout, pin itself is still reachable)'

REFUSED_OUTPUT='REFUSED: no deployment record at /fake/dispatch-src.deployment.json'

run_case() {
  : > "$WORK/argv.log"; : > "$WORK/cfg.log"; : > "$WORK/requests.log"
  : > "$WORK/patch.json"; : > "$WORK/status-argv.log"
  env -i PATH="$WORK/bin:$PATH" HOME="$WORK" TMPDIR="$WORK" \
    PAPERCLIP_API_URL="https://paperclip.invalid/api" \
    PAPERCLIP_API_KEY="pc_CANARY_dispatch_monitor_key" \
    PAPERCLIP_TASK_ID="issue-monitor" \
    DISPATCH_DEPLOY_MONITOR_NOW="2026-09-12T20:00:00Z" \
    DISPATCH_DEPLOY_SH="$WORK/bin/fakedispatch" \
    STATUS_OUTPUT="$1" STATUS_RC="$2" \
    ARGV_LOG="$WORK/argv.log" CFG_LOG="$WORK/cfg.log" \
    REQUEST_LOG="$WORK/requests.log" PATCH_LOG="$WORK/patch.json" \
    STATUS_ARGV_LOG="$WORK/status-argv.log" ISSUE_SRC="$WORK/issue.json" \
    CURL_HTTP_STATUS="${CURL_HTTP_STATUS:-200}" \
    GET_HTTP_STATUS="${GET_HTTP_STATUS:-}" PATCH_HTTP_STATUS="${PATCH_HTTP_STATUS:-}" \
    MONITOR_STORED_NEXT_OVERRIDE="${MONITOR_STORED_NEXT_OVERRIDE:-}" \
    MONITOR_OMIT_STORED_COLUMN="${MONITOR_OMIT_STORED_COLUMN:-}" \
    "$TOOL" > "$WORK/out.txt" 2> "$WORK/err.txt"
  CASE_RC=$?
}

next_at() { jq -r '.executionPolicy.monitor.nextCheckAt' "$WORK/patch.json"; }
comment()  { jq -r '.comment' "$WORK/patch.json"; }

hdr "1. No drift is reported and re-armed on the normal interval"
run_case "$NO_DRIFT_OUTPUT" 0
[[ "$CASE_RC" -eq 0 ]] && ok "preserves status exit 0" || bad "expected exit 0, got $CASE_RC"
[[ "$(next_at)" == "2026-09-13T20:00:00Z" ]] \
  && ok "a clean cycle re-checks in the normal 24h" || bad "normal interval was $(next_at)"
comment | grep -q "No drift" && ok "reports the clean verdict" || bad "clean verdict not reported"

hdr "2. Drift is reported and re-armed on the short retry"
run_case "$DRIFT_OUTPUT" 1
[[ "$CASE_RC" -eq 1 ]] && ok "preserves status exit 1" || bad "expected exit 1, got $CASE_RC"
[[ "$(next_at)" == "2026-09-12T22:00:00Z" ]] \
  && ok "drift re-checks in the shorter 2h" || bad "drift interval was $(next_at)"
comment | grep -q "DRIFT DETECTED" && ok "leads with the drift finding" || bad "comment did not announce drift"
comment | grep -qi "stray checkout" && ok "carries the recoverable stray-checkout guidance" || bad "missing stray-checkout note"

hdr "3. A refusal is never scored clean"
run_case "$REFUSED_OUTPUT" 2
[[ "$CASE_RC" -eq 2 ]] && ok "preserves status exit 2" || bad "expected exit 2, got $CASE_RC"
[[ "$(next_at)" == "2026-09-12T22:00:00Z" ]] \
  && ok "a refusal retries on the shorter 2h interval" || bad "refusal interval was $(next_at)"
comment | grep -q "REFUSED" && ok "reports the refusal verdict" || bad "refusal not reported"
comment | grep -qi "unrecoverable" && ok "flags the refusal as the unrecoverable case" || bad "missing unrecoverable note"

hdr "4. An undocumented exit code is treated as refused, not as a pass"
run_case "$NO_DRIFT_OUTPUT" 7
[[ "$CASE_RC" -eq 2 ]] && ok "exit 7 is normalised to 2, never to 0" || bad "expected exit 2, got $CASE_RC"

hdr "5. The monitor is armed against the authoritative column, not our own echo"
MONITOR_OMIT_STORED_COLUMN=1 run_case "$NO_DRIFT_OUTPUT" 0
[[ "$CASE_RC" -eq 2 ]] \
  && ok "a 200 that stores no monitorNextCheckAt column is a failed re-arm" \
  || bad "an unarmed issue scored $CASE_RC"
unset MONITOR_OMIT_STORED_COLUMN
grep -qi "stored no monitorNextCheckAt" "$WORK/err.txt" \
  && ok "says which column was missing" || bad "unhelpful failed-re-arm error"

MONITOR_STORED_NEXT_OVERRIDE="2026-09-13T23:30:00.000Z" run_case "$NO_DRIFT_OUTPUT" 0
[[ "$CASE_RC" -eq 2 ]] \
  && ok "a column storing a DIFFERENT instant is a failed re-arm" \
  || bad "a wrong stored instant scored $CASE_RC"
unset MONITOR_STORED_NEXT_OVERRIDE

hdr "6. Millisecond normalisation is not mistaken for a failed write"
run_case "$DRIFT_OUTPUT" 1
[[ "$CASE_RC" -eq 1 ]] \
  && ok "millisecond-normalised readback is accepted as the same instant" \
  || bad "ms normalisation was scored a failure ($CASE_RC)"

hdr "7. Paperclip failures are exit 2 and never a health claim"
GET_HTTP_STATUS=500 run_case "$NO_DRIFT_OUTPUT" 0
[[ "$CASE_RC" -eq 2 ]] && ok "an HTTP 500 on the issue read is exit 2" || bad "HTTP 500 on GET scored $CASE_RC"
unset GET_HTTP_STATUS

PATCH_HTTP_STATUS=500 run_case "$NO_DRIFT_OUTPUT" 0
[[ "$CASE_RC" -eq 2 ]] && ok "an HTTP 500 on the monitor re-arm is exit 2" || bad "HTTP 500 on PATCH scored $CASE_RC"
unset PATCH_HTTP_STATUS

hdr "8. The bearer token never reaches argv"
run_case "$DRIFT_OUTPUT" 1
grep -q "pc_CANARY_dispatch_monitor_key" "$WORK/argv.log" \
  && bad "the API key appeared in curl argv" || ok "the API key never appears in curl argv"
grep -q "pc_CANARY_dispatch_monitor_key" "$WORK/cfg.log" \
  && ok "the key travels in the curl config file instead" || bad "the key was not in the config file"

hdr "9. The existing execution policy is preserved, not replaced"
run_case "$DRIFT_OUTPUT" 1
[[ "$(jq -r '.executionPolicy.mode' "$WORK/patch.json")" == "normal" ]] \
  && ok "keeps sibling executionPolicy keys" || bad "clobbered the execution policy"
[[ "$(jq -r '.executionPolicy.monitor.kind' "$WORK/patch.json")" == "external_service" ]] \
  && ok "uses the only accepted monitor kind enum" || bad "monitor kind is not external_service"

echo
echo "-----------------------------------------------------------------"
if [[ "$FAIL" -eq 0 ]]; then
  echo "PASS  $PASS/$PASS"
  exit 0
fi
echo "FAIL  $FAIL failed, $PASS passed"
exit 1
