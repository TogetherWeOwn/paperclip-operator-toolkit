#!/usr/bin/env python3
# ===========================================================================
# pacer_admission_audit.py — append-only audit log for pacer admission
# decisions
#
# SCOPE: shadow mode only. This module WRITES one JSON object per pacer
# admission decision — timestamp, lane, allow/deny, headroom-at-decision —
# and rotates the file under a size cap. Nothing here enforces anything:
# there is no admit/refuse branch, no call into selection, no read or write
# of selection.mode, and importing this module changes no pacing behaviour.
# The enforce flip, hysteresis, the headroom tie-break, and the weekly-vs-5h
# conflict handling are separate concerns; none of that is duplicated here.
#
# WHY APPEND-ONLY: the log is evidence, not state. A writer that rewrites
# history can hide the decision it is supposed to record, so the steady
# path opens the file with "a" and never truncates it. The ONLY rewrite is
# rotation under the cap (oldest lines dropped, newest kept), via tmp +
# os.replace so a crash cannot leave a half file.
#
# RECORD SCHEMA (one JSON object per line, keys stable):
#   v         schema version, always 1
#   ts        UTC "YYYY-MM-DDTHH:MM:SSZ" of the decision
#   lane      non-empty string, e.g. "claude-sonnet" (max 128 chars)
#   decision  "allow" or "deny" — nothing else is representable
#   headroom  finite number: budget remaining at decision time
#             (negative = already overdrawn; NaN/Inf are refused because
#             json would emit them as bare words, which is not JSON)
#   reason    optional short string (max 512 chars), e.g. which guard fired
#   mode      always "shadow" — stamped by the writer, not caller-settable
#
# EXIT CODES (cli)
#   0  decision recorded (and rotation, if due, succeeded)
#   1  I/O failure: append or rotation could not complete
#   2  usage / validation: bad decision, lane, headroom, ts, or cap
#
# The CLI appends to --file, defaulting to pacer-admission-audit.jsonl in
# ${HANDOFF_DIR:-$HOME/handoff}.
# Read-only except for the one file it appends. No network, no credential.
# ===========================================================================
from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import sys

AUDIT_BASENAME = "pacer-admission-audit.jsonl"


def default_audit_path():
    """${HANDOFF_DIR:-$HOME/handoff}/pacer-admission-audit.jsonl."""
    handoff = os.environ.get("HANDOFF_DIR") or os.path.join(
        os.path.expanduser("~"), "handoff")
    return os.path.join(handoff, AUDIT_BASENAME)


SCHEMA_VERSION = 1
SHADOW_MODE = "shadow"

DECISIONS = ("allow", "deny")

# Rotation defaults. The log is evidence but not forever: 1 MiB / 10k lines
# keeps ~months of decisions while bounding the handoff directory's disk.
DEFAULT_MAX_BYTES = 1024 * 1024
DEFAULT_MAX_LINES = 10000

MAX_LANE_CHARS = 128
MAX_REASON_CHARS = 512


class AuditError(ValueError):
    """A decision the writer refuses to record. Never writes anything."""


def format_ts(dt):
    """Format an aware UTC datetime as YYYY-MM-DDTHH:MM:SSZ."""
    if dt.tzinfo is None:
        raise AuditError("timestamp must carry a timezone")
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(s):
    if not isinstance(s, str):
        return None
    try:
        return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=datetime.timezone.utc
        )
    except ValueError:
        return None


def validate_lane(lane):
    if not isinstance(lane, str) or not lane.strip():
        raise AuditError("lane must be a non-empty string")
    if len(lane) > MAX_LANE_CHARS:
        raise AuditError("lane exceeds %d chars" % MAX_LANE_CHARS)
    if "\n" in lane or "\r" in lane:
        raise AuditError("lane must be a single line")
    return lane.strip()


def validate_decision(decision):
    if decision not in DECISIONS:
        raise AuditError(
            "decision must be one of %s, got %r" % ("/".join(DECISIONS), decision)
        )
    return decision


def validate_headroom(headroom):
    if isinstance(headroom, bool) or not isinstance(headroom, (int, float)):
        raise AuditError("headroom must be a number, got %r" % (headroom,))
    if not math.isfinite(headroom):
        raise AuditError("headroom must be finite, got %r" % (headroom,))
    return float(headroom)


def validate_reason(reason):
    if reason is None:
        return ""
    if not isinstance(reason, str):
        raise AuditError("reason must be a string")
    if len(reason) > MAX_REASON_CHARS:
        raise AuditError("reason exceeds %d chars" % MAX_REASON_CHARS)
    if "\n" in reason or "\r" in reason:
        raise AuditError("reason must be a single line")
    return reason


