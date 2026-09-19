#!/usr/bin/env bash
# ===========================================================================
# db_backup_stall.sh — detect a WEDGED database backup scheduler (TOG-831).
# ---------------------------------------------------------------------------
# On 2026-08-30T09:37:42Z a scheduled backup started and never settled. It did
# not throw -- `grep -c "database backup failed" server.log` is 0 for the whole
# log -- so the `finally` at server/src/index.ts:722 never ran and
# `databaseBackupInFlight` stayed true for 92 hours. Every subsequent hourly
# tick no-opped at index.ts:671 with one WARN line. 90 backups were lost. An
# unrelated process restart at 2026-09-03T05:17:03Z cured it by accident.
#
# THE REASON THIS SCRIPT EXISTS: /api/health could not see any of it, and then
# erased the evidence. inspectDatabaseBackupHealth() only stats .sql.gz mtimes
# (services/database-backup-health.ts:81-103), so:
#
#   * for the first 26 hours the stall is INVISIBLE -- age is under maxAgeHours;
#   * after 26 hours it warns `database_backup_stale`, but that same warning is
#     produced by a merely-late backup, so it does not identify the cause;
#   * the instant ONE backup lands, status flips back to "ok" with warnings: []
#     and the 90 lost backups leave no trace in the endpoint at all.
#
# The leading indicator is the WARN line itself. It fires within ONE hour, it is
# unambiguous, and nothing surfaces it. This script surfaces it.
#
# Two independent signals, either of which is a stall:
#
#   1. SUPPRESSION -- a "Skipping scheduled database backup" WARN that is newer
#      than the newest "database backup complete". Backups are being actively
#      skipped right now. This is the definitive signal.
#   2. ORPHAN -- a `<prefix>-*.sql` older than --orphan-min-age-minutes whose
#      `.sql.gz` sibling is missing OR TRUNCATED. The JavaScript backup engine
#      writes the plain .sql first and gzips at the end
#      (packages/db/src/backup-lib.ts:962-968), so a stale .sql with no usable
#      .gz is a backup that died mid-write. NOTE this is corroborating, not
#      conclusive on its own: a backup legitimately in progress also has one,
#      which is what the minimum age screens out.
#
#      THE TRUNCATED CASE IS NOT HYPOTHETICAL -- it is the 2026-09-05 shape and
#      the original 2026-09-03 detector MISSED it. Measured on the host: the
#      .sql.gz mtime (06:36:44) PRECEDES the .sql mtime (06:37:02), so the gzip
#      output file is created when the dump OPENS, not when it succeeds. The
#      COPY loop then hung -- the 832 MB .sql ends mid-COPY with no COMMIT and
#      no "PostgreSQL database dump complete" -- and nothing was ever written
#      through the gzip stream, leaving a 20-byte empty frame.
#
#      That ordering is what broke the original rule. "An unpaired .sql is the
#      death certificate" assumed the .gz appears only on success; in fact it
#      appears immediately, so the wedged case has a COMPLETE-LOOKING pair and
#      scored exit 0 on a scheduler that had been dead for 11 hours. Existence
#      is not success: the .gz must be at least --min-backup-bytes to count.
#
#   3. STALENESS -- the newest usable in-server `.sql.gz` in the backup
#      directory is older than --max-backup-age-hours. Host fallback archives
#      (`*-hostcron.sql.gz`) are measured separately and excluded by default so
#      they cannot make a wedged in-server scheduler look healthy. This is the
#      signal of last resort and the only one that survives losing the log. It
#      exists because signals 1 and 2
#      both read sources that can silently go away: on 2026-09-05 the server
#      log stopped being written to at 05:33 (the process was replaced and the
#      new one logs elsewhere), so the suppression scan anchored on a
#      12-hour-old completion, found no skips after it, and reported health.
#      A detector whose log went stale must not be able to return 0.
#
# FAILING CLOSED IS THE WHOLE POINT. The log is multi-gigabyte, so this reads a
# bounded tail window (--window-bytes). If no "database backup complete" anchor
# is found inside that window, the run is INCONCLUSIVE (exit 2) and says so --
# it NEVER reports healthy from a window it could not anchor. A detector that
# goes green because it looked at too little of the log is the exact failure
# mode that let this incident run for 92 hours.
#
# The same rule now covers a log that is merely OLD. An anchor found in a file
# whose newest bytes predate the newest backup by more than --max-backup-age-
# hours is an anchor from a dead log, and a dead log cannot testify to present
# health -- that run is INCONCLUSIVE too, never green.
#
# This script is read-only: it stats the backup directory, reads the tail of the
# log, and optionally GETs /api/health. It never writes a backup, never deletes
# one, and never restarts anything.
#
#   ./db_backup_stall.sh                # human-readable
#   ./db_backup_stall.sh --json         # machine-readable
#
# --staleness-only (TOG-2370): evaluate ONLY signal 3 (newest usable archive
# age) and skip signals 1/2 and the server-log entirely. This exists because
# by TOG-2370 signal 1 (log suppression) is a PERMANENT stall once the
# in-server scheduler wedges -- no code change and no file on disk clears
# databaseBackupInFlight (TOG-1138) -- so a combined verdict can never go
# green again even after host_db_backup.sh (docs/host-db-backup.md) starts
# landing independently-verified archives on the same schedule. Since that
# script writes paperclip-<ts>-hostcron.sql.gz into the SAME directory, it
# already matches this detector's existing `$PREFIX-*.sql.gz` glob with no
# code change: --staleness-only answers "is there a recent, restorable
# backup at all," which is what the owner asked this monitor to alert on,
# regardless of which writer produced it or what the in-server scheduler's
# internal bookkeeping says.
#
# Exit status:
#   0  no stall detected (and the window was anchored)
#   1  STALL detected -- backups are being suppressed or died mid-write
#   2  inconclusive or tool failure -- log unreadable, or window unanchored
#
# --staleness-only exit status:
#   0  a usable archive exists within --max-backup-age-hours
#   1  every archive is stale, truncated, or absent
#   2  the backup directory itself could not be measured
# ===========================================================================
set -uo pipefail

