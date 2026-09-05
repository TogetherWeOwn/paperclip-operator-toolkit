#!/usr/bin/env bash
# ===========================================================================
# test_tog994_orphan_retire.sh — the REFUSALS in org_orphan_retire.sh
#
# This tool DELETES rows from principal_permission_grants and
# company_secret_bindings. The interesting assertions are therefore not "does it
# delete" but "does it refuse", and every refusal below is one that, if it broke
# silently, would take real rows with it.
#
# WHY A CAPTURE SHIM AND NOT A REAL DATABASE. The suite runs the tool with a
# lib/pcsql.sh replaced by a shim that RECORDS the SQL it is handed and answers
# only the two scalars that gate reaching the apply block. That gives two things
# a live database would not:
#
#   * it runs in CI and in an agent container, where neither pcsql backend
#     exists (see pg_source.js) — the alternative is a suite nobody runs;
#   * it can assert on the SQL TEXT, which is where the safety properties live.
#     "Every DELETE carries a terminated-agent predicate" is a statement about
#     the emitted statement, and checking it directly is stronger than inferring
#     it from a rowcount on one fixture.
#
# The shim is NOT a stand-in query engine, deliberately: MEMORY says a
# hand-written stand-in for a real client returns plausible wrong answers rather
# than errors. It answers nothing that any verdict here depends on. The
# behavioural half — that the transaction retires exactly the orphan rows and
# touches no live agent — was rehearsed against the live database under
# ROLLBACK and is recorded on TOG-994.
#
# §6 IS THE ASSERTION THAT CARRIES THE SUITE. A refusal test that never sees the
# tool proceed cannot tell a working guard from a tool that is broken and
# refuses everything. So §6 shows the SAME invocation reaching the write.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${ORG_ORPHAN_RETIRE_SH:-$HERE/org_orphan_retire.sh}"
CID="00000000-0000-4000-8000-00000000c1d0"
AGENT="00000000-0000-4000-8000-0000000a9e17"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -r "$TOOL" ]] || { echo "no readable org_orphan_retire.sh at $TOOL" >&2; exit 2; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/lib"
cp "$TOOL" "$WORK/org_orphan_retire.sh"

# The shim. It records SQL and answers ONLY the agent-count guard and the
# live-requester guard — the two scalars between the tool's start and its write.
cat > "$WORK/lib/pcsql.sh" <<'SHIM'
pcsql_backend() { echo psql; }
pcsql_required_bin() { echo cat; }
pcsql_preflight() { [[ "${SHIM_UNREACHABLE:-0}" != "1" ]]; }
pcsql_run() {
  local q; q="$(cat)"
  printf '%s\n-- ###SPLIT###\n' "$q" >> "$SHIM_LOG"
  case "$q" in
    *"count(*) FROM agents WHERE company_id"*) echo "${SHIM_AGENT_COUNT:-24}" ;;
    *"status <> 'terminated';"*)               echo "${SHIM_REQUESTER_OK:-1}" ;;
    *"SELECT count(DISTINCT"*)                 echo "0|0|0|0" ;;
    *)                                         echo "" ;;
  esac
}
SHIM

# Run the tool. Echoes its exit status; the SQL it emitted lands in $WORK/sql.
run() {
  : > "$WORK/sql"
  ( cd "$WORK" && SHIM_LOG="$WORK/sql" COMPANY_ID="$CID" GRANT_LOG="$WORK/grant-log.jsonl" \
      bash ./org_orphan_retire.sh "$@" ) >"$WORK/out" 2>"$WORK/err"
  echo $?
}
emitted() { cat "$WORK/sql"; }
wrote_sql() { grep -qE 'DELETE FROM|UPDATE company_memberships' "$WORK/sql"; }

hdr "1. The tool parses and refuses an unknown mode"
bash -n "$TOOL" 2>/dev/null && ok "org_orphan_retire.sh parses" || bad "does not parse"
rc="$(run frobnicate)"
[[ "$rc" != "0" ]] && ok "an unrecognised mode exits non-zero ($rc)" || bad "an unrecognised mode exited 0"

hdr "2. DRY RUN IS THE DEFAULT — plan emits no write"
rc="$(run plan)"
if [[ "$rc" == "0" ]]; then ok "plan exits 0"; else bad "plan exited $rc"; fi
if wrote_sql; then
  bad "PLAN EMITTED A WRITE — the dry-run default is broken"
else
  ok "plan emitted no DELETE and no UPDATE"
fi
grep -q 'PLAN ONLY' "$WORK/out" && ok "plan says so in its output" || bad "plan does not announce itself"

hdr "3. apply REFUSES without attribution (TOG-870)"
rc="$(run apply)"
[[ "$rc" != "0" ]] && ok "apply without --requested-by exits non-zero ($rc)" || bad "apply ran unattributed"
grep -q 'requested-by' "$WORK/err" && ok "the refusal names the missing flag" || bad "the refusal does not say what is missing"
wrote_sql && bad "it emitted a write anyway" || ok "no write was emitted"

rc="$(run apply --requested-by not-a-uuid)"
[[ "$rc" != "0" ]] && ok "a non-UUID --requested-by is refused" || bad "a non-UUID --requested-by was accepted"

