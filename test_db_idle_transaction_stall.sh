#!/usr/bin/env bash
# Offline regression suite for db_idle_transaction_stall.js. The fake `pg`
# module controls the aggregate row or query failure; no database is contacted.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${DB_IDLE_TRANSACTION_STALL_JS:-$HERE/db_idle_transaction_stall.js}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }

[[ -x "$TOOL" ]] || { echo "ERROR: $TOOL is not executable" >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_db_idle_transaction_stall.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/node_modules/pg"

cat > "$WORK/node_modules/pg/index.js" <<'JS'
'use strict';
class Client {
  async connect() {
    if (process.env.FAKE_CONNECT_ERROR) {
      const error = new Error(process.env.FAKE_CONNECT_ERROR);
      error.code = 'ECONNREFUSED';
      throw error;
    }
  }
  async query(sql, params) {
    process.stderr.write(`QUERY=${sql}\nPARAM=${JSON.stringify(params)}\n`);
    if (process.env.FAKE_QUERY_ERROR) {
      const error = new Error(process.env.FAKE_QUERY_ERROR);
      error.code = '42501';
      throw error;
    }
    return { rows: [JSON.parse(process.env.FAKE_ROW)] };
  }
  async end() {}
}
module.exports = { Client };
JS

run_case() {
  env -i PATH="$PATH" HOME="$WORK" NODE_PATH="$WORK/node_modules" \
    DATABASE_URL="postgresql://monitor.invalid/db" \
    FAKE_ROW="${FAKE_ROW:-}" \
    FAKE_CONNECT_ERROR="${FAKE_CONNECT_ERROR:-}" \
    FAKE_QUERY_ERROR="${FAKE_QUERY_ERROR:-}" \
    "$TOOL" "$@" > "$WORK/out" 2> "$WORK/err"
  RC=$?
  OUT="$(cat "$WORK/out")"
  ERR="$(cat "$WORK/err")"
}

printf '\n\033[1m1. Clean aggregate is exit 0\033[0m\n'
FAKE_ROW='{"total_connections":10,"idle_connections":2,"idle_in_transaction":0,"stale_idle_in_transaction":0,"oldest_stale_minutes":0,"max_connections":100}' run_case --json
(( RC == 0 )) && ok "no stale transaction is exit 0" || bad "expected exit 0, got $RC"
printf '%s' "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["verdict"]=="ok" and d["measured"] is True and d["staleIdleInTransaction"]==0' \
  && ok "clean JSON is measured and carries zero" || bad "clean JSON contract failed: $OUT"

printf '\n\033[1m2. Stale idle transactions are exit 1\033[0m\n'
FAKE_ROW='{"total_connections":26,"idle_connections":16,"idle_in_transaction":10,"stale_idle_in_transaction":10,"oldest_stale_minutes":21,"max_connections":100}' run_case --json
(( RC == 1 )) && ok "ten stale transactions are exit 1" || bad "expected exit 1, got $RC"
printf '%s' "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["verdict"]=="stall" and d["staleIdleInTransaction"]==10 and d["oldestStaleMinutes"]==21 and d["maxConnections"]==100' \
  && ok "stall JSON preserves count, age, and capacity" || bad "stall JSON contract failed: $OUT"
grep -q 'more than 5 minutes' <<<"$OUT" \
  && ok "reason names the five-minute threshold" || bad "threshold missing from reason"

printf '\n\033[1m3. The threshold is parameterized in SQL\033[0m\n'
FAKE_ROW='{"total_connections":1,"idle_connections":0,"idle_in_transaction":0,"stale_idle_in_transaction":0,"oldest_stale_minutes":0,"max_connections":100}' run_case --max-age-minutes 7 --json
grep -q 'PARAM=\[7\]' <<<"$ERR" \
  && ok "passes 7 as a query parameter" || bad "threshold was not parameterized: $ERR"
grep -q 'pg_backend_pid' <<<"$ERR" \
  && ok "excludes the detector's own connection" || bad "self-connection exclusion missing"

printf '\n\033[1m4. Query failures are inconclusive, never clean\033[0m\n'
FAKE_QUERY_ERROR='permission denied' run_case --json
(( RC == 2 )) && ok "query failure is exit 2" || bad "expected exit 2, got $RC"
printf '%s' "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["verdict"]=="inconclusive" and d["measured"] is False and d["exitCode"]==2' \
  && ok "query failure reports unmeasured" || bad "query failure JSON contract failed: $OUT"

printf '\n\033[1m5. Missing credentials are inconclusive\033[0m\n'
env -i PATH="$PATH" HOME="$WORK" NODE_PATH="$WORK/node_modules" "$TOOL" --json > "$WORK/out" 2> "$WORK/err"; RC=$?
(( RC == 2 )) && ok "missing DATABASE_URL is exit 2" || bad "expected exit 2, got $RC"
grep -q 'DATABASE_URL is not set' "$WORK/out" \
  && ok "names the missing capability" || bad "missing credential reason absent"

printf '\n\033[1m6. Bad arguments refuse instead of guessing\033[0m\n'
run_case --max-age-minutes 0
(( RC == 2 )) && ok "rejects a zero threshold" || bad "accepted zero threshold"
run_case --unknown
(( RC == 2 )) && ok "rejects an unknown flag" || bad "accepted unknown flag"

printf '\n\033[1mTOTAL\033[0m  %d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
