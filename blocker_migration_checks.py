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

# Dialects: postgres enforces CONCURRENTLY/USING; sqlite (D1) skips them
# because SQLite rejects that syntax. Destructive-DDL and down-path
# checks run under every dialect.
DIALECTS = ("postgres", "sqlite")

_DOWN_RE = re.compile(r"--\s*down\b", re.IGNORECASE)
_DROP_TABLE_RE = re.compile(r"\bdrop\s+table\b", re.IGNORECASE)
_DROP_COLUMN_RE = re.compile(r"\bdrop\s+column\b", re.IGNORECASE)
_TRUNCATE_RE = re.compile(r"\btruncate\b", re.IGNORECASE)
_CREATE_INDEX_RE = re.compile(r"\bcreate\s+(unique\s+)?index\b", re.IGNORECASE)
_CONCURRENTLY_RE = re.compile(r"\bconcurrently\b", re.IGNORECASE)
_ALTER_TYPE_RE = re.compile(r"\balter\s+column\b.*\btype\b", re.IGNORECASE | re.DOTALL)
_ALTER_CLAUSE_RE = re.compile(r"\balter\s+column\b.*\btype\b", re.IGNORECASE | re.DOTALL)
_USING_RE = re.compile(r"\busing\b", re.IGNORECASE)
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def is_migration_path(path):
    """True when the path sits under one of the MIGRATION_DIRS markers."""
    return any(marker in str(path) for marker in MIGRATION_DIRS)


def _up_section(text):
    """The reversible (up) half of a migration; the DOWN half is expected
    to undo things, so destructive statements there are not findings."""
    return _DOWN_RE.split(text, maxsplit=1)[0]


def _strip_sql_comments(sql):
    """Remove `--` line comments and `/* */` blocks (outside string literals).

    Guards must match code, never prose: without this a comment containing
    CONCURRENTLY/USING masks an unguarded statement in the same chunk.
    Quote-aware: `--` inside single/double-quoted literals is kept.
    """
    no_block = _BLOCK_COMMENT_RE.sub(" ", sql or "")
    out = []
    i = 0
    n = len(no_block)
    quote = None
    while i < n:
        ch = no_block[i]
        if quote is not None:
            out.append(ch)
            if ch == quote:
                # SQL escapes '' by doubling; a doubled quote stays quoted.
                if i + 1 < n and no_block[i + 1] == quote:
                    out.append(no_block[i + 1])
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == "-" and i + 1 < n and no_block[i + 1] == "-":
            # Line comment: skip to (not including) the newline.
            while i < n and no_block[i] != "\n":
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _statements(up):
    """Split the comment-stripped up-section into `;`-terminated statements.

    Index/alter checks run per statement so one guarded statement cannot
    mask an unguarded sibling (e.g. a CONCURRENTLY index hiding a second
    blocking index, or an index's USING satisfying an unrelated ALTER).
    Splitting is syntactic: a `;` inside a string literal also splits,
    which may add a finding but never hides a blocking lock.
    """
    stripped = _strip_sql_comments(up)
    return [part.strip() for part in stripped.split(";") if part.strip()]


def _split_top_level_commas(stmt):
    """Split an ALTER statement on commas at paren depth 0 (outside quotes).

    One USING must not cover two ALTER COLUMN clauses:
    `... USING a::int, ALTER COLUMN b TYPE int` flags the second clause.
    """
    parts = []
    depth = 0
    quote = None
    cur = []
    i = 0
    n = len(stmt)
    while i < n:
        ch = stmt[i]
        if quote is not None:
            cur.append(ch)
            if ch == quote:
                if i + 1 < n and stmt[i + 1] == quote:
                    cur.append(stmt[i + 1])
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            cur.append(ch)
            i += 1
            continue
        if ch == "(":
            depth += 1
            cur.append(ch)
            i += 1
            continue
        if ch == ")" and depth > 0:
            depth -= 1
            cur.append(ch)
            i += 1
            continue
        if ch == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
            i += 1
            continue
        cur.append(ch)
        i += 1
    tail = "".join(cur).strip()
    if tail:
        parts.append(tail)
    return parts


