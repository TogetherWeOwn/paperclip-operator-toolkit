#!/usr/bin/env python3
"""CI change-gating policy lint (phase 2 of the org CI standard).

Warns, and once every repo child complies fails, when a workflow has heavy
jobs without change gating or uses workflow-level `on: pull_request: paths:`
on a workflow producing a required check.

Scope: PR-triggered workflows that produce required checks. Out of scope and
skipped: workflows with no `pull_request`/`pull_request_target` trigger
(schedule, push-to-main and dispatch-only full-run paths need no gating), and
workflows carrying a `ci-policy: non-required` marker comment (live audits,
canaries and other deliberately non-required workflows that run on their own
file only).

Heuristics (static; see the card for the historical-duration half):
  heavy job = `timeout-minutes` >= 10, or missing (GitHub defaults to 6h).
  gated job = a job-level `if:` naming change detection (`needs.*outputs`,
  the `github.event` draft/event-name latches) or a lifecycle guard
  (`failure()`, `always()`, `cancelled()`); or the job publishes `outputs:`
  (it IS the detector). Light jobs (< 10 min) need no gating.

Environment contract:
  CI_POLICY_MODE        "warn" | "error" (default warn)
  HEAVY_TIMEOUT_MINUTES heavy threshold in minutes (default 10)

Usage: ci_policy.py [workflow-file ...] (default: .github/workflows/*.yml).
Runs inside the existing required `pr-lint` job, so adopting it in warn mode
adds no new required check and needs no ruleset change. Stdlib only.

Fail-flip plan (recorded per the card): flip `CI_POLICY_MODE` to `error` in
the owning workflow only after the rollout is confirmed for every repo
merged and verified. Warn-mode rollout needs no ruleset change.
"""
import glob
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

HEAVY_DEFAULT = 10
EXEMPT = re.compile(r"ci-policy:\s*non-required\b", re.I)
GATED = re.compile(
    r"needs\.[a-zA-Z0-9_-]+\.outputs|github\.event|failure\(\)|always\(\)|cancelled\(\)"
)
JOB_HEADER = re.compile(r"(?m)^  ([A-Za-z0-9_-]+):\n")
TIMEOUT = re.compile(r"(?m)^    timeout-minutes:\s*(\d+)\s*$")
JOB_IF = re.compile(r"(?m)^    if:\s*(.+?)\s*$")
OUTPUTS = re.compile(r"(?m)^    outputs:\s*$")
TOP_KEY = re.compile(r"(?m)^[A-Za-z][^:\n]*:")


@dataclass
class Finding:
    level: str  # "error" | "warning"
    title: str
    message: str


def on_section(text):
    """Return the `on:` trigger block, or '' when absent."""
    # [ \t], never \s: a greedy \s* eats the newline and the indentation,
    # so a block-form `on:` would misread as the flow value `pull_request:`.
    m = re.search(r"(?m)^on:[ \t]*(?P<val>\[.*?\]|\S.*?)?[ \t]*$", text)
    if not m:
        return ""
    if (m.group("val") or "").strip():
        return m.group("val")  # flow form: `on: [push, pull_request]`
    start = m.end()
    tail = text[start:]
    end = TOP_KEY.search(tail)
    return tail[: end.start()] if end else tail


def has_pr_trigger(on_text):
    return "pull_request" in on_text


def has_workflow_paths(on_text):
    """Workflow-level `paths:` under `pull_request`/`pull_request_target`."""
    lines = on_text.splitlines()
    in_pr, pr_indent = False, 0
    for line in lines:
        m = re.match(r"^(\s*)([A-Za-z0-9_-]+):\s*(.*)$", line)
        if not m:
            continue
        indent, key = len(m.group(1)), m.group(2)
        # Relative indents: the block is already cut at top-level keys, so
        # the trigger names sit at its shallowest level, whatever that is.
        if key in ("pull_request", "pull_request_target") and (not in_pr or indent <= pr_indent):
            in_pr, pr_indent = True, indent
        elif in_pr and indent <= pr_indent:
            in_pr = False
        if in_pr and key == "paths" and indent > pr_indent:
            return True
    return False


def split_jobs(text):
    """Map job name -> body for the `jobs:` block."""
    m = re.search(r"(?ms)^jobs:\n(?P<jobs>.*)\Z", text)
    if not m:
        return {}
    jobs_text = m.group("jobs")
    bodies = {}
    for name in JOB_HEADER.findall(jobs_text):
        jm = re.search(
            r"(?ms)^  " + re.escape(name) + r":\n(?P<body>.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)",
            jobs_text,
        )
        bodies[name] = jm.group("body") if jm else ""
    return bodies


def lint_file(path, mode, heavy_after):
    out, notes = [], []
    text = Path(path).read_text()
    on_text = on_section(text)
    if not has_pr_trigger(on_text):
        notes.append(f"{path}: no pull_request trigger; full-run path, out of scope")
        return out, notes
    if EXEMPT.search(text):
        notes.append(f"{path}: marked ci-policy non-required; out of scope")
        return out, notes
    if has_workflow_paths(on_text):
        out.append(Finding(
            mode, "Change gating",
            f"{path}: workflow-level `on: pull_request: paths:` silences "
            "required checks on PRs outside it. Gate at job level instead "
            "(`needs:` + `if:`, aggregated by `ci-ok`), or mark the workflow "
            "`ci-policy: non-required` with a reason when it truly produces "
            "no required check.",
        ))
    for name, body in split_jobs(text).items():
        tm = TIMEOUT.search(body)
        timeout = int(tm.group(1)) if tm else None
        heavy = timeout is None or timeout >= heavy_after
        if not heavy:
            continue
        if OUTPUTS.search(body):
            continue  # the detector publishes outputs; it is the gate
        im = JOB_IF.search(body)
        if im and GATED.search(im.group(1)):
            continue
        why = "has no `timeout-minutes` (GitHub defaults to 6h)" if timeout is None else (
            f"`timeout-minutes: {timeout}` with no change-gating `if:`")
        out.append(Finding(
            mode, "Change gating",
            f"{path}: heavy job `{name}` {why}. Run it only when its area "
            "changed (`needs:` the detector, `if:` on its outputs), or record "
            "why it always runs.",
        ))
    return out, notes


def evaluate(files, mode="warning", heavy_after=HEAVY_DEFAULT):
    findings, notes = [], []
    for path in files:
        f, n = lint_file(path, mode, heavy_after)
        findings.extend(f)
        notes.extend(n)
    return findings, notes


def _escape(text):
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def main(env=None, argv=None):
    env = dict(os.environ) if env is None else env
    mode = "error" if env.get("CI_POLICY_MODE", "warn").strip().lower() == "error" else "warning"
    try:
        heavy_after = int(env.get("HEAVY_TIMEOUT_MINUTES") or HEAVY_DEFAULT)
    except ValueError:
        heavy_after = HEAVY_DEFAULT
    files = list(argv[1:] if argv is not None else sys.argv[1:]) or sorted(
        glob.glob(os.path.join(".github", "workflows", "*.yml"))
    )
    findings, notes = evaluate(files, mode, heavy_after)
    for f in findings:
        print(f"::{f.level} title={_escape(f.title)}::{_escape(f.message)}")
    for n in notes:
        print(f"note: {n}")
    if any(f.level == "error" for f in findings):
        return 1
    print("CI policy OK" if not findings else "CI policy OK (warnings above)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
