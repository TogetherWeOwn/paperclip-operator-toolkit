#!/usr/bin/env python3
"""
TOG-208 — per-connection attribution hook for TOG-207-bakeoff-harness.sh (G7/G8).

WHY THIS FILE EXISTS
--------------------
The harness emits a pre-written `g7-<arm>.sql` and accepts a `TOG207_CONN_COUNTS_CMD`
hook. The SQL it emits does not run against omniroute@3.8.49, and one of its three
queries returns a PASS in exactly the situation it exists to detect. Verified this run
against a fixture built from omniroute's own shipped DDL (src/lib/db/core.ts and
migrations/050_session_account_affinity.sql), not from a hand-written schema:

  D-1  `uh.created_at` DOES NOT EXIST. usage_history's time column is `timestamp`
       (core.ts). `created_at` appears zero times in any usage_history context in src/,
       and no migration adds it.  -> "no such column: uh.created_at"
       This kills the window predicate, which is the entire attribution mechanism.

  D-2  `pc.account_label` DOES NOT EXIST on provider_connections. That table labels
       connections with `name`. `account_label` is a column on usage_history.
       -> "no such column: pc.account_label"

  D-3  THE DANGEROUS ONE. The G8 DB-side check reads the `session_account_affinity`
       TABLE. omniroute@3.8.49 never writes that table -- there are ZERO
       `INSERT INTO session_account_affinity` statements in src/. Migration 050 creates
       it; the runtime stores affinity in `key_value` under
       namespace='session_account_affinity' (src/lib/db/sessionAccountAffinity.ts:12).
       So the shipped query returns 0 unconditionally.
       Measured on the fixture: 7 real affinity records present, shipped query -> 0.
       G8 is the guard the issue text calls load-bearing ("without it, session affinity
       pins one connection and all eight arms read 100%/0%"). A vacuous PASS there means
       an affinity-pinned matrix reads as a clean "no rotation mechanism works".

  D-4  Query 2 groups by `pc.provider` through a LEFT JOIN, then filters on it in WHERE,
       which degrades the LEFT JOIN to an INNER JOIN and silently drops rows whose
       connection record was deleted. usage_history carries its own `provider`; no join
       is needed.

  D-5  No `success` segmentation. usage_history has `success INTEGER DEFAULT 1`. Counting
       failures into a rotation split biases it toward whichever connection fails more --
       and 429s/errors are precisely what a rotation arm provokes.

And the harness ingests this hook as `$CMD ... > tsv 2>err || true`, so every one of the
above fails SILENTLY: `perConnection` stays null, G10 degrades to provider-level, and the
run reports main-vs-main-2 as "not measured" after the money is already spent.

USAGE
-----
  # once, before the matrix -- refuses to proceed on a schema it cannot serve
  ./TOG-208-conn-counts.py selftest

  # wire into the harness (this is the whole integration)
  export TOG207_CONN_COUNTS_CMD="/path/to/TOG-208-conn-counts.py counts"
  OMNIROUTE_MGMT_TOKEN=... OMNIROUTE_API_KEY=... ./TOG-207-bakeoff-harness.sh 98

  # G8 DB-side, corrected -- run per arm; NON-ZERO exit means the arm is pin-contaminated
  ./TOG-208-conn-counts.py affinity <W_START> <W_END>

  # human-readable per-arm summary
  ./TOG-208-conn-counts.py report <W_START> <W_END>

DB is opened READ-ONLY (`mode=ro`). This script never writes to OmniRoute state.
Override discovery with TOG208_DB=/path/to/storage.sqlite (or DATA_DIR=...).
"""

import json
import os
import sqlite3
import sys

PROVIDER = os.environ.get("TOG208_PROVIDER", "opencode-go")

# Columns each query genuinely depends on. selftest asserts these against the LIVE db,
# so a schema drift fails here rather than becoming a null column in results.json.
REQUIRED = {
    "usage_history": ["connection_id", "account_label", "provider", "success", "timestamp"],
    "provider_connections": ["id", "provider", "name", "priority"],
    "key_value": ["namespace", "key", "value"],
}

