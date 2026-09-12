#!/usr/bin/env bash
# Hermetic regression suite for TOG-825's running-server gate.
# No systemd and no host config: journalctl is a recording stub, while each
# config points at a temporary executable named capability_gate.sh.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${TOG825_VERIFY_SH:-$HERE/mcp/deploy/TOG-825-verify.sh}"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

[[ -x "$TOOL" ]] || { echo "ERROR: $TOOL is not executable" >&2; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: python3 is required" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_tog825_verify_g4.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat > "$WORK/bin/journalctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$JOURNAL_FIXTURE"
STUB
chmod +x "$WORK/bin/journalctl"

cat > "$WORK/capability_gate.sh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$WORK/capability_gate.sh"

python3 - "$WORK/config.json" "$WORK/capability_gate.sh" <<'PY'
import json,sys
with open(sys.argv[1], "w") as f:
    json.dump({"capabilityScript": sys.argv[2]}, f)
PY

run_case() {
  OUT="$(env -i PATH="$WORK/bin:$PATH" HOME="$WORK" \
    ORG_MCP_CONFIG="$WORK/config.json" ORG_MCP_UNIT="org-request-mcp.service" \
    JOURNAL_FIXTURE="$1" "$TOOL" "$2" 2>&1)"
  RC=$?
}

want() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then ok "$label"
  else bad "$label" "expected '$expected', got '$actual'"; fi
}

want_in() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then ok "$label"
  else bad "$label" "expected output to contain '$expected'; got: $actual"; fi
}

FULL_TOOLS='{"ts":"2026-09-12T06:09:43.299Z","event":"listening","tools":["submit_provisioning_request","review_provisioning_request","read_my_requests","submit_capability_request","review_capability_request","countersign_capability_request"]}'
QUEUE_TOOLS='{"event":"listening","tools":["submit_provisioning_request","review_provisioning_request","read_my_requests"]}'

printf '== 1. The production tools-array event is visible ==\n'
run_case "$FULL_TOOLS" --post
want "all three capability tools pass post" 0 "$RC"
want_in "post names the advertised running surface" "G4 running server advertises" "$OUT"

run_case "$FULL_TOOLS" --pre
want "the same live surface stops a stale pre-runbook" 1 "$RC"
want_in "pre says the premise changed" "premise has changed" "$OUT"

printf '\n== 2. Queue-only and legacy events retain their verdicts ==\n'
run_case "$QUEUE_TOOLS" --pre
want "queue-only tools pass pre" 0 "$RC"
run_case "$QUEUE_TOOLS" --post
want "queue-only tools fail post" 1 "$RC"

run_case '{"event":"listening","capabilityToolsAdvertised":true}' --post
want "legacy true passes post" 0 "$RC"
run_case '{"event":"listening","capabilityToolsAdvertised":false}' --pre
want "legacy false passes pre" 0 "$RC"

printf '\n== 3. Ambiguous evidence never passes ==\n'
run_case 'not json at all' --post
want "no usable listening event is unknown" 2 "$RC"
want_in "unknown evidence is not presented as a pass" "RESULT: UNKNOWN" "$OUT"

run_case 'not json at all' --pre
want "missing evidence makes pre unknown too" 2 "$RC"
want_in "pre does not infer the running state from config" "RESULT: UNKNOWN" "$OUT"

run_case '{"event":"listening","tools":["submit_capability_request"]}' --post
want "a partial capability tool list fails" 1 "$RC"
want_in "partial list is reported inconsistent" "internally inconsistent" "$OUT"

run_case '{"event":"listening","tools":["submit_capability_request","review_capability_request","countersign_capability_request"],"capabilityToolsAdvertised":false}' --post
want "a boolean disagreeing with the tools array fails" 1 "$RC"
want_in "the disagreement is explicit" "disagrees" "$OUT"

run_case $'{"event":"listening","tools":[]}\nMar 12 host service[1]: {"event":"listening","tools":["submit_capability_request","review_capability_request","countersign_capability_request"]}' --post
want "the newest structured listening event wins" 0 "$RC"

printf '\nTOTAL %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