def build_record(lane, decision, headroom, reason="", ts=None, now=None):
    """Validate inputs and return the record dict. Writes nothing.

    `ts` is an explicit "YYYY-MM-DDTHH:MM:SSZ" string (tests, replays);
    otherwise the record carries now. `mode` is stamped here and takes no
    caller input — shadow is the only mode this writer knows.
    """
    lane = validate_lane(lane)
    decision = validate_decision(decision)
    headroom = validate_headroom(headroom)
    reason = validate_reason(reason)
    if ts is None:
        moment = now or datetime.datetime.now(datetime.timezone.utc)
        stamp = format_ts(moment)
    else:
        if parse_ts(ts) is None:
            raise AuditError(
                "ts must be UTC in YYYY-MM-DDTHH:MM:SSZ form, got %r" % (ts,)
            )
        stamp = ts
    return {
        "v": SCHEMA_VERSION,
        "ts": stamp,
        "lane": lane,
        "decision": decision,
        "headroom": headroom,
        "reason": reason,
        "mode": SHADOW_MODE,
    }


def validate_caps(max_bytes, max_lines):
    # A negative cap is not "extra disabled" — silently treating it as
    # disabled would let a sign typo turn off rotation without saying so.
    # Zero disables that dimension openly; negatives are refused.
    for name, value in (("max_bytes", max_bytes), ("max_lines", max_lines)):
        if isinstance(value, bool) or not isinstance(value, int):
            raise AuditError("%s must be an int, got %r" % (name, value))
        if value < 0:
            raise AuditError("%s refuses negatives (0 disables), got %r"
                             % (name, value))
    return max_bytes, max_lines


def encode_record(record):
    # allow_nan=False: NaN/Inf escape validation only via direct dict
    # injection, and must still never reach the file as bare words.
    return json.dumps(record, sort_keys=True, allow_nan=False)


def append_record(path, record):
    """Append one record line. The only steady-state mutation: open "a"."""
    line = encode_record(record)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
        fh.flush()
    return record


def rotate_if_needed(path, max_bytes=DEFAULT_MAX_BYTES,
                     max_lines=DEFAULT_MAX_LINES):
    """Drop oldest lines while over either cap. Returns lines kept count.

    A cap of 0 disables that dimension. Newest lines are always kept: the
    rewrite keeps a SUFFIX of the file, never a prefix. Atomic via tmp +
    os.replace. Caps count raw lines (garbage included), so an over-cap
    file with garbage still shrinks.
    """
    if max_bytes <= 0 and max_lines <= 0:
        return None
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()
    over_bytes = max_bytes > 0 and size > max_bytes
    over_lines = max_lines > 0 and len(lines) > max_lines
    if not over_bytes and not over_lines:
        return len(lines)
    keep = lines
    if max_lines > 0 and len(keep) > max_lines:
        keep = keep[-max_lines:]
    if max_bytes > 0:
        # Drop oldest until the kept suffix fits. One line is always kept:
        # a single decision larger than the cap is still evidence.
        while len(keep) > 1 and sum(len(ln) for ln in keep) > max_bytes:
            keep = keep[1:]
    tmp = "%s.rot-%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.writelines(keep)
        fh.flush()
    os.replace(tmp, path)
    return len(keep)


def record_decision(path, lane, decision, headroom, reason="",
                    ts=None, now=None,
                    max_bytes=DEFAULT_MAX_BYTES,
                    max_lines=DEFAULT_MAX_LINES):
    """Validate, append, rotate. Returns the record dict. Raises AuditError
    before touching the file on any validation failure; raises OSError on
    I/O failure."""
    validate_caps(max_bytes, max_lines)
    record = build_record(lane, decision, headroom, reason, ts, now)
    append_record(path, record)
    rotate_if_needed(path, max_bytes, max_lines)
    return record


def read_records(path):
    """Read-only consumer helper: valid record dicts in file order, garbage
    lines skipped (a partial final flush must not blank the evidence)."""
    out = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            blob = fh.read()
    except OSError:
        return out
    for ln in blob.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            r = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if isinstance(r, dict) and r.get("v") == SCHEMA_VERSION:
            out.append(r)
    return out


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Append one pacer admission decision to the audit log "
                    "(shadow mode only; enforces nothing).")
    p.add_argument("--file", default=default_audit_path(),
                   help="audit log path (default: "
                        "${HANDOFF_DIR:-$HOME/handoff}/%s)" % AUDIT_BASENAME)
    p.add_argument("--lane", required=True,
                   help="lane the decision was made for, e.g. claude-sonnet")
    p.add_argument("--decision", required=True, choices=list(DECISIONS))
    p.add_argument("--headroom", required=True, type=float,
                   help="budget remaining at decision time (finite number)")
    p.add_argument("--reason", default="",
                   help="optional single-line note, e.g. which guard fired")
    p.add_argument("--ts", default=None,
                   help="override decision time (UTC YYYY-MM-DDTHH:MM:SSZ)")
    p.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES,
                   help="rotation cap in bytes (0 disables; negatives refused)")
    p.add_argument("--max-lines", type=int, default=DEFAULT_MAX_LINES,
                   help="rotation cap in lines (0 disables; negatives refused)")
    a = p.parse_args(argv)

    try:
        record = record_decision(a.file, a.lane, a.decision, a.headroom,
                                 a.reason, a.ts,
                                 max_bytes=a.max_bytes,
                                 max_lines=a.max_lines)
    except AuditError as exc:
        print("refused: %s" % exc, file=sys.stderr)
        return 2
    except OSError as exc:
        print("io error: %s" % exc, file=sys.stderr)
        return 1
    print(encode_record(record))
    return 0


if __name__ == "__main__":
    sys.exit(main())
