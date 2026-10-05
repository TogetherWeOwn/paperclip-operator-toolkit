#!/usr/bin/env python3
# ===========================================================================
# test_codex_countdown.py — hostile tests for the Codex-lane use-before-expiry
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
#   reported as "0 hours left" instead of refused (stale numbers presented
#   as current). The past and exactly-now cases are distinct because `>` and
#   `>=` are indistinguishable to every other case in this file.
# * §4 kills the averaging mutant AND the snap-to-shared mutant: three lanes
#   in one weekly window still emit three rows, and lanes 1-3 keep their own
#   distinct resets (84 s apart) instead of inheriting one headline instant.
# * §5 kills the future-dated-now mutant: rendering against a clock pinned
#   to the fixture's observedAt presents a stale fixture as current. The CLI
#   renders against the real clock unless --now is passed explicitly.
# * §6 kills the truncation mutants: an int() hours display that drops the
#   fraction, or a %d headroom, hides a lane 25 minutes from reset (or 0.4
#   points of headroom) behind a confident "25h / 7%".
# * §7 pins the Codex deltas against the Muse pattern: utilization 1.0 is
#   FULL, not dishonest — the exhausted codex-lane-3 renders 0.0% headroom
#   instead of refusing — and 0.0 renders 100% (empty is not exhausted).
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
from codex_countdown import (  # noqa: E402
    CountdownError,
    assemble_rows,
    format_table,
)

UTC = datetime.timezone.utc
# Card clock: ~103h before the earliest Codex reset (lane-1, 10-07 11:12:45Z),
# so all three fixture lanes are live and the thinnest still has a row to show.
NOW = datetime.datetime(2026, 10, 3, 4, 0, 0, tzinfo=UTC)
RESETS = {
    "codex-lane-1": "2026-10-07T11:12:45Z",
    "codex-lane-2": "2026-10-07T11:14:09Z",
    "codex-lane-3": "2026-10-07T11:12:50Z",
}
UTILS = {"codex-lane-1": 0.71, "codex-lane-2": 0.88, "codex-lane-3": 1.0}
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "tests", "fixtures", "weekly-lanes-synthetic",
                        "codex-weekly-lanes.json")
READOUT = os.path.join(HERE, "codex_countdown.py")


def lanes(utils, resets=RESETS):
    return [{"lane": lane, "weekly_utilization": utils[lane],
             "weekly_reset_utc": resets[lane]} for lane in sorted(utils)]


_MISSING = object()


def row(lane, utilization, reset=_MISSING):
    # Sentinel default: an explicitly-passed None/""/True must reach the
    # parser (and refuse), not fall back to the lane's valid reset.
    return {"lane": lane, "weekly_utilization": utilization,
            "weekly_reset_utc": RESETS[lane] if reset is _MISSING else reset}


def by_lane(rows):
    return {r["lane"]: r for r in rows}


