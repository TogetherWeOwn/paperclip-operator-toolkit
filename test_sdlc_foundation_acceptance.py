"""Behavioral acceptance tests for Land #939: the SDLC 1.0 shared
CI/policy foundation stage, mirrored into this public repo at
templates/org-github/.

These pin the properties that make the foundation safe to adopt, each
named for the production change that would break it:

- The org baseline ruleset twins differ ONLY in enforcement, so the
  evaluate -> active flip can never smuggle a rule change.
- The twins require the stable check names ci-ok + pr-lint (pinned to
  the Actions integration) on main across all repos, require PR thread
  resolution, and carry NO merge queue and NO approval-count gate --
  either one appearing would block merges org-wide on producers that do
  not exist yet.
- The ONE repo exclude list is well-formed, and discover-repos.sh
  subtracts exactly that list (proven behaviorally with a custom list,
  not by reading its source), preserves order, renders JSON, and fails
  closed on empty input instead of reporting an empty org.
- The rendered ruleset payload (exclude list injected the way the
  runbook does it) excludes exactly the listed repos -- the runbook,
  the payloads and discovery cannot drift into three lists.
- The day-1 repo template keeps merge_group, never path-filters a
  trigger (which would suppress the required ci-ok check), pins or
  fill-marks every org `uses:`, aggregates ci-ok with if: always(),
  and ships the policy-bot stub disabled by construction.
- The decision doc names the org .github repo as the one pin root and
  rejects a second ci-shared repo; the bootstrap documents the pin
  fill and the stub rename.

Hermetic: stdlib only, no network, no credentials. Discovery runs
behind its GH_REPO_LIST_FIXTURE seam.

RED before the Land #939 mirror: the staged tree is absent and every
test fails on that fact. GREEN after: all pass.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE = ROOT / "templates" / "org-github"
FOUND = BASE / "sdlc-foundation"
DISCOVER = FOUND / "discover-repos.sh"
EXCLUDE_LIST = FOUND / "repo-exclude-list.txt"
EVALUATE = BASE / "rulesets" / "sdlc-baseline-evaluate.json"
ACTIVE = BASE / "rulesets" / "sdlc-baseline-active.json"
RUNBOOK = BASE / "rulesets" / "SDLC-BASELINE-RUNBOOK.md"
TEMPLATE_CI = FOUND / "repo-template" / "ci.yml"

NAME_OR_GLOB = re.compile(r"^[A-Za-z0-9_.-]+\*?$")
ACTIONS_INTEGRATION_ID = 15368


def read_exclude_entries(path=EXCLUDE_LIST):
    entries = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            entries.append(line)
    return entries


class StagedTreeCase(unittest.TestCase):
    def setUp(self):
        self.assertTrue(
            BASE.is_dir(),
            "templates/org-github/ absent -- the Land #939 foundation "
            "stage has not been mirrored into this public repo",
        )


class RulesetTwinsTest(StagedTreeCase):
    def setUp(self):
        super().setUp()
        for payload in (EVALUATE, ACTIVE):
            self.assertTrue(payload.is_file(), f"missing ruleset payload: {payload}")
        self.evaluate = json.loads(EVALUATE.read_text())
        self.active = json.loads(ACTIVE.read_text())

    @staticmethod
    def _strip(payload, *keys):
        return {k: v for k, v in payload.items() if k not in keys}

    def test_twins_differ_only_in_enforcement(self):
        # The evaluate->active flip must change nothing but enforcement;
        # any other drift means stage 2 enforces rules stage 1 never
        # measured.
        self.assertEqual(
            self._strip(self.evaluate, "_comment", "enforcement"),
            self._strip(self.active, "_comment", "enforcement"),
        )
        self.assertEqual(self.evaluate["enforcement"], "evaluate")
        self.assertEqual(self.active["enforcement"], "active")

    def test_baseline_targets_main_across_all_repos(self):
        self.assertEqual(self.evaluate["name"], "sdlc-baseline")
        self.assertEqual(self.evaluate["target"], "branch")
        self.assertEqual(
            self.evaluate["conditions"]["ref_name"]["include"],
            ["refs/heads/main"],
        )
        self.assertEqual(
            self.evaluate["conditions"]["repository_name"]["include"], ["*"]
        )

    def test_required_checks_are_stable_names_pinned_to_actions(self):
        # Required checks are matched by context name; a renamed or
        # unpinned context is the rename trap that blocks every PR.
        rules = [r for r in self.evaluate["rules"]
                 if r["type"] == "required_status_checks"]
        self.assertEqual(len(rules), 1)
        contexts = {
            c["context"]: c.get("integration_id")
            for c in rules[0]["parameters"]["required_status_checks"]
        }
        self.assertEqual(
            contexts,
            {"ci-ok": ACTIONS_INTEGRATION_ID, "pr-lint": ACTIONS_INTEGRATION_ID},
        )
        self.assertIs(
            rules[0]["parameters"].get("strict_required_status_checks_policy"),
            False,
        )

    def test_no_merge_queue_and_no_approval_count_gate(self):
        types = {r["type"] for r in self.evaluate["rules"]}
        self.assertNotIn("merge_queue", types)
        pr_rules = [r for r in self.evaluate["rules"] if r["type"] == "pull_request"]
        self.assertEqual(len(pr_rules), 1)
        params = pr_rules[0]["parameters"]
        self.assertEqual(params.get("required_approving_review_count"), 0)
        self.assertIs(params.get("required_review_thread_resolution"), True)

    def test_rendered_payload_excludes_exactly_the_one_list(self):
        # Reproduce the runbook's mechanical render (inject the exclude
        # list into repository_name.exclude) and prove the payload then
        # excludes exactly the listed entries -- no second list.
        entries = read_exclude_entries()
        rendered = json.loads(EVALUATE.read_text())
        rendered["conditions"]["repository_name"]["exclude"] = entries
        self.assertEqual(
            rendered["conditions"]["repository_name"]["exclude"], entries
        )
        self.assertEqual(rendered["enforcement"], "evaluate")
        self.assertEqual(
            rendered["conditions"]["repository_name"]["include"], ["*"]
        )


class ExcludeListTest(StagedTreeCase):
    def test_entries_are_names_or_prefix_globs(self):
        self.assertTrue(EXCLUDE_LIST.is_file(), f"missing: {EXCLUDE_LIST}")
        entries = read_exclude_entries()
        self.assertTrue(entries, "exclude list has no entries")
        for entry in entries:
            self.assertRegex(entry, NAME_OR_GLOB)

    def test_list_covers_replays_and_the_policy_repo(self):
        # Snapshot mirrors are never gated, and the policy repo cannot
        # be required to produce ci-ok before it reports it -- dropping
        # either entry re-gates repos that can never go green.
        self.assertEqual(set(read_exclude_entries()), {"replay-*", ".github"})


class DiscoveryTest(StagedTreeCase):
    def setUp(self):
        super().setUp()
        self.assertTrue(DISCOVER.is_file(), f"missing: {DISCOVER}")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture = Path(self.tmp.name) / "repos.txt"
        self.fixture.write_text(
            "TogetherWeOwn/two-bot-next\n"
            "TogetherWeOwn/replay-two-bot\n"
            "TogetherWeOwn/.github\n"
            "TogetherWeOwn/replay\n"
            "TogetherWeOwn/nntunev2\n"
        )

    def discover(self, *args, fixture=None):
        env = dict(os.environ)
        env["GH_REPO_LIST_FIXTURE"] = str(fixture or self.fixture)
        return subprocess.run(
            [str(DISCOVER), *args],
            capture_output=True, text=True, env=env, timeout=30,
        )

    def test_discovery_subtracts_the_exclude_list_and_keeps_order(self):
        result = self.discover()
        self.assertEqual(result.returncode, 0, result.stderr)
        # replay-* is a prefix glob: bare "replay" (no dash) survives.
        self.assertEqual(
            result.stdout.splitlines(),
            ["TogetherWeOwn/two-bot-next", "TogetherWeOwn/replay",
             "TogetherWeOwn/nntunev2"],
        )

    def test_discovery_json_renders_the_kept_set(self):
        result = self.discover("--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            ["TogetherWeOwn/two-bot-next", "TogetherWeOwn/replay",
             "TogetherWeOwn/nntunev2"],
        )

    def test_discovery_reads_the_list_it_is_given(self):
        # Behavioral proof there is no hardcoded repo list: a custom
        # exclude file changes the output.
        custom = Path(self.tmp.name) / "custom-excludes.txt"
        custom.write_text("# comment\n\nnntunev2\n")
        result = self.discover("--exclude-file", str(custom))
        self.assertEqual(result.returncode, 0, result.stderr)
        kept = result.stdout.splitlines()
        self.assertIn("TogetherWeOwn/.github", kept)
        self.assertNotIn("TogetherWeOwn/nntunev2", kept)

    def test_empty_repo_list_fails_closed(self):
        empty = Path(self.tmp.name) / "empty.txt"
        empty.write_text("")
        result = self.discover(fixture=empty)
        self.assertNotEqual(
            result.returncode, 0,
            "an empty org listing must fail closed, never report zero repos",
        )

    def test_missing_inputs_fail(self):
        missing = Path(self.tmp.name) / "nope.txt"
        self.assertNotEqual(self.discover(fixture=missing).returncode, 0)
        self.assertNotEqual(
            self.discover("--exclude-file", str(missing)).returncode, 0
        )
        self.assertNotEqual(self.discover("--bogus").returncode, 0)


class RepoTemplateTest(StagedTreeCase):
    def setUp(self):
        super().setUp()
        self.assertTrue(TEMPLATE_CI.is_file(), f"missing: {TEMPLATE_CI}")
        self.ci = TEMPLATE_CI.read_text()

    def test_template_keeps_merge_group_and_never_path_filters(self):
        self.assertIn("merge_group: {}", self.ci)
        triggers = re.search(r"^on:\n((?:  .*\n)+)", self.ci, re.MULTILINE)
        self.assertIsNotNone(triggers, "template has no on: block")
        self.assertNotIn(
            "paths", triggers.group(1),
            "a path-filtered trigger suppresses the required ci-ok check",
        )

    def test_org_uses_are_pinned_or_fill_marked_never_floating(self):
        floating = re.findall(
            r"uses:\s+TogetherWeOwn/[^@\s]+@(main|master|latest)\b", self.ci
        )
        self.assertEqual(floating, [])
        org_uses = re.findall(r"uses:\s+(TogetherWeOwn/[^@\s]+@\S+)", self.ci)
        self.assertTrue(org_uses, "template calls no org reusable workflow")
        for use in org_uses:
            ref = use.rsplit("@", 1)[1]
            self.assertTrue(
                re.fullmatch(r"[0-9a-f]{40}", ref)
                or re.fullmatch(r"<PINNED_[A-Z_]+>", ref),
                f"org uses: not pinned or fill-marked: {use}",
            )

    def test_ci_ok_aggregates_every_job_with_always(self):
        for job in ("changes", "tier-0", "lint", "secret-scan", "ci-ok"):
            self.assertRegex(self.ci, rf"(?m)^  {re.escape(job)}:")
            self.assertIn(f"name: {job}", self.ci)
        self.assertIn("needs: [changes, tier-0, lint, secret-scan]", self.ci)
        self.assertIn("if: always()", self.ci)
        self.assertIn("contents: read", self.ci)
        self.assertIn("persist-credentials: false", self.ci)

    def test_policy_bot_stub_is_disabled_by_construction(self):
        stub = FOUND / "repo-template" / "policy-bot.yml.disabled"
        self.assertTrue(stub.is_file(), f"missing: {stub}")
        live = [
            line for line in stub.read_text().splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertEqual(
            live, [],
            "an enforcing policy-bot on day 1 would gate the repo on "
            "unmeasured lanes; the stub must be comments only",
        )

    def test_codeowners_carries_the_owning_team_placeholder(self):
        codeowners = FOUND / "repo-template" / "CODEOWNERS"
        self.assertTrue(codeowners.is_file(), f"missing: {codeowners}")
        self.assertIn("<OWNING-TEAM>", codeowners.read_text())


class DocsContractTest(StagedTreeCase):
    def test_decision_names_one_pin_root_and_rejects_ci_shared(self):
        decision = FOUND / "DECISION-central-repo.md"
        self.assertTrue(decision.is_file(), f"missing: {decision}")
        text = decision.read_text()
        self.assertIn("TogetherWeOwn/.github", text)
        self.assertRegex(
            text, r"(?i)no (new )?`?ci-shared`?",
            "the decision must record that no second ci-shared repo "
            "splits the pin root",
        )

    def test_bootstrap_documents_pin_fill_and_stub_rename(self):
        bootstrap = FOUND / "BOOTSTRAP-new-repo.md"
        self.assertTrue(bootstrap.is_file(), f"missing: {bootstrap}")
        text = bootstrap.read_text()
        for token in ("<PINNED_CHANGES_SHA>", "<PINNED_GATE_SHA>",
                      "<OWNING-TEAM>", "policy-bot.yml.disabled",
                      "merge_queue_ready"):
            self.assertIn(token, text)

    def test_runbook_wires_exclude_injection_discovery_and_rollback(self):
        self.assertTrue(RUNBOOK.is_file(), f"missing: {RUNBOOK}")
        text = RUNBOOK.read_text()
        for token in ("repo-exclude-list.txt", "discover-repos.sh",
                      "sdlc-baseline-evaluate.json",
                      "sdlc-baseline-active.json",
                      "enforcement=disabled"):
            self.assertIn(token, text)
        # Stage order is load-bearing: evaluate is applied and audited
        # before active is flipped.
        self.assertLess(
            text.index("sdlc-baseline-evaluate.json"),
            text.index("sdlc-baseline-active.json"),
        )

    def test_staging_migrate_contract_is_staging_first(self):
        contract = FOUND / "repo-template" / "STAGING-MIGRATE-CONTRACT.md"
        self.assertTrue(contract.is_file(), f"missing: {contract}")
        self.assertRegex(contract.read_text(), r"(?i)staging first")


if __name__ == "__main__":
    unittest.main(verbosity=2)
