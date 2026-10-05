#!/usr/bin/env python3
# ===========================================================================
# test_garm_provider_latency_baseline.py — hostile tests for the provider
# operation-latency recorder/checker
#
# Written to FAIL a plausible-but-wrong implementation, not to confirm the
# one that exists. Every section below names the shortcut it kills:
#
# §1  Percentile rank is pinned exact (1..100 -> p50=50, p95=95). An
#     off-by-one rank (ceil+1, or zero-indexed rank) reads 51/96 and goes
#     red. Linear interpolation would read 50.5/95.05 and also go red: the
#     contract is nearest-rank, not "about the middle".
# §2  Validation refuses shape violations but ACCEPTS duplicate durations.
#     A dedup-on-ingest shortcut (§2f) drops the densest real data and
#     biases every percentile; it must go red here.
# §3  The 6h upper bound refuses unit/clock errors, not slow providers.
# §4  Provisional baselines never verdict: `check` answers unknown (exit 3),
#     never ok and never breach, until both operations hold >=10 samples.
# §5  Breach logic is OR across p50/p95 per operation, evaluated on FRESH
#     samples against STORED thresholds — not on the baseline's own history.
# §6  CLI exit codes: 0 recorded/ok, 2 breach, 3 unknown, 1 usage/validation.
#     A `check` that exits 0 on a missing baseline would be a quiet pass.
# §7  Determinism: `--now` pins recorded_at; no clock read, no network, no
#     write outside a temp dir.
# ===========================================================================
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from garm_provider_latency_baseline import (  # noqa: E402
    InvalidInput,
    MAX_DURATION_MS,
    MIN_SAMPLES_PER_OP,
    evaluate,
    init_baseline,
    parse_samples,
    percentile,
    record,
    summarize,
)

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "garm_provider_latency_baseline.py")
SCHEMA = "garm-provider-latency-samples.v1"


def samples_doc(rows):
    return {"schema": SCHEMA, "samples": rows}


def row(op, ms):
    return {"operation": op, "duration_ms": ms}


def write_json(path, doc):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(doc, handle)


def run_cli(*argv):
    proc = subprocess.run(
        [sys.executable, "-B", SCRIPT] + list(argv),
        capture_output=True, text=True, timeout=30)
    return proc


def non_provisional_baseline():
    base = init_baseline("test seed")
    grouped = {"create": [60_000 + i * 1_000 for i in range(12)],
               "delete": [10_000 + i * 1_000 for i in range(12)]}
    return record(base, grouped, "test", "tester", "2026-10-03T00:00:00Z")


class PercentileRankTest(unittest.TestCase):
    """§1: nearest-rank arithmetic is exact, not approximate."""

    def test_pinned_1_to_100(self):
        values = list(range(1, 101))
        self.assertEqual(percentile(values, 50), 50)
        self.assertEqual(percentile(values, 95), 95)

    def test_single_sample_is_itself(self):
        self.assertEqual(percentile([42000], 50), 42000)
        self.assertEqual(percentile([42000], 95), 42000)

    def test_small_n_rounds_up(self):
        # n=10: p50 rank=ceil(5.0)=5 -> 5th value; p95 rank=ceil(9.5)=10.
        values = list(range(1, 11))
        self.assertEqual(percentile(values, 50), 5)
        self.assertEqual(percentile(values, 95), 10)

    def test_summarize_sorts_first(self):
        stats = summarize([30, 10, 20])
        self.assertEqual(
            (stats["count"], stats["min_ms"], stats["max_ms"]), (3, 10, 30))

    def test_empty_percentile_refuses(self):
        with self.assertRaises(InvalidInput):
            percentile([], 50)


