#!/usr/bin/env python3
# ===========================================================================
# test_process_lost_probe.py — hostile tests for the process_lost probe.
#
# These are written to FAIL a plausible-but-wrong implementation, not to
# confirm the one that exists. Each section names the specific shortcut a
# reimplementation would take, and is the only check that can see it:
#
#   §1  classify on the error MESSAGE instead of the errorCode -> §1 red
#   §2  infer the crash cause from run rows                   -> §2 red
#   §3  merge every process_lost row into one burst           -> §3 red
#   §4  treat dateless rows as verdicts or silent passes      -> §4 red
#   §5  mis-rank exit codes / post on a clean window          -> §5 red
#
# Fixtures mirror the recorded incidents: one date reaps 61 in-flight runs at
# once after a pipe-break crash; another reaps ~20 after a spawner memory
# exhaustion. Neither cause is visible in the rows, and the probe must not
# claim otherwise.
# ===========================================================================

import json
import os
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone

import process_lost_probe as mod

HERE = os.path.dirname(os.path.abspath(__file__))

BASE = datetime(2026, 10, 2, 0, 30, 0, tzinfo=timezone.utc)

CANONICAL_TEXT = "Process lost -- server may have restarted"


def run(minute, status="failed", agent="agent-a", code=None, error=None,
        issue=None, second=0):
    """One run record, reaped at BASE + minute."""
    stamp = (BASE + timedelta(minutes=minute, seconds=second)).isoformat()
    stamp = stamp.replace("+00:00", "Z")
    snap = {"issueId": issue} if issue else {}
    return {
        "id": f"{agent}-{minute}-{second}-{status}",
        "agentId": agent,
        "status": status,
        "errorCode": code,
        "error": error,
        "createdAt": stamp,
        "finishedAt": stamp if status in ("succeeded", "failed") else None,
        "contextSnapshot": snap,
    }


def lost(minute, **kw):
    kw.setdefault("code", "process_lost")
    kw.setdefault("error", CANONICAL_TEXT)
    return run(minute, **kw)


def bursts(runs, **kw):
    return mod.probe(runs, **kw)["bursts"]


class ErrorCodeIsTheClassifier(unittest.TestCase):
    """§1 The errorCode is the signal; the message only corroborates.
    A row carrying the canonical message under a different errorCode is a
    different phenomenon and stays out of scope."""

    def test_canonical_message_without_code_is_not_process_lost(self):
        self.assertFalse(
            mod.is_process_lost(
                run(5, code="orphaned_running_run", error=CANONICAL_TEXT)))

    def test_code_without_message_still_counts(self):
        self.assertTrue(
            mod.is_process_lost(run(5, code="process_lost", error=None)))

    def test_message_alone_produces_no_burst(self):
        runs = [run(m, code="orphaned_running_run", error=CANONICAL_TEXT)
                for m in (1, 2, 3, 4)]
        result = mod.probe(runs)
        self.assertEqual(result["verdict"], "SILENT")
        self.assertEqual(result["bursts"], [])

    def test_other_codes_are_silent(self):
        runs = [run(m, code="adapter_failed", error="Adapter failed")
                for m in range(4)]
        self.assertEqual(mod.worst_exit(mod.probe(runs)),
                         mod.EXIT_SILENT)


class RowsNeverProveCause(unittest.TestCase):
    """§2 Both recorded crash shapes present identically here. The probe
    reports reap bursts, never a cause."""

    def test_epipe_shaped_rows_are_just_a_burst(self):
        rows = [lost(m, agent=f"agent-{m}") for m in range(61)]
        result = mod.probe(rows)
        self.assertEqual(result["verdict"], "RECURRENCE")
        self.assertEqual(len(result["bursts"]), 1)
        self.assertEqual(result["bursts"][0]["size"], 61)
        blob = json.dumps(result)
        self.assertNotIn("EPIPE", blob)
        self.assertNotIn("OOM", blob)

    def test_oom_shaped_rows_are_just_a_burst(self):
        rows = [lost(m, agent=f"agent-{m}") for m in range(20)]
        result = mod.probe(rows)
        self.assertEqual(result["verdict"], "RECURRENCE")
        blob = json.dumps(result)
        self.assertNotIn("hook", blob.lower())
        self.assertNotIn("memory", blob.lower())

    def test_no_cause_field_leaks_into_describe(self):
        b = bursts([lost(1), lost(2)])[0]
        self.assertEqual(
            set(b),
            {"size", "first_reaped", "last_reaped", "duration_minutes",
             "agents", "issues", "statuses", "canonical_message_rows"})

    def test_no_cause_key_in_describe(self):
        b = bursts([lost(1), lost(5, agent="agent-b")])[0]
        self.assertNotIn("cause", b)
        self.assertNotIn("cause", json.dumps(b).lower().replace(
            "canonical_message_rows", ""))


