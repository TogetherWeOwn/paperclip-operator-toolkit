#!/usr/bin/env python3
"""Round-12 regression tests for the four 4/5 warnings on head `b2238b4`.

Pins the exact reviewer probes so the fixes cannot regress. Frozen
suites and round-2..11 + review-acceptance files stay untouched.

- Root-level opt-out markers are exact-path only on the delivered gate
  path: a base root `package.json` / `Cargo.toml` marker never opts out
  a new nested manifest.
- Both gates enumerate with NUL-delimited git output (`-z`) and split
  on `\\0` with `os.fsdecode`: paths containing `"`, backslash, tab or
  invalid-UTF-8 bytes are checked, never quoted-skipped.
- An unreadable `.sql` migration is fail-closed (a finding, exit 1),
  never a silent clean pass.
- Per-line shell pins (diff / ls-files / ls-tree carry `-z`) replace
  substring counts so single-line mutants are killed.
"""

import importlib.util
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LOCK = load("blocker_lockfile_checks")
MIG = load("blocker_migration_checks")

STAGE = HERE / "templates" / "org-github" / "blocker-classes47"
CI = HERE / ".github" / "workflows" / "ci.yml"

MARKER = '{"//": "lockfile: none"}\n'


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


class MarkerRootLeakUnitTest(unittest.TestCase):
    def test_root_package_json_marker_does_not_cover_nested(self):
        findings = LOCK.check_lockfile_present(
            ["package.json", "packages/new/package.json"], [],
            manifest_contents={
                "package.json": '{"name": "root"}\n',
                "packages/new/package.json":
                    '{"name": "n", "dependencies": {"a": "1"}}\n',
            },
            marker_contents={"package.json": MARKER},
        )
        self.assertEqual(len(findings), 1, findings)
        self.assertIn("package.json", findings[0])

    def test_root_cargo_marker_does_not_cover_nested(self):
        findings = LOCK.check_lockfile_present(
            ["Cargo.toml", "crates/new/Cargo.toml"], [],
            manifest_contents={
                "Cargo.toml": '[package]\nname = "root"\n',
                "crates/new/Cargo.toml":
                    '[package]\nname = "new"\n[dependencies]\na = "1"\n',
            },
            marker_contents={"Cargo.toml": '[package]\n# lockfile: none\n'},
        )
        self.assertEqual(len(findings), 1, findings)

    def test_exact_root_marker_still_opts_out_root(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["package.json"], [],
            manifest_contents={"package.json": '{"name": "r"}\n'},
            marker_contents={"package.json": MARKER},
        ), [])


