#!/usr/bin/env bash
# Repo-placement acceptance test for Land #915 (TOG-24793).
#
# THE RISK THIS EXISTS FOR. PR TogetherWeOwn/paperclip-ops-tooling#915 adds the
# bounded supervised apply to the regen receipt carrier
# (ops/tog-17271/regen_dry_run_receipt.sh, +452/-108, 5 files). The carrier is
# host-safe shell (no network, no credentials, no DB): it proves the paused
# pre-state, enforces the apply bounds, snapshots the keep file before and after
# the run, and validates the JSON receipt with python. Until that carrier logic
# is mirrored in this public repo, the landing is not complete for consumers
# that only have TogetherWeOwn/paperclip-operator-toolkit: the private repo
# carries the safety logic the supervised apply depends on.
#
# What this pins, hermetically (no network, no credential):
#   1. the carrier exists at this repo's root as regen_dry_run_receipt.sh;
#   2. it is executable bash with clean syntax, so CI and runbooks can call it;
#   3. it exposes the supervised-apply surface the behavioral suite
#      (test_regen_receipt_supervised_apply.sh) exercises: --apply,
#      --expect-script-sha, --expect-holds, the 30/200 bounds, the EXIT-trap
#      PAUSE restore, the keep-file digest comparison, and the apply-refusal
#      summary that proves what was deleted.
#
# RED (before the fix): assertion 1 fails -- the file is absent, which IS the
# placement risk reproduced. GREEN (after): all pass. The Builder adds
# regen_dry_run_receipt.sh on this branch without touching test files.
# Exit 0 all green, 1 anything red. Requires bash.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARRIER="$HERE/regen_dry_run_receipt.sh"
BEHAVIORAL="$HERE/test_regen_receipt_supervised_apply.sh"
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

hdr "Repo-placement: the supervised-apply carrier lives in the public repo"

[[ -f "$CARRIER" ]]
assert $? "the supervised-apply carrier is mirrored at regen_dry_run_receipt.sh in TogetherWeOwn/paperclip-operator-toolkit" \
  "regen_dry_run_receipt.sh absent -- placement risk reproduced (private repo carries the safety logic)"

[[ -f "$BEHAVIORAL" ]]
assert $? "the behavioral suite test_regen_receipt_supervised_apply.sh is present" \
  "behavioral suite absent -- the Builder has no contract to implement against"

if [[ -f "$CARRIER" ]]; then
  [[ -x "$CARRIER" ]]
  assert $? "the mirrored carrier is executable" \
    "a non-executable carrier cannot be called by CI or runbooks"

  bash -n "$CARRIER"
  assert $? "the mirrored carrier passes bash -n syntax check" \
    "a syntax-broken carrier fails every consumer at call time"

  for flag in --apply --expect-script-sha --expect-holds; do
    grep -qF -- "$flag" "$CARRIER"
    assert $? "the mirrored carrier exposes $flag" \
      "test_regen_receipt_supervised_apply.sh exercises $flag -- a renamed flag leaves the suite erroring"
  done

  grep -q "APPLY_MAX_TIME_BUDGET=30" "$CARRIER"
  assert $? "the mirrored carrier bounds --time-budget to 30" \
    "the 1..30 bound is the CISO condition that stops an unbounded apply"

  grep -q "APPLY_MAX_REMOVE=200" "$CARRIER"
  assert $? "the mirrored carrier bounds --max-remove to 200" \
    "the 1..200 bound is what keeps a supervised apply supervised"

  grep -q "trap restore_pause EXIT" "$CARRIER"
  assert $? "the mirrored carrier restores PAUSE on every exit via an EXIT trap" \
    "without the trap a refused apply leaves the host unpaused"

  grep -q "keep_snapshot" "$CARRIER"
  assert $? "the mirrored carrier snapshots the keep file before and after the run" \
    "without the snapshot a same-count ID swap is invisible"

  grep -q "apply summary" "$CARRIER"
  assert $? "the mirrored carrier prints the apply summary on refusal" \
    "without the summary a refused apply loses the record of what was deleted"
fi

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $((PASS + FAIL)) -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