class BurstGrouping(unittest.TestCase):
    """§3 Two bursts a day apart are two crashes, not one multi-day outage.
    Lumping them reports a single enormous burst."""

    DAY = datetime(2026, 10, 3, 19, 20, 0, tzinfo=timezone.utc)

    def day_row(self, minute, **kw):
        stamp = (self.DAY + timedelta(minutes=minute)).isoformat()
        stamp = stamp.replace("+00:00", "Z")
        row = lost(0, **kw)
        row["createdAt"] = stamp
        row["finishedAt"] = stamp
        row["id"] = f"day-{minute}"
        return row

    def test_crashes_a_day_apart_are_separate_bursts(self):
        rows = ([lost(m) for m in (0, 1, 2)]
                + [self.day_row(m) for m in (0, 1, 2)])
        self.assertEqual(len(bursts(rows)), 2)

    def test_reaps_inside_the_gap_are_one_burst(self):
        rows = [lost(m) for m in (0, 14)]
        self.assertEqual(len(bursts(rows)), 1)

    def test_gap_boundary_is_exclusive_at_the_threshold(self):
        rows = [lost(0), lost(15)]
        self.assertEqual(len(bursts(rows, gap_minutes=15)), 2)


class TimestampsAreLoadBearing(unittest.TestCase):
    """§4 A process_lost row with no readable timestamp is unknown, never
    a verdict and never a silent pass."""

    def test_dateless_rows_are_insufficient_not_silent(self):
        row = lost(5)
        del row["finishedAt"]
        del row["createdAt"]
        result = mod.probe([row])
        self.assertEqual(result["verdict"], "INSUFFICIENT")
        self.assertEqual(result["process_lost_rows"], 1)
        self.assertEqual(result["bursts"], [])

    def test_unparseable_stamp_is_insufficient(self):
        row = lost(5)
        row["finishedAt"] = "not-a-time"
        row["createdAt"] = "not-a-time"
        self.assertEqual(mod.probe([row])["verdict"], "INSUFFICIENT")

    def test_dated_rows_still_burst_when_mixed_with_dateless(self):
        dateless = lost(5)
        del dateless["finishedAt"]
        del dateless["createdAt"]
        rows = [lost(1), lost(2), dateless]
        result = mod.probe(rows)
        self.assertEqual(result["verdict"], "RECURRENCE")
        self.assertEqual(result["bursts"][0]["size"], 2)


class ExitCodesAndSilence(unittest.TestCase):
    """§5 A monitor that posts on a clean window trains everyone to ignore
    it. Exit 0 must mean silence, and RECURRENCE must win."""

    def test_clean_window_is_silent(self):
        runs = [run(m, status="succeeded", agent="a") for m in range(5)]
        result = mod.probe(runs)
        self.assertEqual(result["verdict"], "SILENT")
        self.assertEqual(result["bursts"], [])
        self.assertEqual(mod.worst_exit(result), 0)

    def test_each_verdict_maps_to_its_documented_code(self):
        self.assertEqual(mod.worst_exit({"verdict": "SILENT"}), 0)
        self.assertEqual(mod.worst_exit({"verdict": "RECURRENCE"}), 2)
        self.assertEqual(mod.worst_exit({"verdict": "INSUFFICIENT"}), 3)

    def test_cli_reports_recurrence_on_a_burst(self):
        rows = [lost(1), lost(2)]
        result = subprocess.run(
            [sys.executable, "-B", os.path.join(HERE, "process_lost_probe.py"),
             "--input", "-", "--json"], input=json.dumps(rows), text=True,
            capture_output=True, timeout=10,
            env={"PATH": os.environ.get("PATH", "")},
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["verdict"], "RECURRENCE")

    def test_cli_is_silent_on_a_clean_window(self):
        rows = [run(m, status="succeeded", agent="a") for m in range(3)]
        result = subprocess.run(
            [sys.executable, "-B", os.path.join(HERE, "process_lost_probe.py"),
             "--input", "-", "--json"], input=json.dumps(rows), text=True,
            capture_output=True, timeout=10,
            env={"PATH": os.environ.get("PATH", "")},
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["verdict"], "SILENT")

    def test_cli_rejects_a_bad_gap(self):
        rows = [lost(1)]
        result = subprocess.run(
            [sys.executable, "-B", os.path.join(HERE, "process_lost_probe.py"),
             "--input", "-", "--gap-minutes", "0"],
            input=json.dumps(rows), text=True,
            capture_output=True, timeout=10,
            env={"PATH": os.environ.get("PATH", "")},
        )
        self.assertEqual(result.returncode, 1)

    def test_invalid_input_is_usage_not_a_verdict(self):
        result = subprocess.run(
            [sys.executable, "-B", os.path.join(HERE, "process_lost_probe.py"),
             "--input", "-"], input="not json", text=True,
            capture_output=True, timeout=10,
            env={"PATH": os.environ.get("PATH", "")},
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("no verdict", result.stderr)


class SinceWindow(unittest.TestCase):
    def test_since_excludes_older_bursts(self):
        rows = [lost(0), lost(1), lost(120), lost(121)]
        since = (BASE + timedelta(minutes=60)).isoformat()
        since = since.replace("+00:00", "Z")
        result = mod.probe(rows, since=mod.parse_ts(since))
        self.assertEqual(len(result["bursts"]), 1)
        self.assertEqual(result["bursts"][0]["size"], 2)

    def test_since_past_everything_is_silent(self):
        rows = [lost(0), lost(1)]
        since = (BASE + timedelta(days=1)).isoformat()
        since = since.replace("+00:00", "Z")
        result = mod.probe(rows, since=mod.parse_ts(since))
        self.assertEqual(result["verdict"], "SILENT")


if __name__ == "__main__":
    unittest.main()
