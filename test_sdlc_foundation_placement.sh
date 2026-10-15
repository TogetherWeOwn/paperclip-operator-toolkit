#!/usr/bin/env bash
# Repo-placement acceptance test for Land #939: the SDLC 1.0 shared
# CI/policy foundation stage.
#
# THE RISK THIS EXISTS FOR. The foundation stage (org SDLC baseline
# ruleset twins, the one repo exclude list, dynamic repo discovery, the
# day-1 repo template, the central-repo decision and the operator
# runbook) was staged in the private ops repo, and the repo-placement
# gate answered that every one of those files is public-able and belongs
# in THIS public repo. Until the staged tree is mirrored here, the
# landing is not complete: the private repo carries public code the gate
# refuses, and a new repo cut from the org still gets no day-1 baseline.
#
# What this pins, hermetically (no network, no credential):
#   1. the staged tree exists at templates/org-github/ with the same
#      relative paths the placement gate listed;
#   2. discover-repos.sh is executable (host scripts exec it directly);
#   3. the tree README maps every staged file to its destination, so a
#      file added to the stage cannot silently lack an apply path;
#   4. this repo's CI actually runs an sdlc_foundation suite, so the
#      contract cannot rot unwired.
#
# RED (before the fix): assertion set 1 fails -- the tree is absent,
# which IS the placement risk reproduced. GREEN (after): all pass. The
# Builder mirrors the staged tree on this branch without touching test
# files. The behavioral contract lives in
# test_sdlc_foundation_acceptance.py.
# Exit 0 all green, 1 anything red. Requires bash.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="$HERE/templates/org-github"
FOUND="$BASE/sdlc-foundation"
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

STAGED=(
  "README.md"
  "rulesets/sdlc-baseline-evaluate.json"
  "rulesets/sdlc-baseline-active.json"
  "rulesets/SDLC-BASELINE-RUNBOOK.md"
  "sdlc-foundation/DECISION-central-repo.md"
  "sdlc-foundation/repo-exclude-list.txt"
  "sdlc-foundation/discover-repos.sh"
  "sdlc-foundation/BOOTSTRAP-new-repo.md"
  "sdlc-foundation/repo-template/ci.yml"
  "sdlc-foundation/repo-template/CODEOWNERS"
  "sdlc-foundation/repo-template/policy-bot.yml.disabled"
  "sdlc-foundation/repo-template/STAGING-MIGRATE-CONTRACT.md"
)

hdr "Repo-placement: the public foundation stage lives in the public repo"

for rel in "${STAGED[@]}"; do
  [[ -f "$BASE/$rel" ]]
  assert $? "staged file mirrored at templates/org-github/$rel" \
    "absent -- placement risk reproduced (private repo carries public code)"
done

[[ -x "$FOUND/discover-repos.sh" ]]
assert $? "discover-repos.sh is executable" \
  "host scripts exec it directly; a non-executable mirror breaks discovery"

hdr "Destination map: every staged file has an apply path"

if [[ -f "$BASE/README.md" ]]; then
  for rel in "${STAGED[@]}"; do
    [[ "$rel" == "README.md" ]] && continue
    grep -qF "$rel" "$BASE/README.md"
    assert $? "README destination map names $rel" \
      "an unmapped staged file has no documented destination or applier"
  done
fi

hdr "Wiring: CI runs an sdlc_foundation suite"

grep -qs "sdlc_foundation" "$HERE/.github/workflows/ci.yml" \
  || grep -qs "sdlc_foundation" "$HERE/scripts/verify-fast.sh" 2>/dev/null
assert $? "an sdlc_foundation suite is wired into CI (ci.yml or verify-fast)" \
  "an unwired contract rots: the staged tree could drift with no red check"

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $((PASS + FAIL)) -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
