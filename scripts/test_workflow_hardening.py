#!/usr/bin/env python3
"""Offline workflow hardening controls; execute the real aggregator shell."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]


def workflow(name):
    return yaml.safe_load((ROOT / ".github/workflows" / name).read_text())


def step_for(job):
    name = {"failure-log-drain": "Summarize failed jobs", "ci-ok": "Aggregate gated results"}[job]
    steps = [step for step in workflow("ci.yml")["jobs"][job]["steps"] if step.get("name") == name]
    if len(steps) != 1:
        raise AssertionError(f"expected one {name!r} step, got {len(steps)}")
    return steps[0]


def expressions(needs):
    return {
        "toJSON(needs)": json.dumps(needs),
        "needs.changes.result": needs["changes"]["result"],
        "needs.disclosure-scan.result": needs["disclosure-scan"]["result"],
        "needs.secret-scan.result": needs["secret-scan"]["result"],
        "contains(needs.*.result, 'failure')": str(any(v["result"] == "failure" for v in needs.values())).lower(),
        "contains(needs.*.result, 'cancelled')": str(any(v["result"] == "cancelled" for v in needs.values())).lower(),
    }


def render(text, values):
    for key, value in values.items():
        text = text.replace("${{ " + key + " }}", value)
    if "${{" in text:
        raise AssertionError("unmeasured workflow expression")
    return text


def execute(step, needs, **env):
    values = expressions(needs)
    step_env = {key: render(value, values) for key, value in step.get("env", {}).items()}
    return subprocess.run(["bash", "-e", "-o", "pipefail", "-c", render(step["run"], values)],
                          env={"PATH": "/usr/bin:/bin", **step_env, **env}, text=True,
                          capture_output=True, timeout=10)


def results():
    names = workflow("ci.yml")["jobs"]["ci-ok"]["needs"]
    if not names:
        raise AssertionError("aggregator has no dependencies")
    return {name: {"result": "success", "outputs": {}} for name in names}


class WorkflowHardening(unittest.TestCase):
    def test_every_checkout_disables_credential_persistence(self):
        count = 0
        for path in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            for job in workflow(path.name)["jobs"].values():
                for step in job.get("steps", []):
                    if step.get("uses", "").startswith("actions/checkout@"):
                        with self.subTest(workflow=path.name, job=job.get("name")):
                            self.assertIs(step.get("with", {}).get("persist-credentials"), False)
                        count += 1
        self.assertGreater(count, 0, "no checkouts measured")

    def test_aggregator_expressions_are_data_not_shell(self):
        for job in ("failure-log-drain", "ci-ok"):
            with self.subTest(job=job):
                self.assertNotIn("${{", step_for(job)["run"])

    def test_failure_summary_keeps_untrusted_outputs_inert(self):
        needs = results()
        needs["offline-suites"]["result"] = "failure"
        # Break a single-quoted template and attempt command substitution. The
        # payload only touches a disposable canary, never the checkout.
        with tempfile.TemporaryDirectory() as directory:
            canary = str(Path(directory) / "executed")
            needs["offline-suites"]["outputs"]["untrusted"] = "'; touch ${CANARY}; # $(touch ${CANARY})"
            result = execute(step_for("failure-log-drain"), needs, CANARY=canary)
            self.assertFalse(Path(canary).exists(), result.stderr)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("offline-suites = failure", result.stdout)

    def test_aggregator_accepts_success_and_intentional_heavy_skip(self):
        needs = results()
        for heavy_result in ("success", "skipped"):
            needs["offline-suites"]["result"] = heavy_result
            result = execute(step_for("ci-ok"), needs)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_aggregator_refuses_failed_cancelled_and_skipped_required_jobs(self):
        for job in results():
            required = job in ("changes", "disclosure-scan", "secret-scan")
            states = ("failure", "cancelled", "skipped", "") if required else ("failure", "cancelled")
            for state in states:
                with self.subTest(job=job, state=state):
                    needs = results()
                    needs[job]["result"] = state
                    result = execute(step_for("ci-ok"), needs)
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertIn("::error::", result.stdout)

    def test_write_permissions_are_job_scoped_without_new_grants(self):
        self.assertEqual(workflow("ci.yml")["permissions"], {"contents": "read", "actions": "read"})
        cases = (
            ("release-lag.yml", "monitor", {"contents": "read", "actions": "read", "issues": "write"}),
            ("review-trigger.yml", "request-review", {"contents": "read", "checks": "read", "pull-requests": "write"}),
        )
        for name, job, expected in cases:
            with self.subTest(workflow=name):
                data = workflow(name)
                self.assertEqual(data["permissions"], {"contents": "read"})
                self.assertEqual(data["jobs"][job]["permissions"], expected)

    def test_ci_executes_the_contract_with_the_existing_pinned_parser(self):
        steps = workflow("ci.yml")["jobs"]["offline-suites"]["steps"]
        index = next(i for i, step in enumerate(steps)
                     if step.get("run") == "python3 scripts/test_workflow_hardening.py")
        step = steps[index]
        self.assertNotIn("if", step)
        self.assertFalse(step.get("continue-on-error", False))
        self.assertEqual(step["env"]["PYTHONPATH"], "${{ runner.temp }}/static-label-guard-deps")
        install = next(i for i, step in enumerate(steps)
                       if "-r scripts/static-label-guard-requirements.txt" in step.get("run", ""))
        self.assertLess(install, index)
        self.assertIn("--only-binary=:all: --no-deps --require-hashes", steps[install]["run"])

    def test_literal_template_mutation_executes_canary_and_is_detected(self):
        needs = results()
        with tempfile.TemporaryDirectory() as directory:
            canary = str(Path(directory) / "executed")
            needs["offline-suites"]["outputs"]["untrusted"] = "'; touch ${CANARY}; #"
            mutant = copy.deepcopy(step_for("failure-log-drain"))
            mutant["run"] = "echo '${{ toJSON(needs) }}'"
            execute(mutant, needs, CANARY=canary)
            self.assertTrue(Path(canary).is_file(), "injection positive control did not execute")


if __name__ == "__main__":
    unittest.main()
