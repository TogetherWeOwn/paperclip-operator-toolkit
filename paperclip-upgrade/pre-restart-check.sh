#!/usr/bin/env bash
# ===========================================================================
# paperclip-upgrade/pre-restart-check.sh — pre-restart gates for the Paperclip
# 1001 drained restart. Called by drain.sh restart AND usable
# standalone by the operator before any restart.
#
# Gates (every gate prints its evidence; any failure exits 1):
#   1. drained marker present (refuses a restart outside a proven drain)
#   2. the drain's own backup verifies: paperclip.dump present and non-empty,
#      listed in SHA256SUMS, checksum verifies, dump completed within
#      --max-backup-age-mins (a stale backup is not restore evidence)
#   3. required migrations visible in the drizzle ledger (coarse presence
#      smoke check only; the authoritative sha256-keyed gate is
#      migration_gate.py, run by drain.sh verify against the target image's
#      own migration files)
#   4. orphan-lease / stuck-recovery report (NON-DESTRUCTIVE, via
#      orphans.sql): reports and refuses unless the total is exactly
#      --ack-orphans. Never cancels or deletes (cleanup under a pending
#      restart is how a stranded card loses its evidence)
#   5. disk headroom on the data dir (a restart that fills the disk mid-boot
#      is the outage this gate prevents)
#   6. real-root path report under the data dir (informational under rootful
#      Docker; blocking only with --block-on-root)
#
# Read-only except for nothing: this script writes nothing anywhere. It never
# cancels runs, deletes leases, or touches backups.
#
# Exit status: 0 all gates pass | 1 a gate failed | 2 refused (bad args/env)
# ===========================================================================
set -uo pipefail

ME="${BASH_SOURCE[0]##*/}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR=""; BACKUP_DIR=""; MAX_AGE_MINS=120; ACK_ORPHANS=0; BLOCK_ON_ROOT=0
DATA_DIR="${PAPERCLIP_DATA:-${PAPERCLIP_HOME:-$HOME/.paperclip}/data}"
DB_CONTAINER="${PAPERCLIP_UPGRADE_DB_CONTAINER:-paperclip-db}"
DOCKER="${DOCKER:-docker}"
REQUIRE=()

usage() {
  cat <<'USAGE'
usage: pre-restart-check.sh --state-dir DIR --backup-dir DIR [options]

  --state-dir DIR          drain.sh state dir (must contain drained_at)
  --backup-dir DIR         drain.sh backup dir (paperclip.dump + SHA256SUMS)
  --max-backup-age-mins N  dump must be this fresh (default 120)
  --ack-orphans N          accept exactly N orphan rows (default 0)
  --require TAG            migration prefix required present (repeatable;
                           default 0280 0281 0282 0283)
  --block-on-root          real-root paths under the data dir fail the check
USAGE
}

while (($#)); do
  case "$1" in
    --state-dir) STATE_DIR="${2:?}"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:?}"; shift 2 ;;
    --max-backup-age-mins) MAX_AGE_MINS="${2:?}"; shift 2 ;;
    --ack-orphans) ACK_ORPHANS="${2:?}"; shift 2 ;;
    --require) REQUIRE+=("${2:?}"); shift 2 ;;
    --block-on-root) BLOCK_ON_ROOT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'REFUSED: %s: unknown flag: %s\n' "$ME" "$1" >&2; exit 2 ;;
  esac
