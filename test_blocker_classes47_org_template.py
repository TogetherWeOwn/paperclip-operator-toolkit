#!/usr/bin/env python3
"""Acceptance tests for the durable (org-level) classes 4-7 gates.

Durable-by-default requirement: anything used on more
than one repo lives ONCE at org level so new repos inherit it. This file
pins the org shape for the blocker-ledger migration / API-contract /
concurrency / lockfile checks; the deterministic logic itself is pinned
by `test_blocker_migration_checks.py`,
`test_blocker_api_contract_checks.py`,
`test_blocker_concurrency_checks.py` and
`test_blocker_lockfile_checks.py`.

Contract under test (to be implemented by the Builder, staged source
pattern like tier-0 / test-missing):

- `templates/org-github/blocker-classes47/<gate>-gate.yml` for
  `<gate>` in migration, api-contract, concurrency, lockfile: reusable
  `workflow_call` workflow, `mode` default `warn`, no path filters,
  SHA-pinned actions, every job has `timeout-minutes`.
- `templates/org-github/blocker-classes47/<gate>-required.yml`: thin
  `pull_request` + `merge_group` wrapper so an org ruleset can require
  the WORKFLOW, re-exporting a bare `<gate>` check.
- `.github/workflows/blocker-<gate>.yml` (this repo): warn-only callers,
  each calling the org reusable by pinned SHA (never a moving tag).
- `templates/org-github/blocker-classes47/blocker_<gate>_checks.py`
  (underscores): staged verbatim copies of the repo-root logic modules
  (fix upstream, then re-copy; never hand-edit the copy).
- `templates/org-github/rulesets/blocker-classes47-report-only.json`
  (evaluate) and `blocker-classes47-required.json` (active): valid JSON,
  differ only in enforcement, carry a `workflows` rule (the GitHub
  org-ruleset type) with `conditions.repository_name`, integer
  `repository_id` placeholder `0`, `ref: refs/heads/main` and
  `sha: PINNED_SHA` per workflow entry.
- `templates/org-github/blocker-classes47/ADOPTION.md`: caller snippets
  with a pinned-SHA placeholder, warn mode, single-context wiring.
- `templates/org-github/README.md` destination map names every new file.

Style: stdlib unittest, hermetic (no network, no clock). Every test
fails while the staged files are missing — the correct RED reason.
"""

import json
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGE = HERE / "templates" / "org-github" / "blocker-classes47"
CALLERS = HERE / ".github" / "workflows"
RULESETS = HERE / "templates" / "org-github" / "rulesets"
README = HERE / "templates" / "org-github" / "README.md"

GATES = ("migration", "api-contract", "concurrency", "lockfile")


def gate_file(gate):
    return STAGE / f"{gate}-gate.yml"


def required_file(gate):
    return STAGE / f"{gate}-required.yml"


def caller_file(gate):
    return CALLERS / f"blocker-{gate}.yml"


def staged_logic(gate):
    return STAGE / f"blocker_{gate.replace('-', '_')}_checks.py"


def root_logic(gate):
    return HERE / f"blocker_{gate.replace('-', '_')}_checks.py"


class ReusableGateTest(unittest.TestCase):
    def test_staged_reusable_workflows_exist(self):
        for gate in GATES:
            self.assertTrue(
                gate_file(gate).is_file(), f"missing staged gate: {gate}"
            )

    def test_staged_reusables_are_warn_default_workflow_call(self):
        for gate in GATES:
            text = gate_file(gate).read_text()
            self.assertIn("workflow_call:", text, gate)
            self.assertIn('default: "warn"', text, gate)

    def test_staged_reusables_have_no_path_filters(self):
        for gate in GATES:
            text = gate_file(gate).read_text()
            self.assertNotIn("paths:", text, f"{gate} must not path-filter")

    def test_staged_reusables_pin_actions_and_timeout(self):
        for gate in GATES:
            text = gate_file(gate).read_text()
            self.assertIn("timeout-minutes:", text, gate)
            uses = re.findall(r"uses:\s*(\S+)", text)
            self.assertTrue(uses, f"{gate} must use at least one action")
            for ref in uses:
                if ref.startswith("./") or ref.startswith("docker://"):
                    continue
                self.assertRegex(
                    ref,
                    r"^[^@]+@[0-9a-f]{40}$",
                    f"{gate}: action must be SHA-pinned: {ref}",
                )


class RequiredWrapperTest(unittest.TestCase):
    def test_required_wrappers_exist_with_pr_and_merge_group(self):
        for gate in GATES:
            text = required_file(gate).read_text()
            self.assertIn("pull_request:", text, gate)
            self.assertIn("merge_group:", text, gate)
            self.assertIn(f"name: {gate}", text, gate)


