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
connected_database="${RESET_CONNECTED_DB:-org_fixture}"
sentinel_marker_set=0
if [[ ${RESET_SENTINEL_VALUE+x} ]]; then
  sentinel_marker_set=1
  sentinel_marker=$RESET_SENTINEL_VALUE
else
  sentinel_marker=paperclip-ops-tooling:TOG-480
fi
if [[ -n "${RESET_BACKEND_STATE:-}" ]]; then
  call=0; [[ -r "$RESET_BACKEND_STATE" ]] && read -r call < "$RESET_BACKEND_STATE"
  call=$((call + 1)); printf '%s\n' "$call" > "$RESET_BACKEND_STATE"
  if (( call % 2 == 1 )); then connected_database=production; else connected_database=org_fixture; fi
fi
case "$sql" in
  *'CREATE TABLE public.org_fixture_sentinel'*)
    for guard in "\\set expected_database 'org_fixture'" \
      "\\set expected_marker 'paperclip-ops-tooling:TOG-480'" \
      'IF actual_database <> current_setting(' \
      "IF to_regclass('public.org_fixture_sentinel') IS NOT NULL THEN" \
      'IF actual_marker IS DISTINCT FROM current_setting(' \
      "RAISE EXCEPTION 'fixture sentinel has an unexpected value'" \
      'IF public_table_count <> 0 THEN' 'CREATE TABLE public.org_fixture_sentinel' \
      'INSERT INTO public.org_fixture_sentinel' 'COMMIT;'; do
      grep -Fq "$guard" <<<"$sql" || { echo "init safety term missing from write session: $guard" >&2; exit 9; }
    done
    database_line="$(grep -nF 'IF actual_database <> current_setting(' <<<"$sql" | cut -d: -f1)"
    sentinel_line="$(grep -nF "IF to_regclass('public.org_fixture_sentinel') IS NOT NULL THEN" <<<"$sql" | cut -d: -f1)"
    empty_line="$(grep -nF 'IF public_table_count <> 0 THEN' <<<"$sql" | cut -d: -f1)"
    create_line="$(grep -nF 'CREATE TABLE public.org_fixture_sentinel' <<<"$sql" | cut -d: -f1)"
    insert_line="$(grep -nF 'INSERT INTO public.org_fixture_sentinel' <<<"$sql" | cut -d: -f1)"
    commit_line="$(grep -nF 'COMMIT;' <<<"$sql" | cut -d: -f1)"
    if ! (( database_line < sentinel_line && sentinel_line < empty_line \
      && empty_line < create_line && create_line < insert_line && insert_line < commit_line )); then
      printf 'INIT backend=%s\n' "$connected_database" >> "${RESET_EXEC_LOG:?}"
      echo "init guards do not precede the sentinel write in one transaction" >&2
      exit 9
    fi
    [[ "$connected_database" == org_fixture ]] || { echo "connected database is $connected_database" >&2; exit 9; }
    [[ -z "${RESET_SENTINEL_TABLE:-}" ]] || {
      (( sentinel_marker_set == 0 )) \
        || [[ "$sentinel_marker" == paperclip-ops-tooling:TOG-480 ]] \
        || { echo "fixture sentinel has an unexpected value" >&2; exit 9; }
      exit 0
    }
    [[ "${RESET_PUBLIC_TABLES:-0}" == 0 ]] || { echo "target database is not empty" >&2; exit 9; }
    printf 'INIT backend=%s\n' "$connected_database" >> "${RESET_EXEC_LOG:?}"
    ;;
  *'DROP TABLE IF EXISTS public.heartbeat_runs'*)
    for guard in "\\set expected_database 'org_fixture'" \
      "\\set expected_marker 'paperclip-ops-tooling:TOG-480'" \
      'BEGIN;' 'IF actual_database <> current_setting(' \
      "IF to_regclass('public.org_fixture_sentinel') IS NULL THEN" \
      'IF actual_marker IS DISTINCT FROM current_setting(' 'DROP TABLE IF EXISTS public.heartbeat_runs' \
      'CREATE TABLE agents (' 'INSERT INTO agents (' 'COMMIT;'; do
      grep -Fq "$guard" <<<"$sql" || { echo "reset safety term missing from destructive session: $guard" >&2; exit 9; }
    done
    if ! node - "$sql" <<'NODE'
