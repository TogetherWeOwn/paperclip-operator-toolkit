#!/usr/bin/env bash
# Repo-placement acceptance test for Land #941 (config/deploy checks).
#
# THE RISK THIS EXISTS FOR. PR TogetherWeOwn/paperclip-ops-tooling#941
# adds the shared deterministic config/deploy checker, its reusable
# workflow, the consumer caller template, the org ruleset template and
# the rollout doc in the private repo. Every one of those files is
# public-able, so the repo-placement gate requires the mirror to live
# in THIS public repo. Until it is mirrored here, the landing is not
# complete: no repo can adopt the checks with one uses: line, and the
# config/deploy blocker class stays a model judgment.
#
# Two landing defects in the source PR are pinned here so the mirror
# cannot copy them verbatim:
#   * the caller template pins the reusable workflow to the
#     actions/checkout commit -- a SHA that does not exist in the repo
#     hosting the workflow, so every consumer copying it gets a broken
#     workflow. The mirrored caller pin must therefore differ from
#     every action pin used inside the reusable workflow itself;
#   * the source files carry internal ticket ids, which public files
#     must not. The mirror is sanitized, and this test keeps it so.
# The hung-job threshold row the source PR adds stays in the private
# repo with the detector it configures; it is not mirrored here.
#
# What this pins, hermetically (no network, no credential):
#   1. the checker exists at this repo's root as config_deploy_check.py,
#      stdlib-only, exposing the API test_config_deploy_check.py uses;
#   2. the staged org drop exists at templates/org-github/config-deploy/
#      with the reusable workflow_call workflow, the thin caller, the
#      verbatim logic copy and the org ruleset template;
#   3. docs/config-deploy-checks.md documents the fail-closed contract;
#   4. the tree README maps every staged file to its destination;
#   5. this repo's CI actually runs both config-deploy suites;
#   6. no internal ticket ids or internal hosts in mirrored files.
#
# RED (before the fix): the mirror files are absent, which IS the
# placement risk reproduced. GREEN (after): all pass. The Builder adds
# the mirror on this branch without touching test files.
# Exit 0 all green, 1 anything red. Requires bash, python3.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$HERE/config_deploy_check.py"
STAGE="$HERE/templates/org-github/config-deploy"
READMEMAP="$HERE/templates/org-github/README.md"
DOC="$HERE/docs/config-deploy-checks.md"
CI="$HERE/.github/workflows/ci.yml"
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

command -v python3 >/dev/null 2>&1 || { echo "test_config_deploy_placement: python3 is required" >&2; exit 2; }

hdr "Repo-placement: the public checker lives in the public repo"

[[ -f "$CHECKER" ]]
assert $? "the config/deploy checker is mirrored at config_deploy_check.py in TogetherWeOwn/paperclip-operator-toolkit" \
  "config_deploy_check.py absent -- placement risk reproduced (deterministic check lives nowhere adoptable)"

if [[ -f "$CHECKER" ]]; then
  # Stdlib-only: every top-level import must resolve to the standard
  # library, so CI gates and consumer repos can all import the one file.
  python3 - "$CHECKER" <<'PY'
import ast, sys
path = sys.argv[1]
tree = ast.parse(open(path).read())
stdlib = sys.stdlib_module_names
mods = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for a in node.names:
            mods.add(a.name.split('.')[0])
    elif isinstance(node, ast.ImportFrom):
        if node.level == 0 and node.module:
            mods.add(node.module.split('.')[0])
bad = sorted(m for m in mods if m not in stdlib)
if bad:
    print('third-party imports: %s' % ', '.join(bad))
    sys.exit(1)
PY
  assert $? "the mirrored checker imports stdlib only" \
    "a third-party import strands every consumer runtime that only has stdlib"

  for sym in check_tree measured_files main; do
    grep -qE "^def $sym\(" "$CHECKER"
    assert $? "the mirrored checker exposes $sym" \
      "test_config_deploy_check.py exercises $sym -- a renamed API leaves the suite erroring"
  done

  grep -qE "^class Finding" "$CHECKER"
  assert $? "the mirrored checker exposes the Finding type" \
    "callers render findings by level/code/file -- a renamed type breaks them"
fi

hdr "Staged org drop: one reusable workflow every repo adopts"

[[ -f "$STAGE/config-deploy.yml" ]]
assert $? "staged reusable workflow exists at templates/org-github/config-deploy/config-deploy.yml" \
  "absent -- the org has no one-line adoptable config/deploy gate"

