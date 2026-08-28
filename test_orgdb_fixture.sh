#!/usr/bin/env bash
# Offline contract tests for the fixture loader, dumb CLI stub and drift tool.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL $1"; FAIL=$((FAIL+1)); }

for f in test/fixtures/orgdb/paperclipai test/fixtures/orgdb/reset.sh schema_drift.sh; do
  bash -n "$HERE/$f" && ok "$f parses" || bad "$f does not parse"
done

for t in agents principal_permission_grants company_memberships company_secret_bindings budget_policies heartbeat_runs; do
  grep -q "CREATE TABLE $t" "$HERE/test/fixtures/orgdb/schema.sql" && ok "schema contains $t" || bad "schema misses $t"
done
for r in P0 O1 O2 O3 A0 T0 S0 F0; do
  grep -q "orgRoleId.*$r" "$HERE/test/fixtures/orgdb/org.sql" && ok "fixture contains $r" || bad "fixture misses $r"
done
for i in company_memberships_company_principal_unique_idx \
  principal_permission_grants_unique_idx company_secret_bindings_target_path_uq \
  budget_policies_company_scope_metric_unique_idx \
  agents_company_built_in_agent_key_unique_idx heartbeat_runs_company_ctx_taskkey_created_idx; do
  grep -q "${i}" "$HERE/test/fixtures/orgdb/schema.sql" && ok "schema contains index $i" || bad "schema misses index $i"
done
node - "$HERE/schema_drift.sh" <<'NODE'
const fs=require('fs'); const s=fs.readFileSync(process.argv[2],'utf8');
for (const x of ["SELECT 'column'", "SELECT 'index'", 'pg_indexes']) {
  if (!s.includes(x)) { console.error(`missing schema drift term: ${x}`); process.exit(1) }
}
NODE
[[ $? -eq 0 ]] && ok "drift fingerprint includes columns and indexes" || bad "drift fingerprint omits indexes"

mkdir "$TMP/bin"
cat > "$TMP/bin/psql" <<'PSQL'
#!/usr/bin/env bash
cat > "${PSQL_STDIN:?}"
[[ "${PSQL_FAIL:-0}" == 0 ]] || { echo "stubbed SQL failure" >&2; exit 9; }
if grep -q 'INSERT INTO agents' "$PSQL_STDIN"; then
  echo 00000000-0000-4000-8000-000000000099
elif grep -q 'SELECT count(\*) FROM updated' "$PSQL_STDIN"; then
  printf '%s\n' "${PSQL_AFFECTED:-1}"
fi
PSQL
chmod +x "$TMP/bin/psql"
export PATH="$TMP/bin:$PATH" PSQL_STDIN="$TMP/sql" PAPERCLIP_STUB_LOG="$TMP/calls"
payload='{"name":"N","runtimeConfig":{"heartbeat":{"enabled":false}},"permissions":{"authorizationPolicy":{"assignmentPolicy":{"mode":"protected"}}},"metadata":{"permissionProfile":"E0_SPECIALIST"},"reportsTo":"00000000-0000-4000-8000-000000000006"}'
out="$("$HERE/test/fixtures/orgdb/paperclipai" agent create --company-id 00000000-0000-4000-8000-000000000480 --payload-json "$payload" --json --api-base http://stub)"
[[ "$(jq -r .id <<<"$out")" == 00000000-0000-4000-8000-000000000099 ]] && ok "create echoes recorded id" || bad "create did not echo id"
[[ "$(jq -c .payload "$TMP/calls")" == "$payload" ]] && ok "stub records payload verbatim" || bad "stub rewrote payload"
if "$HERE/test/fixtures/orgdb/paperclipai" agent frobnicate >/dev/null 2>&1; then bad "stub accepts an unknown command"; else ok "stub refuses unknown commands"; fi

unknown=00000000-0000-4000-8000-000000000098
PSQL_FAIL=1 "$HERE/test/fixtures/orgdb/paperclipai" agent permissions:update "$unknown" --payload-json '{}' --json --api-base http://stub >/dev/null 2>&1 \
  && bad "stub hides permissions:update SQL errors" || ok "stub propagates permissions:update SQL errors"
