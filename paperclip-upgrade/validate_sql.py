#!/usr/bin/env python3
"""paperclip-upgrade/validate_sql.py -- prove the rehearsal SQL against a real
Paperclip schema on an ISOLATED test database.

What it proves, in one throwaway database it creates and always drops:
  1. builds the schema from a migrations dir (one transaction per migration,
     ledger rows written the way the runtime keys them: sha256 of the .sql);
  2. seeds one ARMED row for every producer gate neutralise-stage.sql closes;
  3. NEGATIVE CONTROL: the verification block alone must RAISE on the armed
     copy (otherwise the gate is vacuous);
  4. runs neutralise-stage.sql in one transaction; every gate must read 0;
  5. runs inventory.sql read-only and checks the seeded counts;
  6. optional --extra-migrations: applies newer migrations (e.g. fork
     0280-0284) on top of the neutralised copy and runs migration_gate.py
     against the resulting ledger, with a NEGATIVE CONTROL that a required
     migration missing from the ledger FAILS the gate, then the image-only
     rollback gate (old image hashes vs the upgraded ledger, --known-ahead);
  7. seeds drain-window fixtures (2030 timestamps, so no other row can match)
     and runs every drain.sh query READ-ONLY with its psql variables bound:
     inflight, leak (a retry is preserved work, a fresh run is a leak),
     drain-marker (N|N for the drain's own startedAt only), rewake (latest
     skipped wake per agent+card, every ineligibility rule, a second pass is a
     no-op), config (a pin change is drift, idle->running is not), fence and
     orphans (zero on a clean copy, exact counts once seeded). With
     --extra-migrations the same queries run again on the upgraded schema and
     must return identical output.

Fail-closed identity: refuses any host outside the allowlist (agent-testdb,
localhost) and only ever creates/drops databases named rehearse_sqlproof_*.
It needs a CREATEDB role that may set session_replication_role (the
agent-testdb role does); no production credential is
read or accepted (no DSN flag, no env DSN).

Exit: 0 proved | 1 a proof step failed | 2 refused
"""
import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import uuid

ALLOWED_HOSTS = {"agent-testdb", "localhost", "127.0.0.1"}
DB_PREFIX = "rehearse_sqlproof_"
HERE = os.path.dirname(os.path.abspath(__file__))


def refuse(msg):
    print(f"REFUSED: validate_sql: {msg}", file=sys.stderr)
    sys.exit(2)


def step(ok, msg):
    print(("ok: " if ok else "FAIL: ") + msg)
    return ok


def load_journal(mig_dir):
    path = os.path.join(mig_dir, "meta", "_journal.json")
    try:
        with open(path, encoding="utf-8") as fh:
            entries = json.load(fh)["entries"]
    except (OSError, ValueError, KeyError) as exc:
        refuse(f"cannot read journal {path}: {exc.__class__.__name__}")
    return sorted(entries, key=lambda e: e["idx"])


def apply_migrations(conn, mig_dir, only_after=None):
    """Apply journal entries (idx > only_after when given); one txn each."""
    cur = conn.cursor()
    cur.execute("CREATE SCHEMA IF NOT EXISTS drizzle")
    cur.execute("CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations "
                "(id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)")
    conn.commit()
    applied = []
    for e in load_journal(mig_dir):
        if only_after is not None and e["idx"] <= only_after:
            continue
        with open(os.path.join(mig_dir, e["tag"] + ".sql"), "rb") as fh:
            raw = fh.read()
        for stmt in raw.decode("utf-8").split("--> statement-breakpoint"):
            if stmt.strip():
                try:
                    cur.execute(stmt)
                except Exception as exc:  # noqa: BLE001 -- report and stop
                    conn.rollback()
                    print(f"FAIL: migration {e['tag']}: {str(exc).splitlines()[0]}")
                    return None
        cur.execute("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (%s, %s)",
                    (hashlib.sha256(raw).hexdigest(), e["when"]))
        conn.commit()
        applied.append(e["tag"])
    return applied


