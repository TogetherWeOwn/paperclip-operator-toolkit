#!/usr/bin/env python3
"""Deterministic migration checks (blocker-ledger class 4).

Flags unsafe or non-reversible schema migrations: destructive DDL without
an explicit safety ack, non-concurrent index builds, lossy column-type
changes, and migrations missing a down path.

Stdlib only, pure functions, no network/clock/filesystem.
"""

import json
import posixpath
import re
import tomllib

MIGRATION_DIRS = ("migrations/", "alembic/versions/")

SAFETY_ACK = "safety: acknowledged"

# Dialects: postgres enforces CONCURRENTLY/USING; sqlite (D1) skips them
# because SQLite rejects that syntax. postgres-transactional is a
# forward-only transactional Postgres runner (each file applied in one
# transaction, no DOWN files): CONCURRENTLY cannot run inside a transaction
# block, so it is skipped like sqlite, but USING is kept (valid in a
# transaction). Destructive-DDL reports under every dialect; the down-path
# check is postgres-only because D1 migrations are forward-only (no DOWN
# marker or sibling down file exists) and postgres-transactional repos
# are forward-only by runner contract.
DIALECTS = ("postgres", "sqlite", "postgres-transactional")

_DOWN_RE = re.compile(r"(?m)^\s*--\s*down\s*$", re.IGNORECASE)
_DROP_TABLE_RE = re.compile(r"\bdrop\s+table\b", re.IGNORECASE)
_DROP_COLUMN_RE = re.compile(r"\bdrop\s+column\b", re.IGNORECASE)
_TRUNCATE_RE = re.compile(r"\btruncate\b", re.IGNORECASE)
_CREATE_INDEX_RE = re.compile(r"\bcreate\s+(unique\s+)?index\b", re.IGNORECASE)
_CONCURRENTLY_RE = re.compile(r"\bconcurrently\b", re.IGNORECASE)
_SQL_IDENTIFIER = r'''(?:"(?:[^"]|"")+"|'(?:[^']|'')+'|`[^`]+`|\[[^\]]+\]|[\w$]+)'''
_ALTER_TABLE_RE = re.compile(
    r"^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"
    + _SQL_IDENTIFIER + r"(?:\s*\.\s*" + _SQL_IDENTIFIER + r")*\s*\*?\s+",
    re.IGNORECASE,
)
# Search version (no `^` anchor) for ALTERs nested in DO blocks, function
# bodies, and EXECUTE strings: `_statements` splits on every `;`, so an
# ALTER inside `DO $$ BEGIN ... ; END $$` sits in a chunk starting with
# `DO`, never with `ALTER`. Searching finds each inner prefix; clauses are
# split from the end of one match to the start of the next.
_ALTER_TABLE_SEARCH_RE = re.compile(
    r"\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"
    + _SQL_IDENTIFIER + r"(?:\s*\.\s*" + _SQL_IDENTIFIER + r")*\s*\*?\s+",
    re.IGNORECASE,
)
# Per-file opt-outs (case-insensitive `--` comments): a forward-only file
# has no DOWN path by contract. Markers are read from the raw file text
# (comments included) so they work even though safety checks run on
# comment-stripped SQL.
# NOTE: `-- no-transaction` (the sqlx marker for a migration that does NOT
# run in a transaction) is deliberately NOT a CONCURRENTLY skip: a
# non-transactional file is exactly where CONCURRENTLY works, so the gate
# still requires it there. Transactional runners pin the
# `postgres-transactional` dialect instead of a per-file marker.
_FORWARD_ONLY_RE = re.compile(
    r"--\s*forward-only\b|forward-only\s*:\s*acknowledged", re.IGNORECASE
)
_CREATE_TABLE_RE = re.compile(
    r"\bcreate\s+(?:temporary\s+|temp\s+|unlogged\s+|global\s+|local\s+)*"
    r"table\s+(?:if\s+not\s+exists\s+)?"
    + r"(" + _SQL_IDENTIFIER + r"(?:\s*\.\s*" + _SQL_IDENTIFIER + r")*)",
    re.IGNORECASE,
)
_INDEX_TABLE_RE = re.compile(
    r"\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?"
    r"(?:if\s+not\s+exists\s+)?"
    + r"(?:" + _SQL_IDENTIFIER + r"(?:\s*\.\s*" + _SQL_IDENTIFIER + r")*\s+)?"
    + r"on\s+(?:only\s+)?"
    + r"(" + _SQL_IDENTIFIER + r"(?:\s*\.\s*" + _SQL_IDENTIFIER + r")*)",
    re.IGNORECASE,
)
# A present COLUMN keyword cannot backtrack into a column named "column".
_ALTER_CLAUSE_RE = re.compile(
    r"^\s*alter\s+(?:column\s+|(?!column\b))(?:if\s+exists\s+)?"
    + _SQL_IDENTIFIER + r"\s+(?:set\s+data\s+)?type\b",
    re.IGNORECASE,
)
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


