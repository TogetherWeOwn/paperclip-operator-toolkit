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
#   2. ORPHAN -- a `<prefix>-*.sql` with no `.sql.gz` sibling, older than
#      --orphan-min-age-minutes. The JavaScript backup engine writes the plain
#      .sql first and gzips at the end (packages/db/src/backup-lib.ts:962-968),
#      so a stale unpaired .sql is a backup that died mid-write. NOTE this is
#      corroborating, not conclusive on its own: a backup legitimately in
#      progress also has one, which is what the minimum age screens out.
#
# FAILING CLOSED IS THE WHOLE POINT. The log is multi-gigabyte, so this reads a
# bounded tail window (--window-bytes). If no "database backup complete" anchor
# is found inside that window, the run is INCONCLUSIVE (exit 2) and says so --
# it NEVER reports healthy from a window it could not anchor. A detector that
# goes green because it looked at too little of the log is the exact failure
# mode that let this incident run for 92 hours.
#
# This script is read-only: it stats the backup directory, reads the tail of the
# log, and optionally GETs /api/health. It never writes a backup, never deletes
# one, and never restarts anything.
#
#   ./db_backup_stall.sh                # human-readable
#   ./db_backup_stall.sh --json         # machine-readable
#
# Exit status:
#   0  no stall detected (and the window was anchored)
#   1  STALL detected -- backups are being suppressed or died mid-write
#   2  inconclusive or tool failure -- log unreadable, or window unanchored
# ===========================================================================
set -uo pipefail

LOG_FILE="${PAPERCLIP_SERVER_LOG:-/paperclip/instances/default/logs/server.log}"
BACKUP_DIR="${PAPERCLIP_DB_BACKUP_DIR:-/paperclip/instances/default/data/backups}"
PREFIX="paperclip"
WINDOW_BYTES=$((256 * 1024 * 1024))
ORPHAN_MIN_AGE_MINUTES=90
JSON=0
CHECK_HEALTH=1

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
                          [--prefix NAME] [--no-health]

Detects a wedged database backup scheduler from the server log's own
"Skipping scheduled database backup" WARN -- the leading indicator that
/api/health cannot see and later erases.

  0 no stall   1 STALL detected   2 inconclusive / tool failure
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1 ;;
    --no-health) CHECK_HEALTH=0 ;;
    --log) shift; [[ $# -gt 0 ]] || { echo "ERROR: --log needs a value" >&2; exit 2; }; LOG_FILE="$1" ;;
    --backup-dir) shift; [[ $# -gt 0 ]] || { echo "ERROR: --backup-dir needs a value" >&2; exit 2; }; BACKUP_DIR="$1" ;;
    --prefix) shift; [[ $# -gt 0 ]] || { echo "ERROR: --prefix needs a value" >&2; exit 2; }; PREFIX="$1" ;;
    --window-bytes) shift; [[ $# -gt 0 ]] || { echo "ERROR: --window-bytes needs a value" >&2; exit 2; }; WINDOW_BYTES="$1" ;;
    --orphan-min-age-minutes) shift; [[ $# -gt 0 ]] || { echo "ERROR: --orphan-min-age-minutes needs a value" >&2; exit 2; }; ORPHAN_MIN_AGE_MINUTES="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

for n in "$WINDOW_BYTES" "$ORPHAN_MIN_AGE_MINUTES"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: numeric options must be positive integers" >&2; exit 2; }
done
[[ "$PREFIX" =~ ^[A-Za-z0-9._-]+$ ]] \
  || { echo "ERROR: prefix contains characters that could escape the glob" >&2; exit 2; }
for tool in tail grep stat date; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done

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

if [[ -r "$LOG_FILE" ]]; then
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

if (( LOG_READABLE == 0 )); then
  add_note "Server log is not readable at ${LOG_FILE} -- the suppression signal could not be evaluated."
elif (( WINDOW_ANCHORED == 0 )); then
  add_note "No '${M_COMPLETE}' anchor found in the last ${WINDOW_BYTES} bytes of ${LOG_FILE}. The window is UNANCHORED: this run cannot distinguish a healthy scheduler from a wedged one. Re-run with a larger --window-bytes."
fi

# --- Signal 2: orphaned in-progress dump -----------------------------------
ORPHANS=()
if [[ -d "$BACKUP_DIR" ]]; then
  orphan_cutoff=$(( NOW_EPOCH - ORPHAN_MIN_AGE_MINUTES * 60 ))
  for f in "$BACKUP_DIR/$PREFIX"-*.sql; do
    [[ -e "$f" ]] || continue
    [[ -e "$f.gz" ]] && continue
    mtime="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
    (( mtime > orphan_cutoff )) && continue
    age_min=$(( (NOW_EPOCH - mtime) / 60 ))
    size="$(stat -c %s "$f" 2>/dev/null || echo 0)"
    ORPHANS+=("$(basename "$f")|${age_min}|${size}")
  done
else
  add_note "Backup directory ${BACKUP_DIR} does not exist -- the orphan signal could not be evaluated."
fi

if (( ${#ORPHANS[@]} > 0 )); then
  for entry in "${ORPHANS[@]}"; do
    IFS='|' read -r oname oage osize <<<"$entry"
    add_reason "ORPHAN: ${oname} is ${oage} minutes old with no .sql.gz sibling (${osize} bytes). The JavaScript backup engine gzips only on success (packages/db/src/backup-lib.ts:962-968), so this dump died mid-write."
  done
  [[ "$VERDICT" == "ok" ]] && VERDICT="stall"
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
if [[ "$VERDICT" == "stall" ]]; then
  EXIT_CODE=1
elif (( LOG_READABLE == 0 || WINDOW_ANCHORED == 0 )); then
  VERDICT="inconclusive"
  EXIT_CODE=2
else
  EXIT_CODE=0
fi

if (( JSON == 1 )); then
  printf '{'
  printf '"verdict":"%s",' "$(json_escape "$VERDICT")"
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
  printf '  log                %s (%s bytes, window %s)\n' "$LOG_FILE" "$LOG_SIZE_BYTES" "$WINDOW_BYTES"
  printf '  window anchored    %s\n' "$( ((WINDOW_ANCHORED==1)) && echo yes || echo 'NO -- cannot conclude health' )"
  printf '  skips in window    %s\n' "${SKIP_COUNT_IN_WINDOW:-0}"
  printf '  orphaned dumps     %s\n' "${#ORPHANS[@]}"
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
  if [[ "$VERDICT" == "stall" ]]; then
    printf '\nRemediation: the in-flight guard only clears on process restart until the\n'
    printf 'watchdog in patches/TOG-831-db-backup-watchdog.patch is deployed. Restarting\n'
    printf 'the Paperclip server clears databaseBackupInFlight and the next tick backs up.\n'
  fi
fi

exit "$EXIT_CODE"
