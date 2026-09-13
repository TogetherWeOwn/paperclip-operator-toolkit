#!/usr/bin/env bash
# ===========================================================================
# test_host_db_backup.sh — regression suite for the TOG-2370 host-side backup
# fallback.
#
# Offline: `podman` is a recording stub (see $WORK/bin/podman) so no real
# container, database, or network is touched. `gzip`/`flock`/`date`/`find`/
# `stat` are the real system binaries -- their behaviour is exactly what the
# script depends on, so stubbing them would test the stub instead of the
# script.
#
# The load-bearing properties, in the order they matter:
#   1. A verified-good dump lands under the documented `-hostcron.sql.gz`
#      name and passes every check a human would run by hand.
#   2. A short, truncated, or trailer-less dump is NEVER left visible under
#      its final name (the TOG-1129/1130 empty-gzip-residue failure mode).
#   3. A concurrent dump (this script's own overlapping tick, or a live
#      COPY the courtesy check can see) causes a clean skip, not a stack.
#   4. Retention prunes only files THIS script wrote; a server-authored
#      archive is never touched.
#   5. Bad arguments and missing preconditions refuse (exit 2), never guess.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${HOST_DB_BACKUP_SH:-$HERE/host_db_backup.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -x "$TOOL" ]] || { echo "ERROR: $TOOL is not executable" >&2; exit 1; }
for t in podman gzip flock date find stat; do
  : # real binaries are required on the test host too; the script itself checks this
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_host_db_backup.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin" "$WORK/backups" "$WORK/lockdir"

cat > "$WORK/bin/podman" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  container)
    [[ "$2" == "exists" ]] || exit 2
    exit "${FAKE_CONTAINER_EXISTS_RC:-0}"
    ;;
  exec)
    shift; shift
    case "$1" in
      sh)
        script="$3"
        case "$script" in
          *POSTGRES_USER*) printf '%s\n' "${FAKE_POSTGRES_USER-paperclip}" ;;
          *POSTGRES_DB*)   printf '%s\n' "${FAKE_POSTGRES_DB-paperclip}" ;;
          *) exit 1 ;;
        esac
        ;;
      psql)
        printf '%s\n' "${FAKE_ACTIVE_DUMPS:-0}"
        ;;
      pg_dump)
        rc="${FAKE_PGDUMP_RC:-0}"
        if [[ "$rc" != 0 ]]; then exit "$rc"; fi
        cat "${FAKE_DUMP_SQL_FILE:?FAKE_DUMP_SQL_FILE not set}"
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
STUB
chmod +x "$WORK/bin/podman"

export PATH="$WORK/bin:$PATH"
export HOST_DB_BACKUP_LOCK_DIR="$WORK/lockdir"

# A dump that passes every check: >1KiB AFTER gzip, exactly one completion
# trailer, at least one CREATE TABLE. The padding must be incompressible
# (random, not repeated 'x's) or gzip collapses it under the 1024-byte floor
# the script checks on the COMPRESSED output.
GOOD_DUMP="$WORK/good.sql"
{
  echo "-- PostgreSQL database dump"
  echo "CREATE TABLE issues (id integer);"
  head -c 4096 /dev/urandom | base64 | sed 's/^/-- padding /'
  echo "-- PostgreSQL database dump complete"
} > "$GOOD_DUMP"

run() {
  OUT="$("$TOOL" --backup-dir "$WORK/backups" "$@" 2>&1)"
  RC=$?
}

reset_env() {
  unset FAKE_CONTAINER_EXISTS_RC FAKE_POSTGRES_USER FAKE_POSTGRES_DB \
        FAKE_ACTIVE_DUMPS FAKE_PGDUMP_RC FAKE_DUMP_SQL_FILE
}

# The podman stub runs as a separate process (found via $PATH), so its
# FAKE_* knobs must be exported, not merely assigned, or it never sees them.
set -a

