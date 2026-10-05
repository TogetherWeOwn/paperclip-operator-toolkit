#!/usr/bin/env python3
# ===========================================================================
# test_garm_ready_time_baseline.py — hostile tests for the GARM VM
# create-to-ready recorder/checker
#
# Written to FAIL a plausible-but-wrong implementation, not to confirm the
# one that exists. Every section below names the shortcut it kills:
#
# §1  Percentile rank is pinned exact (1..100 -> p50=50, p95=95). An
#     off-by-one rank (ceil+1, or zero-indexed rank) reads 51/96 and goes
#     red. Linear interpolation would read 50.5/95.05 and also go red: the
#     contract is nearest-rank, not "about the middle".
# §2  Validation accepts timestamp pairs and derives durations, but ACCEPTS
#     duplicate durations. A dedup-on-ingest shortcut drops the densest
#     real data and biases every percentile; it must go red here. Clocks
#     are strict Zulu seconds: fractional seconds, offset spellings, and
#     non-string clocks all refuse, and ready-before-create refuses rather
#     than clamping to zero.
# §3  The 6h upper bound refuses clock/join errors, not slow boots. The
#     exact 6h boundary still records: a fencepost `<` instead of `<=`
#     drops a legal row here.
# §4  Provisional baselines never verdict: `check` answers unknown (exit 3),
#     never ok and never breach, until startup holds >=10 samples. A
#     `check` that exits 0 on a missing baseline would be a quiet pass.
# §5  Breach logic is OR across p50/p95, evaluated on FRESH samples
#     against STORED thresholds — not on the baseline's own history. A
#     checker that verdicts on stored history goes red on the
#     fresh-good/history-slow case.
# §6  CLI exit codes: 0 recorded/ok, 2 breach, 3 unknown, 1 usage/
#     validation. Recording slow-but-legal samples is not a refusal.
# §7  Determinism: `--now` pins recorded_at; no clock read, no network,
#     no write outside the given baseline path or temp dir.
# ===========================================================================
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from garm_ready_time_baseline import (  # noqa: E402
    InvalidInput,
    MAX_DURATION_MS,
    MAX_SAMPLES,
    MIN_SAMPLES,
    evaluate,
    init_baseline,
    parse_samples,
    percentile,
    record,
    summarize,
)

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "garm_ready_time_baseline.py")
SCHEMA = "garm-ready-time-samples.v1"
BASE = datetime(2026, 10, 10, 14, 0, 0, tzinfo=timezone.utc)


def zulu(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def row(name, created, ready):
    return {"instance": name, "created_at": created, "ready_at": ready}


def pair_row(name, created_dt, duration_s):
    return row(name, zulu(created_dt), zulu(created_dt +
                                            timedelta(seconds=duration_s)))


def samples_doc(rows):
    return {"schema": SCHEMA, "samples": rows}


def write_json(path, doc):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(doc, handle)


def twelve_good():
    return [pair_row("garm-two-%02d" % i, BASE + timedelta(minutes=i),
                     120 + i * 10)
            for i in range(12)]


def run_cli(*argv):
    proc = subprocess.run(
        [sys.executable, "-B", SCRIPT] + list(argv),
        capture_output=True, text=True, timeout=30)
    return proc


def non_provisional_baseline():
    base = init_baseline("test seed")
    return record(base, parse_samples(samples_doc(twelve_good())),
                  "test", "tester", "2026-10-03T00:00:00Z")


class PercentileRankTest(unittest.TestCase):
    """§1: nearest-rank arithmetic is exact, not approximate."""

    def test_1_to_100_p50_is_50(self):
        self.assertEqual(percentile(list(range(1, 101)), 50), 50)

    def test_1_to_100_p95_is_95(self):
        self.assertEqual(percentile(list(range(1, 101)), 95), 95)

    def test_single_sample_is_both_ends(self):
        self.assertEqual(percentile([42000.0], 50), 42000.0)
        self.assertEqual(percentile([42000.0], 95), 42000.0)

    def test_two_samples_p50_is_first(self):
        # Nearest-rank: rank = ceil(0.5*2) = 1. A zero-indexed or
        # ceil+1 rank reads the second element and goes red.
        self.assertEqual(percentile([100.0, 200.0], 50), 100.0)

    def test_empty_input_rejects(self):
        with self.assertRaises(InvalidInput):
            percentile([], 50)


class ValidationTest(unittest.TestCase):
    """§2: pairs validate strictly; duplicates are data."""

    def test_accepts_duplicate_durations(self):
        rows = [pair_row("garm-two-a", BASE, 200),
                pair_row("garm-two-b", BASE, 200),
                pair_row("garm-two-c", BASE, 200)]
        parsed = parse_samples(samples_doc(rows))
        self.assertEqual([d for _, d in parsed],
                         [200000.0, 200000.0, 200000.0])

    def test_rejects_extra_keys(self):
        bad = dict(pair_row("x", BASE, 60))
        bad["note"] = "extra"
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([bad]))

    def test_rejects_missing_ready(self):
        bad = {"instance": "x", "created_at": zulu(BASE)}
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([bad]))

    def test_rejects_empty_samples(self):
        with self.assertRaises(InvalidInput):
            parse_samples({"schema": SCHEMA, "samples": []})

    def test_rejects_bad_schema(self):
        with self.assertRaises(InvalidInput):
            parse_samples({"schema": "garm-provider-latency-samples.v1",
                           "samples": [pair_row("x", BASE, 60)]})

    def test_rejects_fractional_seconds(self):
        bad = row("x", "2026-10-10T14:00:00.000Z", zulu(BASE))
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([bad]))

    def test_rejects_offset_spelling(self):
        bad = row("x", "2026-10-10T14:00:00+00:00", zulu(BASE))
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([bad]))

    def test_rejects_non_string_clock(self):
        bad = {"instance": "x", "created_at": 20261010,
               "ready_at": zulu(BASE)}
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([bad]))

    def test_rejects_impossible_calendar(self):
        bad = row("x", "2026-02-30T14:00:00Z", "2026-02-30T14:05:00Z")
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([bad]))

    def test_rejects_ready_before_create(self):
        bad = row("x", zulu(BASE + timedelta(minutes=5)), zulu(BASE))
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([bad]))

    def test_rejects_empty_instance(self):
        bad = pair_row("   ", BASE, 60)
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc([bad]))

    def test_rejects_over_max_rows(self):
        rows = [pair_row("garm-two-%d" % i, BASE, 60)
                for i in range(MAX_SAMPLES + 1)]
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc(rows))

    def test_derives_duration_ms(self):
        created = datetime(2026, 10, 10, 14, 1, 0, tzinfo=timezone.utc)
        parsed = parse_samples(samples_doc(
            [pair_row("garm-two-abc", created, 200)]))
        self.assertEqual(parsed, [("garm-two-abc", 200000.0)])


