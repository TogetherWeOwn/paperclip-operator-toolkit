#!/usr/bin/env bash
# ===========================================================================
# paperclip-upgrade/resolve-drain-stranded.sh — restore cards stranded in
# `blocked` by a recovery action whose run is gone.
#
# PORT NOTES (from the live host resolve-drain-stranded.sh):
#   - The zero-loss drain never cancels runs, so cancellation-stranding
#     cannot happen through it. This script is the safety net for cards left
#     blocked by recovery actions from OTHER causes (interrupted prior run,
#     operator restart outside the drain): it lists candidates by default and
#     restores only with --apply --live.
#   - Discovery is a read-only DB query; mutation is the recovery-actions
#     resolve API (never direct UPDATE of issue status).
#   - Only cards STILL blocked are touched; a card that moved on is skipped.
#   - Every restore is logged with the API code; non-200 responses abort the
#     run rather than continuing half-applied.
#
# Usage: resolve-drain-stranded.sh --since 'YYYY-MM-DD HH:MM' [--apply] [--live]
#
# Exit status: 0 | 1 a restore failed | 2 refused
# ===========================================================================
set -uo pipefail
umask 077

ME="${BASH_SOURCE[0]##*/}"
API_BASE="${PAPERCLIP_UPGRADE_API_BASE:-http://127.0.0.1:3100}"
API_AUTH_FILE="${PAPERCLIP_UPGRADE_API_AUTH_FILE:-$HOME/.config/paperclip-upgrade/board.curl}"
DB_CONTAINER="${PAPERCLIP_UPGRADE_DB_CONTAINER:-paperclip-db}"
DOCKER="${DOCKER:-docker}"
SINCE=""; APPLY=0; LIVE=0; COMPANY=""
UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

while (($#)); do
  case "$1" in
    --since) SINCE="${2:?}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --live) LIVE=1; shift ;;
    --company) COMPANY="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,/^# ===/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'REFUSED: %s: unknown flag: %s\n' "$ME" "$1" >&2; exit 2 ;;
  esac
done

[[ -n "$SINCE" ]] || { printf 'REFUSED: %s: --since is required\n' "$ME" >&2; exit 2; }
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}([[:space:]]+[0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$ ]] \
  || { printf 'REFUSED: %s: --since must be YYYY-MM-DD [HH:MM[:SS]]\n' "$ME" >&2; exit 2; }
command -v "$DOCKER" >/dev/null || { printf 'REFUSED: %s: docker runtime is missing\n' "$ME" >&2; exit 2; }
if [[ "$APPLY" == "1" && "$LIVE" != "1" ]]; then
  printf 'REFUSED: %s: --apply mutates live cards; pass --live (operator only)\n' "$ME" >&2; exit 2
fi

# company + since are interpolated as psql variables, not shell-quoted SQL:
# the date regex above guarantees SINCE is a plain date literal, and --company
# must be a UUID, so neither can break out of the :'var' literal form.
[[ -z "$COMPANY" ]] || [[ "$COMPANY" =~ ^$UUID_RE$ ]] \
  || { printf 'REFUSED: %s: --company must be a UUID\n' "$ME" >&2; exit 2; }

query() { # extra SQL text appended when --company is given (UUID-validated above)
  cat <<SQL
-- q:stranded
SELECT r.id || ' ' || i.id || ' ' || i.identifier
  FROM issue_recovery_actions r JOIN issues i ON i.id = r.source_issue_id
 WHERE r.created_at >= :'since'::timestamptz
   AND r.status = 'active'
   AND r.kind = 'stranded_assigned_issue'
   AND r.evidence ->> 'retryReason' IN ('assignment_recovery', 'issue_continuation_needed')
   AND i.status = 'blocked'$1;
SQL
}
if [[ -n "$COMPANY" ]]; then
  OUT="$(query " AND r.company_id = '$COMPANY'::uuid" \
    | "$DOCKER" exec -i "$DB_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -X -At -F ' ' -v ON_ERROR_STOP=1 -v since="$SINCE" -f -)" \
    || { printf 'ERROR: %s: discovery query failed\n' "$ME" >&2; exit 1; }
else
  OUT="$(query "" \
    | "$DOCKER" exec -i "$DB_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -X -At -F ' ' -v ON_ERROR_STOP=1 -v since="$SINCE" -f -)" \
    || { printf 'ERROR: %s: discovery query failed\n' "$ME" >&2; exit 1; }
fi

n="$(grep -c . <<<"$OUT" || true)"
printf 'candidates: %s\n' "$n"
[[ "$n" == "0" ]] && exit 0
printf '%s\n' "$OUT"

[[ "$APPLY" == "1" ]] || { printf 'list-only (pass --apply --live to restore)\n'; exit 0; }

while read -r aid iid ident; do
  [[ -n "${aid:-}" ]] || continue
  body=$(python3 -c 'import json,sys; print(json.dumps({"actionId":sys.argv[1],"outcome":"restored","sourceIssueStatus":"todo","resolutionNote":"Operator: this card was blocked only because a restart stranded its queued recovery/continuation retry (no drain cancel involved). Restored to todo for the original assignee; verify prior side effects before repeating them."}))' "$aid")
  code=$(curl -sK "$API_AUTH_FILE" -m 90 -X POST -H 'content-type: application/json' --data-binary "$body" \
    "$API_BASE/api/issues/$iid/recovery-actions/resolve" -o /tmp/drain-stranded-resp.json -w '%{http_code}') \
    || { printf 'ERROR: %s: transport failed restoring %s\n' "$ME" "$ident" >&2; exit 1; }
  printf '%s %s\n' "$ident" "$code"
  [[ "$code" == "200" ]] || { printf 'ERROR: %s: restore of %s returned %s; aborting\n' "$ME" "$ident" "$code" >&2; exit 1; }
done <<<"$OUT"
printf 'restored %s card(s)\n' "$n"
