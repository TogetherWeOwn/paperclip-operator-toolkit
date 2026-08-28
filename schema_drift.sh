#!/usr/bin/env bash
# Compare the six-table CI fixture with a fingerprint taken from the running
# Paperclip database. The contract is columns (including type, nullability and
# default) plus indexes on those six tables. It intentionally excludes foreign
# keys, non-index constraints and triggers because the query-compatible fixture
# omits platform behaviour outside the two privilege suites. CI tests the
# detector; the operator comparison still runs where production is reachable.
set -uo pipefail
ME="$(basename "${BASH_SOURCE[0]}")"
TABLES="agents budget_policies company_memberships company_secret_bindings heartbeat_runs principal_permission_grants"
EXIT_OK=0; EXIT_REFUSED=2; EXIT_DRIFT=3

die() { echo "REFUSED: $ME: $*" >&2; exit $EXIT_REFUSED; }
query() {
  psql -X -Atq -v ON_ERROR_STOP=1 <<SQL
SET search_path = public, pg_catalog;
SELECT 'column', table_name, lpad(ordinal_position::text, 3, '0'), column_name,
       data_type,
       CASE WHEN is_nullable='NO' THEN 'not-null' ELSE 'nullable' END,
       COALESCE(regexp_replace(column_default, '::(text|jsonb|boolean|integer|bigint|uuid)$', ''), '(none)')
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('agents','budget_policies','company_memberships','company_secret_bindings','heartbeat_runs','principal_permission_grants')
UNION ALL
SELECT 'index', tablename, '---', indexname,
       regexp_replace(indexdef, ' ON public\\.', ' ON '),
       '(none)', '(none)'
FROM pg_indexes
WHERE schemaname='public'
  AND tablename IN ('agents','budget_policies','company_memberships','company_secret_bindings','heartbeat_runs','principal_permission_grants')
ORDER BY 2, 1, 3, 4;
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