LOG_FILE="${PAPERCLIP_SERVER_LOG:-/paperclip/instances/default/logs/server.log}"
BACKUP_DIR="${PAPERCLIP_DB_BACKUP_DIR:-/paperclip/instances/default/data/backups}"
PREFIX="paperclip"
WINDOW_BYTES=$((256 * 1024 * 1024))
ORPHAN_MIN_AGE_MINUTES=90
JSON=0
CHECK_HEALTH=1
STALENESS_ONLY=0
# The host fallback writes `*-hostcron.sql.gz` into the same directory. Normal
# scheduler detection excludes that producer; --staleness-only deliberately
# includes every producer unless the caller explicitly requests the exclusion.
EXCLUDE_SUFFIX="hostcron"
EXCLUDE_ENABLED=1
EXCLUDE_WAS_EXPLICIT=0
# A gzip stream with no members is 20 bytes; a real dump here is ~160 MB. 1 KiB
# is far above the empty-frame size and far below any plausible real backup, so
# it separates the two without needing to know the database's size.
MIN_BACKUP_BYTES=1024
# Backups are hourly. Two hours is one missed tick plus slack -- it is the
# threshold the TOG-1129 operator finding asked for, and it is well under the
# server's own 26-hour maxAgeHours, which is why /api/health stayed "ok".
MAX_BACKUP_AGE_HOURS=2

# Log markers. These are the exact strings server/src/index.ts logs; if the
# server rewords them this detector must fail closed rather than read silence
# as health, which is what the unanchored-window check below guarantees.
M_COMPLETE="database backup complete"
M_STARTING="database backup starting"
M_SKIP="Skipping scheduled database backup"
M_FAILED="database backup failed"