const sql=process.argv[2]
const start=sql.indexOf('DO $reset_guard$')
const end=sql.indexOf('$reset_guard$;', start)
if (start < 0 || end < 0) process.exit(1)
const guard=sql.slice(start, end)
const terms=[
  "IF actual_database <> current_setting('org_fixture.expected_database') THEN",
  "IF to_regclass('public.org_fixture_sentinel') IS NULL THEN",
  'SELECT marker INTO STRICT actual_marker FROM public.org_fixture_sentinel;',
  "IF actual_marker IS DISTINCT FROM current_setting('org_fixture.expected_marker') THEN"
]
let at=-1
for (const term of terms) {
  const next=guard.indexOf(term, at + 1)
  if (next < 0) process.exit(1)
  at=next
}
const beforeGuard=sql.slice(0, start)
const guardBeforeMarker=guard.slice(0, guard.indexOf(terms[2]))
const destructive=/\b(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT|CREATE|ALTER)\b/i
if (destructive.test(beforeGuard) || destructive.test(guardBeforeMarker)) process.exit(1)
if (/\bRETURN\s*;/i.test(guard)) process.exit(1)
const drop=sql.indexOf('DROP TABLE IF EXISTS public.heartbeat_runs', end)
const schema=sql.indexOf('CREATE TABLE agents (', drop)
const data=sql.indexOf('INSERT INTO agents (', schema)
const commit=sql.indexOf('COMMIT;', data)
if (!(end < drop && drop < schema && schema < data && data < commit)) process.exit(1)
NODE
    then
      printf 'WRITE backend=%s\n' "$connected_database" >> "${RESET_EXEC_LOG:?}"
      echo "reset guards do not precede all writes in one transaction" >&2
      exit 9
    fi
    [[ "$connected_database" == org_fixture ]] || { echo "connected database is $connected_database" >&2; exit 9; }
    [[ "${RESET_SENTINEL_TABLE:-}" == org_fixture_sentinel ]] || { echo "fixture sentinel is absent" >&2; exit 9; }
    if (( sentinel_marker_set == 0 )) || [[ "$sentinel_marker" != paperclip-ops-tooling:TOG-480 ]]; then
      echo "fixture sentinel has an unexpected value" >&2
      exit 9
    fi
    printf 'WRITE backend=%s\n' "$connected_database" >> "${RESET_EXEC_LOG:?}"
    ;;
  *'SELECT current_database()'*) printf '%s\n' "$connected_database" ;;
  *"to_regclass('public.org_fixture_sentinel')"*) printf '%s\n' "${RESET_SENTINEL_TABLE:-}" ;;
  *'SELECT marker FROM public.org_fixture_sentinel'*) printf '%s\n' "${RESET_SENTINEL_VALUE:-paperclip-ops-tooling:TOG-480}" ;;
  *'SELECT count(*)'*) printf '%s\n' "${RESET_PUBLIC_TABLES:-0}" ;;
esac
PSQL
chmod +x "$TMP/reset-bin/psql"
reset_cmd="$HERE/test/fixtures/orgdb/reset.sh"
RESET_SQL_LOG="$TMP/reset-wrong-name.sql" RESET_EXEC_LOG="$TMP/reset-wrong-name.exec" PATH="$TMP/reset-bin:$PATH" PGDATABASE=production "$reset_cmd" >/dev/null 2>&1 \
  && bad "reset accepts the wrong explicit database" || ok "reset refuses the wrong explicit database"
if [[ -s "$TMP/reset-wrong-name.exec" ]]; then bad "wrong-database refusal executed DROP"; else ok "wrong-database refusal happens before DROP"; fi
RESET_SQL_LOG="$TMP/reset-no-sentinel.sql" RESET_EXEC_LOG="$TMP/reset-no-sentinel.exec" PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" >/dev/null 2>&1 \
  && bad "reset accepts a database without the sentinel" || ok "reset refuses a database without the sentinel"
if [[ -s "$TMP/reset-no-sentinel.exec" ]]; then bad "missing-sentinel refusal executed DROP"; else ok "missing-sentinel refusal happens before DROP"; fi
for marker_case in wrong null; do
  if [[ "$marker_case" == wrong ]]; then marker_value=not-the-fixture-marker; else marker_value=; fi
  RESET_SQL_LOG="$TMP/reset-$marker_case-marker.sql" RESET_EXEC_LOG="$TMP/reset-$marker_case-marker.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE="$marker_value" \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" >/dev/null 2>&1 \
    && bad "reset accepts a $marker_case sentinel marker" || ok "reset refuses a $marker_case sentinel marker"
  if [[ -s "$TMP/reset-$marker_case-marker.exec" ]]; then bad "$marker_case-marker refusal executed DROP"; else ok "$marker_case-marker refusal happens before DROP"; fi
done
RESET_SQL_LOG="$TMP/reset-wrong-connected.sql" RESET_EXEC_LOG="$TMP/reset-wrong-connected.exec" RESET_CONNECTED_DB=production PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" >/dev/null 2>&1 \
  && bad "reset accepts an overridden connected database" || ok "reset verifies the server-side database name"
