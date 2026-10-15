#!/usr/bin/env python3
"""Deterministic migration checks (blocker-ledger class 4).

Flags unsafe or non-reversible schema migrations: destructive DDL without
an explicit safety ack, non-concurrent index builds, lossy column-type
changes, and migrations missing a down path.

Stdlib only, pure functions, no network/clock/filesystem.
"""

import posixpath
import re

MIGRATION_DIRS = ("migrations/", "alembic/versions/")

SAFETY_ACK = "safety: acknowledged"

# Dialects: postgres enforces CONCURRENTLY/USING; sqlite (D1) skips them
# because SQLite rejects that syntax. Destructive-DDL reports under every
# dialect; the down-path check is postgres-only because D1 migrations are
# forward-only (no DOWN marker or sibling down file exists).
DIALECTS = ("postgres", "sqlite")

_DOWN_RE = re.compile(r"(?m)^\s*--\s*down\s*$", re.IGNORECASE)
_DROP_TABLE_RE = re.compile(r"\bdrop\s+table\b", re.IGNORECASE)
_DROP_COLUMN_RE = re.compile(r"\bdrop\s+column\b", re.IGNORECASE)
_TRUNCATE_RE = re.compile(r"\btruncate\b", re.IGNORECASE)
_CREATE_INDEX_RE = re.compile(r"\bcreate\s+(unique\s+)?index\b", re.IGNORECASE)
_CONCURRENTLY_RE = re.compile(r"\bconcurrently\b", re.IGNORECASE)
_ALTER_TYPE_RE = re.compile(
    r"\balter\s+column\s+(?:if\s+exists\s+)?"
    r"(?:\"[^\"]+\"|'[^']+'|`[^`]+`|\[[^\]]+\]|[\w$.]+)"
    r"\s+(?:set\s+data\s+)?type\b",
    re.IGNORECASE,
)
_ALTER_CLAUSE_RE = _ALTER_TYPE_RE
_USING_RE = re.compile(r"\busing\b", re.IGNORECASE)


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
    Single-pass and quote-aware for both comment forms: a `/*` inside a
    single/double-quoted literal is kept (seed rows with glob patterns are
    common in migrations), and Postgres-nested `/* /* */ */` blocks are
    removed by depth. An unterminated block is kept verbatim (fail closed:
    its content still reports) rather than swallowing the rest of the file.
    """
    text = sql or ""
    out = []
    i = 0
    n = len(text)
    quote = None
    depth = 0
    block_start = 0
    while i < n:
        ch = text[i]
        if depth > 0:
            # Inside a block comment: quotes are comment text, nesting counts.
            if ch == "/" and i + 1 < n and text[i + 1] == "*":
                depth += 1
                i += 2
                continue
            if ch == "*" and i + 1 < n and text[i + 1] == "/":
                depth -= 1
                i += 2
                if depth == 0:
                    out.append(" ")
                continue
            i += 1
            continue
        if quote is not None:
            out.append(ch)
            if ch == quote:
                # SQL escapes '' by doubling; a doubled quote stays quoted.
                if i + 1 < n and text[i + 1] == quote:
                    out.append(text[i + 1])
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
        if ch == "-" and i + 1 < n and text[i + 1] == "-":
            # Line comment: skip to (not including) the newline.
            while i < n and text[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            depth = 1
            block_start = i
            i += 2
            continue
        out.append(ch)
        i += 1
    if depth > 0:
        # Unterminated block: fail closed, keep the raw text so its
        # statements still report instead of vanishing silently.
        out.append(text[block_start:])
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


def check_migration_down(changed_files, contents, dialect="postgres"):
    """Every changed *.sql migration file present in contents must carry
    a -- DOWN marker (case-insensitive) or have a sibling down file in
    changed_files. Paths missing from contents (e.g. deleted files, which
    the gate excludes via --diff-filter=d) are skipped. One finding per
    migration missing both. Non-migration files are ignored.

    `dialect="sqlite"` (Cloudflare D1) skips the check entirely: D1
    migrations are forward-only, so every file would otherwise warn."""
    if (dialect or "postgres") not in DIALECTS:
        raise ValueError("unknown dialect: %r" % (dialect,))
    if (dialect or "postgres") == "sqlite":
        return []
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


_MIGRATIONS_DIR_RE = re.compile(
    # The key may be quoted (wrangler.json/.jsonc `"migrations_dir": ...`),
    # so allow one optional closing quote before the `:`/`=`.
    r"""migrations_dir\s*["']?\s*[:=]\s*["']([^"']+)["']""", re.IGNORECASE
)


