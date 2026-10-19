#!/usr/bin/env bash
# Repo-placement acceptance test for Land #942 (test-missing gate workflow).
#
# THE RISK THIS EXISTS FOR. PR TogetherWeOwn/paperclip-ops-tooling#942 adds
# the deterministic test-missing/wrong gate (stdlib-only, no network, no
# clock) plus its staged org drop: the reusable gate workflow, the thin
# required wrapper, the verbatim logic copy, the adoption guide, the
# report-only/required ruleset twins, and this repo's warn-only caller. The
# shared logic and the staged drop are public-able, so the repo-placement
# gate requires the mirror to live in THIS public repo. Until it is mirrored
# here, the landing is not complete: the gate exists nowhere consumers can
# adopt it with one uses: line, and the blocker class stays a model judgment.
#
# What this pins, hermetically (no network, no credential):
#   1. the gate exists at this repo's root as blocker_test_checks.py;
#   2. it is stdlib-only, so every consumer runtime can import the one file;
#   3. it exposes the API the behavioral suite (test_test_missing_gate.py)
#      exercises;
#   4. the staged org drop exists under templates/org-github/test-missing/
#      with the reusable workflow_call gate, the pull_request + merge_group
#      wrapper, the verbatim logic copy, the adoption guide, and the
#      report-only/active ruleset twins that differ only in enforcement.
#   (This repo's warn-only caller is deliberately NOT part of the mirror: the
#   staged org pin resolves nowhere yet, so the caller lands in the repin
#   follow-up and this suite asserts its absence until then.)
#
# RED (before the fix): the mirror files are absent, which IS the placement
# risk reproduced. GREEN (after): all pass. The Builder adds the mirror on
# this branch without touching test files.
# Exit 0 all green, 1 anything red. Requires bash, python3.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/blocker_test_checks.py"
STAGE="$HERE/templates/org-github/test-missing"
RULESETS="$HERE/templates/org-github/rulesets"
READMEMAP="$HERE/templates/org-github/README.md"
CALLER="$HERE/.github/workflows/test-missing.yml"
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

command -v python3 >/dev/null 2>&1 || { echo "test_test_missing_gate_placement: python3 is required" >&2; exit 2; }

hdr "Repo-placement: the public gate lives in the public repo"

[[ -f "$GUARD" ]]
assert $? "the deterministic gate is mirrored at blocker_test_checks.py in TogetherWeOwn/paperclip-operator-toolkit" \
  "blocker_test_checks.py absent -- placement risk reproduced (deterministic check lives nowhere adoptable)"

if [[ -f "$GUARD" ]]; then
  # Stdlib-only: every top-level import must resolve to the standard library,
  # so CI gates and consumer repos can all import the one file.
  python3 - "$GUARD" <<'PY'
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
  assert $? "the mirrored gate imports stdlib only" \
    "a third-party import strands every consumer runtime that only has stdlib"

  for sym in is_test_path is_src_path check_src_without_tests check_changed_line_coverage check_test_guards; do
    grep -qE "^(def $sym|TEST_EXEMPT_LABEL)" "$GUARD" 2>/dev/null || grep -qE "^def $sym\(" "$GUARD"
    assert $? "the mirrored gate exposes $sym" \
      "test_test_missing_gate.py exercises $sym -- a renamed API leaves the suite erroring"
  done

  grep -q 'TEST_EXEMPT_LABEL = "tests-exempt"' "$GUARD"
  assert $? "the mirrored gate pins the tests-exempt waive label" \
    "the waive label is the escape hatch -- a renamed label silently re-fails exempt PRs"
fi

hdr "Staged org drop: one reusable gate every repo adopts"

[[ -f "$STAGE/test-missing-gate.yml" ]]
assert $? "staged reusable gate exists at templates/org-github/test-missing/test-missing-gate.yml" \
  "absent -- the org has no one-line adoptable gate"

if [[ -f "$STAGE/test-missing-gate.yml" ]]; then
  grep -q "workflow_call:" "$STAGE/test-missing-gate.yml"
  assert $? "the staged gate is a reusable workflow_call workflow" \
    "without workflow_call no repo can adopt it with one uses: line"

  grep -q 'default: "warn"' "$STAGE/test-missing-gate.yml"
  assert $? "the staged gate defaults to warn mode" \
    "warn-first is the rollout rule -- a default-enforce gate fails repos before the FP rate is measured"

  grep -q "timeout-minutes:" "$STAGE/test-missing-gate.yml"
  assert $? "every staged gate job carries a timeout bound" \
    "an unbounded gate job can hang the required check forever"

  python3 - "$STAGE/test-missing-gate.yml" <<'PY'
