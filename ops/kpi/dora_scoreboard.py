#!/usr/bin/env python3
"""Offline nightly escape/rework joiner; JSON plus a private owner-inbox spool line.

This is a descriptive quality guardrail, not deployment DORA, a merge gate, an
inbox transport, or a statistical non-inferiority decision. No model calls.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

# The isolated scheduled interpreter ignores PYTHONPATH and the working dir.
# Load only the delivered sibling helper; do not re-add either to sys.path.
SPEC = importlib.util.spec_from_file_location("escape_ledger", Path(__file__).with_name("escape_ledger.py"))
ledger = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ledger)
MAX_BYTES = 64 * 1024 * 1024
MAX_ROWS = 250_000


class SnapshotError(ValueError):
    def __init__(self, code):
        self.code = code


def reject_constant(value):
    raise ValueError("non-finite JSON number")


def read_snapshot(path, now, max_age_hours, expected_run=None):
    with path.open("rb") as handle:
        raw = handle.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise SnapshotError("INVALID_SNAPSHOT")
    lines = raw.splitlines()
    if not lines or len(lines) > MAX_ROWS:
        raise SnapshotError("INVALID_SNAPSHOT")
    rows = [json.loads(line, parse_constant=reject_constant) for line in lines]
    if any(not isinstance(r, dict) for r in rows):
        raise SnapshotError("INVALID_SNAPSHOT")
    meta = rows[0]
    allowed = {"metadata", "merge", "escape", "aggregate", "unlinked_incident"}
    if (meta.get("type") != "metadata" or meta.get("schema_version") != ledger.VERSION or
            meta.get("mode") != "shadow" or any(r.get("type") not in allowed for r in rows) or
            sum(r.get("type") == "metadata" for r in rows) != 1 or
            not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", meta.get("run_id", "")) or
            not re.fullmatch(r"[0-9a-f]{64}", meta.get("tool_sha256") or "")):
        raise SnapshotError("INVALID_SNAPSHOT")
    if expected_run is not None and (not expected_run or meta["run_id"] != expected_run):
        raise SnapshotError("WRONG_INVOCATION")
    generated, end = ledger.instant(meta["generated_at"]), ledger.instant(meta["end"])
    if now - generated > dt.timedelta(hours=max_age_hours) or now - end > dt.timedelta(hours=max_age_hours):
        raise SnapshotError("STALE_SNAPSHOT")
    if generated > now + dt.timedelta(minutes=5) or end > now or generated < end:
        raise SnapshotError("INVALID_SNAPSHOT")
    merges = [r for r in rows if r["type"] == "merge"]
    events = [r for r in rows if r["type"] == "escape"]
    if (meta.get("merges") != len(merges) or meta.get("escapes") != len(events) or
            meta.get("unlinked_incident_mentions") != sum(r["type"] == "unlinked_incident" for r in rows)):
        raise SnapshotError("INVALID_SNAPSHOT")
    quality = ledger.quality_summary(meta, merges, events)
    if quality != meta.get("quality"):
        raise SnapshotError("INVALID_SNAPSHOT")
    source = {"run_id": meta["run_id"], "generated_at": meta["generated_at"],
              "collector_sha256": meta["tool_sha256"], "sha256": hashlib.sha256(raw).hexdigest(),
              "repos": meta["repos"], "scope": meta.get("scope", "explicit_repositories")}
    return quality, source, min(generated, end) + dt.timedelta(hours=max_age_hours)


def rate_text(rate, numerator, n):
    value = f"{100 * rate:.2f}%" if rate is not None else "N/A"
    return f"{value} ({numerator}/{n}; n={n})"


def owner_line(data):
    if data["status"] == "unavailable":
        return f"Quality guardrail: UNAVAILABLE ({data['error']['code']}); n=N/A; refresh source before any decision."
    q, source = data["quality"], data["source"]
    rate = rate_text(q["escape_rework_rate"], q["affected_n"], q["n"])
    rework = rate_text(q["rework_rate"], q["rework_n"], q["n"])
    spans = []
    for name, values in q["stage_waits"].items():
        p50, p90 = values["p50_seconds"], values["p90_seconds"]
        duration = "N/A" if p50 is None else f"{p50:.0f}/{p90:.0f}s"
        spans.append(f"{name} p50/p90={duration} (n={values['n']}, missing={values['missing_n']})")
    return (f"Quality guardrail [{q['start']},{q['end']}): escape+rework proxy={rate}; "
            f"rework={rework}; immature={q['immature_n']}; coverage={q['coverage_status']}; "
            f"{' ; '.join(spans)}; shadow only, non-inferiority NOT established; "
            f"source={source['run_id']}:{source['sha256'][:12]}; expires={data['expires_at']}.")


def error_result(code, now):
    return {"schema_version": 1, "status": "unavailable", "published_at": ledger.stamp(now),
            "error": {"code": code, "retryable": code in {"SOURCE_UNAVAILABLE", "OUTPUT_UNAVAILABLE", "BUSY"},
                      "next_action": "Recollect the ledger with the matching invocation; validate it with --dry-run."}}


def publish(out, data):
    # JSON is authoritative and contains its own line, source identity and expiry.
    # A crash between renames must never be interpreted as a matching file pair.
    ledger.save_json(out / "quality-scoreboard.json", data)
    ledger.atomic(out / "owner-inbox-line.txt", data["owner_line"] + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", required=True, type=Path, help="Private escapes.jsonl from the collector")
    parser.add_argument("--output-dir", type=Path, help="Private spool directory; required unless --dry-run")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print JSON; no filesystem writes")
    parser.add_argument("--now", help="Timezone-qualified as-of instant; default current UTC")
    parser.add_argument("--max-age-hours", type=float, default=36, help="Source and observation freshness (1..168)")
    parser.add_argument("--entry-point", choices=["cli", "systemd"], default="cli")
    args = parser.parse_args(argv)
    if not args.dry_run and args.output_dir is None:
        parser.error("--output-dir is required unless --dry-run")
    if not 1 <= args.max_age_hours <= 168:
        parser.error("--max-age-hours must be between 1 and 168")
    try:
        now = ledger.instant(args.now) if args.now else dt.datetime.now(ledger.UTC)
    except (ValueError, TypeError):
        parser.error("--now must be a timezone-qualified instant")
    os.umask(0o077)

    def build():
        try:
            expected = os.environ.get("INVOCATION_ID", "") if args.entry_point == "systemd" else None
            quality, source, expires = read_snapshot(args.ledger, now, args.max_age_hours, expected)
            return {"schema_version": 1, "status": quality["coverage_status"],
                    "published_at": ledger.stamp(now), "expires_at": ledger.stamp(expires),
                    "source": source, "quality": quality}
        except SnapshotError as exc:
            return error_result(exc.code, now)
        except OSError:
            return error_result("SOURCE_UNAVAILABLE", now)
        except (ValueError, KeyError, TypeError, AttributeError, RecursionError, OverflowError):
            return error_result("INVALID_SNAPSHOT", now)

    try:
        if args.dry_run:
            data = build()
            data["owner_line"] = owner_line(data)
        else:
            with ledger.lock(args.output_dir / ".quality-scoreboard.lock", nonblocking=True):
                data = build()
                data["owner_line"] = owner_line(data)
                publish(args.output_dir, data)
    except BlockingIOError:
        data = error_result("BUSY", now)
    except OSError:
        data = error_result("OUTPUT_UNAVAILABLE", now)
    print(json.dumps(data, ensure_ascii=True, sort_keys=True))
    return 0 if data["status"] == "complete" else (75 if data.get("error", {}).get("code") == "BUSY" else 2)


if __name__ == "__main__":
    sys.exit(main())
