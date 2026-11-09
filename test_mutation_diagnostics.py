#!/usr/bin/env python3
"""Exercise the actual workflow functions with deterministic offline results."""

import hashlib
import importlib.util
import json
import os
import select
import shutil
import signal
import sys
import time
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent
WORKFLOW = ROOT / ".github/workflows/ci.yml"
OWNER = "test_responsible_leader.sh"
SIBLING = "test_request_record_integrity.sh"


class MutationDiagnostics(unittest.TestCase):
    def run_gate(self, *, expected="no", owner=1, sibling=0, baseline=0, owner_baseline=0,
                 assertion="", large_baseline=False):
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
                if not mutated and os.environ['LARGE_BASELINE'] == 'yes':
                    print('FAIL ' + 'b' * 400000)
                    print('RESULT ' + 'e' * 400000, file=sys.stderr)
                assertion = os.environ['ASSERTION']
                sentinel = os.environ.get('TEST_LEADER_NOTIFY_ASSERTION_SENTINEL')
                if sentinel:
                    text = ''
                    if not mutated and assertion != 'missing-baseline':
                        text = 'transport-ignore-term-courier-gone\\n'
                    elif mutated and assertion == 'passing-mutant':
                        text = 'transport-ignore-term-courier-gone\\n'
                    elif mutated and assertion != 'unarmed-mutant':
                        text = 'transport-ignore-term-assertion-armed\\n'
                    pathlib.Path(sentinel).write_text(text)
                    if mutated and assertion in ('cleaned-mutant', 'wrong-exit'):
                        print('MUTATION_WATCHDOG: watched descendant terminated')
                if sentinel and not mutated and assertion == 'baseline-failed':
                    sys.exit(7)
                key = role + ('_RC' if mutated else '_BASELINE_RC')
                sys.exit(int(os.environ.get(key, '0')))
            '''))
            script = functions + textwrap.dedent('''\
                stage() { cp -a "$SOURCE/." "$1/"; }
                mutation_check "$LABEL" test_responsible_leader.sh "$EXPECTED" \
                  's/^  may_request "$now_tpl"/  true "$now_tpl"/'
            ''')
            result = subprocess.run(
                ["bash", "-u", "-o", "pipefail", "-c", script], cwd=source,
                env={**os.environ, "SOURCE": str(source), "RUNNER_TEMP": temp,
                     "EXPECTED": expected, "OWNER_RC": str(owner),
                     "SIBLING_RC": str(sibling), "SIBLING_BASELINE_RC": str(baseline),
                     "OWNER_BASELINE_RC": str(owner_baseline),
                     "LABEL": "transport-can-ignore-timeout-term" if assertion else "banked-stale-authority",
                     "ASSERTION": assertion, "LARGE_BASELINE": "yes" if large_baseline else "no",
                     "TMPDIR": temp, "BASH_ENV": "/dev/null"},
                capture_output=True, text=True, timeout=15,
            )
            saved = {p.name: p.read_text() for p in (root / "mutation-diagnostics").glob("*.log")}
            self.assertFalse(list(root.rglob("mutant.*")), "mutant cleanup changed")
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

    def test_large_failing_baseline_bounds_both_console_streams(self):
        result, saved = self.run_gate(owner_baseline=7, large_baseline=True)
        self.assertEqual(result.returncode, 1)
        self.assertLess(len(result.stdout), 18000)
        self.assertLess(len(result.stderr), 1000)
        transcript = saved["banked-stale-authority-owner-baseline.log"]
        self.assertIn("FAIL " + "b" * 400000, transcript)
        self.assertIn("RESULT " + "e" * 400000, transcript)

    def test_exceptional_assertion_exits_retain_available_transcripts(self):
        label = "transport-can-ignore-timeout-term"
        for outcome in ("baseline-failed", "missing-baseline", "passing-mutant", "zero-exit",
                        "unarmed-mutant", "uncleaned-mutant", "wrong-exit"):
            with self.subTest(outcome=outcome):
                baseline = 0
                owner = {"zero-exit": 0, "wrong-exit": 1}.get(outcome, 124)
                result, saved = self.run_gate(
                    expected="skip", owner=owner, owner_baseline=baseline, assertion=outcome)
                self.assertEqual(result.returncode, 1)
                self.assertLess(len(result.stdout), 34000)
                self.assertLess(len(result.stderr), 1000)
                phases = ["assertion-baseline"]
                if outcome not in ("baseline-failed", "missing-baseline"):
                    phases.append("owner")
                self.assertEqual(set(saved), {f"{label}-{phase}.log" for phase in phases})
                for phase in phases:
                    transcript = saved[f"{label}-{phase}.log"]
                    kind = "mutant" if phase == "owner" else "baseline"
                    self.assertIn(f"OWNER-{kind}-stdout", transcript)
                    self.assertIn(f"OWNER-{kind}-stderr", transcript)
                    self.assertIn("x" * 20000, transcript)

    def test_attributable_assertion_timeout_stays_green(self):
        result, saved = self.run_gate(expected="skip", owner=124, assertion="cleaned-mutant")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(saved)


class ConcurrentSubmissionDiagnostics(unittest.TestCase):
    def run_concurrency(self, *, distinct=False, permissive_mkdir=False, rejected_tracer=False,
                        stalled=False):
        source = (ROOT / SIBLING).read_text()
        start = source.index('reset\n# Opt-in Actions diagnostics')
        end = source.index('\n# The locks serialize', start)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scratch = root / "scratch"
            scratch.mkdir()
            queue = scratch / "queue.sh"
            # Deterministically reproduce the observed shape, not its unknown
            # cause: two successful children but only one retained REQ-001.
            queue.write_text(textwrap.dedent('''\
                #!/usr/bin/env bash
                [[ -z "${TRACE_SECRET_CANARY:-}" ]] || exit 90
                [[ "$BASH_ENV" == */test/request_record_provenance.sh ]] || exit 92
                [[ -f "$ORG_SNAPSHOT" && -x "$PROV" ]] || exit 91
                QUEUE_LOCK="${QUEUE}.lock"
                REQRECORD_STATUS_LOCK="${QUEUE}.notify-status.lock"
                mkdir "$QUEUE_LOCK"; first=$?
                mkdir "$QUEUE_LOCK"; second=$?
                mkdir "$REQRECORD_STATUS_LOCK"
                if mkdir "$REQRECORD_STATUS_LOCK"; then :; fi
                printf 'fixture-status:%s/%s\\n' "$first" "$second"
                printf '%s\\n' '{"event":"request.submitted","requestId":"REQ-001"}' > "$QUEUE"
                printf 'fixture-child-stdout\\n'
                printf 'fixture-child-stderr\\n' >&2
            '''))
            if distinct:
                queue.write_text(queue.read_text().replace(
                    "printf '%s\\n' '{\"event\":\"request.submitted\",\"requestId\":\"REQ-001\"}' > \"$QUEUE\"",
                    "printf '{\"event\":\"request.submitted\",\"requestId\":\"REQ-%s\"}\\n' \"$BASHPID\" >> \"$QUEUE\"",
                ))
            if stalled:
                queue.write_text(textwrap.dedent('''\
                    #!/usr/bin/env bash
                    QUEUE_LOCK="${QUEUE}.lock"
                    mkdir "$QUEUE_LOCK"
                    printf 'fixture-child-stdout\\n'
                    printf 'fixture-child-stderr\\n' >&2
                    printf 'ready\\n' > "$HOME/stall-ready"
                    IFS= read -r release < "$HOME/stall-release"
                '''))
            queue.chmod(0o700)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            if permissive_mkdir:
                shim = fake_bin / "mkdir"
                # The parent deliberately poisons BASH_ENV. Keep the PATH fake
                # usable for harness setup as well as the isolated child.
                shim.write_text('#!/bin/sh\nexec /usr/bin/mkdir -p "$@"\n')
                shim.chmod(0o700)
            if rejected_tracer or stalled:
                tracer = fake_bin / "strace"
                tracer.write_text('#!/bin/bash\nprintf "fixture-probe-denied\\n" >&2\nexit 73\n')
                tracer.chmod(0o700)
            (scratch / "org.tsv").touch()
            (scratch / "startup.sh").write_text("exit 92\n")
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
            command = ["bash", "-u", "-o", "pipefail", "-c", script]
            environment = {**os.environ, "CASE_ROOT": str(scratch), "HERE": str(ROOT),
                     "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
                     "BASH_ENV": "/dev/null", "REQUEST_RECORD_DIAGNOSTICS_DIR": str(saved_dir),
                     "TRACE_SECRET_CANARY": "must-not-reach-child-trace"}
            if stalled:
                os.mkfifo(scratch / "stall-ready")
                os.mkfifo(scratch / "stall-release")
                ready_fd = os.open(scratch / "stall-ready", os.O_RDWR | os.O_NONBLOCK)
                # Both children must emit evidence and reach the stall before
                # termination. No real queue race, resubmission or sleep.
                command[-1] = "trap 'rm -rf \"$CASE_ROOT\"' EXIT; trap 'exit 143' TERM\n" + script
                with subprocess.Popen(command, env=environment, start_new_session=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as child:
                    try:
                        ready = b""
                        deadline = time.monotonic() + 10
                        while ready.count(b"ready\n") < 2:
                            remaining = deadline - time.monotonic()
                            self.assertGreater(remaining, 0, "both children must reach the stall")
                            self.assertTrue(select.select([ready_fd], [], [], remaining)[0])
                            ready += os.read(ready_fd, 4096)
                    finally:
                        os.close(ready_fd)
                        os.killpg(child.pid, signal.SIGTERM)
                        try:
                            stdout, stderr = child.communicate(timeout=5)
                        except subprocess.TimeoutExpired:
                            os.killpg(child.pid, signal.SIGKILL)
                            stdout, stderr = child.communicate(timeout=5)
                            self.fail("stalled run ignored SIGTERM")
                    result = subprocess.CompletedProcess(command, child.returncode, stdout, stderr)
                self.assertFalse(scratch.exists(), "disposable evidence must be cleaned")
            else:
                result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=15)
            self.assertTrue(saved_dir.is_dir(), result.stdout + result.stderr)
            saved = {p.name: p.read_text() for p in saved_dir.iterdir()}
        return result, saved

    def test_stalled_cleanup_escalates_before_context_exit(self):
        with mock.patch.object(subprocess, "Popen") as popen, \
                mock.patch.object(os, "killpg") as killpg, \
                mock.patch.object(select, "select", return_value=([1], [], [])), \
                mock.patch.object(os, "read", return_value=b"ready\nready\n"):
            child = popen.return_value.__enter__.return_value
            child.pid = 12345
            child.communicate.side_effect = [
                subprocess.TimeoutExpired("fixture", 5), ("", "")]
            with self.assertRaisesRegex(AssertionError, "stalled run ignored SIGTERM"):
                self.run_concurrency(stalled=True)
            self.assertEqual(killpg.call_args_list, [
                mock.call(child.pid, signal.SIGTERM), mock.call(child.pid, signal.SIGKILL)])
            self.assertEqual(child.communicate.call_args_list, [
                mock.call(timeout=5), mock.call(timeout=5)])

    def test_interrupted_wait_retains_already_produced_child_evidence(self):
        result, saved = self.run_concurrency(stalled=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("result.txt", saved)
        self.assertNotIn("lock-controls.out", saved)
        for label in ("submit-one", "submit-two"):
            self.assertIn("fixture-child-stdout", saved[f"{label}.out"])
            self.assertIn("fixture-child-stderr", saved[f"{label}.out"])
            self.assertTrue(saved[f"{label}.trace"])
            self.assertIn('"phase": "before"', saved[f"{label}.provenance"])
            self.assertIn("syscall_tracer=unavailable", saved[f"{label}.syscalls"])

    def test_failed_concurrency_retains_isolated_traces(self):
        result, saved = self.run_concurrency()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        expected = {f"{label}.{suffix}" for label in ("submit-one", "submit-two", "lock-controls")
                    for suffix in ("trace", "provenance", "syscalls", "out")}
        expected |= {"queue.snapshot", "result.txt", "tracer-probe.out", "control-one.out", "control-two.out"}
        self.assertTrue(expected <= set(saved))
        self.assertFalse(set(saved) - expected - {"tracer-probe.syscalls"})
        self.assertEqual(saved["result.txt"],
                         "first_rc=0\nsecond_rc=0\nsubmitted=1\ndistinct=1\ncontrols_rc=0\n")
        for label in ("submit-one", "submit-two"):
            self.assertTrue(saved[f"{label}.trace"])
            self.assertIn("fixture-child-stdout", saved[f"{label}.out"])
            self.assertIn("fixture-child-stderr", saved[f"{label}.out"])
            records = [json.loads(line) for line in saved[f"{label}.provenance"].splitlines()
                       if line.startswith("{")]
            self.assertTrue(any(r["phase"] == "before" for r in records))
            self.assertTrue(any(r["phase"] == "after-boundary" and r["next_boundary_status"] != 0
                                for r in records))
            # The failed `if mkdir` has a zero status at the next boundary. Do
            # not mislabel it the mkdir result; only syscall evidence is that.
            self.assertTrue(any(r["phase"] == "after-boundary" and r["next_boundary_status"] == 0
                                and "REQRECORD_STATUS_LOCK" in r["command"] for r in records))
            self.assertTrue(all("previous_status" not in r for r in records))
            self.assertTrue(any("inode" in r["locks"][1] and
                                r["locks"][1]["path"].endswith(".notify-status.lock") for r in records))
            self.assertTrue(all("inode" in r["parent"] and r["mount_namespace"] for r in records))
        controls = dict(line.split("=", 1) for line in saved["lock-controls.out"].splitlines()
                        if "=" in line and line.split("=", 1)[0].endswith("_rc"))
        self.assertEqual(controls["resolved_first_rc"], "0")
        self.assertNotEqual(controls["resolved_second_rc"], "0")
        self.assertEqual(sum(controls[k] == "0" for k in ("contention_one_rc", "contention_two_rc")), 1)
        self.assertNotIn("must-not-reach-child-trace", "".join(saved.values()))
        self.assertNotIn("startup.sh", "".join(saved.values()))
        loser = "one" if controls["contention_one_rc"] != "0" else "two"
        self.assertTrue(saved[f"control-{loser}.out"])

    def test_unusable_tracer_does_not_replace_original_submissions(self):
        result, saved = self.run_concurrency(distinct=True, rejected_tracer=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("first_rc=0\nsecond_rc=0\nsubmitted=2\ndistinct=2\ncontrols_rc=0\n", saved["result.txt"])
        self.assertIn("fixture-probe-denied", saved["tracer-probe.out"])
        self.assertIn("probe_rc=73", saved["tracer-probe.out"])
        for label in ("submit-one", "submit-two", "lock-controls"):
            self.assertEqual(saved[f"{label}.syscalls"], "syscall_tracer=unavailable\nprobe_rc=73\n")
        self.assertIn("fixture-child-stdout", saved["submit-one.out"])

    def test_passing_experiment_still_retains_evidence(self):
        result, saved = self.run_concurrency(distinct=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("submitted=2\ndistinct=2\ncontrols_rc=0\n", saved["result.txt"])
        self.assertTrue(saved["submit-one.provenance"])
        self.assertTrue(saved["submit-two.syscalls"])

    def test_permissive_command_is_discriminated_without_product_change(self):
        result, saved = self.run_concurrency(distinct=True, permissive_mkdir=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("submitted=2\ndistinct=2\ncontrols_rc=1\n", saved["result.txt"])
        self.assertIn("resolved_second_rc=0\n", saved["lock-controls.out"])
        self.assertIn("native_second_rc=1\n", saved["lock-controls.out"])
        self.assertIn("/bin/mkdir", saved["submit-one.provenance"])
        self.assertIn('"shebang":', saved["submit-one.provenance"])


class ExecutableIdentityDiagnostics(unittest.TestCase):
    def test_replaced_and_unlinked_executable_uses_proc_handle(self):
        spec = importlib.util.spec_from_file_location(
            "request_record_provenance", ROOT / "test/request_record_provenance.py")
        observer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(observer)
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / "disposable-python"
            shutil.copyfile(sys.executable, image)
            image.chmod(0o700)
            expected_hash = hashlib.sha256(image.read_bytes()).hexdigest()
            expected_stat = image.stat()
            with subprocess.Popen(
                [str(image), "-I", "-c", "import sys; print('ready', flush=True); sys.stdin.read()"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            ) as child:
                try:
                    self.assertTrue(select.select([child.stdout], [], [], 5)[0], "image startup timed out")
                    self.assertEqual(child.stdout.readline(), b"ready\n")
                    replacement = Path(temp) / "replacement"
                    shutil.copyfile("/usr/bin/true", replacement)
                    replacement.replace(image)
                    for state in ("replaced", "unlinked", "canonical-loop"):
                        if state == "unlinked":
                            image.unlink()
                        elif state == "canonical-loop":
                            link = Path(str(image) + " (deleted)")
                            link.symlink_to(link.name)
                        with self.subTest(state=state):
                            record = observer.identity(f"/proc/{child.pid}/exe", executable=True)
                            self.assertNotIn("error", record)
                            self.assertEqual(record["sha256"], expected_hash)
                            self.assertEqual(record["inode"], expected_stat.st_ino)
                            self.assertEqual(record["device"], expected_stat.st_dev)
                            self.assertEqual(record["format"], "ELF")
                            self.assertEqual(record["symlink_target"], str(image) + " (deleted)")
                            if state == "canonical-loop":
                                # Non-strict resolve can return the loop path or
                                # raise, depending on Python. Force the error
                                # branch without relying on that version detail.
                                with mock.patch.object(observer.Path, "resolve", side_effect=RuntimeError(
                                    "fixture canonical loop"
                                )):
                                    failed_metadata = observer.identity(
                                        f"/proc/{child.pid}/exe", executable=True)
                                self.assertIn("canonical_error", failed_metadata)
                                self.assertNotIn("error", failed_metadata)
                                for key in ("sha256", "inode", "device", "format", "symlink_target"):
                                    self.assertEqual(failed_metadata[key], record[key])
                    # Ordinary paths must still detect changed bytes; no hash cache.
                    shutil.copyfile("/usr/bin/true", image)
                    self.assertNotEqual(observer.identity(image, executable=True)["sha256"], expected_hash)
                finally:
                    child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0)


if __name__ == "__main__":
    unittest.main()