if [[ -s "$TMP/reset-wrong-connected.exec" ]]; then bad "connected-database refusal executed DROP"; else ok "connected-database refusal happens before DROP"; fi
RESET_SQL_LOG="$TMP/reset-init-nonempty.sql" RESET_EXEC_LOG="$TMP/reset-init-nonempty.exec" RESET_PUBLIC_TABLES=1 PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" --init >/dev/null 2>&1 \
  && bad "reset initializes a sentinel over existing tables" || ok "reset refuses to arm a non-empty database"
if [[ -s "$TMP/reset-init-nonempty.exec" ]]; then bad "non-empty init executed the sentinel write"; else ok "non-empty init makes no sentinel write"; fi
for marker_case in wrong null; do
  if [[ "$marker_case" == wrong ]]; then marker_value=not-the-fixture-marker; else marker_value=; fi
  RESET_SQL_LOG="$TMP/reset-init-$marker_case-marker.sql" RESET_EXEC_LOG="$TMP/reset-init-$marker_case-marker.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE="$marker_value" \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" --init >/dev/null 2>&1 \
    && bad "init accepts an existing $marker_case sentinel marker" || ok "init refuses an existing $marker_case sentinel marker"
  if [[ -s "$TMP/reset-init-$marker_case-marker.exec" ]]; then bad "$marker_case-marker init refusal wrote the sentinel"; else ok "$marker_case-marker init refusal makes no sentinel write"; fi
done
RESET_SQL_LOG="$TMP/reset-init-valid.sql" RESET_EXEC_LOG="$TMP/reset-init-valid.exec" PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" --init >/dev/null 2>&1 \
  && ok "init creates the sentinel after all guards pass" || bad "init refuses an empty fixture database"
if grep -q '^INIT backend=org_fixture$' "$TMP/reset-init-valid.exec"; then ok "valid init executes the sentinel write"; else bad "valid init never reached the sentinel write"; fi

init_backend_state="$TMP/reset-init-backend-state"
RESET_SQL_LOG="$TMP/reset-init-alternating-invalid.sql" RESET_EXEC_LOG="$TMP/reset-init-alternating.exec" \
  RESET_BACKEND_STATE="$init_backend_state" PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture \
  "$reset_cmd" --init >/dev/null 2>&1 \
  && bad "alternating backend init accepts the unvalidated session" || ok "alternating backend init refuses the unvalidated session"
if [[ -s "$TMP/reset-init-alternating.exec" ]]; then bad "unvalidated alternating backend executed sentinel init"; else ok "unvalidated alternating backend executes no sentinel init"; fi
RESET_SQL_LOG="$TMP/reset-init-alternating-valid.sql" RESET_EXEC_LOG="$TMP/reset-init-alternating.exec" \
  RESET_BACKEND_STATE="$init_backend_state" PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture \
  "$reset_cmd" --init >/dev/null 2>&1 \
  && ok "alternating backend init accepts its validated session" || bad "alternating backend init refuses its validated session"
if [[ "$(grep -c '^INIT backend=org_fixture$' "$TMP/reset-init-alternating.exec")" == 1 ]]; then ok "only the validated alternating backend initializes the sentinel"; else bad "alternating backend init was not session-bound"; fi

RESET_SQL_LOG="$TMP/reset-valid.sql" RESET_EXEC_LOG="$TMP/reset-valid.exec" RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE=paperclip-ops-tooling:TOG-480 PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" >/dev/null 2>&1 \
  && ok "reset reaches the loader only after both guards pass" || bad "reset refuses a valid fixture sentinel"
if grep -q '^WRITE backend=org_fixture$' "$TMP/reset-valid.exec"; then ok "valid fixture reset executes all writes"; else bad "valid fixture reset never reached its writes"; fi

backend_state="$TMP/reset-backend-state"
RESET_SQL_LOG="$TMP/reset-alternating-invalid.sql" RESET_EXEC_LOG="$TMP/reset-alternating.exec" \
  RESET_BACKEND_STATE="$backend_state" RESET_SENTINEL_TABLE=org_fixture_sentinel \
  RESET_SENTINEL_VALUE=paperclip-ops-tooling:TOG-480 \
  PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" >/dev/null 2>&1 \
  && bad "alternating backend reset accepts the unvalidated session" || ok "alternating backend reset refuses the unvalidated session"
