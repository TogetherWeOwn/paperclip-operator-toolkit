#!/usr/bin/env python3
"""Exercise the actual workflow functions with deterministic offline results."""

import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parent
WORKFLOW = ROOT / ".github/workflows/ci.yml"
OWNER = "test_responsible_leader.sh"
SIBLING = "test_request_record_integrity.sh"


class MutationDiagnostics(unittest.TestCase):
    def run_gate(self, *, expected="no", owner=1, sibling=0, baseline=0):
        workflow = WORKFLOW.read_text()
        start = workflow.index("          mutation_suite() {")
        end = workflow.index("\n          rc=0", start)
        functions = textwrap.dedent(workflow[start:end])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            (source / "lib").mkdir()
            (source / "org_request_queue.sh").write_text('  may_request "$now_tpl"\n')
            (source / "lib/reqrecord.sh").write_text(":\n")
            (source / "lib/notify_exec.py").write_text("pass\n")
            # The watchdog seam emits both streams, plus enough output to prove
            # the console is bounded without truncating the retained transcript.
            (source / "lib/mutation_watchdog.py").write_text(textwrap.dedent('''\
                import os, pathlib, sys
                mutated = 'true' in pathlib.Path(sys.argv[1], 'org_request_queue.sh').read_text()
                role = 'OWNER' if sys.argv[2] == 'test_responsible_leader.sh' else 'SIBLING'
                phase = 'mutant' if mutated else 'baseline'
                print(role + '-' + phase + '-stdout')
                print('x' * 20000, flush=True)
                print(role + '-' + phase + '-stderr', file=sys.stderr)
                key = role + '_RC' if mutated else ('BASELINE_RC' if role == 'SIBLING' else '0')
                sys.exit(int(os.environ.get(key, '0')))
            '''))
            script = functions + textwrap.dedent('''\
                stage() { cp -a "$SOURCE/." "$1/"; }
                mutation_check banked-stale-authority test_responsible_leader.sh "$EXPECTED" \
                  's/^  may_request "$now_tpl"/  true "$now_tpl"/'
            ''')
            result = subprocess.run(
                ["bash", "-u", "-o", "pipefail", "-c", script], cwd=source,
                env={**os.environ, "SOURCE": str(source), "RUNNER_TEMP": temp,
                     "EXPECTED": expected, "OWNER_RC": str(owner),
                     "SIBLING_RC": str(sibling), "BASELINE_RC": str(baseline),
                     "BASH_ENV": "/dev/null"},
                capture_output=True, text=True, timeout=15,
            )
            saved = {p.name: p.read_text() for p in (root / "mutation-diagnostics").glob("*.log")}
        return result, saved

    def test_expected_independence_stays_green(self):
        result, saved = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(saved)

    def test_unexpected_sibling_preserves_both_transcripts(self):
        result, saved = self.run_gate(sibling=1)
        self.assertEqual(result.returncode, 1)
        for phase, role in (("owner", "OWNER"), ("sibling", "SIBLING")):
            transcript = saved[f"banked-stale-authority-{phase}.log"]
            self.assertIn(f"{role}-mutant-stdout", transcript)
            self.assertIn(f"{role}-mutant-stderr", transcript)
            self.assertIn("x" * 20000, transcript)
        self.assertIn("expected detection=no", result.stdout)
        self.assertLess(len(result.stdout), 34000)
        self.assertIn("SIBLING-mutant-stderr", result.stdout)

    def test_baseline_failure_is_not_mutant_detection(self):
        result, saved = self.run_gate(baseline=7)
        self.assertEqual(result.returncode, 1)
        self.assertIn("no mutation attribution", result.stdout)
        self.assertIn("rc=7", result.stdout)
        self.assertIn("SIBLING-baseline-stderr", saved["banked-stale-authority-sibling-baseline.log"])
        self.assertNotIn("OWNER-mutant", result.stdout)

    def test_unexpected_owner_pass_is_preserved(self):
        result, saved = self.run_gate(owner=0)
        self.assertEqual(result.returncode, 1)
        self.assertIn("OWNER-mutant-stderr", saved["banked-stale-authority-owner.log"])

    def test_yes_expectation_still_requires_detection(self):
        result, saved = self.run_gate(expected="yes", sibling=0)
        self.assertEqual(result.returncode, 1)
        self.assertIn("expected detection=yes", result.stdout)
        self.assertEqual(len(saved), 2)
        result, saved = self.run_gate(expected="yes", sibling=1)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(saved)

    def test_sibling_deadlines_are_not_detection(self):
        for code in (124, 137):
            with self.subTest(code=code):
                result, saved = self.run_gate(expected="yes", sibling=code)
                self.assertEqual(result.returncode, 1)
                self.assertIn("OUTER deadline", result.stdout)
                self.assertIn(f"rc={code}", result.stdout)
                self.assertEqual(len(saved), 2)


if __name__ == "__main__":
    unittest.main()
