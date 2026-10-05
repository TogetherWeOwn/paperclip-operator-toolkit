#!/usr/bin/env python3
"""paperclip-upgrade/migration_gate.py -- prove required Drizzle migrations
are APPLIED, keyed the way the runtime itself keys them.

WHY NOT `where id='0280'` OR created_at. drizzle.__drizzle_migrations.id is a
serial, not a tag, so `id='0280'` matches whichever row happens to be 280th.
created_at is not stable either: packages/db/src/client.ts
recordMigrationHistoryEntry writes max(latest_created_at + 1, journal.when),
and journal `when` values are not monotonic. The runtime's authoritative
"is this migration applied" test (client.ts loadAppliedMigrations) is the
sha256 of the migration .sql file content against ledger.hash. This gate uses
the same key, against the .sql files shipped INSIDE the target image.

Inputs:
  --sql-hashes FILE    sha256sum output over every <tag>.sql in the target
                       image's packages/db/src/migrations directory
  --ledger FILE        `select hash from <schema>.__drizzle_migrations`, one
                       row per line (extra whitespace-separated fields ignored)
  --require PREFIX     4-digit tag prefix that must be applied, e.g. 0280
                       (repeatable)
  --allow-pending      do not fail on image migrations missing from the ledger
                       (pre-boot inspection only)
  --max-unknown N      ledger hashes the image does not ship that are
                       tolerated (default 0). Unknown rows mean the database is
                       AHEAD of the image (or a shipped file was edited);
                       booting that image is a schema downgrade. Record the
                       pre-upgrade baseline and pass it here.
  --known-ahead FILE   sha256sum output over a NEWER image's migrations.
                       Ledger hashes listed there are reported as "ahead"
                       instead of "unknown" and do not count against
                       --max-unknown. Used ONLY by an image-only rollback:
                       the old image ignores ledger rows it does not ship
                       (client.ts loadAppliedMigrations compares hashes it
                       knows), so rows written by the newer image are
                       tolerated precisely when they are that image's own
                       files and nothing else.

Output: one line per check on stdout ("ok: ..." / "FAIL: ..."); never row data
beyond tags and counts.

Exit: 0 all gates pass | 1 a gate failed | 2 bad input (REFUSED)
"""
import argparse
import re
import sys

HEX64 = re.compile(r"[0-9a-f]{64}")


def refuse(msg):
    print(f"REFUSED: migration_gate: {msg}", file=sys.stderr)
    sys.exit(2)


def load_hashes(path):
    """tag -> sha256 from sha256sum output; refuses an empty or malformed file."""
    tags = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line:
                    continue
                m = re.fullmatch(r"([0-9a-f]{64})\s+\*?(?:.*/)?([^/\s]+)\.sql", line)
                if not m:
                    refuse(f"unparseable --sql-hashes line: {line[:80]}")
                if m.group(2) in tags:
                    refuse(f"duplicate migration tag in --sql-hashes: {m.group(2)}")
                tags[m.group(2)] = m.group(1)
    except OSError as exc:
        refuse(f"cannot read --sql-hashes {path}: {exc.__class__.__name__}")
    if not tags:
        refuse("--sql-hashes lists no migrations")
    return tags


def load_ledger(path):
    hashes = []
    try:
        with open(path, encoding="utf-8") as fh:
            for raw in fh:
                fields = raw.split()
                if not fields:
                    continue
                found = [f for f in fields if HEX64.fullmatch(f)]
                if len(found) != 1:
                    refuse("ledger row without exactly one sha256 hash field")
                hashes.append(found[0])
    except OSError as exc:
        refuse(f"cannot read --ledger {path}: {exc.__class__.__name__}")
    if not hashes:
        refuse("ledger is empty: refusing to treat an empty or unreadable migration table as evidence")
    return hashes


def main(argv):
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--sql-hashes", required=True)
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--require", action="append", default=[])
    ap.add_argument("--allow-pending", action="store_true")
    ap.add_argument("--max-unknown", type=int, default=0)
    ap.add_argument("--known-ahead")
    args = ap.parse_args(argv)

    for p in args.require:
        if not re.fullmatch(r"[0-9]{4}", p):
            refuse(f"--require must be a 4-digit migration prefix: {p}")
    if args.max_unknown < 0:
        refuse("--max-unknown must be >= 0")

    image = load_hashes(args.sql_hashes)
    applied = set(load_ledger(args.ledger))

    rc = 0
    for prefix in args.require:
        matches = sorted(t for t in image if t.startswith(prefix + "_"))
        if len(matches) != 1:
            print(f"FAIL: required migration {prefix} has {len(matches)} .sql files in the target image (want exactly 1)")
            rc = 1
            continue
        tag = matches[0]
        if image[tag] not in applied:
            print(f"FAIL: required migration {tag} is NOT applied (its sha256 is not in the ledger)")
            rc = 1
            continue
        print(f"ok: migration applied: {tag} (sha256 verified)")

    pending = sorted(t for t, h in image.items() if h not in applied)
    if pending and not args.allow_pending:
        print(f"FAIL: {len(pending)} image migration(s) not applied; first: {pending[0]}")
        rc = 1
    elif pending:
        print(f"ok: {len(pending)} image migration(s) pending (allowed: pre-boot inspection); first: {pending[0]}")
    else:
        print(f"ok: all {len(image)} image migrations are applied")

    known = set(image.values())
    ahead_known = set(load_hashes(args.known_ahead).values()) if args.known_ahead else set()
    ahead = len([h for h in applied if h not in known and h in ahead_known])
    if args.known_ahead:
        print(f"ok: {ahead} ledger migration(s) ahead of the target image, all shipped by the --known-ahead image")
    unknown = len([h for h in applied if h not in known and h not in ahead_known])
    if unknown > args.max_unknown:
        print(f"FAIL: {unknown} ledger migration(s) unknown to the target image (max {args.max_unknown}): database ahead of image")
        rc = 1
    else:
        print(f"ok: {unknown} ledger migration(s) unknown to the target image (max {args.max_unknown})")
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
