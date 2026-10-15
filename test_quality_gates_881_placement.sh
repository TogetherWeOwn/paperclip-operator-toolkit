#!/usr/bin/env bash
# Placement acceptance tests for Land #881 (TOG-24959).
#
# THE RISK THIS EXISTS FOR. PR TogetherWeOwn/paperclip-ops-tooling#881 adds a
# deterministic quality-gates job (WARN-first, two HARD rules) whose Paperclip
# Review is FAILURE: the pull_request_target ban is bypassable, the floor
# guard misses unittest assertions, and the WARN gates emit hollow signal.
# Until the paired Land card resolves those threads, the landing is not
# complete -- and this card proves it with failing checks, not prose.
#
# What this pins, hermetically (no network, no credential):
#   1. the behavioral suite exists beside this file and is executable;
#   2. it is stdlib-only, so it runs anywhere python3 and git exist;
#   3. with no subject it skips instead of failing, so repo CI (which never
#      has an ops-tooling checkout) stays green;
#   4. this branch carries test files only -- no production code;
#   5. neither test file leaks a secret-shaped value.
#
# RED (before the fix): the behavioral suite fails against the PR head;
# that red lives in test_quality_gates_881_acceptance.py, recorded on the
# card. This placement file is GREEN now: it guards the vehicle, not the
# landing. Exit 0 all green, 1 anything red. Requires bash, git, python3.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE="$HERE/test_quality_gates_881_acceptance.py"
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

command -v python3 >/dev/null 2>&1 || { echo "test_quality_gates_881_placement: python3 is required" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "test_quality_gates_881_placement: git is required" >&2; exit 2; }

hdr "Placement: the acceptance pair is present and runnable"

[[ -f "$SUITE" && -x "$SUITE" ]]
assert $? "the behavioral suite exists and is executable at test_quality_gates_881_acceptance.py" \
  "the Land builder has nothing to run -- the suite file is absent or not executable"

[[ -f "$HERE/test_quality_gates_881_placement.sh" && -x "$HERE/test_quality_gates_881_placement.sh" ]]
assert $? "this placement file exists and is executable" \
  "placement must be as runnable as the suite it guards"

python3 - "$SUITE" <<'PY'
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
assert $? "the behavioral suite imports stdlib only" \
  "a third-party import strands the Land builder on a bare runner"

grep -q "OPS_TOOLING_SUBJECT" "$SUITE"
assert $? "the subject seam (OPS_TOOLING_SUBJECT) is recorded in the suite" \
  "an unrecorded seam is an unrunnable suite -- the builder must know where to point it"

hdr "Placement: safe to carry on a branch and in repo CI"

skip_out="$(env -u OPS_TOOLING_SUBJECT python3 "$SUITE" 2>&1)"
skip_rc=$?
[[ $skip_rc -eq 0 ]] && printf '%s' "$skip_out" | grep -qi "skipped"
assert $? "with no subject the suite skips (exit 0), never fails" \
  "rc=$skip_rc -- repo CI has no ops-tooling checkout, so a hard failure would red every build"

python3 -m py_compile "$SUITE"
assert $? "the behavioral suite compiles under the repo's parse gate" \
  "ci.yml py_compiles every root *.py -- a syntax error reds the branch for the wrong reason"

bash -n "$HERE/test_quality_gates_881_placement.sh"
assert $? "this placement file parses under the repo's parse gate" \
  "ci.yml bash -n's every root *.sh"

hdr "Placement: test files only, no secrets"

if git -C "$HERE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  base="$(git -C "$HERE" merge-base HEAD origin/main 2>/dev/null || true)"
  if [[ -n "$base" ]]; then
    others="$(git -C "$HERE" diff --name-only "$base" HEAD -- . ':!test_*' ':!test/**' || true)"
    [[ -z "$others" ]]
    assert $? "this branch changes test files only" \
      "non-test paths changed: $(printf '%s' "$others" | tr '\n' ' ') -- this card owns no production code"
    [[ -z "$(git -C "$HERE" status --porcelain || true)" ]]
    assert $? "the working tree is clean (everything committed)" \
      "uncommitted work is invisible to the Land builder"
  else
    bad "this branch changes test files only" \
      "no merge-base with origin/main -- cannot prove test-only scope"
  fi
else
  bad "this branch changes test files only" \
    "not inside a git work tree -- cannot prove test-only scope"
fi

SELF="$HERE/test_quality_gates_881_placement.sh"
# Self-match guard: the pattern definition names pat_secret, and the filter
# drops that one definition line -- a real secret never carries that name.
pat_secret='ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY'
hits="$(grep -hE "$pat_secret" "$SUITE" "$SELF" | grep -v 'pat_secret' || true)"
[[ -z "$hits" ]]
assert $? "neither test file carries a secret-shaped value" \
  "acceptance tests run on builders' runners -- secrets must never ride along: $hits"

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $((PASS + FAIL)) -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
