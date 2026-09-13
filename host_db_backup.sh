#!/usr/bin/env bash
# ===========================================================================
# host_db_backup.sh — host-side database backup that does NOT depend on the
# in-server scheduler (TOG-2370).
# ---------------------------------------------------------------------------
# TOG-831/TOG-1129/TOG-1138/TOG-2279/TOG-2370: the in-server hourly backup
# scheduler wedges on a hung COPY loop and its in-flight guard
# (databaseBackupInFlight) is process memory that only a restart clears — and
# as of TOG-2370, even a restart no longer reliably fixes it (the very first
# tick after a 19:57 restart wedged again at 20:58). This script removes the
# server's own health from the RPO equation entirely: it runs `pg_dump`
# directly against the `paperclip-db` container from the host, independent of
# whatever state the app container's in-process flag is in.
#
# This is intentionally the SAME approach the owner's own manual out-of-band
# backup used (podman exec pg_dump | gzip), just made durable and scheduled.
#
# NAMING. Output uses the SAME "paperclip-" prefix db_backup_stall.sh already
# globs for staleness/no-usable-backup, with a "-hostcron" tag inserted so a
# human or script can still tell which process produced a given archive:
#
#   paperclip-<YYYYMMDD>-<HHMMSS>-hostcron.sql.gz
#
# This is deliberate: signal 3 (staleness) and signal "no usable backup" in
# db_backup_stall.sh should legitimately clear once THIS timer is landing
# archives — that is the whole point of a fallback. It does NOT mask signal 1
# (log suppression), which is the one that actually identifies the in-server
# scheduler as wedged; that signal reads the server's own log lines and has
# nothing to do with what is on disk. Do not use this script's success to
# conclude the in-server scheduler recovered — check signal 1 for that.
#
# OVERLAP. The owner's caution: "the in-server scheduler and a host timer can
# both be dumping at once... take a lock so a slow dump under load cannot
# overlap the next tick." This script CANNOT flock against the app
# container's in-process scheduler directly -- the host and the app container
# do not share a filesystem namespace an external flock could pin them both
# to (the exact TOG-1150 blind spot: host paths are invisible from inside the
# app container, and the reverse is equally true). What it DOES do:
#
#   1. flock its OWN lock file so two ticks of ITSELF never overlap, even if
#      a prior run is still draining a large dump when the timer fires again.
#   2. Query pg_stat_activity for another backend already running a COPY (a
#      dump in progress, whoever started it) and skip this cycle rather than
#      pile a second concurrent dump on top of one already running. This is a
#      courtesy check, not a lock -- there is an unavoidable race between the
#      check and this script's own COPY starting -- but it is the best
#      available signal from outside the process that holds the real state.
#   3. The timer is scheduled off the top of the hour (see the .timer unit),
#      so it does not compete with the in-server scheduler's own hourly tick
#      by construction, not just by luck.
#
# VERIFICATION. Mirrors the owner's own manual verification, not just "gzip
# exited 0": integrity (`gzip -t`), a real completion trailer, and a nonzero
# CREATE TABLE count. An empty or truncated dump is never left where a
# consumer would mistake it for a good one -- it is written to a `.partial`
# name and only renamed into place after every check passes.
#
# RETENTION. Prunes only the files THIS script created (the "-hostcron" tag),
# never a server-authored archive, at --retention-days (default matches
# PAPERCLIP_DB_BACKUP_RETENTION_DAYS=2 in production).
#
# This is read-write only within the backup directory: it creates and prunes
# archives there. It does not touch the database beyond a read-only dump and
# a read-only pg_stat_activity query, and it never restarts anything.
#
#   ./host_db_backup.sh                 # run one cycle
#   ./host_db_backup.sh --dry-run       # log what would happen, write nothing
#
# Exit status:
#   0  backup landed (or a live concurrent dump caused a deliberate skip)
#   1  backup attempted and failed verification
#   2  refused -- missing tool, bad config, or precondition not met
# ===========================================================================
set -uo pipefail

ME="${BASH_SOURCE[0]##*/}"

CONTAINER="${PAPERCLIP_DB_CTR:-paperclip-db}"
BACKUP_DIR="${PAPERCLIP_DB_BACKUP_DIR:-/paperclip/instances/default/data/backups}"
RETENTION_DAYS="${PAPERCLIP_DB_BACKUP_RETENTION_DAYS:-2}"
LOCK_DIR="${HOST_DB_BACKUP_LOCK_DIR:-/tmp}"
LOCK_FILE="$LOCK_DIR/host_db_backup.lock"
TAG="hostcron"
DRY_RUN=0

