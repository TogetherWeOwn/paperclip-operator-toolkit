#!/usr/bin/env python3
"""Recovery-writer dry-run harness: decision log, no mutation.

Evaluates the platform watchdog detectors and writes a decision log without
applying any action. There is deliberately no ``--apply`` flag, no board
client, and no network import in this file: a unit labelled dry-run that
really writes is the drift this harness must never become (see
``recovery_writer.py`` drift 1). Enabling a first auto-action and the preflight canary are separate,
later changes.

Usage (from the repo root)::

  PYTHONPATH=. python3 watchdog/recovery_dryrun.py \
      --snapshot snap.json --log decisions.jsonl

Reads a detector snapshot (the same shape ``watchdog/detectors.py`` takes),
evaluates every detector, and appends one decision record per detector row
to the log file. Repeat polls on the same signature log ``skip`` with the
same dedupe key instead of a second ``propose``. Severity is part of the
signature: a row first logged at ``info`` (a skip) that later escalates to
``high`` is a new signature and is proposed once, instead of being swallowed
by the earlier skip.

Exit codes: 0 decided (propose and skip are both decisions), 2 usage or
unreadable input (missing, non-UTF-8, malformed or too deeply nested
snapshot or decision log). This harness never exits 1 for a failed apply,
because it cannot apply.

Decision record schema (one JSON object per line)::

  {"type": "decision", "harness": "recovery-dryrun/1",
   "detector": "watchdog/agent_error", "verdict": "propose",
   "reason": "non-benign agent error past 10m",
   "dedupeKey": "<24 hex>", "mutation": "none",
   "issueId": "<uuid or null>", "identifier": "CARD-1 or null",
   "severity": "high", "note": "owning lead triages; ...",
   "dryRun": true, "phase": "dry-run-propose-only"}

No secrets in output: records carry identifiers, detector names, reasons and
classifications only. Detector evidence values are never copied into the
log (secret-hit rows carry pattern names in evidence, so they stay out).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys

from watchdog.detectors import detect

HARNESS_NAME = "recovery-dryrun/1"
HARNESS_PHASE = "dry-run-propose-only"

# Findings at these severities propose attention; info rows are diagnostics
# that stay logged but propose nothing.
PROPOSE_SEVERITIES = frozenset({"high", "critical", "unknown"})

# Evidence identity fields, in order. The dedupe key must survive repeat
# polls, so it uses identity fields only -- never measured values such as
# ageMin, rewokes or ratios, which move between polls of one signature.
EVIDENCE_IDENTITY_FIELDS = (
    "agentId",
    "host",
    "job",
    "label",
    "repo",
    "signature",
    "source",
    "patternName",
    "identifier",
)


def scope_of(record: dict) -> str:
    """Stable scope for one detector row across repeat polls."""
    for key in ("issueId", "identifier"):
        value = record.get(key)
        if value:
            return str(value)
    evidence = record.get("evidence")
    if isinstance(evidence, dict):
        parts = []
        for field in EVIDENCE_IDENTITY_FIELDS:
            value = evidence.get(field)
            if value is not None and str(value) not in ("?", ""):
                parts.append(f"{field}={value}")
        if parts:
            return "|".join(parts)
    return "global"


def dedupe_key(record: dict) -> str:
    """First-seen identity of one detector row.

    Detector + reason + severity + scope. Severity is in the key so an
    ``info`` skip never uses up the identity its later ``high`` escalation
    needs; measured values stay out so one signature keeps one key.
    """
    material = json.dumps(
        {
            "detector": str(record.get("detector") or "unknown"),
            "reason": str(record.get("reason") or "unspecified"),
            "mutation": str(record.get("mutation") or "none"),
            "severity": str(record.get("severity") or "none"),
            "scope": scope_of(record),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(material.encode()).hexdigest()[:24]


def load_seen_keys(paths: list[str]) -> set[str]:
    """Collect dedupe keys already in decision logs. Fails loudly."""
    seen: set[str] = set()
    for path in paths:
        try:
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise ValueError(f"cannot read decision log {path}: {exc}") from exc
        for lineno, line in enumerate(text.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except (json.JSONDecodeError, RecursionError) as exc:
                raise ValueError(
                    f"corrupt decision log {path} line {lineno}: {exc}; "
                    f"refusing to lose dedupe state"
                ) from exc
            if isinstance(row, dict) and row.get("type") == "decision":
                key = row.get("dedupeKey")
                if isinstance(key, str) and key:
                    seen.add(key)
    return seen


def to_decision(record: dict, seen: set[str]) -> dict:
    """Map one detector row to a propose/skip decision record."""
    key = dedupe_key(record)
    base = {
        "type": "decision",
        "harness": HARNESS_NAME,
        "detector": str(record.get("detector") or "unknown"),
        "dedupeKey": key,
        "mutation": str(record.get("mutation") or "none"),
        "issueId": record.get("issueId"),
        "identifier": record.get("identifier"),
        "dryRun": True,
        "phase": HARNESS_PHASE,
    }
    if key in seen:
        return {
            **base,
            "verdict": "skip",
            "reason": "duplicate signature already logged",
            "severity": record.get("severity"),
            "note": (
                f"dedupeKey {key} was decided on an earlier poll; "
                f"repeat polls must not duplicate. Original reason: "
                f"{record.get('reason') or 'unspecified'}"
            ),
        }
    if record.get("type") == "proposal":
        return {
            **base,
            "verdict": "propose",
            "reason": str(record.get("reason") or "unspecified"),
            "severity": None,
            "note": str(record.get("note") or ""),
        }
    severity = str(record.get("severity") or "unknown")
    if severity in PROPOSE_SEVERITIES:
        return {
            **base,
            "verdict": "propose",
            "reason": str(record.get("reason") or "unspecified"),
            "severity": severity,
            "note": str(record.get("suggestedAction") or ""),
        }
    return {
        **base,
        "verdict": "skip",
        "reason": str(record.get("reason") or "unspecified"),
        "severity": severity,
        "note": (
            "info-level diagnostic; logged for audit, proposes no action. "
            f"Detail: {record.get('suggestedAction') or ''}".rstrip()
        ),
    }


def run(snapshot_path: str, log_path: str,
        known_logs: list[str]) -> tuple[dict, list[dict]]:
    """Evaluate detectors, append decisions to the log.

    Returns (summary, decisions). Appends to the log file; reads only the
    snapshot and prior logs, writes only the log file. No board, no network.
    """
    try:
        with open(snapshot_path, encoding="utf-8") as handle:
            snapshot = json.load(handle)
    except (OSError, json.JSONDecodeError, RecursionError) as exc:
        # RecursionError is a deeply nested document: unreadable input, so
        # exit 2 like the other refusals, not a traceback.
        raise ValueError(f"cannot read snapshot {snapshot_path}: {exc}") from exc
    if not isinstance(snapshot, dict):
        raise ValueError("snapshot must be a JSON object")
    try:
        records = detect(snapshot)
    except ValueError as exc:
        raise ValueError(f"detectors refused the snapshot: {exc}") from exc
    seen = load_seen_keys([log_path, *known_logs])
    decisions = []
    for record in records:
        if not isinstance(record, dict):
            continue
        decision = to_decision(record, seen)
        seen.add(decision["dedupeKey"])
        decisions.append(decision)
    try:
        with open(log_path, "a", encoding="utf-8") as handle:
            for decision in decisions:
                handle.write(json.dumps(decision, sort_keys=True) + "\n")
    except OSError as exc:
        raise ValueError(f"cannot append to decision log {log_path}: {exc}") from exc
    proposed = sum(1 for d in decisions if d["verdict"] == "propose")
    summary = {
        "type": "summary",
        "harness": HARNESS_NAME,
        "decisions": len(decisions),
        "proposed": proposed,
        "skipped": len(decisions) - proposed,
        "phase": HARNESS_PHASE,
    }
    return summary, decisions


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Recovery-writer dry-run harness: evaluate detectors, "
        "append propose/skip decisions to a log, mutate nothing."
    )
    parser.add_argument("--snapshot", required=True,
                        help="JSON file in watchdog detector snapshot shape")
    parser.add_argument("--log", required=True,
                        help="JSONL decision log to append to (created if missing)")
    parser.add_argument("--known-log", action="append", default=[],
                        help="extra prior decision log for dedupe (repeatable)")
    args = parser.parse_args(argv)
    try:
        summary, decisions = run(args.snapshot, args.log, args.known_log)
    except ValueError as exc:
        print(f"recovery_dryrun: {exc}", file=sys.stderr)
        return 2
    for decision in decisions:
        print(json.dumps(decision, sort_keys=True))
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
