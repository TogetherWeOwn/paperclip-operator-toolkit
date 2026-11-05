#!/usr/bin/env bash
# ===========================================================================
# ci-gating.sh -- structural gate for the change-gated CI standard in
# .github/workflows/ci.yml.
#
# THE BUG CLASS THIS EXISTS FOR. Job-level gating has one fail-dangerous
# direction: a job whose `needs: changes` is deleted while its
# `if: needs.changes.outputs.heavy` stays keeps evaluating against an
# UNDEFINED output -- '' is never 'true', so the job skips on EVERY pull
# request and its required check reports success without running. The reverse
# (deleted `if:`) merely wastes runners. This gate pins the load-bearing
# half: every heavy job names `changes` in `needs:` AND tests the heavy
# output in `if:`; ci-ok aggregates with `if: ${{ !cancelled() }}`; the
# triggers stay full-run capable; and no workflow-level `paths:` can silence
# a required check.
#
# The detector diffs with `git merge-base` against the PR base SHA, which is
# sound only on a full-history checkout: the changes checkout pins
# fetch-depth 0, and rename detection stays disabled so a move into docs/
# still lists the old path. Either half removed must turn this gate red.
#
# Usage: verification/ci-gating.sh [workflow-file]
# Exit 0 gate holds, 1 gate broken. Offline; requires PyYAML.
# ===========================================================================
set -Eeuo pipefail

WORKFLOW="${1:-.github/workflows/ci.yml}"
[[ -f "$WORKFLOW" ]] || { printf 'FAIL: missing %s\n' "$WORKFLOW" >&2; exit 1; }

python3 - "$WORKFLOW" <<'PY'
from pathlib import Path
import re
import sys

try:
    import yaml
except ImportError:
    raise SystemExit("FAIL: PyYAML is required to validate workflow execution")

class UniqueKeyLoader(yaml.SafeLoader):
    """Reject ambiguous mappings instead of accepting a shadowed execution key."""

    def construct_mapping(self, node, deep=False):
        self.flatten_mapping(node)
        seen = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=deep)
            if key in seen:
                raise ValueError(f"duplicate YAML key: {key!r}")
            seen.add(key)
        return super().construct_mapping(node, deep=deep)

text = Path(sys.argv[1]).read_text()

# Read execution metadata once, rejecting ambiguous or malformed mappings.
try:
    workflow = yaml.load(text, Loader=UniqueKeyLoader)
    if not isinstance(workflow, dict) or not isinstance(workflow.get("jobs"), dict):
        raise ValueError("workflow jobs must be a mapping")
    jobs = workflow["jobs"]
    if not jobs or not all(isinstance(job, dict) for job in jobs.values()):
        raise ValueError("workflow jobs must contain job mappings")
    for job in jobs.values():
        steps = job.get("steps", [])
        if not isinstance(steps, list) or not all(isinstance(step, dict) for step in steps):
            raise ValueError("job steps must be mappings")
except (yaml.YAMLError, ValueError, TypeError) as exc:
    raise SystemExit(f"FAIL: cannot parse workflow execution properties: {exc}")


def needs(scope):
    value = scope.get("needs", [])
    return [value] if isinstance(value, str) else value


def condition(scope):
    value = scope.get("if", "")
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if value.startswith("${{") and value.endswith("}}"):
        value = value[3:-2].strip()
    return value

# Heavy job -> the outputs.if shape it must carry. Every heavy job tests the
# single heavy output; the model-selection suite additionally runs unless
# cancelled, which still names the heavy output.
HEAVY = [
    "privilege-suites",
    "offline-suites",
    "upgrade-offline",
    "long-mutation-gates",
    "runbook-gates",
    "omniroute-broker-suite",
    "dispatch-suite",
    "mcp-suite",
    "model-selection-impact",
    "model-selection-suite",
    "cliproxy-insight-suite",
]

jobs_match = re.search(r"(?ms)^jobs:\n(?P<jobs>.*)\Z", text)
if not jobs_match:
    raise SystemExit("FAIL: jobs block is missing")
jobs_text = jobs_match.group("jobs")
bodies = {}
for name in re.findall(r"(?m)^  ([a-zA-Z0-9_-]+):\n", jobs_text):
    m = re.search(r"(?ms)^  " + re.escape(name) + r":\n(?P<body>.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)", jobs_text)
    bodies[name] = m.group("body") if m else ""

