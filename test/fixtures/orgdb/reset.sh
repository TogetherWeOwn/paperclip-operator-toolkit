#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPECTED_DATABASE=org_fixture
SENTINEL_TABLE=org_fixture_sentinel
SENTINEL_VALUE=paperclip-ops-tooling:TOG-480

refuse() { echo "REFUSED: orgdb fixture reset: $*" >&2; exit 2; }
psql_scalar() { psql -X -Atq -v ON_ERROR_STOP=1 <<<"$1"; }

# An ambient libpq default must never choose the target of this destructive
# helper. Requiring both the explicit input and the server's answer catches a
# DATABASE_URL/PGSERVICE override as well as a missing PGDATABASE.
[[ "${PGDATABASE:-}" == "$EXPECTED_DATABASE" ]] \
  || refuse "PGDATABASE must be explicitly set to '$EXPECTED_DATABASE'"
connected_database="$(psql_scalar 'SELECT current_database();')" \
  || refuse "could not identify the connected database"
[[ "$connected_database" == "$EXPECTED_DATABASE" ]] \
  || refuse "connected database is '$connected_database', expected '$EXPECTED_DATABASE'"

sentinel_regclass="$(psql_scalar "SELECT COALESCE(to_regclass('public.$SENTINEL_TABLE')::text, '');")" \
  || refuse "could not inspect the fixture sentinel"

if [[ "${1:-}" == "--init" ]]; then
  [[ $# -eq 1 ]] || refuse "usage: reset.sh [--init]"
  if [[ -n "$sentinel_regclass" ]]; then
    marker="$(psql_scalar "SELECT marker FROM public.$SENTINEL_TABLE;")" \
      || refuse "could not read the fixture sentinel"
    [[ "$marker" == "$SENTINEL_VALUE" ]] \
      || refuse "fixture sentinel has an unexpected value"
    exit 0
  fi

  public_table_count="$(psql_scalar "
    SELECT count(*)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p');")" \
    || refuse "could not inspect the target database"
  [[ "$public_table_count" == "0" ]] \
    || refuse "will not initialize a sentinel over $public_table_count existing public table(s)"

  psql -X -v ON_ERROR_STOP=1 -v marker="$SENTINEL_VALUE" <<'SQL' >/dev/null
CREATE TABLE public.org_fixture_sentinel (
  marker text PRIMARY KEY,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
INSERT INTO public.org_fixture_sentinel (marker) VALUES (:'marker');
SQL
  exit 0
fi
[[ $# -eq 0 ]] || refuse "usage: reset.sh [--init]"

# The sentinel is deliberately outside the six-table fixture and survives each
# reset. No DROP is reachable until both the database name and this marker have
# been verified.
[[ "$sentinel_regclass" == "$SENTINEL_TABLE" || "$sentinel_regclass" == "public.$SENTINEL_TABLE" ]] \
  || refuse "fixture sentinel is absent; run reset.sh --init on an empty org_fixture database"
marker="$(psql_scalar "SELECT marker FROM public.$SENTINEL_TABLE;")" \
  || refuse "could not read the fixture sentinel"
[[ "$marker" == "$SENTINEL_VALUE" ]] \
  || refuse "fixture sentinel has an unexpected value"

psql -X -v ON_ERROR_STOP=1 <<'SQL'
DROP TABLE IF EXISTS public.heartbeat_runs, public.budget_policies,
  public.company_secret_bindings, public.company_memberships,
  public.principal_permission_grants, public.agents CASCADE;
SQL
psql -X -v ON_ERROR_STOP=1 -f "$HERE/schema.sql"
psql -X -v ON_ERROR_STOP=1 -f "$HERE/org.sql"
