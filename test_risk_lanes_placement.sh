#!/usr/bin/env bash
# Repo-placement acceptance test for Land #938 (advisory risk lanes).
#
# THE RISK THIS EXISTS FOR. PR TogetherWeOwn/paperclip-ops-tooling#938
# adds the deterministic LOW/HIGH risk-lane classifier, lane ledger,
# embedded advisory workflow, required wrapper, org ruleset draft and
# policy-bot template in the private repo, and the repo-placement gate
# answers that every one of those files is public-able and belongs in
# TogetherWeOwn/paperclip-operator-toolkit -- i.e. this repo. Until the
# mirror lands here, the landing is not complete: the private repo
# carries public code the gate refuses. Two of the eight review
# findings on #938 were placement-shaped and are pinned here: the
# suite must actually run in CI (finding 4), and promotable files must
# carry no internal ticket ids (public-repo hygiene).
#
# What this pins, hermetically (no network, no credential):
#   1. the canonical classifier exists at this repo's root as
#      risk_lanes.py, stdlib-only, exposing the API the behavioral
#      suite (test_risk_lanes.py) exercises;
#   2. the staged org drop exists at templates/org-github/risk-lanes/
#      with the promotable files, and the tree README maps them;
#   3. this repo's CI actually runs a risk-lanes suite;
#   4. no internal ticket ids in the mirrored public files.
#
# RED (before the fix): assertion 1 fails -- the files are absent,
# which IS the placement risk reproduced. GREEN (after): all pass.
# The Builder mirrors the files on this branch without touching test
# files. Exit 0 all green, 1 anything red. Requires bash, python3.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE="$HERE/risk_lanes.py"
STAGE="$HERE/templates/org-github/risk-lanes"
READMEMAP="$HERE/templates/org-github/README.md"
CI="$HERE/.github/workflows/ci.yml"
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

command -v python3 >/dev/null 2>&1 || { echo "test_risk_lanes_placement: python3 is required" >&2; exit 2; }

hdr "Repo-placement: the public classifier lives in the public repo"

[[ -f "$MODULE" ]]
assert $? "the risk-lane classifier is mirrored at risk_lanes.py in TogetherWeOwn/paperclip-operator-toolkit" \
  "risk_lanes.py absent -- placement risk reproduced (private repo carries public code)"

if [[ -f "$MODULE" ]]; then
  python3 - "$MODULE" <<'PY'
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
  assert $? "the mirrored classifier imports stdlib only" \
    "a third-party import strands every consumer runtime that only has stdlib"

  for sym in classify is_narrow_low is_docs_tests_only is_clean log_lane \
             is_tripwire_escape count_clean_low_merges narrow_widen_ready; do
    grep -qE "^def $sym\(" "$MODULE"
    assert $? "the mirrored classifier exposes $sym" \
      "test_risk_lanes.py exercises $sym -- a renamed API leaves the suite erroring"
  done

  grep -q "FULL_MAX_LINES = 400" "$MODULE"
  assert $? "the mirrored classifier keeps the 400-line full budget" \
    "the budget is the backtested rule -- retuning here silently moves the LOW share"

  grep -q "NARROW_MAX_LINES = 50" "$MODULE"
  assert $? "the mirrored classifier keeps the 50-line narrow budget" \
    "narrow activates first -- a wider narrow budget widens the first live lane"
fi

hdr "Repo-placement: the staged org drop lives in the public repo"

STAGED=(
  "risk-lane-advisory.yml"
  "risk-lane-required.yml"
  "org-ruleset-risk-lane.json"
  "risk-lane-exclusions.txt"
  "policy-advisory.yml"
  "RISK-LANES-ROLLOUT.md"
)
for rel in "${STAGED[@]}"; do
  [[ -f "$STAGE/$rel" ]]
  assert $? "staged file mirrored at templates/org-github/risk-lanes/$rel" \
    "absent -- the org drop is incomplete and the private staging copy stays canonical"
done

if [[ -f "$READMEMAP" ]]; then
  for rel in "${STAGED[@]}"; do
    grep -q "risk-lanes/$rel" "$READMEMAP"
    assert $? "templates/org-github/README.md maps risk-lanes/$rel to a destination" \
      "an unmapped staged file has no documented destination or applier"
  done
else
  assert 1 "templates/org-github/README.md maps the risk-lanes staged files" \
    "templates/org-github/README.md absent -- staged files have no documented destinations"
fi

hdr "CI wiring: the suite runs somewhere that can go red"

grep -q "test_risk_lanes" "$CI"
assert $? "this repo's CI runs a risk-lanes suite" \
  "finding 4 on the source PR: a suite that never runs in CI lets classifier regressions merge green"

hdr "Public hygiene: no internal ticket ids in mirrored files"

leaked=0
for f in "$MODULE" "$STAGE"/*; do
  [[ -f "$f" ]] || continue
  if grep -qE 'TOG-[0-9]+' "$f"; then leaked=1; fi
done
[[ "$leaked" -eq 0 && -f "$MODULE" ]]
assert $? "mirrored classifier and staged files carry no internal ticket ids" \
  "public promotable files must not name internal tickets -- scrub on mirror"

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $((PASS + FAIL)) -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
