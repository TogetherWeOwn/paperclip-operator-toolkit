#!/usr/bin/env bash
# Hermetic tests for blocked_audit.sh. No network: curl is stubbed on PATH.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/blocked_audit.sh"
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "  ok   - $1"; }
no(){ fail=$((fail+1)); echo "  FAIL - $1"; }

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/bin"

# ---- curl stub ---------------------------------------------------------------
# Serves canned issue/agent lists; records every write to $STAGE/writes.log.
cat > "$STAGE/bin/curl" <<'STUB'
#!/usr/bin/env bash
method=GET; url=""; out=""; wfmt=""; data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) shift; method="$1" ;;
    -o) shift; out="$1" ;;
    -w) shift; wfmt="$1" ;;
    -d) shift; data="$1" ;;
    -H|--header|--config) shift ;;
    -s) ;;
    http*|https*) url="$1" ;;
  esac
  shift
done
# Emulate curl faithfully: body goes to -o (or stdout), then -w is printed
# VERBATIM with substitutions. Getting this wrong is what makes a stub pass a
# test that the real binary would fail.
emit(){ if [ -n "$out" ]; then printf '%s' "$1" > "$out"; else printf '%s' "$1"; fi
        if [ -n "$wfmt" ]; then printf '%b' "${wfmt//%\{http_code\}/200}"; fi; }
if [ "$method" = PATCH ]; then
  echo "$url|$data" >> "$STAGE_DIR/writes.log"
  emit '{"id":"x","status":"blocked"}'; exit 0
fi
case "$url" in
  *"/agents") emit "$(cat "$STAGE_DIR/agents.json")" ;;
  *"/issues")  emit "$(cat "$STAGE_DIR/issues.json")" ;;
  *) emit '{}' ;;
esac
STUB
chmod +x "$STAGE/bin/curl"

cat > "$STAGE/agents.json" <<'J'
[{"id":"aaaaaaaa-1111-1111-1111-111111111111","name":"Alpha"},
 {"id":"bbbbbbbb-2222-2222-2222-222222222222","name":"Beta"},
 {"id":"abababab-3333-3333-3333-333333333333","name":"Ambiguous1"},
 {"id":"abababab-4444-4444-4444-444444444444","name":"Ambiguous2"}]
J
cat > "$STAGE/issues.json" <<'J'
[{"id":"i1","identifier":"TOG-1","status":"blocked","assigneeAgentId":null,"assigneeUserId":null},
 {"id":"i2","identifier":"TOG-2","status":"blocked","assigneeAgentId":"aaaaaaaa-1111-1111-1111-111111111111","assigneeUserId":null}]
J

export STAGE_DIR="$STAGE"
export PATH="$STAGE/bin:$PATH"
export PAPERCLIP_API_KEY=k PAPERCLIP_API_URL=https://example.invalid PAPERCLIP_COMPANY_ID=c
unset PAPERCLIP_RUN_ID

run(){ : > "$STAGE/writes.log"; bash "$SUT" --table "$1" "${@:2}" 2>&1; }

# 0. a snapshot must be deliberately supplied; there is no stale default.
o=$(bash "$SUT" --status 2>&1); rc=$?
[ $rc -eq 2 ] && grep -q -- "--table PATH" <<<"$o" && ok "guard: explicit audit table is required" \
  || no "guard: missing table exited $rc: $o"

# 1. baseline: an applicable row is APPLIED and writes exactly once (assign only)
cat > "$STAGE/t1.json" <<'J'
{"dispositions":[{"key":"TOG-1","verdict":"KEEP_BLOCKED","assignee":"aaaaaaaa","source":{"status":"blocked","assigneeAgentId":null,"assigneeUserId":null}}]}
J
o=$(run "$STAGE/t1.json" --apply); rc=$?
[ $rc -eq 0 ] && grep -q "APPLIED  TOG-1" <<<"$o" && ok "baseline: pending row applies" || no "baseline: pending row applies ($rc) $o"
[ "$(wc -l < "$STAGE/writes.log")" = "1" ] && ok "baseline: exactly one write for assign-only" \
  || no "baseline: expected 1 write, got $(wc -l < "$STAGE/writes.log")"

# 2. idempotence: a row already in its target state is skipped and writes NOTHING
cat > "$STAGE/t2.json" <<'J'
{"dispositions":[{"key":"TOG-2","verdict":"KEEP_BLOCKED","assignee":"aaaaaaaa","source":{"status":"blocked","assigneeAgentId":"aaaaaaaa-1111-1111-1111-111111111111","assigneeUserId":null}}]}
J
o=$(run "$STAGE/t2.json" --apply)
grep -q "^OK       TOG-2" <<<"$o" && [ ! -s "$STAGE/writes.log" ] \
  && ok "idempotence: already-correct row writes nothing" || no "idempotence failed: $o"

# 3. --status must never write
o=$(run "$STAGE/t1.json" --status)
grep -q "PENDING  TOG-1" <<<"$o" && [ ! -s "$STAGE/writes.log" ] \
  && ok "--status writes nothing" || no "--status wrote something or missed the row"

