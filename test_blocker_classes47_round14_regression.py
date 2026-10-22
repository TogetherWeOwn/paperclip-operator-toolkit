#!/usr/bin/env python3
"""Round-14 regression tests for the 4/5 warnings on head `6f7c7a4`.

Pins the exact reviewer probes so the fixes cannot regress. Frozen
suites and round-2..13 + review-acceptance files stay untouched.

- Workflow-command encoder: the CR branch is pinned behaviourally in
  all four gates. The round-13 LF-only names proved nothing about CR,
  and the runner's output reader ends a line on a lone CR, so a
  `\\r::error::` name forges `::error::` lines in every gate without
  encoding. Migration, lockfile and concurrency each get a CR-name
  test asserting no forged `::` line plus `%0D` in the output; the
  api-contract gate (which had no gate-level test) gets a hostile
  endpoint-key test; all four gates are listed in the encoder pin.
- Blocker ruleset render: both payloads render with the single org
  exclude list injected (runbook step), integer repository_id, branch
  ref and sha pin; the runbook step is pinned by content.
"""

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
FOUND = HERE / "templates" / "org-github" / "sdlc-foundation"
EXCLUDE_LIST = FOUND / "repo-exclude-list.txt"
RUNBOOK = RULESETS / "SDLC-BASELINE-RUNBOOK.md"
CI = HERE / ".github" / "workflows" / "ci.yml"

ALL_GATES = (
    "migration-gate.yml",
    "lockfile-gate.yml",
    "concurrency-gate.yml",
    "api-contract-gate.yml",
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


def extract_heredoc(gate_name):
    text = (STAGE / gate_name).read_text()
    match = re.search(r"<<'PY'[^\n]*\n(.*?)\n[ \t]*PY(?:\n|$)", text, re.S)
    assert match, "%s Python heredoc must be extractable" % gate_name
    return textwrap.dedent(match.group(1))


def no_forged_command_lines(output):
    """Every stdout line starting with `::` must be an intended warning.

    `splitlines()` already splits on a lone CR (the runner's output
    reader does too), so a CR-forged `::error::` line is caught here.
    """
    bad = [
        ln
        for ln in output.splitlines()
        if ln.startswith("::") and not ln.startswith("::warning::")
    ]
    return bad


def read_exclude_entries(path=EXCLUDE_LIST):
    entries = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            entries.append(line)
    return entries


class EncoderPresenceTest(unittest.TestCase):
    def test_all_four_gates_encode_percent_cr_lf(self):
        for gate in ALL_GATES:
            text = (STAGE / gate).read_text()
            self.assertIn("_encode_workflow_command_data", text, gate)
            # The CR branch is a real control (a lone CR ends a line in
            # the runner's output reader), not belt-and-braces: dropping
            # it must fail this test.
            self.assertIn(r'.replace("\r", "%0D")', text, gate)
            self.assertIn(r'.replace("\n", "%0A")', text, gate)
            self.assertIn(r'.replace("%", "%25")', text, gate)


class ScratchRepoMixin:
    def setUp(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
        self.temp = tempfile.TemporaryDirectory(
            prefix="blocker-round14-", dir=scratch)
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

    def run_api_contract_gate(self, old_schema, new_schema):
        # The gate reads fixed /tmp paths (like the delivered YAML), so
        # back up, write, run, and restore in cleanup.
        tmp = Path("/tmp")
        saved = {}
        for name in ("blocker-old-schema.json", "blocker-new-schema.json"):
            p = tmp / name
            saved[name] = p.read_bytes() if p.exists() else None
        self.addCleanup(self._restore_tmp_schemas, saved)
        (tmp / "blocker-old-schema.json").write_text(
            json.dumps(old_schema))
        (tmp / "blocker-new-schema.json").write_text(
            json.dumps(new_schema))
        env = dict(
            self.env, GATE_LOGIC=str(HERE), GATE_MODE="enforce",
        )
        return subprocess.run(
            [sys.executable, "-I", "-"],
            input=extract_heredoc("api-contract-gate.yml"),
            cwd=self.repo, env=env, capture_output=True, text=True,
            timeout=30,
        )

    def _restore_tmp_schemas(self, saved):
        tmp = Path("/tmp")
        for name, data in saved.items():
            p = tmp / name
            if data is None:
                try:
                    p.unlink()
                except OSError:
                    pass
            else:
                p.write_bytes(data)


MIGRATING_WORKFLOW = """\
name: x
on: push
jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - run: npm run migrate
"""


class CarriageReturnInjectionGateTest(ScratchRepoMixin, unittest.TestCase):
    def test_migration_cr_name_cannot_forge_error(self):
        forged = "db/migrations/002_a\r::error::forged.sql"
        proc = self.run_migration_gate(
            {}, {forged: "CREATE INDEX i ON t (c);\n"},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertEqual(no_forged_command_lines(output), [], output)
        self.assertIn("%0D", output)

    def test_lockfile_cr_name_cannot_forge_error(self):
        forged = "a\r::error::forged-from-lockfile/yarn.lock"
        proc = self.run_lockfile_gate(
            {}, {forged: ""},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertEqual(no_forged_command_lines(output), [], output)
        self.assertIn("%0D", output)

    def test_concurrency_cr_name_cannot_forge_error(self):
        forged = ".github/workflows/a\r::error::forged.yml"
        proc = self.run_concurrency_gate(
            {forged: MIGRATING_WORKFLOW},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertEqual(no_forged_command_lines(output), [], output)
        self.assertIn("%0D", output)

    def test_api_contract_cr_endpoint_key_cannot_forge_error(self):
        hostile = "GET /a\r::error::forged"
        proc = self.run_api_contract_gate(
            {hostile: {"req_required": [], "resp_required": []}},
            {},
        )
        output = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", output)
        self.assertEqual(proc.returncode, 1, output)
        self.assertEqual(no_forged_command_lines(output), [], output)
        self.assertIn("%0D", output)


class BlockerRenderTest(unittest.TestCase):
    def render(self, name):
        payload = json.loads((RULESETS / name).read_text())
        payload["conditions"]["repository_name"]["exclude"] = (
            read_exclude_entries()
        )
        return payload

    def test_payloads_render_with_single_exclude_list(self):
        entries = read_exclude_entries()
        self.assertTrue(entries, "exclude list has no entries")
        for name in (
            "blocker-classes47-report-only.json",
            "blocker-classes47-required.json",
        ):
            rendered = self.render(name)
            self.assertEqual(
                rendered["conditions"]["repository_name"]["exclude"],
                entries, name,
            )
            self.assertEqual(
                rendered["conditions"]["repository_name"]["include"],
                ["*"], name,
            )

    def test_workflow_entries_pin_repo_ref_sha(self):
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
                self.assertTrue(w.get("sha"), name)

    def test_runbook_documents_blocker_render(self):
        text = RUNBOOK.read_text()
        for token in (
            "blocker-classes47-report-only",
            "blocker-classes47-required",
            "repository_name.exclude",
            "repo-exclude-list.txt",
        ):
            self.assertIn(token, text)


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round14_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round14_regression",
            CI.read_text(),
            "CI must run the round-14 regression module",
        )


if __name__ == "__main__":
    unittest.main()