class FixtureTest(unittest.TestCase):
    def test_fixture_is_present_and_has_three_codex_lanes(self):
        self.assertTrue(os.path.exists(FIXTURE),
                        "fixture %s is missing -- §1 is the headline case "
                        "and must never silently skip" % FIXTURE)
        with open(FIXTURE, encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual(len(doc["lanes"]), 3)
        for entry in doc["lanes"]:
            self.assertIn("codex", entry["lane"])
            self.assertEqual(entry["weekly_reset_utc"], RESETS[entry["lane"]])
        self.assertEqual(
            sorted(e["weekly_utilization"] for e in doc["lanes"]),
            [0.71, 0.88, 1.0])


class HeadroomMathTest(unittest.TestCase):
    """§1: headroom is (1 - u) * 100 against the live rows."""

    def test_three_rows_keep_identity_order_with_own_resets(self):
        rows = assemble_rows(lanes(UTILS), NOW)
        self.assertEqual([r["lane"] for r in rows],
                         ["codex-lane-1", "codex-lane-2", "codex-lane-3"])
        heads = by_lane(rows)
        self.assertAlmostEqual(heads["codex-lane-1"]["headroomPct"], 29.0)
        self.assertAlmostEqual(heads["codex-lane-2"]["headroomPct"], 12.0)
        self.assertAlmostEqual(heads["codex-lane-3"]["headroomPct"], 0.0)
        # Per-lane resets, not one snapped instant: 371565 / 371649 /
        # 371570 s from NOW.
        self.assertAlmostEqual(heads["codex-lane-1"]["hoursToReset"],
                               103.2125)
        self.assertAlmostEqual(heads["codex-lane-2"]["hoursToReset"],
                               103.235833, places=5)
        self.assertAlmostEqual(heads["codex-lane-3"]["hoursToReset"],
                               103.213889, places=5)
        for r in rows:
            self.assertEqual(r["resetsAt"], RESETS[r["lane"]])

    def test_hours_to_reset_is_fractional_not_truncated(self):
        now = datetime.datetime(2026, 10, 7, 10, 49, 9, tzinfo=UTC)
        rows = assemble_rows([row("codex-lane-2", 0.5)], now)
        self.assertAlmostEqual(rows[0]["hoursToReset"], 25 / 60.0)

    def test_display_sorts_thinnest_first_without_mutating_input(self):
        rows = assemble_rows(lanes(UTILS), NOW)
        before = [r["lane"] for r in rows]
        table = format_table(rows)
        body = table.splitlines()[1:]
        self.assertTrue(body[0].startswith("codex-lane-3"))
        self.assertTrue(body[1].startswith("codex-lane-2"))
        self.assertTrue(body[2].startswith("codex-lane-1"))
        self.assertEqual([r["lane"] for r in rows], before)
        self.assertIn("0.0%", body[0])
        self.assertIn("29.0%", body[2])


class RefuseDishonestRowsTest(unittest.TestCase):
    """§2: missing/non-finite/out-of-range utilization is refused, never
    zero-substituted. Every case names the lane."""

    def test_missing_utilization_is_refused(self):
        with self.assertRaises(CountdownError) as ctx:
            assemble_rows([{"lane": "codex-lane-1",
                            "weekly_reset_utc": RESETS["codex-lane-1"]}],
                          NOW)
        self.assertIn("codex-lane-1", str(ctx.exception))

    def test_null_utilization_is_refused_not_zero(self):
        with self.assertRaises(CountdownError):
            assemble_rows([row("codex-lane-1", None)], NOW)

    def test_string_utilization_is_refused(self):
        with self.assertRaises(CountdownError):
            assemble_rows([row("codex-lane-1", "0.4")], NOW)

    def test_nan_and_inf_utilization_are_refused(self):
        for bad in (float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(CountdownError):
                assemble_rows([row("codex-lane-1", bad)], NOW)

    def test_out_of_range_utilization_is_refused(self):
        for bad in (-0.01, 1.01):
            with self.assertRaises(CountdownError):
                assemble_rows([row("codex-lane-1", bad)], NOW)

    def test_bool_utilization_is_refused(self):
        with self.assertRaises(CountdownError):
            assemble_rows([row("codex-lane-1", True)], NOW)

    def test_missing_lane_name_is_refused(self):
        with self.assertRaises(CountdownError):
            assemble_rows([{"weekly_utilization": 0.5,
                            "weekly_reset_utc": RESETS["codex-lane-1"]}],
                          NOW)

    def test_duplicate_lane_is_refused(self):
        with self.assertRaises(CountdownError) as ctx:
            assemble_rows([row("codex-lane-1", 0.1),
                           row("codex-lane-1", 0.2)], NOW)
        self.assertIn("codex-lane-1", str(ctx.exception))

    def test_refused_rows_leave_no_partial_output(self):
        with self.assertRaises(CountdownError):
            assemble_rows([row("codex-lane-1", 0.1),
                           row("codex-lane-2", None)], NOW)


class ResetHonestyTest(unittest.TestCase):
    """§3: an unreadable or already-past reset is refused."""

    def test_missing_reset_is_refused(self):
        with self.assertRaises(CountdownError):
            assemble_rows([{"lane": "codex-lane-1",
                            "weekly_utilization": 0.5}], NOW)

    def test_unparseable_reset_is_refused(self):
        for bad in ("tomorrow", "2026-10-07", True, None, ""):
            with self.assertRaises(CountdownError):
                assemble_rows([row("codex-lane-1", 0.5, reset=bad)], NOW)

    def test_past_reset_is_refused_not_zero_hours(self):
        with self.assertRaises(CountdownError) as ctx:
            assemble_rows([row("codex-lane-1", 0.5,
                               reset="2026-10-03T03:00:00Z")], NOW)
        self.assertIn("codex-lane-1", str(ctx.exception))

    def test_reset_exactly_at_now_is_refused(self):
        with self.assertRaises(CountdownError):
            assemble_rows([row("codex-lane-1", 0.5,
                               reset="2026-10-03T04:00:00Z")], NOW)

    def test_reset_one_second_after_now_is_live(self):
        rows = assemble_rows([row("codex-lane-1", 0.5,
                                  reset="2026-10-03T04:00:01Z")], NOW)
        self.assertAlmostEqual(rows[0]["hoursToReset"], 1 / 3600.0)


class NoAveragingTest(unittest.TestCase):
    """§4: lanes in one weekly window are never merged, and their distinct
    resets are never snapped to one headline instant."""

    def test_one_window_still_emits_one_row_per_lane(self):
        rows = assemble_rows(lanes(UTILS), NOW)
        self.assertEqual(len(rows), 3)
        heads = sorted(r["headroomPct"] for r in rows)
        self.assertAlmostEqual(heads[0], 0.0)
        self.assertAlmostEqual(heads[-1], 29.0)
        self.assertNotAlmostEqual(sum(heads) / 3, heads[0])

    def test_per_lane_resets_are_honored_not_snapped_to_shared(self):
        rows = assemble_rows(lanes(UTILS), NOW)
        got = by_lane(rows)
        # Lanes 1 and 2 differ by 84 s; a snapped instant would read equal.
        self.assertNotAlmostEqual(got["codex-lane-1"]["hoursToReset"],
                                  got["codex-lane-2"]["hoursToReset"])
        self.assertAlmostEqual(
            got["codex-lane-2"]["hoursToReset"]
            - got["codex-lane-1"]["hoursToReset"], 84 / 3600.0)


class ClockHonestyTest(unittest.TestCase):
    """§5: the CLI renders against the real clock, not the fixture."""

    def test_no_now_flag_ignores_fixture_observed_at(self):
        # The fixture's observedAt is six years stale. A reader that pins
        # "now" to it would print 2020 in the header and present ancient
        # rows as current — a stale-data failure. The readout must render
        # against the real clock instead.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "stale-observed.json")
            live_reset = (datetime.datetime.now(UTC)
                          + datetime.timedelta(hours=48)).strftime(
                              "%Y-%m-%dT%H:%M:%SZ")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"observedAt": "2020-01-01T00:00:00Z",
                           "lanes": [row("codex-lane-1", 0.5,
                                         reset=live_reset)]},
                          fh)
            proc = subprocess.run(
                [sys.executable, READOUT, "--fixture", path],
                capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("2020-01-01", proc.stdout)
        self.assertIn("codex-lane-1", proc.stdout)

    def test_explicit_now_renders_the_fixture(self):
        proc = subprocess.run(
            [sys.executable, READOUT, "--json",
             "--now", "2026-10-03T04:00:00Z"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = json.loads(proc.stdout)
        self.assertEqual(len(rows), 3)
        self.assertAlmostEqual(by_lane(rows)["codex-lane-3"]
                               ["headroomPct"], 0.0)

    def test_table_mode_prints_three_lanes_thinnest_first(self):
        proc = subprocess.run(
            [sys.executable, READOUT,
             "--now", "2026-10-03T04:00:00Z"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.splitlines()
        self.assertIn("Codex weekly countdown", lines[0])
        self.assertEqual(len(lines), 1 + 1 + 3)
        self.assertTrue(lines[2].startswith("codex-lane-3"))
        self.assertTrue(lines[-1].startswith("codex-lane-1"))

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

    def test_one_minute_before_earliest_reset_still_renders(self):
        now = datetime.datetime(2026, 10, 7, 11, 11, 45, tzinfo=UTC)
        rows = assemble_rows(lanes(UTILS), now)
        self.assertAlmostEqual(by_lane(rows)["codex-lane-1"]
                               ["hoursToReset"], 1 / 60.0)

    def test_past_all_resets_every_lane_refuses(self):
        now = datetime.datetime(2026, 10, 7, 11, 15, 0, tzinfo=UTC)
        with self.assertRaises(CountdownError):
            assemble_rows(lanes(UTILS), now)

    def test_straddling_now_refuses_the_expired_lane_not_partial_rows(self):
        # 11:13:00Z is past lane-1's reset but before lanes 2/3. The whole
        # assembly refuses — one expired window never yields two live rows
        # beside a silent gap.
        now = datetime.datetime(2026, 10, 7, 11, 13, 0, tzinfo=UTC)
        with self.assertRaises(CountdownError) as ctx:
            assemble_rows(lanes(UTILS), now)
        self.assertIn("codex-lane-1", str(ctx.exception))


class CodexDeltaTest(unittest.TestCase):
    """§7: the Codex deltas against the Muse pattern — 1.0 is FULL (renders
    0.0%, never refused) and 0.0 is EMPTY (renders 100%, never refused)."""

    def test_full_utilization_renders_zero_headroom(self):
        rows = assemble_rows([row("codex-lane-3", 1.0)], NOW)
        self.assertAlmostEqual(rows[0]["headroomPct"], 0.0)
        self.assertAlmostEqual(rows[0]["weeklyUtilization"], 1.0)

    def test_empty_utilization_renders_full_headroom(self):
        rows = assemble_rows([row("codex-lane-1", 0.0)], NOW)
        self.assertAlmostEqual(rows[0]["headroomPct"], 100.0)

    def test_exhausted_lane_still_sorts_thinnest_first(self):
        table = format_table(assemble_rows(lanes(UTILS), NOW))
        body = table.splitlines()[1:]
        self.assertIn("100.0%", body[0])
        self.assertIn("0.0%", body[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
