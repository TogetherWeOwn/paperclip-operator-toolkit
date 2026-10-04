#!/usr/bin/env python3
"""Pin the merged plugin sweep to change gating and the single aggregator."""
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/ci.yml"


def job(text, name):
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  \S|\Z)", text, re.M | re.S)
    if not match:
        raise AssertionError(f"missing job: {name}")
    return match.group(1)


class PluginWiring(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()

    def test_changed_heavy_jobs_are_gated(self):
        for name in ("model-selection-impact", "cliproxy-insight-suite", "secret-scan"):
            with self.subTest(job=name):
                block = job(self.text, name)
                self.assertIn("needs: [changes]", block)
                self.assertIn("if: needs.changes.outputs.heavy == 'true'", block)
                self.assertIn("runs-on: ubuntu-latest", block)

    def test_plugin_aggregator_runs_after_failed_impacted_sweep(self):
        block = job(self.text, "model-selection-suite")
        self.assertIn("needs: [changes, model-selection-impact, model-selection-mutants]", block)
        self.assertIn("if: ${{ !cancelled() && needs.changes.outputs.heavy == 'true' }}", block)
        self.assertIn("success/true/success) ;;", block)
        self.assertIn("success/false/skipped) ;;", block)
        self.assertIn("exit 1", block)

    def test_single_aggregator_covers_all_plugin_checks_and_scans(self):
        block = job(self.text, "ci-ok")
        self.assertIn("if: ${{ !cancelled() }}", block)
        self.assertIn("needs.changes.result }}' != 'success'", block)
        self.assertIn("contains(needs.*.result, 'failure')", block)
        self.assertIn("contains(needs.*.result, 'cancelled')", block)
        for name in ("changes", "cliproxy-insight-suite", "disclosure-scan", "secret-scan",
                     "model-selection-impact", "model-selection-mutants", "model-selection-suite"):
            with self.subTest(job=name):
                self.assertIn(f"      - {name}\n", block)

    def test_draft_ci_and_dependency_changes_admit_full_suites(self):
        block = job(self.text, "changes")
        script = textwrap.dedent(block.split("        run: |\n", 1)[1])
        cases = [
            (".github/workflows/ci.yml", "true", "true"),
            ("plugins/model-selection/package-lock.json", "true", "true"),
            ("plugins/dispatch/package.json", "true", "true"),
            (".gitleaks.toml", "true", "true"),
            ("docs/unreferenced.md", "true", "false"),
            ("docs/unreferenced.md", "false", "false"),
            ("plugins/model-selection/src/worker.ts", "false", "true"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "git"
            executable.write_text('''#!/bin/bash
case "$1" in
  merge-base) printf '%s\\n' fixture-base ;;
  diff) printf '%s\\n' "$FILES" ;;
  grep) exit 1 ;;
  *) exit 2 ;;
esac
''')
            executable.chmod(0o755)
            for files, draft, expected in cases:
                with self.subTest(files=files, draft=draft):
                    output = root / "output"
                    output.write_text("")
                    # No inherited credentials or shell startup hooks.
                    env = {"PATH": f"{root}:/usr/bin:/bin", "EVENT": "pull_request",
                           "DRAFT": draft, "BASE_SHA": "base", "HEAD_SHA": "head",
                           "FILES": files, "GITHUB_OUTPUT": str(output)}
                    result = subprocess.run(["/bin/bash", "-c", script], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(output.read_text().strip(), "heavy=" + expected)

    def test_explicit_manual_full_run_is_declared(self):
        trigger = self.text.split("on:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertTrue("  workflow_dispatch:" in trigger, "explicit manual full-run trigger is missing")

    def test_matrix_and_full_event_paths_survive_merge(self):
        block = job(self.text, "model-selection-mutants")
        self.assertIn("needs: model-selection-impact", block)
        self.assertIn("needs.model-selection-impact.outputs.impacted == 'true'", block)
        self.assertIn("shard: [1, 2, 3, 4, 5, 6, 7, 8]", block)
        self.assertIn("fail-fast: false", block)
        self.assertIn("run: npm run test:mutants", block)
        self.assertIn('if [ "$EVENT" != "pull_request" ]; then', job(self.text, "changes"))
        self.assertNotIn("<<<<<<<", self.text)
        self.assertNotIn(">>>>>>>", self.text)


if __name__ == "__main__":
    unittest.main()
