#!/usr/bin/env python3
"""Immutable Action reference contract, including red/green positive controls."""
from pathlib import Path
import re
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
REMOTE = re.compile(r"[^@\s]+@[0-9a-fA-F]{40}\Z")
DOCKER = re.compile(r"docker://[^@\s]+@sha256:[0-9a-fA-F]{64}\Z")


def check_uses(value, *, reusable=False):
    if not isinstance(value, str):
        raise ValueError("uses must be a string")
    if value.startswith("./") and len(value) > 2 and "@" not in value:
        return
    if not reusable and DOCKER.fullmatch(value):
        return
    if REMOTE.fullmatch(value) and not value.startswith("docker://"):
        return
    raise ValueError(f"pin remote uses to a full commit SHA (Docker: sha256 digest): {value!r}")


def check_workflow(text):
    workflow = yaml.safe_load(text)
    if not isinstance(workflow, dict) or not isinstance(workflow.get("jobs"), dict) or not workflow["jobs"]:
        raise ValueError("workflow must contain a non-empty jobs mapping")
    count = 0
    for name, job in workflow["jobs"].items():
        if not isinstance(job, dict):
            raise ValueError(f"job {name!r} must be a mapping")
        if "uses" in job:
            check_uses(job["uses"], reusable=True)
            count += 1
        else:
            steps = job.get("steps")
            if not isinstance(steps, list) or not steps:
                raise ValueError(f"job {name!r} must have steps or reusable uses")
            for step in steps:
                if not isinstance(step, dict):
                    raise ValueError(f"job {name!r} step must be a mapping")
                if "uses" in step:
                    check_uses(step["uses"])
                    count += 1
    return count


class ActionPins(unittest.TestCase):
    def test_all_repository_workflows_are_immutable(self):
        paths = sorted((ROOT / ".github/workflows").glob("*.y*ml"))
        self.assertTrue(paths, "no workflows measured")
        for path in paths:
            with self.subTest(workflow=path.name):
                check_workflow(path.read_text())

    def test_full_commits_local_actions_and_container_digests_pass(self):
        for reference in ("actions/checkout@" + "a" * 40, "./.github/actions/build",
                          "docker://alpine:3@sha256:" + "b" * 64):
            with self.subTest(reference=reference):
                check_uses(reference)

    def test_mutable_and_malformed_refs_fail(self):
        for reference in ("actions/checkout@v7", "vendor/action@main", "vendor/action@latest",
                          "vendor/action@" + "a" * 39, "vendor/action@" + "g" * 40,
                          "vendor/action@" + "a" * 41, "vendor/action", "", None, 7,
                          "docker://alpine:3", "docker://alpine@" + "a" * 40,
                          "docker://alpine@sha256:" + "b" * 63, "./", "./action@main"):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                check_uses(reference)

    def test_job_level_reusable_refs_are_checked(self):
        check_workflow("jobs:\n  shared:\n    uses: vendor/repo/.github/workflows/ci.yml@" + "a" * 40)
        check_workflow("jobs:\n  shared:\n    uses: ./.github/workflows/shared.yml")
        for ref in ("vendor/repo/.github/workflows/ci.yml@main", "docker://alpine@sha256:" + "b" * 64):
            with self.subTest(reference=ref), self.assertRaises(ValueError):
                check_workflow("jobs:\n  shared:\n    uses: " + ref)

    def test_quoted_and_flow_style_uses_cannot_hide_mutable_refs(self):
        for text in ("jobs: {test: {steps: [{uses: 'actions/checkout@v7'}]}}",
                     'jobs:\n  test:\n    steps:\n      - "uses": "actions/checkout@v7"'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                check_workflow(text)

    def test_empty_malformed_and_unmeasured_workflows_fail(self):
        for text in ("", "[]", "jobs: {}", "jobs: []", "jobs: {test: null}",
                     "jobs: {test: {}}", "jobs: {test: {steps: []}}",
                     "jobs: {test: {steps: [null]}}", "jobs: ["):
            with self.subTest(text=text), self.assertRaises((ValueError, yaml.YAMLError)):
                check_workflow(text)

    def test_pin_mutation_is_detected(self):
        good = "jobs: {test: {steps: [{uses: 'vendor/action@" + "a" * 40 + "'}]}}"
        self.assertEqual(check_workflow(good), 1)
        with self.assertRaises(ValueError):
            check_workflow(good.replace("a" * 40, "v7"))

    def test_ci_executes_the_contract_with_hash_pinned_parser(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
        job = workflow["jobs"]["offline-suites"]
        self.assertEqual(job["needs"], ["changes"])
        self.assertEqual(job["if"], "needs.changes.outputs.heavy == 'true'")
        steps = job["steps"]
        runs = [step.get("run", "") for step in steps]
        self.assertIn("python3 scripts/test_action_pins.py", runs)
        index = runs.index("python3 scripts/test_action_pins.py")
        step = steps[index]
        self.assertNotIn("if", step)
        self.assertFalse(step.get("continue-on-error", False))
        self.assertEqual(step["env"]["PYTHONPATH"], "${{ runner.temp }}/static-label-guard-deps")
        install = next(i for i, run in enumerate(runs)
                       if "-r scripts/static-label-guard-requirements.txt" in run)
        self.assertIn("--only-binary=:all: --no-deps --require-hashes", runs[install])
        self.assertLess(install, index)


if __name__ == "__main__":
    unittest.main()