hdr "4. The kill switch stops a write"
touch "$WORK/.provisioner-disabled"
rc="$(run apply --requested-by "$AGENT")"
[[ "$rc" != "0" ]] && ok ".provisioner-disabled refuses apply ($rc)" || bad "the kill switch did not stop apply"
wrote_sql && bad "a write was emitted with the kill switch engaged" || ok "no write emitted with kill switch engaged"
rm -f "$WORK/.provisioner-disabled"

rc="$(PROVISIONER_DISABLED=1 run apply --requested-by "$AGENT")"
[[ "$rc" != "0" ]] && ok "PROVISIONER_DISABLED=1 refuses apply" || bad "PROVISIONER_DISABLED=1 was ignored"

hdr "5. An unreachable or empty database is not 'nothing to retire'"
rc="$(SHIM_UNREACHABLE=1 run plan)"
[[ "$rc" == "3" ]] && ok "an unreachable backend exits 3, not 0" || bad "unreachable backend exited $rc (want 3)"

rc="$(SHIM_AGENT_COUNT=0 run plan)"
[[ "$rc" != "0" ]] && ok "a company with zero agents is refused, not swept ($rc)" || bad "an empty database was accepted"

# A requester the database does not confirm as live must stop the write. This is
# the guard that keeps a retirement from being attributed to a terminated agent.
rc="$(SHIM_REQUESTER_OK=0 run apply --requested-by "$AGENT")"
[[ "$rc" != "0" ]] && ok "a requester that is not a live agent is refused" || bad "a non-live requester was accepted"
wrote_sql && bad "it wrote for a non-live requester" || ok "no write emitted for a non-live requester"

hdr "6. Positive control — the same invocation DOES reach the write"
# Without this, every assertion above is satisfied by a tool that refuses
# unconditionally, and the suite would be measuring nothing.
rc="$(run apply --requested-by "$AGENT")"
if wrote_sql; then
  ok "a well-formed apply reaches the write — §3-§5 are refusing for their stated reasons"
else
  bad "a well-formed apply emitted no write; the refusal tests above prove nothing"
fi

hdr "7. Every destructive statement carries a terminated-agent predicate"
# The core safety property, asserted on the emitted text. Each DELETE/UPDATE
# clause must name status = 'terminated'.
txn="$(awk '/^BEGIN;/{f=1} f{print} /^COMMIT;/{exit}' "$WORK/sql")"
if [[ -z "$txn" ]]; then
  bad "no transaction was emitted — cannot check the predicates"
else
  ok "captured the apply transaction ($(wc -l <<<"$txn") lines)"

  n_stmt="$(grep -cE 'DELETE FROM|UPDATE company_memberships' <<<"$txn")"
  n_term="$(grep -c "a.status = 'terminated'" <<<"$txn")"
  [[ "$n_stmt" -eq 3 ]] && ok "all three kinds are present (2 DELETE + 1 UPDATE)" \
                        || bad "expected 3 destructive statements, found $n_stmt"
  [[ "$n_term" -ge "$n_stmt" ]] \
    && ok "every destructive statement carries status='terminated' ($n_term for $n_stmt)" \
    || bad "only $n_term terminated predicates for $n_stmt statements — one deletes unfiltered"

  # Rule 3: terminated must be asserted POSITIVELY. `NOT EXISTS (agent)` would
  # also remove the orphans, and would additionally remove every row whose agent
  # is merely invisible — a different and much larger set.
  grep -q "NOT EXISTS (SELECT 1 FROM agents" <<<"$txn" \
    && bad "a destructive statement matches on a MISSING agent row, not a terminated one" \
    || ok "no destructive statement fires on a merely-absent agent (safety rule 3)"

  # Rule 4: the company filter. Two companies share this database.
  n_cid="$(grep -cE "company_id = '$CID'|company_id = :" <<<"$txn")"
  [[ "$n_cid" -ge 3 ]] && ok "every statement is scoped to one company ($n_cid clauses)" \
                       || bad "only $n_cid company_id clauses — a statement is unscoped"

  # Rule 5: attribution rides in the same transaction, with an action that
  # grant_attribution.js actually recognises.
  grep -q 'INSERT INTO activity_log' <<<"$txn" \
    && ok "an activity_log row is written inside the transaction" \
    || bad "no attribution row in the transaction (TOG-870)"
  grep -q "'agent.permissions_updated'" <<<"$txn" \
    && ok "the attribution uses a recognised GRANT_ACTION" \
    || bad "the attribution action is not one grant_attribution.js reads"
fi

hdr "8. --kind confines the sweep to one table"
rc="$(run apply --requested-by "$AGENT" --kind bindings)"
txn="$(awk '/^BEGIN;/{f=1} f{print} /^COMMIT;/{exit}' "$WORK/sql")"
# The tool gates each statement on a literal flag comparison rather than by
# omitting it, so 'confined' means the other two are switched OFF, not absent.
if grep -qE "DELETE FROM company_secret_bindings" <<<"$txn" \
   && grep -A2 'DELETE FROM principal_permission_grants' <<<"$txn" | grep -q "'0' = '1'"; then
  ok "--kind bindings enables the binding delete and disables the grant delete"
else
  bad "--kind bindings did not confine the sweep"
fi
rc="$(run apply --requested-by "$AGENT" --kind nonsense)"
[[ "$rc" != "0" ]] && ok "an unknown --kind is refused" || bad "an unknown --kind was accepted"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
