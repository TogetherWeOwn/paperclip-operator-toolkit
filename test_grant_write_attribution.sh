#!/usr/bin/env bash
# ===========================================================================
# test_grant_write_attribution.sh — offline suite for org_provisioner.sh's
# grant WRITE path (TOG-870).
#
# THE DEFECT THIS GUARDS. `apply_exact_grants` used to write grants with a raw
# INSERT naming no grantor and emitting no activity_log row. Those 25 rows on
# this board are the only grants whose author cannot be recovered by ANY means:
# every other anonymous row is recoverable by joining activity_log on
# (entity_id, timestamp), and these have no such row to join to.
# scripts/grant_attribution.js MEASURES that gap; this suite stops the repo
# widening it.
#
# WHY THIS RUNS WITHOUT A DATABASE. The thing under test is what SQL the
# function emits and what it refuses to emit — answerable with a fake psql that
# records its stdin. A suite that needed the real provisioning database could
# only run on the production VPS, which is the same reason lib/pcsql.sh exists.
#
# THE FUNCTIONS ARE EXTRACTED FROM org_provisioner.sh, NEVER COPIED. This is
# the rule acceptance_org_lib.sh already follows for the ceiling catalog: a
# suite holding its own copy of the code keeps passing after the real one
# regresses, which is a false green with extra steps. §0 proves the extraction
# guard fires, because a suite that extracts nothing tests nothing and passes.
#
# EVERY ASSERTION HAS ONE LABEL, pass or fail. verification/tog-870-mutation-
# gate.sh identifies WHICH case reddened by name; a failure branch that prints
# a differently-worded label is unmatchable, and every mutation then reports
# "went red, but not on the case that covers it".
#
# WHAT IS DELIBERATELY NOT CLAIMED: that PostgreSQL accepts this SQL. That
# needs a real database (the remaining half of TOG-202). What IS claimed is
# that both attribution columns are present, that they carry the right two
# principals, and that the function REFUSES rather than writing an anonymous
# row — the three ways this specific defect comes back.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROV="$HERE/org_provisioner.sh"
PASS=0; FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS+1)); }
# No colour, and the case name follows "FAIL " immediately — see the header.
bad() { printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# chk <label> <why-it-would-matter> <command...>
# One label for both outcomes. The second argument is the diagnostic, printed
# only on failure, and is never part of the label the gate matches on.
chk() { local l=$1 why=$2; shift 2; if "$@"; then ok "$l"; else bad "$l" "$why"; fi; }

[ -f "$PROV" ] || { echo "FATAL: $PROV not found"; exit 2; }
command -v jq >/dev/null || { echo "FATAL: jq required"; exit 2; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# The fake psql. It records argv and stdin, and answers the ONE read query the
# function makes (the owner lookup) from a file the case controls, so the
# refusal branches are drivable.
cat >"$WORK/bin/psql" <<'FAKE'
#!/usr/bin/env bash
n=$(( $(cat "$REC/calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$REC/calls"
{ printf '%s\n' "$@"; } > "$REC/psql.$n.argv"
cat > "$REC/psql.$n.stdin"
# The owner lookup is the only SELECT; everything else is the write transaction.
if grep -q 'FROM company_memberships' "$REC/psql.$n.stdin"; then
  cat "$REC/owners" 2>/dev/null || true
fi
exit 0
FAKE
chmod +x "$WORK/bin/psql"
export PATH="$WORK/bin:$PATH"

# --- EXTRACT the functions under test, rather than restating them. ----------
# `die` is extracted too: the refusal assertions below are assertions about the
# real refusal path, and a locally-defined stand-in would test this file.
EXTRACT="$WORK/subject.sh"
{
  echo 'set -uo pipefail'
  sed -n '/^die() {/p' "$PROV"
  sed -n '/^PROVISIONER_OPERATOR_USER_ID=/,/^}/p' "$PROV"
  sed -n '/^apply_exact_grants() {/,/^}/p' "$PROV"
} > "$EXTRACT"
for fn in die resolve_operator_user_id apply_exact_grants; do
  grep -q "^$fn\(()\| *()\)" "$EXTRACT" \
    || { echo "FATAL: could not extract $fn from org_provisioner.sh — it moved or was renamed."; exit 2; }
done

COMPANY="00000000-0000-4000-8000-000000000000"
NEWAGENT="11111111-2222-3333-4444-555555555555"
CALLER="99999999-8888-7777-6666-555555555555"
OWNER="UsRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # synthetic board-user id, not this installation's
GRANTS='[{"permissionKey":"tasks:assign","scope":null},{"permissionKey":"agents:configure","scope":{"subtreeRootAgentId":"11111111-2222-3333-4444-555555555555"}}]'

# Drive the extracted function in a subshell with the psql backend selected.
# Each case gets a clean recording dir: libpq variables and the call counter are
# both sticky, and cross-talk between cases is how a dispatcher suite lies.
drive() { # drive <owners-file-contents> <args...>
  REC="$WORK/rec"; rm -rf "$REC"; mkdir -p "$REC"; export REC
  printf '%s' "$1" > "$REC/owners"; shift
  OUT="$( ( set +e
    export PAPERCLIP_SQL_BACKEND=psql DATABASE_URL='postgres://u:p@h/d'
    export COMPANY_ID="$COMPANY"
    . "$HERE/lib/pcsql.sh"
    pcsql() { pcsql_run -v ON_ERROR_STOP=1 "$@"; }
    . "$EXTRACT"
    apply_exact_grants "$@" ) 2>&1 )"
  CODE=$?
}
# The write transaction is the LAST psql call; the owner lookup is the first.
calls()    { cat "$REC/calls" 2>/dev/null || echo 0; }
write_sql() { local n; n="$(calls)"; [ "$n" -gt 0 ] && cat "$REC/psql.$n.stdin"; }
wrote()     { [ "$(calls)" -ge 2 ]; }
no_write()  { ! wrote; }
refused()   { [ "$CODE" != "0" ] && grep -q 'REFUSED' <<<"$OUT"; }
in_sql()    { grep -qE "$1" <<<"$SQL"; }
bound()     { grep -qx "$1" "$REC/psql.$(calls).argv"; }

hdr "1. the grant INSERT carries granted_by_user_id"
# The column that was missing. Its absence is why 25 rows name nobody.
drive "$OWNER" "$NEWAGENT" "$GRANTS" "$CALLER"
chk "the write path succeeds" "exit $CODE: $(printf '%s' "$OUT" | tail -2)" \
  test "$CODE" = "0"
SQL="$(write_sql)"
chk "the grants INSERT names the granted_by_user_id column" \
  "the INSERT column list omits it — every new grant would be anonymous again" \
  in_sql 'INSERT INTO principal_permission_grants \(.*granted_by_user_id\)'

hdr "2. the operator id reaches psql as a bound variable, not inlined"
# Values ride as -v bindings, never spliced into the SQL text. This is the
# repo's standing rule and it is also what stops a quoting bug becoming an
# injection.
chk "the operator user id is bound as :a" \
  "argv: $(tr '\n' ' ' < "$REC/psql.$(calls).argv")" bound "a=$OWNER"
chk "the requesting agent is bound as :b" \
  "argv: $(tr '\n' ' ' < "$REC/psql.$(calls).argv")" bound "b=$CALLER"

hdr "3. an activity_log row is written — the ONLY recoverable attribution"
# granted_by_user_id is user-typed and cannot name an agent. Without this row an
# agent-initiated grant is anonymous forever, which is the exact 25-row defect.
#
# The table name is ANCHORED. A bare substring match is satisfied by
# `activity_log_archive` or any other table starting the same way, so it would
# keep passing while the rows went somewhere the attribution join never reads.
chk "an activity_log row accompanies the grants" \
  "the 25 unrecoverable rows come from exactly this omission" \
  in_sql 'INSERT INTO activity_log[[:space:]]*$'
# The action string must stay one scripts/grant_attribution.js reads as
# grant-bearing, or these rows are invisible to the audit that measures them.
chk "...with an action the attribution join recognises" \
  "grant_attribution.js would not see these rows at all" \
  in_sql "'agent\.permissions_updated'"
chk "...and the reader still lists that action" \
  "writer and reader have diverged; the rows are written and never read" \
  grep -q '"agent\.permissions_updated"' "$HERE/scripts/grant_attribution.js"

hdr "4. both principals are recorded, and they are DIFFERENT columns"
# Who ran it (a human operator) and who asked for it (an agent) are two facts.
# Collapsing them loses the one the charter's separation-of-duties metric reads.
chk "the activity actor is the REQUESTING agent" \
  "the actor column does not carry :b" in_sql "'agent', :'b'"
chk "the activity entity is the RECEIVING agent (the join key)" \
  "the attribution join keys on entity_id; a wrong entity is an invisible row" \
  in_sql "'agent', :'agent_id'"
chk "the operator is recorded as responsible_user_id" \
  "the human who ran the command is not on the activity row" \
  in_sql 'responsible_user_id'

hdr "5. attribution commits WITH the grants, never separately"
# A grant that commits without its attribution is the defect. One transaction.
#
# The extraction takes the FIRST BEGIN..COMMIT block only. `sed -n
# '/^BEGIN;/,/^COMMIT;/p'` would not do: sed RESTARTS the range at the next
# BEGIN, so splitting this into two transactions still yields both INSERTs in
# the captured text and the assertion passes on the mutated code.
BODY="$(awk '/^BEGIN;/{inb=1} inb{print} /^COMMIT;/{if(inb) exit}' <<<"$SQL")"
chk "the write is a single transaction" \
  "found $(grep -c '^COMMIT;' <<<"$SQL") COMMIT statements, wanted exactly 1" \
  test "$(grep -c '^COMMIT;' <<<"$SQL")" = "1"
in_body() { grep -qE "$1" <<<"$BODY"; }
chk "grants and activity_log are inside the same BEGIN/COMMIT" \
  "a partial failure would commit the grant and lose its attribution" \
  bash -c 'grep -q "INSERT INTO principal_permission_grants" <<<"$1" &&
           grep -qE "INSERT INTO activity_log[[:space:]]*$" <<<"$1"' _ "$BODY"

hdr "6. THE REFUSALS: an anonymous write is refused, not defaulted"
# A default requesting-agent would silently restore anonymous rows the first
# time a new call site forgot the argument — precisely how the original 25 were
# written. The refusal must come BEFORE any write.
drive "$OWNER" "$NEWAGENT" "$GRANTS"
chk "a missing requesting agent -> REFUSED" \
  "exit $CODE, output: $(printf '%s' "$OUT" | tail -2)" refused
chk "...and no write transaction reached the database" \
  "a write still reached psql, so an unattributed grant was written" no_write

hdr "7. an unresolvable operator refuses rather than guessing a human"
# Attributing a grant to the WRONG person is worse than the null being removed.
drive "" "$NEWAGENT" "$GRANTS" "$CALLER"
chk "zero owners -> REFUSED, no grant written" \
  "exit $CODE, output: $(printf '%s' "$OUT" | tail -2)" refused
chk "...and no write transaction was issued" "psql got a second call" no_write
# Two owners is the ambiguous case: picking either would be a coin flip.
drive "$OWNER
SECONDOWNERaaaaaaaaaaaaaaaaaaaaaaaa" "$NEWAGENT" "$GRANTS" "$CALLER"
chk "two owners -> REFUSED rather than picking one" \
  "exit $CODE, output: $(printf '%s' "$OUT" | tail -2)" refused

hdr "8. the explicit operator seam overrides the lookup"
# An operator running as somebody other than the sole owner must be able to say
# so — and must not be forced through the owner heuristic. Note the owners file
# is EMPTY here: the seam has to work where the lookup would refuse.
REC="$WORK/rec2"; rm -rf "$REC"; mkdir -p "$REC"; export REC
printf '' > "$REC/owners"
OUT="$( ( set +e
  export PAPERCLIP_SQL_BACKEND=psql DATABASE_URL='postgres://u:p@h/d'
  export COMPANY_ID="$COMPANY" PROVISIONER_OPERATOR_USER_ID="EXPLICITOPERATOR"
  . "$HERE/lib/pcsql.sh"
  pcsql() { pcsql_run -v ON_ERROR_STOP=1 "$@"; }
  . "$EXTRACT"
  apply_exact_grants "$NEWAGENT" "$GRANTS" "$CALLER" ) 2>&1 )"
CODE=$?
chk "PROVISIONER_OPERATOR_USER_ID is honoured with no owner row at all" \
  "exit $CODE: $(printf '%s' "$OUT" | tail -2)" test "$CODE" = "0"
chk "...and it skips the owner lookup entirely (1 psql call, the write)" \
  "psql was called $(calls) times, wanted 1" test "$(calls)" = "1"
chk "...and that id is what gets written" \
  "argv: $(tr '\n' ' ' < "$REC/psql.$(calls).argv")" bound "a=EXPLICITOPERATOR"

hdr "9. both real call sites pass a requesting agent"
# The refusal in §6 turns a forgotten argument into a hard failure at run time.
# This turns it into a failure HERE, before anyone runs the provisioner.
chk "found at least 2 apply_exact_grants call sites" \
  "found $(grep -c 'apply_exact_grants "' "$PROV") — the function moved or a caller was dropped" \
  test "$(grep -c 'apply_exact_grants "' "$PROV")" -ge 2
chk "no call site passes only two arguments" \
  "$(grep -o 'apply_exact_grants "[^"]*" [^ ]*$' "$PROV" || true)" \
  bash -c '[ -z "$(grep -o "apply_exact_grants \"[^\"]*\" [^ ]*$" "$1" || true)" ]' _ "$PROV"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
