#!/usr/bin/env python3
"""Round-10 regression tests for the three 4/5 warnings on head `6d070a4`.

Pins the exact reviewer probes so the fixes cannot regress. Frozen
suites and round-2/3/4/5/6/7/8/9 + review-acceptance files stay
untouched; this file pins the new behaviour separately.

- `lockfile: none` is honoured only from the base revision (a PR that
  adds the marker in the same diff still fails in enforce mode).
- `ignore_manifests` workflow wiring is pinned by parsing the delivered
  YAML (gate input declaration, step env mapping, wrapper forwarding
  for both mode and ignore, mixed comma/space separators).
- A stdlib-only `go.mod` (no `require` directive) never reports;
  a `go.mod` with a `require` and no `go.sum` still flags.
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

STAGE = HERE / "templates" / "org-github" / "blocker-classes47"
CI = HERE / ".github" / "workflows" / "ci.yml"


def load_yaml(path):
    try:
        import yaml
    except ImportError:
        raise unittest.SkipTest("PyYAML required")
    return yaml.safe_load(Path(path).read_text())


class GoStdlibTest(unittest.TestCase):
    def test_require_less_go_mod_passes(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["go.mod"], [],
            manifest_contents={
                "go.mod": "module example.com/tool\n\ngo 1.27\n",
            },
        ), [])

    def test_go_mod_with_require_still_flags(self):
        findings = LOCK.check_lockfile_present(
            ["go.mod"], [],
            manifest_contents={
                "go.mod": (
                    "module example.com/tool\n\ngo 1.27\n\n"
                    "require github.com/a/b v1.0.0\n"
                ),
            },
        )
        self.assertTrue(findings, "go.mod with require must flag")
        self.assertIn("go.mod", findings[0])

    def test_go_mod_require_block_still_flags(self):
        findings = LOCK.check_lockfile_present(
            ["go.mod"], [],
            manifest_contents={
                "go.mod": "module x\n\ngo 1.27\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n",
            },
        )
        self.assertTrue(findings, "require block must flag")

    def test_go_mod_without_contents_fails_closed(self):
        findings = LOCK.check_lockfile_present(["go.mod"], [])
        self.assertTrue(findings, "no contents must fail closed")

    def test_go_mod_with_go_sum_passes(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["go.mod", "go.sum"], [],
            manifest_contents={
                "go.mod": "module x\n\ngo 1.27\n\nrequire github.com/a/b v1.0.0\n",
            },
        ), [])

    def test_go_require_regex_indented(self):
        self.assertTrue(LOCK._GO_REQUIRE_RE.search("  require foo"))
        self.assertTrue(LOCK._GO_REQUIRE_RE.search("\trequire ("))
        self.assertIsNone(LOCK._GO_REQUIRE_RE.search("module x\n"))


class MarkerFromBaseTest(unittest.TestCase):
    def test_marker_in_base_passes(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["package.json"], [],
            manifest_contents={"package.json": '{"name": "x"}\n'},
            marker_contents={
                "package.json": '{"name": "x", "//": "lockfile: none"}\n',
            },
        ), [])

    def test_marker_only_in_pr_still_flags(self):
        findings = LOCK.check_lockfile_present(
            ["package.json"], [],
            manifest_contents={
                "package.json": '{"name": "x", "//": "lockfile: none"}\n',
            },
            marker_contents={},
        )
        self.assertTrue(findings, "PR-added marker must not waive")

    def test_marker_omitted_falls_back_to_manifest(self):
        # Backward compatibility for library callers: no marker_contents
        # means the marker is read from manifest_contents.
        self.assertEqual(LOCK.check_lockfile_present(
            ["package.json"], [],
            manifest_contents={
                "package.json": '{"name": "x", "//": "lockfile: none"}\n',
            },
        ), [])

    def test_marker_basename_keys(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["sub/dir/package.json"], [],
            manifest_contents={"sub/dir/package.json": '{"name": "x"}\n'},
            marker_contents={
                "package.json": '{"//": "lockfile: none"}\n',
            },
        ), [])

    def test_no_marker_still_flags(self):
        findings = LOCK.check_lockfile_present(
            ["package.json"], [],
            manifest_contents={"package.json": '{"name": "x"}\n'},
            marker_contents={"package.json": '{"name": "x"}\n'},
        )
        self.assertTrue(findings)


def workflow_call_inputs(document):
    # PyYAML parses the `on:` key as boolean True (YAML 1.1).
    on = document.get("on", document.get(True))
    return on["workflow_call"]["inputs"]


class GateYamlPinTest(unittest.TestCase):
    def test_gate_declares_ignore_manifests_input(self):
        gate = load_yaml(STAGE / "lockfile-gate.yml")
        inputs = workflow_call_inputs(gate)
        self.assertIn("ignore_manifests", inputs)
        self.assertIn("mode", inputs)

    def test_gate_env_maps_ignore_manifests(self):
        text = (STAGE / "lockfile-gate.yml").read_text()
        self.assertRegex(
            text,
            r"GATE_IGNORE_MANIFESTS:\s*\$\{\{\s*inputs\.ignore_manifests",
            "gate step env must map inputs.ignore_manifests",
        )

    def test_gate_env_reads_repo_variable(self):
        text = (STAGE / "lockfile-gate.yml").read_text()
        self.assertIn(
            "vars.BLOCKER_LOCKFILE_IGNORE", text,
            "gate must read BLOCKER_LOCKFILE_IGNORE so the direct "
            "caller from ADOPTION.md gets the variable",
        )

    def test_gate_heredoc_reads_marker_from_base(self):
        text = (STAGE / "lockfile-gate.yml").read_text()
        self.assertIn('GATE_BASE="$base"', text)
        self.assertRegex(text, r"git.*show.*base.*path")

    def test_gate_split_accepts_comma_and_space(self):
        text = (STAGE / "lockfile-gate.yml").read_text()
        self.assertIn(r"[,\s]", text)

    def test_wrapper_forwards_mode(self):
        wrapper = load_yaml(STAGE / "lockfile-required.yml")
        forwarded = [
            job.get("with", {}).get("mode", "")
            for job in wrapper["jobs"].values() if "uses" in job
        ]
        self.assertEqual(len(forwarded), 1)
        self.assertRegex(forwarded[0], r"inputs\.mode")

    def test_wrapper_forwards_ignore_manifests(self):
        wrapper = load_yaml(STAGE / "lockfile-required.yml")
        forwarded = [
            job.get("with", {}).get("ignore_manifests", "")
            for job in wrapper["jobs"].values() if "uses" in job
        ]
        self.assertEqual(len(forwarded), 1)
        self.assertRegex(
            forwarded[0],
            r"inputs\.ignore_manifests\s*\|\|\s*vars\.BLOCKER_LOCKFILE_IGNORE",
        )

    def test_wrapper_with_keys_are_gate_inputs(self):
        gate = load_yaml(STAGE / "lockfile-gate.yml")
        wrapper = load_yaml(STAGE / "lockfile-required.yml")
        gate_inputs = set(workflow_call_inputs(gate).keys())
        for job in wrapper["jobs"].values():
            if "uses" not in job:
                continue
            for key in (job.get("with", {}) or {}).keys():
                self.assertIn(
                    key, gate_inputs,
                    "wrapper with: key %r is not a declared gate input"
                    % key,
                )


def isolated_env():
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR", str(HERE)),
        "LANG": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "PYTHONDONTWRITEBYTECODE": "1",
    }


class LockfileGateRound10Test(unittest.TestCase):
    def setUp(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
        self.temp = tempfile.TemporaryDirectory(
            prefix="lockfile-gate10-", dir=scratch)
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

    def test_gate_pr_added_marker_still_flags(self):
        proc = self.lockfile_gate(
            {},
            {"package.json": '{"name": "x", "//": "lockfile: none"}\n'},
        )
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("package.json", output)

    def test_gate_merged_marker_passes(self):
        proc = self.lockfile_gate(
            {"package.json": '{"name": "x", "//": "lockfile: none"}\n'},
            {"package.json": '{"name": "x", "dependencies": {"a": "1"}, "//": "lockfile: none"}\n'},
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_gate_mixed_comma_space_ignore_passes(self):
        proc = self.lockfile_gate(
            {},
            {
                "package.json": '{"name": "x"}\n',
                "Cargo.toml": '[package]\nname = "x"\n',
                "src/main.rs": "fn main() {}\n",
            },
            ignore="package.json, Cargo.toml",
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_gate_space_separated_ignore_passes(self):
        proc = self.lockfile_gate(
            {},
            {
                "package.json": '{"name": "x"}\n',
                "Cargo.toml": '[package]\nname = "x"\n',
                "src/main.rs": "fn main() {}\n",
            },
            ignore="package.json Cargo.toml",
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_gate_stdlib_go_mod_passes(self):
        proc = self.lockfile_gate(
            {},
            {"go.mod": "module example.com/tool\n\ngo 1.27\n"},
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_gate_go_mod_with_require_still_flags(self):
        proc = self.lockfile_gate(
            {},
            {"go.mod": "module x\n\ngo 1.27\n\nrequire github.com/a/b v1.0.0\n"},
        )
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("go.mod", output)


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round10_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round10_regression",
            CI.read_text(),
            "CI must run the round-10 regression module",
        )


if __name__ == "__main__":
    unittest.main()