# 4. done:true rows are never considered
cat > "$STAGE/t4.json" <<'J'
{"dispositions":[{"key":"TOG-1","verdict":"KEEP_BLOCKED","assignee":"aaaaaaaa","source":{"status":"blocked","assigneeAgentId":null,"assigneeUserId":null},"done":true}]}
J
o=$(run "$STAGE/t4.json" --apply); rc=$?
[ $rc -eq 5 ] && [ ! -s "$STAGE/writes.log" ] && ok "done:true row is skipped and guard fires" \
  || no "done:true not skipped (rc=$rc)"

# 5. zero-measurement guard: empty table exits 5, not 0
echo '{"dispositions":[]}' > "$STAGE/t5.json"
o=$(run "$STAGE/t5.json" --status); rc=$?
[ $rc -eq 5 ] && ok "guard: empty table exits 5" || no "guard: empty table exited $rc"

# 6. unknown issue key is reported MISSING, never silently counted as success
cat > "$STAGE/t6.json" <<'J'
{"dispositions":[{"key":"TOG-999","verdict":"KEEP_BLOCKED","assignee":"aaaaaaaa","source":{"status":"blocked","assigneeAgentId":null,"assigneeUserId":null}}]}
J
o=$(run "$STAGE/t6.json" --apply); rc=$?
grep -q "MISSING  TOG-999" <<<"$o" && [ $rc -eq 1 ] \
  && ok "unknown key -> MISSING + failure" || no "unknown key mishandled (rc=$rc): $o"

# 7. an ambiguous agent prefix must FAIL, never bind the wrong agent
cat > "$STAGE/t7.json" <<'J'
{"dispositions":[{"key":"TOG-1","verdict":"KEEP_BLOCKED","assignee":"abababab","source":{"status":"blocked","assigneeAgentId":null,"assigneeUserId":null}}]}
J
o=$(run "$STAGE/t7.json" --apply); rc=$?
grep -q "did not resolve to exactly one agent" <<<"$o" && [ ! -s "$STAGE/writes.log" ] && [ $rc -eq 1 ] \
  && ok "ambiguous agent prefix refuses to write" || no "ambiguous prefix not refused (rc=$rc): $o"

# 8. moved source state is stale evidence and must never write.
cat > "$STAGE/t8.json" <<'J'
{"dispositions":[{"key":"TOG-1","verdict":"KEEP_BLOCKED","assignee":"aaaaaaaa","source":{"status":"todo","assigneeAgentId":null,"assigneeUserId":null}}]}
J
o=$(run "$STAGE/t8.json" --apply); rc=$?
grep -q "^STALE    TOG-1" <<<"$o" && [ ! -s "$STAGE/writes.log" ] && [ $rc -eq 1 ] \
  && ok "stale source state refuses to write" || no "stale source state not refused (rc=$rc): $o"

# 9. missing source precondition must never write.
cat > "$STAGE/t9.json" <<'J'
{"dispositions":[{"key":"TOG-1","verdict":"KEEP_BLOCKED","assignee":"aaaaaaaa"}]}
J
o=$(run "$STAGE/t9.json" --apply); rc=$?
grep -q "audited source status, assigneeAgentId, and assigneeUserId are required" <<<"$o" && [ ! -s "$STAGE/writes.log" ] && [ $rc -eq 1 ] \
  && ok "missing source precondition refuses to write" || no "missing source precondition not refused (rc=$rc): $o"

# 10. an unknown verdict is a table error, not a silently skipped row.
cat > "$STAGE/t10.json" <<'J'
{"dispositions":[{"key":"TOG-1","verdict":"KEEP_BLOKED","assignee":"aaaaaaaa","source":{"status":"blocked","assigneeAgentId":null,"assigneeUserId":null}}]}
J
o=$(run "$STAGE/t10.json" --apply); rc=$?
grep -q "unknown verdict 'KEEP_BLOKED'" <<<"$o" && [ ! -s "$STAGE/writes.log" ] && [ $rc -eq 1 ] \
  && ok "unknown verdict refuses to write" || no "unknown verdict not refused (rc=$rc): $o"

# 11. a third-party source assignee is stale evidence. The intended target is
# accepted separately as valid partial/complete progress.
cat > "$STAGE/t11.json" <<'J'
{"dispositions":[{"key":"TOG-2","verdict":"KEEP_BLOCKED","assignee":"bbbbbbbb","source":{"status":"blocked","assigneeAgentId":"cccccccc-5555-5555-5555-555555555555","assigneeUserId":null}}]}
J
o=$(run "$STAGE/t11.json" --apply); rc=$?
grep -q "^STALE    TOG-2" <<<"$o" && [ ! -s "$STAGE/writes.log" ] && [ $rc -eq 1 ] \
  && ok "stale source assignee refuses to write" || no "stale source assignee not refused (rc=$rc): $o"