class BoundTest(unittest.TestCase):
    """§3: the 6h bound refuses errors, keeps the boundary row."""

    def test_rejects_over_six_hours(self):
        created = BASE
        ready = BASE + timedelta(hours=6, seconds=1)
        with self.assertRaises(InvalidInput):
            parse_samples(samples_doc(
                [row("x", zulu(created), zulu(ready))]))

    def test_accepts_exactly_six_hours(self):
        created = BASE
        ready = BASE + timedelta(hours=6)
        parsed = parse_samples(samples_doc(
            [row("x", zulu(created), zulu(ready))]))
        self.assertEqual(parsed[0][1], float(MAX_DURATION_MS))


class ProvisionalTest(unittest.TestCase):
    """§4: provisional baselines never verdict."""

    def test_init_is_provisional(self):
        base = init_baseline("test seed")
        self.assertTrue(base["provisional"])
        verdict, _ = evaluate(base, parse_samples(
            samples_doc(twelve_good())))
        self.assertEqual(verdict, "unknown")

    def test_below_min_samples_stays_provisional(self):
        base = init_baseline("test seed")
        small = [pair_row("garm-two-%02d" % i, BASE, 120)
                 for i in range(MIN_SAMPLES - 1)]
        base = record(base, parse_samples(samples_doc(small)),
                      "test", "tester", "2026-10-03T00:00:00Z")
        self.assertTrue(base["provisional"])
        verdict, _ = evaluate(base, parse_samples(
            samples_doc(twelve_good())))
        self.assertEqual(verdict, "unknown")

    def test_cli_check_provisional_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline = os.path.join(tmp, "base.json")
            samples = os.path.join(tmp, "samples.json")
            write_json(samples, samples_doc(twelve_good()))
            proc = run_cli("init", "--baseline", baseline,
                           "--source", "test")
            self.assertEqual(proc.returncode, 0)
            proc = run_cli("check", "--samples", samples,
                           "--baseline", baseline)
            self.assertEqual(proc.returncode, 3)
            self.assertIn("unknown", proc.stdout)

    def test_cli_check_missing_baseline_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            samples = os.path.join(tmp, "samples.json")
            write_json(samples, samples_doc(twelve_good()))
            proc = run_cli("check", "--samples", samples,
                           "--baseline", os.path.join(tmp, "absent.json"))
            self.assertEqual(proc.returncode, 3)


