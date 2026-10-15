#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE=test_pr_hygiene_land82_acceptance
SCRATCH_ROOT="${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_SCRATCH_DIR:-${TMPDIR:-/tmp}}}"
STAGE="$(mktemp -d "${SCRATCH_ROOT%/}/pr-hygiene-land82.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

cp "$ROOT/pr_hygiene_sweep.py" "$STAGE/"
cp "$ROOT/$SUITE.py" "$STAGE/"
cp "$STAGE/pr_hygiene_sweep.py" "$STAGE/pr_hygiene_sweep.baseline.py"

run_test() {
  (cd "$STAGE" && python3 -m unittest "$SUITE.SweepAcceptance.$1")
}

mutate_once() {
  python3 - "$STAGE/pr_hygiene_sweep.py" "$1" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
mutants = {
    "zero-on-fault": (
        'return 1 if RUN["faults"] else 0',
        'return 0',
    ),
    "org-404-log-only": (
        'fault(f"org repo list page {page} failed: HTTP 404")',
        'log(f"org repo list page {page} failed: HTTP 404")',
    ),
    "agent-pipe-split": (
        'head, has_edge = row.rsplit("|", 1)',
        'head, has_edge = row.split("|", 1)',
    ),
    "nameless-check-index": (
        'and c.get("name")',
        '',
    ),
    "null-head-repo": (
        'head_repo = (d["head"].get("repo") or {}).get("full_name")',
        'head_repo = d["head"].get("repo").get("full_name")',
    ),
}
old, new = mutants[sys.argv[2]]
if source.count(old) != 1:
    raise SystemExit(f"expected one mutation anchor for {sys.argv[2]}, found {source.count(old)}")
path.write_text(source.replace(old, new, 1))
PY
}

(cd "$STAGE" && python3 -m unittest "$SUITE")

check_mutant() {
  local name="$1" test_name="$2"
  cp "$STAGE/pr_hygiene_sweep.baseline.py" "$STAGE/pr_hygiene_sweep.py"
  mutate_once "$name"
  if run_test "$test_name" >/dev/null 2>&1; then
    printf 'FAIL: mutant survived: %s\n' "$name" >&2
    exit 1
  fi
  printf 'PASS: %s\n' "$name"
}

check_mutant zero-on-fault test_org_listing_404_is_counted_and_exits_one
check_mutant org-404-log-only test_org_listing_404_is_counted_and_exits_one
check_mutant agent-pipe-split test_agent_name_with_pipe_is_preserved_without_crash
check_mutant nameless-check-index test_nameless_failing_check_run_does_not_crash
check_mutant null-head-repo test_null_head_repo_does_not_crash_when_work_product_matches

printf 'PASS: 5 fault-visibility/crash mutants detected\n'
