#!/usr/bin/env bash
# Fixture test for tog752_predispatch_deploy_gate.sh.
#
# Three cases, matching the gate's own doc comment:
#   A no validator markers at all            -> PASS  (exit 0)
#   B validator markers, fix marker absent   -> FAIL  (exit 3)
#   C validator markers, fix marker present  -> PASS  (exit 0)
# Plus a REFUSED case: no positive-control marker anywhere, which must not
# read as A (a broken grep and a genuinely clean deploy must not look alike).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/tog752_predispatch_deploy_gate.sh"
fail=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

check() {
  local name="$1" dir="$2" want="$3" got
  "$GATE" check --target "$dir" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$want" ]; then
    printf 'ok    %s (exit %s)\n' "$name" "$got"
  else
    printf 'FAIL  %s: expected exit %s, got %s\n' "$name" "$want" "$got"
    fail=1
  fi
}

# Case A: nothing deployed there but ordinary server code with the positive
# control markers present.
mkdir -p "$WORK/caseA"
cat > "$WORK/caseA/other.js" <<'EOF'
function wakeOpts() {}
function requestWakeup() {}
EOF
check "case A: no validator deployed" "$WORK/caseA" 0

# Case B: validator markers present, fix marker absent -- the ordering
# violation this gate exists to catch.
mkdir -p "$WORK/caseB"
cat > "$WORK/caseB/validator.js" <<'EOF'
function collectPreDispatchCallSiteCoverage() {}
function wakeOpts() {}
EOF
check "case B: validator deployed WITHOUT fix" "$WORK/caseB" 3

# Case C: validator markers present, fix marker present.
mkdir -p "$WORK/caseC"
cat > "$WORK/caseC/validator.js" <<'EOF'
function collectPreDispatchCallSiteCoverage() { invalidatesSeamProperty(); }
function invalidatesSeamProperty() {}
function wakeOpts() {}
EOF
check "case C: validator deployed WITH fix" "$WORK/caseC" 0

# Refused: no positive-control marker anywhere -- must not silently read as
# case A. A grep that cannot prove it works must not report a pass.
mkdir -p "$WORK/caseRefuse"
echo "unrelated content" > "$WORK/caseRefuse/other.js"
check "refused: no positive control" "$WORK/caseRefuse" 2

# Refused: target does not exist at all.
check "refused: missing target dir" "$WORK/does-not-exist" 2

if [ "$fail" -eq 0 ]; then
  printf '\nall cases passed\n'
else
  printf '\nSOME CASES FAILED\n' >&2
fi
exit $fail
