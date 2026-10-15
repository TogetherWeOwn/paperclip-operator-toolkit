#!/usr/bin/env python3
"""Advisory risk-lane acceptance tests (paired tests for Land #938).

PR TogetherWeOwn/paperclip-ops-tooling#938 adds the deterministic
LOW/HIGH risk-lane classifier, its JSONL lane ledger, the embedded
org-wide advisory workflow, the thin required wrapper, the org ruleset
draft and the log-only policy-bot template. All of it is public,
stdlib-only code, so repo-placement requires the mirror to live in this
public repo: ``risk_lanes.py`` at the root (canonical classifier +
ledger) and the promotable org drop under
``templates/org-github/risk-lanes/``. The Builder implements that
mirror on this branch WITHOUT touching test files; these tests fail
until the mirror lands, then pass.

THE RISKS THIS EXISTS FOR (the eight Paperclip Review findings on the
first reviewed head of #938, scored 3/5):

1. Classifier bypass: the docs/tests-only shortcut returned LOW before
   the sensitive-token check, so privileged paths named like tests or
   prose (.github/workflows/*_test.yml, ops/secrets/*_test.sh,
   requirements.txt, infra/.../allow.txt, CLAUDE.md) rode the narrow
   LOW lane that activates first.
2. merge_group runs always classified HIGH (empty changeset): the
   reusable read only pull_request SHAs.
3. The ruleset draft used the invalid rule type ``required_workflows``
   and put the pinned commit in ``ref`` instead of ``sha``.
4. The risk-lanes suite ran only in a local tier, never in CI (pinned
   for this repo by test_risk_lanes_placement.sh).
5. The embedded classifier matched git display strings, not paths
   (rename display, C-quoted non-ASCII names, binary files counted as
   0 lines) and crashed on a null config value, losing its outputs.
6. The embedded classifier was never executed by any test; removing
   tokens/globs from it left every test green.
7. The widen count could not see escapes recorded after the merge and
   double-counted re-logged PRs, inflating the N=50 auto-widen gate.
8. The policy-bot template did not implement the lane rule it claimed
   to mirror (no test globs, no size bound, no token guard).

RED (before the fix): ModuleNotFoundError / staged files absent --
the repo-placement risk reproduced. GREEN (after): all pass.

Stdlib only, offline. Scratch git repos are built in temp dirs for the
embedded-classifier execution tests; git must be on PATH.
"""

import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import risk_lanes as r

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.join(HERE, "templates", "org-github", "risk-lanes")
ADVISORY = os.path.join(STAGE, "risk-lane-advisory.yml")
WRAPPER = os.path.join(STAGE, "risk-lane-required.yml")
RULESET = os.path.join(STAGE, "org-ruleset-risk-lane.json")
POLICY = os.path.join(STAGE, "policy-advisory.yml")


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class ConstantsTest(unittest.TestCase):
    def test_budgets_are_the_verbatim_rule(self):
        self.assertEqual(r.FULL_MAX_LINES, 400)
        self.assertEqual(r.NARROW_MAX_LINES, 50)
        self.assertEqual(r.WIDEN_CLEAN_LOW_REQUIRED, 50)

    def test_binary_file_counts_over_the_full_budget(self):
        # Finding 5: a blob is not line-reviewable; counting it as 0
        # lines made a multi-MB payload LOW/narrow.
        self.assertEqual(r.BINARY_FILE_LINES, r.FULL_MAX_LINES + 1)

    def test_backtest_is_not_activated(self):
        self.assertIn("NOT_ACTIVATED", r.BACKTEST_STATUS)


