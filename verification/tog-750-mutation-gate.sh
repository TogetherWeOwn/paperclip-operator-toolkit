#!/usr/bin/env bash
# TOG-750 mutation gate.
#
# The fix lets an interaction addressed to an agent actually wake that agent:
# `allowsAddressedInteractionWake` grants the non-assignee exemption when the
# INTERACTION ROW says the wake is for a still-pending interaction addressed to
# this agent. Five tests in
# server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts assert it.
# This proves those tests can fail, which is the only thing that makes their
# green mean anything.
#
# Two directions matter, and a suite that catches only one is not a control:
#
#   UNDER-delivery -- revert the exemption at any of the three cancel sites.
#     The original defect: 125 of 125 addressed wakes cancelled. Must go red.
#   OVER-delivery  -- grant the exemption on weaker evidence: trust the wake
#     context instead of the row, ignore the addressee, ignore the interaction
#     status, or widen the shared reason set. Each trivially satisfies "the
#     addressee gets its run" while handing any agent a bypass of the assignee
#     gate, because `enrichWakeContextSnapshot` copies a caller-supplied
#     `reason` into `contextSnapshot.wakeReason` and `POST /agents/:id/wakeup`
#     accepts a free-form `reason` and `payload` on a self-wake. Must also go
#     red.
#
# Plus a DECOY: a real edit to a genuinely unrelated line, which must stay
# GREEN. Without it, a suite that fails on any edit whatsoever would score a
# perfect result here while proving nothing about attribution.
#
# Exit 0 all mutants behaved · 1 a mutant survived (or the decoy died) · 2 refused.

set -euo pipefail

# /app is the shared deployed tree and is not ours to leave modified, and the
# fix lives in this repo as a patch rather than in /app at all. So the gate
# stages its own copy of the two files, applies the patch to them, and mutates
# that -- /app is only ever read. Point TOG750_SERVER_DIR at a real checkout to
# run against one instead.
UPSTREAM_DIR=${TOG750_SERVER_DIR:-/app/server}
SRC_REL="src/services/heartbeat.ts"
TEST_REL="src/__tests__/heartbeat-stale-queue-invalidation.test.ts"
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PATCH=${TOG750_PATCH:-$REPO_ROOT/patches/TOG-750-addressed-interaction-wake.patch}
VITEST="$UPSTREAM_DIR/node_modules/.bin/vitest"

refuse() { printf 'REFUSED: %s\n' "$1" >&2; exit 2; }

[ -f "$UPSTREAM_DIR/$SRC_REL" ]  || refuse "heartbeat source not found at $UPSTREAM_DIR/$SRC_REL"
[ -f "$UPSTREAM_DIR/$TEST_REL" ] || refuse "test file not found at $UPSTREAM_DIR/$TEST_REL"
[ -f "$PATCH" ]  || refuse "patch not found at $PATCH"
[ -x "$VITEST" ] || refuse "vitest not executable at $VITEST"
command -v git >/dev/null || refuse "git is required to apply the patch"

# These tests boot an embedded Postgres and assert on real heartbeat_runs rows,
# because the acceptance criterion is a run row rather than a code reading. On a
# host where that harness cannot start, the suite's own `describeEmbeddedPostgres`
# degrades to `describe.skip` -- and a skipped suite is GREEN. Every mutant would
# then "survive" for a reason that has nothing to do with the mutation. Refuse
# rather than emit that result.
if grep -q 'embeddedPostgresSupport.supported ? describe : describe.skip' "$UPSTREAM_DIR/$TEST_REL"; then
  :
