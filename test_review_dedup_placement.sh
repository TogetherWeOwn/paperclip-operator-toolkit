#!/usr/bin/env bash
# Repo-placement acceptance test for Land #943 (TOG-24553).
#
# THE RISK THIS EXISTS FOR. PR TogetherWeOwn/paperclip-ops-tooling#943 adds
# the same-head review idempotency guard (stdlib-only, no network, no DB) in
# ops/productivity/, and the repo-placement gate answers FAILING with
# "public code belongs in TogetherWeOwn/paperclip-operator-toolkit" -- i.e.
# this repo. Until the guard is mirrored here, the landing is not complete:
# the private repo carries public code the gate refuses.
#
# What this pins, hermetically (no network, no credential):
#   1. the guard exists at this repo's root as review_dedup.py;
#   2. it is stdlib-only, so it is importable from every consumer runtime;
#   3. it exposes the idempotency API the behavioral suite
#      (test_review_dedup.py) exercises.
#
# RED (before the fix): assertion 1 fails -- the file is absent, which IS the
# placement risk reproduced. GREEN (after): all pass. The Builder adds
# review_dedup.py on this branch without touching test files.
# Exit 0 all green, 1 anything red. Requires bash, python3.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/review_dedup.py"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# assert <status> <label> [diagnostic]
# ONE label per assertion, printed identically whether it passes or fails.
assert() {
  local status="$1" label="$2" diag="${3:-}"
  if [[ "$status" -eq 0 ]]; then ok "$label"; else
    bad "$label"
    [[ -n "$diag" ]] && printf '        %s\n' "$diag"
  fi
  return 0
}

command -v python3 >/dev/null 2>&1 || { echo "test_review_dedup_placement: python3 is required" >&2; exit 2; }

hdr "Repo-placement: the public guard lives in the public repo"

[[ -f "$GUARD" ]]
assert $? "the same-head idempotency guard is mirrored at review_dedup.py in TogetherWeOwn/paperclip-operator-toolkit" \
  "review_dedup.py absent -- placement risk reproduced (private repo carries public code)"

if [[ -f "$GUARD" ]]; then
  # Stdlib-only: every top-level import must resolve to the standard library,
  # so CI gates, reconcilers and sweeper jobs can all import the one file.
  python3 - "$GUARD" <<'PY'
import ast, sys
path = sys.argv[1]
tree = ast.parse(open(path).read())
stdlib = sys.stdlib_module_names
third = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for a in node.names:
            third.add(a.name.split('.')[0])
    elif isinstance(node, ast.ImportFrom):
        if node.level == 0 and node.module:
            third.add(node.module.split('.')[0])
bad = sorted(m for m in third if m not in stdlib)
if bad:
    print('third-party imports: %s' % ', '.join(bad))
    sys.exit(1)
PY
  assert $? "the mirrored guard imports stdlib only" \
    "a third-party import strands every consumer runtime that only has stdlib"

  for sym in idempotency_key check_run_suppresses head_decision; do
    grep -qE "^def $sym\(" "$GUARD"
    assert $? "the mirrored guard exposes $sym" \
      "test_review_dedup.py exercises $sym -- a renamed API leaves the suite erroring"
  done

  grep -q "MAX_ERROR_RETRIES = 1" "$GUARD"
  assert $? "the mirrored guard keeps the one-retry error budget" \
    "the retry budget is the rule that stops 970 extra rows -- it must read 1, not 0 and not unbounded"
fi

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $((PASS + FAIL)) -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
