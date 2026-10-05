#!/usr/bin/env python3
# ===========================================================================
# garm_provider_latency_baseline.py — record and check GARM provider
# operation latency against a checked-in baseline
#
# SCOPE. This tool baselines PROVIDER OPERATION latency only: how long the
# GARM provider takes to execute an instance create or delete, measured from
# GARM API read metadata (instance request timestamps vs. terminal-state
# timestamps) or operator-supplied samples in the same shape. It does NOT
# cover pool health, reaper TTL, queue wait, job
# duration, or runner registration lag. Those are separate instruments; a
# breach here means "the provider is slow", never "the pool is empty".
#
# SOURCE-ONLY AND READ-ONLY. This script never contacts GARM, GitHub, or any
# host. It reads exactly two files it is explicitly given (a samples file and
# a baseline file) and writes only the baseline file on `record`. There is no
# network, no credential, no host command, no discovery. Sample collection
# from live API metadata is an operator step documented in
# docs/garm-provider-latency-baseline.md, not a function in this file.
#
# WHY NEAREST-RANK. p50/p95 here use the nearest-rank method
# (rank = ceil(p/100 * n) on ascending 1-indexed sorted data) because it is
# exact on small samples and needs no interpolation convention. The test
# suite pins 1..100 -> p50=50, p95=95; an off-by-one rank reads 51/96 and
# goes red. Do not "improve" this to linear interpolation without updating
# the baseline arithmetic and the pinned cases together.
#
# WHY DUPLICATES ARE DATA. Real latency samples repeat (quantized provider
# timestamps, identical VM sizes). A validator that rejects duplicate
# durations silently drops the densest part of the distribution and biases
# every percentile. Duplicates are accepted; only shape violations refuse.
#
# WHY AN UPPER BOUND EXISTS. Operator samples are milliseconds. A sample
# above six hours is not a slow VM, it is a unit error (seconds or
# microseconds filed as milliseconds) or a clock-skew artifact from the
# metadata export. Refusing it protects the baseline from one bad export
# moving p95 by an order of magnitude. The bound is deliberately loose: any
# real provider operation that takes over six hours is a pool outage, and an
# outage is a separate incident, not a baseline row.
#
# TRI-STATE CHECK. `check` answers three ways, never two:
#   0  OK      — enough samples, all operations within thresholds
#   2  BREACH  — enough samples, an operation exceeds a threshold
#   3  UNKNOWN — baseline missing/provisional, or samples empty/unreadable.
#                UNKNOWN is not permission to page and not permission to
#                relax: it means the instrument has no standing, so the
#                decision must be made on something else and SAID so.
# A baseline with fewer than MIN_SAMPLES_PER_OP samples per operation is
# PROVISIONAL: `record` writes it, `check` refuses to verdict on it (exit 3).
# A provisional threshold that pages is the same false green as a dead feed
# reading quiet — both report confidence the data cannot support.
#
# EXIT CODES
#   0  recorded / checked OK
#   1  usage or validation failure (bad shape, bad value, write failed)
#   2  threshold breach (`check` only)
#   3  UNKNOWN (`check` only: missing/provisional baseline, no samples)
#
# Read-only except `record`/`init`, which write only the baseline path given
# on argv. Standard library only. Deterministic under `--now`.
# ===========================================================================
import argparse
import json
import math
import sys
from datetime import datetime, timezone

SAMPLES_SCHEMA = "garm-provider-latency-samples.v1"
BASELINE_SCHEMA = "garm-provider-latency-baseline.v1"
MAX_BYTES = 1024 * 1024
OPERATIONS = ("create", "delete")
MIN_SAMPLES_PER_OP = 10
MAX_SAMPLES_PER_OP = 2000
# Anything slower than this filed as milliseconds is a unit/clock error, not
# a slow provider. Six hours in milliseconds. See header.
MAX_DURATION_MS = 6 * 60 * 60 * 1000