def _normalize_dir(value):
    """Normalise a `migrations_dir` value for path comparison: strip
    whitespace, drop leading `./` segments, drop trailing slashes."""
    v = (value or "").strip()
    while v.startswith("./"):
        v = v[2:]
    return v.strip().strip("/")


def _config_dir(wrangler_path):
    """The wrangler config's own directory (`worker/wrangler.toml` ->
    `worker`, root configs -> `""`): `migrations_dir` resolves relative
    to it, never to the repo root."""
    p = str(wrangler_path or "").replace("\\", "/").strip()
    while p.startswith("./"):
        p = p[2:]
    p = p.strip("/")
    if not p or "/" not in p:
        return ""
    return p.rsplit("/", 1)[0]


def _join_config_dir(cfg_dir, value):
    """Join a wrangler config dir with a `migrations_dir` value.

    Normalised with `posixpath.normpath`, so `.` and `..` segments
    (`./db/migrations`, `../../db/migrations`) resolve the way wrangler
    resolves them relative to the config file.
    """
    raw = (cfg_dir + "/" + value) if cfg_dir else value
    normed = posixpath.normpath(raw.replace("\\", "/").strip())
    while normed.startswith("./"):
        normed = normed[2:]
    if normed in ("", "."):
        return ""
    return normed.strip("/")


def _normalize_changed_path(path):
    p = str(path or "").replace("\\", "/").strip()
    while p.startswith("./"):
        p = p[2:]
    return p.lstrip("/")


def _code_lines(text):
    """Yield uncommented code lines: drop full-line `#` / `//` comments and
    strip inline `#` / `//` tails outside single/double-quoted strings.

    A commented `# d1_databases` line must never flip detection, and the
    check reads config text (never the PR diff), so a PR cannot smuggle
    the marker in through an unrelated file.
    """
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        out = []
        quote = None
        i = 0
        n = len(raw)
        while i < n:
            ch = raw[i]
            if quote is not None:
                out.append(ch)
                if ch == quote:
                    quote = None
                i += 1
                continue
            if ch in ("'", '"'):
                quote = ch
                out.append(ch)
                i += 1
                continue
            if ch == "#" or (ch == "/" and i + 1 < n and raw[i + 1] == "/"):
                break
            out.append(ch)
            i += 1
        code = "".join(out).strip()
        if code:
            yield code


def _wrangler_declares_d1(wrangler_texts):
    """True when any wrangler config text declares `d1_databases` in code
    (comments ignored)."""
    for text in wrangler_texts or ():
        for line in _code_lines(text):
            if "d1_databases" in line.lower():
                return True
    return False


def _text_declares_d1(text):
    """True when one wrangler config text declares `d1_databases` in code
    (comments ignored)."""
    for line in _code_lines(text):
        if "d1_databases" in line.lower():
            return True
    return False


def _split_d1_tables(text):
    """Split a TOML wrangler text into its `[[d1_databases]]` tables.

    Returns None when the text has no TOML D1 table (JSON configs and
    D1-free files take other paths); otherwise one body per binding.
    A body runs to the next `[` header so a second table's
    `migrations_dir` never leaks into the first binding.
    """
    parts = re.split(
        r"(?im)^\s*\[\[\s*d1_databases\s*\]\]", text or ""
    )
    if len(parts) < 2:
        return None
    bodies = []
    for section in parts[1:]:
        bodies.append(re.split(r"(?m)^\s*\[", section, maxsplit=1)[0])
    return bodies