if [[ -s "$TMP/reset-alternating.exec" ]]; then bad "unvalidated alternating backend executed DROP"; else ok "unvalidated alternating backend executes no DROP"; fi
RESET_SQL_LOG="$TMP/reset-alternating-valid.sql" RESET_EXEC_LOG="$TMP/reset-alternating.exec" \
  RESET_BACKEND_STATE="$backend_state" RESET_SENTINEL_TABLE=org_fixture_sentinel \
  RESET_SENTINEL_VALUE=paperclip-ops-tooling:TOG-480 \
  PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$reset_cmd" >/dev/null 2>&1 \
  && ok "alternating backend reset accepts its validated session" || bad "alternating backend reset refuses its validated session"
if [[ "$(grep -c '^WRITE backend=org_fixture$' "$TMP/reset-alternating.exec")" == 1 ]]; then ok "only the validated alternating backend executes reset writes"; else bad "alternating backend writes were not session-bound"; fi
if [[ "$(grep -c 'DROP TABLE IF EXISTS public.heartbeat_runs' "$TMP/reset-alternating-valid.sql")" == 1 ]] \
  && [[ "$(grep -c 'CREATE TABLE agents (' "$TMP/reset-alternating-valid.sql")" == 1 ]] \
  && [[ "$(grep -c 'INSERT INTO agents (' "$TMP/reset-alternating-valid.sql")" == 1 ]]; then
  ok "database, sentinel, DROP, schema, and data share one psql session"
else
  bad "fixture reset writes span multiple psql sessions"
fi

mutant_dir="$TMP/reset-mutants"
mkdir "$mutant_dir"
cp "$HERE/test/fixtures/orgdb/schema.sql" "$HERE/test/fixtures/orgdb/org.sql" "$mutant_dir/"
mutant_baseline="$mutant_dir/reset-baseline.sh"
cp "$reset_cmd" "$mutant_baseline"
chmod +x "$mutant_baseline"
RESET_SQL_LOG="$TMP/reset-mutant-baseline.sql" RESET_EXEC_LOG="$TMP/reset-mutant-baseline.exec" \
  RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE=paperclip-ops-tooling:TOG-480 \
  PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$mutant_baseline" >/dev/null 2>&1 \
  && ok "copied reset mutant baseline passes with its fixture files" \
  || bad "copied reset mutant baseline does not pass"

mutant="$mutant_dir/reset-drop-before-guard.sh"
cp "$reset_cmd" "$mutant"
if node - "$mutant" <<'NODE'
const fs=require('fs'), p=process.argv[2], s=fs.readFileSync(p,'utf8')
const start=s.indexOf('DO $reset_guard$'), end=s.indexOf('$reset_guard$;', start)
if (start < 0 || end < 0) throw Error('reset guard block anchor missing')
const drop="DROP TABLE IF EXISTS public.heartbeat_runs, public.budget_policies,\n  public.company_secret_bindings, public.company_memberships,\n  public.principal_permission_grants, public.agents CASCADE;\n"
const dropAt=s.indexOf(drop, end)
if (dropAt < 0) throw Error('reset DROP mutation anchor missing')
const guard=s.slice(start, end)
const databaseAt=guard.indexOf("  IF actual_database <> current_setting('org_fixture.expected_database') THEN")
if (databaseAt < 0) throw Error('reset database guard mutation anchor missing')
fs.writeFileSync(p, s.slice(0, start + databaseAt) + drop + s.slice(start + databaseAt, dropAt) + s.slice(dropAt + drop.length))
NODE
then
  chmod +x "$mutant"
  mutant_err="$TMP/reset-drop-before-guard.err"
  RESET_SQL_LOG="$TMP/reset-drop-before-guard.sql" RESET_EXEC_LOG="$TMP/reset-drop-before-guard.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture \
    "$mutant" >/dev/null 2>"$mutant_err"; mutant_rc=$?
  if [[ $mutant_rc -eq 9 ]] && grep -Fq 'reset guards do not precede all writes in one transaction' "$mutant_err"; then
    ok "test control rejects DROP before the reset guards at the safety seam"
  else
    bad "DROP-before-guard mutant did not fail at the expected safety seam"
  fi
else
  bad "DROP-before-guard mutation could not be constructed"
fi

mutant="$mutant_dir/reset-independent-drop-before-guard.sh"
cp "$reset_cmd" "$mutant"
if node - "$mutant" <<'NODE'
const fs=require('fs'), p=process.argv[2], s=fs.readFileSync(p,'utf8')
const anchor='DO $reset_guard$'
const at=s.indexOf(anchor)
if (at < 0) throw Error('reset guard mutation anchor missing')
fs.writeFileSync(p, s.slice(0, at) + 'DROP TABLE public.agents CASCADE;\n' + s.slice(at))
NODE
then
  chmod +x "$mutant"
  mutant_err="$TMP/reset-independent-drop-before-guard.err"
  RESET_SQL_LOG="$TMP/reset-independent-drop-before-guard.sql" RESET_EXEC_LOG="$TMP/reset-independent-drop-before-guard.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE=paperclip-ops-tooling:TOG-480 \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture \
    "$mutant" >/dev/null 2>"$mutant_err"; mutant_rc=$?
  if [[ $mutant_rc -eq 9 ]] && grep -Fq 'reset guards do not precede all writes in one transaction' "$mutant_err"; then
    ok "test control rejects an independent destructive write before the reset guard"
  else
    bad "independent pre-guard destructive-write mutant did not fail at the expected safety seam"
  fi
