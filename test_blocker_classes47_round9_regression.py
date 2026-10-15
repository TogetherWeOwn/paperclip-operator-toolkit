#!/usr/bin/env python3
"""Round-9 regression tests for the four 4/5 warnings on head `0184b37`.

Pins the exact reviewer probes so the fixes cannot regress. Frozen
suites and round-2/3/4/5/6/7/8 + review-acceptance files stay untouched;
this file pins the new behaviour separately.

- Lockfile gate never crashes on binary `bun.lockb` and never
  emptiness-checks `requirements*.txt` (`is_parseable_lockfile`).
- The `lockfile: none` marker (JSON-valid `"//": "lockfile: none"`,
  case-insensitive), tool-only `pyproject.toml`, and `ignore_manifests`
  are wired through the delivered gate heredoc, not just the library.
- The library-crate hint counts `src/bin/` files and `[[bin]]`
  targets as binary evidence and scopes to the changed manifest's own
  directory.
- Chain splitting covers `;`, `||`, `|` (not just `&&`); each
  `[tool.poetry]`/`[tool.pdm]`/`[tool.uv]` table counts as a manifest.
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


CONC = load("blocker_concurrency_checks")
LOCK = load("blocker_lockfile_checks")

STAGE = HERE / "templates" / "org-github" / "blocker-classes47"
CI = HERE / ".github" / "workflows" / "ci.yml"


def workflow_for_run(run_text):
    return (
        "name: x\non: [push]\njobs:\n  deploy:\n"
        "    runs-on: ubuntu-latest\n    steps:\n"
        "      - run: %s\n" % run_text
    )


class ChainSeparatorTest(unittest.TestCase):
    def assert_flags(self, run_text):
        findings = CONC.check_workflow_concurrency(
            {"w.yml": workflow_for_run(run_text)}
        )
        self.assertEqual(len(findings), 1, "must flag: %r" % run_text)

    def test_semicolon_chain_still_flags(self):
        # Without `;` splitting this is one `echo` segment and stays
        # clean; split segments judge the migrating sibling alone.
        self.assert_flags("echo go; npm run migrate")

    def test_double_pipe_chain_still_flags(self):
        # One segment carries `cargo test` (benign); the migrating
        # sibling must still flag.
        self.assert_flags("cargo test || npm run migrate")

    def test_single_pipe_chain_still_flags(self):
        self.assert_flags("echo x | npm run migrate")

    def test_step_helper_semicolon_chain(self):
        self.assertTrue(CONC.step_runs_migrations(
            {"run": "echo go; npm run migrate"}))
        self.assertTrue(CONC.step_runs_migrations(
            {"run": "cargo test || npm run migrate"}))
        self.assertTrue(CONC.step_runs_migrations(
            {"run": "echo x | npm run migrate"}))


class PyprojectTableTest(unittest.TestCase):
    def assert_flags(self, table):
        findings = LOCK.check_lockfile_present(
            ["pyproject.toml"], [],
            manifest_contents={"pyproject.toml": "%s\nname = \"x\"\n" % table},
        )
        self.assertTrue(findings, "%s must count as a manifest" % table)

    def test_tool_poetry_counts(self):
        self.assert_flags("[tool.poetry]")

    def test_tool_pdm_counts(self):
        self.assert_flags("[tool.pdm]")

    def test_tool_uv_counts(self):
        self.assert_flags("[tool.uv]")


class LibraryCrateHintTest(unittest.TestCase):
    def test_lib_plus_main_still_flags(self):
        findings = LOCK.check_lockfile_present(
            ["Cargo.toml"], ["src/lib.rs", "src/main.rs"])
        self.assertTrue(findings, "lib + main.rs must still flag")

    def test_lib_plus_src_bin_still_flags(self):
        findings = LOCK.check_lockfile_present(
            ["Cargo.toml"], ["src/lib.rs", "src/bin/tool.rs"])
        self.assertTrue(findings, "lib + src/bin must still flag")

    def test_bin_section_in_manifest_still_flags(self):
        findings = LOCK.check_lockfile_present(
            ["Cargo.toml"], ["src/lib.rs"],
            manifest_contents={"Cargo.toml": '[[bin]]\nname = "tool"\n'},
        )
        self.assertTrue(findings, "[[bin]] must count as binary evidence")

    def test_workspace_bin_outside_scope_still_waives_lib_crate(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["crates/a/Cargo.toml"],
            ["crates/a/src/lib.rs", "crates/cli/src/bin/cli.rs"],
        ), [])

    def test_root_manifest_sees_workspace_bin(self):
        findings = LOCK.check_lockfile_present(
            ["Cargo.toml"],
            ["crates/a/src/lib.rs", "crates/cli/src/bin/cli.rs"],
        )
        self.assertTrue(findings, "root manifest must see workspace bins")


class OptOutTest(unittest.TestCase):
    def test_ignore_manifests_opts_out(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["package.json"], [],
            ignore_manifests=("package.json",),
        ), [])

    def test_ignore_manifests_basename_match(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["sub/dir/package.json"], [],
            ignore_manifests=("package.json",),
        ), [])

    def test_lockfile_none_case_insensitive(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["package.json"], [],
            manifest_contents={"package.json": '{"//": "LOCKFILE: NONE"}\n'},
        ), [])

    def test_lockfile_none_json_valid_form(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["package.json"], [],
            manifest_contents={
                "package.json": '{"name": "x", "//": "lockfile: none"}\n'
            },
        ), [])


class ParseableFilterTest(unittest.TestCase):
    def test_bun_lockb_is_not_parseable(self):
        self.assertFalse(LOCK.is_parseable_lockfile("bun.lockb"))

    def test_requirements_variants_are_not_parseable(self):
        self.assertFalse(LOCK.is_parseable_lockfile("requirements-dev.txt"))
        self.assertFalse(LOCK.is_parseable_lockfile("requirements.txt"))

    def test_text_lockfiles_are_parseable(self):
        self.assertTrue(LOCK.is_parseable_lockfile("yarn.lock"))
        self.assertTrue(LOCK.is_parseable_lockfile("package-lock.json"))
        self.assertTrue(LOCK.is_parseable_lockfile("Cargo.lock"))

    def test_empty_requirements_never_reports(self):
        self.assertEqual(
            LOCK.check_lockfile_parseable({"requirements-dev.txt": ""}), [])

    def test_bun_lockb_never_reports(self):
        self.assertEqual(
            LOCK.check_lockfile_parseable({"bun.lockb": "binary-bytes"}), [])

    def test_empty_yarn_lock_still_reports(self):
        findings = LOCK.check_lockfile_parseable({"yarn.lock": ""})
        self.assertTrue(findings)


def isolated_env():
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR", str(HERE)),
        "LANG": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "PYTHONDONTWRITEBYTECODE": "1",
    }


class LockfileGateWiringTest(unittest.TestCase):
    def setUp(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
        self.temp = tempfile.TemporaryDirectory(
            prefix="lockfile-gate-", dir=scratch)
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

    def lockfile_gate(self, base_files, changes, ignore=""):
        base = self.commit_files({"README.md": "fixture\n", **base_files})
        self.commit_files(changes)
        changed_text = self.git(
            "diff", "--name-only", "--no-renames", "--diff-filter=d",
            base, "HEAD", "--",
        )
        changed = self.repo / "changed.txt"
        changed.write_text((changed_text + "\n") if changed_text else "")
        present = self.repo / "present.txt"
        present.write_text(self.git("ls-files") + "\n")
        text = (STAGE / "lockfile-gate.yml").read_text()
        match = re.search(r"<<'PY'[^\n]*\n(.*?)\n[ \t]*PY(?:\n|$)", text, re.S)
        self.assertIsNotNone(
            match, "lockfile gate Python heredoc must be executable")
        env = dict(
            self.env, GATE_CHANGED=str(changed), GATE_PRESENT=str(present),
            GATE_LOGIC=str(HERE), GATE_MODE="enforce",
            GATE_IGNORE_MANIFESTS=ignore, GATE_BASE=base,
        )
        return subprocess.run(
            [sys.executable, "-I", "-"],
            input=textwrap.dedent(match.group(1)),
            cwd=self.repo, env=env, capture_output=True, text=True,
            timeout=30,
        )

    def test_gate_binary_bun_lockb_never_crashes(self):
        proc = self.lockfile_gate(
            {},
            {
                "package.json": '{"name": "x"}\n',
                "bun.lockb": b"\x00\x01\x02binary-lock\xff\xfe\n",
            },
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertNotIn("UnicodeDecodeError", output)
        self.assertEqual(proc.returncode, 0, output)

    def test_gate_empty_requirements_dev_is_clean(self):
        proc = self.lockfile_gate(
            {},
            {
                "pyproject.toml": '[project]\nname = "x"\n',
                "requirements-dev.txt": "",
            },
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 0, output)

    def test_gate_tool_only_pyproject_passes(self):
        proc = self.lockfile_gate(
            {}, {"pyproject.toml": "[tool.ruff]\nline-length = 100\n"})
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_gate_lockfile_none_marker_passes(self):
        # Marker honoured only from the base revision (merged opt-out):
        # base carries the marker, PR keeps it while changing deps.
        proc = self.lockfile_gate(
            {"package.json": '{"name": "x", "//": "lockfile: none"}\n'},
            {"package.json": '{"name": "x", "dependencies": {"left-pad": "1.0.0"}, "//": "lockfile: none"}\n'},
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_gate_ignore_manifests_env_passes(self):
        proc = self.lockfile_gate(
            {}, {"package.json": '{"name": "x"}\n'}, ignore="package.json")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_gate_missing_lock_still_flags(self):
        proc = self.lockfile_gate(
            {}, {"package.json": '{"name": "x"}\n'})
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("package.json", output)


class RequiredWrapperWiringTest(unittest.TestCase):
    def test_required_wrapper_forwards_ignore_manifests(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML required")
        document = yaml.safe_load(
            (STAGE / "lockfile-required.yml").read_text())
        forwarded = [job.get("with", {}).get("ignore_manifests", "")
                     for job in document["jobs"].values() if "uses" in job]
        self.assertEqual(len(forwarded), 1)
        self.assertRegex(
            forwarded[0],
            r"inputs\.ignore_manifests\s*\|\|\s*vars\.BLOCKER_LOCKFILE_IGNORE",
        )


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round9_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round9_regression",
            CI.read_text(),
            "CI must run the round-9 regression module",
        )


if __name__ == "__main__":
    unittest.main()
