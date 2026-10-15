#!/usr/bin/env python3
"""Behavioral acceptance tests for Land #881 (paperclip-ops-tooling): the
deterministic quality-gates job is WARN-first with HARD rules that fire as
specified.

Subject: a checkout of TogetherWeOwn/paperclip-ops-tooling at the PR head
under test, pointed to by OPS_TOOLING_SUBJECT. Without it every test skips
(exit 0): repo CI never has a subject, so the suite refuses to score itself
there instead of failing. With a subject it is hermetic: stdlib only, no
network, no credentials. Behavioral probes run the subject's own gate
scripts (gate 5 bash, gate 8 python) against tiny synthetic git repos in
tmp; WARN/HARD wiring and the tool-shape findings are pinned structurally
on the subject tree, mirroring the reviewer's stated fixes.

Landing criteria pinned here (CONSTRAINTS.md as the contract):

- WARN-first: gates 1, 2, 3a, 3b, 4a, 4b, 4c, 6, 7 report via
  continue-on-error and own no required check; HARD gates 3c, 5 (and 8)
  carry no continue-on-error, so a hit fails the step.
- HARD rule 1 (gate 3c): zizmor fails the job on high-severity findings,
  offline, pinned.
- HARD rule 2 (gate 5): no_pull_request_target.sh refuses the trigger in
  every YAML spelling -- including the quoted-key and next-line flow-list
  forms that slip the head revision -- and the ban cannot be suppressed
  away (a zizmor-ignore silencer trips gate 8 in the same change).
- WARN signal is real (findings 2, 4, 5): mutmut installs the patch extra
  and scopes mutants to the change; the semgrep timeout rule filters with
  patterns/pattern-not; ast-grep scans include hidden dirs.
- The job does not smuggle supply-chain risk (late-novel finding 6):
  no persisted checkout credential, no redundant base fetch, downloads
  verified.

RED at head e6ce5a1: the bypass, assertion and WARN-signal probes fail and
the hygiene probes fail; the wiring and regression probes pass, proving the
harness itself runs the gates. GREEN after the Land fix resolves the review
threads: every probe passes. The PR's own unit suites (test_floor_guard.py,
test_no_pull_request_target.py, test_quality_gates.py) cover unit level;
this suite is black-box acceptance and never touches their files.

Run: OPS_TOOLING_SUBJECT=/path/to/paperclip-ops-tooling \
     python3 -m unittest test_quality_gates_881_acceptance -v
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SUBJECT = Path(os.environ["OPS_TOOLING_SUBJECT"]) if os.environ.get("OPS_TOOLING_SUBJECT") else None

WORKFLOW = Path(".github/workflows/quality-gates.yml")
GATE5 = Path("scripts/quality-gates/no_pull_request_target.sh")
GUARD = Path("scripts/quality-gates/floor_guard.py")
IGNORE = Path(".constraintsignore")
SEMGREP = Path(".semgrep/quality-gates.yml")
SUBPROC_GATE = Path("scripts/quality-gates/subprocess_timeout_gate.py")
MUTMUT_SH = Path("scripts/quality-gates/mutmut_changed.sh")

WARN_GATES = [
    "Gate 1 (WARN)",
    "Gate 2 (WARN)",
    "Gate 3a (WARN)",
    "Gate 3b (WARN)",
    "Gate 4a (WARN)",
    "Gate 4b (WARN)",
    "Gate 4c (WARN)",
    "Gate 6 (WARN)",
    "Gate 7 (WARN)",
]
HARD_GATES = [
    "Gate 3c (HARD)",
    "Gate 5 (HARD)",
    "Gate 8 (HARD)",
]

# The reviewer's exact bypass probe: quoted trigger key plus an audit
# silencer on the same line. Valid YAML, valid workflow, banned trigger.
BYPASS_WORKFLOW = """\
name: probe
"on": [push, pull_request_target] # zizmor: ignore[dangerous-triggers]
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - run: echo probe
"""

BENIGN_WORKFLOW = """\
name: probe
on: [push, pull_request]
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - run: echo probe
"""


def git(repo, *args):
    return subprocess.run(
        ["git", "-c", "init.defaultBranch=main",
         "-c", "user.email=acceptance@example.com",
         "-c", "user.name=acceptance", *args],
        cwd=repo, capture_output=True, text=True, timeout=120,
    )


def split_steps(workflow_text):
    """Split a workflow into (name, body) steps on `- name:` / `- uses:`."""
    steps = []
    current = None
    for line in workflow_text.splitlines():
        head = re.match(r"^      - (name|uses):\s*(.*)$", line)
        if head:
            current = [head.group(2).strip().strip('"'), []]
            steps.append(current)
        elif current is not None:
            current[1].append(line)
    return [(name, "\n".join(body)) for name, body in steps]


def step_allows_failure(body):
    return bool(re.search(r"(?m)^\s*continue-on-error:\s*true\s*$", body))


class SubjectTreeCase(unittest.TestCase):
    """Every test needs the subject tree; without it, skip, never fail."""

    def setUp(self):
        if SUBJECT is None:
            self.skipTest("OPS_TOOLING_SUBJECT is unset -- no subject to score")
        self.subject = SUBJECT
        for rel in (WORKFLOW, GATE5, GUARD):
            self.assertTrue(
                (self.subject / rel).is_file(),
                f"subject is not the Land #881 tree: missing {rel}",
            )
        self.workflow_text = (self.subject / WORKFLOW).read_text()
        self.steps = split_steps(self.workflow_text)

    def step_body(self, prefix):
        for name, body in self.steps:
            if name.startswith(prefix):
                return body
        self.fail(f"workflow has no step starting with {prefix!r}")


class WarnFirstWiringTest(SubjectTreeCase):
    """WARN-first: WARN reports, HARD fails, the job owns no required check."""

    def test_every_warn_step_continues_on_error(self):
        for gate in WARN_GATES:
            with self.subTest(gate=gate):
                self.assertTrue(
                    step_allows_failure(self.step_body(gate)),
                    f"{gate} must carry continue-on-error: true (report, not fail)",
                )

    def test_no_hard_step_continues_on_error(self):
        for gate in HARD_GATES:
            with self.subTest(gate=gate):
                self.assertFalse(
                    step_allows_failure(self.step_body(gate)),
                    f"{gate} must fail the step on a hit: no continue-on-error",
                )

    def test_job_owns_no_required_check(self):
        self.assertIn(
            "ci-policy: non-required", self.workflow_text,
            "the job must declare the non-required marker: WARN noise "
            "and HARD red signal without blocking merge",
        )


class ZizmorHighGateTest(SubjectTreeCase):
    """HARD rule 1 (gate 3c): zizmor fails the job on high-severity findings."""

    def test_high_gate_runs_pinned_offline_scan(self):
        body = self.step_body("Gate 3c (HARD)")
        self.assertIn("--min-severity high", body)
        self.assertIn("--no-online-audits", body)
        self.assertIn(".github/workflows/", body)


class Gate5HarnessMixin:
    """Run the subject's gate 5 script against a synthetic tracked tree."""

    def run_gate5(self, workflow_text, tracked=True):
        repo = Path(tempfile.mkdtemp(prefix="qg881-g5-"))
        self.addCleanup(shutil.rmtree, repo, True)
        script_dir = repo / "scripts" / "quality-gates"
        script_dir.mkdir(parents=True)
        shutil.copy(self.subject / GATE5, script_dir / GATE5.name)
        wf_dir = repo / ".github" / "workflows"
        wf_dir.mkdir(parents=True)
        (wf_dir / "probe.yml").write_text(workflow_text)
        self.assertEqual(git(repo, "init", "-q").returncode, 0)
        if tracked:
            git(repo, "add", "-A")
        else:
            git(repo, "add", str(script_dir / GATE5.name))
        self.assertEqual(git(repo, "commit", "-qm", "base").returncode, 0)
        proc = subprocess.run(
            ["bash", str(script_dir / GATE5.name)],
            capture_output=True, text=True, timeout=120,
        )
        return proc.returncode


