#!/usr/bin/env python3
# ===========================================================================
# codex_countdown.py — Codex-lane use-before-expiry countdown readout
# (mirror of the Muse and Claude lane readouts; no shared code)
#
# SCOPE: read-only. Per each of the 3 Codex weekly lanes, show remaining
# weekly headroom % and hours-to-reset, from a JSON fixture through a pure
# assemble/display function. No roster writes, no pin changes, no enforce
# flip — importing or running this module changes no pacing behaviour.
#
# DELTAS FROM THE MUSE PATTERN (deliberate, all pinned by tests):
#   * 3 lanes, not 8.
#   * No single shared reset instant: the three committed Codex rows reset
#     seconds apart (11:12:45 / 11:14:09 / 11:12:50 on 2026-10-07), so there
#     is no WEEKLY_RESET_UTC constant and the header names no reset — each
#     row's own resetsAt is that lane's truth, and the per-lane test pins
#     three distinct hours-left values (the Muse "honored not snapped"
#     case, which here is the headline, not the edge).
#   * codex-lane-3 sits at utilization 1.0 (exhausted, per the committed
#     snapshot's own health label). 1.0 is full, not dishonest: it renders
#     as 0.0% headroom, never refused. Only < 0 or > 1 is refused.
#   * The unused EXPECTED_LANE_COUNT constant the Muse module declares is
#     dropped here — nothing reads it there either.
#
# WHAT THIS REFUSES, AND WHY (same contract as the Muse readout)
#   * Missing, non-numeric, NaN/Inf, or out-of-[0,1] utilization is a
#     CountdownError naming the lane — never substituted with zero. A null
#     reading scored as zero would print 100% headroom on a lane that may be
#     exhausted (the `[[ "" -eq 0 ]]` bash trap the cold-start detector
#     exists for, in another costume).
#   * A missing, unparseable, or already-past reset is a CountdownError, not
#     "0 hours left". Numbers that describe a window that is over are a
#     stale-data failure presented as current.
#   * Lanes are never averaged: rows sharing one weekly window still emit
#     one row per lane. A mean would hide the thinnest lane, which is the
#     one the countdown exists to surface.
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
        "tests", "fixtures", "weekly-lanes-synthetic",
        "codex-weekly-lanes.json")
    p = argparse.ArgumentParser(
        description="Codex-lane use-before-expiry countdown readout "
                    "(read-only).")
    p.add_argument("--fixture", default=default_fixture)
    p.add_argument("--now",
                   help="override current UTC time (testing), e.g. "
                        "2026-10-03T04:00:00Z")
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
        print("codex_countdown: cannot read fixture: %s" % exc,
              file=sys.stderr)
        return 2
    except CountdownError as exc:
        print("codex_countdown: refused: %s" % exc, file=sys.stderr)
        return 2

    if a.json:
        print(json.dumps(rows, indent=2, sort_keys=True))
    else:
        # No single shared reset to name here (see module header): the
        # per-lane resets-at column below is each lane's truth.
        print("Codex weekly countdown (now %s, %d lanes)" % (
            now.strftime("%Y-%m-%dT%H:%M:%SZ"), len(rows)))
        print(format_table(rows), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