done
((${#REQUIRE[@]})) || REQUIRE=(0280 0281 0282 0283)

[[ -n "$STATE_DIR" ]] || { printf 'REFUSED: %s: --state-dir is required\n' "$ME" >&2; exit 2; }
[[ -n "$BACKUP_DIR" ]] || { printf 'REFUSED: %s: --backup-dir is required\n' "$ME" >&2; exit 2; }
[[ "$MAX_AGE_MINS" =~ ^[0-9]+$ && "$MAX_AGE_MINS" -ge 1 ]] || { printf 'REFUSED: %s: --max-backup-age-mins must be a positive integer\n' "$ME" >&2; exit 2; }
[[ "$ACK_ORPHANS" =~ ^[0-9]+$ ]] || { printf 'REFUSED: %s: --ack-orphans must be a non-negative integer\n' "$ME" >&2; exit 2; }
for t in "${REQUIRE[@]}"; do [[ "$t" =~ ^[0-9]{4}$ ]] || { printf 'REFUSED: %s: --require must be a 4-digit migration prefix: %s\n' "$ME" "$t" >&2; exit 2; }; done
[[ -f "$HERE/orphans.sql" && ! -L "$HERE/orphans.sql" ]] || { printf 'REFUSED: %s: orphans.sql missing beside %s\n' "$ME" "$0" >&2; exit 2; }
command -v "$DOCKER" >/dev/null || { printf 'REFUSED: %s: docker runtime is missing\n' "$ME" >&2; exit 2; }

rc=0
gate_ok()   { printf 'ok: %s\n' "$1"; }
gate_fail() { printf 'FAIL: %s\n' "$1"; rc=1; }

# Read-only database access: SQL on stdin, PGOPTIONS forces a read-only
# transaction. Container credentials stay inside the container (POSTGRES_*
# env); nothing secret is printed (counts and hashes only).
dbq() {
  "$DOCKER" exec -i -e "PGOPTIONS=-c default_transaction_read_only=on" "$DB_CONTAINER" \
    sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -At -v ON_ERROR_STOP=1 -f -'
}

# --- 1. drained marker -------------------------------------------------------
if [[ -f "$STATE_DIR/drained_at" ]]; then
  gate_ok "drained at $(cat "$STATE_DIR/drained_at") (state: $STATE_DIR)"
else
  gate_fail "no drained_at in $STATE_DIR — restart outside a proven drain is refused"
fi

# --- 2. the drain's own backup verifies ---------------------------------------
dump="$BACKUP_DIR/paperclip.dump"
if [[ -f "$dump" && ! -L "$dump" && -s "$dump" ]]; then
  age_m=$(( ($(date +%s) - $(stat -c %Y -- "$dump")) / 60 ))
  if (( age_m > MAX_AGE_MINS )); then
    gate_fail "backup $dump is ${age_m}m old (limit ${MAX_AGE_MINS}m)"
  else
    gate_ok "backup $dump ($(stat -c %s -- "$dump") bytes, ${age_m}m old, limit ${MAX_AGE_MINS}m)"
  fi
  if [[ -f "$BACKUP_DIR/SHA256SUMS" ]] && grep -q '^paperclip\.dump' "$BACKUP_DIR/SHA256SUMS"; then
    if (cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS >/dev/null 2>&1); then
      gate_ok "backup checksum verifies (SHA256SUMS covers paperclip.dump)"
    else
      gate_fail "backup checksum DOES NOT verify: $BACKUP_DIR/SHA256SUMS"
    fi
  else
    gate_fail "backup has no SHA256SUMS covering paperclip.dump (unchecksummed backups are not restore evidence)"
  fi
else
  gate_fail "no non-empty $dump (drain.sh backup writes paperclip.dump + SHA256SUMS there)"
fi

# --- 3. required migrations present (coarse smoke check) ----------------------
if mig_rows="$(dbq <<<"SELECT id || ' ' || hash FROM drizzle.__drizzle_migrations;" 2>/dev/null)"; then
  for m in "${REQUIRE[@]}"; do
    if grep -q "$m" <<<"$mig_rows"; then
      gate_ok "migration present: $m"
    else
      gate_fail "required migration $m missing from drizzle.__drizzle_migrations"
    fi
  done
else
  gate_fail "cannot read drizzle.__drizzle_migrations (database unreachable?)"
fi

# --- 4. orphan-lease / stuck-recovery report (NON-DESTRUCTIVE) ----------------
# This gate only REPORTS and refuses. It never cancels a run, deletes a lease,
# or resolves a recovery action: cleanup under a pending restart is exactly how
# a stranded card loses its evidence. Abort and let the operator reconcile, or
# re-run with --ack-orphans EXACTLY the reported total.
if orphans="$(dbq < "$HERE/orphans.sql" 2>/dev/null)" && [[ -n "$orphans" ]]; then
  printf '%s\n' "$orphans"
  total="$(awk -F'|' '{ s += $2 } END { print s + 0 }' <<<"$orphans")"
  if [[ "$total" =~ ^[0-9]+$ ]] && (( total == ACK_ORPHANS )); then
    gate_ok "orphan rows $total (ack $ACK_ORPHANS)"
  else
    gate_fail "orphan/stuck rows present: total ${total:-unreadable} (ack $ACK_ORPHANS) — reported, NOT cleaned up; reconcile by hand, then re-run"
  fi
else
  gate_fail "orphans.sql unreadable (database unreachable?)"
fi

# --- 5. disk headroom ----------------------------------------------------------
if df_out="$(df -B1 "$DATA_DIR" 2>/dev/null | tail -1)"; then
  avail="$(awk '{print $4}' <<<"$df_out")"
  printf 'info: data-dir available bytes: %s\n' "$avail"
  if [[ "$avail" =~ ^[0-9]+$ ]] && (( avail < 5 * 1024 * 1024 * 1024 )); then
    gate_fail "less than 5GiB available on the data dir"
  else
    gate_ok "data-dir headroom sufficient"
  fi
else
  gate_fail "cannot stat data dir: $DATA_DIR"
fi

# --- 6. real-root paths (informational under rootful Docker) ------------------
# History: the image entrypoint runs `chown -R node:node /paperclip` and exits
# fatally on the first path it cannot chown; host uid 0 was unmapped inside a
# rootless container, so real-root files crash-looped the service (2026-09-03:
# 65 min outage; 2026-09-19: 3 loops). Under rootful Docker the boot chown can
# re-own real-root paths and they are no longer fatal; post-restart-reharden.sh
# deliberately creates some (the agent immutability set). The count is
# therefore reported, and only blocks with --block-on-root.
if n="$(sudo -n find "$DATA_DIR" -xdev \( -user 0 -o -group 0 \) 2>/dev/null | wc -l)"; then
  if [[ "$n" != "0" ]]; then
    printf 'note: %s real-root-owned path(s) under %s (expected: reharden set)\n' "$n" "$DATA_DIR"
    [[ "$BLOCK_ON_ROOT" == "1" ]] && gate_fail "--block-on-root: real-root paths block this restart" || gate_ok "real-root paths reported (non-blocking under rootful Docker)"
  else
    gate_ok "no real-root paths under $DATA_DIR"
  fi
else
  printf 'info: cannot scan real-root paths (no passwordless sudo); skipped\n'
fi

exit "$rc"
