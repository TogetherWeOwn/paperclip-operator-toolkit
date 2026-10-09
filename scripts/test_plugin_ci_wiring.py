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
        for name in ("model-selection-impact", "cliproxy-insight-suite"):
            with self.subTest(job=name):
                block = job(self.text, name)
                self.assertIn("needs: [changes]", block)
                self.assertIn("if: needs.changes.outputs.heavy == 'true'", block)
                self.assertIn("runs-on: ubuntu-latest", block)

    def test_scans_are_always_on(self):
        # Neither scan may sit behind the change gate: docs-only changes and
        # draft PRs must still be scanned. Not a prefix match: any `needs:` or
        # `if:` key at job level, in any spelling, is a re-gate.
        for name in ("secret-scan", "disclosure-scan"):
            with self.subTest(job=name):
                block = job(self.text, name)
                header = block.split("    steps:\n", 1)[0]
                self.assertNotRegex(header, r"(?m)^    needs:")
                self.assertNotRegex(header, r"(?m)^    if:")
                self.assertNotIn("outputs.heavy", block)
                self.assertIn("runs-on: ubuntu-latest", block)

    def test_disclosure_scan_covers_the_complete_tracked_tree(self):
        block = job(self.text, "disclosure-scan")
        self.assertIn("run: bash scripts/disclosure-scan.sh .\n", block)
        self.assertNotIn("disclosure-scan.sh plugins", block)

    def test_secret_scan_keeps_pinned_scanner_controls_and_full_history(self):
        block = job(self.text, "secret-scan")
        self.assertIn("fetch-depth: 0", block)
        self.assertRegex(block, r"GITLEAKS_SHA256: '[0-9a-f]{64}'")
        self.assertIn("sha256sum -c -", block)
        self.assertIn("python3 scripts/test_secret_scan.py", block)
        self.assertIn("bash scripts/secret-scan.sh", block)
        # Controls run before the real scan so a broken scanner cannot read clean.
        self.assertLess(block.index("test_secret_scan.py"), block.index("bash scripts/secret-scan.sh"))

    def run_ci_ok(self, results):
        """Render the aggregator's expressions from fixture job results and run it."""
        block = job(self.text, "ci-ok")
        script = textwrap.dedent(block.split("        run: |\n", 1)[1])
        script = re.sub(r"\$\{\{ needs\.([a-z-]+)\.result \}\}", lambda m: results[m.group(1)], script)
        for state in ("failure", "cancelled"):
            flag = "true" if state in results.values() else "false"
            script = script.replace("${{ contains(needs.*.result, '%s') }}" % state, flag)
        self.assertNotIn("${{", script)
        return subprocess.run(["/bin/bash", "-c", script], env={"PATH": "/usr/bin:/bin"},
                              capture_output=True, text=True)

    def test_ci_ok_refuses_a_skipped_or_failed_scan(self):
        everything = ("changes", "privilege-suites", "offline-suites", "long-mutation-gates",
                      "runbook-gates", "broker-suite", "omniroute-broker-suite", "dispatch-suite",
                      "mcp-suite", "cliproxy-insight-suite", "disclosure-scan", "secret-scan",
                      "model-selection-impact", "model-selection-mutants", "model-selection-suite")
        gated = {n: "skipped" for n in everything}
        gated.update({"changes": "success", "disclosure-scan": "success", "secret-scan": "success"})
        self.assertEqual(self.run_ci_ok(gated).returncode, 0, "docs/draft skip with both scans green must pass")
        for scan in ("secret-scan", "disclosure-scan"):
            for bad in ("skipped", "failure", "cancelled"):
                with self.subTest(scan=scan, result=bad):
                    results = dict(gated, **{scan: bad})
                    result = self.run_ci_ok(results)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(scan, result.stdout + result.stderr)

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

    def test_preflight_baseline_failure_is_reported_not_swallowed(self):
        # The default step shell is `bash -e`: a bare baseline call exits with the
        # suite's status before the diagnostic prints, which is how a red step
        # once carried no output at all.
        block = job(self.text, "long-mutation-gates")
        self.assertIn('preflight_suite "$baseline" || base_rc=$?', block)
        self.assertIn("the UNMUTATED preflight copy fails", block)

    def test_explicit_manual_full_run_is_declared(self):
        trigger = self.text.split("on:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertTrue("  workflow_dispatch:" in trigger, "explicit manual full-run trigger is missing")

    def test_matrix_and_full_event_paths_survive_merge(self):
        block = job(self.text, "model-selection-mutants")
        self.assertIn("needs: model-selection-impact", block)
        self.assertIn("needs.model-selection-impact.outputs.impacted == 'true'", block)
        self.assertIn("shard: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]", block)
        self.assertIn("fail-fast: false", block)
        self.assertIn("run: npm run test:mutants", block)
        self.assertIn('if [ "$EVENT" != "pull_request" ]; then', job(self.text, "changes"))
        self.assertNotIn("<<<<<<<", self.text)
        self.assertNotIn(">>>>>>>", self.text)


if __name__ == "__main__":
    unittest.main()