class PullRequestTargetBanTest(SubjectTreeCase, Gate5HarnessMixin):
    """HARD rule 2 (gate 5): the ban fires in every YAML spelling."""

    def test_quoted_on_key_fails(self):
        rc = self.run_gate5(BYPASS_WORKFLOW.split("# zizmor")[0])
        self.assertNotEqual(rc, 0, '"on": [push, pull_request_target] must fail gate 5')

    def test_next_line_flow_list_fails(self):
        rc = self.run_gate5(BENIGN_WORKFLOW.replace(
            "on: [push, pull_request]", "on:\n  [push, pull_request_target]"))
        self.assertNotEqual(rc, 0, "flow list on the line after on: must fail gate 5")

    def test_inline_unquoted_still_fails(self):
        rc = self.run_gate5(BENIGN_WORKFLOW.replace(
            "on: [push, pull_request]", "on: [push, pull_request_target]"))
        self.assertNotEqual(rc, 0)

    def test_mapping_key_still_fails(self):
        rc = self.run_gate5(BENIGN_WORKFLOW.replace(
            "on: [push, pull_request]",
            "on:\n  pull_request_target:\n    branches: [main]"))
        self.assertNotEqual(rc, 0)

    def test_comment_mention_passes(self):
        rc = self.run_gate5(BENIGN_WORKFLOW.replace(
            "name: probe", "name: probe\n# pull_request_target is banned here"))
        self.assertEqual(rc, 0, "a comment that merely names the token must pass")

    def test_step_name_mention_passes(self):
        rc = self.run_gate5(BENIGN_WORKFLOW.replace(
            "- run: echo probe", "- run: echo probe\n      name: check pull_request_target handling"))
        self.assertEqual(rc, 0, "a step name that merely names the token must pass")

    def test_untracked_probe_is_out_of_scope(self):
        rc = self.run_gate5(
            BENIGN_WORKFLOW.replace("on: [push, pull_request]",
                                    "on: [push, pull_request_target]"),
            tracked=False)
        self.assertEqual(rc, 0, "gate 5 scans tracked workflows only (git ls-files)")

    def test_reviewer_bypass_probe_fails(self):
        rc = self.run_gate5(BYPASS_WORKFLOW)
        self.assertNotEqual(
            rc, 0,
            "quoted trigger key plus zizmor-ignore silencer must still fail gate 5",
        )


