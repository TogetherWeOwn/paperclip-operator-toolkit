#!/usr/bin/env python3
"""Landing acceptance for public PR #88 (mirror shared config/deploy checks).

Verifies the landing criteria of https://github.com/TogetherWeOwn/paperclip-operator-toolkit/pull/88
after the Paperclip Review 2/5 findings were addressed: the staged org rollout
must work as written (reusable workflow, caller pin, required context, merge
queue) and the checker must stay fail-closed on malformed shapes without
crashing, while real reusable/matrix check contexts match.

Target selection (no network, stdlib only):
  PR88_CHECKER   path to config_deploy_check.py under test
                 (default: ./config_deploy_check.py, the post-landing layout)
  PR88_TEMPLATES path to templates/org-github/config-deploy under test
                 (default: ./templates/org-github/config-deploy)

Each test maps to one review finding (F1..F7). The suite FAILS on the
reviewed head and PASSES on the fixed head; see the card for the recorded
fail-before / pass-after runs.
"""

import importlib.util
import json
import os
import re
import tempfile
import unittest
from pathlib import Path

CHECKER = Path(os.environ.get("PR88_CHECKER", "config_deploy_check.py"))
TEMPLATES = Path(os.environ.get("PR88_TEMPLATES", "templates/org-github/config-deploy"))

SHA = "a" * 40
PINNED_CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262"


