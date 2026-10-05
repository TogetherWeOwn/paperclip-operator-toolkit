#!/usr/bin/env bash
# Mutation gate for plugins/dispatch.
#
# A green suite proves nothing on its own. This breaks the plugin one behaviour
# at a time and demands the suite goes RED for each. A mutation that stays green
# names a behaviour the tests assert nothing about.
#
# Each mutation targets a load-bearing decision from the dispatch plugin design,
# not an arbitrary token, so a survivor is a real coverage gap and not noise.
#
# Usage: verification/dispatch-plugin-mutation-gate.sh
# Exit 0 = every mutation was caught. Exit 1 = at least one survived.

set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/plugins/dispatch"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SRC_SEL="$PLUGIN_DIR/dist/selection.js"
SRC_REP="$PLUGIN_DIR/dist/reporting.js"
SRC_WRK="$PLUGIN_DIR/dist/worker.js"
SRC_MAN="$PLUGIN_DIR/dist/manifest.js"

for f in "$SRC_SEL" "$SRC_REP" "$SRC_WRK" "$SRC_MAN"; do
  cp "$f" "$WORK/$(basename "$f").orig"
done

restore() {
  for f in "$SRC_SEL" "$SRC_REP" "$SRC_WRK" "$SRC_MAN"; do
    cp "$WORK/$(basename "$f").orig" "$f"
  done
}
trap 'restore; rm -rf "$WORK"' EXIT

CAUGHT=0
SURVIVED=0
SURVIVOR_NAMES=()

# baseline: the unmutated suite must be green, or every result below is void.
echo "=== baseline (unmutated) ==="
if ! (cd "$PLUGIN_DIR" && npm test >"$WORK/baseline.log" 2>&1); then
  echo "FATAL: baseline suite is not green. Mutation results would be meaningless."
  tail -30 "$WORK/baseline.log"
  exit 1
fi
BASE_PASS=$(grep -aE 'pass [0-9]+' "$WORK/baseline.log" | grep -oE '[0-9]+' | head -1)
echo "baseline green (${BASE_PASS} passing)"
echo

# mutate <name> <file> <perl-expr> <description>
mutate() {
  local name="$1" file="$2" expr="$3" desc="$4"
  restore
  perl -0pi -e "$expr" "$file"

  # A mutation that does not change the file is a broken gate, not a pass.
  if cmp -s "$file" "$WORK/$(basename "$file").orig"; then
    echo "[BROKEN GATE] $name — the edit changed nothing; pattern did not match"
    SURVIVED=$((SURVIVED + 1))
    SURVIVOR_NAMES+=("$name (pattern did not apply)")
    return
  fi
  # The mutant must still parse, or we are testing the parser.
  if ! node --check "$file" 2>/dev/null; then
    echo "[BROKEN GATE] $name — mutant is not valid JS; would fail for the wrong reason"
    SURVIVED=$((SURVIVED + 1))
    SURVIVOR_NAMES+=("$name (syntax error)")
    return
  fi

  if (cd "$PLUGIN_DIR" && npm test >"$WORK/$name.log" 2>&1); then
    echo "[SURVIVED] $name — $desc"
    SURVIVED=$((SURVIVED + 1))
    SURVIVOR_NAMES+=("$name: $desc")
  else
    local nfail
    nfail=$(grep -cE '^not ok|^✖|✗' "$WORK/$name.log" 2>/dev/null || echo "?")
    echo "[caught]   $name — $desc"
    CAUGHT=$((CAUGHT + 1))
  fi
}

echo "=== mutations ==="

# 1. THE safety-critical one: installing must not be what enables waking.
mutate "wake-default-on" "$SRC_MAN" \
  's/(wakeEnabled: \{[^}]*?default: )false/${1}true/s' \
  "manifest defaults wakeEnabled to true"

# 2. Config read: a missing flag must not read as enabled.
mutate "wake-config-truthy" "$SRC_WRK" \
  's/wakeEnabled: raw\.wakeEnabled === true/wakeEnabled: raw.wakeEnabled !== false/' \
  "absent config reads as wake-enabled"

# 3. ADR 0003 idle rail: updatedAt must never be the anchor.
mutate "idle-from-updatedat" "$SRC_SEL" \
  's/const created = toMillis\(issue\.createdAt\);/const created = toMillis(issue.updatedAt ?? issue.createdAt);/' \
  "idle falls back to updatedAt instead of createdAt"

# 4. Idle must be scoped to THIS issue's runs.
mutate "idle-unscoped-runs" "$SRC_SEL" \
  's/\.filter\(\(run\) => run\.issueId === issue\.id\)/.filter(() => true)/' \
  "idle counts runs belonging to other issues"

# 5. Server rail order: assignee is checked before status.
mutate "rail-order-swap" "$SRC_SEL" \
  's/(  if \(!issue\.assigneeAgentId\) \{\n    return \{ outcome: "refused_unassigned" \};\n  \}\n)(  if \(WAKEUP_REFUSED_STATUSES\.includes\(issue\.status\)\) \{\n    return \{ outcome: "refused_backlog" \};\n  \}\n)/${2}${1}/s' \
  "status rail evaluated before the assignee rail"