usage() {
  cat >&2 <<'EOF'
usage: db_backup_stall.sh [--json] [--log FILE] [--backup-dir DIR]
                          [--window-bytes N] [--orphan-min-age-minutes N]
                          [--min-backup-bytes N] [--max-backup-age-hours N]
                          [--prefix NAME] [--exclude-suffix NAME]
                          [--include-all-producers] [--no-health]
                          [--staleness-only]

Detects a wedged database backup scheduler from the server log's own
"Skipping scheduled database backup" WARN -- the leading indicator that
/api/health cannot see and later erases.

  0 no stall   1 STALL detected   2 inconclusive / tool failure

By default, archives ending `-hostcron.sql.gz` are excluded from the
in-server orphan/staleness signals and reported separately. Change the
producer marker with --exclude-suffix, or use --include-all-producers to
restore the legacy all-writers view.

--staleness-only evaluates ONLY whether a usable archive exists within
--max-backup-age-hours (signal 3), ignoring the server log and the orphan
check entirely. It includes every producer by default, so an independent
writer (e.g. host_db_backup.sh, TOG-2370) can satisfy that availability-only
check. Pass --exclude-suffix explicitly to narrow it to the in-server writer.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1 ;;
    --no-health) CHECK_HEALTH=0 ;;
    --staleness-only) STALENESS_ONLY=1 ;;
    --exclude-suffix) shift; [[ $# -gt 0 ]] || { echo "ERROR: --exclude-suffix needs a value" >&2; exit 2; }; EXCLUDE_SUFFIX="$1"; EXCLUDE_ENABLED=1; EXCLUDE_WAS_EXPLICIT=1 ;;
    --include-all-producers) EXCLUDE_ENABLED=0; EXCLUDE_WAS_EXPLICIT=1 ;;
    --log) shift; [[ $# -gt 0 ]] || { echo "ERROR: --log needs a value" >&2; exit 2; }; LOG_FILE="$1" ;;
    --backup-dir) shift; [[ $# -gt 0 ]] || { echo "ERROR: --backup-dir needs a value" >&2; exit 2; }; BACKUP_DIR="$1" ;;
    --prefix) shift; [[ $# -gt 0 ]] || { echo "ERROR: --prefix needs a value" >&2; exit 2; }; PREFIX="$1" ;;
    --window-bytes) shift; [[ $# -gt 0 ]] || { echo "ERROR: --window-bytes needs a value" >&2; exit 2; }; WINDOW_BYTES="$1" ;;
    --orphan-min-age-minutes) shift; [[ $# -gt 0 ]] || { echo "ERROR: --orphan-min-age-minutes needs a value" >&2; exit 2; }; ORPHAN_MIN_AGE_MINUTES="$1" ;;
    --min-backup-bytes) shift; [[ $# -gt 0 ]] || { echo "ERROR: --min-backup-bytes needs a value" >&2; exit 2; }; MIN_BACKUP_BYTES="$1" ;;
    --max-backup-age-hours) shift; [[ $# -gt 0 ]] || { echo "ERROR: --max-backup-age-hours needs a value" >&2; exit 2; }; MAX_BACKUP_AGE_HOURS="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

for n in "$WINDOW_BYTES" "$ORPHAN_MIN_AGE_MINUTES" "$MIN_BACKUP_BYTES" "$MAX_BACKUP_AGE_HOURS"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: numeric options must be positive integers" >&2; exit 2; }
done
[[ "$PREFIX" =~ ^[A-Za-z0-9._-]+$ ]] \
  || { echo "ERROR: prefix contains characters that could escape the glob" >&2; exit 2; }
[[ -z "$EXCLUDE_SUFFIX" || "$EXCLUDE_SUFFIX" =~ ^[A-Za-z0-9._-]+$ ]] \
  || { echo "ERROR: exclude-suffix contains characters that could escape the glob" >&2; exit 2; }
for tool in tail grep stat date; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done

# --staleness-only exists to answer "is there ANY usable archive" once the
# host fallback lands, so it defaults to counting every producer -- unless
# the caller explicitly asked to narrow it with --exclude-suffix (or widen
# it in default mode with --include-all-producers). Default (combined) mode
# always excludes the host producer: that mode's job is judging the
# IN-SERVER scheduler, and a host-side archive answering for it is exactly
# the TOG-2998 defect.
EFFECTIVE_EXCLUDE_ENABLED=$EXCLUDE_ENABLED
if (( STALENESS_ONLY == 1 && EXCLUDE_WAS_EXPLICIT == 0 )); then
  EFFECTIVE_EXCLUDE_ENABLED=0
fi

NOW_EPOCH="$(date -u +%s)"
NOW_ISO="$(date -u -d "@$NOW_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"

# --- JSON emission ---------------------------------------------------------
# Values are emitted through a real escaper so a log line containing a quote or
# a backslash cannot produce malformed JSON that a consumer silently misparses.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

VERDICT="ok"
EXIT_CODE=0
REASONS=()
NOTES=()

add_reason() { REASONS+=("$1"); }
add_note()   { NOTES+=("$1"); }

# --- Signal 1: suppression (the definitive leading indicator) ---------------
LOG_READABLE=0
WINDOW_ANCHORED=0
LAST_COMPLETE_LINE=""
LAST_SKIP_LINE=""
LAST_STARTING_LINE=""
SKIP_COUNT_IN_WINDOW=0
FAILED_COUNT_IN_WINDOW=0
LOG_SIZE_BYTES=0

if (( STALENESS_ONLY == 0 )) && [[ -r "$LOG_FILE" ]]; then
  LOG_READABLE=1
  LOG_SIZE_BYTES="$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)"

  # Bounded tail. Ordering within the window is what matters, so record the
  # position of each marker's LAST occurrence rather than parsing timestamps --
  # the log's bracketed [HH:MM:SS] carries no date and would be ambiguous across
  # midnight, which is precisely the kind of subtle wrongness that turns a
  # detector into a false green.
  WINDOW="$(tail -c "$WINDOW_BYTES" -- "$LOG_FILE" 2>/dev/null)" || WINDOW=""

  if [[ -n "$WINDOW" ]]; then
    complete_pos="$(printf '%s\n' "$WINDOW" | grep -a -n -F -- "$M_COMPLETE" | tail -1 | cut -d: -f1)"
    skip_pos="$(printf '%s\n' "$WINDOW" | grep -a -n -F -- "$M_SKIP" | tail -1 | cut -d: -f1)"
    starting_pos="$(printf '%s\n' "$WINDOW" | grep -a -n -F -- "$M_STARTING" | tail -1 | cut -d: -f1)"

    LAST_COMPLETE_LINE="$(printf '%s\n' "$WINDOW" | grep -a -F -- "$M_COMPLETE" | tail -1)"
    LAST_SKIP_LINE="$(printf '%s\n' "$WINDOW" | grep -a -F -- "$M_SKIP" | tail -1)"
    LAST_STARTING_LINE="$(printf '%s\n' "$WINDOW" | grep -a -F -- "$M_STARTING" | tail -1)"
    SKIP_COUNT_IN_WINDOW="$(printf '%s\n' "$WINDOW" | grep -a -c -F -- "$M_SKIP")"
    FAILED_COUNT_IN_WINDOW="$(printf '%s\n' "$WINDOW" | grep -a -c -F -- "$M_FAILED")"

    # The anchor. Without a completed backup inside the window we cannot order
    # anything against it, so we refuse to draw a conclusion.
    if [[ -n "$complete_pos" ]]; then
      WINDOW_ANCHORED=1

      if [[ -n "$skip_pos" ]] && (( skip_pos > complete_pos )); then
        VERDICT="stall"
        add_reason "SUPPRESSION: a '${M_SKIP}' WARN appears AFTER the most recent '${M_COMPLETE}' in the scanned window. The in-flight guard (server/src/index.ts:671) is wedged and every scheduled tick is a no-op."
      fi

      # A start with neither a completion nor a skip after it is the very first
      # hour of a wedge -- before the next tick has even fired.
      if [[ "$VERDICT" == "ok" && -n "$starting_pos" ]] && (( starting_pos > complete_pos )); then
        VERDICT="stall"
        add_reason "UNSETTLED: the most recent '${M_STARTING}' has no matching '${M_COMPLETE}' after it. A backup is in flight and has not settled; if it never does, the guard wedges permanently."
      fi
    fi
  fi
fi

if (( STALENESS_ONLY == 1 )); then
  add_note "--staleness-only: the server log and the orphan/truncation signal were not evaluated. Only the newest usable archive's age was measured."
elif (( LOG_READABLE == 0 )); then
  add_note "Server log is not readable at ${LOG_FILE} -- the suppression signal could not be evaluated."
elif (( WINDOW_ANCHORED == 0 )); then
  add_note "No '${M_COMPLETE}' anchor found in the last ${WINDOW_BYTES} bytes of ${LOG_FILE}. The window is UNANCHORED: this run cannot distinguish a healthy scheduler from a wedged one. Re-run with a larger --window-bytes."
fi

# --- Signal 2: orphaned or truncated in-progress dump -----------------------
# A .sql whose .gz sibling is MISSING or TRUNCATED. Treating "the sibling file
# exists" as "the backup succeeded" is what made this detector return exit 0 on
# the live 2026-09-05 wedge: the compress step had created a 20-byte .gz and
# then died. The sibling must be big enough to be a real archive.
#
# Skipped entirely in --staleness-only mode: an in-progress dump belonging to
# a DIFFERENT writer (e.g. host_db_backup.sh mid-run) is not this detector's
# concern once it is only answering "is there a recent usable archive."
ORPHANS=()
BACKUP_DIR_READABLE=0
if [[ -d "$BACKUP_DIR" ]]; then
  BACKUP_DIR_READABLE=1
  if (( STALENESS_ONLY == 0 )); then
    orphan_cutoff=$(( NOW_EPOCH - ORPHAN_MIN_AGE_MINUTES * 60 ))
    for f in "$BACKUP_DIR/$PREFIX"-*.sql; do
      [[ -e "$f" ]] || continue
      gz_size=-1
      if [[ -e "$f.gz" ]]; then
        gz_size="$(stat -c %s "$f.gz" 2>/dev/null || echo 0)"
        (( gz_size >= MIN_BACKUP_BYTES )) && continue
      fi
      mtime="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
      (( mtime > orphan_cutoff )) && continue
      age_min=$(( (NOW_EPOCH - mtime) / 60 ))
      size="$(stat -c %s "$f" 2>/dev/null || echo 0)"
      ORPHANS+=("$(basename "$f")|${age_min}|${size}|${gz_size}")
    done
  fi
else
  add_note "Backup directory ${BACKUP_DIR} does not exist -- the orphan and staleness signals could not be evaluated."
fi

if (( ${#ORPHANS[@]} > 0 )); then
  for entry in "${ORPHANS[@]}"; do
    IFS='|' read -r oname oage osize ogz <<<"$entry"
    if (( ogz < 0 )); then
      add_reason "ORPHAN: ${oname} is ${oage} minutes old with no .sql.gz sibling (${osize} bytes). The JavaScript backup engine compresses only after writer.close() (packages/db/src/backup-lib.ts:1019-1025), so this dump died mid-write."
    else
      add_reason "TRUNCATED: ${oname} is ${oage} minutes old (${osize} bytes) and its .sql.gz sibling is only ${ogz} bytes, under the ${MIN_BACKUP_BYTES}-byte floor. The tiny .gz is residue of the failed pg_dump attempt, not output of this dump: the pg_dump branch opens the .gz, the spawn fails, and the catch-block cleanup at backup-lib.ts:565-567 tests existsSync BEFORE the stream has created the file, so the unlink never fires and a finalized 20-byte empty frame is left behind (verification/tog-1130-empty-gzip-residue-repro.mjs, survives ~50-70% of attempts). The .sql beside it is the JavaScript engine's dump, which then died mid-write. This is the 2026-09-05 signature; an empty gzip frame is 20 bytes and gzip -t passes it."
    fi
  done
  [[ "$VERDICT" == "ok" ]] && VERDICT="stall"
fi

# --- Signal 3: no usable backup landed recently -----------------------------
# The signal of last resort, and the only one that does not read the log. It
# catches the case where the log itself went away: on 2026-09-05 the server
# stopped writing to server.log at 05:33, so signal 1 anchored on a stale
# completion, saw no skips after it, and called it health.
NEWEST_GOOD_NAME="none"
NEWEST_GOOD_AGE_MIN=-1
NEWEST_HOST_NAME="none"
NEWEST_HOST_AGE_MIN=-1
if (( BACKUP_DIR_READABLE == 1 )); then
  newest_mtime=0
  newest_host_mtime=0
  for f in "$BACKUP_DIR/$PREFIX"-*.sql.gz; do
    [[ -e "$f" ]] || continue
    sz="$(stat -c %s "$f" 2>/dev/null || echo 0)"
    (( sz >= MIN_BACKUP_BYTES )) || continue   # a truncated archive is not a backup
    mt="$(stat -c %Y "$f" 2>/dev/null || echo 0)"

    is_host=0
    [[ -n "$EXCLUDE_SUFFIX" && "$f" == *-"$EXCLUDE_SUFFIX".sql.gz ]] && is_host=1
    if (( is_host == 1 )); then
      # Tracked for observability regardless of whether it counts toward the
      # verdict, so the fallback's own freshness is never invisible.
      (( mt > newest_host_mtime )) && { newest_host_mtime="$mt"; NEWEST_HOST_NAME="$(basename "$f")"; }
    fi
    if (( is_host == 0 || EFFECTIVE_EXCLUDE_ENABLED == 0 )); then
      (( mt > newest_mtime )) && { newest_mtime="$mt"; NEWEST_GOOD_NAME="$(basename "$f")"; }
    fi
  done

  (( newest_host_mtime > 0 )) && NEWEST_HOST_AGE_MIN=$(( (NOW_EPOCH - newest_host_mtime) / 60 ))

  if (( newest_mtime == 0 )); then
    NEWEST_GOOD_AGE_MIN=-1
    VERDICT="stall"
    if (( EFFECTIVE_EXCLUDE_ENABLED == 1 )); then
      add_reason "NO USABLE BACKUP: ${BACKUP_DIR} contains no in-server ${PREFIX}-*.sql.gz (excluding *-${EXCLUDE_SUFFIX}.sql.gz) of at least ${MIN_BACKUP_BYTES} bytes. Every in-server archive present is truncated or absent."
    else
      add_reason "NO USABLE BACKUP: ${BACKUP_DIR} contains no ${PREFIX}-*.sql.gz of at least ${MIN_BACKUP_BYTES} bytes. Every archive present is truncated or absent."
    fi
  else
    NEWEST_GOOD_AGE_MIN=$(( (NOW_EPOCH - newest_mtime) / 60 ))
    if (( NEWEST_GOOD_AGE_MIN > MAX_BACKUP_AGE_HOURS * 60 )); then
      [[ "$VERDICT" == "ok" ]] && VERDICT="stall"
      add_reason "STALE: the newest usable backup ${NEWEST_GOOD_NAME} is ${NEWEST_GOOD_AGE_MIN} minutes old, over the ${MAX_BACKUP_AGE_HOURS}-hour threshold. Backups are hourly, so this is at least one missed tick regardless of what the log says."
    fi
  fi

  if (( EFFECTIVE_EXCLUDE_ENABLED == 1 && newest_host_mtime > 0 )); then
    add_note "A host-side archive (${NEWEST_HOST_NAME}, ${NEWEST_HOST_AGE_MIN} min old) exists but is excluded from this verdict by producer filter --exclude-suffix ${EXCLUDE_SUFFIX} -- it cannot answer for the in-server scheduler. See newestHostArchive / --include-all-producers."
  fi
fi

# A log whose newest bytes predate the newest good backup is a DEAD log, and an
# anchor found inside it says nothing about present health. Downgrade to
# inconclusive rather than letting a stale anchor produce a green.
# Not evaluated in --staleness-only mode: the log is never read there, so
# LOG_READABLE stays 0 by construction, not because anything failed.
LOG_STALE=0
if (( STALENESS_ONLY == 0 && LOG_READABLE == 1 && WINDOW_ANCHORED == 1 )); then
  log_mtime="$(stat -c %Y "$LOG_FILE" 2>/dev/null || echo 0)"
  log_age_min=$(( (NOW_EPOCH - log_mtime) / 60 ))
  if (( log_age_min > MAX_BACKUP_AGE_HOURS * 60 )); then
    LOG_STALE=1
    add_note "Server log ${LOG_FILE} has not been written to for ${log_age_min} minutes, over the ${MAX_BACKUP_AGE_HOURS}-hour threshold. Its anchor is historical: the suppression signal cannot testify to present health and was NOT used to clear anything. Point --log at the live log."
  fi
fi

# --- Corroborate with the server's own health view -------------------------
# Recorded for contrast, never used to clear a stall: the whole point is that
# this endpoint reads "ok" during the first 26 hours of a wedge and again
# immediately after recovery.
HEALTH_STATUS="not_checked"
HEALTH_AGE_HOURS="null"
HEALTH_LATEST="not_reported"
if (( CHECK_HEALTH == 1 )) && [[ -n "${PAPERCLIP_API_URL:-}" ]] && command -v curl >/dev/null 2>&1; then
  base="${PAPERCLIP_API_URL%/}"; base="${base%/api}"
  # The UNAUTHENTICATED /api/health returns databaseBackup.status but omits
  # latestBackup entirely; only an authenticated call includes it. Send the
  # bearer when we have one so `latest`/`age` are real values rather than a
  # bare "null" that reads like "no backup exists".
  health_auth=()
  [[ -n "${PAPERCLIP_API_KEY:-}" ]] && health_auth=(-H "Authorization: Bearer ${PAPERCLIP_API_KEY}")
  if health_json="$(curl -sS --max-time 20 "${health_auth[@]}" "$base/api/health" 2>/dev/null)"; then
    if command -v python3 >/dev/null 2>&1; then
      eval "$(printf '%s' "$health_json" | python3 -c '
import json,sys
def sh(v):
    return "\x27" + str(v).replace("\x27", "\x27\\\x27\x27") + "\x27"
try:
    d = json.load(sys.stdin).get("databaseBackup") or {}
except Exception:
    print("HEALTH_STATUS=unparseable"); sys.exit(0)
print("HEALTH_STATUS=" + sh(d.get("status") or "unknown"))
lb = d.get("latestBackup") or {}
print("HEALTH_AGE_HOURS=" + sh(lb.get("ageHours") if lb.get("ageHours") is not None else "null"))
print("HEALTH_LATEST=" + sh(lb.get("name") or "null"))
' 2>/dev/null)" || HEALTH_STATUS="unparseable"
    fi
  else
    HEALTH_STATUS="unreachable"
  fi
fi

if [[ "$VERDICT" == "stall" && "$HEALTH_STATUS" == "ok" ]]; then
  add_note "/api/health reports databaseBackup.status=ok while this detector sees a stall. That is the documented blind spot, not a contradiction: the endpoint only stats .sql.gz mtimes and cannot see suppressed ticks."
fi

# --- Verdict ---------------------------------------------------------------
if (( STALENESS_ONLY == 1 )); then
  # Only signal 3 ran. "Inconclusive" here means the backup directory itself
  # could not be measured -- there is no log-anchoring question to fail on.
  if [[ "$VERDICT" == "stall" ]]; then
    EXIT_CODE=1
  elif (( BACKUP_DIR_READABLE == 0 )); then
    VERDICT="inconclusive"
    EXIT_CODE=2
  else
    EXIT_CODE=0
  fi
elif [[ "$VERDICT" == "stall" ]]; then
  EXIT_CODE=1
elif (( LOG_READABLE == 0 || WINDOW_ANCHORED == 0 || LOG_STALE == 1 )); then
  # LOG_STALE belongs here and not with the stall arm on purpose: a dead log is
  # a failure to OBSERVE, not evidence of a wedge. Signals 2 and 3 have already
  # had their say; if they are quiet, "I cannot tell" is the honest verdict.
  VERDICT="inconclusive"
  EXIT_CODE=2
else
  EXIT_CODE=0
fi

if (( JSON == 1 )); then
  printf '{'
  printf '"verdict":"%s",' "$(json_escape "$VERDICT")"
  printf '"stalenessOnly":%s,' "$( ((STALENESS_ONLY==1)) && echo true || echo false )"
  printf '"checkedAt":"%s",' "$(json_escape "$NOW_ISO")"
  printf '"logFile":"%s",' "$(json_escape "$LOG_FILE")"
  printf '"logSizeBytes":%s,' "$LOG_SIZE_BYTES"
  printf '"windowBytes":%s,' "$WINDOW_BYTES"
  printf '"windowAnchored":%s,' "$( ((WINDOW_ANCHORED==1)) && echo true || echo false )"
  printf '"skipCountInWindow":%s,' "${SKIP_COUNT_IN_WINDOW:-0}"
  printf '"failedCountInWindow":%s,' "${FAILED_COUNT_IN_WINDOW:-0}"
  printf '"lastCompleteLine":"%s",' "$(json_escape "$LAST_COMPLETE_LINE")"
  printf '"lastSkipLine":"%s",' "$(json_escape "$LAST_SKIP_LINE")"
  printf '"orphanCount":%s,' "${#ORPHANS[@]}"
  printf '"logStale":%s,' "$( ((LOG_STALE==1)) && echo true || echo false )"
  printf '"newestUsableBackup":"%s",' "$(json_escape "$NEWEST_GOOD_NAME")"
  printf '"newestUsableBackupAgeMinutes":%s,' "$NEWEST_GOOD_AGE_MIN"
  printf '"excludeSuffix":"%s",' "$(json_escape "$EXCLUDE_SUFFIX")"
  printf '"excludeEnabled":%s,' "$( ((EFFECTIVE_EXCLUDE_ENABLED==1)) && echo true || echo false )"
  printf '"newestHostArchive":"%s",' "$(json_escape "$NEWEST_HOST_NAME")"
  printf '"newestHostArchiveAgeMinutes":%s,' "$NEWEST_HOST_AGE_MIN"
  printf '"minBackupBytes":%s,' "$MIN_BACKUP_BYTES"
  printf '"maxBackupAgeHours":%s,' "$MAX_BACKUP_AGE_HOURS"
  printf '"healthStatus":"%s",' "$(json_escape "$HEALTH_STATUS")"
  printf '"healthLatestBackup":"%s",' "$(json_escape "$HEALTH_LATEST")"
  printf '"healthAgeHours":"%s",' "$(json_escape "$HEALTH_AGE_HOURS")"
  printf '"reasons":['
  for i in "${!REASONS[@]}"; do
    (( i > 0 )) && printf ','
    printf '"%s"' "$(json_escape "${REASONS[$i]}")"
  done
  printf '],"notes":['
  for i in "${!NOTES[@]}"; do
    (( i > 0 )) && printf ','
    printf '"%s"' "$(json_escape "${NOTES[$i]}")"
  done
  printf '],"exitCode":%s}\n' "$EXIT_CODE"
else
  case "$VERDICT" in
    stall)        printf 'DB BACKUP STALL DETECTED\n' ;;
    inconclusive) printf 'INCONCLUSIVE -- this run cannot confirm backup health\n' ;;
    *)            printf 'No backup stall detected\n' ;;
  esac
  printf '  checked at         %s\n' "$NOW_ISO"
  if (( STALENESS_ONLY == 1 )); then
    printf '  mode               staleness-only (log and orphan signals not evaluated)\n'
  else
    printf '  log                %s (%s bytes, window %s)\n' "$LOG_FILE" "$LOG_SIZE_BYTES" "$WINDOW_BYTES"
    printf '  window anchored    %s\n' "$( ((WINDOW_ANCHORED==1)) && echo yes || echo 'NO -- cannot conclude health' )"
    printf '  log freshness      %s\n' "$( ((LOG_STALE==1)) && echo 'STALE -- anchor is historical' || echo current )"
    printf '  skips in window    %s\n' "${SKIP_COUNT_IN_WINDOW:-0}"
    printf '  orphaned/truncated %s\n' "${#ORPHANS[@]}"
  fi
  printf '  newest usable .gz  %s (%s min old, floor %s bytes)\n' \
    "$NEWEST_GOOD_NAME" "$NEWEST_GOOD_AGE_MIN" "$MIN_BACKUP_BYTES"
  if [[ "$NEWEST_HOST_NAME" != "none" ]]; then
    printf '  newest host .gz    %s (%s min old, suffix -%s, %s)\n' \
      "$NEWEST_HOST_NAME" "$NEWEST_HOST_AGE_MIN" "$EXCLUDE_SUFFIX" \
      "$( ((EFFECTIVE_EXCLUDE_ENABLED==1)) && echo 'excluded from verdict' || echo 'counted toward verdict' )"
  fi
  printf '  /api/health says   %s (latest %s, age %sh)\n' "$HEALTH_STATUS" "$HEALTH_LATEST" "$HEALTH_AGE_HOURS"
  if [[ -n "$LAST_COMPLETE_LINE" ]]; then
    printf '  last completion    %s\n' "${LAST_COMPLETE_LINE:0:150}"
  fi
  if (( ${#REASONS[@]} > 0 )); then
    printf '\nFindings:\n'
    for r in "${REASONS[@]}"; do printf '  - %s\n' "$r"; done
  fi
  if (( ${#NOTES[@]} > 0 )); then
    printf '\nNotes:\n'
    for n in "${NOTES[@]}"; do printf '  - %s\n' "$n"; done
  fi
  if [[ "$VERDICT" == "stall" && "$STALENESS_ONLY" == 0 ]]; then
    printf '\nRemediation: the in-flight guard only clears on process restart until the\n'
    printf 'watchdog in patches/TOG-831-db-backup-watchdog.patch is deployed. Restarting\n'
    printf 'the Paperclip server clears databaseBackupInFlight and the next tick backs up.\n'
  elif [[ "$VERDICT" == "stall" ]]; then
    printf '\nRemediation: no usable archive has landed within --max-backup-age-hours.\n'
    printf 'Check both writers: the in-server scheduler (docs/runbooks/database-backup-stall.md)\n'
    printf 'and the host-side fallback (docs/host-db-backup.md), e.g.\n'
    printf '  systemctl --user status paperclip-host-db-backup.timer\n'
  fi
fi

exit "$EXIT_CODE"
