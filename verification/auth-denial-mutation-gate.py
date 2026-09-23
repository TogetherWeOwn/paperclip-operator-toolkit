#!/usr/bin/env python3
"""TOG-4062: attributable mutation kills, never startup errors or stale pyc.

Every mutant starts in a fresh temporary directory with a green baseline first.
Only named assertion failures count; missing tests, skips, errors, timeouts,
non-parsing mutants and test-loader failures refuse. The checkout is never edited.

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
TARGET = "auth_denial_discriminator.py"
SUITE = "test_auth_denial_discriminator.py"
FIXTURE = "tests/auth-denial-incident-2026-09-22.json"

# Two independently named assertions per shortcut. The first six reproduce
# the original promised mutation contract; the rest protect corrected evidence
# boundaries and the two findings from the first independent review.
MUTANTS = [
    ("error-code-classifier",
     'return any(sig in text for sig in AUTH_DENIAL_SIGNATURES)',
     'return run.get("errorCode") == "adapter_failed"',
     ['ErrorCodeIsNotTheClassifier.test_worktree_abort_sharing_a_code_is_not_a_denial',
      'ErrorCodeIsNotTheClassifier.test_denial_under_transient_upstream_is_caught']),
    ("no-control-guard",
     'elif len(interior) >= min_control_runs:', 'elif True:',
     ['SilenceIsNotProof.test_blackout_without_enough_control_runs_is_insufficient',
      'SilenceIsNotProof.test_single_denial_can_never_discriminate']),
    ("padded-window",
     'and first < observed_at(r) < last', 'and True',
     ['TheWindowIsStrictlyInterior.test_flanking_successes_do_not_count_as_interleaving',
      'SilenceIsNotProof.test_single_denial_can_never_discriminate']),
    ("nonterminal-controls",
     'and r.get("status") in TERMINAL_STATUSES', 'and True',
     ['OnlyTerminalRunsAreEvidence.test_queued_and_running_are_not_control_runs',
      'OnlyTerminalRunsAreEvidence.test_cancelled_is_not_a_control_run']),
    ("never-split-bursts",
     'if bursts and stamp - observed_at(bursts[-1][-1]) < gap:', 'if bursts:',
     ['BurstGrouping.test_denials_separated_by_more_than_the_gap_are_separate_bursts',
      'BurstGrouping.test_gap_boundary_is_exclusive_at_the_threshold']),
    ("trust-wording",
     'if successes:\n        verdict = "INTERMITTENT"',
     'if any("disabled" in error_text(r) for r in burst):\n'
     '        verdict = "ENTITLEMENT"\n'
     '    elif successes:\n        verdict = "INTERMITTENT"',
     ['InterleavingOverridesWording.test_entitlement_wording_with_interleaved_successes_is_intermittent',
      'InterleavingOverridesWording.test_mixed_wording_same_agent_success_is_intermittent']),
    ("ignore-model-identity",
     'if model is None or recorded_model(run) != model:', 'if False:',
     ['SameModelAttemptsOnly.test_other_model_success_is_not_recovery',
      'SameModelAttemptsOnly.test_other_model_failures_cannot_escalate']),
    ("terminal-means-attempt",
     'usage = run.get("usageJson") or {}',
     'return True\n    usage = run.get("usageJson") or {}',
     ['SameModelAttemptsOnly.test_zero_usage_success_does_not_prove_attempt',
      'SameModelAttemptsOnly.test_zero_usage_failures_do_not_prove_attempts']),
    ("pre-inference-is-attempt",
     'if any(sig in error_text(run) for sig in PRE_INFERENCE_SIGNATURES):',
     'if False:',
     ['SameModelAttemptsOnly.test_worktree_abort_is_not_a_control_even_with_stale_usage',
      'SameModelAttemptsOnly.test_configuration_failure_is_not_a_control']),
    ("merge-model-timelines",
     'by_model.setdefault(recorded_model(r), []).append(r)',
     'by_model.setdefault(None, []).append(r)',
     ['SameModelAttemptsOnly.test_other_model_denial_cannot_extend_window',
      'SameModelAttemptsOnly.test_model_bursts_have_independent_counts']),
    ("exit-code-is-severity",
     'worst = max(bursts, key=lambda b: severity[b["verdict"]])',
     'worst = max(bursts, key=lambda b: exit_for[b["verdict"]])',
     ['ExitCodesAndSilence.test_entitlement_outranks_insufficient_across_bursts',
      'ExitCodesAndSilence.test_entitlement_wins_a_three_way_split']),
    ("halved-default",
     'MIN_CONTROL_RUNS = 2', 'MIN_CONTROL_RUNS = 1',
     ['SilenceIsNotProof.test_default_threshold_is_two_control_runs',
      'SilenceIsNotProof.test_default_path_refuses_a_single_control_run']),
]

WORKER = '''
import io, json, sys, unittest
import test_auth_denial_discriminator as tests
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
    (directory / "tests").mkdir()
    (directory / TARGET).write_text(source)
    shutil.copyfile(ROOT / SUITE, directory / SUITE)
    shutil.copyfile(ROOT / FIXTURE, directory / FIXTURE)


def main():
    source = (ROOT / TARGET).read_text()
    with tempfile.TemporaryDirectory(prefix="auth-denial-baseline-") as tmp:
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
        required = {"test_auth_denial_discriminator." + name for name in expected}
        with tempfile.TemporaryDirectory(prefix=f"auth-denial-{label}-") as tmp:
            stage(Path(tmp), source)
            control = run_suite(tmp, sorted(required))
            if not control["success"] or control["run"] != len(required):
                raise RuntimeError(f"{label}: named baseline failed: {control}")
            (Path(tmp) / TARGET).write_text(mutated)
            result = run_suite(tmp, sorted(required))
        if result["run"] != control["run"]:
            raise RuntimeError(f"{label}: test population changed")
        failures = set(result["failures"])
        if len(required) < 2 or not required <= failures or result["success"]:
            raise RuntimeError(f"{label}: missing named assertion kills: "
                               f"{sorted(required - failures)}; {result}")
        print(f"KILLED {label}: {len(failures)} assertion failures; "
              + ", ".join(expected))
    print(f"PASS: {len(MUTANTS)} mutants, each with >=2 named assertion kills")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, SyntaxError, subprocess.TimeoutExpired) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
