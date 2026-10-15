#!/usr/bin/env python3
"""Round-11 regression tests for the three 4/5 warnings on head `7214172`.

Pins the exact reviewer probes so the fixes cannot regress. Frozen
suites and round-2/3/4/5/6/7/8/9/10 + review-acceptance files stay
untouched; this file pins the new behaviour separately.

- A base-revision `lockfile: none` marker never leaks across
  directories: a PR that touches opted-out `docs/package.json` and adds
  `svc/api/package.json` with dependencies still fails in enforce mode.
  Bare-basename keys (the round-10 unit-test shape) keep working.
- Base-revision reads never crash on non-UTF-8 bytes: the lockfile
  marker read and the migration wrangler/`.sql` reads decode with
  `errors="replace"` (no `text=True` anywhere in either gate).
- Non-ASCII paths are never silently skipped: both gates enumerate
  files with `git -c core.quotepath=off`, so a PR-controlled
  `café/package.json` / `002_café.sql` is checked, not quoted away.
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


class MarkerScopeTest(unittest.TestCase):
    def test_dir_key_does_not_leak_to_new_manifest(self):
        # Exact reviewer probe: base-opted-out docs manifest touched,
        # new svc manifest added with dependencies and no lockfile.
        findings = LOCK.check_lockfile_present(
            ["docs/package.json", "svc/api/package.json"], [],
            manifest_contents={
                "docs/package.json": '{"name": "docs"}\n',
                "svc/api/package.json":
                    '{"name": "api", "dependencies": {"left-pad": "1.0.0"}}\n',
            },
            marker_contents={"docs/package.json": MARKER},
        )
        self.assertEqual(len(findings), 1, findings)
        self.assertIn("package.json", findings[0])

    def test_exact_path_marker_still_opts_out(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["svc/api/package.json"], [],
            manifest_contents={
                "svc/api/package.json": '{"name": "api"}\n',
            },
            marker_contents={"svc/api/package.json": MARKER},
        ), [])

    def test_bare_basename_key_still_opts_out(self):
        # Legacy compatibility path ONLY (`marker_contents=None`, marker
        # falls back to `manifest_contents`): a directory-less key still
        # covers a nested path for library callers and unit tests. The
        # delivered gate always passes an explicit `marker_contents`
        # dict (exact-path only), so a root `package.json` key never
        # opts out a new nested manifest there — see round-12.
        self.assertEqual(LOCK.check_lockfile_present(
            ["sub/dir/package.json"], [],
            manifest_contents={"package.json": MARKER},
            marker_contents=None,
        ), [])

    def test_explicit_marker_map_is_exact_path_only(self):
        # The delivered gate path: an explicit (even directory-less)
        # root key must NOT opt out a different directory.
        findings = LOCK.check_lockfile_present(
            ["packages/new/package.json"], [],
            manifest_contents={
                "packages/new/package.json":
                    '{"name": "n", "dependencies": {"a": "1"}}\n',
            },
            marker_contents={"package.json": MARKER},
        )
        self.assertEqual(len(findings), 1, findings)

    def test_no_marker_still_flags(self):
        findings = LOCK.check_lockfile_present(
            ["package.json"], [],
            manifest_contents={"package.json": '{"name": "x"}\n'},
            marker_contents={},
        )
        self.assertTrue(findings, "unmarked manifest must flag")


class NonAsciiPathTest(unittest.TestCase):
    def test_cafe_manifest_detected_and_flagged(self):
        self.assertTrue(LOCK.is_manifest("café/package.json"))
        findings = LOCK.check_lockfile_present(
            ["café/package.json"], [],
            manifest_contents={
                "café/package.json":
                    '{"name": "x", "dependencies": {"left-pad": "1.0.0"}}\n',
            },
            marker_contents={},
        )
        self.assertEqual(len(findings), 1, findings)

    def test_cafe_sql_is_migration_path(self):
        path = "db/migrations/002_café.sql"
        self.assertTrue(MIG.is_migration_path(path))
        findings = MIG.check_migration_safety(
            {path: "CREATE INDEX i ON t (c);"}, dialect="postgres")
        self.assertTrue(findings, "plain CREATE INDEX must flag")
        self.assertIn("café", findings[0])


class GateShellPinTest(unittest.TestCase):
    def test_lockfile_gate_no_strict_text_decode(self):
        # `text=True,` (with comma) is the subprocess call shape;
        # prose mentions of `text=True` in comments do not decode.
        text = (STAGE / "lockfile-gate.yml").read_text()
        self.assertNotIn("text=True,", text)

    def test_migration_gate_no_strict_text_decode(self):
        text = (STAGE / "migration-gate.yml").read_text()
        self.assertNotIn("text=True,", text)

    def test_lockfile_gate_diff_is_nul_delimited(self):
        lines = (STAGE / "lockfile-gate.yml").read_text().splitlines()
        diff_lines = [ln for ln in lines if "diff -z --name-only" in ln]
        self.assertTrue(diff_lines, "lockfile diff enumeration must use -z")
        for ln in diff_lines:
            self.assertIn(
                "core.quotepath=off", ln,
                "diff line must also disable quotepath (defence in depth)")

    def test_lockfile_gate_lsfiles_is_nul_delimited(self):
        lines = (STAGE / "lockfile-gate.yml").read_text().splitlines()
        ls_lines = [ln for ln in lines if "ls-files -z" in ln]
        self.assertGreaterEqual(
            len(ls_lines), 2,
            "both lockfile ls-files enumerations (changed fallback + "
            "present) must use -z")
        for ln in ls_lines:
            self.assertIn("core.quotepath=off", ln)

    def test_migration_gate_diff_is_nul_delimited(self):
        lines = (STAGE / "migration-gate.yml").read_text().splitlines()
        diff_lines = [ln for ln in lines if "diff -z --name-only" in ln]
        self.assertTrue(
            diff_lines, "migration diff enumeration must use -z")
        for ln in diff_lines:
            self.assertIn("core.quotepath=off", ln)

    def test_migration_gate_lstree_is_nul_delimited(self):
        text = (STAGE / "migration-gate.yml").read_text()
        self.assertIn(
            '"-z", base', text,
            "wrangler ls-tree enumeration must pass -z")
        idx = text.find('"ls-tree"')
        self.assertNotEqual(idx, -1, "ls-tree call must exist")
        window = text[max(0, idx - 200):idx + 300]
        self.assertIn("core.quotepath=off", window)
        self.assertIn('"-z"', window)

    def test_both_gates_split_nul_with_fsdecode(self):
        for gate in ("lockfile-gate.yml", "migration-gate.yml"):
            text = (STAGE / gate).read_text()
            self.assertIn("os.fsdecode", text, gate)
            self.assertIn(r"\x00", text, gate)
            self.assertIn('_read_nul_list("GATE_CHANGED")', text, gate)

    def test_changed_list_not_replace_decoded(self):
        for gate in ("lockfile-gate.yml", "migration-gate.yml"):
            text = (STAGE / gate).read_text()
            self.assertNotIn('GATE_CHANGED"], encoding="utf-8"', text, gate)

    def test_both_gates_decode_contents_with_replace(self):
        # File CONTENT reads (Latin-1 bodies) still decode with
        # replace; only the changed-list/name path uses fsdecode.
        for gate in ("lockfile-gate.yml", "migration-gate.yml"):
            text = (STAGE / gate).read_text()
            self.assertIn('errors="replace"', text, gate)

    def test_migration_gate_unreadable_is_fail_closed(self):
        text = (STAGE / "migration-gate.yml").read_text()
        self.assertIn("unreadable", text)
        self.assertIn("fail-closed", text)


class ScratchRepoMixin:
    def setUp(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
        self.temp = tempfile.TemporaryDirectory(
            prefix="blocker-round11-", dir=scratch)
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

    def run_lockfile_gate(self, base_files, changes):
        base = self.commit_files({"README.md": "fixture\n", **base_files})
        self.commit_files(changes)
        # Mirror the fixed gate enumeration (quotepath off).
        changed_text = self.git(
            "-c", "core.quotepath=off",
            "diff", "--name-only", "--no-renames", "--diff-filter=d",
            base, "HEAD", "--",
        )
        changed = self.repo / "changed.txt"
        changed.write_text((changed_text + "\n") if changed_text else "")
        present = self.repo / "present.txt"
        present.write_text(self.git(
            "-c", "core.quotepath=off", "ls-files") + "\n")
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


class LockfileGateBehaviorTest(ScratchRepoMixin, unittest.TestCase):
    def test_gate_cross_directory_marker_still_flags(self):
        proc = self.run_lockfile_gate(
            {"docs/package.json": MARKER},
            {
                "docs/package.json": '{"name": "d", "version": "2"}\n',
                "svc/api/package.json":
                    '{"name": "a", "dependencies": {"left-pad": "1.0.0"}}\n',
            },
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("package.json", output)

    def test_gate_merged_opt_out_still_passes(self):
        proc = self.run_lockfile_gate(
            {"docs/package.json": MARKER},
            {"docs/package.json":
                '{"name": "d", "version": "2", "//": "lockfile: none"}\n'},
        )
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output)

    def test_gate_latin1_base_manifest_no_crash(self):
        proc = self.run_lockfile_gate(
            {"Gemfile": b"# caf\xe9 gems\nsource 'https://rubygems.org'\n"},
            {"Gemfile":
                "# caf\xe9 gems\nsource 'https://rubygems.org'\n"
                "gem 'rack'\n"},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertNotIn("UnicodeDecodeError", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("Gemfile", output)

    def test_gate_non_ascii_manifest_checked(self):
        proc = self.run_lockfile_gate(
            {},
            {"café/package.json":
                '{"name": "x", "dependencies": {"left-pad": "1.0.0"}}\n'},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("package.json", output)


class MigrationGateBehaviorTest(ScratchRepoMixin, unittest.TestCase):
    def run_migration_heredoc(self, files):
        # Real-enumeration path: commit a base, commit the PR files,
        # then run the YAML's own `git diff -z` enumeration so the
        # changed list the heredoc sees is byte-identical to the
        # delivered gate (no hand-written changed.txt).
        base = self.commit_files({"README.md": "fixture\n"})
        self.commit_files(files)
        raw = subprocess.run(
            ["/usr/bin/git", "-c", "core.quotepath=off",
             "diff", "-z", "--name-only", "--no-renames",
             "--diff-filter=d", base, "HEAD", "--"],
            cwd=self.repo, env=self.env,
            capture_output=True, timeout=20,
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

    def test_gate_latin1_sql_no_crash(self):
        proc = self.run_migration_heredoc(
            {"db/migrations/003_latin.sql":
                b"-- caf\xe9 comment\nCREATE INDEX i ON t (c);\n"})
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertNotIn("UnicodeDecodeError", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("CONCURRENTLY", output)

    def test_gate_non_ascii_sql_checked(self):
        proc = self.run_migration_heredoc(
            {"db/migrations/002_café.sql": "CREATE INDEX i ON t (c);\n"})
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("café", output)


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round11_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round11_regression",
            CI.read_text(),
            "CI must run the round-11 regression module",
        )


if __name__ == "__main__":
    unittest.main()