checks = {}


def check(name, ok):
    checks[name] = bool(ok)
    print(("PASS" if ok else "FAIL") + ": " + name)


for job, body in bodies.items():
    check(f"{job} has a positive timeout",
          re.search(r"(?m)^    timeout-minutes:\s*[1-9][0-9]*\s*$", body) is not None)

for name in HEAVY:
    job = jobs.get(name, {})
    check(f"{name} exists", name in jobs)
    expected_needs = ["changes"]
    expected_if = "needs.changes.outputs.heavy == 'true'"
    if name == "model-selection-suite":
        expected_needs += ["model-selection-impact", "model-selection-mutants"]
        expected_if = "!cancelled() && " + expected_if
    check(f"{name} has the exact admission dependencies", needs(job) == expected_needs)
    check(f"{name} tests the heavy output", condition(job) == expected_if)

# The model-selection mutants are gated through the impact job, not
# directly on the detector: pin the chain so a severed link cannot read
# as a pass.
mutants = jobs.get("model-selection-mutants", {})
check("model-selection-mutants exists", "model-selection-mutants" in jobs)
check("model-selection-mutants needs model-selection-impact",
      needs(mutants) == ["model-selection-impact"])
check("model-selection-mutants tests the impact output",
      condition(mutants) == "needs.model-selection-impact.outputs.impacted == 'true'")
check("model-selection-impact binds its output to the impact step",
      jobs.get("model-selection-impact", {}).get("outputs") ==
      {"impacted": "${{ steps.impact.outputs.impacted }}"})

# The detector itself: always runs (no job-level if), publishes the heavy
# output, and diffs against the PR base with rename detection disabled. The
# merge-base call is sound because the checkout below fetches full history;
# a shallow checkout has no common ancestor on PR merge refs and the step
# dies before emitting anything -- parking every heavy suite behind a red
# `changes` job. Pin both halves, not just one.
changes = bodies.get("changes")
check("changes job exists", changes is not None)
if changes is not None:
    check("changes has no job-level if or dependencies",
          "if" not in jobs.get("changes", {}) and needs(jobs.get("changes", {})) == [])
    check("changes publishes the heavy output",
          jobs.get("changes", {}).get("outputs") == {"heavy": "${{ steps.detect.outputs.heavy }}"})
    check("changes checkout fetches full history",
          "fetch-depth: 0" in changes)
    check("changes diffs against the PR base, never a bare HEAD range",
          "git merge-base" in changes
          and "github.event.pull_request.base.sha" in changes)
    # Pin the executable command, not a comment mentioning the flag:
    # the rationale prose names --no-renames too, and rename detection
    # hides the deleted source when code moves into docs/.
    check("changes disables rename detection",
          "git diff --no-renames --name-only" in changes)
    check("changes reads the draft flag",
          "github.event.pull_request.draft" in changes)

# The aggregator: runs unless cancelled, needs every gated job plus the
# detector and both always-on scans.
ciok = bodies.get("ci-ok")
check("ci-ok exists", ciok is not None)
if ciok is not None:
    # !cancelled(), never always(): always() ignores cancellation, so a
    # superseded run's ci-ok queues behind the new head and the PR's
    # concurrency group stalls instead of going red.
    check("ci-ok runs unless cancelled", condition(jobs.get("ci-ok", {})) == "!cancelled()")
    check("ci-ok never uses always()", "always()" not in condition(jobs.get("ci-ok", {})))
    # Bind parsed dependencies: a result mentioned in shell or a comment is
    # not an Actions dependency and cannot contribute to failure propagation.
    required = HEAVY + ["changes", "secret-scan", "disclosure-scan", "model-selection-mutants"]
    needs_items = needs(jobs.get("ci-ok", {}))
    check("ci-ok needs every gated job",
          isinstance(needs_items, list) and len(needs_items) == len(required)
          and all(j in needs_items for j in required))

# Both scans always run: no needs, no if. A scan that can skip on exactly
# the docs-only PRs where every heavy suite also skips would let a
# committed secret merge with ci-ok green.
for scan_name, script in (("secret-scan", "secret-scan.sh"),
                          ("disclosure-scan", "disclosure-scan.sh")):
    scan = bodies.get(scan_name)
    check(f"{scan_name} exists", scan is not None)
    if scan is not None:
        check(f"{scan_name} has no job-level if", "if" not in jobs.get(scan_name, {}))
        check(f"{scan_name} needs nothing", "needs" not in jobs.get(scan_name, {}))
        check(f"{scan_name} runs its scan",
              script in scan)