import re, sys
key = re.compile(r'^\s*(?:-\s+)?uses:')
anchored = re.compile(r'uses:\s*\S+@[0-9a-f]{40}(?:\s|$|#)')
bad = [l.rstrip("\n") for l in open(sys.argv[1]) if key.match(l) and not anchored.search(l)]
if bad:
    print("unanchored or non-40-hex pin:")
    for l in bad:
        print("  " + l.strip())
    sys.exit(1)
PY
  assert $? "staged gate actions are SHA-pinned to exactly 40 hex, never a moving tag" \
    "an unanchored prefix match lets a 43-char (unresolvable) ref through"
fi

[[ -f "$STAGE/test-missing-required.yml" ]]
assert $? "thin required wrapper exists at templates/org-github/test-missing/test-missing-required.yml" \
  "absent -- no org ruleset can require the workflow"

if [[ -f "$STAGE/test-missing-required.yml" ]]; then
  grep -q "pull_request:" "$STAGE/test-missing-required.yml"
  assert $? "the required wrapper triggers on pull_request" \
    "without it the required check never runs on PRs"

  grep -q "merge_group:" "$STAGE/test-missing-required.yml"
  assert $? "the required wrapper triggers on merge_group" \
    "without it the merge queue has no required signal"

  grep -q "name: test-missing" "$STAGE/test-missing-required.yml"
  assert $? "the required wrapper re-exports the bare test-missing check" \
    "the ruleset requires the check by name -- a renamed check leaves the ruleset pointing nowhere"
fi

hdr "Staged logic copy: fix upstream, then re-copy"

[[ -f "$STAGE/blocker_test_checks.py" ]]
assert $? "staged logic copy exists at templates/org-github/test-missing/blocker_test_checks.py" \
  "absent -- the org drop ships no logic to run"

if [[ -f "$GUARD" && -f "$STAGE/blocker_test_checks.py" ]]; then
  cmp -s "$GUARD" "$STAGE/blocker_test_checks.py"
  assert $? "the staged copy is verbatim (fix upstream, then re-copy)" \
    "a hand-edited copy drifts from the tested root source"
fi

hdr "Adoption guide and ruleset twins"

[[ -f "$STAGE/ADOPTION.md" ]]
assert $? "adoption guide exists at templates/org-github/test-missing/ADOPTION.md" \
  "absent -- repos have no caller snippet to copy"

if [[ -f "$STAGE/ADOPTION.md" ]]; then
  grep -q "@<pinned-sha>" "$STAGE/ADOPTION.md"
  assert $? "the adoption guide carries a pinned-SHA caller snippet" \
    "a branch-name snippet lets the gate move under repos without review"

  grep -q "warn" "$STAGE/ADOPTION.md"
  assert $? "the adoption guide documents warn mode" \
    "repos must land warn-first before any enforce flip"
fi

if [[ -f "$RULESETS/test-missing-report-only.json" && -f "$RULESETS/test-missing-required.json" ]]; then
  python3 - "$RULESETS" <<'PY'
import json, sys
base = sys.argv[1]
s1 = json.loads(open(base + "/test-missing-report-only.json").read())
s2 = json.loads(open(base + "/test-missing-required.json").read())
assert s1.get("enforcement") == "evaluate", "report-only must evaluate"
assert s2.get("enforcement") == "active", "required must be active"
strip = lambda d: {k: v for k, v in d.items() if k not in ("enforcement", "_comment")}
assert strip(s1) == strip(s2), "twins must differ only in enforcement"
wfs = [w for r in s1.get("rules", []) if r.get("type") == "workflows"
       for w in r.get("parameters", {}).get("workflows", [])]
assert wfs, "ruleset must carry a workflows entry"
assert any(w.get("repository_id") == "REPO_ID_OF_DOT_GITHUB" for w in wfs), \
    "repository_id stays a string placeholder until the runbook fills it"
conds = s1.get("conditions", {})
assert any(k in conds for k in ("repository_name", "repository_id", "repository_property")), \
    "org rulesets require a repository scope next to ref_name"
PY
  assert $? "ruleset twins exist and differ only in enforcement, with a workflows placeholder" \
    "an enforce flip that smuggles a rule change was never measured in report-only"
else
  assert 1 "ruleset twins exist at templates/org-github/rulesets/test-missing-{report-only,required}.json" \
    "absent -- the staged rollout has no report-only then required path"
fi