def _alter_type_missing_using(stmt):
    """True when any ALTER COLUMN .. TYPE clause in the statement lacks USING."""
    for clause in _split_top_level_commas(stmt):
        if _ALTER_CLAUSE_RE.search(clause) and not _USING_RE.search(clause):
            return True
    return False


def check_migration_safety(contents, dialect="postgres"):
    """One finding per file with destructive DDL (un-acked), a
    non-concurrent CREATE INDEX, or an ALTER COLUMN TYPE without USING.
    Index/alter checks run per `;`-separated statement on comment-stripped
    SQL, USING checked per ALTER COLUMN clause. Findings name
    the file. Safe migrations pass.

    `dialect="sqlite"` (Cloudflare D1) skips the CONCURRENTLY and USING
    checks SQLite rejects; destructive-DDL still reports.
    """
    if dialect not in DIALECTS:
        raise ValueError("unknown dialect: %r" % (dialect,))
    sqlite = dialect == "sqlite"
    findings = []
    for path, text in contents.items():
        if str(path).endswith(".down.sql"):
            continue
        up = _up_section(text)
        reasons = []
        if (
            _DROP_TABLE_RE.search(_strip_sql_comments(up))
            or _DROP_COLUMN_RE.search(_strip_sql_comments(up))
            or _TRUNCATE_RE.search(_strip_sql_comments(up))
        ) and SAFETY_ACK.lower() not in text.lower():
            reasons.append("destructive DDL without safety ack")
        if not sqlite:
            for stmt in _statements(up):
                if _CREATE_INDEX_RE.search(
                    stmt
                ) and not _CONCURRENTLY_RE.search(stmt):
                    if "CREATE INDEX without CONCURRENTLY" not in reasons:
                        reasons.append("CREATE INDEX without CONCURRENTLY")
                if _alter_type_missing_using(stmt):
                    if "ALTER COLUMN TYPE without USING" not in reasons:
                        reasons.append("ALTER COLUMN TYPE without USING")
        if reasons:
            findings.append("%s: %s" % (path, "; ".join(reasons)))
    return findings


def _down_siblings(path):
    """Candidate sibling down files for a migration path.

    Accepts the `<stem>.down.sql` form and the golang-migrate
    `<stem>.up.sql` / `<stem>.down.sql` pair (for which the naive
    `<stem>.up.down.sql` never exists).
    """
    text = str(path)
    siblings = []
    if text.endswith(".up.sql"):
        siblings.append(text[: -len(".up.sql")] + ".down.sql")
    siblings.append(text[:-4] + ".down.sql")
    return siblings


def check_migration_down(changed_files, contents):
    """Every changed *.sql migration file present in contents must carry
    a -- DOWN marker (case-insensitive) or have a sibling down file in
    changed_files. Paths missing from contents (e.g. deleted files, which
    the gate excludes via --diff-filter=d) are skipped. One finding per
    migration missing both. Non-migration files are ignored."""
    findings = []
    for path in changed_files:
        if str(path).endswith(".down.sql"):
            continue
        if not (is_migration_path(path) and str(path).endswith(".sql")):
            continue
        if path not in contents:
            continue
        text = contents.get(path, "")
        if _DOWN_RE.search(text):
            continue
        siblings = _down_siblings(path)
        if any(sibling in changed_files for sibling in siblings):
            continue
        findings.append(
            "%s: migration has no -- DOWN marker and no sibling %s"
            % (path, siblings[0])
        )
    return findings


def detect_migration_dialect(explicit="postgres", repo_files=()):
    """Resolve the effective migration dialect.

    `explicit` (the gate's `dialect` input, default postgres) wins unless
    it is postgres and `repo_files` names a D1 signal (a path mentioning
    d1, e.g. wrangler D1 config); then sqlite is returned so D1 repos are
    not flagged for Postgres-only syntax SQLite rejects. The gate itself
    greps wrangler configs for `d1_databases` before calling this.
    """
    if (explicit or "postgres") != "postgres":
        return explicit
    names = [str(p).lower() for p in (repo_files or ())]
    if any("d1" in name for name in names):
        return "sqlite"
    return "postgres"