class ClassifierBypassTest(unittest.TestCase):
    """Finding 1: the token check runs BEFORE the docs/tests shortcut."""

    PRIVILEGED = [
        (".github/workflows/integration_test.yml", 900),
        ("ops/secrets/rotate_test.sh", 900),
        ("requirements.txt", 5000),
        ("infra/terraform/prod/allow.txt", 3000),
        ("CLAUDE.md", 900),
    ]

    def test_reviewers_five_privileged_paths_are_high(self):
        for path, lines in self.PRIVILEGED:
            with self.subTest(path=path):
                out = r.classify([path], lines, 0)
                self.assertEqual(out["lane"], "HIGH")
                self.assertFalse(r.is_narrow_low([path], lines, 0))

    def test_privileged_paths_are_high_even_when_tiny(self):
        # Size cannot launder a token either: the small-clean disjunct
        # requires clean, and narrow requires clean. (requirements.txt
        # carries no token; its fix is losing the docs-only/narrow-by-
        # docs ride, pinned below -- a tiny clean file is small-clean
        # LOW under the verbatim rule, like any other.)
        for path, _ in self.PRIVILEGED:
            if path == "requirements.txt":
                continue
            with self.subTest(path=path):
                self.assertEqual(r.classify([path], 5, 0)["lane"], "HIGH")
                self.assertFalse(r.is_narrow_low([path], 5, 0))

    def test_requirements_txt_loses_the_docs_only_ride(self):
        self.assertFalse(r.is_docs_tests_only(["requirements.txt"]))
        self.assertEqual(
            r.classify(["requirements.txt"], 5000, 0)["lane"], "HIGH")
        self.assertFalse(r.is_narrow_low(["requirements.txt"], 5000, 0))

    def test_agent_instruction_files_are_sensitive_anywhere(self):
        for path in ("AGENTS.md", "docs/CLAUDE.md", "sub/pkg/AGENTS.md"):
            with self.subTest(path=path):
                self.assertEqual(r.classify([path], 10, 0)["lane"], "HIGH")
                self.assertFalse(r.is_clean([path]))

    def test_token_in_a_markdown_path_outside_docs_is_high(self):
        # *.md matches a prose glob, but only docs/ prose, README kin
        # and issue templates are exempt from the token scan.
        self.assertEqual(r.classify(["src/auth.md"], 10, 0)["lane"], "HIGH")

    def test_test_file_carrying_a_token_is_not_clean(self):
        self.assertEqual(
            r.classify(["tests/test_auth.py"], 10, 0)["lane"], "HIGH")

    def test_txt_outside_docs_is_not_docs_only(self):
        self.assertFalse(r.is_docs_tests_only(["requirements.txt"]))
        self.assertTrue(r.is_docs_tests_only(["docs/notes.txt"]))

    def test_one_tainted_file_poisons_a_docs_tests_pr(self):
        files = ["docs/guide.md", "tests/test_ok.py",
                 ".github/workflows/integration_test.yml"]
        self.assertEqual(r.classify(files, 30, 0)["lane"], "HIGH")
        self.assertFalse(r.is_narrow_low(files, 30, 0))


class ClassifierRuleTest(unittest.TestCase):
    """The verbatim rule, positive side: LOW stays reachable."""

    def test_docs_and_tests_only_is_low_at_any_size(self):
        files = ["docs/guide.md", "tests/test_widget.py", "README.md"]
        self.assertEqual(r.classify(files, 5000, 0)["lane"], "LOW")
        self.assertTrue(r.is_narrow_low(files, 5000, 0))

    def test_prose_under_docs_about_sensitive_topics_stays_low(self):
        # The prose exemption: documenting auth is not changing auth.
        files = ["docs/auth-overview.md", "docs/deploy/runbook.rst"]
        self.assertEqual(r.classify(files, 900, 0)["lane"], "LOW")
        self.assertTrue(r.is_clean(files))

    def test_small_clean_code_is_low_and_boundary_is_400(self):
        self.assertEqual(r.classify(["src/widget.py"], 400, 0)["lane"], "LOW")
        self.assertEqual(r.classify(["src/widget.py"], 401, 0)["lane"], "HIGH")

    def test_narrow_boundary_is_50_for_code(self):
        self.assertTrue(r.is_narrow_low(["src/widget.py"], 50, 0))
        self.assertFalse(r.is_narrow_low(["src/widget.py"], 51, 0))

    def test_empty_changeset_is_high_never_narrow(self):
        self.assertEqual(r.classify([], 0, 0)["lane"], "HIGH")
        self.assertFalse(r.is_narrow_low([], 0, 0))
        self.assertFalse(r.is_docs_tests_only([]))

    def test_sensitive_tokens_are_high(self):
        for path in ("db/migrations/0001_init.sql", "src/billing/charge.py",
                     "Dockerfile", ".github/workflows/ci.yml"):
            with self.subTest(path=path):
                self.assertEqual(r.classify([path], 10, 0)["lane"], "HIGH")

    def test_classify_is_deterministic_with_sorted_reasons(self):
        files = ["src/auth/session.py", "src/widget.py"]
        first = r.classify(files, 900, 0)
        second = r.classify(files, 900, 0)
        self.assertEqual(first, second)
        # The lane itself does not depend on caller file order.
        self.assertEqual(
            r.classify(list(reversed(files)), 900, 0)["lane"], "HIGH")
        self.assertEqual(first["reasons"], sorted(set(first["reasons"])))
        self.assertTrue(first["reasons"])

    def test_cli_is_advisory_and_exits_zero_on_high(self):
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = r.main(["--files", "src/auth/session.py",
                         "--additions", "10"])
        self.assertEqual(rc, 0)
        self.assertIn("lane=HIGH", buf.getvalue())
        self.assertIn("narrow=no", buf.getvalue())