CANDIDATE_DIRS = [
    os.environ.get("DATA_DIR"),
    os.path.expanduser("~/.omniroute"),
    os.path.expanduser("~/.omniroute/data"),
    "/data",
    "/app/data",
    "/var/lib/omniroute",
]


def find_db():
    explicit = os.environ.get("TOG208_DB")
    if explicit:
        if not os.path.exists(explicit):
            die(f"TOG208_DB={explicit} does not exist")
        return explicit
    for d in CANDIDATE_DIRS:
        if not d:
            continue
        p = os.path.join(d, "storage.sqlite")
        if os.path.exists(p):
            return p
    die(
        "could not locate storage.sqlite. omniroute resolves it as "
        "$DATA_DIR/storage.sqlite (core.ts:89-91). Set TOG208_DB=/path/to/storage.sqlite."
    )


def die(msg, code=2):
    print(f"TOG-208 conn-counts FATAL: {msg}", file=sys.stderr)
    sys.exit(code)


def connect():
    p = find_db()
    try:
        db = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    except sqlite3.OperationalError as e:
        die(f"cannot open {p} read-only: {e}")
    return db, p


def columns(db, table):
    return [r[1] for r in db.execute(f"PRAGMA table_info({table})")]


def cmd_selftest():
    db, p = connect()
    print(f"db: {p}")
    ok = True
    for table, cols in REQUIRED.items():
        have = columns(db, table)
        if not have:
            print(f"  ✗ table {table}: MISSING")
            ok = False
            continue
        missing = [c for c in cols if c not in have]
        if missing:
            print(f"  ✗ table {table}: missing columns {missing}")
            ok = False
        else:
            print(f"  ✓ table {table}: all required columns present")

    # The three defects, asserted as live facts rather than as claims in a comment.
    uh = columns(db, "usage_history")
    pc = columns(db, "provider_connections")
    print("\n  shipped-SQL defect checks against THIS database:")
    print(f"    D-1 usage_history.created_at absent  : {'created_at' not in uh}")
    print(f"    D-2 provider_connections.account_label absent : {'account_label' not in pc}")
    n_tbl = db.execute("SELECT COUNT(*) FROM session_account_affinity").fetchone()[0]
    n_kv = db.execute(
        "SELECT COUNT(*) FROM key_value WHERE namespace='session_account_affinity'"
    ).fetchone()[0]
    print(f"    D-3 affinity rows in legacy TABLE    : {n_tbl}")
    print(f"    D-3 affinity records in key_value    : {n_kv}   <-- the real store")
    if n_tbl == 0 and n_kv > 0:
        print("        => the shipped G8 query would report CLEAN while affinity is live.")
    db.close()
    if not ok:
        die("schema does not match what the attribution queries require", 3)
    print("\nselftest PASS — safe to wire as TOG207_CONN_COUNTS_CMD")


def _counts(db, w0, w1):
    # A raw sqlite traceback here is worse than useless: the harness ingests this hook as
    # `$CMD ... > tsv 2>err || true`, so a stack trace becomes an empty TSV and
    # `perConnection: null` -- indistinguishable from "this arm produced no traffic".
    # Fail with something the operator can act on instead.
    try:
        return list(
            db.execute(
                """
        SELECT uh.connection_id,
               COALESCE(pc.name, uh.account_label, uh.connection_id) AS label,
               SUM(CASE WHEN uh.success = 1 THEN 1 ELSE 0 END) AS ok_calls,
               COUNT(*) AS all_calls
          FROM usage_history uh
          LEFT JOIN provider_connections pc ON pc.id = uh.connection_id
         WHERE uh.timestamp >= ? AND uh.timestamp < ?
           AND uh.provider = ?
         GROUP BY uh.connection_id, label, pc.priority
         ORDER BY ok_calls DESC
    """,
                (w0, w1, PROVIDER),
            )
        )
    except sqlite3.OperationalError as e:
        die(
            f"attribution query failed against this database: {e}\n"
            "  Run `TOG-208-conn-counts.py selftest` — it names the exact missing columns.\n"
            "  Do NOT let the matrix continue: the harness swallows this hook's failure\n"
            "  (`|| true`) and would record perConnection:null for every arm."
        )