def _d1_json_array_span(text):
    """Span of the `"d1_databases": [...]` array in a JSON wrangler text.

    Returns None when there is no JSON D1 array (TOML configs and D1-free
    files take other paths). Bracket depth is tracked outside string
    literals so a `]` inside a value never ends the array early.
    """
    match = re.search(r'"d1_databases"\s*:\s*\[', text or "")
    if not match:
        return None
    i = match.end() - 1
    n = len(text)
    depth = 0
    quote = None
    while i < n:
        ch = text[i]
        if quote is not None:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            i += 1
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return text[match.start():i + 1]
        i += 1
    return None


def _split_json_objects(array_span):
    """Top-level `{...}` objects of a JSON array span (brace depth outside
    string literals). Returns [] when the span holds no objects."""
    objs = []
    depth = 0
    quote = None
    start = None
    i = 0
    n = len(array_span or "")
    while i < n:
        ch = array_span[i]
        if quote is not None:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            i += 1
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    objs.append(array_span[start:i + 1])
                    start = None
        i += 1
    return objs


def _d1_binding_dirs(text, cfg_dir):
    """One resolved `migrations_dir` per `[[d1_databases]]` binding.

    Each binding without its own `migrations_dir` keeps the
    config-relative `migrations` default, so a second binding never
    loses its directory. Returns [] when the text declares no D1
    database (comments ignored, so `# d1_databases` never counts).
    """
    if not _text_declares_d1(text):
        return []
    tables = _split_d1_tables(text)
    if tables is not None:
        preface = re.split(
            r"(?im)^\s*\[\[\s*d1_databases\s*\]\]", text or "", maxsplit=1
        )[0]
        fallback = None
        for line in _code_lines(preface):
            m = _MIGRATIONS_DIR_RE.search(line)
            if m:
                fallback = m.group(1)
                break
        dirs = []
        for body in tables:
            code = "\n".join(_code_lines(body))
            m = _MIGRATIONS_DIR_RE.search(code)
            val = m.group(1) if m else (fallback or "migrations")
            dirs.append(_join_config_dir(cfg_dir, _normalize_dir(val)))
        return dirs
    span = _d1_json_array_span(text or "")
    if span is not None:
        outside = (text or "").replace(span, " ")
        fallback = None
        for line in _code_lines(outside):
            m = _MIGRATIONS_DIR_RE.search(line)
            if m:
                fallback = m.group(1)
                break
        objs = _split_json_objects(span)
        if not objs:
            return [
                _join_config_dir(cfg_dir, _normalize_dir(fallback or "migrations"))
            ]
        dirs = []
        for obj in objs:
            found = None
            for line in _code_lines(obj):
                m = _MIGRATIONS_DIR_RE.search(line)
                if m:
                    found = m.group(1)
                    break
            dirs.append(
                _join_config_dir(
                    cfg_dir, _normalize_dir(found or fallback or "migrations")
                )
            )
        return dirs
    return [_join_config_dir(cfg_dir, "migrations")]


def _wrangler_migrations_dirs(wrangler_texts, wrangler_paths=()):
    """All D1 `migrations_dir` values declared in wrangler config texts,
    resolved relative to each config's own directory.

    `wrangler_paths` parallels `wrangler_texts` (empty/absent entries mean
    repo root, preserving the legacy root-relative behaviour). Values are
    normalised with `posixpath.normpath` (`./` and `..` segments
    resolved); each `[[d1_databases]]` binding contributes its own entry
    (default `migrations` when the binding declares none). Configs that
    declare no D1 database contribute nothing.
    """
    dirs = []
    texts = list(wrangler_texts or ())
    paths = list(wrangler_paths or ())
    for i, text in enumerate(texts):
        cfg = _config_dir(paths[i] if i < len(paths) else "")
        dirs.extend(_d1_binding_dirs(text, cfg))
    return dirs


