#!/usr/bin/env bash
# Mutation gate for check 5 of verification/upstream-bundle-filing-gate.sh.
#
# Check 5 answers "does this report cite a source file that is nowhere on this
# host, without carrying the do-not-file precondition marker?". Two separate
# defects have been found in HOW it answers that, and this script pins both
# fixes so neither can be quietly undone:
#
#   1. The one-segment blind spot. Check 5 used to require a citation to carry
#      at least TWO directory segments before it would look at it. That left it
#      blind to eight one-segment citations in the bundle it guards, including
#      the `plugin-job-store.ts` a CEO review blocked a report on. M1 and M2
#      are the mutants that proved it: both passed the narrow version.
#
#   2. The basename collision. Check 5 used to match citations against an index
#      of BASENAMES, so an absent vendor file scored present whenever anything
#      on this box shared its basename. M4 pins that: a citation whose basename
#      exists here but whose path does not must still read as absent.
#
# The controls matter as much as the mutants. Widening a check is how you
# manufacture a false positive, and a check that cries wolf on prose is one the
# next reviewer learns to wave through -- which is how defect 1 got introduced.
# C1 is the exact false positive the narrow rule was built to spare.
#
# Exit 0 = every mutant caught and every control quiet. Exit 1 = otherwise.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="verification/upstream-bundle-filing-gate.sh"

# Mutate a report that does NOT carry the do-not-file marker, so a detected
# citation is a FAIL rather than a note. plugin-auth-surface is clean and
# marker-free at the pin.
CARRIER="docs/upstream/plugin-auth-surface.md"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/tog1029-check5-XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

WORK="$SANDBOX/tree"
mkdir -p "$WORK"
# Copy the tree under test, excluding the VCS dir -- the gate reads the working
# tree when GATE_REF is unset, so a plain copy is enough and keeps this script
# runnable against an uncommitted edit.
tar -C "$REPO_ROOT" --exclude=.git -cf - . 2>/dev/null | tar -C "$WORK" -xf - || {
  echo "could not stage a sandbox copy of the tree" >&2; exit 2; }

[ -x "$WORK/$GATE" ] || chmod +x "$WORK/$GATE" 2>/dev/null

if [ ! -f "$WORK/$CARRIER" ]; then
  echo "carrier report missing: $CARRIER" >&2; exit 2
fi
cp "$WORK/$CARRIER" "$SANDBOX/carrier.orig"

failures=0
pass() { printf '  PASS  %s\n' "$*"; }
bad()  { failures=$((failures + 1)); printf '  FAIL  %s\n' "$*"; }

# Run the gate over the sandbox with the carrier mutated to contain $1.
# Echoes the exit status.
run_with() {
  local injected="$1"
  cp "$SANDBOX/carrier.orig" "$WORK/$CARRIER"
  printf '\n%s\n' "$injected" >> "$WORK/$CARRIER"
  ( cd "$WORK" && ./"$GATE" >"$SANDBOX/out" 2>&1 )
  printf '%s' "$?"
}

echo "TOG-1029 -- check 5 mutation gate"
echo "gate under test: $REPO_ROOT/$GATE"
echo ""

# --- Baseline. An unmutated tree must pass, or nothing below means anything.
cp "$SANDBOX/carrier.orig" "$WORK/$CARRIER"
( cd "$WORK" && ./"$GATE" >"$SANDBOX/out" 2>&1 )
base=$?
if [ "$base" -eq 0 ]; then
  pass "baseline: unmutated bundle passes"
else
  bad "baseline: unmutated bundle FAILS (exit $base) -- fix that before reading the mutants"
  sed 's/^/        | /' "$SANDBOX/out"
  echo ""
  echo "RESULT: baseline red, mutation results are meaningless"
  exit 1
fi

# --- Mutants. Each cites a file that does not exist anywhere on this host and
#     makes an explicit local-read claim, with no do-not-file marker. The gate
#     must FAIL (exit 1) on every one.
#
# The nonce basename must not exist on this box. It is spelled out literally
# rather than generated, so this script is deterministic.
run_mutant() {
  local label="$1" injected="$2" rc
  rc="$(run_with "$injected")"
  if [ "$rc" = "1" ]; then
    pass "$label -- caught"
  else
    bad "$label -- SURVIVED (exit $rc); check 5 cannot see this citation shape"
  fi
}

run_mutant "M1 bare one-segment absent citation" \
  'The file `nowhereatall9911.ts:396` was read directly from the vendor tree on this host.'

run_mutant "M2 one-segment absent citation with a src/ prefix" \
  'The file `src/nowhereatall9911.ts:396` was read directly from the vendor tree on this host.'

run_mutant "M3 two-segment absent citation (pre-existing coverage)" \
  'The file `src/sse/nowhereatall9911.ts` was read directly from the vendor tree on this host.'

# M4 must cite ONLY colliding basenames. An earlier draft paired the collision
# with an absent-basename citation, which the basename version of check 5 also
# caught -- so the mutant passed for the wrong reason and proved nothing about
# the collision fix. Both paths below have a basename that exists on this host
# (`auth.ts` resolves to an Express router, `models.ts` to a pi-local adapter
# model cache) while the paths themselves exist nowhere.
run_mutant "M4 absent paths whose BASENAMES collide with host files" \
  'The files `vendor/nowhere9911/auth.ts` and `vendor/nowhere9911/db/models.ts` were read directly from the vendor tree on this host.'

# --- Controls. Text that must stay quiet. A widened pattern that fails these
#     is worse than the blind spot it fixes.
run_control() {
  local label="$1" injected="$2" rc
  rc="$(run_with "$injected")"
  if [ "$rc" = "0" ]; then
    pass "$label -- correctly quiet"
  else
    bad "$label -- FALSE POSITIVE (exit $rc); do not fix this by re-narrowing the pattern"
    grep -E 'FAIL|absent' "$SANDBOX/out" | sed 's/^/        | /'
  fi
}

# C1 is the exact false positive that motivated the two-segment carve-out.
# Four plugins build a dist/manifest.js under this repo, so it resolves.
run_control "C1 dist/manifest.js prose (the original false positive)" \
  'Shipping a new `dist/manifest.js` there is already the sanctioned deploy mechanism.'

run_control "C2 a real, present two-segment host path" \
  'See `server/dist/routes/plugins.js` for the dispatch handler.'

run_control "C3 a real, present one-segment host path" \
  'See `services/plugin-job-store.ts` for the declaration sync.'

cp "$SANDBOX/carrier.orig" "$WORK/$CARRIER"

echo ""
if [ "$failures" -eq 0 ]; then
  echo "RESULT: PASS -- 4 mutants caught, 3 controls quiet"
  exit 0
fi
echo "RESULT: FAIL -- $failures check(s) failed"
exit 1