def load_checker(path):
    spec = importlib.util.spec_from_file_location("pr88_checker", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_tree(files):
    tmp = tempfile.TemporaryDirectory(prefix="pr88-landing-")
    root = Path(tmp.name)
    for rel, content in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            p.write_bytes(content)
        else:
            p.write_text(content, encoding="utf-8")
    return tmp, root


def codes(findings):
    return [f.code for f in findings]


def workflow_with(job_block):
    return (
        "name: ci\n"
        "on:\n"
        "  pull_request:\n"
        "jobs:\n"
        f"{job_block}\n"
    )


class LandingTemplates(unittest.TestCase):
    """Rollout files: reusable workflow, caller pin, ruleset (F1..F4)."""

    @classmethod
    def setUpClass(cls):
        for name in ("config-deploy.yml", "caller-workflow.yml", "org-ruleset.json"):
            if not (TEMPLATES / name).is_file():
                raise AssertionError(f"missing staged template (fail-closed): {TEMPLATES / name}")
        cls.reusable = (TEMPLATES / "config-deploy.yml").read_text(encoding="utf-8")
        cls.caller = (TEMPLATES / "caller-workflow.yml").read_text(encoding="utf-8")
        cls.ruleset = json.loads((TEMPLATES / "org-ruleset.json").read_text(encoding="utf-8"))

    def test_f1_host_checkout_into_separate_path(self):
        self.assertRegex(
            self.reusable,
            r"(?m)^\s*repository:\s*\S+",
            "F1: reusable workflow must check out the hosting repo explicitly",
        )
        self.assertIn("path: .config-deploy", self.reusable)

    def test_f1_checker_runs_from_host_checkout(self):
        self.assertIn(".config-deploy/", self.reusable)
        self.assertNotIn(
            "python3 .github/scripts/config_deploy_check.py",
            self.reusable,
            "F1: checker must not resolve from the caller checkout",
        )

    def test_f2_caller_pin_is_post_merge_placeholder(self):
        pins = re.findall(r"@[0-9a-fA-F]{40}\b", self.caller)
        self.assertEqual(pins, [], f"F2: caller must not pin a foreign 40-hex commit: {pins}")
        placeholders = re.findall(r"CONFIG_DEPLOY_ORG_GITHUB_SHA", self.caller)
        self.assertGreaterEqual(
            len(placeholders), 2, "F2: uses: and checker_ref must share one placeholder"
        )

    def test_f3_ruleset_requires_reusable_produced_context(self):
        rules = [r for r in self.ruleset["rules"] if r.get("type") == "required_status_checks"]
        self.assertEqual(len(rules), 1, "F3: exactly one required_status_checks rule")
        contexts = [c["context"] for c in rules[0]["parameters"]["required_status_checks"]]
        self.assertIn("config-deploy / config-deploy", contexts)
        self.assertNotIn("config-deploy", contexts)

    def test_f4_no_org_wide_merge_queue(self):
        types = [r.get("type") for r in self.ruleset["rules"]]
        self.assertNotIn("merge_queue", types)

    def test_f4_caller_runs_on_merge_group(self):
        self.assertIn("merge_group", self.caller)


class LandingChecker(unittest.TestCase):
    """Checker behavior: timeout scope, malformed shapes, real contexts (F5..F7)."""

    @classmethod
    def setUpClass(cls):
        if not CHECKER.is_file():
            raise AssertionError(f"missing checker under test (fail-closed): {CHECKER}")
        cls.mod = load_checker(CHECKER)

    def check(self, files):
        tmp, root = write_tree(files)
        try:
            return self.mod.check_tree(str(root)), root
        finally:
            tmp.cleanup()

    def test_f5_step_level_uses_does_not_exempt_timeout(self):
        job = (
            "  build:\n"
            "    runs-on: ubuntu-latest\n"
            "    steps:\n"
            "      - name: Check out code\n"
            f"        uses: {PINNED_CHECKOUT} # v4\n"
            "      - run: echo hi\n"
        )
        findings, _ = self.check({".github/workflows/ci.yml": workflow_with(job)})
        self.assertIn("WORKFLOW_TIMEOUT", codes(findings))

    def test_f5_job_level_uses_still_exempt_from_timeout(self):
        # Preserved behavior: a reusable-workflow caller job cannot carry
        # timeout-minutes, so it must stay exempt.
        job = (
            "  config-deploy:\n"
            f"    uses: TogetherWeOwn/.github/.github/workflows/config-deploy.yml@{SHA}\n"
            "    with:\n"
            f"      checker_ref: {SHA}\n"
        )
        findings, _ = self.check({".github/workflows/ci.yml": workflow_with(job)})
        self.assertNotIn("WORKFLOW_TIMEOUT", codes(findings))

    def test_f6_string_list_required_fails_closed(self):
        job = (
            "  build:\n"
            "    runs-on: ubuntu-latest\n"
            "    timeout-minutes: 5\n"
            "    steps:\n"
            f"      - uses: {PINNED_CHECKOUT} # v4\n"
        )
        doc = json.dumps({"required": ["ci-ok"]})
        findings, _ = self.check(
            {
                ".github/workflows/ci.yml": workflow_with(job),
                "required_checks.json": doc,
            }
        )
        self.assertIn("REQUIRED_CHECKS_PARSE", codes(findings))
        self.assertNotIn("REQUIRED_CHECK_MISSING", codes(findings))

    def test_f6_list_valued_context_fails_closed_without_crash(self):
        job = (
            "  build:\n"
            "    runs-on: ubuntu-latest\n"
            "    timeout-minutes: 5\n"
            "    steps:\n"
            f"      - uses: {PINNED_CHECKOUT} # v4\n"
        )
        doc = json.dumps({"required": [{"context": ["ci-ok"]}]})
        findings, _ = self.check(
            {
                ".github/workflows/ci.yml": workflow_with(job),
                "required_checks.json": doc,
            }
        )
        self.assertIn("REQUIRED_CHECKS_PARSE", codes(findings))

    def test_f6_non_utf8_env_example_does_not_crash(self):
        job = (
            "  build:\n"
            "    runs-on: ubuntu-latest\n"
            "    timeout-minutes: 5\n"
            "    steps:\n"
            f"      - uses: {PINNED_CHECKOUT} # v4\n"
        )
        findings, _ = self.check(
            {
                ".github/workflows/ci.yml": workflow_with(job),
                ".env.example": b"GOOD_KEY=ok\nBAD_KEY=\xff\xfe\n",
            }
        )
        self.assertIsInstance(findings, list)

    def test_f7_reusable_produced_context_matches(self):
        job = (
            "  config-deploy:\n"
            f"    uses: TogetherWeOwn/.github/.github/workflows/config-deploy.yml@{SHA}\n"
            "    with:\n"
            f"      checker_ref: {SHA}\n"
        )
        doc = json.dumps({"required": [{"context": "config-deploy / config-deploy"}]})
        findings, _ = self.check(
            {
                ".github/workflows/ci.yml": workflow_with(job),
                "required_checks.json": doc,
            }
        )
        self.assertNotIn("REQUIRED_CHECK_MISSING", codes(findings))

    def test_f7_bare_context_does_not_match_reusable_producer(self):
        job = (
            "  config-deploy:\n"
            f"    uses: TogetherWeOwn/.github/.github/workflows/config-deploy.yml@{SHA}\n"
            "    with:\n"
            f"      checker_ref: {SHA}\n"
        )
        doc = json.dumps({"required": [{"context": "config-deploy"}]})
        findings, _ = self.check(
            {
                ".github/workflows/ci.yml": workflow_with(job),
                "required_checks.json": doc,
            }
        )
        self.assertIn("REQUIRED_CHECK_MISSING", codes(findings))

    def test_f7_matrix_context_matches(self):
        job = (
            "  test:\n"
            "    runs-on: ubuntu-latest\n"
            "    timeout-minutes: 5\n"
            "    strategy:\n"
            "      matrix:\n"
            "        os: [ubuntu-latest]\n"
            "    steps:\n"
            f"      - uses: {PINNED_CHECKOUT} # v4\n"
        )
        doc = json.dumps({"required": [{"context": "test (ubuntu-latest)"}]})
        findings, _ = self.check(
            {
                ".github/workflows/ci.yml": workflow_with(job),
                "required_checks.json": doc,
            }
        )
        self.assertNotIn("REQUIRED_CHECK_MISSING", codes(findings))

    def test_bad_config_tree_exits_nonzero_in_error_mode(self):
        tmp, root = write_tree(
            {
                ".github/workflows/ci.yml": workflow_with(
                    "  build:\n"
                    "    runs-on: ubuntu-latest\n"
                    "    steps:\n"
                    "      - uses: actions/checkout@v4\n"
                ),
            }
        )
        try:
            rc = self.mod.main(["--root", str(root), "--mode", "error"])
        finally:
            tmp.cleanup()
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