class BreachTest(unittest.TestCase):
    """§5: breach is OR across p50/p95 on FRESH samples."""

    def test_ok_within_thresholds(self):
        base = non_provisional_baseline()
        verdict, detail = evaluate(base, parse_samples(
            samples_doc(twelve_good())))
        self.assertEqual(verdict, "ok")
        self.assertEqual(detail["breaches"], [])

    def test_breach_p50_only(self):
        # Median 700s breaches p50 (600s); p95 700s stays under 1200s.
        base = non_provisional_baseline()
        slow = [pair_row("garm-two-%02d" % i, BASE, 700)
                for i in range(12)]
        verdict, detail = evaluate(base, parse_samples(
            samples_doc(slow)))
        self.assertEqual(verdict, "breach")
        self.assertEqual(len(detail["breaches"]), 1)
        self.assertIn("p50", detail["breaches"][0])

    def test_breach_p95_only(self):
        # 18 fast + 2 very slow: p50 stays fast, p95 lands on slow.
        base = non_provisional_baseline()
        rows = ([pair_row("garm-two-%02d" % i, BASE, 100)
                 for i in range(18)] +
                [pair_row("garm-two-tail-%d" % i, BASE, 2000)
                 for i in range(2)])
        verdict, detail = evaluate(base, parse_samples(
            samples_doc(rows)))
        self.assertEqual(verdict, "breach")
        self.assertEqual(len(detail["breaches"]), 1)
        self.assertIn("p95", detail["breaches"][0])

    def test_fresh_good_beats_slow_history(self):
        # Recorded history holds slow-but-legal rows; a fresh good
        # export still verdicts ok. A checker reading stored history
        # instead of fresh samples goes red here.
        base = init_baseline("test seed")
        slow_history = [pair_row("garm-two-%02d" % i, BASE, 1800)
                        for i in range(12)]
        base = record(base, parse_samples(samples_doc(slow_history)),
                      "test", "tester", "2026-10-03T00:00:00Z")
        self.assertFalse(base["provisional"])
        verdict, _ = evaluate(base, parse_samples(
            samples_doc(twelve_good())))
        self.assertEqual(verdict, "ok")


class CLITest(unittest.TestCase):
    """§6-§7: exit codes and determinism."""

    def test_cli_record_then_check_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline = os.path.join(tmp, "base.json")
            samples = os.path.join(tmp, "samples.json")
            write_json(samples, samples_doc(twelve_good()))
            self.assertEqual(run_cli(
                "init", "--baseline", baseline,
                "--source", "test").returncode, 0)
            proc = run_cli("record", "--samples", samples,
                           "--baseline", baseline, "--source", "test",
                           "--recorded-by", "tester",
                           "--now", "2026-10-03T00:00:00Z")
            self.assertEqual(proc.returncode, 0)
            self.assertIn("total 12", proc.stdout)
            proc = run_cli("check", "--samples", samples,
                           "--baseline", baseline)
            self.assertEqual(proc.returncode, 0)
            self.assertIn('"ok"', proc.stdout)

    def test_cli_check_breach_exit_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline = os.path.join(tmp, "base.json")
            good = os.path.join(tmp, "good.json")
            bad = os.path.join(tmp, "bad.json")
            write_json(good, samples_doc(twelve_good()))
            slow = [pair_row("garm-two-%02d" % i, BASE, 700)
                    for i in range(12)]
            write_json(bad, samples_doc(slow))
            run_cli("init", "--baseline", baseline, "--source", "test")
            run_cli("record", "--samples", good, "--baseline", baseline,
                    "--source", "test", "--recorded-by", "tester",
                    "--now", "2026-10-03T00:00:00Z")
            proc = run_cli("check", "--samples", bad,
                           "--baseline", baseline)
            self.assertEqual(proc.returncode, 2)
            self.assertIn("breach", proc.stdout)

    def test_cli_bad_samples_exit_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline = os.path.join(tmp, "base.json")
            bad = os.path.join(tmp, "bad.json")
            write_json(bad, {"schema": SCHEMA, "samples": []})
            run_cli("init", "--baseline", baseline, "--source", "test")
            proc = run_cli("check", "--samples", bad,
                           "--baseline", baseline)
            self.assertEqual(proc.returncode, 1)

    def test_now_pins_recorded_at(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline = os.path.join(tmp, "base.json")
            samples = os.path.join(tmp, "samples.json")
            write_json(samples, samples_doc(twelve_good()))
            run_cli("init", "--baseline", baseline, "--source", "test")
            run_cli("record", "--samples", samples, "--baseline",
                    baseline, "--source", "test", "--recorded-by",
                    "tester", "--now", "2026-10-03T00:00:00Z")
            with open(baseline, encoding="utf-8") as handle:
                stored = json.load(handle)
            self.assertEqual(stored["provenance"]["recorded_at"],
                             "2026-10-03T00:00:00Z")


class SummarizeTest(unittest.TestCase):
    """Summary arithmetic over derived durations."""

    def test_summarize_counts_and_ends(self):
        summary = summarize([300000.0, 100000.0, 200000.0])
        self.assertEqual(summary["count"], 3)
        self.assertEqual(summary["min_ms"], 100000.0)
        self.assertEqual(summary["max_ms"], 300000.0)
        self.assertEqual(summary["p50_ms"], 200000.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
