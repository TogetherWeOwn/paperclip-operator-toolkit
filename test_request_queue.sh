#!/usr/bin/env bash
# Regression suite for the approval-gated org provisioning request queue.
# Validates separation of duties, closed-set review authority, the distinct
# request ceiling, template disablement, and stale-request (TOCTOU) defence.
#
# Uses its own queue file; the shared grant log stays authoritative.
# Any agent it provisions is torn down at the end.
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

must_refuse() { local d="$1"; shift; local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -ne 0 ]] && grep -q REFUSED <<<"$o"; then ok "$d"
  else bad "$d (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -3; fi; }
must_allow()  { local d="$1"; shift; local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then ok "$d"; else bad "$d (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -4; fi; }

# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; exit 1; }

q() { PGV_COMPANY_ID="$COMPANY_ID" PGV_TEXT="${2:-}" pcsql_run -Atq <<<"$1"; }

sub_id() { # last submitted request id
  jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | tail -1; }

hdr "1. Submit-time ceiling enforcement"
must_refuse "T0 cannot request a President/COO" \
  "$Q" submit --requester T0 --template P1_PRESIDENT_COO --title "TESTQ Shadow President"
must_refuse "T0 cannot request a peer chief (lateral)" \
  "$Q" submit --requester T0 --template B1_FUNCTION_CHIEF --title "TESTQ Shadow Chief"
must_refuse "O2 Chief of Staff cannot request anything" \
  "$Q" submit --requester O2 --template E0_SPECIALIST --title "TESTQ CoS Helper"
must_refuse "requester cannot supply reportsTo through the queue" \
  "$Q" submit --requester T0 --template E0_SPECIALIST --title "TESTQ Escapee" --reports-to O2

hdr "2. Request ceiling is distinct from create ceiling (report: O3 is approval-gated)"
must_allow "O3 Audit MAY REQUEST an audit specialist" \
  "$Q" submit --requester O3 --template E4_AUDIT_ANALYST --title "TESTQ Internal Audit Lead"
REQ_AUDIT="$(sub_id)"
must_refuse "O3 still cannot CREATE one directly (bypassing the queue)" \
  "$PROV" create --caller O3 --template E4_AUDIT_ANALYST --title "TESTQ Direct Audit"
must_refuse "O3 cannot request a template outside its audit exception" \
  "$Q" submit --requester O3 --template E0_SPECIALIST --title "TESTQ Audit Specialist"

hdr "3. Review authority is a closed set"
must_allow "T0 submits a legitimate director request" \
  "$Q" submit --requester T0 --template C1_DIRECTOR_BUILDER --title "TESTQ Director AI Engineering"
REQ_DIR="$(sub_id)"
must_refuse "T0 (a chief) cannot review — no org.review_request" \
  "$Q" review --reviewer T0 --request "$REQ_DIR" --approve --reason "reason supplied so this case asserts authority, not arity"
must_refuse "O3 Audit cannot review — independence, not approval authority" \
  "$Q" review --reviewer O3 --request "$REQ_DIR" --approve --reason "reason supplied so this case asserts authority, not arity"
must_refuse "O2 Chief of Staff cannot review" \
  "$Q" review --reviewer O2 --request "$REQ_DIR" --approve --reason "reason supplied so this case asserts authority, not arity"

hdr "4. Separation of duties — no self-approval even with review authority"
must_allow "O1 submits a request (O1 also holds review authority)" \
  "$Q" submit --requester O1 --template E1_REVIEWER_COACH --title "TESTQ Exec Coach"
REQ_SELF="$(sub_id)"
must_refuse "O1 cannot approve its OWN request" \
  "$Q" review --reviewer O1 --request "$REQ_SELF" --approve --reason "reason supplied so this case asserts authority, not arity"
must_allow "A0 steward can approve O1's request (different principal)" \
  "$Q" review --reviewer A0 --request "$REQ_SELF" --approve --reason "reason supplied so this case asserts authority, not arity"
COACH_ID="$(jq -r --arg r "$REQ_SELF" 'select(.requestId==$r and .status=="approved")|.newAgentId' "$QUEUE" | tail -1)"

hdr "5. Decisions are final"
must_refuse "an approved request cannot be re-approved" \
  "$Q" review --reviewer A0 --request "$REQ_SELF" --approve --reason "reason supplied so this case asserts authority, not arity"
must_refuse "an approved request cannot be flipped to rejected" \
  "$Q" review --reviewer A0 --request "$REQ_SELF" --reject --reason "changed mind"

hdr "6. Template disablement (org.disable_template) freezes pending requests"
must_refuse "a chief cannot disable a template" \
  "$Q" disable-template C1_DIRECTOR_BUILDER --reviewer T0
must_allow "A0 steward disables C1_DIRECTOR_BUILDER" \
  "$Q" disable-template C1_DIRECTOR_BUILDER --reviewer A0
must_refuse "pending director request is now refused at approval time" \
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
  keys="$(q "SELECT COALESCE(string_agg(permission_key,',' ORDER BY permission_key),'(none)') FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'text';" "$DIR_ID")"
  [[ "$keys" == "agents:configure,skills:suggest-changes,tasks:assign_scope,tasks:manage_active_checkouts" ]] \
    && ok "director holds exactly the C1_DIRECTOR_BUILDER template" \
    || bad "director grants are '$keys'"
  cw="$(q "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'text' AND scope IS NULL AND permission_key='tasks:assign';" "$DIR_ID")"
  [[ "$cw" -eq 0 ]] && ok "server's default company-wide tasks:assign was replaced away" || bad "default tasks:assign survived"
  dorm="$(q "SELECT CASE WHEN runtime_config->'heartbeat'->>'enabled'='false' AND runtime_config->'heartbeat'->>'wakeOnDemand'='false' THEN 'yes' ELSE 'no' END FROM agents WHERE id=:'text'::uuid;" "$DIR_ID")"
  [[ "$dorm" == "yes" ]] && ok "queue-provisioned agent is born dormant" || bad "queue-provisioned agent is not dormant"
else bad "no director id captured"; fi

hdr "8. Stale-request / TOCTOU defence"
must_allow "the new director submits a manager request" \
  "$Q" submit --requester "${DIR_ID:-none}" --template D1_MANAGER --title "TESTQ Eng Manager"
REQ_STALE="$(sub_id)"
must_allow "T0 deactivates the director while its request is still pending" \
  "$PROV" deactivate --caller T0 --target "${DIR_ID:-none}"
must_refuse "the pending request is refused — stale requester, authority not banked" \
  "$Q" review --reviewer A0 --request "$REQ_STALE" --approve --reason "reason supplied so this case asserts authority, not arity"

hdr "9. Audit trail completeness"
for ev in request.refused review.refused template.disabled template.enabled create.applied; do
  n="$(jq -r --arg e "$ev" 'select(.event==$e)|.event' "$HERE/provisioner-grant-log.jsonl" 2>/dev/null | wc -l)"
  [[ "$n" -gt 0 ]] && ok "grant log records '$ev' ($n)" || bad "grant log missing '$ev'"
done

hdr "10. Teardown"
for id in "${COACH_ID:-}" ; do
  [[ -n "$id" ]] || continue
  "$PROV" deactivate --caller O1 --target "$id" >/dev/null 2>&1 \
    && ok "test coach deactivated" || bad "coach teardown failed ($id)"
done
# the audit request was never approved; nothing to remove for it
left="$(q "SELECT count(*) FROM agents WHERE company_id=:'company_id'::uuid AND metadata->>'provisionedBy'='org_provisioner' AND status<>'terminated' AND title LIKE 'TESTQ%';")"
[[ "$left" -eq 0 ]] && ok "no TESTQ-provisioned agents remain active" || bad "$left test agent(s) still active"
rm -f "$QUEUE" "$DISABLED_TEMPLATES"

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