else
  bad "independent pre-guard destructive-write mutation could not be constructed"
fi

mutant="$mutant_dir/reset-return-before-marker.sh"
cp "$reset_cmd" "$mutant"
if node - "$mutant" <<'NODE'
const fs=require('fs'), p=process.argv[2], s=fs.readFileSync(p,'utf8')
const start=s.indexOf('DO $reset_guard$'), end=s.indexOf('$reset_guard$;', start)
if (start < 0 || end < 0) throw Error('reset guard block anchor missing')
const anchor='  SELECT marker INTO STRICT actual_marker FROM public.org_fixture_sentinel;'
const at=s.indexOf(anchor, start)
if (at < 0 || at > end) throw Error('reset marker validation anchor missing')
fs.writeFileSync(p, s.slice(0, at) + '  RETURN;\n' + s.slice(at))
NODE
then
  chmod +x "$mutant"
  mutant_err="$TMP/reset-return-before-marker.err"
  RESET_SQL_LOG="$TMP/reset-return-before-marker.sql" RESET_EXEC_LOG="$TMP/reset-return-before-marker.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE=paperclip-ops-tooling:TOG-480 \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture \
    "$mutant" >/dev/null 2>"$mutant_err"; mutant_rc=$?
  if [[ $mutant_rc -eq 9 ]] && grep -Fq 'reset guards do not precede all writes in one transaction' "$mutant_err"; then
    ok "test control rejects control flow that bypasses marker validation"
  else
    bad "marker-validation bypass mutant did not fail at the expected safety seam"
  fi
else
  bad "marker-validation bypass mutation could not be constructed"
fi

for guard_key in database sentinel marker; do
  mutant="$mutant_dir/reset-no-$guard_key-guard.sh"
  cp "$reset_cmd" "$mutant"
  if node - "$mutant" "$guard_key" <<'NODE'
const fs=require('fs'), p=process.argv[2], key=process.argv[3], s=fs.readFileSync(p,'utf8')
const start=s.indexOf('DO $reset_guard$'), end=s.indexOf('$reset_guard$;', start)
if (start < 0 || end < 0) throw Error('reset guard block anchor missing')
const before=s.slice(0,start), guard=s.slice(start,end), after=s.slice(end)
const blocks={
  database: /  IF actual_database <> current_setting\('org_fixture\.expected_database'\) THEN\n    RAISE EXCEPTION[\s\S]*?  END IF;\n/,
  sentinel: /  IF to_regclass\('public\.org_fixture_sentinel'\) IS NULL THEN\n    RAISE EXCEPTION[\s\S]*?  END IF;\n/,
  marker: /  IF actual_marker IS DISTINCT FROM current_setting\('org_fixture\.expected_marker'\) THEN\n    RAISE EXCEPTION[\s\S]*?  END IF;\n/
}
if (!blocks[key].test(guard)) throw Error(`${key} reset guard mutation anchor missing`)
fs.writeFileSync(p, before + guard.replace(blocks[key], '') + after)
NODE
  then
    chmod +x "$mutant"
    mutant_err="$TMP/reset-no-$guard_key-guard.err"
    RESET_SQL_LOG="$TMP/reset-no-$guard_key-guard.sql" RESET_EXEC_LOG="$TMP/reset-no-$guard_key-guard.exec" \
      RESET_SENTINEL_TABLE=org_fixture_sentinel PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture \
      "$mutant" >/dev/null 2>"$mutant_err"; mutant_rc=$?
    if [[ $mutant_rc -eq 9 ]] && grep -Fq "reset safety term missing from destructive session" "$mutant_err"; then
      ok "test control rejects reset without the $guard_key guard at the safety seam"
    else
      bad "$guard_key guard mutant did not fail at the expected safety seam"
    fi
  else
    bad "$guard_key guard mutation could not be constructed"
  fi
done

