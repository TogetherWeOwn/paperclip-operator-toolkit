#!/usr/bin/env python3
"""Negative controls for the parsed CI admission and execution contract."""
import copy
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

import test_workflow_hardening as hardening


ROOT = Path(__file__).resolve().parents[1]
TEXT = (ROOT / ".github/workflows/ci.yml").read_text()
CONTRACTS = (
    "Immutable Action references and red/green controls",
    "Workflow hardening regression controls",
)


def replace(old, new):
    if old not in TEXT:
        raise AssertionError(f"mutation anchor absent: {old!r}")
    return TEXT.replace(old, new, 1)


class CIExecution(unittest.TestCase):
    def gate(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ci.yml"
            path.write_text(text)
            env = {key: os.environ[key] for key in ("PATH", "PYTHONPATH") if key in os.environ}
            return subprocess.run(["bash", str(ROOT / "verification/ci-gating.sh"), str(path)],
                                  cwd=ROOT, env=env, text=True, capture_output=True, timeout=15)

    def rejected(self, text):
        result = self.gate(text)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("FAIL:", result.stdout + result.stderr)

    def test_parser_runtime_matches_the_hashed_wheel(self):
        data = yaml.safe_load(TEXT)
        block = ("      - uses: actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0\n"
                 "        with:\n          python-version: '3.12'\n")
        for job in ("changes", "offline-suites"):
            with self.subTest(job=job):
                matches = [step for step in data["jobs"][job]["steps"]
                           if step.get("uses", "").startswith("actions/setup-python@")]
                self.assertEqual(len(matches), 1, "hash-pinned parser has no selected Python runtime")
                self.assertEqual(matches[0].get("with"), {"python-version": "3.12"})
                start = TEXT.index(f"  {job}:\n")
                prefix, body = TEXT[:start], TEXT[start:]
                self.assertIn(block, body)
                for changed in ("", block.replace("'3.12'", "'3.14'"),
                                block.replace("      - uses:", "      - if: false\n        uses:"),
                                block.replace("6d4fd22b20465ccc0f7354476588e8df7c9ca0e0", "v7")):
                    self.rejected(prefix + body.replace(block, changed, 1))

    def test_parser_setup_has_a_recognized_reporter_teardown(self):
        data = yaml.safe_load(TEXT)
        for job in ("changes", "offline-suites"):
            with self.subTest(job=job):
                runtime = next(step for step in data["jobs"][job]["steps"]
                               if step.get("uses", "").startswith("actions/setup-python@"))
                self.assertNotIn("name", runtime,
                                 "use the default Run actions/ name so its Post Run teardown is recognized")
                start = TEXT.index(f"  {job}:\n")
                prefix, body = TEXT[:start], TEXT[start:]
                self.rejected(prefix + body.replace(
                    "      - uses: actions/setup-python@",
                    "      - name: Python for hash-pinned parser\n        uses: actions/setup-python@", 1))

    def test_postgres_bins_are_selected_and_validated_before_startup(self):
        data = yaml.safe_load(TEXT)
        for job in ("privilege-suites", "upgrade-offline"):
            with self.subTest(job=job):
                steps = data["jobs"][job]["steps"]
                start = next(step["run"] for step in steps
                             if step.get("name") == "Start an ephemeral PostgreSQL cluster")
                preflight = start.split('PGDATA=', 1)[0]
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    bindir = root / "selected-postgres" / "bin"
                    bindir.mkdir(parents=True)
                    config = root / "pg_config"
                    config.write_text(f'#!/bin/sh\nprintf "%s\\n" "{bindir}"\n')
                    config.chmod(0o755)
                    env = {"PATH": str(root) + ":/usr/bin:/bin",
                           "GITHUB_ENV": str(root / "env"), "GITHUB_PATH": str(root / "path")}
                    (root / "env").touch()
                    (root / "path").touch()
                    for tool in ("initdb", "pg_ctl", "createdb", "psql"):
                        path = bindir / tool
                        path.write_text("#!/bin/sh\nexit 0\n")
                        path.chmod(0o755)
                    result = subprocess.run(["bash", "-c", preflight], env=env, cwd=root,
                                            capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn(f"ORGDB_PGBIN={bindir}\n", (root / "env").read_text())
                    self.assertEqual((root / "path").read_text(), str(bindir) + "\n")
                    for tool in ("initdb", "pg_ctl", "createdb", "psql"):
                        path = bindir / tool
                        path.chmod(0o644)
                        result = subprocess.run(["bash", "-c", preflight], env=env, cwd=root,
                                                capture_output=True, text=True, timeout=5)
                        self.assertNotEqual(result.returncode, 0, f"missing {tool} was accepted")
                        path.chmod(0o755)
                stop = next(step for step in steps
                            if step.get("name") == "Stop the ephemeral PostgreSQL cluster")
                self.assertEqual(stop.get("if"), "always()")
                self.assertIn('"$ORGDB_PGBIN/pg_ctl"', stop["run"])
                self.assertIn('echo "ORGDB_PGDATA=$PGDATA"', start)
                self.assertLess(start.index('echo "ORGDB_PGDATA=$PGDATA"'),
                                start.index('"$PGBIN/pg_ctl"'))

    def test_real_workflow_passes(self):
        result = self.gate(TEXT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_mandatory_steps_cannot_skip_swallow_or_replace_the_shell(self):
        for title in ("gitleaks detect", "Disclosure scan over plugins/", "Aggregate gated results"):
            for setting in ("'if': false", "continue-on-error: true", "shell: echo {0}"):
                with self.subTest(title=title, setting=setting):
                    self.rejected(replace(f"      - name: {title}\n",
                                          f"      - name: {title}\n        {setting}\n"))

    def test_scan_commands_are_executable_not_mentions(self):
        for command in ("bash scripts/secret-scan.sh", "bash scripts/disclosure-scan.sh plugins"):
            with self.subTest(command=command):
                self.rejected(replace(f"        run: {command}", f"        run: echo {command}"))

    def test_required_jobs_cannot_redirect_execution(self):
        for job in ("changes", "offline-suites", "secret-scan", "disclosure-scan", "ci-ok"):
            for setting in ("defaults: {run: {shell: 'echo {0}'}}",
                            "defaults: {run: {working-directory: probe-stubs}}",
                            "env: {PATH: probe-stubs}", "continue-on-error: true"):
                with self.subTest(job=job, setting=setting):
                    self.rejected(replace(f"  {job}:\n", f"  {job}:\n    {setting}\n"))

    def test_workflow_cannot_redirect_execution(self):
        for setting in ("defaults: {run: {working-directory: probe-stubs}}",
                        "env: {PATH: probe-stubs}", "env: {BASH_ENV: probe-stubs}"):
            with self.subTest(setting=setting):
                self.rejected(replace("jobs:\n", f"{setting}\njobs:\n"))

    def test_contract_context_is_repository_root_with_the_pinned_parser(self):
        for title in CONTRACTS:
            for setting in ("working-directory: probe-stubs", "env: {PATH: probe-stubs}",
                            "env: {PYTHONPATH: probe-stubs}", "env: {BASH_ENV: probe-stubs}"):
                with self.subTest(title=title, setting=setting):
                    # Replace the existing env mapping, rather than creating a duplicate key.
                    old = (f"      - name: {title}\n        env:\n"
                           "          PYTHONPATH: ${{ runner.temp }}/static-label-guard-deps\n")
                    if setting.startswith("working-directory:"):
                        new = old.replace(f"      - name: {title}\n",
                                          f"      - name: {title}\n        {setting}\n")
                    else:
                        value = setting
                        if "PYTHONPATH" not in setting:
                            value = setting.removesuffix("}") + ", PYTHONPATH: '${{ runner.temp }}/static-label-guard-deps'}"
                        new = f"      - name: {title}\n        {value}\n"
                    self.rejected(replace(old, new))

    def test_heavy_job_predicates_cannot_be_false_conjunctions_or_inverted(self):
        data = yaml.safe_load(TEXT)
        for job, spec in data["jobs"].items():
            condition = spec.get("if", "")
            if "needs.changes.outputs.heavy" not in condition:
                continue
            for new in ("${{ false && needs.changes.outputs.heavy == 'true' }}",
                        condition.replace("== 'true'", "!= 'true'")):
                with self.subTest(job=job, condition=new):
                    start = TEXT.index(f"  {job}:\n")
                    prefix, body = TEXT[:start], TEXT[start:]
                    self.rejected(prefix + body.replace(f"    if: {condition}", f"    if: {new}", 1))

    def test_dependencies_and_outputs_are_bound_not_comment_mentions(self):
        for old, new in (
                ("    needs: [changes]", "    needs: [secret-scan] # changes"),
                ("      heavy: ${{ steps.detect.outputs.heavy }}", "      heavy: 'false'"),
                ("      - id: detect", "      - id: ignored"),
                ("      - id: detect", "      - id: detect\n        if: false"),
                ("    needs: model-selection-impact", "    needs: secret-scan # model-selection-impact"),
                ("      impacted: ${{ steps.impact.outputs.impacted }}", "      impacted: 'false'")):
            with self.subTest(old=old):
                self.rejected(replace(old, new))

    def test_another_contract_guards_the_gate_invocations(self):
        data = yaml.safe_load(TEXT)
        test = hardening.WorkflowHardening("test_ci_executes_the_contract_with_the_existing_pinned_parser")
        validator = getattr(test, "assert_gate_invocations", None)
        self.assertIsNotNone(validator, "the hardening contract does not guard the independent gate")
        validator(data)
        for job in ("changes", "offline-suites"):
            for variant in ("deleted", "if", "shell", "run", "working-directory", "env"):
                with self.subTest(job=job, variant=variant):
                    mutant = copy.deepcopy(data)
                    steps = mutant["jobs"][job]["steps"]
                    step = next(s for s in steps if s.get("name") == "change-gating contract holds")
                    if variant == "deleted":
                        steps.remove(step)
                    else:
                        step[variant] = {"if": False, "shell": "echo {0}", "run": "echo bypass",
                                         "working-directory": "probe-stubs", "env": {"PATH": "probe-stubs"}}[variant]
                    with self.assertRaises(AssertionError):
                        validator(mutant)
                    # Keep production formatting so rejection cannot be caused
                    # by an unrelated legacy text-format assertion in the gate.
                    start = TEXT.index(f"  {job}:\n")
                    prefix, body = TEXT[:start], TEXT[start:]
                    block = ("      - name: change-gating contract holds\n        env:\n"
                             "          PYTHONPATH: ${{ runner.temp }}/static-label-guard-deps\n"
                             "        run: ./test_ci_gating.sh\n")
                    if variant == "deleted":
                        changed = ""
                    elif variant == "run":
                        changed = block.replace("./test_ci_gating.sh", "echo bypass")
                    elif variant == "env":
                        changed = block.replace("        env:\n", "        env:\n          PATH: probe-stubs\n")
                    else:
                        value = {"if": "false", "shell": "echo {0}", "working-directory": "probe-stubs"}[variant]
                        changed = block.replace("        env:\n", f"        {variant}: {value}\n        env:\n")
                    self.assertIn(block, body)
                    self.rejected(prefix + body.replace(block, changed, 1))


if __name__ == "__main__":
    unittest.main()
