#!/usr/bin/env bash
# Compare the six-table CI fixture with a fingerprint taken from the running
# Paperclip database. CI tests the detector; the operator comparison still runs
# where the production schema is reachable.
set -uo pipefail
ME="$(basename "${BASH_SOURCE[0]}")"
TABLES="agents budget_policies company_memberships company_secret_bindings heartbeat_runs principal_permission_grants"
EXIT_OK=0; EXIT_REFUSED=2; EXIT_DRIFT=3

die() { echo "REFUSED: $ME: $*" >&2; exit $EXIT_REFUSED; }
query() {
  psql -Atq -v ON_ERROR_STOP=1 <<SQL
SELECT table_name, column_name, data_type,
       CASE WHEN is_nullable='NO' THEN 'not-null' ELSE 'nullable' END,
       COALESCE(regexp_replace(column_default, '::(text|jsonb|boolean|integer|bigint|uuid)$', ''), '(none)')
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('agents','budget_policies','company_memberships','company_secret_bindings','heartbeat_runs','principal_permission_grants')
ORDER BY table_name, ordinal_position;
SQL
}
case "${1:-}" in
  fingerprint)
    command -v psql >/dev/null || die "psql is not on PATH"
    query
    ;;
  compare)
    fp="${2:-}"; [[ -r "$fp" ]] || die "compare needs a readable fingerprint file"
    command -v psql >/dev/null || die "psql is not on PATH"
    current="$(mktemp)"; trap 'rm -f "$current"' EXIT
    query > "$current" || die "fixture database did not answer"
    if cmp -s "$fp" "$current"; then echo "schema fixture matches fingerprint"; exit $EXIT_OK; fi
    diff -u "$fp" "$current" || true
    echo "schema drift detected" >&2; exit $EXIT_DRIFT
    ;;
  *) cat >&2 <<EOF
Usage:
  $ME fingerprint > production-schema.fp   # run against the VPS database
  $ME compare production-schema.fp         # run against a DB loaded from schema.sql
Exit: 0 match · 2 refused · 3 drift
EOF
    exit $EXIT_REFUSED ;;
esac