# Triggers: push-to-main plus nightly schedule run the FULL suite; the
# detector reports heavy=true on every non-PR event. pull_request carries
# activity types but NO paths filter, so no path filter can silence a
# required check on some PRs; ready_for_review is pinned so a draft that
# flips to ready re-runs the gated set instead of keeping its all-skipped
# draft verdict with ci-ok green.
check("push to main trigger present",
      re.search(r"(?m)^  push:\s*$", text) is not None
      and "branches: [main]" in text)
check("nightly schedule present",
      re.search(r"(?m)^  schedule:\s*$", text) is not None
      and re.search(r"(?m)^\s+-\s*cron:", text) is not None)
pr_trig = re.search(r"(?ms)^  pull_request:\n(?P<block>.*?)^  merge_group:",
                    text)
pr_block = pr_trig.group("block") if pr_trig else ""
check("pull_request trigger has no paths filter",
      pr_trig is not None and "paths:" not in pr_block)
check("pull_request re-runs on ready_for_review",
      re.search(r"(?m)^\s+types:\s*\[.*ready_for_review", pr_block) is not None)

# Step-presence, guarded from OUTSIDE the step itself: the sdlc_foundation
# suite asserts its own wiring, but a deleted step never runs that
# assertion, and a header comment still names the files. This gate runs
# in its own step, so deleting the sdlc_foundation step (comments kept)
# must turn this check red: non-comment lines must execute all three
# commands.
noncomment = "\n".join(
    line for line in text.splitlines()
    if not line.lstrip().startswith("#"))
for cmd in ("./test_sdlc_foundation_placement.sh",
            "python3 -m unittest test_sdlc_foundation_acceptance",
            "./templates/org-github/tests/test_sdlc_foundation.sh"):
    check(f"ci.yml executes {cmd}", cmd in noncomment)

# Protect the execution context as well as the command. These jobs run scripts
# relative to the checkout and must not inherit a different interpreter, import
# path or startup file. Explicit step data maps are pinned below, not allowlisted
# by variable name (PATH and BASH_ENV are not the only execution-affecting keys).
PARSER_ENV = {"PYTHONPATH": "${{ runner.temp }}/static-label-guard-deps"}
PARSER_INSTALL = '''python3 -m pip install --disable-pip-version-check \\
  --only-binary=:all: --no-deps --require-hashes \\
  --target "$RUNNER_TEMP/static-label-guard-deps" \\
  -r scripts/static-label-guard-requirements.txt'''


def root_context(scope):
    defaults = scope.get("defaults", {})
    run = defaults.get("run", {}) if isinstance(defaults, dict) else None
    return (isinstance(run, dict) and run.get("shell", "bash") == "bash"
            and run.get("working-directory", ".") == "." and scope.get("env", {}) == {})


def executable(step, env):
    return ("if" not in step and "continue-on-error" not in step and "uses" not in step
            and step.get("shell", "bash") == "bash"
            and step.get("working-directory", ".") == "." and step.get("env", {}) == env)


def protected_step(job_name, title, command, env=None):
    steps = jobs.get(job_name, {}).get("steps", [])
    matches = [step for step in steps if step.get("name") == title]
    step = matches[0] if len(matches) == 1 else {}
    check(f"{job_name} executes {title}",
          len(matches) == 1 and isinstance(step.get("run"), str)
          and step["run"].strip() == command.strip())
    check(f"{job_name} {title} cannot redirect, skip or swallow execution",
          len(matches) == 1 and executable(step, env or {}))
    return steps.index(step) if len(matches) == 1 else -1


check("workflow uses the repository-root execution context", root_context(workflow))
for name in ("changes", "offline-suites", "secret-scan", "disclosure-scan", "ci-ok"):
    job = jobs.get(name, {})
    check(f"{name} cannot redirect or swallow job execution",
          name in jobs and root_context(job) and "continue-on-error" not in job)