# TOG-736: the --init CREATE TABLE branch previously decided a wrong/NULL
# marker by its own bash comparison, independent of what the guard SQL said -
# so deleting or NULL-unsafing the production predicate still passed. The
# assertions below require the literal predicate text to reach the wire; the
# stub no longer does its own marker comparison for these three checks.
mutant="$mutant_dir/reset-init-no-marker-predicate.sh"
cp "$reset_cmd" "$mutant"
if node - "$mutant" <<'NODE'
const fs=require('fs'), p=process.argv[2], s=fs.readFileSync(p,'utf8')
const start=s.indexOf('DO $init_guard$'), end=s.indexOf('$init_guard$;', start)
if (start < 0 || end < 0) throw Error('init guard block anchor missing')
const before=s.slice(0,start), guard=s.slice(start,end), after=s.slice(end)
const block=/    IF actual_marker IS DISTINCT FROM current_setting\('org_fixture\.expected_marker'\) THEN\n      RAISE EXCEPTION 'fixture sentinel has an unexpected value';\n    END IF;\n/
if (!block.test(guard)) throw Error('init marker predicate mutation anchor missing')
fs.writeFileSync(p, before + guard.replace(block, '') + after)
NODE
then
  chmod +x "$mutant"
  mutant_init_guard="$(node - "$mutant" <<'NODE'
const fs=require('fs'), p=process.argv[2], s=fs.readFileSync(p,'utf8')
const start=s.indexOf('DO $init_guard$'), end=s.indexOf('$init_guard$;', start)
process.stdout.write(start<0||end<0 ? '' : s.slice(start,end))
NODE
)"
  if cmp -s "$mutant" "$reset_cmd"; then
    bad "init marker predicate mutation did not modify the file"
  elif grep -Fq "IF actual_marker IS DISTINCT FROM current_setting('org_fixture.expected_marker')" <<<"$mutant_init_guard"; then
    bad "init marker predicate mutation left the anchor beside the mutation"
  else
    ok "init marker predicate mutation destroys the anchor (landed, by cmp)"
  fi
  base_err="$TMP/reset-init-marker-baseline.err"
  RESET_SQL_LOG="$TMP/reset-init-marker-baseline.sql" RESET_EXEC_LOG="$TMP/reset-init-marker-baseline.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE=not-the-fixture-marker \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$mutant_baseline" --init >/dev/null 2>"$base_err"; base_rc=$?
  if [[ $base_rc -eq 9 ]] && [[ ! -s "$TMP/reset-init-marker-baseline.exec" ]]; then
    ok "unmutated init baseline refuses a wrong sentinel marker before the mutant runs"
  else
    bad "unmutated init baseline did not refuse a wrong sentinel marker; mutation control is untrustworthy"
  fi
  mutant_err="$TMP/reset-init-no-marker-predicate.err"
  RESET_SQL_LOG="$TMP/reset-init-no-marker-predicate.sql" RESET_EXEC_LOG="$TMP/reset-init-no-marker-predicate.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE=not-the-fixture-marker \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$mutant" --init >/dev/null 2>"$mutant_err"; mutant_rc=$?
  if [[ $mutant_rc -eq 9 ]] && grep -Fq "init safety term missing from write session: IF actual_marker IS DISTINCT FROM current_setting(" "$mutant_err"; then
    ok "test control rejects init without the marker predicate at the production safety seam"
  else
    bad "init-without-marker-predicate mutant did not fail at the expected safety seam"
  fi
else
  bad "init marker predicate mutation could not be constructed"
fi

mutant="$mutant_dir/reset-init-null-unsafe-marker.sh"
cp "$reset_cmd" "$mutant"
if node - "$mutant" <<'NODE'
const fs=require('fs'), p=process.argv[2], s=fs.readFileSync(p,'utf8')
const start=s.indexOf('DO $init_guard$'), end=s.indexOf('$init_guard$;', start)
if (start < 0 || end < 0) throw Error('init guard block anchor missing')
const before=s.slice(0,start), guard=s.slice(start,end), after=s.slice(end)
const old="IF actual_marker IS DISTINCT FROM current_setting('org_fixture.expected_marker') THEN"
if (!guard.includes(old)) throw Error('init marker predicate operator anchor missing')
fs.writeFileSync(p, before + guard.replace(old, "IF actual_marker <> current_setting('org_fixture.expected_marker') THEN") + after)
NODE
then
  chmod +x "$mutant"
  mutant_init_guard="$(node - "$mutant" <<'NODE'