def cmd_counts(w0, w1):
    """Emit the TSV contract the harness parses: connection_id<TAB>label<TAB>calls.

    `calls` is SUCCESSFUL calls (D-5). all_calls rides along as a 4th column; the
    harness reads only the first three fields, so it is free diagnostics.
    """
    db, _ = connect()
    rows = _counts(db, w0, w1)
    if not rows:
        print(
            f"TOG-208: zero {PROVIDER} rows in [{w0}, {w1}). Either the window is wrong "
            "or no request in this arm was attributed.",
            file=sys.stderr,
        )
    for cid, label, ok, allc in rows:
        print(f"{cid}\t{label}\t{ok}\t{allc}")
    db.close()


def cmd_affinity(w0, w1):
    """Corrected G8 DB-side check (D-3). Exit 1 if the arm may be affinity-pinned."""
    db, _ = connect()
    live = 0
    total = 0
    for (val,) in db.execute(
        "SELECT value FROM key_value WHERE namespace='session_account_affinity' AND key LIKE ?",
        (f"{PROVIDER}:%",),
    ):
        total += 1
        try:
            rec = json.loads(val)
        except Exception:
            continue
        # overlap test: a pin created before the window end and still valid at window start
        created = str(rec.get("createdAt") or "")
        expires = str(rec.get("expiresAt") or "")
        if created < w1 and expires > w0:
            live += 1
    legacy = db.execute("SELECT COUNT(*) FROM session_account_affinity").fetchone()[0]
    db.close()
    print(f"affinity_records_total\t{total}")
    print(f"affinity_records_overlapping_window\t{live}")
    print(f"legacy_table_rows\t{legacy}\t(always 0 on 3.8.49 — never written)")
    if live > 0:
        print(
            f"G8 DB-SIDE FAIL: {live} session-affinity pin(s) overlap [{w0}, {w1}). "
            "This arm's split may be an artefact of a pin, not of the strategy. DISCARD IT.",
            file=sys.stderr,
        )
        sys.exit(1)


def cmd_report(w0, w1):
    db, _ = connect()
    print(f"window [{w0}, {w1})  provider={PROVIDER}\n")
    rows = _counts(db, w0, w1)
    tot = sum(r[2] for r in rows) or 1
    print(f"{'connection_id':38} {'label':10} {'ok':>5} {'all':>5} {'share':>7}")
    for cid, label, ok, allc in rows:
        print(f"{cid:38} {label:10} {ok:5d} {allc:5d} {ok / tot:6.1%}")
    print("\nprovider mix in the same window (openrouter rows = PAYG fallthrough):")
    for prov, ok, allc in db.execute(
        """SELECT uh.provider, SUM(CASE WHEN uh.success=1 THEN 1 ELSE 0 END), COUNT(*)
             FROM usage_history uh WHERE uh.timestamp >= ? AND uh.timestamp < ?
            GROUP BY uh.provider ORDER BY COUNT(*) DESC""",
        (w0, w1),
    ):
        print(f"  {prov:24} ok={ok:5d} all={allc:5d}")
    db.close()


def main():
    if len(sys.argv) < 2:
        die("usage: TOG-208-conn-counts.py {selftest|counts|affinity|report} [W_START W_END]")
    cmd = sys.argv[1]
    if cmd == "selftest":
        return cmd_selftest()
    if len(sys.argv) < 4:
        die(f"'{cmd}' needs <W_START> <W_END> as ISO-8601 UTC, e.g. 2026-08-23T23:00:00Z")
    w0, w1 = sys.argv[2], sys.argv[3]
    if cmd == "counts":
        return cmd_counts(w0, w1)
    if cmd == "affinity":
        return cmd_affinity(w0, w1)
    if cmd == "report":
        return cmd_report(w0, w1)
    die(f"unknown subcommand '{cmd}'")


if __name__ == "__main__":
    main()
