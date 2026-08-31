#!/usr/bin/env bash
# ===========================================================================
# tog752_predispatch_deploy_gate.sh — is the TOG-746 originSeam fail-open fix
# present in whatever is about to be (or already is) deployed to /app?
#
# WHY THIS EXISTS (TOG-752). TOG-746 closed `done` with a fix for three
# fail-open shapes in the pre-dispatch call-site validator
# (`invalidatesSeamProperty` in
# server/src/services/pre-dispatch-call-site-coverage.ts). Measured
# 2026-08-31: that fix is NOT in this repo's `origin/main` and NOT in the
# deployed `/app/server/dist` — the validator itself is not deployed at all
# right now, so there is no live exposure, but the CISO's standing
# constraint on TOG-642/TOG-649 is ORDERING: the originSeam erasure fail-open
# must be fixed BEFORE any pre-dispatch enforcement reaches a deployed path.
# A fail-open validator is worse than no validator, because it reports
# coverage it does not have.
#
# WHAT THIS IS NOT. It is not a merge tool and it performs no git write. The
# original TOG-752 definition of done asked to "land origin/main" and
# "land origin/tog-674-successor-a36166c1" into this repo's `main` — verified
# 2026-08-31 (see comment thread) to be IMPOSSIBLE as a `git merge`: the two
# are unrelated histories (`git merge-base` exits 1; root commits 60ac5522 vs
# 481b3a46 differ; this repo's `main` is 264-file ops-tooling, the successor
# chain is a 4488-file slice of the real upstream paperclipai/paperclip
# monorepo). The actually-deployed Paperclip server is built from that
# upstream repo via a podman image, not from this repo, so a merge here would
# not touch deploy safety regardless. TOG-752 is narrowed to the one thing a
# script in THIS repo can honestly check: the deployed bundle's content.
#
# WHAT IT CHECKS. Greps the target directory (default: the live
# /app/server/dist) for `invalidatesSeamProperty` — the TOG-746 fix's own
# symbol, absent at the pre-fix base `a36166c1` and present 2x on the fix
# branch — WITH a positive control in the same sweep, so a zero reads as
# real absence rather than a broken grep or an unmounted directory.
#
#   Case A: `preDispatch`/`collectPreDispatchCallSiteCoverage` ABSENT from the
#           target -> the validator is not deployed at all. Gate PASSES
#           (nothing to fail open). This is the CURRENT state, 2026-08-31.
#   Case B: validator markers PRESENT, `invalidatesSeamProperty` ABSENT ->
#           the validator is deployed WITHOUT the fix. Gate FAILS — this is
#           exactly the ordering violation TOG-752 exists to catch.
#   Case C: validator markers PRESENT and `invalidatesSeamProperty` PRESENT ->
#           the fix shipped with the validator. Gate PASSES.
#
# Exit codes:
#   0  PASS   — no deployed exposure (Case A or Case C)
#   3  FAIL   — validator deployed without the fix (Case B) — do not deploy /
#               roll back immediately if this is checked post-deploy
#   2  REFUSED — could not measure (target unreadable, positive control
#               itself absent — the same "prove the grep works" discipline
#               the original CISO sweep used)
#
# USAGE
#   ./tog752_predispatch_deploy_gate.sh check [--target DIR]
#       --target DIR   directory to grep (default: /app/server/dist)
#
# Run this in CI/deploy pipeline before any activation of a pre-dispatch
# call-site validator, and re-run it periodically against the live /app as a
# standing check (it is read-only; safe to run against the deployed tree).
# ===========================================================================
set -uo pipefail

