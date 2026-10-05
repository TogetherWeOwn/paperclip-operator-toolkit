#!/usr/bin/env python3
# ===========================================================================
# test_isolated_first_pickup.py — hostile tests for the GARM first-pickup
# canary verdict
#
# Written to FAIL a plausible-but-wrong implementation, not to confirm the
# one that exists. Every section names the shortcut it kills:
#
# §1  Verdict boundaries are pinned exact: wait == slo is PASS, wait ==
#     slo+1 is FAIL. An off-by-one (strict <) reads the boundary as FAIL
#     and goes red. A "close enough" tolerance would read slo+1 as PASS.
# §2  UNKNOWN, not PASS, when queue_wait_s is absent. A checker that
#     defaults a missing wait to 0 (or to slo) reports a PASS it never
#     measured; §2 pins UNKNOWN plus exit 3.
# §3  Cross-checks each refuse their own lie: wrong schema, non-garm
#     runner, missing example-ephemeral label, bad clocks, picked-up before
#     dispatched, non-positive SLO, out-of-range wait. A checker that only
#     compares two numbers passes fabricated green reports (§3a pins the
#     static-runner lie explicitly).
# §4  Parser fail-closed: duplicate keys, non-finite numbers, NUL bytes,
#     oversize input, malformed JSON, missing files all refuse (exit 1),
#     never verdict.
# §5  CLI exit codes: 0 PASS, 2 FAIL, 3 UNKNOWN, 1 validation error
#     (bare-argparse usage exits 2; the checker's own errors exit 1).
#     Multi-file runs report the worst verdict, so one FAIL is not hidden
#     by a later PASS.
# §6  Determinism: no clock read, no network, no write outside temp dirs.
# ===========================================================================
import json
import os
import subprocess
import sys
import tempfile
import unittest

from garm.check_first_pickup import (  # noqa: E402
    SCHEMA,
    evaluate,
)

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "garm", "check_first_pickup.py")


def report(**overrides):
    doc = {"schema": SCHEMA,
           "run_id": "0",
           "repository": "example/synthetic",
           "pool_labels": ["self-hosted", "example-ephemeral"],
           "runner_name": "garm-example-synthetic",
           "dispatched_at": "2026-10-03T22:00:00Z",
           "picked_up_at": "2026-10-03T22:03:11Z",
           "queue_wait_s": 191,
           "slo_seconds": 600}
    doc.update(overrides)
    return doc


def write_json(path, doc):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(doc, handle)


def run_cli(*paths):
    return subprocess.run([sys.executable, "-B", SCRIPT, *paths],
                          capture_output=True, text=True, timeout=30)


class VerdictBoundaries(unittest.TestCase):
    def test_pass_well_under_slo(self):
        self.assertEqual(evaluate(report())[0], "PASS")

    def test_boundary_wait_equals_slo_is_pass(self):
        verdict, wait, slo = evaluate(report(queue_wait_s=600))
        self.assertEqual((verdict, wait, slo), ("PASS", 600, 600))

    def test_one_second_over_slo_is_fail(self):
        verdict, wait, slo = evaluate(report(queue_wait_s=601))
        self.assertEqual((verdict, wait, slo), ("FAIL", 601, 600))

    def test_zero_wait_is_pass(self):
        self.assertEqual(evaluate(report(queue_wait_s=0))[0], "PASS")


class UnknownWhenUnmeasured(unittest.TestCase):
    def test_missing_wait_is_unknown_not_pass(self):
        doc = report()
        del doc["queue_wait_s"]
        verdict, wait, slo = evaluate(doc)
        self.assertEqual(verdict, "UNKNOWN")
        self.assertIsNone(wait)
        self.assertEqual(slo, 600)


