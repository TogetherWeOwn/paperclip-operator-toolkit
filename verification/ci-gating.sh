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
# Exit 0 gate holds, 1 gate broken. Offline, stdlib python3 only.
# ===========================================================================
set -Eeuo pipefail

WORKFLOW="${1:-.github/workflows/ci.yml}"
[[ -f "$WORKFLOW" ]] || { printf 'FAIL: missing %s\n' "$WORKFLOW" >&2; exit 1; }

python3 - "$WORKFLOW" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text()

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

for job in HEAVY:
    body = bodies.get(job)
    check(f"{job} exists", body is not None)
    if body is None:
        continue
    m = re.search(r"(?m)^    needs:\s*(?P<val>\[.*?\]|\S.*?)\s*$", body)
    needs_val = m.group("val") if m else ""
    # Flow (`needs: [changes]`) or block (subsequent `      - changes`).
    block = "\n".join(
        line for line in body.splitlines()
        if re.match(r"^      - ", line))
    check(f"{job} needs changes",
          "changes" in needs_val or "changes" in block)
    im = re.search(r"(?m)^    if:\s*(?P<val>.+?)\s*$", body)
    if_val = im.group("val") if im else ""
    check(f"{job} tests the heavy output",
          "needs.changes.outputs.heavy" in if_val)

# The model-selection mutants are gated through the impact job, not
# directly on the detector: pin the chain so a severed link cannot read
# as a pass.
mutants = bodies.get("model-selection-mutants")
check("model-selection-mutants exists", mutants is not None)
if mutants is not None:
    check("model-selection-mutants needs model-selection-impact",
          "model-selection-impact" in mutants)
    check("model-selection-mutants tests the impact output",
          "needs.model-selection-impact.outputs.impacted" in mutants)

# The detector itself: always runs (no job-level if), publishes the heavy
# output, and diffs against the PR base with rename detection disabled. The
# merge-base call is sound because the checkout below fetches full history;
# a shallow checkout has no common ancestor on PR merge refs and the step
# dies before emitting anything -- parking every heavy suite behind a red
# `changes` job. Pin both halves, not just one.
changes = bodies.get("changes")
check("changes job exists", changes is not None)
if changes is not None:
    check("changes has no job-level if",
          re.search(r"(?m)^    if:\s*", changes) is None)
    check("changes publishes the heavy output",
          re.search(r"(?m)^    outputs:\s*$", changes) is not None
          and "heavy" in changes)
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
    check("ci-ok runs unless cancelled",
          re.search(r"(?m)^    if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}\s*$", ciok) is not None)
    check("ci-ok never uses always()",
          re.search(r"(?m)^    if:.*always\(\)", ciok) is None)
    # Pin the needs list items, not substrings: the step body names both
    # scans in its result loop, so a dropped need would still read as a
    # pass under a substring check.
    needs_items = set(re.findall(r"(?m)^      - ([a-zA-Z0-9_-]+)\s*$", ciok))
    check("ci-ok needs every gated job",
          all(j in needs_items for j in HEAVY + ["changes", "secret-scan",
                                                "disclosure-scan",
                                                "model-selection-mutants"]))

# Both scans always run: no needs, no if. A scan that can skip on exactly
# the docs-only PRs where every heavy suite also skips would let a
# committed secret merge with ci-ok green.
for scan_name, script in (("secret-scan", "secret-scan.sh"),
                          ("disclosure-scan", "disclosure-scan.sh")):
    scan = bodies.get(scan_name)
    check(f"{scan_name} exists", scan is not None)
    if scan is not None:
        check(f"{scan_name} has no job-level if",
              re.search(r"(?m)^    if:\s*", scan) is None)
        check(f"{scan_name} needs nothing",
              re.search(r"(?m)^    needs:\s*", scan) is None)
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