# Seed thresholds (milliseconds). NO live provider sample stands behind
# these numbers: the GARM fleet has not migrated yet, so there is nothing to
# measure. Each seed is a round number set deliberately ABOVE the physical
# floor of the operation it guards, and each is marked provisional until the
# first recalibration (see docs/garm-provider-latency-baseline.md).
#
# create: provider API call + image boot + cloud-init + runner registration
# is minutes-scale even healthy. p50 alert at 10 min, p95 at 20 min: a median
# create slower than 10 minutes means the typical path — not the tail — is
# sick, and a 5% tail past 20 minutes means one job in twenty waits a full
# CI budget on provisioning alone.
# delete: API call + VM destroy is seconds-to-low-minutes. p50 alert at
# 2 min, p95 at 5 min: deletes have no boot phase, so any median above two
# minutes is provider distress, and a tail past five minutes predicts
# destroy pile-up, which is what the reaper then has to absorb.
PROPOSED_THRESHOLDS_MS = {
    "create": {
        "p50_alert_ms": 10 * 60 * 1000,
        "p95_alert_ms": 20 * 60 * 1000,
        "rationale": (
            "Seed: create spans provider API, image boot, cloud-init and "
            "runner registration (minutes-scale healthy). Median past "
            "10 min means the typical path is sick; 5% tail past 20 min "
            "spends a full CI budget on provisioning. Recalibrate after "
            "the first 30 live create samples."
        ),
    },
    "delete": {
        "p50_alert_ms": 2 * 60 * 1000,
        "p95_alert_ms": 5 * 60 * 1000,
        "rationale": (
            "Seed: delete is API call plus VM destroy with no boot phase "
            "(seconds-to-low-minutes healthy). Median past 2 min is "
            "provider distress; tail past 5 min predicts destroy "
            "pile-up for the reaper. Recalibrate after the first 30 "
            "live delete samples."
        ),
    },
}


class InvalidInput(ValueError):
    pass


def _reject(message):
    raise InvalidInput(message)


def _read_json(path, what):
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_BYTES + 1)
    except OSError as exc:
        _reject("%s unreadable: %s" % (what, exc))
    if len(raw) > MAX_BYTES:
        _reject("%s exceeds %d bytes" % (what, MAX_BYTES))
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        _reject("%s is not UTF-8 JSON" % what)


def _duration_ms(value, index):
    # bool is an int subclass; True == 1 would otherwise pass as 1 ms.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _reject("samples[%d].duration_ms: number required" % index)
    if not math.isfinite(value) or value < 0:
        _reject("samples[%d].duration_ms: finite value >= 0 required" % index)
    if value > MAX_DURATION_MS:
        _reject("samples[%d].duration_ms: exceeds 6h, refusing unit/clock "
                "error" % index)
    return value


def parse_samples(doc):
    """Validate an operator-supplied samples document.

    Returns {operation: [duration_ms, ...]} preserving duplicates and order.
    Raises InvalidInput on any shape violation.
    """
    if type(doc) is not dict:
        _reject("samples: object required")
    if doc.get("schema") != SAMPLES_SCHEMA:
        _reject("samples: schema must be %s" % SAMPLES_SCHEMA)
    rows = doc.get("samples")
    if type(rows) is not list or not rows:
        _reject("samples.samples: non-empty array required")
    if len(rows) > 2 * MAX_SAMPLES_PER_OP:
        _reject("samples.samples: exceeds %d rows" % (2 * MAX_SAMPLES_PER_OP))
    grouped = {op: [] for op in OPERATIONS}
    for index, row in enumerate(rows):
        if type(row) is not dict:
            _reject("samples[%d]: object required" % index)
        if set(row) != {"operation", "duration_ms"}:
            _reject("samples[%d]: exactly {operation, duration_ms} "
                    "required" % index)
        if row["operation"] not in OPERATIONS:
            _reject("samples[%d].operation: must be create or delete"
                    % index)
        grouped[row["operation"]].append(_duration_ms(row["duration_ms"],
                                                      index))
    return grouped


