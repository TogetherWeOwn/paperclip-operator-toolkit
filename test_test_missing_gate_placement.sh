#!/usr/bin/env bash
# Repo-placement acceptance test for Land #942 (test-missing gate workflow).
#
# THE RISK THIS EXISTS FOR. PR TogetherWeOwn/paperclip-ops-tooling#942 adds
# the deterministic test-missing/wrong gate (stdlib-only, no network, no
# clock) plus its staged org drop: the reusable gate workflow, the thin
# required wrapper, the verbatim logic copy, the adoption guide, the
# report-only/required ruleset twins, and this repo's warn-only caller. The
# shared logic and the staged drop are public-able, so the repo-placement
# gate requires the mirror to live in THIS public repo. Until it is mirrored
# here, the landing is not complete: the gate exists nowhere consumers can
# adopt it with one uses: line, and the blocker class stays a model judgment.
#
# What this pins, hermetically (no network, no credential):
#   1. the gate exists at this repo's root as blocker_test_checks.py;
#   2. it is stdlib-only, so every consumer runtime can import the one file;
#   3. it exposes the API the behavioral suite (test_test_missing_gate.py)
#      exercises;
#   4. the staged org drop exists under templates/org-github/test-missing/
#      with the reusable workflow_call gate, the pull_request + merge_group
#      wrapper, the verbatim logic copy, the adoption guide, and the
#      report-only/active ruleset twins that differ only in enforcement;
#   5. this repo's warn-only caller calls the org reusable by pinned SHA.
#
# RED (before the fix): the mirror files are absent, which IS the placement
# risk reproduced. GREEN (after): all pass. The Builder adds the mirror on
# this branch without touching test files.
# Exit 0 all green, 1 anything red. Requires bash, python3.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/blocker_test_checks.py"
STAGE="$HERE/templates/org-github/test-missing"
RULESETS="$HERE/templates/org-github/rulesets"
READMEMAP="$HERE/templates/org-github/README.md"
CALLER="$HERE/.github/workflows/test-missing.yml"
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

command -v python3 >/dev/null 2>&1 || { echo "test_test_missing_gate_placement: python3 is required" >&2; exit 2; }

hdr "Repo-placement: the public gate lives in the public repo"

[[ -f "$GUARD" ]]
assert $? "the deterministic gate is mirrored at blocker_test_checks.py in TogetherWeOwn/paperclip-operator-toolkit" \
  "blocker_test_checks.py absent -- placement risk reproduced (deterministic check lives nowhere adoptable)"

if [[ -f "$GUARD" ]]; then
  # Stdlib-only: every top-level import must resolve to the standard library,
  # so CI gates and consumer repos can all import the one file.
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
  assert $? "the mirrored gate imports stdlib only" \
    "a third-party import strands every consumer runtime that only has stdlib"

  for sym in is_test_path is_src_path check_src_without_tests check_changed_line_coverage check_test_guards; do
    grep -qE "^(def $sym|TEST_EXEMPT_LABEL)" "$GUARD" 2>/dev/null || grep -qE "^def $sym\(" "$GUARD"
    assert $? "the mirrored gate exposes $sym" \
      "test_test_missing_gate.py exercises $sym -- a renamed API leaves the suite erroring"
  done

  grep -q 'TEST_EXEMPT_LABEL = "tests-exempt"' "$GUARD"
  assert $? "the mirrored gate pins the tests-exempt waive label" \
    "the waive label is the escape hatch -- a renamed label silently re-fails exempt PRs"
fi

hdr "Staged org drop: one reusable gate every repo adopts"

[[ -f "$STAGE/test-missing-gate.yml" ]]
assert $? "staged reusable gate exists at templates/org-github/test-missing/test-missing-gate.yml" \
  "absent -- the org has no one-line adoptable gate"

if [[ -f "$STAGE/test-missing-gate.yml" ]]; then
  grep -q "workflow_call:" "$STAGE/test-missing-gate.yml"
  assert $? "the staged gate is a reusable workflow_call workflow" \
    "without workflow_call no repo can adopt it with one uses: line"

  grep -q 'default: "warn"' "$STAGE/test-missing-gate.yml"
  assert $? "the staged gate defaults to warn mode" \
    "warn-first is the rollout rule -- a default-enforce gate fails repos before the FP rate is measured"

  grep -q "timeout-minutes:" "$STAGE/test-missing-gate.yml"
  assert $? "every staged gate job carries a timeout bound" \
    "an unbounded gate job can hang the required check forever"

  grep -qE "uses:[^@]+@[0-9a-f]{40}" "$STAGE/test-missing-gate.yml"
  assert $? "staged gate actions are SHA-pinned, never a moving tag" \
    "a moving tag lets the gate change under repos without review"
fi

[[ -f "$STAGE/test-missing-required.yml" ]]
assert $? "thin required wrapper exists at templates/org-github/test-missing/test-missing-required.yml" \
  "absent -- no org ruleset can require the workflow"