# --- 1. argument validation -------------------------------------------------
hdr "Rejects bad arguments instead of guessing"
reset_env
"$TOOL" --retention-days 0 >/dev/null 2>&1; (( $? == 2 )) && ok "rejects --retention-days 0" || bad "accepted retention-days 0"
"$TOOL" --retention-days abc >/dev/null 2>&1; (( $? == 2 )) && ok "rejects non-numeric --retention-days" || bad "accepted non-numeric retention-days"
"$TOOL" --container 'evil; rm -rf /' >/dev/null 2>&1; (( $? == 2 )) && ok "rejects a container name with shell metacharacters" || bad "accepted an unsafe container name"
"$TOOL" --bogus-flag >/dev/null 2>&1; (( $? == 2 )) && ok "rejects an unknown flag" || bad "accepted an unknown flag"
"$TOOL" --backup-dir "$WORK/does-not-exist" >/dev/null 2>&1; (( $? == 2 )) && ok "refuses a missing backup directory" || bad "did not refuse a missing backup directory"

# --- 2. precondition checks --------------------------------------------------
hdr "Refuses on precondition failure, not silent success"
reset_env
FAKE_CONTAINER_EXISTS_RC=1 run
(( RC == 2 )) && ok "refuses when the container is absent" || bad "expected exit 2 on absent container, got $RC"

# --- 3. dry run --------------------------------------------------------------
hdr "Dry run writes nothing"
reset_env
FAKE_DUMP_SQL_FILE="$GOOD_DUMP"
before_count=$(find "$WORK/backups" -type f | wc -l)
run --dry-run
after_count=$(find "$WORK/backups" -type f | wc -l)
(( RC == 0 )) && ok "dry run exits 0" || bad "dry run exit $RC"
[[ "$before_count" == "$after_count" ]] && ok "dry run creates no file" || bad "dry run created a file"
grep -q "DRY-RUN" <<<"$OUT" && ok "dry run says so" || bad "dry run did not announce itself"

