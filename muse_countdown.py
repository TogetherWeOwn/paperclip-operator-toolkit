#!/usr/bin/env python3
# ===========================================================================
# muse_countdown.py — Muse-lane use-before-expiry countdown readout
#
# SCOPE: read-only. Per each of the 8 Muse weekly lanes, show remaining
# weekly headroom % and hours-to-reset against the shared weekly reset
# (2026-10-05T00:00:00Z), from a JSON fixture through a pure
# assemble/display function. No roster writes, no pin changes, no enforce
# flip — importing or running this module changes no pacing behaviour.
#
# The assembled row shape ({lane, headroomPct, hoursToReset} plus provenance
# extras) matches the watchdog `quotaLanes` contract the quota_expiry
# detector consumes, so this is its read-only feeder: same field names, no
# shared code, no write path between them.
#
# WHAT THIS REFUSES, AND WHY
#   * Missing, non-numeric, NaN/Inf, or out-of-[0,1] utilization is a
#     CountdownError naming the lane — never substituted with zero. A null
#     reading scored as zero would print 100% headroom on a lane that may be
#     exhausted (the `[[ "" -eq 0 ]]` bash trap the cold-start detector
#     exists for, in another costume).
#   * A missing, unparseable, or already-past reset is a CountdownError, not
#     "0 hours left". Numbers that describe a window that is over are the
#     past-reset failure.
#   * Lanes are never averaged: eight lanes sharing one reset instant still
#     emit eight rows, each from its own utilization. A mean would hide the
#     thinnest lane, which is the one the countdown exists to surface.
#   * Duplicate lane names are refused: two rows for one lane would let a
#     stale row shadow the live one in the display sort.
#
# EXIT CODES (cli)
#   0  readout printed
#   2  usage / validation: bad fixture, bad --now, or a refused lane row
#
# Read-only. Opens one JSON fixture, prints to stdout. No network, no
# credential, no roster read, no file written.
# ===========================================================================
from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import sys

UTC = datetime.timezone.utc

# The weekly reset every Muse lane in the fixture shares. Pinned here so the
# display sort and the tests name the same instant; a fixture row carrying a
# different reset is still honored per-row (it is that lane's truth), but the
# card's countdown question is answered against this instant.
WEEKLY_RESET_UTC = "2026-10-05T00:00:00Z"

EXPECTED_LANE_COUNT = 8

_TS_FORMATS = ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ")


class CountdownError(ValueError):
    """A lane row (or clock/fixture) that cannot be rendered honestly."""


def parse_ts(value):
    """Strict UTC instant or None. No offsetless or free-text timestamps."""
    if not isinstance(value, str) or not value:
        return None
    for fmt in _TS_FORMATS:
        try:
            return datetime.datetime.strptime(value, fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


def _lane_utilization(row):
    lane = row.get("lane") if isinstance(row, dict) else None
    name = lane if isinstance(lane, str) and lane else "?"
    if not isinstance(row, dict):
        raise CountdownError("lane %s: row is not an object" % name)
    if not isinstance(lane, str) or not lane:
        raise CountdownError("lane ?: missing or empty lane name")
    raw = row.get("weekly_utilization")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) \
            or not math.isfinite(raw):
        raise CountdownError(
            "lane %s: weekly_utilization is not a finite number" % lane)
    if raw < 0 or raw > 1:
        raise CountdownError(
            "lane %s: weekly_utilization %r outside [0, 1]" % (lane, raw))
    return lane, float(raw)


def _lane_reset(row, lane, now):
    raw = row.get("weekly_reset_utc")
    reset = parse_ts(raw)
    if reset is None:
        raise CountdownError(
            "lane %s: weekly_reset_utc %r is not a UTC "
            "YYYY-MM-DDTHH:MM:SSZ instant" % (lane, raw))
    if reset <= now:
        raise CountdownError(
            "lane %s: weekly_reset_utc %s is not after now %s -- the "
            "window is over, its numbers describe nothing" % (
                lane, raw, now.strftime("%Y-%m-%dT%H:%M:%SZ")))
    return reset, raw if isinstance(raw, str) else reset.strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def assemble_rows(lanes, now):
    """Pure: one countdown row per lane. Input order preserved; no sorting,
    no averaging, no I/O. Raises CountdownError on the first dishonest row."""
    if not isinstance(lanes, list):
        raise CountdownError("lanes is not an array")
    if not isinstance(now, datetime.datetime):
        raise CountdownError("now is not a datetime")
    seen = set()
    rows = []
    for entry in lanes:
        lane, utilization = _lane_utilization(entry)
        if lane in seen:
            raise CountdownError("lane %s: duplicate lane row" % lane)
        seen.add(lane)
        reset, reset_raw = _lane_reset(entry, lane, now)
        headroom_pct = (1.0 - utilization) * 100.0
        hours_to_reset = (reset - now).total_seconds() / 3600.0
        rows.append({
            "lane": lane,
            "weeklyUtilization": utilization,
            "headroomPct": headroom_pct,
            "hoursToReset": hours_to_reset,
            "resetsAt": reset_raw,
        })
    return rows


def format_table(rows):
    """Pure display: fixed-width table, thinnest headroom first (the
    use-before-expiry order). Sorts a copy; the input list is untouched."""
    ordered = sorted(rows, key=lambda r: (r["headroomPct"], r["lane"]))
    lines = ["%-14s %7s %9s %12s %s" % (
        "lane", "used%", "headroom%", "hours-left", "resets-at")]
    for row in ordered:
        lines.append("%-14s %6.1f%% %8.1f%% %12.2f %s" % (
            row["lane"], row["weeklyUtilization"] * 100.0,
            row["headroomPct"], row["hoursToReset"], row["resetsAt"]))
    return "\n".join(lines) + "\n"


def load_fixture(path):
    """Read the fixture file. The only I/O in this module."""
    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    if not isinstance(doc, dict) or not isinstance(doc.get("lanes"), list):
        raise CountdownError(
            "fixture %s has no lanes array" % path)
    return doc


def main(argv=None):
    default_fixture = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "tests", "fixtures", "weekly-lanes-synthetic", "muse-weekly-lanes.json")
    p = argparse.ArgumentParser(
        description="Muse-lane use-before-expiry countdown readout "
                    "(read-only).")
    p.add_argument("--fixture", default=default_fixture)
    p.add_argument("--now",
                   help="override current UTC time (testing), e.g. "
                        "2026-10-03T02:01:00Z")
    p.add_argument("--json", action="store_true",
                   help="emit the assembled rows as JSON instead of the "
                        "human table")
    a = p.parse_args(argv)

    if a.now is not None:
        now = parse_ts(a.now)
        if now is None:
            p.error("--now must be UTC in YYYY-MM-DDTHH:MM:SSZ form")
    else:
        now = datetime.datetime.now(UTC).replace(microsecond=0)

    try:
        doc = load_fixture(a.fixture)
        rows = assemble_rows(doc["lanes"], now)
    except (OSError, json.JSONDecodeError) as exc:
        print("muse_countdown: cannot read fixture: %s" % exc,
              file=sys.stderr)
        return 2
    except CountdownError as exc:
        print("muse_countdown: refused: %s" % exc, file=sys.stderr)
        return 2

    if a.json:
        print(json.dumps(rows, indent=2, sort_keys=True))
    else:
        print("Muse weekly countdown (reset %s, now %s, %d lanes)" % (
            WEEKLY_RESET_UTC, now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            len(rows)))
        print(format_table(rows), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
