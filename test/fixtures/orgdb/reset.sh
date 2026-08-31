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
if [[ "${1:-}" == "--init" ]]; then
  [[ $# -eq 1 ]] || refuse "usage: reset.sh [--init]"
  {
    printf "\\set expected_database '%s'\n" "$EXPECTED_DATABASE"
    printf "\\set expected_marker '%s'\n" "$SENTINEL_VALUE"
    cat <<'SQL'
BEGIN;
SELECT set_config('org_fixture.expected_database', :'expected_database', true);
SELECT set_config('org_fixture.expected_marker', :'expected_marker', true);
DO $init_guard$
DECLARE
  actual_database text := current_database();
  actual_marker text;
  public_table_count bigint;
BEGIN
  IF actual_database <> current_setting('org_fixture.expected_database') THEN
    RAISE EXCEPTION 'connected database is %, expected %',
      actual_database, current_setting('org_fixture.expected_database');
  END IF;

  IF to_regclass('public.org_fixture_sentinel') IS NOT NULL THEN
    SELECT marker INTO STRICT actual_marker FROM public.org_fixture_sentinel;
    IF actual_marker IS DISTINCT FROM current_setting('org_fixture.expected_marker') THEN
      RAISE EXCEPTION 'fixture sentinel has an unexpected value';
    END IF;
    RETURN;
  END IF;

  SELECT count(*) INTO public_table_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p');
  IF public_table_count <> 0 THEN
    RAISE EXCEPTION 'will not initialize a sentinel over % existing public table(s)', public_table_count;
  END IF;

  CREATE TABLE public.org_fixture_sentinel (
    marker text PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  INSERT INTO public.org_fixture_sentinel (marker)
  VALUES (current_setting('org_fixture.expected_marker'));
END
$init_guard$;
COMMIT;
SQL
  } | psql -X -v ON_ERROR_STOP=1 >/dev/null
  exit 0
fi
[[ $# -eq 0 ]] || refuse "usage: reset.sh [--init]"

# The sentinel is deliberately outside the six-table fixture and survives each
# reset. The server-side database name, marker, DROP, schema, and data load share
# one connection and transaction so a failover/load balancer cannot validate
# one backend and execute any reset write on another.
{
  printf "\\set expected_database '%s'\n" "$EXPECTED_DATABASE"
  printf "\\set expected_marker '%s'\n" "$SENTINEL_VALUE"
  cat <<'SQL'
BEGIN;
SELECT set_config('org_fixture.expected_database', :'expected_database', true);
SELECT set_config('org_fixture.expected_marker', :'expected_marker', true);
DO $reset_guard$
DECLARE
  actual_database text := current_database();
  actual_marker text;
BEGIN
  IF actual_database <> current_setting('org_fixture.expected_database') THEN
    RAISE EXCEPTION 'connected database is %, expected %',
      actual_database, current_setting('org_fixture.expected_database');
  END IF;

  IF to_regclass('public.org_fixture_sentinel') IS NULL THEN
    RAISE EXCEPTION 'fixture sentinel is absent; run reset.sh --init on an empty org_fixture database';
  END IF;

  SELECT marker INTO STRICT actual_marker FROM public.org_fixture_sentinel;
  IF actual_marker IS DISTINCT FROM current_setting('org_fixture.expected_marker') THEN
    RAISE EXCEPTION 'fixture sentinel has an unexpected value';
  END IF;
END
$reset_guard$;
DROP TABLE IF EXISTS public.heartbeat_runs, public.budget_policies,
  public.company_secret_bindings, public.company_memberships,
  public.principal_permission_grants, public.agents CASCADE;
SQL
  cat "$HERE/schema.sql" "$HERE/org.sql"
  printf 'COMMIT;\n'
} | psql -X -v ON_ERROR_STOP=1
