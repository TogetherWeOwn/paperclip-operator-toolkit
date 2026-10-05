#!/usr/bin/env bash
# Regression suite for the approval-gated org provisioning request queue.
# Validates separation of duties, closed-set review authority, the distinct
# request ceiling, template disablement, and stale-request (TOCTOU) defence.
#
# Uses its own queue file; the shared grant log stays authoritative.
# Any agent it provisions is torn down at the end.
#
# THIS SUITE NEEDS A COMPANY-SHAPED POSTGRES DATABASE and is not a purely
# offline unit test: org_provisioner.sh has no ORG_SNAPSHOT path, and sections
# 7/9/10 read SQL directly. CI supplies a throwaway schema/org fixture plus a
# dumb recording CLI; a run against the production host remains necessary for
# the real Paperclip API contract. The two guards below still ensure an
# unavailable database never scores itself green.
#
# WHY A REFUSAL IS NOT ENOUGH TO PASS A CASE. The old helper was
#
#   must_refuse() { ... if [[ $rc -ne 0 ]] && grep -q REFUSED <<<"$o"; then ok
#
# which accepts ANY refusal. Run with no database reachable and resolve_agent
# returns empty, so cmd_submit dies at org_request_queue.sh:860
# ("requester not found") — BEFORE the ceiling check at :870 that the case
# claims to test. The refusal is real; the gate under test never ran. Measured
# in an agent container with COMPANY_ID set and no podman: 15 of 31 assertions
# went green against no database at all, including section 10's "no TESTQ
# agents remain active", which is an ABSENCE claim and so the worst of them.
# Same class as the vacuous mutation gates and the neighbouring-gate
# problem: a fail-closed default upstream satisfies an assertion that
# names something downstream.
#
# Two guards, and both are needed — neither subsumes the other:
#   1. pcsql_preflight below: a suite that cannot reach its subject exits 3
#      instead of scoring itself. Catches the whole-run case.
#   2. refuses_because <desc> <reason> <cmd...>: pins each case to ITS OWN
#      gate's words, so a refusal from a different gate is a FAIL. Catches the
#      single-case case, including a backend that dies mid-run, and survives a
#      future section that is entirely refusals. Borrowed unchanged from
#      test_capability_gate.sh:41, which already solved this.
# And qnum() for scalar reads, because bash scores an empty string as 0, so
# `[[ "$(q 'SELECT count(*)...')" -eq 0 ]]` reads a query that never ran as a
# clean result. A check that measured nothing must not read green.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export COMPANY_ID="${COMPANY_ID:?Set COMPANY_ID}"
export QUEUE="$HERE/.test-request-queue.jsonl"
export DISABLED_TEMPLATES="$HERE/.test-disabled-templates"
Q="$HERE/org_request_queue.sh"
PROV="$HERE/org_provisioner.sh"
rm -f "$QUEUE" "$DISABLED_TEMPLATES"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# refuses_because <desc> <reason-substring> <cmd...>
# A refusal from the WRONG gate is a FAIL, not a pass. <reason-substring> is a
# fragment of the message the gate under test emits itself; keep it to the
# distinguishing clause, not the whole sentence, so ordinary rewording of the
# surrounding text does not go red.
refuses_because() {
  local d="$1" why="$2"; shift 2
  local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then bad "$d — was ALLOWED (rc=0)"; return; fi
  if ! grep -q REFUSED <<<"$o"; then bad "$d — non-zero but not a refusal (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -3; return; fi
  if grep -qF -- "$why" <<<"$o"; then ok "$d"
  else bad "$d — refused by the WRONG gate; wanted '$why'"; sed 's/^/        /' <<<"$o" | head -4; fi
}
must_allow()  { local d="$1"; shift; local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then ok "$d"; else bad "$d (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -4; fi; }

# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; exit 1; }

# PRECONDITION. Before any assertion runs, prove the subject is reachable.
# Exit 3 (not 1) so a caller can tell "could not run" from "ran and failed".
if ! pcsql_preflight; then
  cat >&2 <<EOF

ERROR: test_request_queue.sh cannot reach the company database, so it did not run.

  This suite exercises org_request_queue.sh and org_provisioner.sh against live
  company state; there is no offline seam for it. Running anyway would report
  refusals produced by "requester not found" as if they were ceiling
  enforcement. See the header.

  Backend selection: PAPERCLIP_SQL_BACKEND=${PAPERCLIP_SQL_BACKEND:-podman} (podman|docker|psql)
    podman: needs podman on PATH and container \${PAPERCLIP_DB_CTR:-paperclip-db} running
    docker: needs docker on PATH and container \${PAPERCLIP_DB_CTR:-paperclip-db} running (for hosts without podman)
    psql:   needs psql on PATH and DATABASE_URL or libpq PG* variables
  CONTAINER_ENGINE overrides the binary the container backends invoke.
EOF
  exit 3
fi

q() { PGV_COMPANY_ID="$COMPANY_ID" PGV_TEXT="${2:-}" pcsql_run -Atq <<<"$1"; }

# Scalar read that refuses to be mistaken for a number. bash evaluates
# `[[ "" -eq 0 ]]` as TRUE, so an unreachable backend turns every count-is-zero
# assertion into a pass. Anything that is not a bare integer becomes the literal
# string "(no result)", which compares equal to nothing.
qnum() { local v; v="$(q "$@")"; [[ "$v" =~ ^[0-9]+$ ]] && printf '%s' "$v" || printf '(no result)'; }

sub_id() { # last submitted request id
  jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | tail -1; }

hdr "1. Submit-time ceiling enforcement"
# The ceiling gate is org_request_queue.sh:870. Pinning its words is what stops
# resolve_agent's "requester not found" (:860) from answering for it.
refuses_because "T0 cannot request a President/COO" \
  "above the request ceiling" \
  "$Q" submit --requester T0 --template P1_PRESIDENT_COO --title "TESTQ Shadow President"
refuses_because "T0 cannot request a peer chief (lateral)" \
  "above the request ceiling" \
  "$Q" submit --requester T0 --template B1_FUNCTION_CHIEF --title "TESTQ Shadow Chief"
refuses_because "O2 Chief of Staff cannot request anything" \
  "above the request ceiling" \
  "$Q" submit --requester O2 --template E0_SPECIALIST --title "TESTQ CoS Helper"
# This one is honest under any environment: it refuses in argv parsing
# (org_request_queue.sh:846), before the database is consulted at all. Pinned
# anyway so it stays that way.
refuses_because "requester cannot supply reportsTo through the queue" \
  "reportsTo is never caller-supplied" \
  "$Q" submit --requester T0 --template E0_SPECIALIST --title "TESTQ Escapee" --reports-to O2

hdr "2. Request ceiling is distinct from create ceiling (report: O3 is approval-gated)"
must_allow "O3 Audit MAY REQUEST an audit specialist" \
  "$Q" submit --requester O3 --template E4_AUDIT_ANALYST --title "TESTQ Internal Audit Lead"
REQ_AUDIT="$(sub_id)"
refuses_because "O3 still cannot CREATE one directly (bypassing the queue)" \
  "exceeds the delegation ceiling of" \
  "$PROV" create --caller O3 --template E4_AUDIT_ANALYST --title "TESTQ Direct Audit"
refuses_because "O3 cannot request a template outside its audit exception" \
  "above the request ceiling" \
  "$Q" submit --requester O3 --template E0_SPECIALIST --title "TESTQ Audit Specialist"

hdr "3. Review authority is a closed set"
must_allow "T0 submits a legitimate director request" \
  "$Q" submit --requester T0 --template C1_DIRECTOR_BUILDER --title "TESTQ Director AI Engineering"
REQ_DIR="$(sub_id)"
# Review authority is org_request_queue.sh:1175. The --reason is supplied on
# every case so the refusal is about authority, never arity (:1060).
refuses_because "T0 (a chief) cannot review — no org.review_request" \
  "is not the responsible leader for" \
  "$Q" review --reviewer T0 --request "$REQ_DIR" --approve --reason "reason supplied so this case asserts authority, not arity"
refuses_because "O3 Audit cannot review — independence, not approval authority" \
  "is not the responsible leader for" \
  "$Q" review --reviewer O3 --request "$REQ_DIR" --approve --reason "reason supplied so this case asserts authority, not arity"
refuses_because "O2 Chief of Staff cannot review" \
  "is not the responsible leader for" \
  "$Q" review --reviewer O2 --request "$REQ_DIR" --approve --reason "reason supplied so this case asserts authority, not arity"

hdr "4. Separation of duties — no self-approval even with review authority"
must_allow "O1 submits a request (O1 also holds review authority)" \
  "$Q" submit --requester O1 --template E1_REVIEWER_COACH --title "TESTQ Exec Coach"
REQ_SELF="$(sub_id)"
# Self-approval, org_request_queue.sh:1183 — distinct from :1175 above, and
# reachable only because O1 DOES hold standing authority. If this case ever
# refused with "not the responsible leader" it would prove nothing about
# separation of duties, which is the whole point of the section.
refuses_because "O1 cannot approve its OWN request" \
  "cannot review its own request" \
  "$Q" review --reviewer O1 --request "$REQ_SELF" --approve --reason "reason supplied so this case asserts authority, not arity"
must_allow "A0 steward can approve O1's request (different principal)" \
  "$Q" review --reviewer A0 --request "$REQ_SELF" --approve --reason "reason supplied so this case asserts authority, not arity"
COACH_ID="$(jq -r --arg r "$REQ_SELF" 'select(.requestId==$r and .status=="approved")|.newAgentId' "$QUEUE" | tail -1)"

hdr "5. Decisions are final"
refuses_because "an approved request cannot be re-approved" \
  "decisions are final" \
  "$Q" review --reviewer A0 --request "$REQ_SELF" --approve --reason "reason supplied so this case asserts authority, not arity"
refuses_because "an approved request cannot be flipped to rejected" \
  "decisions are final" \
  "$Q" review --reviewer A0 --request "$REQ_SELF" --reject --reason "changed mind" \
    --alternative "keep the approved request final and submit a new request if circumstances changed"

hdr "6. Template disablement (org.disable_template) freezes pending requests"
refuses_because "a chief cannot disable a template" \
  "does not hold org.disable_template" \
  "$Q" disable-template C1_DIRECTOR_BUILDER --reviewer T0
must_allow "A0 steward disables C1_DIRECTOR_BUILDER" \
  "$Q" disable-template C1_DIRECTOR_BUILDER --reviewer A0
# The point of the case is that DISABLEMENT froze it — not that A0 lost
# authority or the id went stale. org_request_queue.sh:1280.
refuses_because "pending director request is now refused at approval time" \
  "is currently disabled by the provisioning steward" \
  "$Q" review --reviewer A0 --request "$REQ_DIR" --approve --reason "reason supplied so this case asserts authority, not arity"
must_allow "A0 re-enables C1_DIRECTOR_BUILDER" \
  "$Q" enable-template C1_DIRECTOR_BUILDER --reviewer A0
must_allow "the same request now approves cleanly" \
  "$Q" review --reviewer A0 --request "$REQ_DIR" --approve --reason "reason supplied so this case asserts authority, not arity"
DIR_ID="$(jq -r --arg r "$REQ_DIR" 'select(.requestId==$r and .status=="approved")|.newAgentId' "$QUEUE" | tail -1)"

hdr "7. Approved requests execute with the requester's placement and exact template"
if [[ -n "${DIR_ID:-}" ]]; then
  parent="$(q "SELECT COALESCE(p.metadata->>'orgRoleId',p.title,'ROOT') FROM agents a LEFT JOIN agents p ON p.id=a.reports_to WHERE a.id=:'text'::uuid;" "$DIR_ID")"
  [[ "$parent" == "T0" ]] && ok "director reports to the REQUESTER (T0), not the reviewer (A0)" \
                          || bad "director parent is '$parent', expected T0"
  # The template set PLUS the assignment baseline. `tasks:assign` is
  # not part of C1_DIRECTOR_BUILDER and deliberately is not in TEMPLATES_JSON
  # (it would break org_request_queue.sh classify_risk's totality check); the
  # provisioner unions it in at the call site. See the ASSIGNMENT BASELINE
  # block in org_provisioner.sh.
  keys="$(q "SELECT COALESCE(string_agg(permission_key,',' ORDER BY permission_key),'(none)') FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'text';" "$DIR_ID")"
  [[ "$keys" == "agents:configure,skills:suggest-changes,tasks:assign,tasks:assign_scope,tasks:manage_active_checkouts" ]] \
    && ok "director holds exactly the C1_DIRECTOR_BUILDER template plus the assignment baseline" \
    || bad "director grants are '$keys'"
  scoped="$(q "SELECT COALESCE(string_agg(permission_key,',' ORDER BY permission_key),'(none)') FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'text' AND scope=jsonb_build_object('subtreeRootAgentId', :'text');" "$DIR_ID")"
  [[ "$scoped" == "agents:configure,tasks:assign_scope,tasks:manage_active_checkouts" ]] \
    && ok "director SELF grants have the exact own-subtree scope" \
    || bad "director own-subtree grants are '$scoped'"
  scope_errors="$(qnum "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'text' AND permission_key IN ('agents:configure','tasks:assign_scope','tasks:manage_active_checkouts') AND scope IS DISTINCT FROM jsonb_build_object('subtreeRootAgentId', :'text');" "$DIR_ID")"
  [[ "$scope_errors" == "0" ]] \
    && ok "director has no NULL or foreign scope on a SELF permission" \
    || bad "director has $scope_errors SELF permission(s) with NULL or foreign scope"
  # `tasks:assign` is EXCLUDED from this check because the assignment baseline
  # makes it company-wide on purpose, and it is the one key here that must be.
  # The scope is not a provisioner choice: routes/agents.ts:2852 calls
  # setPrincipalPermission with no scope argument, which defaults to NULL
  # (services/access.ts:661), so ANY agent with canAssignTasks=true holds it
  # company-wide. Demanding 0 here would have been unsatisfiable for an agent
  # on the company-wide baseline.
  #
  # It must not be narrowed to a subtree either, which is the tempting "fix":
  # authorization.ts:432-443 resolves a subtree-scoped grant by requiring the
  # TARGET to sit inside the actor's subtree and returns false otherwise. A
  # hand-back is upward or lateral, so its target is outside by construction —
  # a subtree scope would reproduce the exact hand-back 403 that the baseline
  # abolished, while this suite stayed green.
  #
  # The other three keys stay in the check: they are SELF permissions and a
  # NULL scope on them is still the privilege-escalation bug this guards.
  #
  # `tools:use` is here as the REPLACEMENT-COMPLETENESS probe. It is in no
  # template this suite provisions, so it can only be present if something
  # outside the provisioner put it there and apply_exact_grants failed to
  # replace it away — which is precisely what the exact-grant-replacement
  # mutant in the provisioner mutation gate under verification/ seeds. Dropping
  # `tasks:assign` from this list above costs the check nothing only because
  # this probe key still covers the DELETE; keep the two in sync.
  cw="$(qnum "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'text' AND scope IS NULL AND permission_key IN ('agents:configure','tasks:assign_scope','tasks:manage_active_checkouts','tools:use');" "$DIR_ID")"
  [[ "$cw" == "0" ]] && ok "server/default SELF grants were replaced away from company scope" || bad "company-wide organizational grant survived (count='$cw')"
  # Positive half: excluding tasks:assign above must not let the check pass by
  # the grant being ABSENT. An agent born without it cannot hand work back.
  bl="$(qnum "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'text' AND permission_key='tasks:assign' AND scope IS NULL;" "$DIR_ID")"
  [[ "$bl" == "1" ]] \
    && ok "queue-provisioned agent is born on the assignment baseline (company-wide tasks:assign)" \
    || bad "expected exactly 1 company-wide tasks:assign grant, found '$bl'"
  dorm="$(q "SELECT CASE WHEN runtime_config->'heartbeat'->>'enabled'='false' AND runtime_config->'heartbeat'->>'wakeOnDemand'='false' THEN 'yes' ELSE 'no' END FROM agents WHERE id=:'text'::uuid;" "$DIR_ID")"
  [[ "$dorm" == "yes" ]] && ok "queue-provisioned agent is born dormant" || bad "queue-provisioned agent is not dormant"
else bad "no director id captured"; fi

hdr "8. Stale-request / TOCTOU defence"
must_allow "the new director submits a manager request" \
  "$Q" submit --requester "${DIR_ID:-none}" --template D1_MANAGER --title "TESTQ Eng Manager"
REQ_STALE="$(sub_id)"
must_allow "T0 deactivates the director while its request is still pending" \
  "$PROV" deactivate --caller T0 --target "${DIR_ID:-none}"
# TOCTOU: the refusal must come from the staleness check (:1283/:1287/:1289),
# not from A0's authority or from the template catalog.
refuses_because "the pending request is refused — stale requester, authority not banked" \
  "refusing to execute a stale request" \
  "$Q" review --reviewer A0 --request "$REQ_STALE" --approve --reason "reason supplied so this case asserts authority, not arity"

hdr "9. Audit trail completeness"
for ev in request.refused review.refused template.disabled template.enabled create.applied; do
  n="$(jq -r --arg e "$ev" 'select(.event==$e)|.event' "${GRANT_LOG:-$HERE/provisioner-grant-log.jsonl}" 2>/dev/null | wc -l)"
  [[ "$n" -gt 0 ]] && ok "grant log records '$ev' ($n)" || bad "grant log missing '$ev'"
done

hdr "10. Teardown"
for id in "${COACH_ID:-}" ; do
  [[ -n "$id" ]] || continue
  "$PROV" deactivate --caller O1 --target "$id" >/dev/null 2>&1 \
    && ok "test coach deactivated" || bad "coach teardown failed ($id)"
done
# the audit request was never approved; nothing to remove for it
#
# This is an ABSENCE claim, and absence claims are the ones that go green for
# free: with the old `[[ "$left" -eq 0 ]]` an unreachable backend returned "",
# bash scored it as 0, and the suite reported that it had cleaned up test
# agents it had never been able to see, let alone create. qnum() makes "the
# query did not answer" distinct from "the answer was zero".
left="$(qnum "SELECT count(*) FROM agents WHERE company_id=:'company_id'::uuid AND metadata->>'provisionedBy'='org_provisioner' AND status<>'terminated' AND title LIKE 'TESTQ%';")"
if [[ "$left" == "0" ]]; then ok "no TESTQ-provisioned agents remain active"
elif [[ "$left" == "(no result)" ]]; then bad "cannot confirm teardown — the database stopped answering mid-run"
else bad "$left test agent(s) still active"; fi
rm -f "$QUEUE" "$DISABLED_TEMPLATES"

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
