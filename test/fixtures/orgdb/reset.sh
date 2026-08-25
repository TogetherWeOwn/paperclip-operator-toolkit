#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
psql -v ON_ERROR_STOP=1 <<'SQL'
DROP TABLE IF EXISTS heartbeat_runs, budget_policies, company_secret_bindings,
  company_memberships, principal_permission_grants, agents CASCADE;
SQL
psql -v ON_ERROR_STOP=1 -f "$HERE/schema.sql"
psql -v ON_ERROR_STOP=1 -f "$HERE/org.sql"
