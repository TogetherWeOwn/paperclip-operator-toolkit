#!/usr/bin/env python3
# ===========================================================================
# test_muse_countdown.py — hostile tests for the Muse-lane use-before-expiry
# countdown readout
#
# Written to FAIL a plausible-but-wrong implementation, not to confirm the
# one that exists:
#
# * §2 kills the zero-substitution mutant: a null/missing utilization scored
#   as zero prints 100% headroom on a lane that may be exhausted — the
#   `[[ "" -eq 0 ]]` bash trap the cold-start detector exists for, in this
#   file's costume. NaN/Inf matter because Python's json parses them as
#   floats by default, and an unguarded `1 - u` then prints `nan%`.
# * §3 kills the past-reset mutant: numbers describing a window that is over
#   reported as "0 hours left" instead of refused (the past-reset failure
#   verbatim). The past and exactly-now cases are distinct because `>` and
#   `>=` are indistinguishable to every other case in this file.
# * §4 kills the averaging mutant: eight lanes sharing one reset still emit
#   eight rows. A mean hides the thinnest lane — the one the countdown
#   exists to surface — while every row-count assertion stays green.
# * §5 kills the future-dated-now mutant: rendering against a clock pinned
#   to the fixture's observedAt presents a stale fixture as current. The CLI
#   renders against the real clock unless --now is passed explicitly.
# * §6 kills the truncation mutants: an int() hours display that drops the
#   fraction, or a %d headroom, hides a lane 25 minutes from reset (or 0.4
#   points of headroom) behind a confident "25h / 7%".
#
# Deterministic: every case pins `now` explicitly, except the one §5 case
# that must use the real clock to prove the fixture's observedAt is not the
# clock (it renders a temp fixture with a live reset). No network, no write
# outside a temp dir, no roster read.
# ===========================================================================
import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from muse_countdown import (  # noqa: E402
    CountdownError,
    assemble_rows,
    format_table,
)

UTC = datetime.timezone.utc
# Card clock: ~44h before the shared weekly reset, so all eight fixture
# lanes are live and the thinnest still has headroom to show.
NOW = datetime.datetime(2026, 10, 3, 4, 0, 0, tzinfo=UTC)
RESET = "2026-10-05T00:00:00Z"
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "tests", "fixtures", "weekly-lanes-synthetic",
                        "muse-weekly-lanes.json")
READOUT = os.path.join(HERE, "muse_countdown.py")


def lanes(utils, reset=RESET):
    return [{"lane": "Muse-weekly-%d" % (i + 1),
             "weekly_utilization": u, "weekly_reset_utc": reset}
            for i, u in enumerate(utils)]


def row(lane, utilization, reset=RESET):
    return {"lane": lane, "weekly_utilization": utilization,
            "weekly_reset_utc": reset}


def by_lane(rows):
    return {r["lane"]: r for r in rows}


