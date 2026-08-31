#!/usr/bin/env bash
# TOG-588 host-namespace mutation gate.
#
# The repaired assertion in test_omniroute_rehearsal.sh section 7 claims:
# "canonical lifecycle leaves the writable host namespace byte-identical".
# The assertion it replaced was INERT -- it asserted on
# OMNIROUTE_REHEARSAL_AUTHORIZATION_DIR, an environment variable no shipped
# code reads, so it passed no matter what the code did. A green suite meant
# nothing. This gate exists so the new green means something.
#
# Method: mutate rehearsal_authorized_preflight.sh -- the SHIPPED script the
# assertion is about -- so that it really does touch the operator's writable
# host namespace, then require the suite to go RED. A snapshot check that
# cannot notice a host-namespace write is the same inert assertion wearing a
# different name.
#
# The script self-verifies its own blob against HEAD (rehearsal_authorized_
# preflight.sh:59-62) and exits 7 before doing any work if it differs. So each
# mutant must be COMMITTED in a scratch clone, not merely written to disk --
# otherwise every mutant "fails" at the self-check and the gate scores a
# perfect result while proving nothing. That failure mode is precisely what
# this gate is guarding against, so it is worth the extra machinery.
#
# Mutants (each must turn the target assertion RED):
#   1. create   -- write a file under $HOME on the host
#   2. delete   -- remove a pre-existing host file
#   3. chmod    -- change the mode of a pre-existing host file
#   4. content  -- rewrite the bytes of a pre-existing host file
#   5. symlink  -- swap a host file for a symlink to itself
#
# DECOY: a real but genuinely irrelevant edit (a comment line). It must stay
# GREEN. Without it, a suite that goes red on ANY edit would score perfectly
# here while proving nothing about attribution.
#
# Exit 0 all mutants behaved · 1 a mutant survived or the decoy died · 2 refused.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SUITE_REL="test_omniroute_rehearsal.sh"
SRC_REL="rehearsal_authorized_preflight.sh"
TARGET_OK='canonical lifecycle leaves the writable host namespace byte-identical'

refuse() { printf 'REFUSED: %s\n' "$1" >&2; exit 2; }

command -v git >/dev/null 2>&1 || refuse 'git is required'
command -v jq >/dev/null 2>&1 || refuse 'jq is required'
command -v python3 >/dev/null 2>&1 || refuse 'python3 is required'
[[ -f $REPO_ROOT/$SUITE_REL ]] || refuse "missing $SUITE_REL"
[[ -f $REPO_ROOT/$SRC_REL ]] || refuse "missing $SRC_REL"

grep -Fq "$TARGET_OK" "$REPO_ROOT/$SUITE_REL" \
  || refuse "target assertion not found in $SUITE_REL -- the gate is anchored on stale text"

# The dead knob must stay dead. If it comes back, this gate is testing the
# wrong thing again.
if grep -q 'OMNIROUTE_REHEARSAL_AUTHORIZATION_DIR' "$REPO_ROOT/$SUITE_REL"; then
  refuse 'the inert OMNIROUTE_REHEARSAL_AUTHORIZATION_DIR knob is back in the suite'
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Scratch clone so mutants can be committed without touching the real tree.
CLONE=$WORK/clone
git -C "$REPO_ROOT" rev-parse --verify HEAD >/dev/null 2>&1 || refuse 'no HEAD to clone'
git clone -q --no-hardlinks --shared "$REPO_ROOT" "$CLONE" 2>/dev/null || refuse 'clone failed'
git -C "$CLONE" -c advice.detachedHead=false checkout -q --detach HEAD

# Carry uncommitted work (the repair itself may not be committed yet).
if ! git -C "$REPO_ROOT" diff --quiet HEAD -- "$SUITE_REL" "$SRC_REL" 2>/dev/null; then
  cp "$REPO_ROOT/$SUITE_REL" "$CLONE/$SUITE_REL"
  cp "$REPO_ROOT/$SRC_REL" "$CLONE/$SRC_REL"
  git -C "$CLONE" add "$SUITE_REL" "$SRC_REL"
  git -C "$CLONE" -c user.name=gate -c user.email=gate@local commit -q -m 'gate: working tree under test'
fi

BASE=$(git -C "$CLONE" rev-parse HEAD)

