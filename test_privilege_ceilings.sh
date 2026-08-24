#!/usr/bin/env bash
# Privilege-ceiling regression suite for the constrained Org Provisioner.
# Validates: President/COO -> Chiefs -> Directors -> Managers -> Specialists
# with decreasing authority at every level and no upward/lateral creation.
#
# Creates a temporary test subtree under T0 and removes it at the end.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export COMPANY_ID="${COMPANY_ID:?Set COMPANY_ID}"
PROV="$HERE/org_provisioner.sh"
PASS=0; FAIL=0
declare -a CREATED=()

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# must_refuse <desc> <args...>
must_refuse() {
  local desc="$1"; shift
  local out; out="$("$PROV" "$@" 2>&1)"; local rc=$?
  if [[ $rc -ne 0 ]] && grep -q 'REFUSED' <<<"$out"; then
    ok "$desc"
  else
    bad "$desc  (rc=$rc, expected refusal)"; sed 's/^/        /' <<<"$out" | head -3
  fi
}

# must_allow <desc> <varname> <args...>
must_allow() {
  local desc="$1" var="$2"; shift 2
  local out; out="$("$PROV" "$@" 2>&1)"; local rc=$?
  local id; id="$(grep -oE 'PROVISIONED [A-Z0-9_]+ -> [0-9a-f-]{36}' <<<"$out" | awk '{print $4}')"
  if [[ $rc -eq 0 && -n "$id" ]]; then
    ok "$desc"; printf -v "$var" '%s' "$id"; CREATED+=("$id")
  else
    bad "$desc  (rc=$rc)"; sed 's/^/        /' <<<"$out" | head -5; printf -v "$var" '%s' ""
  fi
}

# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; exit 1; }

q() { # scalar SQL helper: q <sql> [agent_id]
  PGV_COMPANY_ID="$COMPANY_ID" PGV_AGENT_ID="${2:-}" pcsql_run -Atq <<<"$1"
}

grant_count() { q "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id';" "$1"; }
grant_keys()  { q "SELECT COALESCE(string_agg(permission_key,',' ORDER BY permission_key),'(none)') FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id';" "$1"; }
companywide() { q "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id' AND scope IS NULL AND permission_key IN ('tasks:assign','agents:create','users:manage_permissions','joins:approve','agents:configure');" "$1"; }
self_scoped_ok() { q "SELECT CASE WHEN count(*) FILTER (WHERE scope IS NOT NULL AND scope <> jsonb_build_object('subtreeRootAgentId', :'agent_id')) = 0 THEN 'yes' ELSE 'no' END FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id';" "$1"; }
dormant()     { q "SELECT CASE WHEN runtime_config->'heartbeat'->>'enabled'='false' AND runtime_config->'heartbeat'->>'wakeOnDemand'='false' THEN 'yes' ELSE 'no' END FROM agents WHERE id=:'agent_id'::uuid;" "$1"; }
protected()   { q "SELECT CASE WHEN permissions->'authorizationPolicy'->'assignmentPolicy'->>'mode'='protected' THEN 'yes' ELSE 'no' END FROM agents WHERE id=:'agent_id'::uuid;" "$1"; }
parent_of()   { q "SELECT COALESCE(p.metadata->>'orgRoleId', p.title,'ROOT') FROM agents a LEFT JOIN agents p ON p.id=a.reports_to WHERE a.id=:'agent_id'::uuid;" "$1"; }

hdr "1. Upward and lateral creation must be impossible"
must_refuse "T0 (tech chief) cannot create another President/COO" \
  create --caller T0 --template P1_PRESIDENT_COO --title "Shadow President"
must_refuse "T0 cannot create a peer functional chief (lateral)" \
  create --caller T0 --template B1_FUNCTION_CHIEF --title "Shadow Chief"
must_refuse "T0 cannot create a security chief (lateral, other function)" \
  create --caller T0 --template B3_SECURITY_CHIEF --title "Shadow CISO"
must_refuse "caller cannot supply its own reportsTo (subtree escape)" \
  create --caller T0 --template E0_SPECIALIST --title "Escapee" --reports-to O2

hdr "2. Roles with no team-building authority must not provision"
must_refuse "O2 Chief of Staff has no hiring authority" \
  create --caller O2 --template E0_SPECIALIST --title "CoS Helper"