class CrossChecks(unittest.TestCase):
    def test_wrong_schema_refused(self):
        with self.assertRaises(Exception):
            evaluate(report(schema="garm-first-pickup-report.v0"))

    def test_static_runner_refused(self):
        # §3a: a example-ephemeral label on a static runner name is the exact
        # lie this canary exists to catch; numbers alone must not pass it.
        with self.assertRaises(Exception):
            evaluate(report(runner_name="ci-fixture-host-a-iso-1"))

    def test_missing_ephemeral_label_refused(self):
        with self.assertRaises(Exception):
            evaluate(report(pool_labels=["self-hosted", "example-isolated"]))

    def test_bad_clock_refused(self):
        with self.assertRaises(Exception):
            evaluate(report(dispatched_at="2026-10-03 22:00:00"))

    def test_pickup_before_dispatch_refused(self):
        with self.assertRaises(Exception):
            evaluate(report(dispatched_at="2026-10-03T22:05:00Z",
                            picked_up_at="2026-10-03T22:03:11Z"))

    def test_non_positive_slo_refused(self):
        with self.assertRaises(Exception):
            evaluate(report(slo_seconds=0))

    def test_negative_wait_refused(self):
        with self.assertRaises(Exception):
            evaluate(report(queue_wait_s=-1))

    def test_absurd_wait_refused_not_fail(self):
        # A 6h+ value is a clock/unit error, not a slow pool: it must
        # refuse (InvalidReport), never report FAIL.
        with self.assertRaises(Exception):
            evaluate(report(queue_wait_s=6 * 60 * 60 + 1))

    def test_bool_wait_refused(self):
        with self.assertRaises(Exception):
            evaluate(report(queue_wait_s=True))


class ParserFailClosed(unittest.TestCase):
    def test_duplicate_key_refused(self):
        raw = ('{"schema": "x", "schema": "y"}').encode()
        with tempfile.NamedTemporaryFile(suffix=".json",
                                         delete=False) as handle:
            handle.write(raw)
            path = handle.name
        try:
            proc = run_cli(path)
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 1)

    def test_malformed_json_refused(self):
        with tempfile.NamedTemporaryFile(suffix=".json", mode="w",
                                         delete=False) as handle:
            handle.write("{not json")
            path = handle.name
        try:
            proc = run_cli(path)
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 1)

    def test_missing_file_refused(self):
        proc = run_cli("/nonexistent/first-pickup-report.json")
        self.assertEqual(proc.returncode, 1)

    def test_no_argv_is_usage_error(self):
        proc = subprocess.run([sys.executable, "-B", SCRIPT],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 2)  # argparse usage error; see §5


class CliExitCodes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pass_path = os.path.join(self.tmp.name, "pass.json")
        self.fail_path = os.path.join(self.tmp.name, "fail.json")
        self.unknown_path = os.path.join(self.tmp.name, "unknown.json")
        write_json(self.pass_path, report())
        write_json(self.fail_path, report(queue_wait_s=601))
        unknown = report()
        del unknown["queue_wait_s"]
        write_json(self.unknown_path, unknown)

    def tearDown(self):
        self.tmp.cleanup()

    def test_pass_exits_zero(self):
        proc = run_cli(self.pass_path)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("PASS", proc.stdout)

    def test_fail_exits_two(self):
        proc = run_cli(self.fail_path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("FAIL", proc.stdout)

    def test_unknown_exits_three(self):
        proc = run_cli(self.unknown_path)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("UNKNOWN", proc.stdout)

    def test_worst_verdict_wins(self):
        proc = run_cli(self.pass_path, self.fail_path)
        self.assertEqual(proc.returncode, 2)
        proc = run_cli(self.pass_path, self.unknown_path)
        self.assertEqual(proc.returncode, 3)

    def test_invalid_report_exits_one(self):
        bad = os.path.join(self.tmp.name, "bad.json")
        write_json(bad, report(runner_name="ci-fixture-host-a-iso-1"))
        proc = run_cli(bad)
        self.assertEqual(proc.returncode, 1)


if __name__ == "__main__":
    unittest.main()
