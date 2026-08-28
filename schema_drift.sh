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
  local table_count
  table_count="$(psql -X -Atq -v ON_ERROR_STOP=1 <<SQL
SELECT count(*)
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r','p')
  AND c.relname IN ('agents','budget_policies','company_memberships','company_secret_bindings','heartbeat_runs','principal_permission_grants');
SQL
)" || return 2
  [[ "$table_count" == "6" ]] || {
    echo "REFUSED: $ME: expected all six Paperclip fixture tables, found ${table_count:-no measurable count}" >&2
    return 2
  }

  psql -X -Atq -v ON_ERROR_STOP=1 <<SQL
SET search_path = public, pg_catalog;
SELECT 'column', c.relname, '---', a.attname,
       pg_catalog.format_type(a.atttypid, a.atttypmod),
       CASE WHEN a.attnotnull THEN 'not-null' ELSE 'nullable' END,
       COALESCE(regexp_replace(pg_get_expr(d.adbin, d.adrelid), '::(text|jsonb|boolean|integer|bigint|uuid)$', ''), '(none)')
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname='public'
  AND c.relkind IN ('r','p')
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND c.relname IN ('agents','budget_policies','company_memberships','company_secret_bindings','heartbeat_runs','principal_permission_grants')
UNION ALL
SELECT 'index', tablename, '---', indexname,
       regexp_replace(indexdef, ' ON public\\.', ' ON '),
       '(none)', '(none)'
FROM pg_indexes
WHERE schemaname='public'
  AND tablename IN ('agents','budget_policies','company_memberships','company_secret_bindings','heartbeat_runs','principal_permission_grants')
ORDER BY 2, 1, 4;
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
