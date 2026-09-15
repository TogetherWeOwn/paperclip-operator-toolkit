#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
GATE="$ROOT/verification/tog-2677-selfhosted-runner-gate.sh"
WORKFLOW="$ROOT/.github/workflows/ci.yml"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
expect_pass() {
  local name=$1 file=$2
  if "$GATE" "$file" >"$TMP/out" 2>&1; then
    printf 'ok - %s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'not ok - %s\n' "$name"
    cat "$TMP/out"
    fail=$((fail + 1))
  fi
}
expect_fail() {
  local name=$1 file=$2
  if "$GATE" "$file" >"$TMP/out" 2>&1; then
    printf 'not ok - %s (mutant survived)\n' "$name"
    cat "$TMP/out"
    fail=$((fail + 1))
  else
    printf 'ok - %s\n' "$name"
    pass=$((pass + 1))
  fi
}
mutate() {
  local name=$1 old=$2 new=$3
  MUTANT_FILE="$TMP/$name.yml"
  python3 - "$WORKFLOW" "$MUTANT_FILE" "$old" "$new" <<'PY'
from pathlib import Path
import sys

src, dst, old, new = sys.argv[1:]
text = Path(src).read_text()
if old not in text:
    raise SystemExit(f"mutation anchor absent: {old!r}")
mutant = text.replace(old, new, 1)
if mutant == text:
    raise SystemExit("mutation did not change the workflow")
Path(dst).write_text(mutant)
PY
}

expect_pass baseline "$WORKFLOW"
mutate wrong-label 'runs-on: [self-hosted, two-selfhosted]' 'runs-on: [self-hosted, other-runner]'
expect_fail wrong-label "$MUTANT_FILE"
mutate paid-fallback 'runs-on: [self-hosted, two-selfhosted]' 'runs-on: ubuntu-latest'
expect_fail paid-fallback "$MUTANT_FILE"
mutate no-positive-control '[[ "${RUNNER_NAME:-}" == coolify-vps-* ]]' 'true # runner identity proof deleted'
expect_fail no-positive-control "$MUTANT_FILE"
mutate dirty-checkout 'clean: true' 'clean: false'
expect_fail dirty-checkout "$MUTANT_FILE"
mutate renamed-check 'name: Offline suites' 'name: Offline tests'
expect_fail renamed-check "$MUTANT_FILE"

printf '%s passed, %s failed\n' "$pass" "$fail"
(( fail == 0 ))
