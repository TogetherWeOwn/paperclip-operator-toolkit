#!/usr/bin/env bash
# Compare the six-table CI fixture with a fingerprint taken from the running
# Paperclip database. The contract is columns (including type, nullability and
# default) plus indexes on those six tables. It intentionally excludes foreign
# keys, non-index constraints and triggers because the query-compatible fixture
# omits platform behaviour outside the two privilege suites. CI tests the
# detector; the operator comparison still runs where production is reachable.
#
# IT REACHES POSTGRES THROUGH lib/pcsql.sh, LIKE EVERY OTHER TOOL HERE, and
# that is not a tidiness point. This shipped calling `psql` directly, which is
# the one backend the operator half does not have: production is reached with
# `podman exec paperclip-db` (CONTRIBUTING, "Operator-only"), and pcsql exists
# precisely because open-coding that call in each tool made them unrunnable
# anywhere else. A drift detector that only runs on the CI side of its own
# comparison is not a drift detector — the fixture it guards is a snapshot of
# the VPS schema, so `fingerprint` on the VPS is the half that has to work, and
# it was the half that refused. Failing closed made it visible rather than
# wrong, but it left TOG-480's "the dump ships with a drift check or it does
# not ship" unmet in practice.
#
# The second direction is worse and is why this must not be fixed by telling
# operators to install psql. A bare `psql` connects to whatever that psql
# defaults to — some other database on the same host — and every column it
# reports is real, so the output looks exactly like a measurement of Paperclip.
# The six-table guard below is the backstop for that, and the backend seam
# means the destination is now chosen explicitly rather than inherited from
# whatever happens to be on PATH. Preflight makes "could not reach it" a
# refusal instead of a comparison against nothing.
set -uo pipefail
ME="$(basename "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TABLES="agents budget_policies company_memberships company_secret_bindings heartbeat_runs principal_permission_grants"
EXIT_OK=0; EXIT_REFUSED=2; EXIT_DRIFT=3

die() { echo "REFUSED: $ME: $*" >&2; exit $EXIT_REFUSED; }

# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || die "missing $HERE/lib/pcsql.sh"

query() {
  local table_count
  table_count="$(pcsql_run -X -Atq -v ON_ERROR_STOP=1 <<SQL
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

  pcsql_run -X -Atq -v ON_ERROR_STOP=1 <<SQL
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
# A real round-trip, not `command -v`. A host with podman but no paperclip-db,
# or a psql pointed at a dead one, passes a binary check and then produces a
# comparison against nothing. pcsql_preflight diagnoses on stderr; the exit
# code here is REFUSED either way, never a verdict.
require_backend() {
  pcsql_backend >/dev/null || die "PAPERCLIP_SQL_BACKEND is not one of: podman, psql"
  pcsql_preflight || die "the $(pcsql_backend) backend did not answer; nothing was measured"
}

case "${1:-}" in
  fingerprint)
    require_backend
    query
    ;;
  compare)
    fp="${2:-}"; [[ -r "$fp" ]] || die "compare needs a readable fingerprint file"
    require_backend
    current="$(mktemp)"; trap 'rm -f "$current"' EXIT
    query > "$current" || die "fixture database did not answer"
    if cmp -s "$fp" "$current"; then echo "schema fixture matches fingerprint"; exit $EXIT_OK; fi
    diff -u "$fp" "$current" || true
    echo "schema drift detected" >&2; exit $EXIT_DRIFT
    ;;
  *) cat >&2 <<EOF
Usage:
  # 1. On the VPS. The default backend is podman, so this needs no arguments
  #    and no psql — the same 'podman exec paperclip-db' every operator tool uses.
  $ME fingerprint > production-schema.fp

  # 2. In a clone, against a database loaded from test/fixtures/orgdb/schema.sql.
  PAPERCLIP_SQL_BACKEND=psql $ME compare production-schema.fp

Exit: 0 match · 2 refused (nothing was measured — NOT a pass) · 3 drift
EOF
    exit $EXIT_REFUSED ;;
esac