class LedgerFoldTest(unittest.TestCase):
    """Finding 7: fold by (repo, pr); escapes unwind; dupes count once."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.ledger = os.path.join(self.tmp, "lanes.jsonl")

    def log(self, **row):
        r.log_lane(row, self.ledger)

    def test_log_lane_rejects_bad_lane(self):
        with self.assertRaises(ValueError):
            self.log(pr=1, lane="MEDIUM")

    def test_escape_recorded_after_merge_unwinds_clean_count(self):
        self.log(repo="o/x", pr=1, lane="LOW")
        self.assertEqual(r.count_clean_low_merges(self.ledger), 1)
        self.log(repo="o/x", pr=1, lane="LOW", escaped=True)
        self.assertEqual(r.count_clean_low_merges(self.ledger), 0)

    def test_duplicate_rows_for_one_pr_count_once(self):
        for _ in range(50):
            self.log(repo="o/x", pr=7, lane="LOW")
        self.assertEqual(r.count_clean_low_merges(self.ledger), 1)
        self.assertFalse(r.narrow_widen_ready(self.ledger))

    def test_same_pr_number_in_different_repos_counts_separately(self):
        self.log(repo="o/a", pr=7, lane="LOW")
        self.log(repo="o/b", pr=7, lane="LOW")
        self.assertEqual(r.count_clean_low_merges(self.ledger), 2)

    def test_fifty_distinct_clean_lows_widen(self):
        for pr in range(1, 51):
            self.log(repo="o/x", pr=pr, lane="LOW")
        self.assertEqual(r.count_clean_low_merges(self.ledger), 50)
        self.assertTrue(r.narrow_widen_ready(self.ledger))

    def test_last_lane_wins_and_missing_ledger_is_zero(self):
        self.log(repo="o/x", pr=3, lane="LOW")
        self.log(repo="o/x", pr=3, lane="HIGH")
        self.assertEqual(r.count_clean_low_merges(self.ledger), 0)
        missing = os.path.join(self.tmp, "nope.jsonl")
        self.assertEqual(r.count_clean_low_merges(missing), 0)


class TripwireTest(unittest.TestCase):
    MERGED = "2026-10-15T00:00:00Z"

    def test_revert_and_incident_trip(self):
        self.assertTrue(r.is_tripwire_escape(
            self.MERGED, ["a.py"], [{"type": "revert"}]))
        self.assertTrue(r.is_tripwire_escape(
            self.MERGED, ["a.py"], [{"type": "incident"}]))

    def test_same_files_fix_within_7d_trips(self):
        ev = [{"type": "fix_followup", "merged_at": "2026-10-20T00:00:00Z",
               "files": ["a.py", "b.py"]}]
        self.assertTrue(r.is_tripwire_escape(self.MERGED, ["a.py"], ev))

    def test_different_files_or_missing_files_do_not_trip(self):
        other = [{"type": "fix_followup", "merged_at": "2026-10-20T00:00:00Z",
                  "files": ["zzz.py"]}]
        missing = [{"type": "fix_followup",
                    "merged_at": "2026-10-20T00:00:00Z"}]
        self.assertFalse(r.is_tripwire_escape(self.MERGED, ["a.py"], other))
        self.assertFalse(r.is_tripwire_escape(self.MERGED, ["a.py"], missing))

    def test_late_fix_does_not_trip(self):
        ev = [{"type": "fix_followup", "merged_at": "2026-11-01T00:00:00Z",
               "files": ["a.py"]}]
        self.assertFalse(r.is_tripwire_escape(self.MERGED, ["a.py"], ev))


class StagedArtifactsTest(unittest.TestCase):
    """Findings 2, 3 and 8: the promotable org drop says what it does."""

    def test_reusable_falls_back_to_merge_group_shas(self):
        body = read(ADVISORY)
        self.assertIn("github.event.merge_group.base_sha", body)
        self.assertIn("github.event.merge_group.head_sha", body)

    def test_reusable_is_workflow_call_and_advisory(self):
        body = read(ADVISORY)
        self.assertIn("workflow_call:", body)
        self.assertIn("timeout-minutes: 5", body)
        # HIGH is a lane, not a failure: the only loud failure is a
        # missing diff range (finding 2's silent-HIGH pollution).
        self.assertIn("missing base/head", body)

    def test_wrapper_triggers_and_bare_check_name(self):
        body = read(WRAPPER)
        self.assertIn("pull_request:", body)
        self.assertIn("merge_group:", body)
        self.assertIn("name: risk-lane", body)

    def test_ruleset_uses_valid_workflows_rule_with_sha_pin(self):
        data = json.loads(read(RULESET))
        self.assertEqual(data["enforcement"], "evaluate")
        types = [rule.get("type") for rule in data["rules"]]
        self.assertIn("workflows", types)
        self.assertNotIn("required_workflows", types)
        wf = data["rules"][types.index("workflows")]
        entry = wf["parameters"]["workflows"][0]
        self.assertIn("REPLACE-ME", entry["sha"])
        self.assertNotIn("REPLACE-ME", entry["ref"])

    def test_policy_template_implements_both_low_disjuncts(self):
        body = read(POLICY)
        self.assertIn("low-risk-docs-tests-only", body)
        self.assertIn("low-risk-small-clean", body)
        self.assertIn("high-risk-core-approval", body)
        # "< 401" is policy-bot's spelling of <= 400.
        self.assertIn('"< 401"', body)
        # Token guard on BOTH low rules, not just the docs/tests one.
        self.assertGreaterEqual(body.count("no_changed_files"), 2)
        self.assertIn(r"claude\\.md", body)

    def test_policy_template_does_not_treat_any_txt_as_prose(self):
        body = read(POLICY)
        # Every .txt prose pattern is docs/-anchored (finding 1/8).
        for token in re.findall(r'"[^"\n]*\.txt[^"\n]*"', body):
            self.assertIn("docs/", token, token)


def embedded_script():
    body = read(ADVISORY)
    match = re.search(r"<<'PYEOF'\n(.*?)\n\s*PYEOF", body, re.S)
    if not match:
        match = re.search(r'python3 - <<\'PYEOF\'[^\n]*\n(.*?)\n\s*PYEOF',
                          body, re.S)
    assert match, "embedded PYEOF classifier not found in advisory workflow"
    lines = match.group(1).splitlines()
    indent = min(len(l) - len(l.lstrip()) for l in lines if l.strip())
    return "\n".join(l[indent:] for l in lines) + "\n"


def tuple_assignments(source):
    found = {}
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and isinstance(node.value, ast.Tuple):
                found[target.id] = tuple(
                    elt.value for elt in node.value.elts
                    if isinstance(elt, ast.Constant))
    return found


class EmbeddedParityTest(unittest.TestCase):
    """Findings 5 and 6: the embedded classifier is executed, for real."""

    def test_embedded_tuples_equal_canonical_element_by_element(self):
        found = tuple_assignments(embedded_script())
        self.assertEqual(found["docs_test_globs"], tuple(r.DOCS_TEST_GLOBS))
        self.assertEqual(found["sensitive_tokens"],
                         tuple(r.SENSITIVE_TOKENS))

    def setUp(self):
        if not shutil.which("git"):
            self.skipTest("git required for embedded execution tests")
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.script = os.path.join(self.tmp, "embedded.py")
        with open(self.script, "w", encoding="utf-8") as fh:
            fh.write(embedded_script())
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        self.git("init", "-q")
        self.git("config", "user.email", "t@example.invalid")
        self.git("config", "user.name", "t")
        self.write("seed.txt", "seed\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "seed")
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo,
                              capture_output=True, text=True, check=True).stdout

    def write(self, relpath, content, binary=False):
        path = os.path.join(self.repo, relpath)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = "wb" if binary else "w"
        with open(path, mode) as fh:
            fh.write(content)

    def classify_head(self, extra_env=None):
        self.git("add", "-A")
        self.git("commit", "-qm", "change")
        head = self.git("rev-parse", "HEAD").strip()
        out_file = os.path.join(self.tmp, "ghout.txt")
        env = dict(os.environ, BASE_SHA=self.base, HEAD_SHA=head,
                   GITHUB_OUTPUT=out_file)
        if extra_env:
            env.update(extra_env)
        proc = subprocess.run([sys.executable, self.script], cwd=self.repo,
                              env=env, capture_output=True, text=True)
        outputs = read(out_file) if os.path.exists(out_file) else ""
        return proc, outputs

    def test_nonascii_docs_path_is_low(self):
        self.write("docs/café.md", "# café\n" * 600)
        proc, outputs = self.classify_head()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("lane=LOW", outputs)

    def test_rename_out_of_tests_is_not_docs_tests_only(self):
        os.makedirs(os.path.join(self.repo, "tests"))
        self.write("tests/uniq.py", "x = 1\n" * 500)
        self.git("add", "-A")
        self.git("commit", "-qm", "add test file")
        self.base = self.git("rev-parse", "HEAD").strip()
        os.makedirs(os.path.join(self.repo, "src"))
        self.git("mv", "tests/uniq.py", "src/uniq_prod.py")
        proc, outputs = self.classify_head()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("lane=HIGH", outputs)

    def test_binary_blob_is_high(self):
        self.write("payload.bin", b"\x00\x01" * 4096, binary=True)
        proc, outputs = self.classify_head()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("lane=HIGH", outputs)
        self.assertIn("narrow=no", outputs)

    def test_privileged_workflow_test_file_is_high(self):
        self.write(".github/workflows/integration_test.yml",
                   "name: x\n" * 900)
        proc, outputs = self.classify_head()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("lane=HIGH", outputs)

    def test_small_clean_code_is_low_narrow(self):
        self.write("src/widget.py", "x = 1\n" * 10)
        proc, outputs = self.classify_head()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("lane=LOW", outputs)
        self.assertIn("narrow=yes", outputs)

    def test_null_config_value_still_writes_outputs(self):
        self.write(".github/risk-lane.json", '{"full_max_lines": null}\n')
        self.write("src/widget.py", "x = 1\n" * 10)
        proc, outputs = self.classify_head()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("lane=", outputs)
        self.assertIn("narrow=", outputs)

    def test_missing_shas_fail_visibly_and_still_write_outputs(self):
        out_file = os.path.join(self.tmp, "ghout2.txt")
        env = dict(os.environ, BASE_SHA="", HEAD_SHA="",
                   GITHUB_OUTPUT=out_file)
        proc = subprocess.run([sys.executable, self.script], cwd=self.repo,
                              env=env, capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("lane=", read(out_file))


if __name__ == "__main__":
    unittest.main()