# --- 4. the happy path -------------------------------------------------------
hdr "A good dump lands, verified, under the documented name"
reset_env
FAKE_DUMP_SQL_FILE="$GOOD_DUMP"
rm -f "$WORK/backups"/*
run
(( RC == 0 )) && ok "good dump exits 0" || bad "good dump exit $RC ($OUT)"
landed=$(find "$WORK/backups" -maxdepth 1 -type f -name 'paperclip-*-hostcron.sql.gz' | wc -l)
(( landed == 1 )) && ok "exactly one -hostcron.sql.gz lands" || bad "expected 1 landed file, found $landed"
no_partial=$(find "$WORK/backups" -maxdepth 1 -type f -name '*.partial' | wc -l)
(( no_partial == 0 )) && ok "no .partial file left behind on success" || bad "a .partial file survived a successful run"
landed_file="$(find "$WORK/backups" -maxdepth 1 -type f -name 'paperclip-*-hostcron.sql.gz')"
gzip -t "$landed_file" 2>/dev/null && ok "landed file is a valid gzip stream" || bad "landed file failed gzip -t"
grep -q "host_db_backup=PASS" <<<"$OUT" && ok "reports PASS" || bad "did not report PASS"

# --- 5. truncation is never left visible under the real name ----------------
hdr "A too-small dump is rejected, not landed"
reset_env
TINY="$WORK/tiny.sql"
printf 'x' > "$TINY"
FAKE_DUMP_SQL_FILE="$TINY"
rm -f "$WORK/backups"/*
run
(( RC == 1 )) && ok "tiny dump exits 1" || bad "expected exit 1 on tiny dump, got $RC"
survivors=$(find "$WORK/backups" -maxdepth 1 -type f | wc -l)
(( survivors == 0 )) && ok "no file left behind for a tiny dump" || bad "a file survived a tiny/failed dump"

hdr "A dump missing the completion trailer is rejected, not landed"
reset_env
NOTRAILER="$WORK/notrailer.sql"
{ echo "CREATE TABLE issues (id integer);"; head -c 2048 /dev/zero | tr '\0' 'x'; } > "$NOTRAILER"
FAKE_DUMP_SQL_FILE="$NOTRAILER"
rm -f "$WORK/backups"/*
run
(( RC == 1 )) && ok "missing-trailer dump exits 1" || bad "expected exit 1, got $RC"
survivors=$(find "$WORK/backups" -maxdepth 1 -type f | wc -l)
(( survivors == 0 )) && ok "no file left behind when the trailer is missing" || bad "a file survived a missing-trailer dump"

hdr "A dump with no CREATE TABLE statements is rejected, not landed"
reset_env
NOTABLES="$WORK/notables.sql"
{ echo "-- PostgreSQL database dump"; head -c 2048 /dev/zero | tr '\0' 'x'; echo "-- PostgreSQL database dump complete"; } > "$NOTABLES"
FAKE_DUMP_SQL_FILE="$NOTABLES"
rm -f "$WORK/backups"/*
run
(( RC == 1 )) && ok "no-CREATE-TABLE dump exits 1" || bad "expected exit 1, got $RC"
survivors=$(find "$WORK/backups" -maxdepth 1 -type f | wc -l)
(( survivors == 0 )) && ok "no file left behind when there are no CREATE TABLE statements" || bad "a file survived a table-less dump"

hdr "A failed pg_dump pipeline is rejected, not landed"
reset_env
FAKE_PGDUMP_RC=1
rm -f "$WORK/backups"/*
run
(( RC == 1 )) && ok "pg_dump failure exits 1" || bad "expected exit 1, got $RC"
survivors=$(find "$WORK/backups" -maxdepth 1 -type f | wc -l)
(( survivors == 0 )) && ok "no file left behind when pg_dump itself fails" || bad "a file survived a failed pg_dump"

# --- 6. concurrency: courtesy check and self-lock ---------------------------
hdr "A live COPY in pg_stat_activity causes a clean skip, not a stacked dump"
reset_env
FAKE_ACTIVE_DUMPS=1
FAKE_DUMP_SQL_FILE="$GOOD_DUMP"
rm -f "$WORK/backups"/*
run
(( RC == 0 )) && ok "skip on active dump exits 0, not an error" || bad "expected exit 0 on courtesy skip, got $RC"
grep -qi "SKIP" <<<"$OUT" && ok "explains the skip" || bad "did not explain the skip"
landed=$(find "$WORK/backups" -maxdepth 1 -type f | wc -l)
(( landed == 0 )) && ok "no dump is stacked on top of an active one" || bad "a dump landed despite an active COPY"

hdr "A held lock file causes a clean skip, not a stacked dump"
reset_env
FAKE_DUMP_SQL_FILE="$GOOD_DUMP"
rm -f "$WORK/backups"/*
exec 8>"$WORK/lockdir/host_db_backup.lock"
flock -n 8
run
(( RC == 0 )) && ok "skip while another cycle holds the lock exits 0" || bad "expected exit 0 while lock is held, got $RC"
grep -qi "SKIP" <<<"$OUT" && ok "explains the lock skip" || bad "did not explain the lock skip"
landed=$(find "$WORK/backups" -maxdepth 1 -type f | wc -l)
(( landed == 0 )) && ok "no dump lands while another cycle holds the lock" || bad "a dump landed despite the lock being held"
flock -u 8
exec 8>&-

# --- 7. retention only prunes this script's own files -----------------------
hdr "Retention prunes only -hostcron files, never a server-authored archive"
reset_env
rm -f "$WORK/backups"/*
old_hostcron="$WORK/backups/paperclip-20260101-000000-hostcron.sql.gz"
old_server="$WORK/backups/paperclip-20260101-000000.sql.gz"
head -c 2048 /dev/zero | gzip -c > "$old_hostcron"
head -c 2048 /dev/zero | gzip -c > "$old_server"
touch -d '10 days ago' "$old_hostcron" "$old_server" 2>/dev/null || touch -t 202601010000 "$old_hostcron" "$old_server"
FAKE_DUMP_SQL_FILE="$GOOD_DUMP"
run --retention-days 2
(( RC == 0 )) && ok "run with old files present still exits 0" || bad "unexpected exit $RC with old files present"
[[ -f "$old_server" ]] && ok "a server-authored archive is never pruned by this script" || bad "retention deleted a server-authored archive"
[[ ! -f "$old_hostcron" ]] && ok "an old -hostcron archive past retention is pruned" || bad "an old -hostcron archive was not pruned"
grep -q "host_db_backup_retention: pruned=1" <<<"$OUT" && ok "reports exactly one pruned file" || bad "retention count wrong: $OUT"

printf '\n\033[1mTOTAL\033[0m  %d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