def detect_migration_dialect(
    explicit="auto",
    repo_files=(),
    wrangler_texts=(),
    changed_paths=(),
    wrangler_paths=(),
):
    """Resolve the effective migration dialect.

    `explicit="postgres"` / `"sqlite"` (the gate's `dialect` input) is
    final and never auto-switched, so a mixed repo can always pin
    Postgres. Any other non-`"auto"` value (including `"Postgres"`)
    raises `ValueError` instead of silently falling back to auto.
    `explicit="auto"` (the gate default) selects sqlite only when a
    wrangler config declares `d1_databases` in uncommented code AND that
    D1 config's `migrations_dir` (default: `migrations` relative to the
    config's own directory) covers one of `changed_paths`; otherwise
    postgres. A bare `d1_databases` string in a PR diff or a commented
    config line never flips the result.

    `wrangler_paths` parallels `wrangler_texts` with each config's
    repo-relative path so `migrations_dir` resolves as
    `<config dir>/<migrations_dir>` (wrangler semantics); absent entries
    mean repo root. `repo_files` keeps the legacy path-name signal: when
    no wrangler texts are given, a path mentioning d1 still resolves
    sqlite.
    """
    explicit = explicit or "auto"
    if explicit in ("postgres", "sqlite"):
        return explicit
    if explicit != "auto":
        raise ValueError("unknown dialect: %r" % (explicit,))
    texts = list(wrangler_texts or ())
    paths = list(wrangler_paths or ())
    d1_indexes = [i for i, t in enumerate(texts) if _text_declares_d1(t)]
    if d1_indexes:
        dirs = []
        for i in d1_indexes:
            cfg = _config_dir(paths[i] if i < len(paths) else "")
            dirs.extend(_d1_binding_dirs(texts[i], cfg))
        # Only changed `.sql` migration files can select sqlite: a
        # README or any other non-SQL file under a D1 directory must
        # never switch off the Postgres checks for the real migrations
        # in the same PR.
        normed = [
            _normalize_changed_path(p)
            for p in (changed_paths or ())
            if str(p).endswith(".sql")
        ]
        if not normed:
            return "sqlite" if not (changed_paths or ()) else "postgres"
        for path in normed:
            for d in dirs:
                if d and (path == d or path.startswith(d.rstrip("/") + "/")):
                    return "sqlite"
        return "postgres"
    names = [str(p).lower() for p in (repo_files or ())]
    if texts:
        return "postgres"
    if any("d1" in name for name in names):
        return "sqlite"
    return "postgres"


def dialect_for_migration_path(path, wrangler_texts=(), wrangler_paths=()):
    """The dialect for one migration file.

    Returns `"sqlite"` only when a wrangler config declares
    `d1_databases` in uncommented code AND that D1 config's
    `migrations_dir` (per binding, default `migrations` relative to the
    config's own directory) covers this `.sql` path; otherwise
    `"postgres"`. Non-SQL paths always resolve `"postgres"`, so touching
    a README under a D1 directory never switches off the Postgres
    checks for the real migrations in the same PR. The gate resolves
    every changed migration with this helper instead of one dialect per
    PR.
    """
    if not str(path or "").endswith(".sql"):
        return "postgres"
    texts = list(wrangler_texts or ())
    paths = list(wrangler_paths or ())
    dirs = []
    for i, text in enumerate(texts):
        cfg = _config_dir(paths[i] if i < len(paths) else "")
        dirs.extend(_d1_binding_dirs(text, cfg))
    if not dirs:
        return "postgres"
    normed = _normalize_changed_path(path)
    for d in dirs:
        if d and (normed == d or normed.startswith(d.rstrip("/") + "/")):
            return "sqlite"
    return "postgres"