must_refuse "O3 Audit cannot directly create audit specialists (approval-gated)" \
  create --caller O3 --template E4_AUDIT_ANALYST --title "Audit Analyst"
must_refuse "A0 Provisioning Steward cannot bypass its own ceiling" \
  create --caller A0 --template E0_SPECIALIST --title "Steward Helper"

hdr "3. Function-specific exceptions stay inside their function"
must_refuse "F0 Finance cannot mint a tools:admin holder (E2_TOOLING_ADMIN)" \
  create --caller F0 --template E2_TOOLING_ADMIN --title "Finance Tooling Admin"
must_refuse "F0 Finance cannot create a platform director" \
  create --caller F0 --template C2_PLATFORM_DIRECTOR --title "Finance Platform Dir"

hdr "4. The legitimate chain must work: Chief -> Director -> Manager -> Specialist"
must_allow "T0 creates a Director (C1_DIRECTOR_BUILDER)" DIR \
  create --caller T0 --template C1_DIRECTOR_BUILDER --title "TEST Director AI Engineering"
must_allow "Director creates a Manager (D1_MANAGER)" MGR \
  create --caller "${DIR:-none}" --template D1_MANAGER --title "TEST Agent Engineering Manager"
must_allow "Manager creates a Specialist (E0_SPECIALIST)" SPEC \
  create --caller "${MGR:-none}" --template E0_SPECIALIST --title "TEST AI Engineer"

hdr "5. Each new level must not exceed its own ceiling"
must_refuse "Manager cannot create a peer Manager" \
  create --caller "${MGR:-none}" --template D1_MANAGER --title "TEST Peer Manager"
must_refuse "Manager cannot create a Director (upward)" \
  create --caller "${MGR:-none}" --template C1_DIRECTOR_BUILDER --title "TEST Upward Director"
must_refuse "Specialist cannot create anything at all" \
  create --caller "${SPEC:-none}" --template E0_SPECIALIST --title "TEST Sub-specialist"
must_refuse "Director cannot create a chief (upward)" \
  create --caller "${DIR:-none}" --template B2_TECH_CHIEF --title "TEST Upward Chief"

hdr "5b. Chief seating is reserved to the enterprise operator"
must_allow "O1 may seat a functional chief" CHIEF \
  create --caller O1 --template B1_FUNCTION_CHIEF --title "TEST Interim Chief"
if [[ -n "${CHIEF:-}" ]]; then
  keys="$(grant_keys "$CHIEF")"
  [[ "$keys" == "agents:configure,skills:suggest-changes,tasks:assign_scope,tasks:manage_active_checkouts" ]] \
    && ok "seated chief holds exactly the B1_FUNCTION_CHIEF template" \
    || bad "seated chief grants are '$keys'"
  must_refuse "a seated chief cannot seat a peer chief" \
    create --caller "$CHIEF" --template B1_FUNCTION_CHIEF --title "TEST Peer Chief"
  must_refuse "a seated chief cannot seat a tech chief either" \
    create --caller "$CHIEF" --template B2_TECH_CHIEF --title "TEST Peer Tech Chief"
fi
must_refuse "T0 (a chief) cannot seat a chief even though B* templates now exist" \
  create --caller T0 --template B4_FINANCE_CHIEF --title "TEST Chief From Chief"
must_refuse "no one may provision another enterprise operator" \
  create --caller O1 --template P1_PRESIDENT_COO --title "TEST Shadow President"
must_refuse "no one may provision the human owner role" \
  create --caller O1 --template P0_OWNER --title "TEST Shadow Owner"

hdr "6. Authority must strictly taper down the new chain"
T0_ID="$(q "SELECT id::text FROM agents WHERE company_id=:'company_id'::uuid AND metadata->>'orgRoleId'='T0';")"
for pair in "T0:$T0_ID" "DIRECTOR:${DIR:-}" "MANAGER:${MGR:-}" "SPECIALIST:${SPEC:-}"; do
  lbl="${pair%%:*}"; id="${pair#*:}"
  [[ -n "$id" ]] || { bad "$lbl missing"; continue; }
  printf '        %-11s grants=%-2s  parent=%-9s  keys=%s\n' \
    "$lbl" "$(grant_count "$id")" "$(parent_of "$id")" "$(grant_keys "$id")"