def insert_armed(cur, table, values):
    """Insert one row: explicit armed values + generated fillers for every
    NOT NULL column without a default. FKs/user triggers are off
    (session_replication_role=replica) so no parent rows are needed."""
    cur.execute("""SELECT column_name, udt_name FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=%s
                      AND is_nullable='NO' AND column_default IS NULL""", (table,))
    fill = {"uuid": "gen_random_uuid()", "text": "'x'", "jsonb": "'{}'::jsonb",
            "int4": "1", "int8": "1", "bool": "false", "timestamptz": "now()",
            "numeric": "0"}
    cols, exprs = [], []
    for name, udt in cur.fetchall():
        if name in values:
            continue
        if udt not in fill:
            raise RuntimeError(f"no filler for {table}.{name} ({udt})")
        cols.append(name)
        exprs.append(fill[udt])
    for name, expr in values.items():
        cols.append(name)
        exprs.append(expr)
    cur.execute(f'INSERT INTO public."{table}" ({", ".join(chr(34) + c + chr(34) for c in cols)}) '
                f'VALUES ({", ".join(exprs)})')


# One armed row per gate in neutralise-stage.sql section 9.
ARMED = [
    ("agents", {"runtime_config": "'{\"heartbeat\":{\"enabled\":true}}'::jsonb"}),
    ("agents", {"runtime_config": "'{}'::jsonb"}),
    ("heartbeat_runs", {"status": "'queued'"}),
    ("heartbeat_runs", {"status": "'scheduled_retry'"}),
    ("heartbeat_runs", {"status": "'succeeded'", "controller_lease_expires_at": "now() + interval '1 hour'"}),
    ("agent_wakeup_requests", {"status": "'queued'"}),
    ("agent_wakeup_requests", {"status": "'deferred_issue_execution'"}),
    ("issue_recovery_actions", {"status": "'active'"}),
    ("routines", {"status": "'active'"}),
    ("routine_triggers", {"enabled": "true", "next_run_at": "now()"}),
    ("plugin_jobs", {"status": "'active'", "next_run_at": "now()"}),
    ("plugin_job_runs", {"status": "'running'"}),
    ("plugin_webhook_deliveries", {"status": "'pending'"}),
    ("plugins", {"status": "'ready'"}),
    ("environment_leases", {"status": "'active'"}),
    ("execution_workspace_runtime_leases", {"expires_at": "now() + interval '30 minutes'"}),
    ("native_run_finalizations", {"phase": "'workspace_finalizing'", "lease_owner": "'w1'",
                                  "lease_expires_at": "now() + interval '1 minute'"}),
    ("issues", {"monitor_next_check_at": "now()"}),
    ("status_cards", {"next_eval_at": "now()"}),
    ("chat_deliveries", {"next_attempt_at": "now()"}),
    ("chat_endpoints", {"status": "'active'", "provider": "'slack'"}),
    ("connection_intent_deliveries", {"next_attempt_at": "now()"}),
    ("external_objects", {"next_refresh_at": "now()"}),
    ("status_decision_effects", {"next_attempt_at": "now()"}),
]
EXPECTED_GATES = 20