ME="$(basename "${BASH_SOURCE[0]}")"
EXIT_PASS=0
EXIT_REFUSED=2
EXIT_FAIL=3

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel() { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { c_red "$ME: $*" >&2; exit $EXIT_REFUSED; }

usage() {
  cat <<EOF
$ME check [--target DIR]

  --target DIR   directory to grep for the validator + fix markers
                 (default: /app/server/dist)

Exit: 0 pass (no deployed exposure)   2 refused (measured nothing)
      3 fail (validator deployed without the TOG-746 fix)
EOF
}

# grep -rl over a directory tree, counting FILES that match (not occurrences),
# matching the counting convention the original CISO sweep used
# ("originSeam -> 0 files", "wakeOpts -> 1 file").
count_files_matching() {
  local pattern="$1" dir="$2"
  grep -rl -- "$pattern" "$dir" 2>/dev/null | wc -l | tr -d ' '
}

cmd_check() {
  local target="/app/server/dist"
  while [ $# -gt 0 ]; do
    case "$1" in
      --target) target="${2:?}"; shift 2 ;;
      -h|--help) usage; exit $EXIT_PASS ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  [ -d "$target" ] || die "--target $target is not a directory — refusing to report a pass or fail on an unmeasured target"

  # Positive control FIRST. If a marker we know is present in any deployed
  # server build (wakeOpts / requestWakeup) reads zero, the grep itself is
  # broken (wrong tool, wrong flags, permissions, empty tree) and every other
  # count in this run is meaningless.
  local ctrl_wakeopts ctrl_requestwakeup
  ctrl_wakeopts="$(count_files_matching 'wakeOpts' "$target")"
  ctrl_requestwakeup="$(count_files_matching 'requestWakeup' "$target")"

  if [ "$ctrl_wakeopts" -eq 0 ] && [ "$ctrl_requestwakeup" -eq 0 ]; then
    die "positive control failed: neither 'wakeOpts' nor 'requestWakeup' matched anything under $target. The grep, not the codebase, is broken — refusing to report on invalidatesSeamProperty against an unproven sweep."
  fi

  local n_validator n_predispatch n_fix
  n_validator="$(count_files_matching 'collectPreDispatchCallSiteCoverage' "$target")"
  n_predispatch="$(count_files_matching 'preDispatch' "$target")"
  n_fix="$(count_files_matching 'invalidatesSeamProperty' "$target")"

  printf '\033[1mTOG-752 pre-dispatch deploy gate\033[0m\n'
  printf '  target                              %s\n' "$target"
  printf '  positive control  wakeOpts           %s file(s)\n' "$ctrl_wakeopts"
  printf '  positive control  requestWakeup      %s file(s)\n' "$ctrl_requestwakeup"
  printf '  collectPreDispatchCallSiteCoverage    %s file(s)\n' "$n_validator"
  printf '  preDispatch                           %s file(s)\n' "$n_predispatch"
  printf '  invalidatesSeamProperty (the fix)     %s file(s)\n\n' "$n_fix"

  local validator_deployed=0
  { [ "$n_validator" -gt 0 ] || [ "$n_predispatch" -gt 0 ]; } && validator_deployed=1

  if [ "$validator_deployed" -eq 0 ]; then
    c_grn "PASS — no pre-dispatch call-site validator is deployed to $target."
    c_grn "Nothing to fail open. Case A (current state as of 2026-08-31)."
    exit $EXIT_PASS
  fi

  if [ "$n_fix" -eq 0 ]; then
    c_red "FAIL — a pre-dispatch call-site validator IS deployed to $target,"
    c_red "and it does NOT contain the TOG-746 fix (invalidatesSeamProperty)."
    c_red "This is the exact ordering violation TOG-752 exists to catch:"
    c_red "the three originSeam erasure shapes (x.originSeam = null,"
    c_red "delete x.originSeam, Object.assign erasure) fail OPEN in this build."
    c_red "Do not deploy this build. If already deployed, treat as a live"
    c_red "security regression and escalate for rollback."
    exit $EXIT_FAIL
  fi

  c_grn "PASS — the deployed validator contains the TOG-746 fix (invalidatesSeamProperty present)."
  exit $EXIT_PASS
}

case "${1:-}" in
  check) shift; cmd_check "$@" ;;
  -h|--help|"") usage; [ -n "${1:-}" ] && exit $EXIT_PASS || exit $EXIT_REFUSED ;;
  *) die "unknown subcommand: $1" ;;
esac
