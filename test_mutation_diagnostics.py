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
    def run_gate(self, *, expected="no", owner=1, sibling=0, baseline=0, owner_baseline=0):
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
                key = role + ('_RC' if mutated else '_BASELINE_RC')
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
                     "SIBLING_RC": str(sibling), "SIBLING_BASELINE_RC": str(baseline),
                     "OWNER_BASELINE_RC": str(owner_baseline),
                     "BASH_ENV": "/dev/null"},
                capture_output=True, text=True, timeout=15,
            )
            saved = {p.name: p.read_text() for p in (root / "mutation-diagnostics").glob("*.log")}
        return result, saved

    def test_expected_independence_stays_green(self):
        result, saved = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(saved)

    def assert_diagnostic(self, result, saved, phase, role, code):
        suite = OWNER if role == "OWNER" else SIBLING
        self.assertIn(
            f"::group::banked-stale-authority {phase}: {suite} (rc={code})\n",
            result.stdout,
        )
        transcript = saved[f"banked-stale-authority-{phase}.log"]
        stream_phase = "baseline" if phase.endswith("baseline") else "mutant"
        self.assertIn(f"{role}-{stream_phase}-stdout", transcript)
        self.assertIn(f"{role}-{stream_phase}-stderr", transcript)
        self.assertIn("x" * 20000, transcript)

    def test_unexpected_sibling_preserves_both_transcripts(self):
        result, saved = self.run_gate(sibling=1)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(set(saved), {"banked-stale-authority-owner.log",
                                      "banked-stale-authority-sibling.log"})
        self.assert_diagnostic(result, saved, "owner", "OWNER", 1)
        self.assert_diagnostic(result, saved, "sibling", "SIBLING", 1)
        self.assertLess(len(result.stdout), 34000)
        self.assertIn("SIBLING-mutant-stderr", result.stdout)

    def test_baseline_failure_is_not_mutant_detection(self):
        result, saved = self.run_gate(baseline=7)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(set(saved), {"banked-stale-authority-sibling-baseline.log"})
        self.assert_diagnostic(result, saved, "sibling-baseline", "SIBLING", 7)
        self.assertNotIn("OWNER-mutant", result.stdout)

    def test_owner_baseline_failure_is_preserved(self):
        result, saved = self.run_gate(owner_baseline=7)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(set(saved), {"banked-stale-authority-owner-baseline.log"})
        self.assert_diagnostic(result, saved, "owner-baseline", "OWNER", 7)
        self.assertNotIn("OWNER-mutant", result.stdout)
        self.assertNotIn("SIBLING-", result.stdout)

    def test_unexpected_owner_pass_is_preserved(self):
        result, saved = self.run_gate(owner=0)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(set(saved), {"banked-stale-authority-owner.log"})
        self.assert_diagnostic(result, saved, "owner", "OWNER", 0)

    def test_yes_expectation_still_requires_detection(self):
        result, saved = self.run_gate(expected="yes", sibling=0)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(set(saved), {"banked-stale-authority-owner.log",
                                      "banked-stale-authority-sibling.log"})
        self.assert_diagnostic(result, saved, "owner", "OWNER", 1)
        self.assert_diagnostic(result, saved, "sibling", "SIBLING", 0)
        result, saved = self.run_gate(expected="yes", sibling=1)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(saved)

    def test_sibling_deadlines_are_not_detection(self):
        for code in (124, 137):
            with self.subTest(code=code):
                result, saved = self.run_gate(expected="yes", sibling=code)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(set(saved), {"banked-stale-authority-owner.log",
                                              "banked-stale-authority-sibling.log"})
                self.assert_diagnostic(result, saved, "owner", "OWNER", 1)
                self.assert_diagnostic(result, saved, "sibling", "SIBLING", code)


class ConcurrentSubmissionDiagnostics(unittest.TestCase):
    def test_failed_concurrency_retains_isolated_traces(self):
        source = (ROOT / SIBLING).read_text()
        start = source.index('reset\n# Opt-in Actions diagnostics')
        end = source.index('\n# The locks serialize', start)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queue = root / "queue.sh"
            # Deterministically reproduce the observed shape, not its unknown
            # cause: two successful children but only one retained REQ-001.
            queue.write_text(textwrap.dedent('''\
                #!/usr/bin/env bash
                [[ -z "${TRACE_SECRET_CANARY:-}" && -z "${BASH_ENV:-}" ]] || exit 90
                [[ -f "$ORG_SNAPSHOT" && -x "$PROV" ]] || exit 91
                printf '%s\\n' '{"event":"request.submitted","requestId":"REQ-001"}' > "$QUEUE"
                printf 'fixture-child-stdout\\n'
                printf 'fixture-child-stderr\\n' >&2
            '''))
            queue.chmod(0o700)
            (root / "org.tsv").touch()
            (root / "startup.sh").write_text("exit 92\n")
            script = textwrap.dedent('''\
                TMP="$CASE_ROOT"
                Q="$TMP/queue.sh"
                QUEUE="$TMP/queue.jsonl"
                GRANT_LOG="$TMP/grants.jsonl"
                DISABLED_TEMPLATES="$TMP/disabled"
                ORG_SNAPSHOT="$TMP/org.tsv"
                PROV="$Q"
                CREATE_ARGV="$TMP/create.argv"
                COMPANY_ID=offline-fixture-not-a-real-company
                FAIL=0
                reset() { :; }
                ok() { :; }
                bad() { FAIL=$((FAIL+1)); }
                note() { :; }
                export BASH_ENV="$TMP/startup.sh"
            ''') + source[start:end] + '\nexit "$FAIL"\n'
            saved_dir = root / "diagnostics"
            result = subprocess.run(
                ["bash", "-u", "-o", "pipefail", "-c", script],
                env={**os.environ, "CASE_ROOT": temp, "BASH_ENV": "/dev/null",
                     "REQUEST_RECORD_DIAGNOSTICS_DIR": str(saved_dir),
                     "TRACE_SECRET_CANARY": "must-not-reach-child-trace"},
                capture_output=True, text=True, timeout=15,
            )
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            saved = {p.name: p.read_text() for p in saved_dir.iterdir()}
            self.assertEqual(set(saved), {"submit-one.trace", "submit-two.trace",
                                          "submit-one.out", "submit-two.out",
                                          "queue.snapshot", "result.txt"})
            self.assertEqual(saved["result.txt"],
                             "first_rc=0\nsecond_rc=0\nsubmitted=1\ndistinct=1\n")
            for label in ("submit-one", "submit-two"):
                self.assertTrue(saved[f"{label}.trace"])
                self.assertIn("fixture-child-stdout", saved[f"{label}.out"])
                self.assertIn("fixture-child-stderr", saved[f"{label}.out"])
            self.assertNotIn("must-not-reach-child-trace", "".join(saved.values()))


if __name__ == "__main__":
    unittest.main()