# 12. a malformed trailing row prevents every write, including earlier valid rows.
cat > "$STAGE/t12.json" <<'J'
{"dispositions":[{"key":"TOG-1","verdict":"KEEP_BLOCKED","assignee":"aaaaaaaa","source":{"status":"blocked","assigneeAgentId":null,"assigneeUserId":null}},
                 {"key":"TOG-2","verdict":"KEEP_BLOKED","assignee":"bbbbbbbb","source":{"status":"blocked","assigneeAgentId":"aaaaaaaa-1111-1111-1111-111111111111","assigneeUserId":null}}]}
J
o=$(run "$STAGE/t12.json" --apply); rc=$?
grep -q "unknown verdict 'KEEP_BLOKED'" <<<"$o" && [ ! -s "$STAGE/writes.log" ] && [ $rc -eq 1 ] \
  && ok "whole table validates before writes" || no "validation allowed a partial write (rc=$rc): $o"

# 13. missing keys are table errors, not silently skipped rows.
cat > "$STAGE/t13.json" <<'J'
{"dispositions":[{"verdict":"KEEP_BLOCKED","assignee":"aaaaaaaa","source":{"status":"blocked","assigneeAgentId":null,"assigneeUserId":null}}]}
J
o=$(run "$STAGE/t13.json" --apply); rc=$?
grep -q "key is required" <<<"$o" && [ ! -s "$STAGE/writes.log" ] && [ $rc -eq 1 ] \
  && ok "missing key refuses to write" || no "missing key not refused (rc=$rc): $o"

# 14. a newly assigned human is a newer disposition and must never be overwritten.
cp "$STAGE/issues.json" "$STAGE/issues.saved.json"
jq 'map(if .identifier=="TOG-1" then .assigneeUserId="user-1111" else . end)' \
  "$STAGE/issues.saved.json" > "$STAGE/issues.json"
o=$(run "$STAGE/t1.json" --apply); rc=$?
grep -q "^STALE    TOG-1" <<<"$o" && [ ! -s "$STAGE/writes.log" ] && [ $rc -eq 1 ] \
  && ok "human assignee change refuses to write" || no "human assignee was overwritten (rc=$rc): $o"
mv "$STAGE/issues.saved.json" "$STAGE/issues.json"

# 15. every array element must be an object before any request is made.
cat > "$STAGE/t15.json" <<'J'
{"dispositions":[{"key":"TOG-1","verdict":"KEEP_BLOCKED","assignee":"aaaaaaaa","source":{"status":"blocked","assigneeAgentId":null,"assigneeUserId":null}},7]}
J
o=$(run "$STAGE/t15.json" --apply); rc=$?
grep -q "disposition objects with boolean done fields" <<<"$o" && [ ! -s "$STAGE/writes.log" ] && [ $rc -eq 2 ] \
  && ok "scalar disposition refuses before writes" || no "scalar disposition allowed a write (rc=$rc): $o"

# 16. done must be a literal boolean; string lookalikes cannot replay a row.
cat > "$STAGE/t16.json" <<'J'
{"dispositions":[{"key":"TOG-1","verdict":"KEEP_BLOCKED","assignee":"aaaaaaaa","source":{"status":"blocked","assigneeAgentId":null,"assigneeUserId":null},"done":"true"}]}
J
o=$(run "$STAGE/t16.json" --apply); rc=$?
grep -q "boolean done fields" <<<"$o" && [ ! -s "$STAGE/writes.log" ] && [ $rc -eq 2 ] \
  && ok "non-boolean done refuses before writes" || no "non-boolean done allowed a write (rc=$rc): $o"

# 17. assignee prefixes must be the audited 8-character lowercase hex form.
cat > "$STAGE/t17.json" <<'J'
{"dispositions":[{"key":"TOG-1","verdict":"KEEP_BLOCKED","assignee":"a","source":{"status":"blocked","assigneeAgentId":null,"assigneeUserId":null}}]}
J
o=$(run "$STAGE/t17.json" --apply); rc=$?
grep -q "8-character lowercase hex prefix" <<<"$o" && [ ! -s "$STAGE/writes.log" ] && [ $rc -eq 1 ] \
  && ok "short agent prefix refuses before writes" || no "short agent prefix allowed a write (rc=$rc): $o"

# 18. --max is a hard ceiling: 2 assign-only rows with --max 1 writes once and stops
cat > "$STAGE/t18.json" <<'J'
{"dispositions":[{"key":"TOG-1","verdict":"KEEP_BLOCKED","assignee":"aaaaaaaa","source":{"status":"blocked","assigneeAgentId":null,"assigneeUserId":null}},
                 {"key":"TOG-2","verdict":"KEEP_BLOCKED","assignee":"bbbbbbbb","source":{"status":"blocked","assigneeAgentId":"aaaaaaaa-1111-1111-1111-111111111111","assigneeUserId":null}}]}
J
o=$(run "$STAGE/t18.json" --apply --max 1)
[ "$(wc -l < "$STAGE/writes.log")" = "1" ] && grep -q "STOP     write budget" <<<"$o" \
  && ok "--max caps writes and reports the stop" \
  || no "--max ceiling breached: wrote $(wc -l < "$STAGE/writes.log")"

echo; echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
[ "$pass" -ge 20 ] || { echo "ERROR: fewer assertions ran than expected" >&2; exit 5; }
exit 0
