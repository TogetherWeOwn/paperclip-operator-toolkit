#!/usr/bin/env python3
"""Deterministic migration checks (blocker-ledger class 4).

Flags unsafe or non-reversible schema migrations: destructive DDL without
an explicit safety ack, non-concurrent index builds, lossy column-type
changes, and migrations missing a down path.

Stdlib only, pure functions, no network/clock/filesystem.
"""

import re

MIGRATION_DIRS = ("migrations/", "alembic/versions/")

SAFETY_ACK = "safety: acknowledged"

_DOWN_RE = re.compile(r"--\s*down\b", re.IGNORECASE)
_DROP_TABLE_RE = re.compile(r"\bdrop\s+table\b", re.IGNORECASE)
_DROP_COLUMN_RE = re.compile(r"\bdrop\s+column\b", re.IGNORECASE)
_TRUNCATE_RE = re.compile(r"\btruncate\b", re.IGNORECASE)
_CREATE_INDEX_RE = re.compile(r"\bcreate\s+(unique\s+)?index\b", re.IGNORECASE)
_CONCURRENTLY_RE = re.compile(r"\bconcurrently\b", re.IGNORECASE)
_ALTER_TYPE_RE = re.compile(r"\balter\s+column\b.*\btype\b", re.IGNORECASE | re.DOTALL)
_USING_RE = re.compile(r"\busing\b", re.IGNORECASE)


def is_migration_path(path):
    """True when the path sits under one of the MIGRATION_DIRS markers."""
    return any(marker in str(path) for marker in MIGRATION_DIRS)


def _up_section(text):
    """The reversible (up) half of a migration; the DOWN half is expected
    to undo things, so destructive statements there are not findings."""
    return _DOWN_RE.split(text, maxsplit=1)[0]


def check_migration_safety(contents):
    """One finding per file with destructive DDL (un-acked), a
    non-concurrent CREATE INDEX, or an ALTER COLUMN TYPE without USING.
    Findings name the file. Safe migrations pass."""
    findings = []
    for path, text in contents.items():
        if str(path).endswith(".down.sql"):
            continue
        up = _up_section(text)
        reasons = []
        if (
            _DROP_TABLE_RE.search(up)
            or _DROP_COLUMN_RE.search(up)
            or _TRUNCATE_RE.search(up)
        ) and SAFETY_ACK.lower() not in text.lower():
            reasons.append("destructive DDL without safety ack")
        if _CREATE_INDEX_RE.search(up) and not _CONCURRENTLY_RE.search(up):
            reasons.append("CREATE INDEX without CONCURRENTLY")
        if _ALTER_TYPE_RE.search(up) and not _USING_RE.search(up):
            reasons.append("ALTER COLUMN TYPE without USING")
        if reasons:
            findings.append("%s: %s" % (path, "; ".join(reasons)))
    return findings


def check_migration_down(changed_files, contents):
    """Every changed *.sql migration file must carry a -- DOWN marker
    (case-insensitive) or have a sibling <same-stem>.down.sql in
    changed_files. One finding per migration missing both."""
    findings = []
    for path in changed_files:
        if str(path).endswith(".down.sql"):
            continue
        if not (is_migration_path(path) and str(path).endswith(".sql")):
            continue
        text = contents.get(path, "")
        if _DOWN_RE.search(text):
            continue
        sibling = str(path)[:-4] + ".down.sql"
        if sibling in changed_files:
            continue
        findings.append(
            "%s: migration has no -- DOWN marker and no sibling %s"
            % (path, sibling)
        )
    return findings