const fs=require('fs'), p=process.argv[2], s=fs.readFileSync(p,'utf8')
const start=s.indexOf('DO $init_guard$'), end=s.indexOf('$init_guard$;', start)
process.stdout.write(start<0||end<0 ? '' : s.slice(start,end))
NODE
)"
  if cmp -s "$mutant" "$reset_cmd"; then
    bad "init marker operator mutation did not modify the file"
  elif grep -Fq "IF actual_marker IS DISTINCT FROM current_setting('org_fixture.expected_marker')" <<<"$mutant_init_guard"; then
    bad "init marker operator mutation left the NULL-safe anchor beside the mutation"
  else
    ok "init marker operator mutation destroys the NULL-safe anchor (landed, by cmp)"
  fi
  base_err="$TMP/reset-init-operator-baseline.err"
  RESET_SQL_LOG="$TMP/reset-init-operator-baseline.sql" RESET_EXEC_LOG="$TMP/reset-init-operator-baseline.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE=not-the-fixture-marker \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$mutant_baseline" --init >/dev/null 2>"$base_err"; base_rc=$?
  if [[ $base_rc -eq 9 ]] && [[ ! -s "$TMP/reset-init-operator-baseline.exec" ]]; then
    ok "unmutated init baseline refuses a wrong sentinel marker before the operator mutant runs"
  else
    bad "unmutated init baseline did not refuse a wrong sentinel marker; operator mutation control is untrustworthy"
  fi
  mutant_err="$TMP/reset-init-null-unsafe-marker.err"
  RESET_SQL_LOG="$TMP/reset-init-null-unsafe-marker.sql" RESET_EXEC_LOG="$TMP/reset-init-null-unsafe-marker.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE=not-the-fixture-marker \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$mutant" --init >/dev/null 2>"$mutant_err"; mutant_rc=$?
  if [[ $mutant_rc -eq 9 ]] && grep -Fq "init safety term missing from write session: IF actual_marker IS DISTINCT FROM current_setting(" "$mutant_err"; then
    ok "test control rejects a NULL-unsafe init marker comparison at the production safety seam"
  else
    bad "NULL-unsafe init marker mutant did not fail at the expected safety seam"
  fi
else
  bad "init marker operator mutation could not be constructed"
fi

decoy="$mutant_dir/reset-init-decoy-message.sh"
cp "$reset_cmd" "$decoy"
if node - "$decoy" <<'NODE'
const fs=require('fs'), p=process.argv[2], s=fs.readFileSync(p,'utf8')
const old="RAISE EXCEPTION 'will not initialize a sentinel over % existing public table(s)', public_table_count;"
if (!s.includes(old)) throw Error('decoy message anchor missing')
fs.writeFileSync(p, s.replace(old, "RAISE EXCEPTION 'refusing: % existing public table(s) present', public_table_count;"))
NODE
then
  chmod +x "$decoy"
  if cmp -s "$decoy" "$reset_cmd"; then
    bad "decoy init message mutation did not modify the file"
  else
    ok "decoy init message mutation landed (file differs from original, by cmp)"
  fi
  decoy_err="$TMP/reset-init-decoy.err"
  RESET_SQL_LOG="$TMP/reset-init-decoy.sql" RESET_EXEC_LOG="$TMP/reset-init-decoy.exec" \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$decoy" --init >/dev/null 2>"$decoy_err"; decoy_rc=$?
  if [[ $decoy_rc -eq 0 ]] && grep -q '^INIT backend=org_fixture$' "$TMP/reset-init-decoy.exec"; then
    ok "decoy mutation to an unrelated init message does not change a valid init's outcome"
  else
    bad "decoy mutation to an unrelated init message changed a valid init's outcome"
  fi
else
  bad "decoy init message mutation could not be constructed"
fi

# TOG-736 Mutant C: a RETURN placed AFTER the marker SELECT (but before the
# comparison) exits the reset_guard cleanly with validation skipped, and the
# destructive DROP outside the guard still runs. The prior structural check
# only scanned the guard text BEFORE the SELECT for a stray RETURN.
mutant="$mutant_dir/reset-return-after-marker-select.sh"
cp "$reset_cmd" "$mutant"
if node - "$mutant" <<'NODE'
const fs=require('fs'), p=process.argv[2], s=fs.readFileSync(p,'utf8')
const start=s.indexOf('DO $reset_guard$'), end=s.indexOf('$reset_guard$;', start)
if (start < 0 || end < 0) throw Error('reset guard block anchor missing')
const anchor='  SELECT marker INTO STRICT actual_marker FROM public.org_fixture_sentinel;\n'
const at=s.indexOf(anchor, start)
if (at < 0 || at > end) throw Error('reset marker select anchor missing')
const insertAt=at+anchor.length
fs.writeFileSync(p, s.slice(0, insertAt) + '  RETURN;\n' + s.slice(insertAt))
NODE
then
  chmod +x "$mutant"
  if cmp -s "$mutant" "$reset_cmd"; then
    bad "post-select RETURN mutation did not modify the file"
  else
    ok "post-select RETURN mutation landed (file differs from original, by cmp)"
  fi
  base_err="$TMP/reset-return-after-select-baseline.err"
  RESET_SQL_LOG="$TMP/reset-return-after-select-baseline.sql" RESET_EXEC_LOG="$TMP/reset-return-after-select-baseline.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE=not-the-fixture-marker \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$mutant_baseline" >/dev/null 2>"$base_err"; base_rc=$?
  if [[ $base_rc -eq 9 ]] && [[ ! -s "$TMP/reset-return-after-select-baseline.exec" ]]; then
    ok "unmutated reset baseline refuses a wrong sentinel marker before the mutant runs"
  else
    bad "unmutated reset baseline did not refuse a wrong sentinel marker; mutation control is untrustworthy"
  fi
  mutant_err="$TMP/reset-return-after-marker-select.err"
  RESET_SQL_LOG="$TMP/reset-return-after-marker-select.sql" RESET_EXEC_LOG="$TMP/reset-return-after-marker-select.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE=not-the-fixture-marker \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$mutant" >/dev/null 2>"$mutant_err"; mutant_rc=$?
  if [[ $mutant_rc -eq 9 ]] && grep -Fq 'reset guards do not precede all writes in one transaction' "$mutant_err"; then
    ok "test control rejects a post-select RETURN that bypasses marker validation"
  else
    bad "post-select-RETURN mutant did not fail at the expected safety seam"
  fi
