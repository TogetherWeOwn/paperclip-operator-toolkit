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
if grep -q 'INSERT INTO agents' "$PSQL_STDIN"; then echo 00000000-0000-4000-8000-000000000099; fi
PSQL
chmod +x "$TMP/bin/psql"
export PATH="$TMP/bin:$PATH" PSQL_STDIN="$TMP/sql" PAPERCLIP_STUB_LOG="$TMP/calls"
payload='{"name":"N","runtimeConfig":{"heartbeat":{"enabled":false}},"permissions":{"authorizationPolicy":{"assignmentPolicy":{"mode":"protected"}}},"metadata":{"permissionProfile":"E0_SPECIALIST"},"reportsTo":"00000000-0000-4000-8000-000000000006"}'
out="$("$HERE/test/fixtures/orgdb/paperclipai" agent create --company-id 00000000-0000-4000-8000-000000000480 --payload-json "$payload" --json --api-base http://stub)"
[[ "$(jq -r .id <<<"$out")" == 00000000-0000-4000-8000-000000000099 ]] && ok "create echoes recorded id" || bad "create did not echo id"
[[ "$(jq -c .payload "$TMP/calls")" == "$payload" ]] && ok "stub records payload verbatim" || bad "stub rewrote payload"
if "$HERE/test/fixtures/orgdb/paperclipai" agent frobnicate >/dev/null 2>&1; then bad "stub accepts an unknown command"; else ok "stub refuses unknown commands"; fi

printf 'RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