def percentile(sorted_values, pct):
    """Nearest-rank percentile over ascending sorted values (non-empty)."""
    if not sorted_values:
        _reject("percentile: empty input")
    if not 0 < pct < 100:
        _reject("percentile: pct must be in (0, 100)")
    rank = math.ceil(pct / 100.0 * len(sorted_values))
    return sorted_values[rank - 1]


def summarize(durations):
    ordered = sorted(durations)
    return {
        "count": len(ordered),
        "min_ms": ordered[0],
        "p50_ms": percentile(ordered, 50),
        "p95_ms": percentile(ordered, 95),
        "max_ms": ordered[-1],
    }


def default_thresholds():
    return {
        op: {
            "p50_alert_ms": spec["p50_alert_ms"],
            "p95_alert_ms": spec["p95_alert_ms"],
            "rationale": spec["rationale"],
        }
        for op, spec in PROPOSED_THRESHOLDS_MS.items()
    }


def _utcnow(now):
    if now is None:
        return datetime.now(timezone.utc)
    try:
        parsed = datetime.fromisoformat(now.replace("Z", "+00:00"))
    except ValueError:
        _reject("--now: ISO-8601 timestamp required")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso_z(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def init_baseline(source):
    if not isinstance(source, str) or not source.strip():
        _reject("source: non-empty text required")
    return {
        "schema": BASELINE_SCHEMA,
        "provisional": True,
        "thresholds": default_thresholds(),
        "operations": {
            op: {"count": 0, "min_ms": None, "p50_ms": None,
                 "p95_ms": None, "max_ms": None, "samples": []}
            for op in OPERATIONS
        },
        "provenance": {
            "source": source.strip(),
            "refresh_cadence": ("recompute after every >=30 new samples per "
                                "operation or weekly, whichever comes first"),
            "recorded_at": None,
            "recorded_by": None,
            "total_samples": 0,
        },
    }


def _check_baseline_shape(doc):
    if type(doc) is not dict:
        _reject("baseline: object required")
    if doc.get("schema") != BASELINE_SCHEMA:
        _reject("baseline: schema must be %s" % BASELINE_SCHEMA)
    if type(doc.get("operations")) is not dict:
        _reject("baseline.operations: object required")
    for op in OPERATIONS:
        entry = doc["operations"].get(op)
        if type(entry) is not dict:
            _reject("baseline.operations.%s: object required" % op)
        stored = entry.get("samples")
        if type(stored) is not list:
            _reject("baseline.operations.%s.samples: array required" % op)
        for value in stored:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                _reject("baseline.operations.%s.samples: numbers only"
                        % op)
    thresholds = doc.get("thresholds")
    if type(thresholds) is not dict:
        _reject("baseline.thresholds: object required")
    for op in OPERATIONS:
        spec = thresholds.get(op)
        if type(spec) is not dict:
            _reject("baseline.thresholds.%s: object required" % op)
        for key in ("p50_alert_ms", "p95_alert_ms"):
            value = spec.get(key)
            if (isinstance(value, bool) or not isinstance(value, (int, float))
                    or not math.isfinite(value) or value < 0):
                _reject("baseline.thresholds.%s.%s: finite value >= 0 "
                        "required" % (op, key))
    return doc


def record(baseline, grouped, source, recorded_by, now):
    """Append validated samples to the baseline store and recompute stats.

    Returns the updated baseline document. Oldest samples drop once an
    operation exceeds MAX_SAMPLES_PER_OP; the store is a bounded window,
    not an unbounded log.
    """
    _check_baseline_shape(baseline)
    if not isinstance(source, str) or not source.strip():
        _reject("source: non-empty text required")
    if not isinstance(recorded_by, str) or not recorded_by.strip():
        _reject("recorded_by: non-empty text required")
    total = 0
    for op in OPERATIONS:
        stored = baseline["operations"][op]["samples"]
        stored.extend(grouped[op])
        if len(stored) > MAX_SAMPLES_PER_OP:
            del stored[:-MAX_SAMPLES_PER_OP]
        stats = summarize(stored) if stored else None
        if stats is None:
            baseline["operations"][op] = {
                "count": 0, "min_ms": None, "p50_ms": None,
                "p95_ms": None, "max_ms": None, "samples": [],
            }
        else:
            baseline["operations"][op] = dict(stats, samples=list(stored))
        total += len(stored)
    provisional = any(
        baseline["operations"][op]["count"] < MIN_SAMPLES_PER_OP
        for op in OPERATIONS
    )
    baseline["provisional"] = provisional
    baseline["provenance"].update({
        "source": source.strip(),
        "recorded_at": _iso_z(_utcnow(now)),
        "recorded_by": recorded_by.strip(),
        "total_samples": total,
    })
    return baseline


def evaluate(baseline, grouped):
    """Compare fresh samples against baseline thresholds.

    Returns (verdict, details) where verdict is one of
    "ok", "breach", "unknown". Unknown covers: provisional baseline and
    operations with no fresh samples — a verdict on either would be
    confidence the data cannot support.
    """
    _check_baseline_shape(baseline)
    if baseline.get("provisional"):
        return ("unknown", {"reason": "baseline is provisional"})
    details = {}
    worst = "ok"
    for op in OPERATIONS:
        fresh = grouped[op]
        if not fresh:
            return ("unknown", {"reason": "no fresh %s samples" % op})
        stats = summarize(sorted(fresh))
        spec = baseline["thresholds"][op]
        breach = (stats["p50_ms"] > spec["p50_alert_ms"]
                  or stats["p95_ms"] > spec["p95_alert_ms"])
        details[op] = dict(stats, thresholds=dict(spec),
                           breach=bool(breach))
        if breach:
            worst = "breach"
    return (worst, details)


def _write_json(path, doc):
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(doc, handle, indent=2, sort_keys=True)
            handle.write("\n")
    except OSError as exc:
        _reject("baseline write failed: %s" % exc)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Record GARM provider operation latency samples into "
                    "a baseline file, or check fresh samples against it. "
                    "Read-only except for the baseline path on record/init. "
                    "No network, no credentials, no host access.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="write a provisional baseline")
    p_init.add_argument("--baseline", required=True)
    p_init.add_argument("--source", required=True,
                        help="where seed provenance comes from, e.g. "
                             "operator-supplied seed pending live samples")

    p_record = sub.add_parser("record", help="append samples, recompute")
    p_record.add_argument("--samples", required=True)
    p_record.add_argument("--baseline", required=True)
    p_record.add_argument("--source", required=True,
                          help="sample origin, e.g. garm-api-read-metadata "
                               "export 2026-10-03 or operator-supplied")
    p_record.add_argument("--recorded-by", default="operator")
    p_record.add_argument("--now", default=None,
                          help="ISO-8601 clock override for determinism")

    p_check = sub.add_parser("check", help="verdict fresh samples vs "
                                           "thresholds")
    p_check.add_argument("--samples", required=True)
    p_check.add_argument("--baseline", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            _write_json(args.baseline, init_baseline(args.source))
            print("initialized provisional baseline at %s" % args.baseline)
            return 0
        grouped = parse_samples(_read_json(args.samples, "samples"))
        if args.command == "record":
            try:
                baseline = _check_baseline_shape(
                    _read_json(args.baseline, "baseline"))
            except InvalidInput:
                baseline = None
            if baseline is None:
                baseline = init_baseline(args.source)
            record(baseline, grouped, args.source, args.recorded_by,
                   args.now)
            _write_json(args.baseline, baseline)
            print("recorded: provisional=%s total_samples=%d"
                  % (baseline["provisional"],
                     baseline["provenance"]["total_samples"]))
            return 0
        try:
            baseline = _check_baseline_shape(
                _read_json(args.baseline, "baseline"))
        except InvalidInput as exc:
            print("unknown: %s" % exc)
            return 3
        verdict, details = evaluate(baseline, grouped)
        print(json.dumps({"verdict": verdict, "details": details},
                         indent=2, sort_keys=True))
        return {"ok": 0, "breach": 2, "unknown": 3}[verdict]
    except InvalidInput as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