def _normalize_ident_part(part):
    """One identifier part, unquoted and lowercased (Postgres folds unquoted)."""
    text = (part or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'`":
        text = text[1:-1]
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    return text.lower()


def _normalize_table(name):
    """Full normalised qualified name, for strict same-file compare.

    Every dotted part is unquoted/lowercased and the qualification is
    preserved: `public.events` and `archive.events` never compare equal,
    and a qualified side never matches an unqualified side (an unqualified
    `CREATE TABLE t` is not proof that `public.t` is new — fail closed and
    warn). Only two unqualified names compare bare.
    """
    parts = [p for p in (name or "").strip().split(".")]
    normed = [_normalize_ident_part(p) for p in parts]
    normed = [p for p in normed if p]
    return ".".join(normed)


_SINGLE_QUOTE_RE = re.compile(r"'(?:[^']|'')*'")
_DOLLAR_TAG_RE = re.compile(r"\$[A-Za-z_][\w$]*\$|\$\$")


def _strip_single_quoted_literals(text):
    """Blank single-quoted string contents (keep the quotes for structure).

    A `COMMENT ON TABLE events IS 'create table events ...'` literal must
    never count as a table creation. Doubled `''` escapes are honoured.
    """
    return _SINGLE_QUOTE_RE.sub("''", text or "")


def _strip_dollar_quoted_blocks(text):
    """Remove Postgres dollar-quoted bodies (`$$ ... $$`, `$tag$ ... $tag$`).

    `CREATE TABLE` inside a `DO $$` guard or a `CREATE FUNCTION ... $$`
    body is conditional/procedural code, never proof the table is new.
    Unmatched tags are left alone (fail closed: the statements still scan).
    """
    out = text or ""
    # Iterate over opening tags; each needs its matching close.
    pos = 0
    while True:
        m = _DOLLAR_TAG_RE.search(out, pos)
        if not m:
            break
        tag = m.group(0)
        close = out.find(tag, m.end())
        if close == -1:
            pos = m.end()
            continue
        out = out[: m.start()] + " " + out[close + len(tag):]
        pos = m.start() + 1
    return out


def _created_tables(up):
    """Tables created at top level of the up-section (strict, fail closed).

    Comment-stripped, single-quoted literals blanked (literal prose never
    counts), dollar-quoted `DO`/function bodies removed, then scanned per
    `;`-separated statement. Skipped as proof: `TEMP`/`TEMPORARY` tables
    (a temp object is never the persistent table the index builds on),
    and any creation inside a `DO`/function/`EXECUTE` fragment
    (dollar-quote remnants, a `DO ` line prefix, or a statement-opening
    `EXECUTE` keyword). A top-level `CREATE TABLE IF NOT EXISTS` counts
    as proof: the idempotent `IF NOT EXISTS` pair is the dominant shape
    in forward-only repos, and excluding it flags roughly half of a real
    corpus. A column named `executed_at`/`execute_at` never skips the
    statement: only a statement-opening `EXECUTE` counts.
    """
    no_comments = _strip_sql_comments(up)
    no_literals = _strip_single_quoted_literals(no_comments)
    top_level = _strip_dollar_quoted_blocks(no_literals)
    created = set()
    for stmt in _statements(top_level):
        if re.search(r"(?m)^\s*execute\b", stmt, re.IGNORECASE):
            continue
        if re.search(r"(?m)^\s*do\b", stmt, re.IGNORECASE):
            continue
        for m in _CREATE_TABLE_RE.finditer(stmt):
            whole = m.group(0)
            if re.search(r"\btemp(orary)?\b", whole, re.IGNORECASE):
                continue
            table = _normalize_table(m.group(1))
            if table:
                created.add(table)
    return created


def _index_table(stmt):
    """Indexed table for a CREATE INDEX statement, or None."""
    m = _INDEX_TABLE_RE.search(stmt)
    return _normalize_table(m.group(1)) if m else None


def _alter_type_missing_using(stmt):
    """Check each ALTER [COLUMN] .. TYPE action, not the table identifier.

    Searches (not start-anchored) so ALTERs nested in `DO $$` blocks,
    function bodies, and `EXECUTE '...'` strings still report: the chunk
    starts with `DO`/`CREATE FUNCTION`, but the inner `ALTER TABLE`
    prefix is found and clauses split from its end to the next match.
    Short-form `ALTER c TYPE`, per-clause USING, and the column/table
    named `type` negatives are preserved.
    """
    matches = list(_ALTER_TABLE_SEARCH_RE.finditer(stmt))
    if not matches:
        return False
    for idx, match in enumerate(matches):
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(stmt)
        for clause in _split_top_level_commas(stmt[match.end():end]):
            if _ALTER_CLAUSE_RE.match(clause) and not _USING_RE.search(clause):
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
    `dialect="postgres-transactional"` (forward-only runner applying each
    file in one transaction) skips CONCURRENTLY (it cannot run inside a
    transaction block) but keeps USING; destructive-DDL still reports.
    Under plain `postgres` there is no per-file CONCURRENTLY skip:
    `-- no-transaction` (sqlx: this file does NOT run in a transaction) is
    exactly where CONCURRENTLY works, so it still requires it. A
    `CREATE INDEX` on a table created at top level in the same up-section
    never reports (a brand-new persistent table has no concurrent writers
    to block, including the idempotent `CREATE TABLE IF NOT EXISTS` +
    `CREATE INDEX IF NOT EXISTS` pair); the match is strict (full
    qualified name, no TEMP, never inside literals or DO/function
    bodies, never a statement-opening `EXECUTE`).
    """
    if dialect not in DIALECTS:
        raise ValueError("unknown dialect: %r" % (dialect,))
    sqlite = dialect == "sqlite"
    transactional = dialect == "postgres-transactional"
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
            skip_concurrently = transactional
            created = _created_tables(up) if not skip_concurrently else set()
            for stmt in _statements(up):
                if (
                    not skip_concurrently
                    and _CREATE_INDEX_RE.search(stmt)
                    and not _CONCURRENTLY_RE.search(stmt)
                ):
                    table = _index_table(stmt)
                    if table and table in created:
                        continue
                    if "CREATE INDEX without CONCURRENTLY" not in reasons:
                        reasons.append("CREATE INDEX without CONCURRENTLY")
                if not sqlite and _alter_type_missing_using(stmt):
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
    migrations are forward-only, so every file would otherwise warn.
    `dialect="postgres-transactional"` likewise skips it: the runner is
    forward-only by contract. Under plain `postgres`, a file carrying a
    `-- forward-only` (or `forward-only: acknowledged`) comment is
    forward-only by declaration and skips the check for that file only."""
    if (dialect or "postgres") not in DIALECTS:
        raise ValueError("unknown dialect: %r" % (dialect,))
    if (dialect or "postgres") in ("sqlite", "postgres-transactional"):
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
        if _FORWARD_ONLY_RE.search(text or ""):
            continue
        siblings = _down_siblings(path)
        if any(sibling in changed_files for sibling in siblings):
            continue
        findings.append(
            "%s: migration has no -- DOWN marker and no sibling %s"
            % (path, siblings[0])
        )
    return findings


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


def _jsonc_text(text):
    """Strip JSONC comments/trailing commas outside double-quoted strings.

    Apostrophes in comments are not quotes. Preserve escaped quotes and
    comment delimiters inside strings; let json.loads reject malformed
    data rather than guessing a directory that could weaken the gate.
    """
    out = []
    quoted = False
    i = 0
    while i < len(text):
        ch = text[i]
        if quoted:
            out.append(ch)
            if ch == "\\":
                out.append(text[i + 1:i + 2])
                i += 2
                continue
            if ch == '"':
                quoted = False
        elif ch == '"':
            quoted = True
            out.append(ch)
        elif text.startswith("//", i):
            end = text.find("\n", i + 2)
            i = len(text) if end == -1 else end
            out.append(" ")
            continue
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end == -1:
                raise ValueError("unterminated JSONC comment")
            out.append(" ")
            i = end + 2
            continue
        else:
            # Whitespace/comments can follow a trailing comma. Remove
            # it only when the next code token closes the array/object.
            if ch in "]}":
                j = len(out) - 1
                while j >= 0 and out[j].isspace():
                    j -= 1
                if j >= 0 and out[j] == ",":
                    out[j] = " "
            out.append(ch)
        i += 1
    return "".join(out)


def _wrangler_config(text):
    """Parse TOML or JSONC with stdlib (Python 3.11+); invalid means no D1."""
    text = text or ""
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        try:
            config = json.loads(_jsonc_text(text))
        except ValueError:
            return {}
        return config if isinstance(config, dict) else {}


def _d1_binding_dirs(text, cfg_dir):
    """Resolve root and env-scoped D1 bindings without leaking defaults.

    Each scope may supply its own legacy `migrations_dir` default; each
    binding otherwise defaults to config-relative `migrations`. Parsing
    the config makes quoted TOML env names and every JSON env array work,
    while comments or marker strings outside bindings cannot select D1.
    """
    config = _wrangler_config(text)
    scopes = [config]
    envs = config.get("env", {})
    if isinstance(envs, dict):
        scopes.extend(v for v in envs.values() if isinstance(v, dict))
    dirs = []
    for scope in scopes:
        bindings = scope.get("d1_databases", [])
        if not isinstance(bindings, list):
            continue
        for binding in bindings:
            if not isinstance(binding, dict):
                continue
            value = binding.get(
                "migrations_dir", scope.get("migrations_dir", "migrations")
            )
            if isinstance(value, str) and value.strip():
                dirs.append(_join_config_dir(cfg_dir, _normalize_dir(value)))
    return dirs


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

    `explicit="postgres"` / `"sqlite"` / `"postgres-transactional"`
    (the gate's `dialect` input) is final and never auto-switched, so a
    mixed repo can always pin Postgres and a forward-only transactional
    runner can pin `postgres-transactional`. Any other non-`"auto"`
    value (including `"Postgres"`) raises `ValueError` instead of
    silently falling back to auto.
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
    if explicit in ("postgres", "sqlite", "postgres-transactional"):
        return explicit
    if explicit != "auto":
        raise ValueError("unknown dialect: %r" % (explicit,))
    texts = list(wrangler_texts or ())
    paths = list(wrangler_paths or ())
    dirs = _wrangler_migrations_dirs(texts, paths)
    if dirs:
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
    dirs = _wrangler_migrations_dirs(wrangler_texts, wrangler_paths)
    if not dirs:
        return "postgres"
    normed = _normalize_changed_path(path)
    for d in dirs:
        if d and (normed == d or normed.startswith(d.rstrip("/") + "/")):
            return "sqlite"
    return "postgres"