if [[ -f "$STAGE/test-missing-required.yml" ]]; then
  grep -q "pull_request:" "$STAGE/test-missing-required.yml"
  assert $? "the required wrapper triggers on pull_request" \
    "without it the required check never runs on PRs"

  grep -q "merge_group:" "$STAGE/test-missing-required.yml"
  assert $? "the required wrapper triggers on merge_group" \
    "without it the merge queue has no required signal"

  grep -q "name: test-missing" "$STAGE/test-missing-required.yml"
  assert $? "the required wrapper re-exports the bare test-missing check" \
    "the ruleset requires the check by name -- a renamed check leaves the ruleset pointing nowhere"
fi

hdr "Staged logic copy: fix upstream, then re-copy"

[[ -f "$STAGE/blocker_test_checks.py" ]]
assert $? "staged logic copy exists at templates/org-github/test-missing/blocker_test_checks.py" \
  "absent -- the org drop ships no logic to run"

if [[ -f "$GUARD" && -f "$STAGE/blocker_test_checks.py" ]]; then
  cmp -s "$GUARD" "$STAGE/blocker_test_checks.py"
  assert $? "the staged copy is verbatim (fix upstream, then re-copy)" \
    "a hand-edited copy drifts from the tested root source"
fi

hdr "Adoption guide and ruleset twins"

[[ -f "$STAGE/ADOPTION.md" ]]
assert $? "adoption guide exists at templates/org-github/test-missing/ADOPTION.md" \
  "absent -- repos have no caller snippet to copy"

if [[ -f "$STAGE/ADOPTION.md" ]]; then
  grep -q "@<pinned-sha>" "$STAGE/ADOPTION.md"
  assert $? "the adoption guide carries a pinned-SHA caller snippet" \
    "a branch-name snippet lets the gate move under repos without review"

  grep -q "warn" "$STAGE/ADOPTION.md"
  assert $? "the adoption guide documents warn mode" \
    "repos must land warn-first before any enforce flip"
fi

if [[ -f "$RULESETS/test-missing-report-only.json" && -f "$RULESETS/test-missing-required.json" ]]; then
  python3 - "$RULESETS" <<'PY'
import json, sys
base = sys.argv[1]
s1 = json.loads(open(base + "/test-missing-report-only.json").read())
s2 = json.loads(open(base + "/test-missing-required.json").read())
assert s1.get("enforcement") == "evaluate", "report-only must evaluate"
assert s2.get("enforcement") == "active", "required must be active"
strip = lambda d: {k: v for k, v in d.items() if k not in ("enforcement", "_comment")}
assert strip(s1) == strip(s2), "twins must differ only in enforcement"
wfs = [w for r in s1.get("rules", []) if r.get("type") == "required_workflows"
       for w in r.get("parameters", {}).get("workflows", [])]
assert wfs, "ruleset must carry a required_workflows entry"
assert any(w.get("repository_id") == "REPO_ID_OF_DOT_GITHUB" for w in wfs), \
    "repository_id stays a string placeholder until the runbook fills it"
PY
  assert $? "ruleset twins exist and differ only in enforcement, with a required_workflows placeholder" \
    "an enforce flip that smuggles a rule change was never measured in report-only"
else
  assert 1 "ruleset twins exist at templates/org-github/rulesets/test-missing-{report-only,required}.json" \
    "absent -- the staged rollout has no report-only then required path"
fi

if [[ -f "$READMEMAP" ]]; then
  for f in "test-missing/test-missing-gate.yml" "test-missing/test-missing-required.yml" "test-missing/blocker_test_checks.py" "test-missing/ADOPTION.md" "rulesets/test-missing-report-only.json" "rulesets/test-missing-required.json"; do
    grep -qF "$f" "$READMEMAP"
    assert $? "README destination map names $f" \
      "an unmapped staged file has no documented destination or applier"
  done
else
  assert 1 "README destination map names every new staged file" \
    "templates/org-github/README.md absent -- staged files have no documented destinations"
fi

hdr "Wiring: this repo calls the org gate warn-only by pinned SHA"

[[ -f "$CALLER" ]]
assert $? "this repo's warn-only caller exists at .github/workflows/test-missing.yml" \
  "absent -- the gate is staged but this repo does not run it"

if [[ -f "$CALLER" ]]; then
  grep -qE "uses:[[:space:]]*TogetherWeOwn/\.github/\.github/workflows/\S+@[0-9a-f]{40}" "$CALLER"
  assert $? "the caller reaches the org reusable by pinned SHA, never a moving tag" \
    "a moving tag lets the gate change under this repo without review"

  grep -q "mode: warn" "$CALLER"
  assert $? "the caller runs in warn mode" \
    "warn-first is the rollout rule -- this repo flips to enforce only after its FP rate is measured"
fi

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $((PASS + FAIL)) -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