class FloorHarnessMixin:
    """Run the subject's floor guard against a synthetic two-state tree."""

    def run_guard(self, base_files, mutate):
        repo = Path(tempfile.mkdtemp(prefix="qg881-g8-"))
        self.addCleanup(shutil.rmtree, repo, True)
        script_dir = repo / "scripts" / "quality-gates"
        script_dir.mkdir(parents=True)
        shutil.copy(self.subject / GUARD, script_dir / GUARD.name)
        shutil.copy(self.subject / IGNORE, repo / IGNORE.name)
        for rel, text in base_files.items():
            path = repo / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.assertEqual(git(repo, "init", "-q").returncode, 0)
        git(repo, "add", "-A")
        self.assertEqual(git(repo, "commit", "-qm", "base").returncode, 0)
        mutate(repo)
        proc = subprocess.run(
            [sys.executable, str(script_dir / GUARD.name), "--base", "HEAD"],
            cwd=repo, capture_output=True, text=True, timeout=120,
        )
        return proc


TEST_PROBE_BASE = """\
import unittest


class ProbeTest(unittest.TestCase):
    def test_answer(self):
        self.assertEqual(compute(), 42)
        self.assertIn("ok", describe())
        assert compute() != 0
"""


class FloorGuardSuppressionTest(SubjectTreeCase, FloorHarnessMixin):
    """Gate 8: audit silencers and stripped assertions fail; clean edits pass."""

    def test_zizmor_ignore_suppression_fails(self):
        def mutate(repo):
            path = repo / ".github" / "workflows" / "probe.yml"
            path.write_text(BENIGN_WORKFLOW.replace(
                "on: [push, pull_request]",
                "on: [push, pull_request] # zizmor: ignore[dangerous-triggers]"))

        proc = self.run_guard(
            {".github/workflows/probe.yml": BENIGN_WORKFLOW}, mutate)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("silenced-checker", proc.stderr)

    def test_reviewer_bypass_probe_trips_floor(self):
        def mutate(repo):
            path = repo / ".github" / "workflows" / "probe.yml"
            path.write_text(BYPASS_WORKFLOW)

        proc = self.run_guard(
            {".github/workflows/probe.yml": BENIGN_WORKFLOW}, mutate)
        self.assertEqual(
            proc.returncode, 1,
            "the bypass change must trip gate 8 via its audit silencer",
        )

    def test_self_assert_removal_fails(self):
        def mutate(repo):
            path = repo / "test_probe.py"
            path.write_text("".join(
                line for line in path.read_text().splitlines(keepends=True)
                if "assertEqual" not in line))

        proc = self.run_guard({"test_probe.py": TEST_PROBE_BASE}, mutate)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("assertion-removed", proc.stderr)

    def test_bare_assert_removal_still_fails(self):
        def mutate(repo):
            path = repo / "test_probe.py"
            path.write_text("".join(
                line for line in path.read_text().splitlines(keepends=True)
                if "assert compute" not in line))

        proc = self.run_guard({"test_probe.py": TEST_PROBE_BASE}, mutate)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("assertion-removed", proc.stderr)

    def test_message_only_edit_passes(self):
        base = TEST_PROBE_BASE.replace(
            'self.assertIn("ok", describe())',
            'self.assertIn(value, "should FAIL")')

        def mutate(repo):
            path = repo / "test_probe.py"
            path.write_text(path.read_text().replace("should FAIL", "must FAIL"))

        proc = self.run_guard({"test_probe.py": base}, mutate)
        self.assertEqual(
            proc.returncode, 0,
            "an edit that keeps the assertion (message wording only) must pass",
        )

    def test_clean_tree_passes(self):
        proc = self.run_guard(
            {".github/workflows/probe.yml": BENIGN_WORKFLOW,
             "test_probe.py": TEST_PROBE_BASE},
            lambda repo: None)
        self.assertEqual(proc.returncode, 0)