done
c_t0="$(grant_count "$T0_ID")"; c_d="$(grant_count "${DIR:-}")"
c_m="$(grant_count "${MGR:-}")"; c_s="$(grant_count "${SPEC:-}")"
if [[ "$c_t0" -ge "$c_d" && "$c_d" -gt "$c_m" && "$c_m" -gt "$c_s" ]]; then
  ok "grant breadth decreases: chief($c_t0) >= director($c_d) > manager($c_m) > specialist($c_s)"
else
  bad "taper violated: chief=$c_t0 director=$c_d manager=$c_m specialist=$c_s"
fi
[[ "$c_s" -eq 0 ]] && ok "specialist has ZERO organizational-governance grants" \
                  || bad "specialist holds $c_s grants, expected 0"

hdr "7. No descendant inherited the server's default company-wide tasks:assign"
for pair in "DIRECTOR:${DIR:-}" "MANAGER:${MGR:-}" "SPECIALIST:${SPEC:-}"; do
  lbl="${pair%%:*}"; id="${pair#*:}"; [[ -n "$id" ]] || continue
  n="$(companywide "$id")"
  [[ "$n" -eq 0 ]] && ok "$lbl holds no company-wide privileged grant" \
                   || bad "$lbl holds $n company-wide privileged grant(s)"
done

hdr "8. SELF scopes bind to the agent's own subtree, not the caller's"
for pair in "DIRECTOR:${DIR:-}" "MANAGER:${MGR:-}"; do
  lbl="${pair%%:*}"; id="${pair#*:}"; [[ -n "$id" ]] || continue
  [[ "$(self_scoped_ok "$id")" == "yes" ]] \
    && ok "$lbl scoped grants resolve to its OWN subtreeRootAgentId" \
    || bad "$lbl has a scope pointing somewhere else"
done

hdr "9. Provisioned agents are born dormant and protected"
for pair in "DIRECTOR:${DIR:-}" "MANAGER:${MGR:-}" "SPECIALIST:${SPEC:-}"; do
  lbl="${pair%%:*}"; id="${pair#*:}"; [[ -n "$id" ]] || continue
  [[ "$(dormant "$id")" == "yes" ]] && ok "$lbl heartbeat disabled + wakeOnDemand false" || bad "$lbl not dormant"
  [[ "$(protected "$id")" == "yes" ]] && ok "$lbl assignment policy protected" || bad "$lbl not protected"
done

hdr "10. Deactivation is descendant-only"
must_refuse "Manager cannot deactivate its own Director (upward)" \
  deactivate --caller "${MGR:-none}" --target "${DIR:-none}"
must_refuse "Director cannot deactivate a chief in another function" \
  deactivate --caller "${DIR:-none}" --target S0
must_refuse "Director cannot deactivate the President/COO" \
  deactivate --caller "${DIR:-none}" --target O1

hdr "11. Owner/Board kill switch"
touch "$HERE/.provisioner-disabled"
must_refuse "all provisioning refused while kill switch engaged" \
  create --caller T0 --template E0_SPECIALIST --title "TEST Killswitch"
rm -f "$HERE/.provisioner-disabled"
ok "kill switch released"

hdr "12. Teardown — remove the test subtree"
for pair in "SPECIALIST:${SPEC:-}:${MGR:-}" "MANAGER:${MGR:-}:${DIR:-}" "DIRECTOR:${DIR:-}:T0" "CHIEF:${CHIEF:-}:O1"; do
  lbl="${pair%%:*}"; rest="${pair#*:}"; id="${rest%%:*}"; caller="${rest#*:}"
  [[ -n "$id" && -n "$caller" ]] || continue
  if "$PROV" deactivate --caller "$caller" --target "$id" >/dev/null 2>&1; then
    ok "$lbl deactivated by its own parent"
  else
    bad "$lbl teardown failed (agent $id may still exist)"
  fi
done
left="$(q "SELECT count(*) FROM agents WHERE company_id=:'company_id'::uuid AND metadata->>'provisionedBy'='org_provisioner' AND status <> 'terminated' AND title LIKE 'TEST%';")"
[[ "$left" -eq 0 ]] && ok "no TEST-provisioned agents remain active" || bad "$left test agent(s) still active"

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
