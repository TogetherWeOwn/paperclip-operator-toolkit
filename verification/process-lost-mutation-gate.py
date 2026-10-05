#!/usr/bin/env python3
"""Attributable mutation kills only: never startup errors or stale pyc.

Mirrors verification/auth-denial-mutation-gate.py. Every mutant starts in a
fresh temporary directory with a green baseline first. Only named assertion
failures count; missing tests, skips, errors, timeouts, non-parsing mutants
and test-loader failures refuse. The checkout is never edited.

TestResult separates assertion failures from unexpected errors:
https://docs.python.org/3/library/unittest.html#unittest.TestResult
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = "process_lost_probe.py"
SUITE = "test_process_lost_probe.py"

# Each mutant names the shortcut it stands for and the assertions that kill
# it. The first three reproduce the hand-killed contract; the rest protect
# the dateless-rows and exit-code boundaries.
MUTANTS = [
    ("message-classifier",
     'return run.get("errorCode") == PROCESS_LOST_CODE',
     'return CANONICAL_MESSAGE_SIG in error_text(run)',
     ['ErrorCodeIsTheClassifier.'
      'test_canonical_message_without_code_is_not_process_lost',
      'ErrorCodeIsTheClassifier.test_message_alone_produces_no_burst']),
    ("never-split-bursts",
     'if bursts and stamp - observed_at(bursts[-1][-1]) < gap:',
     'if bursts:',
     ['BurstGrouping.test_crashes_a_day_apart_are_separate_bursts',
      'BurstGrouping.test_gap_boundary_is_exclusive_at_the_threshold']),
    ("dateless-silently-passes",
     'dateless_lost = [r for r in runs\n'
     '                     if observed_at(r) is None and is_process_lost(r)]',
     'dateless_lost = []',
     ['TimestampsAreLoadBearing.'
      'test_dateless_rows_are_insufficient_not_silent',
      'TimestampsAreLoadBearing.test_unparseable_stamp_is_insufficient']),
    ("cause-attribution",
     '"canonical_message_rows": sum(',
     '"cause": "server-crash",\n            "canonical_message_rows": sum(',
     ['RowsNeverProveCause.test_no_cause_field_leaks_into_describe',
      'RowsNeverProveCause.test_no_cause_key_in_describe']),
]

WORKER = '''
import io, json, sys, unittest
import test_process_lost_probe as tests
loader = unittest.TestLoader()
suite = (loader.loadTestsFromNames(sys.argv[1:]) if sys.argv[1:]
         else loader.loadTestsFromModule(tests))
result = unittest.TextTestRunner(stream=io.StringIO()).run(suite)
print(json.dumps({
    "success": result.wasSuccessful(), "run": result.testsRun,
    "failures": [t.id() for t, _ in result.failures],
    "errors": [t.id() for t, _ in result.errors],
    "skipped": len(result.skipped), "loader_errors": loader.errors,
    "expected_failures": len(result.expectedFailures),
    "unexpected_successes": len(result.unexpectedSuccesses),
}))
'''


def run_suite(directory, names=()):
    proc = subprocess.run(
        [sys.executable, "-B", "-c", WORKER, *names], cwd=directory,
        env={"PATH": os.environ.get("PATH", "")},
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError("test worker failed before producing a result")
    result = json.loads(proc.stdout)
    if (not result["run"] or result["errors"] or result["skipped"]
            or result["loader_errors"] or result["expected_failures"]
            or result["unexpected_successes"]):
        raise RuntimeError(f"unattributable test result: {result}")
    return result


def stage(directory, source):
    (directory / TARGET).write_text(source)
    shutil.copyfile(ROOT / SUITE, directory / SUITE)


def main():
    source = (ROOT / TARGET).read_text()
    with tempfile.TemporaryDirectory(prefix="process-lost-baseline-") as tmp:
        stage(Path(tmp), source)
        baseline = run_suite(tmp)
        if not baseline["success"]:
            raise RuntimeError(f"baseline failed: {baseline}")
    print(f"BASELINE: {baseline['run']} passed")
    for label, old, new, expected in MUTANTS:
        if source.count(old) != 1:
            raise RuntimeError(f"{label}: mutation anchor missing or ambiguous")
        mutated = source.replace(old, new)
        compile(mutated, TARGET, "exec")
        required = {"test_process_lost_probe." + name for name in expected}
        with tempfile.TemporaryDirectory(prefix=f"process-lost-{label}-") as tmp:
            stage(Path(tmp), source)
            control = run_suite(tmp, sorted(required))
            if not control["success"] or control["run"] != len(required):
                raise RuntimeError(f"{label}: named baseline failed: {control}")
            (Path(tmp) / TARGET).write_text(mutated)
            result = run_suite(tmp, sorted(required))
        if result["run"] != control["run"]:
            raise RuntimeError(f"{label}: test population changed")
        failures = set(result["failures"])
        if not required <= failures or result["success"]:
            raise RuntimeError(f"{label}: missing named assertion kills: "
                               f"{sorted(required - failures)}; {result}")
        print(f"KILLED {label}: {len(failures)} assertion failures; "
              + ", ".join(expected))
    print(f"PASS: {len(MUTANTS)} mutants killed")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, SyntaxError,
            subprocess.TimeoutExpired) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