class ScratchRepoMixin:
    def setUp(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
        self.temp = tempfile.TemporaryDirectory(
            prefix="blocker-round12-", dir=scratch)
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


class LockfileGateRootMarkerTest(ScratchRepoMixin, unittest.TestCase):
    def test_gate_root_package_marker_does_not_cover_nested(self):
        proc = self.run_lockfile_gate(
            {"package.json": MARKER},
            {
                "package.json": '{"name": "r", "version": "2"}\n',
                "packages/new/package.json":
                    '{"name": "n", "dependencies": {"a": "1"}}\n',
            },
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("package.json", output)

    def test_gate_root_cargo_marker_does_not_cover_nested(self):
        proc = self.run_lockfile_gate(
            {"Cargo.toml": '[package]\n# lockfile: none\n'},
            {
                "Cargo.toml": '[package]\nname = "r"\nversion = "2"\n',
                "crates/new/Cargo.toml":
                    '[package]\nname = "n"\n[dependencies]\na = "1"\n',
            },
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("Cargo.toml", output)


class QuotedSpecialPathTest(ScratchRepoMixin, unittest.TestCase):
    def test_migration_quote_in_name_is_checked(self):
        proc = self.run_migration_gate(
            {},
            {'db/migrations/002_a"b.sql': "CREATE INDEX i ON t (c);\n"},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("CONCURRENTLY", output)

    def test_migration_tab_in_name_is_checked(self):
        proc = self.run_migration_gate(
            {},
            {"db/migrations/002_a\tb.sql": "CREATE INDEX i ON t (c);\n"},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("CONCURRENTLY", output)

    def test_migration_backslash_in_name_is_checked(self):
        proc = self.run_migration_gate(
            {},
            {"db/migrations/002_a\\b.sql": "CREATE INDEX i ON t (c);\n"},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("CONCURRENTLY", output)

    def test_lockfile_quote_in_dir_is_checked(self):
        proc = self.run_lockfile_gate(
            {},
            {'a"b/package.json':
                '{"name": "x", "dependencies": {"a": "1"}}\n'},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("package.json", output)

    def test_lockfile_tab_in_dir_is_checked(self):
        proc = self.run_lockfile_gate(
            {},
            {"a\tb/package.json":
                '{"name": "x", "dependencies": {"a": "1"}}\n'},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("package.json", output)


class InvalidUtf8NameTest(ScratchRepoMixin, unittest.TestCase):
    def test_migration_invalid_utf8_name_is_fail_closed(self):
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
        # The delivered `-z` enumeration must carry the raw byte name;
        # a quoted/escaped form would prove the bypass is back.
        self.assertIn(b"\xe9", raw, "raw -z bytes must reach the gate")
        changed = self.repo / "changed.txt"
        changed.write_bytes(raw if raw else b"")
        env = dict(
            self.env, GATE_CHANGED=str(changed), GATE_BASE=base,
            GATE_DIALECT="postgres", GATE_LOGIC=str(HERE),
            GATE_MODE="enforce",
        )
        # Bytes capture: the gate echoes the raw-byte name, which is
        # invalid UTF-8 — `text=True` would raise UnicodeDecodeError in
        # the harness itself. Decode with replace for assertions.
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
        self.assertNotIn("blocker-migration: clean", output)


class NulEnumerationPinTest(unittest.TestCase):
    def test_lockfile_diff_line_is_nul(self):
        lines = (STAGE / "lockfile-gate.yml").read_text().splitlines()
        hits = [ln for ln in lines if "diff -z --name-only" in ln]
        self.assertTrue(hits)
        for ln in hits:
            self.assertIn("core.quotepath=off", ln)

    def test_lockfile_present_line_is_nul(self):
        lines = (STAGE / "lockfile-gate.yml").read_text().splitlines()
        hits = [ln for ln in lines if "ls-files -z" in ln]
        self.assertGreaterEqual(len(hits), 2)
        for ln in hits:
            self.assertIn("core.quotepath=off", ln)

    def test_migration_diff_line_is_nul(self):
        lines = (STAGE / "migration-gate.yml").read_text().splitlines()
        hits = [ln for ln in lines if "diff -z --name-only" in ln]
        self.assertTrue(hits)
        for ln in hits:
            self.assertIn("core.quotepath=off", ln)

    def test_migration_lstree_line_is_nul(self):
        text = (STAGE / "migration-gate.yml").read_text()
        self.assertIn('"-z", base', text)
        idx = text.find('"ls-tree"')
        self.assertNotEqual(idx, -1)
        window = text[max(0, idx - 200):idx + 300]
        self.assertIn("core.quotepath=off", window)
        self.assertIn('"-z"', window)

    def test_heredocs_split_nul_with_fsdecode(self):
        for gate in ("lockfile-gate.yml", "migration-gate.yml"):
            text = (STAGE / gate).read_text()
            self.assertIn("os.fsdecode", text, gate)
            self.assertIn('_read_nul_list("GATE_CHANGED")', text, gate)

    def test_migration_unreadable_fails_closed(self):
        text = (STAGE / "migration-gate.yml").read_text()
        self.assertIn("migration file unreadable (fail-closed)", text)


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round12_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round12_regression",
            CI.read_text(),
            "CI must run the round-12 regression module",
        )


if __name__ == "__main__":
    unittest.main()
