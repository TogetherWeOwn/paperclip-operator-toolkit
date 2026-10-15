#!/usr/bin/env python3
"""Round-13 regression tests for the three 4/5 warnings on head `a7c4ec5`.

Pins the exact reviewer probes so the fixes cannot regress. Frozen
suites and round-2..12 + review-acceptance files stay untouched
(except the org-template ruleset retarget, which the reviewer demanded
because the pinned `required_workflows` type is rejected by the GitHub
org-ruleset API).

- Ruleset payloads use the real `workflows` rule type with
  `conditions.repository_name`, integer `repository_id` placeholder,
  `ref: refs/heads/main` and `sha: PINNED_SHA`.
- Gates encode workflow-command data (`%`->`%25`, CR->`%0D`,
  LF->`%0A`) so a PR-controlled newline in a path cannot forge a
  second `::cmd::` line.
- Fail-closed / fsdecode coverage is behavioural: invalid-UTF-8 names
  must round-trip to `open()` (CONCURRENTLY finding), a dangling
  symlink must report `unreadable (fail-closed)`, and a tool-only
  `pyproject.toml` in an invalid-UTF-8 dir must stay exempt.
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGE = HERE / "templates" / "org-github" / "blocker-classes47"
RULESETS = HERE / "templates" / "org-github" / "rulesets"
CI = HERE / ".github" / "workflows" / "ci.yml"


def isolated_env():
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR", str(HERE)),
        "LANG": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def extract_heredoc(gate_name):
    text = (STAGE / gate_name).read_text()
    match = re.search(r"<<'PY'[^\n]*\n(.*?)\n[ \t]*PY(?:\n|$)", text, re.S)
    assert match, "%s Python heredoc must be extractable" % gate_name
    return textwrap.dedent(match.group(1))


def no_forged_command_lines(output):
    """Every stdout line starting with `::` must be an intended warning.

    The gates only ever print `::warning::` command lines; a second
    line starting with `::error::`, `::notice::` or `::stop-commands::`
    proves a PR-controlled newline was echoed raw.
    """
    bad = [
        ln
        for ln in output.splitlines()
        if ln.startswith("::") and not ln.startswith("::warning::")
    ]
    return bad


class RulesetWorkflowsShapeTest(unittest.TestCase):
    def load_both(self):
        stage1 = json.loads(
            (RULESETS / "blocker-classes47-report-only.json").read_text()
        )
        stage2 = json.loads(
            (RULESETS / "blocker-classes47-required.json").read_text()
        )
        return stage1, stage2

    def test_both_payloads_use_workflows_type(self):
        for name in (
            "blocker-classes47-report-only.json",
            "blocker-classes47-required.json",
        ):
            payload = json.loads((RULESETS / name).read_text())
            types = [r.get("type") for r in payload.get("rules", [])]
            self.assertIn("workflows", types, name)
            self.assertNotIn("required_workflows", types, name)

    def test_conditions_carry_repository_name(self):
        for name in (
            "blocker-classes47-report-only.json",
            "blocker-classes47-required.json",
        ):
            payload = json.loads((RULESETS / name).read_text())
            cond = payload.get("conditions", {})
            self.assertIn("repository_name", cond, name)
            self.assertEqual(
                cond["repository_name"].get("include"), ["*"], name
            )

    def test_workflow_entries_pin_sha_with_branch_ref(self):
        for name in (
            "blocker-classes47-report-only.json",
            "blocker-classes47-required.json",
        ):
            payload = json.loads((RULESETS / name).read_text())
            wfs = [
                w
                for r in payload.get("rules", [])
                if r.get("type") == "workflows"
                for w in r.get("parameters", {}).get("workflows", [])
            ]
            self.assertEqual(len(wfs), 4, name)
            for w in wfs:
                self.assertIsInstance(w.get("repository_id"), int, name)
                self.assertEqual(w.get("ref"), "refs/heads/main", name)
                self.assertEqual(w.get("sha"), "PINNED_SHA", name)

    def test_gates_encode_workflow_command_data(self):
        for gate in (
            "migration-gate.yml",
            "lockfile-gate.yml",
            "concurrency-gate.yml",
        ):
            text = (STAGE / gate).read_text()
            self.assertIn("_encode_workflow_command_data", text, gate)


class ScratchRepoMixin:
    def setUp(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
        self.temp = tempfile.TemporaryDirectory(
            prefix="blocker-round13-", dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.env = isolated_env()
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Acceptance fixture")

    def git(self, *args):
        return subprocess.run(
            ["/usr/bin/git", *args], cwd=self.repo, env=self.env,
            capture_output=True, text=True, check=True, timeout=20,
        ).stdout.strip()

    def git_raw(self, *args):
        return subprocess.run(
            ["/usr/bin/git", *args], cwd=self.repo, env=self.env,
            capture_output=True, timeout=20,
        )

    def commit_files(self, files):
        for name, data in files.items():
            p = self.repo / name
            p.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(data, (bytes, bytearray)):
                p.write_bytes(bytes(data))
            else:
                p.write_text(data)
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def commit_raw_path(self, raw_dir_bytes, raw_name_bytes, data):
        raw_dir = os.path.join(os.fsencode(str(self.repo)), raw_dir_bytes)
        os.makedirs(raw_dir, exist_ok=True)
        raw_path = os.path.join(raw_dir, raw_name_bytes)
        fd = os.open(raw_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def run_migration_gate(self, base_files, changes):
        base = self.commit_files({"README.md": "fixture\n", **base_files})
        self.commit_files(changes)
        raw = self.git_raw(
            "-c", "core.quotepath=off",
            "diff", "-z", "--name-only", "--no-renames",
            "--diff-filter=d", base, "HEAD", "--",
        ).stdout
        changed = self.repo / "changed.txt"
        changed.write_bytes(raw if raw else b"")
        env = dict(
            self.env, GATE_CHANGED=str(changed), GATE_BASE=base,
            GATE_DIALECT="postgres", GATE_LOGIC=str(HERE),
            GATE_MODE="enforce",
        )
        return subprocess.run(
            [sys.executable, "-I", "-"],
            input=extract_heredoc("migration-gate.yml"),
            cwd=self.repo, env=env, capture_output=True, text=True,
            timeout=30,
        )

    def run_lockfile_gate(self, base_files, changes):
        base = self.commit_files({"README.md": "fixture\n", **base_files})
        self.commit_files(changes)
        raw = self.git_raw(
            "-c", "core.quotepath=off",
            "diff", "-z", "--name-only", "--no-renames",
            "--diff-filter=d", base, "HEAD", "--",
        ).stdout
        changed = self.repo / "changed.txt"
        changed.write_bytes(raw if raw else b"")
        present_raw = self.git_raw(
            "-c", "core.quotepath=off", "ls-files", "-z",
        ).stdout
        present = self.repo / "present.txt"
        present.write_bytes(present_raw if present_raw else b"")
        env = dict(
            self.env, GATE_CHANGED=str(changed), GATE_PRESENT=str(present),
            GATE_LOGIC=str(HERE), GATE_MODE="enforce",
            GATE_IGNORE_MANIFESTS="", GATE_BASE=base,
        )
        return subprocess.run(
            [sys.executable, "-I", "-"],
            input=extract_heredoc("lockfile-gate.yml"),
            cwd=self.repo, env=env, capture_output=True, text=True,
            timeout=30,
        )

    def run_concurrency_gate(self, files):
        for name, data in files.items():
            p = self.repo / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(data)
        env = dict(
            self.env, GATE_LOGIC=str(HERE), GATE_MODE="enforce",
        )
        return subprocess.run(
            [sys.executable, "-I", "-"],
            input=extract_heredoc("concurrency-gate.yml"),
            cwd=self.repo, env=env, capture_output=True, text=True,
            timeout=30,
        )


MIGRATING_WORKFLOW = """\
name: x
on: push
jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - run: npm run migrate
"""


class NewlineInjectionGateTest(ScratchRepoMixin, unittest.TestCase):
    def test_migration_newline_name_cannot_forge_error(self):
        forged = "db/migrations/002_a\n::error::forged.sql"
        proc = self.run_migration_gate(
            {}, {forged: "CREATE INDEX i ON t (c);\n"},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertEqual(no_forged_command_lines(output), [], output)
        self.assertIn("%0A", output)

    def test_lockfile_newline_name_cannot_forge_error(self):
        forged = "a\n::error::forged-from-lockfile/yarn.lock"
        proc = self.run_lockfile_gate(
            {}, {forged: ""},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertEqual(no_forged_command_lines(output), [], output)
        self.assertIn("%0A", output)

    def test_concurrency_newline_name_cannot_forge_error(self):
        forged = ".github/workflows/a\n::error::forged.yml"
        proc = self.run_concurrency_gate(
            {forged: MIGRATING_WORKFLOW},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertEqual(no_forged_command_lines(output), [], output)
        self.assertIn("%0A", output)


class FailClosedBehaviourTest(ScratchRepoMixin, unittest.TestCase):
    def test_invalid_utf8_name_round_trips_to_open(self):
        # Behavioural proof the NUL+fsdecode path reaches open(): the
        # file holds CREATE INDEX without CONCURRENTLY, so only a
        # successful open produces the CONCURRENTLY finding. The
        # decode-replace mutant opens the wrong name, goes unreadable,
        # and never prints CONCURRENTLY.
        base = self.commit_files({"README.md": "fixture\n"})
        self.commit_raw_path(
            b"db/migrations", b"002_caf\xe9.sql",
            b"CREATE INDEX i ON t (c);\n",
        )
        raw = self.git_raw(
            "-c", "core.quotepath=off",
            "diff", "-z", "--name-only", "--no-renames",
            "--diff-filter=d", base, "HEAD", "--",
        ).stdout
        self.assertIn(b"\xe9", raw, "raw -z bytes must reach the gate")
        changed = self.repo / "changed.txt"
        changed.write_bytes(raw if raw else b"")
        env = dict(
            self.env, GATE_CHANGED=str(changed), GATE_BASE=base,
            GATE_DIALECT="postgres", GATE_LOGIC=str(HERE),
            GATE_MODE="enforce",
        )
        proc = subprocess.run(
            [sys.executable, "-I", "-"],
            input=extract_heredoc("migration-gate.yml").encode(),
            cwd=self.repo, env=env, capture_output=True, text=False,
            timeout=30,
        )
        output = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode(
            "utf-8", "replace")
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("CONCURRENTLY", output)
        self.assertNotIn("blocker-migration: clean", output)

    def test_dangling_symlink_migration_is_fail_closed(self):
        # A tracked dangling .sql symlink reaches the `unreadable`
        # branch on its own: deleting the append mutant turns this
        # gate clean, so this test kills that mutant behaviourally.
        base = self.commit_files({"README.md": "fixture\n"})
        target = self.repo / "db" / "migrations"
        target.mkdir(parents=True, exist_ok=True)
        link = target / "002_link.sql"
        os.symlink("nonexistent-target.sql", link)
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        raw = self.git_raw(
            "-c", "core.quotepath=off",
            "diff", "-z", "--name-only", "--no-renames",
            "--diff-filter=d", base, "HEAD", "--",
        ).stdout
        changed = self.repo / "changed.txt"
        changed.write_bytes(raw if raw else b"")
        env = dict(
            self.env, GATE_CHANGED=str(changed), GATE_BASE=base,
            GATE_DIALECT="postgres", GATE_LOGIC=str(HERE),
            GATE_MODE="enforce",
        )
        proc = subprocess.run(
            [sys.executable, "-I", "-"],
            input=extract_heredoc("migration-gate.yml").encode(),
            cwd=self.repo, env=env, capture_output=True, text=False,
            timeout=30,
        )
        output = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode(
            "utf-8", "replace")
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("unreadable (fail-closed)", output)

    def test_lockfile_invalid_utf8_dir_keeps_tool_only_exemption(self):
        # A tool-only pyproject.toml in an invalid-UTF-8 directory is
        # exempt only when the gate round-trips the name to open().
        # The decode-replace mutant reads the wrong name, sees no
        # contents, fails closed, and reports a missing lockfile.
        base = self.commit_files({"README.md": "fixture\n"})
        self.commit_raw_path(
            b"a\xe9", b"pyproject.toml",
            b"[tool.ruff]\nline-length = 100\n",
        )
        raw = self.git_raw(
            "-c", "core.quotepath=off",
            "diff", "-z", "--name-only", "--no-renames",
            "--diff-filter=d", base, "HEAD", "--",
        ).stdout
        self.assertIn(b"\xe9", raw, "raw -z bytes must reach the gate")
        changed = self.repo / "changed.txt"
        changed.write_bytes(raw if raw else b"")
        present_raw = self.git_raw(
            "-c", "core.quotepath=off", "ls-files", "-z",
        ).stdout
        present = self.repo / "present.txt"
        present.write_bytes(present_raw if present_raw else b"")
        env = dict(
            self.env, GATE_CHANGED=str(changed), GATE_PRESENT=str(present),
            GATE_LOGIC=str(HERE), GATE_MODE="enforce",
            GATE_IGNORE_MANIFESTS="", GATE_BASE=base,
        )
        proc = subprocess.run(
            [sys.executable, "-I", "-"],
            input=extract_heredoc("lockfile-gate.yml").encode(),
            cwd=self.repo, env=env, capture_output=True, text=False,
            timeout=30,
        )
        output = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode(
            "utf-8", "replace")
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 0, output)
        self.assertIn("blocker-lockfile: clean", output)


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round13_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round13_regression",
            CI.read_text(),
            "CI must run the round-13 regression module",
        )


if __name__ == "__main__":
    unittest.main()
