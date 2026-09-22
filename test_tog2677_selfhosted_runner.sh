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
mutate wrong-label 'runs-on: [self-hosted, isolated]' 'runs-on: [self-hosted, other-runner]'
expect_fail wrong-label "$MUTANT_FILE"
mutate paid-fallback 'runs-on: [self-hosted, isolated]' 'runs-on: ubuntu-latest'
expect_fail paid-fallback "$MUTANT_FILE"
# TOG-3051. The label now carries the isolation property: isolated runners
# have no DOCKER_HOST in their .env, two-selfhosted ones do. Quietly moving a job
# back onto the Docker pool would hand it the host socket again, which is exactly
# what TOG-2677 forbids, so that must turn this job red.
mutate docker-creep 'runs-on: [self-hosted, isolated]' 'runs-on: [self-hosted, two-selfhosted]'
expect_fail docker-creep "$MUTANT_FILE"
# A service container is the quiet way back to needing a daemon: adding one would
# re-create the hole that privilege-suites' ephemeral PostgreSQL cluster closed,
# without any runs-on line changing. That must turn this job red too.
mutate service-container-creep '    timeout-minutes: 20' '    services:
      db:
        image: postgres:16
    timeout-minutes: 20'
expect_fail service-container-creep "$MUTANT_FILE"
mutate no-positive-control '[[ "${RUNNER_NAME:-}" == coolify-vps-* ]]' 'true # runner identity proof deleted'
expect_fail no-positive-control "$MUTANT_FILE"
mutate dirty-checkout 'clean: true' 'clean: false'
expect_fail dirty-checkout "$MUTANT_FILE"
mutate renamed-check 'name: Offline suites' 'name: Offline tests'
expect_fail renamed-check "$MUTANT_FILE"

printf '%s passed, %s failed\n' "$pass" "$fail"
(( fail == 0 ))