# 6. Blocker rail must ignore blockers that are done.
mutate "blocker-rail-any" "$SRC_SEL" \
  's/blockedBy\.some\(\(blocker\) => blocker\.status !== "done"\)/blockedBy.length > 0/' \
  "a done blocker still refuses the issue"

# 7. The unblock_descriptor park rail (ADR 0003).
mutate "park-rail-dropped" "$SRC_SEL" \
  's/  return descriptor !== null && descriptor !== undefined;/  return false;/' \
  "an issue parked on a named owner is woken anyway"

# 8. Per-assignee coalescing (ADR 0001).
mutate "no-assignee-spread" "$SRC_SEL" \
  's/if \(claimed\.has\(agentId\)\) \{/if (false) {/' \
  "two picks for one agent in a single firing"

# 9. Focus filter must narrow selection, never the counters.
mutate "focus-before-counters" "$SRC_SEL" \
  's/    if \(focus\.size > 0 && !focus\.has\(issue\.projectId\)\) \{\n      outOfFocus \+= 1;\n      continue;\n    \}\n//s' \
  "focus filter removed from selection entirely"

# 10. deadlocked_agents must stay null, never a fabricated 0.
mutate "deadlocked-fabricated" "$SRC_SEL" \
  's/      deadlocked_agents: null,/      deadlocked_agents: 0,/' \
  "deadlocked_agents fabricated as 0"

# 11. ...and must therefore never be written as a metric.
mutate "deadlocked-written" "$SRC_REP" \
  's/    if \(typeof value !== "number"\) continue;/    if (false) continue;/' \
  "a null legacy counter is written as a metric anyway"

# 12. Metrics must be written every firing, not only on a change.
mutate "metrics-gated-on-change" "$SRC_WRK" \
  's/  await emitMetrics\(ctx, \{ companyId, summary, wakeEnabled: config\.wakeEnabled \}\);/  if (false) await emitMetrics(ctx, { companyId, summary, wakeEnabled: config.wakeEnabled });/' \
  "metrics suppressed, so silence becomes indistinguishable from zero"

# 13. Activity must be withheld when nothing changed.
mutate "activity-every-firing" "$SRC_REP" \
  's/  if \(!previous\) return true;/  return true;/' \
  "an activity line every firing, even with no change"

# 14. Idle ms must stay out of the state comparison.
mutate "idlems-in-state" "$SRC_REP" \
  's/    wakeFailures: \[\.\.\.\(summary\.wakeFailures \?\? \[\]\)\]\.sort\(\),/    wakeFailures: [...(summary.wakeFailures ?? [])].sort(), _idle: summary.idleMs ?? Math.random(),/' \
  "idle milliseconds folded into the state-change comparison"

# 15. ADR 0004: a refusal must not abort the remaining picks.
mutate "wake-no-try-catch" "$SRC_WRK" \
  's/    \} catch \(error\) \{\n      const message = error instanceof Error \? error\.message : String\(error\);/    } catch (error) {\n      throw error;\n      const message = error instanceof Error ? error.message : String(error);/s' \
  "one refused wake aborts every later pick"

# 16. A wake must be counted only when the server actually queued it.
mutate "woken-counts-attempts" "$SRC_REP" \
  's/woken: wakeOutcomes\.filter\(\(o\) => o\.queued\)\.length/woken: wakeOutcomes.length/' \
  "woken counts attempts rather than queued runs"

# 17. Report-only must call requestWakeup zero times.
mutate "report-only-wakes" "$SRC_WRK" \
  's/  const wakeOutcomes = config\.wakeEnabled\n    \? await wakePicks\(ctx, companyId, selection\.picks, job\.runId\)\n    : \[\];/  const wakeOutcomes = await wakePicks(ctx, companyId, selection.picks, job.runId);/s' \
  "report-only mode wakes anyway"

# 18. One company's failure must not stop the sweep.
mutate "company-loop-fatal" "$SRC_WRK" \
  's/        \} catch \(error\) \{\n          \/\/ One company/        } catch (error) {\n          throw error;\n          \/\/ One company/s' \
  "a failing company aborts the whole sweep"

# 19. Terminal cards must be excluded from the counted population.
mutate "terminal-counted" "$SRC_SEL" \
  's/export const TERMINAL_STATUSES = \["done", "cancelled"\];/export const TERMINAL_STATUSES = [];/' \
  "done and cancelled cards counted as refusals"

# 20. The routing gap must count only unassigned non-terminal work.
mutate "routing-gap-all" "$SRC_SEL" \
  's/\.filter\(\(issue\) => !TERMINAL_STATUSES\.includes\(issue\.status\) && !issue\.assigneeAgentId\)/.filter((issue) => !issue.assigneeAgentId)/' \
  "routing gap counts terminal unassigned cards too"

# 21. The partial-list flag must travel with the owner list.
mutate "owners-claim-complete" "$SRC_SEL" \
  's/    complete: false,/    complete: true,/' \
  "a partial routing-owner list reports itself as complete"

restore
echo
echo "=== result ==="
echo "caught:   $CAUGHT"
echo "survived: $SURVIVED"
if [ "$SURVIVED" -gt 0 ]; then
  echo
  echo "Survivors (behaviour the suite does not assert):"
  for s in "${SURVIVOR_NAMES[@]}"; do echo "  - $s"; done
  exit 1
fi
echo "every mutation was caught."
exit 0