else
  refuse "suite no longer guards on embeddedPostgresSupport; re-check the skip-is-green assumption"
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Shadow tree: symlink the server directory so node_modules and the module graph
# resolve exactly as upstream, then replace the two files under test with real,
# writable copies. Nothing under $UPSTREAM_DIR is ever written.
#
# The repo root is mirrored too, not just the server directory: server/tsconfig.json
# extends ../tsconfig.base.json, so a stage that only shadows the server resolves
# no tsconfig and vitest fails to transform anything -- which would look like a
# red suite rather than a broken harness.
REPO_PARENT=$(cd "$UPSTREAM_DIR/.." && pwd)
SERVER_NAME=$(basename "$UPSTREAM_DIR")
for entry in "$REPO_PARENT"/*; do
  [ "$(basename "$entry")" = "$SERVER_NAME" ] && continue
  ln -s "$entry" "$WORK/$(basename "$entry")"
done

STAGE="$WORK/$SERVER_NAME"
mkdir -p "$STAGE"
for entry in "$UPSTREAM_DIR"/*; do
  [ "$(basename "$entry")" = "src" ] && continue
  ln -s "$entry" "$STAGE/$(basename "$entry")"
done
cp -rs "$UPSTREAM_DIR/src" "$STAGE/src" || refuse "could not build shadow src tree"
rm -f "$STAGE/$SRC_REL" "$STAGE/$TEST_REL"
cp "$UPSTREAM_DIR/$SRC_REL"  "$STAGE/$SRC_REL"
cp "$UPSTREAM_DIR/$TEST_REL" "$STAGE/$TEST_REL"
chmod u+w "$STAGE/$SRC_REL" "$STAGE/$TEST_REL"

# Apply the fix on top. If it does not apply, refuse rather than scoring a tree
# we did not build.
UPSTREAM_SRC_SHA=$(sha256sum < "$STAGE/$SRC_REL" | cut -d' ' -f1)
( cd "$STAGE" && git apply -p2 "$PATCH" ) || refuse "patch does not apply to $UPSTREAM_DIR"
[ "$(sha256sum < "$STAGE/$SRC_REL" | cut -d' ' -f1)" != "$UPSTREAM_SRC_SHA" ] \
  || refuse "patch applied but changed nothing"

SRC="$STAGE/$SRC_REL"
BACKUP="$WORK/patched.ts"
cp "$SRC" "$BACKUP"
ORIGINAL_SHA=$(sha256sum < "$BACKUP" | cut -d' ' -f1)

# Run the suite against whatever is currently staged. Echoes rc only.
# Each run boots and tears down an embedded Postgres, so this is ~35s per mutant.
run_suite() {
  ( cd "$STAGE" && timeout 900 "$VITEST" run "$TEST_REL" >"$WORK/out.txt" 2>&1 ) && echo 0 || echo $?
}

# A skipped suite exits 0 and reads exactly like a pass. Belt and braces on the
# grep above: assert the run actually executed tests.
assert_tests_ran() {
  grep -Eq 'Tests +[0-9]+ (passed|failed)' "$WORK/out.txt" || {
    printf '  FAIL  suite reported no executed tests -- green here is vacuous\n'
    tail -20 "$WORK/out.txt" | sed 's/^/        /'
    exit 1
  }
}

PASS=0
FAIL=0

# --- 0. Baseline. The unmutated fix must be GREEN, or nothing below means
#        anything: a mutant "failing" a suite that was already red proves zero.
printf '\n=== baseline (unmutated) ===\n'
rc=$(run_suite)
assert_tests_ran
if [ "$rc" = "0" ]; then
  printf '  PASS  baseline green (rc=0) -- %s\n' "$(grep -Eo 'Tests +[0-9]+ passed \([0-9]+\)' "$WORK/out.txt" | head -1)"
  PASS=$((PASS + 1))
else
  printf '  FAIL  baseline is RED (rc=%s) -- every mutant result below is meaningless\n' "$rc"
  tail -25 "$WORK/out.txt" | sed 's/^/        /'
  exit 1
fi

# assert_mutant <label> <expect: red|green> <perl program...>
assert_mutant() {
  local label=$1 expect=$2; shift 2
  cp "$BACKUP" "$SRC"
  local applied=0
  for prog in "$@"; do
    if perl -0777 -pi -e "$prog" "$SRC"; then applied=1; fi
  done
  [ "$applied" = "1" ] || { printf '  FAIL  %-46s could not apply mutation\n' "$label"; FAIL=$((FAIL+1)); return; }

  # A mutation that changed no bytes is a rotted anchor pretending to be a pass.
  if [ "$(sha256sum < "$SRC" | cut -d' ' -f1)" = "$ORIGINAL_SHA" ]; then
    printf '  FAIL  %-46s anchor did not match; file unchanged\n' "$label"
    FAIL=$((FAIL + 1)); return
  fi

  local rc; rc=$(run_suite)
  if [ "$expect" = "red" ]; then
    if [ "$rc" != "0" ]; then
      printf '  PASS  %-46s killed (rc=%s)\n' "$label" "$rc"; PASS=$((PASS+1))
    else
      assert_tests_ran
      printf '  FAIL  %-46s SURVIVED -- suite is blind to this\n' "$label"; FAIL=$((FAIL+1))
    fi
  else
    if [ "$rc" = "0" ]; then
      assert_tests_ran
      printf '  PASS  %-46s decoy stayed green (rc=0)\n' "$label"; PASS=$((PASS+1))
    else
      printf '  FAIL  %-46s decoy went RED -- suite fails on unrelated edits\n' "$label"
      tail -15 "$WORK/out.txt" | sed 's/^/        /'
      FAIL=$((FAIL+1))
    fi
  fi
}

printf '\n=== under-delivery mutants (the original defect) ===\n'

# Exactly reverting the fix at the assignee gate. This is the mutant the
# acceptance criterion names: "reverting exactly the fix must turn the new
# assertion red".
assert_mutant "revert the exemption at the assignee gate" red \
  's/      !isNonAssigneeWorkspaceBusyRetry\(retryReason, context\) &&\n      \/\/ Checked last.*?\n      \/\/ so the common path never pays for this read\.\n      !\(await allowsAddressedInteractionWake\(db, \{\n        companyId: run\.companyId,\n        issueId,\n        agentId: run\.agentId,\n        contextSnapshot: context,\n      \}\)\)\n/      !isNonAssigneeWorkspaceBusyRetry(retryReason, context)\n/s'

# Revert the fix at the dependency gate only. That gate runs BEFORE the assignee
# gate in claimQueuedRun, so a fix applied only to the assignee gate leaves the
# 12-of-125 that died here still dead. If this survives, the suite is not
# covering the second call site and the fix is half a fix.
assert_mutant "revert the exemption at the dependency gate" red \
  's/      if \(\n        unresolvedBlockerCount > 0 &&\n        !allowsIssueInteractionWake\(context\) &&\n.*?      \) \{\n        await cancelQueuedRunForBlockedDependencies/      if (unresolvedBlockerCount > 0 \&\& !allowsIssueInteractionWake(context)) {\n        await cancelQueuedRunForBlockedDependencies/s'

# Make the exemption unreachable by keying it on a reason nothing ever fires.
# A "rename for consistency" that misses the wake site looks exactly like this.
assert_mutant "wake reason constant no longer matches" red \
  's/^export const ADDRESSED_INTERACTION_WAKE_REASON = "interaction_pending";$/export const ADDRESSED_INTERACTION_WAKE_REASON = "interaction_pending_v2";/m'

printf '\n=== over-delivery mutants (a weaker grant is not this fix) ===\n'

# THE mutant. Trust the wake context instead of the interaction row -- which is
# the fix the card literally proposed. Every "does the addressee run" test still
# passes; only the forgery test can tell the difference. If this survives, the
# suite is not constraining the implementation and the fix as written is
# unjustified.
assert_mutant "trust the context instead of the row" red \
  's/  const interaction = await dbOrTx\n    \.select\(\{/  return true;\n  const interaction = await dbOrTx\n    .select({/'

# Grant the exemption to any agent in the company, not just the addressee. This
# is the difference between "deliver the question to whom it was asked" and
# "let anyone run on any issue that has an open interaction".
assert_mutant "ignore the addressee" red \
  's/  return interaction\.addresseeAgentId === input\.agentId;/  return true;/'

# Keep waking on interactions that have already been answered or withdrawn. A
# resolved question is not a standing reason to run, and this is the mutant that
# would otherwise turn every historical interaction into a permanent wake.
assert_mutant "ignore the interaction status" red \
  's/  if \(interaction\.status !== "pending"\) return false;\n/  /'

# Accept a wake naming an interaction id with no matching row -- the same
# forgery as the context-only mutant, reached by a different edit. A `?? null`
# lookup that then fails open is a genuinely easy thing to write.
assert_mutant "fail open when the interaction row is absent" red \
  's/  if \(!interaction\) return false;/  if (!interaction) return true;/'

printf '\n=== decoy (must stay GREEN) ===\n'

# A real edit on a path this suite does not claim to cover: scope the interaction
# lookup by issue as well as company, or not. Dropping the issue predicate leaves
# every assertion here true -- each test seeds exactly one issue -- so if this
# goes red the suite is reacting to edits rather than to behaviour, and the seven
# kills above cannot be attributed to the mutations that caused them.
#
# (It is deliberately not a harmless edit: it IS a real narrowing of the lookup,
# and the fact that this suite cannot see it is stated in the doc rather than
# hidden. The company + interaction-id + addressee predicates still bound it.)
assert_mutant "interaction lookup unscoped by issue" green \
  's/        eq\(issueThreadInteractions\.issueId, input\.issueId\),\n//'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