def verification_block(sql_text):
    i = sql_text.find("DO $$")
    if i < 0:
        refuse("neutralise SQL has no DO $$ verification block")
    return sql_text[i:]


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("PGHOST", "agent-testdb"))
    ap.add_argument("--user", default=os.environ.get("PGUSER", "agent_test"))
    ap.add_argument("--migrations", required=True, help="0279-era packages/db/src/migrations dir")
    ap.add_argument("--extra-migrations", help="newer migrations dir (e.g. fork 0280-0284)")
    ap.add_argument("--require", action="append", default=[], help="4-digit prefix migration_gate must see applied")
    ap.add_argument("--neutralise-sql", default=os.path.join(HERE, "neutralise-stage.sql"))
    ap.add_argument("--inventory-sql", default=os.path.join(HERE, "inventory.sql"))
    ap.add_argument("--keep", action="store_true", help="do not drop the proof database (debug)")
    args = ap.parse_args(argv)

    if args.host not in ALLOWED_HOSTS:
        refuse(f"host {args.host!r} is not an isolated test host (allowed: {sorted(ALLOWED_HOSTS)})")
    if os.environ.get("PGPASSWORD") or os.environ.get("DATABASE_URL") or os.environ.get("PGSERVICE"):
        refuse("PGPASSWORD/DATABASE_URL/PGSERVICE is set: this proof takes no credential; unset it")
    try:
        import psycopg2  # noqa: PLC0415
    except ImportError:
        refuse("python3 psycopg2 is not installed")

    dbname = DB_PREFIX + secrets.token_hex(4)
    assert dbname.startswith(DB_PREFIX)
    admin = psycopg2.connect(host=args.host, user=args.user, dbname="postgres", connect_timeout=10)
    admin.autocommit = True
    acur = admin.cursor()
    acur.execute("SELECT 1 FROM pg_database WHERE datname=%s", (dbname,))
    if acur.fetchone():
        refuse(f"collision: database {dbname} already exists")
    acur.execute(f'CREATE DATABASE "{dbname}"')
    print(f"ok: created isolated proof database {dbname} on {args.host}")

    ok = True
    try:
        conn = psycopg2.connect(host=args.host, user=args.user, dbname=dbname, connect_timeout=10)
        applied = apply_migrations(conn, args.migrations)
        ok &= step(applied is not None, f"schema built from {len(applied or [])} migrations")
        if not ok:
            return 1
        cur = conn.cursor()
        cur.execute("SET session_replication_role = replica")
        for table, values in ARMED:
            insert_armed(cur, table, values)
        cur.execute("SET session_replication_role = DEFAULT")
        conn.commit()
        print(f"ok: seeded {len(ARMED)} armed producer rows")

        with open(args.neutralise_sql, encoding="utf-8") as fh:
            neutralise = fh.read()
        verify = verification_block(neutralise)

        conn.notices.clear()
        try:
            cur.execute(verify)
            conn.commit()
            ok &= step(False, "NEGATIVE CONTROL: verification passed on an armed copy (gate is vacuous)")
        except psycopg2.Error as exc:
            conn.rollback()
            armed = [n for n in conn.notices if re.search(r"= [1-9]", n)]
            ok &= step("producer gate(s) still armed" in str(exc) and len(armed) == EXPECTED_GATES,
                       f"NEGATIVE CONTROL: armed copy raised; {len(armed)}/{EXPECTED_GATES} gates read > 0")

        conn.notices.clear()
        try:
            cur.execute(neutralise)
            conn.commit()
            zero = [n for n in conn.notices if re.search(r"verify \w+ = 0\b", n)]
            ok &= step(len(zero) == EXPECTED_GATES,
                       f"neutralise-stage.sql closed {len(zero)}/{EXPECTED_GATES} producer gates in one transaction")
        except psycopg2.Error as exc:
            conn.rollback()
            still = [n.strip() for n in conn.notices if re.search(r"= [1-9]", n)]
            ok &= step(False, f"neutralise-stage.sql raised: {str(exc).splitlines()[0]} {still}")

        ro = psycopg2.connect(host=args.host, user=args.user, dbname=dbname, connect_timeout=10)
        ro.set_session(readonly=True)
        rcur = ro.cursor()
        with open(args.inventory_sql, encoding="utf-8") as fh:
            inv_sql = fh.read()
        rcur.execute(inv_sql)
        inv = dict(r[0].split("|", 1) for r in rcur.fetchall())
        ro.rollback()
        ok &= step(inv.get("agents") == "2" and inv.get("heartbeat_runs") == "3"
                   and inv.get("ledger_rows") == str(len(applied))
                   and int(inv.get("schema_tables_public", "0")) > 100,
                   f"inventory.sql read-only: agents={inv.get('agents')} heartbeat_runs={inv.get('heartbeat_runs')} "
                   f"ledger_rows={inv.get('ledger_rows')} tables={inv.get('schema_tables_public')} "
                   f"indexes={inv.get('indexes_public')} ops_guard_functions={inv.get('ops_guard_functions')}")

        drain_out = drain_sql_proof(conn, rcur)
        ok &= drain_out is not None

        if args.extra_migrations:
            base_idx = max(e["idx"] for e in load_journal(args.migrations))
            extra = apply_migrations(conn, args.extra_migrations, only_after=base_idx)
            ok &= step(extra is not None, f"extra migrations applied on the neutralised copy: {extra}")
            if extra is not None:
                ok &= gate_proof(cur, args.extra_migrations, args.require or [t[:4] for t in extra])
                ok &= rollback_gate_proof(cur, args.migrations, args.extra_migrations)
                rcur.execute(inv_sql)
                inv2 = dict(r[0].split("|", 1) for r in rcur.fetchall())
                ro.rollback()
                print(f"ok: inventory after extra migrations: tables={inv2.get('schema_tables_public')} "
                      f"indexes={inv2.get('indexes_public')} ledger_rows={inv2.get('ledger_rows')} "
                      f"roles_nonsystem={inv2.get('roles_nonsystem')} ops_guard_functions={inv2.get('ops_guard_functions')}")
                if drain_out is not None:
                    again = {name: run_ro(rcur, name, binds) for name, binds in DRAIN_QUERIES}
                    same = [n for n in again if again[n] == drain_out[n]]
                    ok &= step(len(same) == len(DRAIN_QUERIES),
                               f"drain queries on the upgraded schema return identical output: "
                               f"{len(same)}/{len(DRAIN_QUERIES)} ({sorted(set(again) - set(same))} differ)")
        ro.close()
        conn.close()
    finally:
        if args.keep:
            print(f"kept: {dbname}")
        else:
            acur.execute(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')
            print(f"ok: dropped {dbname}")
        admin.close()
    print("VALIDATE_SQL " + ("PASSED" if ok else "FAILED"))
    return 0 if ok else 1


def gate_proof(cur, mig_dir, required):
    """migration_gate.py against the live ledger: positive, then a negative
    control with the newest required migration's ledger row withheld."""
    gate = os.path.join(HERE, "migration_gate.py")
    with tempfile.TemporaryDirectory() as td:
        hashes = os.path.join(td, "sql.sha256")
        write_hashes(mig_dir, hashes)
        cur.execute("SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id")
        ledger_rows = [r[0] for r in cur.fetchall()]
        cur.connection.rollback()
        ledger = os.path.join(td, "ledger.txt")
        with open(ledger, "w", encoding="utf-8") as out:
            out.write("\n".join(ledger_rows) + "\n")
        req = sum((["--require", p] for p in required), [])
        pos = subprocess.run([sys.executable, gate, "--sql-hashes", hashes, "--ledger", ledger, *req],
                             capture_output=True, text=True, check=False)
        ok = step(pos.returncode == 0, f"migration_gate on the post-upgrade ledger: rc={pos.returncode} "
                  f"({'; '.join(pos.stdout.split(chr(10))[:len(required)])})")
        # Negative control: withhold the ledger row of the newest REQUIRED
        # migration (keyed by its sha256); the gate must name it NOT applied.
        newest = sorted(n[:-4] for n in os.listdir(mig_dir)
                        if n.endswith(".sql") and n[:4] == sorted(required)[-1])[0]
        with open(os.path.join(mig_dir, newest + ".sql"), "rb") as fh:
            withheld = hashlib.sha256(fh.read()).hexdigest()
        with open(ledger, "w", encoding="utf-8") as out:
            out.write("\n".join(h for h in ledger_rows if h != withheld) + "\n")
        neg = subprocess.run([sys.executable, gate, "--sql-hashes", hashes, "--ledger", ledger, *req],
                             capture_output=True, text=True, check=False)
        ok &= step(neg.returncode == 1 and "NOT applied" in neg.stdout,
                   f"NEGATIVE CONTROL: migration_gate with {newest}'s ledger row withheld: rc={neg.returncode}")
    return ok


def write_hashes(mig_dir, path):
    with open(path, "w", encoding="utf-8") as out:
        for name in sorted(os.listdir(mig_dir)):
            if name.endswith(".sql"):
                with open(os.path.join(mig_dir, name), "rb") as fh:
                    out.write(f"{hashlib.sha256(fh.read()).hexdigest()}  {name}\n")


def rollback_gate_proof(cur, old_dir, new_dir):
    """Image-only rollback: the OLD image against the upgraded ledger. Without
    --known-ahead the newer rows are unknown (database ahead of image: FAIL);
    with the newer image's hashes as --known-ahead they are tolerated, and
    only they are: one foreign ledger row still fails."""
    gate = os.path.join(HERE, "migration_gate.py")
    with tempfile.TemporaryDirectory() as td:
        old_h, new_h, ledger = (os.path.join(td, n) for n in ("old.sha256", "new.sha256", "ledger.txt"))
        write_hashes(old_dir, old_h)
        write_hashes(new_dir, new_h)
        cur.execute("SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id")
        rows = [r[0] for r in cur.fetchall()]
        cur.connection.rollback()

        def run(extra_rows, *flags):
            with open(ledger, "w", encoding="utf-8") as out:
                out.write("\n".join(rows + extra_rows) + "\n")
            return subprocess.run([sys.executable, gate, "--sql-hashes", old_h, "--ledger", ledger, *flags],
                                  capture_output=True, text=True, check=False)
        bare = run([])
        ok = step(bare.returncode == 1 and "database ahead of image" in bare.stdout,
                  f"NEGATIVE CONTROL: old image vs upgraded ledger without --known-ahead: rc={bare.returncode}")
        known = run([], "--known-ahead", new_h)
        ok &= step(known.returncode == 0, f"image-only rollback gate with --known-ahead: rc={known.returncode} "
                   f"({[ln for ln in known.stdout.splitlines() if 'ahead' in ln]})")
        foreign = run([hashlib.sha256(b"not a shipped migration").hexdigest()], "--known-ahead", new_h)
        ok &= step(foreign.returncode == 1, f"NEGATIVE CONTROL: one foreign ledger row still fails "
                   f"the rollback gate: rc={foreign.returncode}")
    return ok


# --- drain.sh query proof -------------------------------------------------
# Every fixture timestamp sits in 2030 so nothing the ARMED seed or the
# migrations wrote can fall into a drain window.
T0 = "2030-01-01T00:00:00.000Z"          # task drain startedAt, as the API returns it
REQ = "2029-12-31T23:59:00.000Z"         # DB time recorded just before the POST
UNTIL = "2030-01-01T01:00:00.000Z"       # undrain
FENCE_SINCE = "2030-01-01T02:30:00.000Z"  # backup_at for the fence proof
DRAIN_QUERIES = [
    ("inflight.sql", {}),
    ("leak.sql", {"sa": T0}),
    ("drain-marker.sql", {"sa": T0, "req": REQ}),
    ("rewake.sql", {"since": REQ, "until": UNTIL}),
    ("config.sql", {}),
    ("fence.sql", {"since": FENCE_SINCE}),
    ("orphans.sql", {}),
]


def bind_psql_vars(sql_text, binds):
    """Replace psql :'name' variables with SQL string literals, exactly what
    `psql -v name=value` does for the :'name' form. An unbound variable is a
    proof failure, not a silent empty string."""
    def sub(m):
        if m.group(1) not in binds:
            raise RuntimeError(f"unbound psql variable :'{m.group(1)}'")
        return "'" + binds[m.group(1)].replace("'", "''") + "'"
    return re.sub(r":'([a-z_]+)'", sub, sql_text)


def run_ro(rcur, name, binds):
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        text = bind_psql_vars(fh.read(), binds)
    rcur.execute(text)
    rows = [r[0] for r in rcur.fetchall()]
    rcur.connection.rollback()
    return rows


def kv(rows):
    return dict(r.split("|", 1) for r in rows)


def ts(minutes):
    """2030-01-01T00:00Z + minutes, as a timestamptz literal."""
    return f"(timestamptz '{T0}' + interval '{minutes} minutes')"


def drain_sql_proof(conn, rcur):
    """Seed the drain-window fixtures and prove every drain.sh query. Returns
    the per-query output (for the post-upgrade identity check) or None."""
    cur = conn.cursor()
    u = {k: str(uuid.uuid4()) for k in (
        "C1 C2 A1 A2 A3 I1 I2 I3 I4 I5 I6 I7 W1a W1b W2 W3 W4 W5 W6 W6n W7 W8 W9 W10 W11 "
        "Rpre Rretry WRretry Rleak WL R5 CM1").split()}
    q = lambda k: f"'{u[k]}'"  # noqa: E731
    skip = lambda reason, issue=None, key="issueId", extra=None: (  # noqa: E731
        "'" + json.dumps({**({key: issue} if issue else {}), **(extra or {}),
                          "heartbeatSkip": {"reason": reason}}) + "'::jsonb")
    cur.execute("SET session_replication_role = replica")
    for c, prefix in (("C1", "FXA"), ("C2", "FXB")):
        insert_armed(cur, "companies", {"id": q(c), "issue_prefix": f"'{prefix}'", "status": "'active'"})
    for a, status in (("A1", "active"), ("A2", "paused"), ("A3", "idle")):
        insert_armed(cur, "agents", {"id": q(a), "company_id": q("C1"), "status": f"'{status}'",
                                     "name": f"'fx-{a}'", "adapter_config": "'{\"model\":\"m1\"}'::jsonb"})
    for i, status, who in (("I1", "todo", "A1"), ("I2", "done", "A1"), ("I3", "todo", "A3"),
                           ("I4", "in_progress", "A2"), ("I5", "todo", "A1"), ("I6", "todo", "A1"),
                           ("I7", "in_review", "A3")):
        insert_armed(cur, "issues", {"id": q(i), "company_id": q("C1"), "status": f"'{status}'",
                                     "assignee_agent_id": q(who)})
    # Suppressed wakes inside [REQ, UNTIL] unless noted.
    sup = "'heartbeat.scheduling_suppressed'"
    wakes = [
        ("W1a", "A1", 1, skip("task_drain", u["I1"])),
        ("W1b", "A1", 2, skip("task_drain", u["I1"], extra={"commentId": u["CM1"]})),  # latest -> owed
        ("W2", "A1", 3, skip("task_drain", u["I2"])),            # card done
        ("W3", "A1", 4, skip("task_drain", u["I3"])),            # card reassigned to A3
        ("W4", "A2", 5, skip("task_drain", u["I4"])),            # agent paused
        ("W5", "A1", 6, skip("task_drain", u["I5"])),            # run already queued
        ("W6", "A1", 7, skip("task_drain", u["I6"])),            # newer real wake exists
        ("W7", "A3", 8, skip("task_drain", u["I7"].upper(), key="taskId",
                             extra={"commentId": "not-a-uuid"})),  # taskId, upper case -> owed
        ("W8", "A1", 9, skip("task_drain")),                     # no card -> unattributable
        ("W9", "A1", 10, skip("worktree_instance", u["I1"])),    # not a drain skip
        ("W10", "A1", -60, skip("task_drain", u["I1"])),         # before the window
        ("W11", "A3", 11, skip("database_restore_in_progress", u["I3"])),  # restart hold -> owed
    ]
    for w, a, minute, payload in wakes:
        insert_armed(cur, "agent_wakeup_requests", {"id": q(w), "company_id": q("C1"), "agent_id": q(a),
                     "status": "'skipped'", "reason": sup, "payload": payload, "created_at": ts(minute)})
    issue_payload = lambda i: "'" + json.dumps({"issueId": u[i]}) + "'::jsonb"  # noqa: E731
    # A real wake for I6 after the undrain, a run that was executing before
    # the drain, its legitimate retry (run + wake), one leaked run, one leaked
    # wake, and the queued run that makes W5 ineligible (created pre-drain).
    insert_armed(cur, "agent_wakeup_requests", {"id": q("W6n"), "company_id": q("C1"), "agent_id": q("A1"),
                 "status": "'completed'", "payload": issue_payload("I6"), "created_at": ts(120)})
    insert_armed(cur, "heartbeat_runs", {"id": q("Rpre"), "company_id": q("C1"), "agent_id": q("A1"),
                 "status": "'running'", "created_at": ts(-10)})
    insert_armed(cur, "agent_wakeup_requests", {"id": q("WRretry"), "company_id": q("C1"), "agent_id": q("A1"),
                 "status": "'queued'", "created_at": ts(5)})
    insert_armed(cur, "heartbeat_runs", {"id": q("Rretry"), "company_id": q("C1"), "agent_id": q("A1"),
                 "status": "'scheduled_retry'", "retry_of_run_id": q("Rpre"),
                 "wakeup_request_id": q("WRretry"), "created_at": ts(5)})
    insert_armed(cur, "heartbeat_runs", {"id": q("Rleak"), "company_id": q("C1"), "agent_id": q("A3"),
                 "status": "'queued'", "created_at": ts(6)})
    insert_armed(cur, "agent_wakeup_requests", {"id": q("WL"), "company_id": q("C1"), "agent_id": q("A3"),
                 "status": "'queued'", "created_at": ts(6)})
    insert_armed(cur, "heartbeat_runs", {"id": q("R5"), "company_id": q("C1"), "agent_id": q("A1"),
                 "status": "'queued'", "context_snapshot": issue_payload("I5"), "created_at": ts(-5)})
    # Drain markers: two for this drain (one per company), plus three that
    # must NOT match: another startedAt, a stale row, a "stopped" row.
    marker = lambda sa: "'" + json.dumps({"startedAt": sa, "expiresAt": None}) + "'::jsonb"  # noqa: E731
    for company, action, sa, minute in (("C1", "started", T0, 0), ("C2", "started", T0, 0),
                                        ("C1", "started", "2030-01-01T00:00:00.001Z", 0),
                                        ("C1", "started", T0, -1440), ("C2", "stopped", T0, 0)):
        insert_armed(cur, "activity_log", {"company_id": q(company), "action": f"'instance.task_drain.{action}'",
                     "entity_type": "'instance_settings'", "entity_id": "'default'",
                     "details": marker(sa), "created_at": ts(minute)})
    cur.execute("SET session_replication_role = DEFAULT")
    conn.commit()

    ok = True
    out = {name: run_ro(rcur, name, binds) for name, binds in DRAIN_QUERIES}
    inflight = kv(out["inflight.sql"])
    hard = sorted(k for k in inflight if not k.startswith("info_"))
    ok &= step(hard == ["native_finalizations_leased", "plugin_job_runs_running", "runs_controller_lease_live",
                        "runs_running", "wakes_claimed"] and inflight["runs_running"] == "1"
               and all(re.fullmatch(r"[a-z_]+\|[0-9]+", r) for r in out["inflight.sql"]),
               f"inflight.sql: 5 hard gates, runs_running={inflight.get('runs_running')} (the pre-drain run)")

    leak = kv(out["leak.sql"])
    ok &= step(leak == {"leak_runs": "1", "leak_wakes": "2", "info_retries_since": "1",
                        "info_wakes_skipped_since": "11"},
               f"leak.sql: retry run+wake are preserved work, fresh run and wakes leak: {leak}")
    clean = kv(run_ro(rcur, "leak.sql", {"sa": "2030-01-01T03:00:00.000Z"}))
    ok &= step(clean.get("leak_runs") == "0" and clean.get("leak_wakes") == "0",
               f"leak.sql POSITIVE CONTROL: nothing admitted after a later startedAt reads 0: {clean}")

    ok &= step(out["drain-marker.sql"] == ["2|2"],
               f"drain-marker.sql: this drain's markers|companies = {out['drain-marker.sql']} (want 2|2)")
    other = run_ro(rcur, "drain-marker.sql", {"sa": "2030-01-01T00:00:00.002Z", "req": REQ})
    ok &= step(other == ["0|2"], f"drain-marker.sql NEGATIVE CONTROL: another startedAt = {other} (want 0|2)")

    want_wakes = sorted([f"wake|{u['W1b']}|{u['A1']}|{u['I1']}|{u['CM1']}",
                         f"wake|{u['W7']}|{u['A3']}|{u['I7']}|-",
                         f"wake|{u['W11']}|{u['A3']}|{u['I3']}|-"])
    got = out["rewake.sql"]
    ok &= step(sorted(r for r in got if r.startswith("wake|")) == want_wakes
               and "unattributable|1" in got and "ineligible|5" in got and len(got) == 5,
               f"rewake.sql: 3 owed wakes (latest per agent+card), unattributable=1, ineligible=5 "
               f"(done/reassigned/paused/run-queued/newer-wake); got {len(got)} lines")
    # Second pass: the rewake POST is itself a newer non-skipped wake.
    cur.execute("SET session_replication_role = replica")
    insert_armed(cur, "agent_wakeup_requests", {"company_id": q("C1"), "agent_id": q("A1"), "status": "'queued'",
                 "payload": issue_payload("I1"), "created_at": ts(90)})
    cur.execute("SET session_replication_role = DEFAULT")
    conn.commit()
    again = run_ro(rcur, "rewake.sql", {"since": REQ, "until": UNTIL})
    ok &= step(not any(r.startswith(f"wake|{u['W1b']}|") for r in again) and "ineligible|6" in again,
               "rewake.sql second pass: an already re-woken card is no longer owed (ineligible=6)")

    cfg = out["config.sql"]
    ok &= step(any(r.startswith(f"agent|{u['A3']}|{u['C1']}|active|") for r in cfg)
               and any(r.startswith(f"company|{u['C1']}|") for r in cfg),
               f"config.sql: {len(cfg)} fingerprint lines, idle agent fingerprinted as active")
    cur.execute(f"UPDATE agents SET status = 'running' WHERE id = {q('A3')}")
    cur.execute(f"""UPDATE agents SET adapter_config = '{{"model":"m2"}}'::jsonb WHERE id = {q('A1')}""")
    conn.commit()
    drift = sorted(set(cfg) - set(run_ro(rcur, "config.sql", {})))
    ok &= step(len(drift) == 1 and drift[0].startswith(f"agent|{u['A1']}|"),
               f"config.sql: a model pin change is drift, idle->running is not ({len(drift)} drifted line)")

    fence = kv(out["fence.sql"])
    ok &= step(sum(int(v) for v in fence.values()) == 0, f"fence.sql: 0 writes after backup_at on a clean copy")
    cur.execute("SET session_replication_role = replica")
    insert_armed(cur, "issue_comments", {"company_id": q("C1"), "issue_id": q("I1"), "body": "'after backup'",
                 "created_at": ts(180), "updated_at": ts(180)})
    cur.execute("SET session_replication_role = DEFAULT")
    conn.commit()
    fence2 = kv(run_ro(rcur, "fence.sql", {"since": FENCE_SINCE}))
    ok &= step(fence2.get("issue_comments") == "1" and sum(int(v) for v in fence2.values()) == 1,
               "fence.sql NEGATIVE CONTROL: one comment written after backup_at is counted")

    orph = kv(out["orphans.sql"])
    ok &= step(len(orph) == 6 and all(v == "0" for v in orph.values()),
               f"orphans.sql POSITIVE CONTROL: neutralised copy has 0 orphans in {len(orph)} checks")
    src = str(uuid.uuid4())
    cur.execute("SET session_replication_role = replica")
    insert_armed(cur, "native_run_finalizations", {"phase": "'workspace_finalizing'", "lease_owner": "'gone'",
                 "lease_expires_at": "now() - interval '1 minute'"})
    insert_armed(cur, "heartbeat_runs", {"id": q("WL"), "company_id": q("C1"), "agent_id": q("A1"),
                 "status": "'succeeded'"})
    insert_armed(cur, "environment_leases", {"status": "'active'", "heartbeat_run_id": q("WL")})
    insert_armed(cur, "execution_workspace_runtime_leases", {"owner_run_id": q("WL"),
                 "expires_at": "now() + interval '10 minutes'"})
    insert_armed(cur, "issue_recovery_actions", {"source_issue_id": f"'{src}'", "status": "'active'",
                 "updated_at": "now() - interval '3 hours'", "timeout_at": "now() - interval '1 hour'"})
    for _ in range(2):
        insert_armed(cur, "issue_recovery_actions", {"source_issue_id": f"'{src}'", "status": "'cancelled'"})
    cur.execute("SET session_replication_role = DEFAULT")
    conn.commit()
    orph2 = kv(run_ro(rcur, "orphans.sql", {}))
    ok &= step(all(v == "1" for v in orph2.values()) and len(orph2) == 6,
               f"orphans.sql NEGATIVE CONTROL: one seeded orphan per check reads 1: {orph2}")
    # Restore the fixture state the identity re-run expects.
    cur.execute(f"""UPDATE agents SET adapter_config = '{{"model":"m1"}}'::jsonb, status = 'idle' WHERE id IN ({q('A1')}, {q('A3')})""")
    conn.commit()
    if not ok:
        return None
    return {name: run_ro(rcur, name, binds) for name, binds in DRAIN_QUERIES}


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