usage() {
  cat >&2 <<EOF
usage: $ME [--dry-run] [--backup-dir DIR] [--container NAME] [--retention-days N]

Runs pg_dump against \$PAPERCLIP_DB_CTR (default paperclip-db) from the host,
independent of the in-server backup scheduler. See the header comment for the
overlap-avoidance and verification contract.

  0 backup landed (or a courtesy skip)   1 verification failed   2 refused
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --backup-dir) shift; [[ $# -gt 0 ]] || { echo "ERROR: --backup-dir needs a value" >&2; exit 2; }; BACKUP_DIR="$1" ;;
    --container) shift; [[ $# -gt 0 ]] || { echo "ERROR: --container needs a value" >&2; exit 2; }; CONTAINER="$1" ;;
    --retention-days) shift; [[ $# -gt 0 ]] || { echo "ERROR: --retention-days needs a value" >&2; exit 2; }; RETENTION_DAYS="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

[[ "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]] \
  || { echo "ERROR: --retention-days must be a positive integer" >&2; exit 2; }
[[ "$CONTAINER" =~ ^[A-Za-z0-9._-]+$ ]] \
  || { echo "ERROR: container name contains characters that could escape podman's argv" >&2; exit 2; }
for tool in podman gzip flock date find stat; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done
[[ -d "$BACKUP_DIR" ]] || { echo "ERROR: backup directory does not exist: $BACKUP_DIR" >&2; exit 2; }
[[ -w "$BACKUP_DIR" ]] || { echo "ERROR: backup directory is not writable: $BACKUP_DIR" >&2; exit 2; }

exec 9>"$LOCK_FILE" || { echo "ERROR: cannot open lock file: $LOCK_FILE" >&2; exit 2; }
if ! flock -n 9; then
  echo "SKIP: another $ME cycle already holds the lock; not overlapping it" >&2
  exit 0
fi

podman container exists "$CONTAINER" \
  || { echo "ERROR: container is absent: $CONTAINER" >&2; exit 2; }

# Courtesy check, not a lock (see header): if a dump-shaped query is already
# running against this database, another process (the in-server scheduler,
# or a previous cycle of this same script that outlived its own flock window
# via a stale lock file) is already doing the work this cycle would duplicate.
# Skip rather than add a second concurrent COPY.
active_dumps="$(podman exec "$CONTAINER" psql -X -A -t -U "$(podman exec "$CONTAINER" sh -c 'echo "$POSTGRES_USER"')" \
  -d "$(podman exec "$CONTAINER" sh -c 'echo "$POSTGRES_DB"')" \
  -c "SELECT count(*) FROM pg_stat_activity WHERE query LIKE 'COPY %TO stdout%' AND pid <> pg_backend_pid();" 2>/dev/null)"
if [[ "$active_dumps" =~ ^[0-9]+$ ]] && (( active_dumps > 0 )); then
  echo "SKIP: $active_dumps other COPY-to-stdout backend(s) already running against $CONTAINER; not stacking a second dump" >&2
  exit 0
fi

PG_USER="$(podman exec "$CONTAINER" sh -c 'echo "$POSTGRES_USER"')" \
  || { echo "ERROR: could not read POSTGRES_USER from $CONTAINER" >&2; exit 2; }
PG_DB="$(podman exec "$CONTAINER" sh -c 'echo "$POSTGRES_DB"')" \
  || { echo "ERROR: could not read POSTGRES_DB from $CONTAINER" >&2; exit 2; }
[[ -n "$PG_USER" && -n "$PG_DB" ]] \
  || { echo "ERROR: $CONTAINER did not report POSTGRES_USER/POSTGRES_DB" >&2; exit 2; }

TS="$(date -u +%Y%m%d-%H%M%S)"
FINAL="$BACKUP_DIR/paperclip-${TS}-${TAG}.sql.gz"
PARTIAL="$FINAL.partial"

if (( DRY_RUN == 1 )); then
  echo "DRY-RUN: would dump $PG_DB from $CONTAINER as $PG_USER to $FINAL"
  exit 0
fi

rm -f -- "$PARTIAL"
if ! podman exec "$CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" --no-owner --no-privileges \
    | gzip -c > "$PARTIAL"; then
  rm -f -- "$PARTIAL"
  echo "ERROR: pg_dump | gzip pipeline failed" >&2
  exit 1
fi

# Verify before the archive is visible under its real name -- the exact
# failure mode this exists to avoid is a truncated dump masquerading as a
# good one (TOG-1129/1130's 20-byte empty-gzip residue).
size="$(stat -c %s "$PARTIAL" 2>/dev/null || echo 0)"
if (( size < 1024 )); then
  rm -f -- "$PARTIAL"
  echo "ERROR: dump is only $size bytes, under the 1024-byte floor" >&2
  exit 1
fi
if ! gzip -t -- "$PARTIAL"; then
  rm -f -- "$PARTIAL"
  echo "ERROR: gzip integrity check failed on $PARTIAL" >&2
  exit 1
fi
trailer_count="$(gzip -cd -- "$PARTIAL" | grep -a -c -F -- '-- PostgreSQL database dump complete')"
if [[ "$trailer_count" != 1 ]]; then
  rm -f -- "$PARTIAL"
  echo "ERROR: dump does not end with exactly one completion trailer (found $trailer_count)" >&2
  exit 1
fi
create_count="$(gzip -cd -- "$PARTIAL" | grep -a -c -E '^CREATE TABLE ')"
if (( create_count < 1 )); then
  rm -f -- "$PARTIAL"
  echo "ERROR: dump contains no CREATE TABLE statements" >&2
  exit 1
fi

mv -- "$PARTIAL" "$FINAL"
echo "host_db_backup=PASS file=$(basename "$FINAL") size_bytes=$size tables=$create_count"

# Retention: only ever prune archives THIS script wrote, never a
# server-authored one.
cutoff_days="$RETENTION_DAYS"
pruned=0
while IFS= read -r -d '' old; do
  rm -f -- "$old" && pruned=$((pruned + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "paperclip-*-${TAG}.sql.gz" -mtime "+${cutoff_days}" -print0 2>/dev/null)
echo "host_db_backup_retention: pruned=$pruned retention_days=$RETENTION_DAYS"

exit 0