if [[ -f "$STAGE/config-deploy.yml" ]]; then
  grep -q "workflow_call:" "$STAGE/config-deploy.yml"
  assert $? "the staged workflow is a reusable workflow_call workflow" \
    "without workflow_call no repo can adopt it with one uses: line"

  grep -qE "^\s+name: config-deploy\s*$" "$STAGE/config-deploy.yml"
  assert $? "the staged workflow's job reports the bare config-deploy check" \
    "the org ruleset requires the check by this name -- a renamed check leaves the ruleset pointing nowhere"

  grep -q "timeout-minutes:" "$STAGE/config-deploy.yml"
  assert $? "the staged workflow job carries a timeout bound" \
    "an unbounded gate job can hang the required check forever"

  grep -q "contents: read" "$STAGE/config-deploy.yml"
  assert $? "the staged workflow runs with read-only contents permission" \
    "a deterministic offline checker needs no write token in any consumer repo"

  grep -q "persist-credentials: false" "$STAGE/config-deploy.yml"
  assert $? "the staged workflow does not persist checkout credentials" \
    "a persisted token outlives the read-only check it was minted for"

  grep -q "config_deploy_check.py" "$STAGE/config-deploy.yml"
  assert $? "the staged workflow actually runs the checker" \
    "a reusable workflow that never invokes the logic is a green badge over nothing"

  # Every uses: in the reusable workflow must be SHA-pinned -- the same
  # rule the checker itself enforces on consumers.
  python3 - "$STAGE/config-deploy.yml" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
pins = re.findall(r"(?m)^\s*-?\s*uses:\s*(\S+)", text)
unpinned = [p for p in pins
            if not p.startswith("./")
            and not re.search(r"@[0-9a-fA-F]{40}$", p)
            and "@sha256:" not in p]
if not pins or unpinned:
    print("unpinned uses: %s" % (unpinned or "none found"))
    sys.exit(1)
PY
  assert $? "staged workflow actions are SHA-pinned, never a moving tag" \
    "a moving tag lets the gate change under repos without review"
fi

[[ -f "$STAGE/caller-workflow.yml" ]]
assert $? "consumer caller template exists at templates/org-github/config-deploy/caller-workflow.yml" \
  "absent -- repos have no thin caller file to copy"

if [[ -f "$STAGE/caller-workflow.yml" ]]; then
  grep -q "pull_request:" "$STAGE/caller-workflow.yml"
  assert $? "the caller template triggers on pull_request" \
    "without it the required check never runs on PRs"

  grep -qE "uses:[[:space:]]*\S+/\.github/workflows/config-deploy\.yml@[0-9a-f]{40}" "$STAGE/caller-workflow.yml"
  assert $? "the caller reaches the reusable workflow by pinned SHA, never a moving tag" \
    "a branch or tag pin lets the gate change under repos without review"

  grep -q "mode: error" "$STAGE/caller-workflow.yml"
  assert $? "the caller template runs in error mode" \
    "the caller is the required-check path -- warn mode would report findings and still pass"

  grep -qE "^\s{2}config-deploy:\s*$" "$STAGE/caller-workflow.yml"
  assert $? "the caller job id is config-deploy" \
    "consumer rulesets and dashboards key on this job id"

  if [[ -f "$STAGE/config-deploy.yml" ]]; then
    # Regression pin for the source PR's caller defect: its pin was the
    # actions/checkout commit copied from inside the reusable workflow,
    # a SHA that does not exist in the workflow's hosting repo.
    python3 - "$STAGE/caller-workflow.yml" "$STAGE/config-deploy.yml" <<'PY'
import re, sys
caller = open(sys.argv[1]).read()
reusable = open(sys.argv[2]).read()
m = re.search(r"uses:\s*\S+@([0-9a-f]{40})", caller)
inner = set(re.findall(r"uses:\s*\S+@([0-9a-f]{40})", reusable))
if not m or m.group(1) in inner:
    print("caller pin reuses an inner action pin: %s" % (m.group(1) if m else "missing"))
    sys.exit(1)
PY
    assert $? "the caller pin is a commit of the hosting repo, not a copied inner action pin" \
      "a pin copied from an unrelated action names no commit in the hosting repo -- every consumer workflow breaks"
  fi
fi

hdr "Staged logic copy: fix upstream, then re-copy"

[[ -f "$STAGE/config_deploy_check.py" ]]
assert $? "staged logic copy exists at templates/org-github/config-deploy/config_deploy_check.py" \
  "absent -- the org drop ships a workflow with no logic to run"