for name in ("changes", "offline-suites"):
    install = protected_step(name, "Prepare static label parser", PARSER_INSTALL)
    gate = protected_step(name, "change-gating contract holds", "./test_ci_gating.sh", PARSER_ENV)
    hardening = protected_step(name, "Workflow hardening regression controls",
                              "python3 scripts/test_workflow_hardening.py", PARSER_ENV)
    check(f"{name} prepares the pinned parser before its contracts", 0 <= install < min(gate, hardening))
    if name == "offline-suites":
        pins = protected_step(name, "Immutable Action references and red/green controls",
                              "python3 scripts/test_action_pins.py", PARSER_ENV)
        check("offline-suites prepares the pinned parser before Action pins", 0 <= install < pins)

# The admission guard has an always-executed caller, outside the heavy job it
# validates. Bind the published output to the one detector step, not a comment.
detectors = [step for step in jobs.get("changes", {}).get("steps", []) if step.get("id") == "detect"]
check("changes has one executable detector with bound inputs",
      len(detectors) == 1 and isinstance(detectors[0].get("run"), str)
      and bool(detectors[0]["run"].strip()) and executable(detectors[0], {
          "EVENT": "${{ github.event_name }}", "DRAFT": "${{ github.event.pull_request.draft }}",
          "BASE_SHA": "${{ github.event.pull_request.base.sha }}",
          "HEAD_SHA": "${{ github.event.pull_request.head.sha }}"}))

for name, title, command in (
        ("secret-scan", "Secret suppression positive controls", "python3 scripts/test_secret_scan.py"),
        ("secret-scan", "gitleaks detect", "bash scripts/secret-scan.sh"),
        ("disclosure-scan", "Disclosure scan self-test", "bash scripts/test_disclosure_scan.sh"),
        ("disclosure-scan", "Plugin CI wiring self-test", "python3 scripts/test_plugin_ci_wiring.py"),
        ("disclosure-scan", "Repo placement classifier self-test", "python3 scripts/test_repo_placement.py"),
        ("disclosure-scan", "Disclosure scan over plugins/", "bash scripts/disclosure-scan.sh plugins")):
    protected_step(name, title, command)

# Validate the real aggregation step, not only a directly-executed extraction of
# its shell. Comments may evolve, but the failure-propagation program is fixed.
def shell_program(value):
    if not isinstance(value, str):
        return ""
    return "\n".join(line.strip() for line in value.splitlines()
                     if line.strip() and not line.lstrip().startswith("#"))


aggregate = [step for step in jobs.get("ci-ok", {}).get("steps", [])
             if step.get("name") == "Aggregate gated results"]
aggregate_env = {
    "CHANGES_RESULT": "${{ needs.changes.result }}",
    "DISCLOSURE_RESULT": "${{ needs.disclosure-scan.result }}",
    "SECRET_RESULT": "${{ needs.secret-scan.result }}",
    "FAILED": "${{ contains(needs.*.result, 'failure') }}",
    "CANCELLED": "${{ contains(needs.*.result, 'cancelled') }}",
}
check("ci-ok has one mandatory aggregation step",
      len(aggregate) == 1 and executable(aggregate[0], aggregate_env))
expected_aggregate = '''set -euo pipefail
if [ "$CHANGES_RESULT" != 'success' ]; then
  echo "::error::change detection did not succeed"
  exit 1
fi
for scan in disclosure-scan:"$DISCLOSURE_RESULT" secret-scan:"$SECRET_RESULT"; do
  if [ "${scan#*:}" != "success" ]; then
    echo "::error::always-on scan ${scan%%:*} did not succeed (result: ${scan#*:})"
    exit 1
  fi
done
if [ "$FAILED" = "true" ] || [ "$CANCELLED" = "true" ]; then
  echo "::error::a needed job failed or was cancelled"
  exit 1
fi
echo "ci-ok: every needed job succeeded or was intentionally skipped"'''
check("ci-ok executes the failure-propagation program",
      len(aggregate) == 1 and shell_program(aggregate[0].get("run")) == shell_program(expected_aggregate))

# The drain keeps describing red runs; it must not become a required gate.
drain = bodies.get("failure-log-drain")
check("failure-log-drain exists", drain is not None)
if drain is not None:
    check("failure-log-drain still runs on failure only",
          re.search(r"(?m)^    if:\s*failure\(\)\s*$", drain) is not None)

failed = [n for n, ok in checks.items() if not ok]
if failed:
    raise SystemExit(1)
PY
