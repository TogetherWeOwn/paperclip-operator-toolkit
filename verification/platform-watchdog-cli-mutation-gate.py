#!/usr/bin/env python3
"""The watchdog CLI and read-only contract tests must fail when broken.

Mirrors verification/process-lost-mutation-gate.py. Every mutant runs in a
fresh temporary copy of watchdog/ and the suite after a green baseline, so the
checkout is never edited and an interrupted run strands nothing. Only named
assertion failures count; missing tests, skips, errors, timeouts, non-parsing
mutants and loader failures refuse. Offline: no credentials, no network.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = "watchdog/detectors.py"
SUITE = "test_platform_watchdog_cli.py"
MODULE = "test_platform_watchdog_cli"

REFUSAL = "CliRefusalTest."
OUTPUT = "CliOutputContractTest."
READ_ONLY = "ReadOnlyContractTest."

# (label, anchor, replacement, tests that must fail). An id also matches its
# subTest failures. Each anchor must occur exactly once in the target.
# The desk/host-coverage refusal layer was intentionally not ported to the
# public tree, so its three mutants (anchors absent here) are dropped rather
# than kept failing. If that layer is ever ported, restore them with it.
MUTANTS = [
    ("unreadable-snapshot-exits-0",
     '        print(f"watchdog: cannot read snapshot: {exc}", file=sys.stderr)\n'
     '        return 2',
     '        print(f"watchdog: cannot read snapshot: {exc}", file=sys.stderr)\n'
     '        return 0',
     [REFUSAL + "test_unreadable_snapshot_exits_2",
      REFUSAL + "test_invalid_json_exits_2"]),
    ("non-utf8-snapshot-tracebacks",
     "    except (OSError, ValueError, RecursionError) as exc:",
     "    except (OSError, json.JSONDecodeError, RecursionError) as exc:",
     [REFUSAL + "test_non_utf8_snapshot_exits_2",
      REFUSAL + "test_refusals_never_echo_snapshot_content",
      REFUSAL + "test_pathological_json_snapshot_exits_2"]),
    ("pathological-json-snapshot-tracebacks",
     "    except (OSError, ValueError, RecursionError) as exc:",
     "    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:",
     [REFUSAL + "test_pathological_json_snapshot_exits_2"]),
    ("non-object-snapshot-exits-0",
     '        print("watchdog: snapshot must be a JSON object", '
     'file=sys.stderr)\n        return 2',
     '        print("watchdog: snapshot must be a JSON object", '
     'file=sys.stderr)\n        return 0',
     [REFUSAL + "test_non_object_json_exits_2"]),
    ("refusal-echoes-snapshot",
     '        print("watchdog: snapshot must be a JSON object", '
     'file=sys.stderr)',
     '        print("watchdog: snapshot must be a JSON object: "\n'
     '              + repr(snapshot), file=sys.stderr)',
     [REFUSAL + "test_refusals_never_echo_snapshot_content"]),
    ("records-lose-sorted-keys",
     'print(json.dumps(record, sort_keys=True))',
     'print(json.dumps(record))',
     [OUTPUT + "test_mixed_snapshot_is_sorted_jsonl_with_a_matching_summary"]),
    ("summary-loses-sorted-keys",
     'print(json.dumps(summary, sort_keys=True))',
     'print(json.dumps(summary))',
     [OUTPUT + "test_clean_snapshot_prints_exactly_the_summary_line"]),
    ("summary-count-off-by-one",
     '"records": len(records), "phase": PHASE}',
     '"records": len(records) + 1, "phase": PHASE}',
     [OUTPUT + "test_clean_snapshot_prints_exactly_the_summary_line",
      OUTPUT + "test_mixed_snapshot_is_sorted_jsonl_with_a_matching_summary"]),
    ("success-echoes-snapshot",
     '    print(json.dumps(summary, sort_keys=True))\n    return 0',
     '    print(json.dumps(summary, sort_keys=True))\n'
     '    print(json.dumps({"type": "debug", "snapshot": snapshot},\n'
     '                     sort_keys=True))\n    return 0',
     [OUTPUT + "test_unrelated_snapshot_content_is_never_echoed"]),
    ("output-order-depends-on-hash-seed",
     '    for record in records:\n'
     '        mutation = record.get("mutation")',
     '    records.sort(key=lambda r: hash(r.get("detector")))\n'
     '    for record in records:\n'
     '        mutation = record.get("mutation")',
     [OUTPUT + "test_two_runs_with_pinned_now_are_byte_identical"]),
    ("detect-normalizes-now-in-place",
     '        datetime.timezone.utc)\n    records = []\n',
     '        datetime.timezone.utc)\n    snapshot["now"] = now.isoformat()\n'
     '    records = []\n',
     [READ_ONLY + "test_detect_leaves_its_input_equal"]),
    ("detect-fills-defaults-in-place",
     '        datetime.timezone.utc)\n    records = []\n',
     '        datetime.timezone.utc)\n    records = []\n'
     '    for item in snapshot.get("issues") or []:\n'
     '        item.setdefault("isReview", False)\n',
     [READ_ONLY + "test_detect_leaves_its_input_equal"]),
    ("detect-opens-a-file",
     '        datetime.timezone.utc)\n    records = []\n',
     '        datetime.timezone.utc)\n    records = []\n'
     '    open(__file__, encoding="utf-8").close()\n',
     [READ_ONLY + "test_detect_does_no_io"]),
    ("detect-spawns-a-process",
     '        datetime.timezone.utc)\n    records = []\n',
     '        datetime.timezone.utc)\n    records = []\n'
     '    import subprocess\n    subprocess.Popen(["true"]).wait()\n',
     [READ_ONLY + "test_detect_does_no_io"]),
    ("detect-opens-a-socket",
     '        datetime.timezone.utc)\n    records = []\n',
     '        datetime.timezone.utc)\n    records = []\n'
     '    import socket\n    socket.socket().close()\n',
     [READ_ONLY + "test_detect_does_no_io"]),
]

WORKER = '''
import io, json, sys, unittest
import test_platform_watchdog_cli as tests
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
        capture_output=True, text=True, timeout=120,
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
    package = directory / "watchdog"
    package.mkdir()
    shutil.copyfile(ROOT / "watchdog" / "__init__.py", package / "__init__.py")
    (directory / TARGET).write_text(source)
    shutil.copyfile(ROOT / SUITE, directory / SUITE)


def killed(required, failures):
    """Required ids that failed, counting a subTest failure under its test."""
    return {name for name in required
            if any(f == name or f.startswith(name + " ") for f in failures)}


def main():
    source = (ROOT / TARGET).read_text()
    with tempfile.TemporaryDirectory(prefix="watchdog-cli-baseline-") as tmp:
        stage(Path(tmp), source)
        baseline = run_suite(Path(tmp))
        if not baseline["success"]:
            raise RuntimeError(f"baseline failed: {baseline}")
    print(f"BASELINE: {baseline['run']} passed")
    for label, old, new, expected in MUTANTS:
        if source.count(old) != 1:
            raise RuntimeError(f"{label}: mutation anchor missing or ambiguous")
        mutated = source.replace(old, new)
        compile(mutated, TARGET, "exec")
        required = [f"{MODULE}.{name}" for name in expected]
        with tempfile.TemporaryDirectory(prefix=f"watchdog-cli-{label}-") as tmp:
            stage(Path(tmp), source)
            control = run_suite(Path(tmp), sorted(required))
            if not control["success"] or control["run"] != len(required):
                raise RuntimeError(f"{label}: named baseline failed: {control}")
            (Path(tmp) / TARGET).write_text(mutated)
            result = run_suite(Path(tmp), sorted(required))
        if result["run"] != control["run"]:
            raise RuntimeError(f"{label}: test population changed")
        missing = set(required) - killed(required, result["failures"])
        if missing or result["success"]:
            raise RuntimeError(f"{label}: missing named assertion kills: "
                               f"{sorted(missing)}; {result}")
        print(f"KILLED {label}: " + ", ".join(expected))
    print(f"PASS: {len(MUTANTS)} mutants killed")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, SyntaxError,
            subprocess.TimeoutExpired) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