class ValidationTest(unittest.TestCase):
    """§2: hostile shapes refuse; real shapes pass."""

    def test_wrong_schema_refuses(self):
        with self.assertRaises(InvalidInput):
            parse_samples({"schema": "other.v1", "samples": [row("create", 1)]})  # noqa: E501

    def test_empty_samples_refuse(self):
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([]))

    def test_unknown_operation_refuses(self):
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([{"operation": "boot",
                                        "duration_ms": 5}]))  # noqa: E501

    def test_extra_key_refuses(self):
        bad = {"operation": "create", "duration_ms": 5, "host": "rbx1"}
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([bad]))

    def test_negative_refuses(self):
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([row("delete", -1)]))

    def test_nan_and_inf_refuse(self):
        for bad in (float("nan"), float("inf")):
            with self.assertRaises(InvalidInput):
                parse_samples(samples_doc([row("create", bad)]))

    def test_string_duration_refuses(self):
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([row("create", "60000")]))

    def test_bool_duration_refuses(self):
        # True == 1 would otherwise pass as 1 ms.
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([row("create", True)]))

    def test_duplicate_durations_accepted(self):
        """§2f: dedup-on-ingest is the shortcut this kills."""
        grouped = parse_samples(samples_doc([row("create", 60000)] * 5))
        self.assertEqual(grouped["create"], [60000] * 5)
        self.assertEqual(summarize(grouped["create"])["p50_ms"], 60000)

    def test_zero_is_a_valid_duration(self):
        grouped = parse_samples(samples_doc([row("delete", 0)]))
        self.assertEqual(grouped["delete"], [0])


class UpperBoundTest(unittest.TestCase):
    """§3: the 6h cap refuses unit/clock errors."""

    def test_just_over_6h_refuses(self):
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([row("create", MAX_DURATION_MS + 1)]))

    def test_exactly_6h_accepted(self):
        grouped = parse_samples(samples_doc([row("create", MAX_DURATION_MS)]))  # noqa: E501
        self.assertEqual(grouped["create"], [MAX_DURATION_MS])


class ProvisionalTest(unittest.TestCase):
    """§4: thin data never verdicts."""

    def test_fresh_baseline_is_provisional(self):
        base = init_baseline("operator seed")
        self.assertTrue(base["provisional"])

    def test_nine_samples_stays_provisional(self):
        base = init_baseline("test")
        grouped = {"create": [60000] * 9, "delete": [10000] * 10}
        record(base, grouped, "test", "tester", "2026-10-03T00:00:00Z")
        self.assertTrue(base["provisional"])

    def test_ten_each_clears_provisional(self):
        base = init_baseline("test")
        grouped = {"create": [60000] * 10, "delete": [10000] * 10}
        record(base, grouped, "test", "tester", "2026-10-03T00:00:00Z")
        self.assertFalse(base["provisional"])

    def test_provisional_evaluates_unknown(self):
        verdict, _ = evaluate(init_baseline("test"),
                              {"create": [1], "delete": [1]})
        self.assertEqual(verdict, "unknown")

    def test_missing_operation_in_fresh_samples_is_unknown(self):
        base = non_provisional_baseline()
        verdict, _ = evaluate(base, {"create": [60000] * 10, "delete": []})
        self.assertEqual(verdict, "unknown")


class BreachTest(unittest.TestCase):
    """§5: breach is per-operation OR over p50/p95 on FRESH samples."""

    def test_healthy_samples_ok(self):
        base = non_provisional_baseline()
        verdict, details = evaluate(
            base, {"create": [60000] * 10, "delete": [10000] * 10})
        self.assertEqual(verdict, "ok")
        self.assertFalse(details["create"]["breach"])

    def test_p50_breach_alone_pages(self):
        base = non_provisional_baseline()
        slow = [11 * 60 * 1000] * 10  # median past 10-min seed
        verdict, _ = evaluate(base, {"create": slow, "delete": [10000] * 10})  # noqa: E501
        self.assertEqual(verdict, "breach")

    def test_tail_only_p95_breach_pages(self):
        base = non_provisional_baseline()
        # 18 fast + 2 very slow (n=20): median rank 10 is fast, but p95
        # rank=ceil(0.95*20)=19 lands on the slow tail. A single slow
        # sample would sit at rank 20, correctly OUTSIDE p95 — the tail
        # must hold >=5% to move nearest-rank p95, which is what this pins.
        tail = [60000] * 18 + [25 * 60 * 1000] * 2
        verdict, details = evaluate(base, {"create": tail,
                                           "delete": [10000] * 10})
        self.assertEqual(verdict, "breach")
        self.assertTrue(details["create"]["breach"])
        self.assertEqual(details["create"]["p50_ms"], 60000)

    def test_baseline_history_does_not_self_breach(self):
        # Evaluating the baseline's own stored stats is not implemented;
        # evaluate() takes fresh samples, so a hot history cannot page
        # without fresh evidence. Pin the signature: no fresh samples for
        # an operation is unknown, not breach.
        base = non_provisional_baseline()
        verdict, _ = evaluate(base, {"create": [], "delete": []})
        self.assertEqual(verdict, "unknown")