if [[ -f "$READMEMAP" ]]; then
  for f in "test-missing/test-missing-gate.yml" "test-missing/test-missing-required.yml" "test-missing/blocker_test_checks.py" "test-missing/ADOPTION.md" "rulesets/test-missing-report-only.json" "rulesets/test-missing-required.json"; do
    grep -qF "$f" "$READMEMAP"
    assert $? "README destination map names $f" \
      "an unmapped staged file has no documented destination or applier"
  done
else
  assert 1 "README destination map names every new staged file" \
    "templates/org-github/README.md absent -- staged files have no documented destinations"
fi

hdr "Wiring: caller deferred until the org pin resolves"

# The staged org pin names no commit containing the reusable workflow, and
# GitHub resolves called workflows at parse time: a caller landing now turns
# every PR red (0 jobs, "workflow was not found"). The caller lands in the
# repin follow-up instead; that PR restores the pinned-SHA + warn-mode
# assertions here.
if [[ -f "$CALLER" ]]; then
  assert 1 "this repo's warn-only caller stays out until the repin PR lands" \
    "present with an unresolvable org pin -- every PR gets a red test-missing run at parse time"
else
  assert 0 "this repo's warn-only caller stays out until the repin PR lands"
fi

if [[ -f "$STAGE/test-missing-gate.yml" ]]; then
  grep -q "needs.detect.result" "$STAGE/test-missing-gate.yml" && grep -q "needs.test-missing.result" "$STAGE/test-missing-gate.yml"
  assert $? "the test-missing-ok aggregator reads both gate needs results" \
    "an aggregator that never reads needs results stays green when the gate fails"

  # Pin the fail-closed fix: the aggregator block must carry an `exit 1`
  # guarded by mode (warn stays advisory, anything else fails). Deleting the
  # failing branch removes `exit 1` and must turn this red.
  python3 - "$STAGE/test-missing-gate.yml" <<'PY'
