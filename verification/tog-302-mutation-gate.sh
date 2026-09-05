#!/usr/bin/env bash
# TOG-302 mutation gate.
#
# A green test suite proves nothing on its own: it may be green because the fix
# works, or green because the tests do not look at the thing the fix changed.
# This distinguishes the two by breaking the fix on purpose, one direction at a
# time, and requiring the suite to go red for each.
#
# Directions:
#   M1  drop the scope entirely            -> the original defect
#   M2  scope via contextSnapshot only     -> write guard satisfied, prompt still empty
#   M3  scope unconditionally to any issue -> would scope to done/backlog cards
#   M4  drop the assignee filter           -> would scope to another agent's issue
#   DECOY  a comment-only edit             -> must stay GREEN (proves the suite
#          is not merely reacting to the file being touched)
set -uo pipefail

SRC=/app/server/src/services/heartbeat.ts
TEST=src/__tests__/heartbeat-timer-wake-issue-scope.test.ts
ORIG=$(mktemp); cp "$SRC" "$ORIG"
trap 'cp "$ORIG" "$SRC"; rm -f "$ORIG"' EXIT

pass=0; fail=0

run_suite() { (cd /app/server && timeout 900 /app/node_modules/.bin/vitest run "$TEST" 2>&1 | tail -5); }

# expect=red  -> the mutant must be KILLED (suite fails)
# expect=green-> the suite must still pass
check() {
  local name="$1" expect="$2" out
  out=$(run_suite)
  if echo "$out" | grep -q "Tests .*failed"; then got=red; else got=green; fi
  if [ "$got" = "$expect" ]; then
    echo "  PASS  $name (expected $expect, got $got)"; pass=$((pass+1))
  else
    echo "  FAIL  $name (expected $expect, got $got)"; fail=$((fail+1))
  fi
  cp "$ORIG" "$SRC"
}

echo "== baseline (unmutated): expect green"
check "baseline" green

echo "== M1: remove the scope entirely (the original defect)"
perl -0pi -e 's/\Q...(timerIssueId ? { payload: { issueId: timerIssueId } } : {}),\E//' "$SRC"
check "M1 no scope" red

echo "== M2: scope via contextSnapshot only (no payload -> no taskId, no prompt)"
perl -0pi -e 's/\Q...(timerIssueId ? { payload: { issueId: timerIssueId } } : {}),\E//' "$SRC"
perl -0pi -e 's/(timerClaimWasFirstHeartbeat: timerClaim\.wasFirstHeartbeat,)/$1\n            ...(timerIssueId ? { issueId: timerIssueId } : {}),/' "$SRC"
check "M2 snapshot-only scope" red

echo "== M3: ignore the actionable-status filter (would scope to done/backlog)"
perl -0pi -e 's/\QinArray(issues.status, [...TIMER_ACTIONABLE_ISSUE_STATUSES]),\E//' "$SRC"
check "M3 no status filter" red

echo "== M4: drop the assignee filter (would scope to another agent's issue)"
perl -0pi -e 's/\Qeq(issues.assigneeAgentId, agent.id),\E//' "$SRC"
check "M4 no assignee filter" red

echo "== DECOY: comment-only change, must stay green"
perl -0pi -e 's/(async function findActionableTimerIssue)/\/\/ decoy\n  $1/' "$SRC"
check "decoy comment-only" green

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ] || exit 1