class CliTest(unittest.TestCase):
    """§6/§7: exit codes and determinism through the real CLI."""

    def test_init_record_check_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            samples = os.path.join(tmp, "samples.json")
            baseline = os.path.join(tmp, "baseline.json")
            write_json(samples, samples_doc(
                [row("create", 60000 + i) for i in range(10)]
                + [row("delete", 10000 + i) for i in range(10)]))
            proc = run_cli("init", "--baseline", baseline,
                           "--source", "cli test seed")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            proc = run_cli("record", "--samples", samples,
                           "--baseline", baseline, "--source", "cli test",
                           "--recorded-by", "cli",
                           "--now", "2026-10-03T12:00:00Z")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(baseline, encoding="utf-8") as handle:
                stored = json.load(handle)
            self.assertFalse(stored["provisional"])
            self.assertEqual(stored["provenance"]["recorded_at"],
                             "2026-10-03T12:00:00Z")
            proc = run_cli("check", "--samples", samples,
                           "--baseline", baseline)
            self.assertEqual(proc.returncode, 0, proc.stdout)
            self.assertIn('"verdict": "ok"', proc.stdout)

    def test_check_breach_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            samples = os.path.join(tmp, "s.json")
            baseline = os.path.join(tmp, "b.json")
            healthy = ([row("create", 60000) for _ in range(10)]
                       + [row("delete", 10000) for _ in range(10)])
            write_json(samples, samples_doc(healthy))
            self.assertEqual(run_cli(
                "record", "--samples", samples, "--baseline", baseline,
                "--source", "t", "--now", "2026-10-03T00:00:00Z").returncode,
                0)
            write_json(samples, samples_doc(
                [row("create", 30 * 60 * 1000) for _ in range(10)]
                + [row("delete", 10000) for _ in range(10)]))
            proc = run_cli("check", "--samples", samples,
                           "--baseline", baseline)
            self.assertEqual(proc.returncode, 2, proc.stdout)
            self.assertIn('"verdict": "breach"', proc.stdout)

    def test_check_provisional_exits_3_not_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            samples = os.path.join(tmp, "s.json")
            baseline = os.path.join(tmp, "b.json")
            write_json(samples, samples_doc([row("create", 1)]))
            self.assertEqual(run_cli(
                "init", "--baseline", baseline,
                "--source", "seed").returncode, 0)
            proc = run_cli("check", "--samples", samples,
                           "--baseline", baseline)
            self.assertEqual(proc.returncode, 3, proc.stdout)

    def test_check_missing_baseline_exits_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            samples = os.path.join(tmp, "s.json")
            write_json(samples, samples_doc([row("create", 1)]))
            proc = run_cli("check", "--samples", samples, "--baseline",
                           os.path.join(tmp, "absent.json"))
            self.assertEqual(proc.returncode, 3, proc.stdout)

    def test_bad_samples_exit_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            samples = os.path.join(tmp, "s.json")
            baseline = os.path.join(tmp, "b.json")
            with open(samples, "w", encoding="utf-8") as handle:
                handle.write("{not json")
            proc = run_cli("check", "--samples", samples,
                           "--baseline", baseline)
            self.assertEqual(proc.returncode, 1)

    def test_record_recovers_from_absent_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            samples = os.path.join(tmp, "s.json")
            baseline = os.path.join(tmp, "new.json")
            write_json(samples, samples_doc([row("create", 60000)]))
            proc = run_cli("record", "--samples", samples,
                           "--baseline", baseline, "--source", "t",
                           "--now", "2026-10-03T00:00:00Z")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(baseline, encoding="utf-8") as handle:
                stored = json.load(handle)
            self.assertTrue(stored["provisional"])
            self.assertEqual(stored["operations"]["create"]["count"], 1)

    def test_store_is_bounded(self):
        base = init_baseline("test")
        many = list(range(1, 3000))  # 2999 durations, all valid ms
        record(base, {"create": many, "delete": []},
               "test", "tester", "2026-10-03T00:00:00Z")
        self.assertEqual(base["operations"]["create"]["count"], 2000)
        # Oldest dropped: 2999 appended, first 999 evicted, window opens
        # at 1000.
        self.assertEqual(base["operations"]["create"]["samples"][0], 1000)


class ConstantsTest(unittest.TestCase):
    def test_min_samples_is_ten(self):
        self.assertEqual(MIN_SAMPLES_PER_OP, 10)


if __name__ == "__main__":
    unittest.main()
