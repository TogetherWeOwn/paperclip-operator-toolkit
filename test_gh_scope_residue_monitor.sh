#!/usr/bin/env bash
# Regression suite for the TOG-398 scheduled monitor wrapper.
#
# The wrapper's two load-bearing properties are that a text-only zero never
# becomes a clean claim, and that every outcome re-arms a native Paperclip issue
# monitor. Offline: detector and curl are recording stubs, and the clock is fixed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${GH_SCOPE_RESIDUE_MONITOR_SH:-$HERE/gh_scope_residue_monitor.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }
plain() { sed -e 's/\x1b\[[0-9;]*m//g' "$1"; }

[[ -x "$TOOL" ]] || { echo "ERROR: $TOOL is not executable" >&2; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_scope_residue_monitor.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat > "$WORK/issue.json" <<'EOF'
{
  "id":"issue-monitor",
  "identifier":"TOG-398",
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

cat > "$WORK/detector" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$DETECTOR_JSON"
exit "$DETECTOR_RC"
STUB
chmod +x "$WORK/detector"

# curl reads the config path, records request bodies, and returns the issue or a
# patched issue. The response includes the exact nextCheckAt from the PATCH so
# the wrapper's post-write verification exercises a real returned artifact.
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
  jq --slurpfile p "$body" '. + {executionPolicy:$p[0].executionPolicy, monitorNextCheckAt:$p[0].executionPolicy.monitor.nextCheckAt}' \
    "$ISSUE_SRC" > "$out"
fi
printf 200
STUB
chmod +x "$WORK/bin/curl"

run_case() {
  : > "$WORK/argv.log"; : > "$WORK/cfg.log"; : > "$WORK/requests.log"; : > "$WORK/patch.json"
  env -i PATH="$WORK/bin:$PATH" HOME="$WORK" TMPDIR="$WORK" \
    PAPERCLIP_API_URL="https://paperclip.invalid/api" \
    PAPERCLIP_API_KEY="pc_CANARY_monitor_key" \
    PAPERCLIP_TASK_ID="issue-monitor" \
    SCOPE_RESIDUE_MONITOR_NOW="2026-08-27T00:00:00Z" \
    GH_SCOPE_RESIDUE_SH="$WORK/detector" \
    DETECTOR_JSON="$1" DETECTOR_RC="$2" \
    ARGV_LOG="$WORK/argv.log" CFG_LOG="$WORK/cfg.log" \
    REQUEST_LOG="$WORK/requests.log" PATCH_LOG="$WORK/patch.json" ISSUE_SRC="$WORK/issue.json" \
    "$TOOL" > "$WORK/out.txt" 2> "$WORK/err.txt"
  CASE_RC=$?
}

hdr "Known residue is reported and re-armed"
run_case '{"residue":[{"issue":427,"status":"todo","repo":"two-bot","project":"Community Platform","projectId":"p","via":"named"}],"count":1,"branchesChecked":false,"coverage":"partial","reposChecked":0,"reposTotal":0}' 1

[[ "$CASE_RC" -eq 1 ]] && ok "preserves detector exit 1 after a successful re-arm" || bad "expected exit 1, got $CASE_RC"
[[ "$(jq -r '.executionPolicy.monitor.nextCheckAt' "$WORK/patch.json")" == "2026-08-27T06:00:00Z" ]] \
  && ok "normal outcome re-arms exactly six hours later" || bad "normal interval was not six hours"
[[ "$(jq -r '.executionPolicy.mode' "$WORK/patch.json")" == normal ]] \
  && ok "preserves the existing execution policy outside .monitor" || bad "existing execution policy was replaced"
[[ "$(jq -r '.executionPolicy.monitor.serviceName' "$WORK/patch.json")" == "Paperclip project-less GitHub scope residue" ]] \
  && ok "stores a named monitor service" || bad "monitor service name missing"
comment="$(jq -r '.comment' "$WORK/patch.json")"
grep -qF '1 open project-less issue(s)' <<<"$comment" && ok "comment names the measured residue count" || bad "comment omitted residue count"
grep -qF 'floor, not proof' <<<"$comment" && ok "comment states the detector is a floor" || bad "comment overstated the detector"
grep -qF 'TOG-427' <<<"$comment" && ok "comment names the issue to repair" || bad "comment omitted the residue row"

hdr "A text-only zero is inconclusive, never clean"
run_case '{"residue":[],"count":0,"branchesChecked":false,"coverage":"partial","reposChecked":0,"reposTotal":0}' 3

[[ "$CASE_RC" -eq 3 ]] && ok "preserves inconclusive exit 3" || bad "expected exit 3, got $CASE_RC"
comment="$(jq -r '.comment' "$WORK/patch.json")"
grep -qF 'Inconclusive' <<<"$comment" && ok "zero is labelled inconclusive" || bad "zero was not labelled inconclusive"
grep -qF 'not a clean-board proof' <<<"$comment" && ok "zero explicitly refuses a clean-board claim" || bad "zero reads as proof"
if grep -qiE 'gate passed|board is clean|no .* needs a repo' <<<"$comment"; then bad "zero comment contains a clean claim"; else ok "zero comment contains no clean claim"; fi

hdr "A detector failure retries sooner and never reads clean"
run_case '' 2

[[ "$CASE_RC" -eq 2 ]] && ok "detector failure exits 2 after re-arm" || bad "expected exit 2, got $CASE_RC"
[[ "$(jq -r '.executionPolicy.monitor.nextCheckAt' "$WORK/patch.json")" == "2026-08-27T01:00:00Z" ]] \
  && ok "failure retries exactly one hour later" || bad "error retry interval was not one hour"
comment="$(jq -r '.comment' "$WORK/patch.json")"
grep -qF 'UNKNOWN' <<<"$comment" && ok "failure is labelled unknown" || bad "failure was not labelled unknown"
grep -qF 'Nothing was scored clean' <<<"$comment" && ok "failure refuses a clean claim" || bad "failure could be read as clean"

hdr "The Paperclip credential stays out of argv"
CANARY='pc_CANARY_monitor_key'
if grep -qF "$CANARY" "$WORK/argv.log"; then bad "PAPERCLIP_API_KEY leaked into curl argv"; else ok "PAPERCLIP_API_KEY absent from curl argv"; fi
grep -qF "Authorization: Bearer $CANARY" "$WORK/cfg.log" \
  && ok "PAPERCLIP_API_KEY reached curl through its config" || bad "positive auth control failed"
grep -qF -- '--config' "$WORK/argv.log" && ok "only the config path appears in curl argv" || bad "curl was not invoked through --config"

hdr "Malformed inputs fail before a misleading update"
run_case '{"count":0,"residue":"not-an-array","coverage":"partial"}' 3
[[ "$CASE_RC" -eq 2 ]] && ok "malformed detector JSON exits 2" || bad "malformed detector JSON returned $CASE_RC"
[[ "$(jq -r '.executionPolicy.monitor.nextCheckAt' "$WORK/patch.json")" == "2026-08-27T01:00:00Z" ]] \
  && ok "malformed output takes the shorter error retry" || bad "malformed output used the normal interval"

printf '\n\033[1mtotal\033[0m  %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
