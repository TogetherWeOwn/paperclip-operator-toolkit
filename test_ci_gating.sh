#!/usr/bin/env bash
# test_ci_gating.sh -- CI entry point for the change-gating contract.
# 1. The structural gate over the real .github/workflows/ci.yml.
# 2. Positive controls: mutated workflow copies that MUST turn the gate red
#    (a gate that has only ever seen the healthy file has never shown it can
#    fail). Exit 0 all green, 1 anything red.
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
GATE="$ROOT/verification/ci-gating.sh"
WORKFLOW="$ROOT/.github/workflows/ci.yml"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
expect_pass() {
  local name=$1 file=$2
  if "$GATE" "$file" >"$TMP/out" 2>&1; then
    printf 'ok - %s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'not ok - %s\n' "$name"
    cat "$TMP/out"
    fail=$((fail + 1))
  fi
}
expect_fail() {
  local name=$1 file=$2
  if "$GATE" "$file" >"$TMP/out" 2>&1; then
    printf 'not ok - %s (mutant survived)\n' "$name"
    cat "$TMP/out"
    fail=$((fail + 1))
  else
    printf 'ok - %s\n' "$name"
    pass=$((pass + 1))
  fi
}
mutate() {
  local name=$1 old=$2 new=$3
  MUTANT_FILE="$TMP/$name.yml"
  python3 - "$WORKFLOW" "$MUTANT_FILE" "$old" "$new" <<'PY'
from pathlib import Path
import sys

src, dst, old, new = sys.argv[1:]
text = Path(src).read_text()
if old not in text:
    raise SystemExit(f"mutation anchor absent: {old!r}")
mutant = text.replace(old, new, 1)
if mutant == text:
    raise SystemExit("mutation did not change the workflow")
Path(dst).write_text(mutant)
PY
}

printf '# structural gate over the real workflow\n'
expect_pass baseline "$WORKFLOW"

printf '# positive controls: each mutant must turn the gate red\n'
# The fail-dangerous direction: needs deleted, area if stays -> the job would
# skip on every PR while its required check reports success.
mutate needs-deleted '  dispatch-suite:
    name: dispatch suite
    needs: [changes]' '  dispatch-suite:
    name: dispatch suite
    # needs dropped'
expect_fail needs-deleted "$MUTANT_FILE"
# The area test deleted: the job would test an output the detector never
# publishes, so it skips on every PR while the gate must still catch it.
mutate heavy-if-deleted "needs.changes.outputs.heavy" "needs.changes.outputs.full"
expect_fail heavy-if-deleted "$MUTANT_FILE"
# The aggregator conditional: without a status function, ci-ok implies
# success() and skips whenever a needed job failed, so the merge gate hangs
# instead of going red. The anchor carries the ci-ok step name so the mutant
# lands on the aggregator, not on another `if:` line.
mutate ci-ok-not-status-fn '    if: ${{ !cancelled() }}
    needs:' '    if: success()
    needs:'
expect_fail ci-ok-not-status-fn "$MUTANT_FILE"
# always() on the aggregator ignores cancellation, so a superseded run's
# ci-ok queues behind the new head and stalls the PR concurrency group.
mutate ci-ok-always '    if: ${{ !cancelled() }}
    needs:' '    if: always()
    needs:'
expect_fail ci-ok-always "$MUTANT_FILE"
# Even the lightweight aggregator needs a bounded runtime.
mutate ci-ok-timeout-dropped '  ci-ok:
    name: ci-ok
    runs-on: ubuntu-latest
    timeout-minutes: 5' '  ci-ok:
    name: ci-ok
    runs-on: ubuntu-latest'
expect_fail ci-ok-timeout-dropped "$MUTANT_FILE"
# A workflow-level paths filter on pull_request silences required checks on
# PRs outside it.
mutate workflow-paths '    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:' '    types: [opened, synchronize, reopened, ready_for_review]
    paths:
      - plugins/**
  merge_group:'
expect_fail workflow-paths "$MUTANT_FILE"
# Dropping ready_for_review strands a draft that flips to ready on its
# all-skipped draft verdict with ci-ok green.
mutate ready-for-review-dropped 'types: [opened, synchronize, reopened, ready_for_review]' 'types: [opened, synchronize, reopened]'
expect_fail ready-for-review-dropped "$MUTANT_FILE"
# The full-history checkout is load-bearing for the merge-base diff: without
# it the detector dies before emitting anything on PR merge refs.
mutate fetch-depth-dropped '          fetch-depth: 0
      - id: detect' '      - id: detect'
expect_fail fetch-depth-dropped "$MUTANT_FILE"
# The base must come from merge-base, not a bare range endpoint.
mutate merge-base-removed 'merge_base="$(git merge-base "$BASE_SHA" "$HEAD_SHA")"' 'merge_base="$BASE_SHA"'
expect_fail merge-base-removed "$MUTANT_FILE"
# Rename detection reports only the destination: moving code into docs/
# would hide the source path and skip the affected suite.
mutate no-renames-dropped 'git diff --no-renames --name-only' 'git diff --name-only'
expect_fail no-renames-dropped "$MUTANT_FILE"
# The fail-dangerous direction on the privilege job itself: needs deleted,
# area if stays -> the enforcement suite skips on every PR while its
# required check reports success.
mutate privilege-needs-deleted '  privilege-suites:
    name: Privilege ceiling suites
    needs: [changes]' '  privilege-suites:
    name: Privilege ceiling suites
    # needs dropped'
expect_fail privilege-needs-deleted "$MUTANT_FILE"
# Without the nightly full run, a slipped regression waits for the next
# main push to be caught.
mutate schedule-deleted '  schedule:' '  # schedule deleted:'
expect_fail schedule-deleted "$MUTANT_FILE"
# The detector gated: a changes job with its own if can skip, and every
# gated job then evaluates against undefined outputs (silent skip).
mutate changes-gated '  changes:
    name: Change detection' '  changes:
    if: github.event_name == '"'"'pull_request'"'"'
    name: Change detection'
expect_fail changes-gated "$MUTANT_FILE"
# Scans gated: a secret-scan job with needs/if can skip on exactly the
# docs-only PRs where every heavy suite also skips -- the committed secret
# would then merge with ci-ok green.
mutate scan-gated '  secret-scan:
    name: secret scan' '  secret-scan:
    needs: [changes]
    if: needs.changes.outputs.heavy == '"'"'true'"'"'
    name: secret scan'
expect_fail scan-gated "$MUTANT_FILE"
# ci-ok blind to secrets: secret-scan dropped from needs, so a red scan no
# longer fails the aggregator on a docs-only PR.
mutate ciok-blind-to-scan '      - disclosure-scan
      - secret-scan
      - model-selection-impact
      - model-selection-mutants
      - model-selection-suite
    steps:
      - name: Aggregate gated results' '      - disclosure-scan
      - model-selection-impact
      - model-selection-mutants
      - model-selection-suite
    steps:
      - name: Aggregate gated results'
expect_fail ciok-blind-to-scan "$MUTANT_FILE"

printf '%s passed, %s failed\n' "$pass" "$fail"
(( fail == 0 ))