# Run the suite in the clone and report the target assertion's state.
# Prints: PASS, FAIL, or ABSENT.
target_state() {
  local out=$1
  if grep -Fq "  ok   $TARGET_OK" "$out"; then printf 'PASS'
  elif grep -Fq "FAIL $TARGET_OK" "$out" || grep -Fq 'canonical lifecycle mutated the writable host namespace' "$out"; then printf 'FAIL'
  else printf 'ABSENT'; fi
}

run_suite() {
  local out=$1
  ( cd "$CLONE" && timeout 900 ./"$SUITE_REL" ) > "$out" 2>&1 || true
}

reset_clone() {
  git -C "$CLONE" checkout -q --detach "$BASE"
  git -C "$CLONE" reset -q --hard "$BASE"
  git -C "$CLONE" clean -qfd
}

# Commit whatever is on disk so the script's HEAD self-check passes.
commit_mutant() {
  git -C "$CLONE" add -A
  git -C "$CLONE" -c user.name=gate -c user.email=gate@local commit -q -m "mutant: $1"
}

# ---------------------------------------------------------------- baseline
reset_clone
BASE_OUT=$WORK/baseline.out
run_suite "$BASE_OUT"
BASE_STATE=$(target_state "$BASE_OUT")
if [[ $BASE_STATE != PASS ]]; then
  printf 'REFUSED: baseline is not green (target assertion: %s)\n' "$BASE_STATE" >&2
  sed -n '/7\. canonical/,/8\. credentialed/p' "$BASE_OUT" >&2
  exit 2
fi
BASE_FAILED=$(sed -n 's/^  failed: \([0-9]*\)$/\1/p' "$BASE_OUT" | tail -1)
[[ ${BASE_FAILED:-1} == 0 ]] || refuse "baseline suite is not fully green (failed: ${BASE_FAILED:-unknown})"
printf 'baseline: target assertion PASS, suite failed=0\n\n'

# The host-side mutation is injected just before the script streams into the
# container -- after its own preflight checks, so it is reached on a normal run.
ANCHOR='stream_to_agent() {'

inject() {
  local payload=$1
  python3 - "$CLONE/$SRC_REL" "$ANCHOR" "$payload" <<'PY'
import sys
path, anchor, payload = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
if anchor not in src:
    raise SystemExit('ANCHOR_MISSING')
src = src.replace(anchor, payload + '\n' + anchor, 1)
open(path, 'w').write(src)
PY
}

PASSED=0
FAILED=0

# Each mutant acts on the operator's real writable HOME, which the suite
# points at $LIFECYCLE/home.
run_mutant() {
  local name=$1 payload=$2 expect=$3
  reset_clone
  if ! inject "$payload"; then
    printf '  %-9s REFUSED: anchor missing in %s\n' "$name" "$SRC_REL"
    FAILED=$((FAILED + 1)); return
  fi
  commit_mutant "$name"
  local out=$WORK/$name.out
  run_suite "$out"
  local state; state=$(target_state "$out")
  if [[ $state == $expect ]]; then
    printf '  %-9s %-6s (expected %s)  OK\n' "$name" "$state" "$expect"
    PASSED=$((PASSED + 1))
  else
    printf '  %-9s %-6s (expected %s)  *** GATE FAILURE ***\n' "$name" "$state" "$expect"
    sed -n '/7\. canonical/,/8\. credentialed/p' "$out" | sed 's/^/      /'
    FAILED=$((FAILED + 1))
  fi
}

HOST_VICTIM='"$HOME/state/evidence/evidence.jsonl"'

printf 'mutants (each must turn the target assertion RED):\n'

run_mutant create \
  ": > \"\$HOME/state/mutant-created-file\"" FAIL

run_mutant delete \
  "rm -f $HOST_VICTIM" FAIL

run_mutant chmod \
  "chmod 0644 $HOST_VICTIM" FAIL

run_mutant content \
  "printf 'mutated\\n' >> $HOST_VICTIM" FAIL

run_mutant symlink \
  "cp $HOST_VICTIM \"\$HOME/state/evidence/.real\" && ln -sf .real $HOST_VICTIM" FAIL

printf '\ndecoy (must stay GREEN -- proves attribution, not blanket sensitivity):\n'
run_mutant decoy \
  "# TOG-588 gate decoy: an inert comment that changes no behaviour." PASS

printf '\n'
printf 'passed: %d\nfailed: %d\n' "$PASSED" "$FAILED"
if (( FAILED != 0 )); then
  printf '\nRESULT: the host-namespace snapshot is not a working control.\n'
  exit 1
fi
printf '\nRESULT: every host-namespace mutation is caught; the decoy survives.\n'
exit 0