class FixtureTest(unittest.TestCase):
    def test_fixture_is_present_and_has_eight_muse_lanes(self):
        self.assertTrue(os.path.exists(FIXTURE),
                        "fixture %s is missing -- §1 is the headline case "
                        "and must never silently skip" % FIXTURE)
        with open(FIXTURE, encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual(len(doc["lanes"]), 8)
        for entry in doc["lanes"]:
            self.assertIn("Muse", entry["lane"])
            self.assertEqual(entry["weekly_reset_utc"], RESET)


class HeadroomMathTest(unittest.TestCase):
    """§1: headroom is (1 - u) * 100 against the live rows."""

    def test_eight_rows_keep_identity_order_and_shared_reset(self):
        rows = assemble_rows(lanes([0.04, 0.11, 0.27, 0.46,
                                    0.63, 0.81, 0.93, 0.99]), NOW)
        self.assertEqual([r["lane"] for r in rows],
                         ["Muse-weekly-%d" % n for n in range(1, 9)])
        heads = by_lane(rows)
        self.assertAlmostEqual(heads["Muse-weekly-1"]["headroomPct"], 96.0)
        self.assertAlmostEqual(heads["Muse-weekly-8"]["headroomPct"], 1.0)
        for r in rows:
            self.assertAlmostEqual(r["hoursToReset"], 44.0)
            self.assertEqual(r["resetsAt"], RESET)

    def test_hours_to_reset_is_fractional_not_truncated(self):
        now = datetime.datetime(2026, 10, 3, 23, 35, 0, tzinfo=UTC)
        rows = assemble_rows([row("Muse-weekly-1", 0.5)], now)
        self.assertAlmostEqual(rows[0]["hoursToReset"], 24 + 25 / 60.0)

    def test_display_sorts_thinnest_first_without_mutating_input(self):
        rows = assemble_rows(lanes([0.04, 0.99]), NOW)
        before = [r["lane"] for r in rows]
        table = format_table(rows)
        body = table.splitlines()[1:]
        self.assertTrue(body[0].startswith("Muse-weekly-2"))
        self.assertTrue(body[1].startswith("Muse-weekly-1"))
        self.assertEqual([r["lane"] for r in rows], before)
        self.assertIn("1.0%", body[0])
        self.assertIn("96.0%", body[1])


class RefuseDishonestRowsTest(unittest.TestCase):
    """§2: missing/non-finite/out-of-range utilization is refused, never
    zero-substituted. Every case names the lane."""

    def test_missing_utilization_is_refused(self):
        with self.assertRaises(CountdownError) as ctx:
            assemble_rows([{"lane": "Muse-weekly-1",
                            "weekly_reset_utc": RESET}], NOW)
        self.assertIn("Muse-weekly-1", str(ctx.exception))

    def test_null_utilization_is_refused_not_zero(self):
        with self.assertRaises(CountdownError):
            assemble_rows([row("Muse-weekly-1", None)], NOW)

    def test_string_utilization_is_refused(self):
        with self.assertRaises(CountdownError):
            assemble_rows([row("Muse-weekly-1", "0.4")], NOW)

    def test_nan_and_inf_utilization_are_refused(self):
        for bad in (float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(CountdownError):
                assemble_rows([row("Muse-weekly-1", bad)], NOW)

    def test_out_of_range_utilization_is_refused(self):
        for bad in (-0.01, 1.01):
            with self.assertRaises(CountdownError):
                assemble_rows([row("Muse-weekly-1", bad)], NOW)

    def test_bool_utilization_is_refused(self):
        with self.assertRaises(CountdownError):
            assemble_rows([row("Muse-weekly-1", True)], NOW)

    def test_missing_lane_name_is_refused(self):
        with self.assertRaises(CountdownError):
            assemble_rows([{"weekly_utilization": 0.5,
                            "weekly_reset_utc": RESET}], NOW)

    def test_duplicate_lane_is_refused(self):
        with self.assertRaises(CountdownError) as ctx:
            assemble_rows([row("Muse-weekly-1", 0.1),
                           row("Muse-weekly-1", 0.2)], NOW)
        self.assertIn("Muse-weekly-1", str(ctx.exception))

    def test_refused_rows_leave_no_partial_output(self):
        with self.assertRaises(CountdownError):
            assemble_rows([row("Muse-weekly-1", 0.1),
                           row("Muse-weekly-2", None)], NOW)


class ResetHonestyTest(unittest.TestCase):
    """§3: an unreadable or already-past reset is refused."""

    def test_missing_reset_is_refused(self):
        with self.assertRaises(CountdownError):
            assemble_rows([{"lane": "Muse-weekly-1",
                            "weekly_utilization": 0.5}], NOW)

    def test_unparseable_reset_is_refused(self):
        for bad in ("tomorrow", "2026-10-05", True, None, ""):
            with self.assertRaises(CountdownError):
                assemble_rows([row("Muse-weekly-1", 0.5, reset=bad)], NOW)

    def test_past_reset_is_refused_not_zero_hours(self):
        with self.assertRaises(CountdownError) as ctx:
            assemble_rows([row("Muse-weekly-1", 0.5,
                               reset="2026-10-03T03:00:00Z")], NOW)
        self.assertIn("Muse-weekly-1", str(ctx.exception))

    def test_reset_exactly_at_now_is_refused(self):
        with self.assertRaises(CountdownError):
            assemble_rows([row("Muse-weekly-1", 0.5,
                               reset="2026-10-03T04:00:00Z")], NOW)

    def test_reset_one_second_after_now_is_live(self):
        rows = assemble_rows([row("Muse-weekly-1", 0.5,
                                  reset="2026-10-03T04:00:01Z")], NOW)
        self.assertAlmostEqual(rows[0]["hoursToReset"], 1 / 3600.0)


class NoAveragingTest(unittest.TestCase):
    """§4: lanes sharing one reset are never merged or averaged."""

    def test_shared_reset_still_emits_one_row_per_lane(self):
        rows = assemble_rows(lanes([0.04, 0.11, 0.27, 0.46,
                                    0.63, 0.81, 0.93, 0.99]), NOW)
        self.assertEqual(len(rows), 8)
        heads = sorted(r["headroomPct"] for r in rows)
        self.assertAlmostEqual(heads[0], 1.0)
        self.assertAlmostEqual(heads[-1], 96.0)
        self.assertNotAlmostEqual(sum(heads) / 8, heads[0])

    def test_per_lane_resets_are_honored_not_snapped_to_shared(self):
        rows = assemble_rows(
            [row("Muse-weekly-1", 0.5, reset="2026-10-06T00:00:00Z"),
             row("Muse-weekly-2", 0.5)], NOW)
        got = by_lane(rows)
        self.assertAlmostEqual(got["Muse-weekly-1"]["hoursToReset"], 68.0)
        self.assertAlmostEqual(got["Muse-weekly-2"]["hoursToReset"], 44.0)


class ClockHonestyTest(unittest.TestCase):
    """§5: the CLI renders against the real clock, not the fixture."""

    def test_no_now_flag_ignores_fixture_observed_at(self):
        # The fixture's observedAt is six years stale. A reader that pins
        # "now" to it would print 2020 in the header and present ancient
        # rows as current — the past-reset failure. The readout must render
        # against the real clock instead.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "stale-observed.json")
            live_reset = (datetime.datetime.now(UTC)
                          + datetime.timedelta(hours=48)).strftime(
                              "%Y-%m-%dT%H:%M:%SZ")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"observedAt": "2020-01-01T00:00:00Z",
                           "lanes": [row("Muse-weekly-1", 0.5,
                                         reset=live_reset)]},
                          fh)
            proc = subprocess.run(
                [sys.executable, READOUT, "--fixture", path],
                capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("2020-01-01", proc.stdout)
        self.assertIn("Muse-weekly-1", proc.stdout)

    def test_explicit_now_renders_the_fixture(self):
        proc = subprocess.run(
            [sys.executable, READOUT, "--json",
             "--now", "2026-10-03T04:00:00Z"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = json.loads(proc.stdout)
        self.assertEqual(len(rows), 8)
        self.assertAlmostEqual(by_lane(rows)["Muse-weekly-8"]
                               ["headroomPct"], 1.0)

    def test_table_mode_prints_eight_lanes_thinnest_first(self):
        proc = subprocess.run(
            [sys.executable, READOUT,
             "--now", "2026-10-03T04:00:00Z"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.splitlines()
        self.assertIn("Muse weekly countdown", lines[0])
        self.assertEqual(len(lines), 1 + 1 + 8)
        self.assertTrue(lines[2].startswith("Muse-weekly-8"))
        self.assertTrue(lines[-1].startswith("Muse-weekly-1"))

    def test_bad_now_is_usage_not_a_readout(self):
        proc = subprocess.run(
            [sys.executable, READOUT, "--now", "tomorrow"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")

    def test_missing_fixture_is_usage_not_a_readout(self):
        proc = subprocess.run(
            [sys.executable, READOUT, "--fixture", "/nonexistent/x.json",
             "--now", "2026-10-03T04:00:00Z"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")


class FixtureEndsHonestlyTest(unittest.TestCase):
    """§6: at the window's own end the readout refuses, never prints zeros."""

    def test_one_minute_before_reset_still_renders(self):
        now = datetime.datetime(2026, 10, 4, 23, 59, 0, tzinfo=UTC)
        rows = assemble_rows(lanes([0.99]), now)
        self.assertAlmostEqual(rows[0]["hoursToReset"], 1 / 60.0)

    def test_at_reset_every_lane_refuses(self):
        now = datetime.datetime(2026, 10, 5, 0, 0, 0, tzinfo=UTC)
        with self.assertRaises(CountdownError):
            assemble_rows(lanes([0.04, 0.99]), now)


if __name__ == "__main__":
    unittest.main(verbosity=2)