PSQL_AFFECTED=0 "$HERE/test/fixtures/orgdb/paperclipai" agent permissions:update "$unknown" --payload-json '{}' --json --api-base http://stub >/dev/null 2>&1 \
  && bad "stub accepts zero-row permissions:update" || ok "stub refuses zero-row permissions:update"
PSQL_AFFECTED=2 "$HERE/test/fixtures/orgdb/paperclipai" agent terminate "$unknown" --json --api-base http://stub >/dev/null 2>&1 \
  && bad "stub accepts multi-row terminate" || ok "stub refuses multi-row terminate"

mkdir "$TMP/reset-bin"
cat > "$TMP/reset-bin/psql" <<'PSQL'
#!/usr/bin/env bash
sql="$(cat)"; printf '%s\n' "$sql" >> "${RESET_SQL_LOG:?}"
case "$sql" in
  *'SELECT current_database()'*) printf '%s\n' "${RESET_CONNECTED_DB:-org_fixture}" ;;
  *"to_regclass('public.org_fixture_sentinel')"*) printf '%s\n' "${RESET_SENTINEL_TABLE:-}" ;;
  *'SELECT marker FROM public.org_fixture_sentinel'*) printf '%s\n' "${RESET_SENTINEL_VALUE:-paperclip-ops-tooling:TOG-480}" ;;
  *'SELECT count(*)'*) printf '%s\n' "${RESET_PUBLIC_TABLES:-0}" ;;
esac
PSQL
chmod +x "$TMP/reset-bin/psql"
reset_cmd="$HERE/test/fixtures/orgdb/reset.sh"
RESET_SQL_LOG="$TMP/reset-wrong-name.sql" PATH="$TMP/reset-bin:$PATH" PGDATABASE=production "$reset_cmd" >/dev/null 2>&1 \
  && bad "reset accepts the wrong explicit database" || ok "reset refuses the wrong explicit database"
if [[ -f "$TMP/reset-wrong-name.sql" ]] && grep -q 'DROP TABLE' "$TMP/reset-wrong-name.sql"; then bad "wrong-database refusal reached DROP"; else ok "wrong-database refusal happens before DROP"; fi
RESET_SQL_LOG="$TMP/reset-no-sentinel.sql" PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" >/dev/null 2>&1 \
  && bad "reset accepts a database without the sentinel" || ok "reset refuses a database without the sentinel"
if grep -q 'DROP TABLE' "$TMP/reset-no-sentinel.sql"; then bad "missing-sentinel refusal reached DROP"; else ok "missing-sentinel refusal happens before DROP"; fi
RESET_SQL_LOG="$TMP/reset-wrong-connected.sql" RESET_CONNECTED_DB=production PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" >/dev/null 2>&1 \
  && bad "reset accepts an overridden connected database" || ok "reset verifies the server-side database name"
if grep -q 'DROP TABLE' "$TMP/reset-wrong-connected.sql"; then bad "connected-database refusal reached DROP"; else ok "connected-database refusal happens before DROP"; fi
RESET_SQL_LOG="$TMP/reset-init-nonempty.sql" RESET_PUBLIC_TABLES=1 PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" --init >/dev/null 2>&1 \
  && bad "reset initializes a sentinel over existing tables" || ok "reset refuses to arm a non-empty database"
if grep -q 'CREATE TABLE public.org_fixture_sentinel' "$TMP/reset-init-nonempty.sql"; then bad "non-empty init created the sentinel"; else ok "non-empty init makes no sentinel write"; fi
RESET_SQL_LOG="$TMP/reset-valid.sql" RESET_SENTINEL_TABLE=org_fixture_sentinel PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" >/dev/null 2>&1 \
  && ok "reset reaches the loader only after both guards pass" || bad "reset refuses a valid fixture sentinel"
if grep -q 'DROP TABLE' "$TMP/reset-valid.sql"; then ok "valid fixture reset executes the DROP"; else bad "valid fixture reset never reached DROP"; fi

printf 'RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