import re, sys
agg = open(sys.argv[1]).read().split("test-missing-ok:")[-1]
assert re.search(r'if\s+\[\[\s*"\$\{NEEDS_DETECT\}"', agg), "aggregator guards on needs results"
assert re.search(r'\[\[\s*"\$\{GATE_MODE\}"\s*==\s*"warn"\s*\]\]', agg), "warn stays advisory"
assert "exit 1" in agg, "aggregator fails the run outside warn mode"
PY
  assert $? "the test-missing-ok aggregator fails closed (exit 1) outside warn mode" \
    "without a mode-guarded exit 1 the always-green aggregator can regress silently"

  grep -q 'event == "merge_group"' "$STAGE/test-missing-gate.yml"
  assert $? "merge_group runs skip the label-dependent check and rely on the PR-time run" \
    "merge_group payloads carry no labels, so the tests-exempt waiver would never apply in queue"

  # Behavioural-test wiring pins: the embedded gate script regressed
  # silently under grep-only checks (waiver invert, enforce narrowing,
  # unknown-mode exit 2 removal, GATE_EVENT mis-wire, merge_group base
  # drop, and continue-on-error: true all passed 32/0 and 35/0). The unit
  # matrix executes the extracted script; these pins kill the
  # non-python mutants at the YAML level.
  [[ "$(grep -c 'GATE_EVENT: ${{ github.event_name }}' "$STAGE/test-missing-gate.yml")" -ge 2 ]]
  assert $? "the gate wires GATE_EVENT from github.event_name in detect and check jobs" \
    "a mis-wired GATE_EVENT silently changes merge_group/push handling with no failing test"

  grep -qF 'GATE_CHANGED: ${{ needs.detect.outputs.changed }}' "$STAGE/test-missing-gate.yml"
  assert $? "the check job wires GATE_CHANGED from the detect outputs" \
    "an empty GATE_CHANGED sees no files, so enforcing never fails with no failing test"

  grep -qF "GATE_LABELS: \${{ join(github.event.pull_request.labels.*.name, ',') }}" "$STAGE/test-missing-gate.yml"
  assert $? "the check job wires GATE_LABELS from the pull-request labels" \
    "a blank GATE_LABELS breaks the tests-exempt waiver with no failing test"

  [[ "$(grep -c 'GATE_MODE: ${{ inputs.mode }}' "$STAGE/test-missing-gate.yml")" -ge 2 ]]
  assert $? "the check and aggregator jobs wire GATE_MODE from inputs.mode" \
    "a hard-wired GATE_MODE warn keeps enforcing green with no failing test"

  grep -qF 'changed: ${{ steps.diff.outputs.changed }}' "$STAGE/test-missing-gate.yml"
  assert $? "the detect job exposes the diff via steps.diff.outputs.changed" \
    "a blanked detect output starves the gate with no failing test"

  grep -qF 'GATE_PR_BASE: ${{ github.event.pull_request.base.sha }}' "$STAGE/test-missing-gate.yml"
  assert $? "the detect job diffs the pull-request base SHA" \
    "a GATE_PR_BASE pointed at head.sha diffs to an empty set with no failing test"

  [[ "$(grep -c 'fetch-depth: 0' "$STAGE/test-missing-gate.yml")" -ge 2 ]]
  assert $? "both checkouts fetch full history (fetch-depth 0)" \
    "a shallow checkout cannot fetch the base SHA, so the diff is empty with no failing test"

  grep -qF -- '--diff-filter=AMR' "$STAGE/test-missing-gate.yml"
  assert $? "the detect diff keeps renames for the R100 drop (--diff-filter=AMR)" \
    "a bare AM filter drops renamed-and-edited files, a silent pass in enforcing mode"

  grep -q 'R100' "$STAGE/test-missing-gate.yml"
  assert $? "the detect diff drops only pure renames (R100)" \
    "without the R100 drop a pure rename counts as a new src file and false-fails"

  if grep -qF -- '--diff-filter=AM "' "$STAGE/test-missing-gate.yml"; then
    assert 1 "the detect diff never uses the bare AM filter" \
      "bare AM drops every rename including renamed-and-edited files (silent pass in enforcing mode)"
  else
    assert 0 "the detect diff never uses the bare AM filter"
  fi

  grep -q 'core.quotePath=false' "$STAGE/test-missing-gate.yml"
  assert $? "the detect diff lists non-ASCII paths unquoted (core.quotePath=false)" \
    "a quoted octal path never matches .py so an untested non-ASCII src silently passes"

  grep -qF "f.startswith('\"')" "$STAGE/test-missing-gate.yml" && grep -q "unclassifiable quoted path" "$STAGE/test-missing-gate.yml"
  assert $? "the mode-aware gate fails closed on still-quoted paths (\" or \\ in the name)" \
    "core.quotePath=false covers only non-ASCII -- a quoted entry would otherwise silently pass; the guard lives in the gate (which knows the mode), never in detect (which has no mode and would red even warn-mode wrappers)"

  grep -q 'set -euo pipefail' "$STAGE/test-missing-gate.yml"
  assert $? "the detect run block sets pipefail (git|awk fails closed)" \
    "without pipefail a git failure writes an empty changed list and the gate passes"

  grep -qF 'GATE_BASE="${GATE_PR_BASE:-${GATE_MERGE_BASE:-}}"' "$STAGE/test-missing-gate.yml"
  assert $? "the detect job falls back from PR base to merge_group base" \
    "dropping the merge fallback diffs other queued PRs files with no failing test"

  grep -q 'print $NF' "$STAGE/test-missing-gate.yml"
  assert $? "the detect else branch lists the new path (print \$NF)" \
    "printing \$2 lists the old deleted path for renames with no failing test"

  grep -q 'HEAD~1 HEAD' "$STAGE/test-missing-gate.yml"
  assert $? "the detect fallback diffs HEAD~1 (not HEAD~2)" \
    "a HEAD~2 fallback diffs two commits of files with no failing test"

  if [[ -f "$STAGE/ADOPTION.md" ]]; then
    grep -q 'core.quotePath=false' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet lists non-ASCII paths unquoted" \
      "a copy-paste adopter regains the quoted-path silent pass"

    grep -qF -- '--diff-filter=AMR' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet keeps renames for the R100 drop" \
      "a copy-paste adopter with bare AM regains the rename-and-edit hole"

    grep -q 'R100' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet drops only pure renames (R100)" \
      "without the R100 drop a copy-paste adopter false-fails pure renames"

    grep -q -- '--name-status' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet uses --name-status (status-aware drop)" \
      "--name-only cannot drop pure renames so a copy-paste adopter regains the hole"

    grep -q "awk -F'\\\\t'" "$STAGE/ADOPTION.md" || grep -q 'awk -F' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet keeps the R100 awk stage" \
      "dropping the awk stage lists pure renames as new src files for adopters"

    grep -q 'set -euo pipefail' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet sets pipefail" \
      "without pipefail an adopter git failure passes the gate"

    grep -qF "f.startswith('\"')" "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet routes still-quoted paths to the gate (relevant=true)" \
      "a copy-paste adopter with a quotePath-only diff regains the silent pass on \" or \\ names; adoption detect has no mode so it must stay green and let the mode-aware gate decide"

    grep -q 'HEAD~1 HEAD' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet fallback diffs HEAD~1 (not HEAD~2)" \
      "a HEAD~2 fallback diffs two commits of files for copy-paste adopters"

    grep -q 'print $NF' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet fallback lists the new path (print \$NF)" \
      "printing \$2 lists the old deleted path for renames with no failing test"

    if grep -qF -- '--diff-filter=AM "' "$STAGE/ADOPTION.md"; then
      assert 1 "the adoption snippet never uses the bare AM filter" \
        "bare AM drops every rename including renamed-and-edited files for copy-paste adopters"
    else
      assert 0 "the adoption snippet never uses the bare AM filter"
    fi

    grep -q 'relevant: ${{ steps.diff.outputs.relevant }}' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet exposes the relevant output" \
      "without the output the adopter gate never knows whether to run"

    grep -q 'echo "relevant=${relevant}"' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet writes the relevant output" \
      "a snippet that never writes relevant starves its own gate"

    # The fixture sets GATE_PR_BASE directly, so these YAML wirings
    # regress silently without exact-line pins: base.sha->head.sha diffs
    # an empty set, fetch-depth 1 cannot fetch the base, `always()` runs
    # the gate on docs-only PRs, and a non-warn mode fails adopter runs.
    grep -qF 'GATE_PR_BASE: ${{ github.event.pull_request.base.sha }}' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet diffs the pull-request base SHA" \
      "a GATE_PR_BASE pointed at head.sha diffs to an empty set with no failing test"

    grep -q 'fetch-depth: 0' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet fetches full history (fetch-depth 0)" \
      "a shallow checkout cannot fetch the base SHA, so the diff is empty with no failing test"

    grep -qF "if: needs.detect.outputs.relevant == 'true'" "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet gates the gate job on relevant" \
      "an always() gate burns a runner on docs-only PRs against the change-gating policy"

    grep -qF 'mode: warn' "$STAGE/ADOPTION.md"
    assert $? "the adoption snippet lands in warn mode" \
      "adopters must land warn-first before any enforce flip"
  else
    assert 1 "the adoption snippet carries the detect pins" \
      "ADOPTION.md absent -- adopter copy-paste has no pinned snippet"
  fi

  grep -q 'merge_group.base_sha' "$STAGE/test-missing-gate.yml"
  assert $? "the detect job diffs the merge_group base_sha in queue runs" \
    "dropping the merge_group base diffs other queued PRs files with no failing test"

  grep -q "continue-on-error: \${{ inputs.mode == 'warn' }}" "$STAGE/test-missing-gate.yml"
  assert $? "the gate job fails the run outside warn mode (mode-guarded continue-on-error)" \
    "forcing continue-on-error true for all modes makes enforcing advisory with no failing test"

  if grep -q "continue-on-error: true" "$STAGE/test-missing-gate.yml"; then
    assert 1 "the gate job never hard-codes continue-on-error true" \
      "a literal true keeps enforcing green when the gate finds src without tests"
  else
    assert 0 "the gate job never hard-codes continue-on-error true"
  fi

  grep -q '\.test\.' "$STAGE/test-missing-gate.yml" && grep -q '\.spec\.' "$STAGE/test-missing-gate.yml"
  assert $? "the embedded is_test treats *.test.* and *.spec.* as tests" \
    "without the colocated patterns the shipped workflow flags its own test files as src"

  # The behavioural matrix itself must stay: deleting it re-opens the
  # silent-regression window the 4/5 review found.
  grep -q "EmbeddedGateScriptTest" "$HERE/test_test_missing_gate.py" && \
    grep -q "merge_group" "$HERE/test_test_missing_gate.py" && \
    grep -q "Enforcing" "$HERE/test_test_missing_gate.py" && \
    grep -q "AdoptionSnippetFixtureTest" "$HERE/test_test_missing_gate.py" && \
    grep -q "relevant" "$HERE/test_test_missing_gate.py"
  assert $? "the embedded gate script has a behavioural case matrix in the unit suite" \
    "without the matrix the waiver/mode/merge_group mutants survive both suites again"
fi

if [[ -f "$STAGE/test-missing-required.yml" ]]; then
  grep -q '\./\.github/workflows/test-missing-gate\.yml' "$STAGE/test-missing-required.yml"
  assert $? "the required wrapper calls the co-landed gate path" \
    "the wrapper and gate land together in TogetherWeOwn/.github -- a renamed path strands the required check"

  grep -q "stage 1" "$STAGE/test-missing-required.yml"
  assert $? "the required wrapper documents the stage-1 resolution proof" \
    "the ./ call must prove it resolves in evaluate before stage 2 goes active"
fi

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $((PASS + FAIL)) -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