class WarnSignalTest(SubjectTreeCase):
    """WARN gates must emit real signal (findings 2, 4, 5 fixes)."""

    def test_mutmut_installs_patch_extra(self):
        self.assertIn(
            "mutmut[patch]==", self.workflow_text,
            "--use-patch-file needs whatthepatch, which only ships in the patch extra",
        )

    def test_mutmut_scopes_mutants_and_reads_results(self):
        script = (self.subject / MUTMUT_SH).read_text()
        self.assertIn("--paths-to-mutate", script,
                      "without paths-to-mutate mutmut guesses lib/ and checks 0 mutants")
        self.assertIn("mutmut results", script,
                      "survivors come from `mutmut results`, not a log grep that only hits the legend")

    def test_semgrep_filters_with_patterns(self):
        rules = (self.subject / SEMGREP).read_text()
        self.assertIsNotNone(
            re.search(r"(?m)^\s*-\s*pattern-not:", rules),
            "a top-level pattern-not-regex next to pattern-either filters "
            "nothing; the timeout exclusion belongs in patterns/ as pattern-not",
        )

    def test_ast_grep_scans_include_hidden_dirs(self):
        gate4c = self.step_body("Gate 4c (WARN)")
        self.assertIn("--no-ignore hidden", gate4c,
                      "ast-grep skips .github/ by default, so the gha-* rules never run")
        gate = (self.subject / SUBPROC_GATE).read_text()
        self.assertIn("--no-ignore hidden", gate,
                      "the gate 4b scan misses .github/scripts without the flag")


class WorkflowHygieneTest(SubjectTreeCase):
    """The gates job must not smuggle supply-chain risk (late-novel finding)."""

    def test_checkout_drops_credential(self):
        self.assertIn(
            "persist-credentials: false", self.workflow_text,
            "a persisted checkout token plus unverified downloads hands the "
            "HARD-gate binaries a write-capable credential",
        )

    def test_no_redundant_base_fetch(self):
        fetch = 'git fetch --no-tags --depth=50 origin "$base"'
        self.assertNotIn(fetch, self.workflow_text,
                         "fetch-depth 0 already holds the base; the fetch adds nothing")
        self.assertNotIn(fetch, (self.subject / MUTMUT_SH).read_text())

    def test_downloads_verified(self):
        self.assertIn(
            "sha256sum", self.workflow_text,
            "release binaries pulled by mutable tag and the pip bootstrap "
            "must be digest-pinned and verified before they execute",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
