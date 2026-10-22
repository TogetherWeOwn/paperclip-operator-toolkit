#!/usr/bin/env bash
# Repo-placement acceptance test for Land #897 (pr-hygiene fault visibility).
#
# THE RISK THIS EXISTS FOR. PR TogetherWeOwn/paperclip-ops-tooling#897 makes
# the pr-hygiene sweep fail visibly on GitHub faults (bound calls, counted
# faults, non-zero exit). The sweep is public, stdlib-only operator code, so
# repo placement requires its mirror to live in this public repo. Until it
# lands here as pr_hygiene_sweep.py, the landing is not complete.
#
# What this pins, hermetically (no network, no credential):
#   1. the sweep exists at this repo's root as pr_hygiene_sweep.py;
#   2. it imports stdlib (or repo-local modules) only, so it is importable
#      from every consumer runtime;
#   3. importing it has no side effects (no token mint, no network, no
#      subprocess at import time) -- the timer, not the import, runs it;
#   4. it exposes the fault-visibility API the behavioural suite
#      (test_pr_hygiene_fault_visibility.py) exercises.
#
# RED (before the fix): assertion 1 fails -- the file is absent, which IS
# the placement risk reproduced. GREEN (after): all pass. The Builder adds
# pr_hygiene_sweep.py on this branch without touching test files.
# Exit 0 all green, 1 anything red. Requires bash, python3.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWEEP="$HERE/pr_hygiene_sweep.py"
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

command -v python3 >/dev/null 2>&1 || { echo "test_pr_hygiene_fault_visibility_placement: python3 is required" >&2; exit 2; }

hdr "Repo placement: the public pr-hygiene sweep lives in the public repo"

[[ -f "$SWEEP" ]]
assert $? "the pr-hygiene sweep is mirrored at pr_hygiene_sweep.py in TogetherWeOwn/paperclip-operator-toolkit" \
  "pr_hygiene_sweep.py absent -- placement risk reproduced (private repo carries public code)"

if [[ -f "$SWEEP" ]]; then
  # Stdlib-only: every import must resolve to the standard library or to a
  # sibling module in this repo, so CI gates and operator timers can all
  # import the sweep without installing anything.
  python3 - "$SWEEP" <<'PY'
import ast, os, sys
path = sys.argv[1]
tree = ast.parse(open(path).read())
stdlib = sys.stdlib_module_names
here = os.path.dirname(os.path.abspath(path))
local = {os.path.splitext(f)[0] for f in os.listdir(here) if f.endswith('.py')}
third = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for a in node.names:
            third.add(a.name.split('.')[0])
    elif isinstance(node, ast.ImportFrom):
        if node.level == 0 and node.module:
            third.add(node.module.split('.')[0])
bad = sorted(m for m in third if m not in stdlib and m not in local)
if bad:
    print('third-party imports: %s' % ', '.join(bad))
    sys.exit(1)
PY
  assert $? "the mirrored sweep imports stdlib or repo-local modules only" \
    "a third-party import strands every consumer runtime that only has stdlib"

  # Import is a pure definition load: running it in an empty directory with
  # no credential and no network must succeed without doing any work.
  TMPD="$(mktemp -d)"
  (cd "$TMPD" && timeout 15 env -i PATH="$PATH" PYTHONPATH="$HERE" python3 -c "import pr_hygiene_sweep" >/dev/null 2>&1)
  assert $? "importing the mirrored sweep has no side effects" \
    "import must not mint a token, call the network or spawn the sweep"
  rm -rf "$TMPD"

  for sym in gh fault reset_run main; do
    grep -qE "^def $sym\(" "$SWEEP"
    assert $? "the mirrored sweep exposes $sym" \
      "test_pr_hygiene_fault_visibility.py exercises $sym -- a renamed API leaves the suite erroring"
  done
fi

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $((PASS + FAIL)) -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