class CallerTest(unittest.TestCase):
    def test_repo_callers_exist_and_call_org_reusable_by_sha(self):
        for gate in GATES:
            caller = caller_file(gate)
            self.assertTrue(caller.is_file(), f"missing caller: {caller}")
            text = caller.read_text()
            m = re.search(
                r"uses:\s*TogetherWeOwn/\.github/\.github/workflows/\S+@[0-9a-f]{40}",
                text,
            )
            self.assertIsNotNone(
                m, f"{gate}: caller must call the org reusable by pinned SHA"
            )

    def test_repo_callers_default_warn(self):
        for gate in GATES:
            text = caller_file(gate).read_text()
            self.assertIn("warn", text, gate)


class StagedLogicCopyTest(unittest.TestCase):
    def test_staged_logic_copies_exist(self):
        for gate in GATES:
            self.assertTrue(
                staged_logic(gate).is_file(),
                f"missing staged copy: {staged_logic(gate)}",
            )

    def test_staged_copies_match_root_sources(self):
        for gate in GATES:
            root = root_logic(gate)
            staged = staged_logic(gate)
            self.assertTrue(
                root.is_file(), "root source missing (Builder implements it)"
            )
            self.assertTrue(
                staged.is_file(), f"missing staged copy: {staged}"
            )
            self.assertEqual(
                staged.read_bytes(),
                root.read_bytes(),
                f"staged copy must be verbatim: {gate}",
            )


class RulesetPayloadTest(unittest.TestCase):
    def test_ruleset_payloads_exist_and_differ_only_in_enforcement(self):
        stage1 = json.loads(
            (RULESETS / "blocker-classes47-report-only.json").read_text()
        )
        stage2 = json.loads(
            (RULESETS / "blocker-classes47-required.json").read_text()
        )
        self.assertEqual(stage1.get("enforcement"), "evaluate")
        self.assertEqual(stage2.get("enforcement"), "active")
        s1 = {
            k: v for k, v in stage1.items() if k not in ("enforcement", "_comment")
        }
        s2 = {
            k: v for k, v in stage2.items() if k not in ("enforcement", "_comment")
        }
        self.assertEqual(s1, s2)

    def test_ruleset_carries_required_workflow_with_placeholder(self):
        stage1 = json.loads(
            (RULESETS / "blocker-classes47-report-only.json").read_text()
        )
        # GitHub org-ruleset type is `workflows` (rest-api-description
        # repository-rule-workflows enum); `required_workflows` is rejected.
        wfs = [
            w
            for r in stage1.get("rules", [])
            if r.get("type") == "workflows"
            for w in r.get("parameters", {}).get("workflows", [])
        ]
        self.assertTrue(wfs, "ruleset must carry a workflows entry")
        self.assertEqual(len(wfs), 4, "one entry per blocker gate")
        for w in wfs:
            self.assertIsInstance(
                w.get("repository_id"), int,
                "repository_id stays an integer placeholder until the runbook fills it",
            )
            self.assertEqual(w.get("ref"), "refs/heads/main")
            self.assertEqual(w.get("sha"), "PINNED_SHA")
            self.assertTrue(w.get("path", "").startswith(".github/workflows/"))
        cond = stage1.get("conditions", {})
        self.assertIn("repository_name", cond)
        self.assertEqual(cond["repository_name"].get("include"), ["*"])


class AdoptionMapTest(unittest.TestCase):
    def test_adoption_guide_exists_with_pinned_sha_placeholder(self):
        adoption = STAGE / "ADOPTION.md"
        self.assertTrue(
            adoption.is_file(), f"missing adoption guide: {adoption}"
        )
        text = adoption.read_text()
        self.assertIn("@<pinned-sha>", text)
        self.assertIn("warn", text)
        for gate in GATES:
            self.assertIn(gate, text, f"adoption must cover {gate}")

    def test_readme_destination_map_names_new_files(self):
        text = README.read_text()
        expected = []
        for gate in GATES:
            expected.append(f"blocker-classes47/{gate}-gate.yml")
            expected.append(f"blocker-classes47/{gate}-required.yml")
            expected.append(
                f"blocker-classes47/blocker_{gate.replace('-', '_')}_checks.py"
            )
        expected += [
            "blocker-classes47/ADOPTION.md",
            "rulesets/blocker-classes47-report-only.json",
            "rulesets/blocker-classes47-required.json",
        ]
        for f in expected:
            self.assertIn(f, text, f"destination map must name {f}")


if __name__ == "__main__":
    unittest.main()