else
  bad "post-select RETURN mutation could not be constructed"
fi

decoy="$mutant_dir/reset-decoy-comment.sh"
cp "$reset_cmd" "$decoy"
if node - "$decoy" <<'NODE'
const fs=require('fs'), p=process.argv[2], s=fs.readFileSync(p,'utf8')
const anchor='DO $reset_guard$\nDECLARE\n'
if (!s.includes(anchor)) throw Error('reset guard declare anchor missing')
fs.writeFileSync(p, s.replace(anchor, anchor + '  -- decoy: unrelated comment, must not affect outcome\n'))
NODE
then
  chmod +x "$decoy"
  if cmp -s "$decoy" "$reset_cmd"; then
    bad "decoy reset comment mutation did not modify the file"
  else
    ok "decoy reset comment mutation landed (file differs from original, by cmp)"
  fi
  decoy_err="$TMP/reset-decoy.err"
  RESET_SQL_LOG="$TMP/reset-decoy.sql" RESET_EXEC_LOG="$TMP/reset-decoy.exec" \
    RESET_SENTINEL_TABLE=org_fixture_sentinel RESET_SENTINEL_VALUE=paperclip-ops-tooling:TOG-480 \
    PATH="$TMP/reset-bin:$PATH" PGDATABASE=org_fixture "$decoy" >/dev/null 2>"$decoy_err"; decoy_rc=$?
  if [[ $decoy_rc -eq 0 ]] && grep -q '^WRITE backend=org_fixture$' "$TMP/reset-decoy.exec"; then
    ok "decoy comment inside the reset guard does not change a valid reset's outcome"
  else
    bad "decoy comment inside the reset guard changed a valid reset's outcome"
  fi
else
  bad "decoy reset comment mutation could not be constructed"
fi

schema_mutant="$TMP/schema-drift-no-typmod.sh"
cp "$HERE/schema_drift.sh" "$schema_mutant"
if node - "$schema_mutant" <<'NODE'
const fs=require('fs'), p=process.argv[2], s=fs.readFileSync(p,'utf8')
const old='pg_catalog.format_type(a.atttypid, a.atttypmod),'
if (!s.includes(old)) throw Error('schema type modifier mutation anchor missing')
fs.writeFileSync(p, s.replace(old, 'pg_catalog.format_type(a.atttypid, -1),'))
NODE
then
  if grep -Fq 'pg_catalog.format_type(a.atttypid, a.atttypmod)' "$schema_mutant"; then
    bad "type modifier mutation did not remove atttypmod"
  else
    ok "type modifier mutation removes atttypmod"
  fi
else
  bad "type modifier mutant could not be constructed"
fi
if grep -Fq "ALTER TABLE public.agents ALTER COLUMN created_at TYPE timestamp(3) with time zone" "$HERE/.github/workflows/ci.yml" \
  && grep -Fq './schema-drift-no-typmod.sh compare expected.fp' "$HERE/.github/workflows/ci.yml" \
  && grep -Fq "sha256sum < expected.fp | cut -d' ' -f1" "$HERE/.github/workflows/ci.yml" \
  && ! grep -Fq "node - <<'NODE'" "$HERE/.github/workflows/ci.yml"; then
  ok "CI executes the no-atttypmod mutant against a real type modifier change"
else
  bad "CI does not execute the type modifier extractor mutant"
fi

printf 'RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
