#!/usr/bin/env python3
"""Offline PASS/FAIL verdict for GARM first-pickup canary reports.

Reads canary report documents -- produced by a
first-pickup canary workflow (or hand-recorded with the same shape) -- and verdicts the queue-wait against the SLO. Offline only:
reads the files on argv, never contacts GARM, GitHub, or any host.

Report schema ``garm-first-pickup-report.v1``:

    {"schema": "garm-first-pickup-report.v1",
     "run_id": "123", "repository": "o/r",
     "pool_labels": ["self-hosted", "example-ephemeral"],
     "runner_name": "garm-example-x",
     "dispatched_at": "2026-10-03T22:00:00Z",
     "picked_up_at": "2026-10-03T22:03:11Z",
     "queue_wait_s": 191, "slo_seconds": 600}

``queue_wait_s`` is authoritative when present; the two clocks are a
cross-check. Exit 0 PASS, 2 FAIL (SLO miss), 3 UNKNOWN (no usable sample),
1 usage/validation error. A FAIL means "no ephemeral VM picked up work
within SLO" -- it licenses no cap, label, or routing change.

Python standard library only. Safe diagnostics: rejections name the field,
never the value.
"""

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA = "garm-first-pickup-report.v1"
MAX_BYTES = 1024 * 1024
MAX_WAIT_S = 6 * 60 * 60  # 6h: a larger value is a clock/unit error, not a slow pool
CLOCK = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T"
                   r"[0-9]{2}:[0-9]{2}:[0-9]{2}Z")


class InvalidReport(ValueError):
    pass


def require(condition, field):
    if not condition:
        raise InvalidReport(field)


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "JSON: duplicate key")
        value[key] = item
    return value


def parse(raw):
    require(len(raw) <= MAX_BYTES, "JSON: input exceeds 1MiB")
    require("\x00" not in raw, "JSON: NUL byte")
    try:
        doc = json.loads(raw, object_pairs_hook=unique_object,
                         parse_constant=lambda v: (_ for _ in ()).throw(
                             InvalidReport("JSON: non-finite number")))
    except json.JSONDecodeError as exc:
        raise InvalidReport(f"JSON: {exc.msg}") from exc
    require(type(doc) is dict, "top-level object")
    return doc


def load_report(path):
    raw = Path(path).read_bytes()
    require(len(raw) <= MAX_BYTES, "JSON: input exceeds 1MiB")
    return parse(raw.decode("utf-8"))


def evaluate(doc):
    """Return (verdict, queue_wait_s, slo_seconds). Verdict is one of
    PASS, FAIL, UNKNOWN. Raises InvalidReport on malformed input."""
    require(type(doc) is dict, "top-level object")
    require(doc.get("schema") == SCHEMA, "schema")
    require(type(doc.get("runner_name")) is str
            and doc["runner_name"].startswith("garm-"), "runner_name")
    labels = doc.get("pool_labels")
    require(type(labels) is list and "example-ephemeral" in labels, "pool_labels")
    for field in ("dispatched_at", "picked_up_at"):
        value = doc.get(field)
        require(type(value) is str and CLOCK.fullmatch(value) is not None,
                field)
    require(doc["picked_up_at"] >= doc["dispatched_at"], "clock-order")
    slo = doc.get("slo_seconds")
    require(type(slo) is int and slo > 0, "slo_seconds")
    wait = doc.get("queue_wait_s")
    if wait is None:
        return ("UNKNOWN", None, slo)
    require(type(wait) is int and 0 <= wait <= MAX_WAIT_S, "queue_wait_s")
    return ("PASS" if wait <= slo else "FAIL", wait, slo)


def summarize(path):
    doc = load_report(path)
    return evaluate(doc)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Offline PASS/FAIL verdict for GARM first-pickup "
                    "canary reports.")
    parser.add_argument("reports", nargs="+",
                        help="first-pickup report JSON file(s)")
    args = parser.parse_args(argv)
    worst = 0  # 0 PASS < 2 FAIL < 3 UNKNOWN; validation errors exit 1
    order = {"PASS": 0, "FAIL": 2, "UNKNOWN": 3}
    for path in args.reports:
        try:
            verdict, wait, slo = summarize(path)
        except (InvalidReport, OSError, UnicodeDecodeError) as exc:
            print(f"ERROR {path}: {exc}")
            return 1
        extra = "" if wait is None else f" wait={wait}s slo={slo}s"
        print(f"{verdict} {path}:{extra}")
        worst = max(worst, order[verdict])
    return worst


if __name__ == "__main__":
    sys.exit(main())