if [[ -f "$CHECKER" && -f "$STAGE/config_deploy_check.py" ]]; then
  cmp -s "$CHECKER" "$STAGE/config_deploy_check.py"
  assert $? "the staged copy is verbatim (fix upstream, then re-copy)" \
    "a hand-edited copy drifts from the tested root source"
fi

hdr "Org ruleset template and rollout doc"

if [[ -f "$STAGE/org-ruleset.json" ]]; then
  python3 - "$STAGE/org-ruleset.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc.get("target") == "branch", "ruleset must target branches"
refs = doc.get("conditions", {}).get("ref_name", {}).get("include", [])
assert "refs/heads/main" in refs, "ruleset must cover main"
ctx = [c.get("context")
       for r in doc.get("rules", []) if r.get("type") == "required_status_checks"
       for c in r.get("parameters", {}).get("required_status_checks", [])]
assert "config-deploy" in ctx, "ruleset must require the config-deploy check"
strict = [r.get("parameters", {}).get("strict_required_status_checks_policy")
          for r in doc.get("rules", []) if r.get("type") == "required_status_checks"]
assert strict == [True], "required checks must be strict (branch up to date)"
PY
  assert $? "org ruleset template is valid and requires config-deploy on main, strictly" \
    "a ruleset naming no config-deploy context makes the org rollout a no-op"
else
  assert 1 "org ruleset template exists at templates/org-github/config-deploy/org-ruleset.json" \
    "absent -- the operator has no one-time org ruleset to apply"
fi

[[ -f "$DOC" ]]
assert $? "rollout doc exists at docs/config-deploy-checks.md" \
  "absent -- repos have no documented adoption or coverage story"

if [[ -f "$DOC" ]]; then
  grep -q "caller" "$DOC"
  assert $? "the rollout doc documents the caller file consumers copy" \
    "without it each repo invents its own caller and the one-definition rule dies"

  grep -qE "exit(s| code)?[^0-9]{0,12}2|exits .2." "$DOC"
  assert $? "the rollout doc documents the fail-closed exit-2 contract" \
    "an operator who reads exit 2 as a crash will bypass the gate instead of fixing coverage"
fi

if [[ -f "$READMEMAP" ]]; then
  for f in "config-deploy/config-deploy.yml" "config-deploy/caller-workflow.yml" "config-deploy/config_deploy_check.py" "config-deploy/org-ruleset.json"; do
    grep -qF "$f" "$READMEMAP"
    assert $? "README destination map names $f" \
      "an unmapped staged file has no documented destination or applier"
  done
else
  assert 1 "README destination map names every new staged file" \
    "templates/org-github/README.md absent -- staged files have no documented destinations"
fi

hdr "Wiring and public hygiene"

grep -q "test_config_deploy_check.py" "$CI" 2>/dev/null
assert $? "this repo's CI runs the behavioral config-deploy suite" \
  "an unwired suite rots: the checker can break while CI stays green"

grep -q "test_config_deploy_placement.sh" "$CI" 2>/dev/null
assert $? "this repo's CI runs this placement suite" \
  "an unwired placement suite cannot stop the mirror drifting back out"

MIRRORED=()
for f in "$CHECKER" "$STAGE/config-deploy.yml" "$STAGE/caller-workflow.yml" \
         "$STAGE/config_deploy_check.py" "$STAGE/org-ruleset.json" "$DOC"; do
  [[ -f "$f" ]] && MIRRORED+=("$f")
done
if [[ ${#MIRRORED[@]} -gt 0 ]]; then
  ! grep -qE '\b(TOG|PAP|PAPA)-[0-9]+\b' "${MIRRORED[@]}"
  assert $? "mirrored public files carry no internal ticket ids" \
    "public files must not name internal tracker ids -- sanitize on mirror, do not copy verbatim"

  # Assembled in fragments: this public test file must not itself
  # carry the internal hostname it scans for.
  internal_host_pat="inf""extion\.net"
  ! grep -qi "$internal_host_pat" "${MIRRORED[@]}"
  assert $? "mirrored public files carry no internal hostnames" \
    "public files must not name internal hosts"
else
  assert 1 "mirrored public files carry no internal ticket ids" \
    "no mirrored files exist to inspect -- placement risk reproduced"
  assert 1 "mirrored public files carry no internal hostnames" \
    "no mirrored files exist to inspect -- placement risk reproduced"
fi

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $((PASS + FAIL)) -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
