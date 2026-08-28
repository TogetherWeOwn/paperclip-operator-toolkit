#!/usr/bin/env bash
# Privilege-ceiling regression suite for the constrained Org Provisioner.
# Validates: President/COO -> Chiefs -> Directors -> Managers -> Specialists
# with decreasing authority at every level and no upward/lateral creation.
#
# Creates a temporary test subtree under T0 and removes it at the end.
#
# NEEDS A COMPANY-SHAPED POSTGRES DATABASE. org_provisioner.sh has no
# ORG_SNAPSHOT seam, so this suite cannot run as a purely offline unit test. CI
# supplies a throwaway schema/org fixture plus a dumb recording CLI; the VPS run
# remains necessary for the real Paperclip API contract. See the pcsql_preflight
# guard below, and the header of test_request_queue.sh for the measurement that
# motivated both (TOG-402): a refusal-shaped assertion accepts
# ANY refusal, so a tool that dies at "caller not found" satisfies a case that
# names the delegation ceiling. Here that produced 2 undeserved passes out of
# 36 with no podman present; the sibling suite produced 15 of 31.
#
# refuses_because pins each case to the words of the gate it names.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export COMPANY_ID="${COMPANY_ID:?Set COMPANY_ID}"
PROV="$HERE/org_provisioner.sh"
PASS=0; FAIL=0
declare -a CREATED=()

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# refuses_because <desc> <reason-substring> <args...>
# A refusal from the WRONG gate is a FAIL. Same helper as
# test_capability_gate.sh:41 and test_request_queue.sh, less the $PROV prefix
# which every case in this suite shares.
refuses_because() {
  local desc="$1" why="$2"; shift 2
  local out; out="$("$PROV" "$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then bad "$desc — was ALLOWED (rc=0)"; return; fi
  if ! grep -q 'REFUSED' <<<"$out"; then
    bad "$desc — non-zero but not a refusal (rc=$rc)"; sed 's/^/        /' <<<"$out" | head -3; return
  fi
  if grep -qF -- "$why" <<<"$out"; then ok "$desc"
  else bad "$desc — refused by the WRONG gate; wanted '$why'"; sed 's/^/        /' <<<"$out" | head -4; fi
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

# PRECONDITION — exit 3 ("could not run"), distinct from 1 ("ran and failed").
if ! pcsql_preflight; then
  cat >&2 <<EOF

ERROR: test_privilege_ceilings.sh cannot reach the company database, so it did not run.

  This suite provisions and tears down real agents through org_provisioner.sh.
  Running it without a reachable backend reports "caller not found" refusals as
  if they were ceiling enforcement. See the header, and TOG-402.

  Backend selection: PAPERCLIP_SQL_BACKEND=${PAPERCLIP_SQL_BACKEND:-podman} (podman|psql)
    podman: needs podman on PATH and container \${PAPERCLIP_DB_CTR:-paperclip-db} running
    psql:   needs psql on PATH and DATABASE_URL or libpq PG* variables
EOF
  exit 3
fi

q() { # scalar SQL helper: q <sql> [agent_id]
  PGV_COMPANY_ID="$COMPANY_ID" PGV_AGENT_ID="${2:-}" pcsql_run -Atq <<<"$1"
}

# A count that refuses to be mistaken for zero when the query returned nothing:
# bash evaluates `[[ "" -eq 0 ]]` as TRUE. See test_request_queue.sh.
qnum() { local v; v="$(q "$@")"; [[ "$v" =~ ^[0-9]+$ ]] && printf '%s' "$v" || printf '(no result)'; }

grant_count() { q "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id';" "$1"; }
grant_keys()  { q "SELECT COALESCE(string_agg(permission_key,',' ORDER BY permission_key),'(none)') FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id';" "$1"; }
self_scope_keys() { q "SELECT COALESCE(string_agg(permission_key,',' ORDER BY permission_key),'(none)') FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id' AND scope = jsonb_build_object('subtreeRootAgentId', :'agent_id') AND permission_key IN ('agents:configure','tasks:assign_scope','tasks:manage_active_checkouts');" "$1"; }
dormant()     { q "SELECT CASE WHEN runtime_config->'heartbeat'->>'enabled'='false' AND runtime_config->'heartbeat'->>'wakeOnDemand'='false' THEN 'yes' ELSE 'no' END FROM agents WHERE id=:'agent_id'::uuid;" "$1"; }
create_call_payload_ok() { local title="$1"; jq -er --arg title "$title" 'select(.command=="agent.create" and .payload.title==$title) | .payload | (.permissions.canCreateAgents==false and .permissions.canCreateSkills==false and .permissions.authorizationPolicy.assignmentPolicy.mode=="protected")' "${PAPERCLIP_STUB_LOG:?PAPERCLIP_STUB_LOG required}" 2>/dev/null | tail -1; }
create_call_parent() { local title="$1"; jq -er --arg title "$title" 'select(.command=="agent.create" and .payload.title==$title) | .payload.reportsTo' "${PAPERCLIP_STUB_LOG:?PAPERCLIP_STUB_LOG required}" 2>/dev/null | tail -1; }
create_call_title_for() { q "SELECT title FROM agents WHERE id=:'agent_id'::uuid;" "$1"; }
backend_is_recording_stub() { [[ -n "${PAPERCLIP_STUB_LOG:-}" && -r "${PAPERCLIP_STUB_LOG:-}" ]]; }
protected()   { q "SELECT CASE WHEN permissions->'authorizationPolicy'->'assignmentPolicy'->>'mode'='protected' THEN 'yes' ELSE 'no' END FROM agents WHERE id=:'agent_id'::uuid;" "$1"; }
legacy_flags_off() { q "SELECT CASE WHEN permissions->'canCreateAgents'='false'::jsonb AND permissions->'canCreateSkills'='false'::jsonb AND permissions->'canAssignTasks'='false'::jsonb THEN 'yes' ELSE 'no' END FROM agents WHERE id=:'agent_id'::uuid;" "$1"; }
parent_of()   { q "SELECT COALESCE(p.metadata->>'orgRoleId', p.title,'ROOT') FROM agents a LEFT JOIN agents p ON p.id=a.reports_to WHERE a.id=:'agent_id'::uuid;" "$1"; }

hdr "1. Upward and lateral creation must be impossible"
refuses_because "T0 (tech chief) cannot create another President/COO" \
  "exceeds the delegation ceiling of" \
  create --caller T0 --template P1_PRESIDENT_COO --title "Shadow President"
refuses_because "T0 cannot create a peer functional chief (lateral)" \
  "exceeds the delegation ceiling of" \
  create --caller T0 --template B1_FUNCTION_CHIEF --title "Shadow Chief"
refuses_because "T0 cannot create a security chief (lateral, other function)" \
  "exceeds the delegation ceiling of" \
  create --caller T0 --template B3_SECURITY_CHIEF --title "Shadow CISO"
refuses_because "caller cannot supply its own reportsTo (subtree escape)" \
  "reportsTo cannot be supplied by the caller" \
  create --caller T0 --template E0_SPECIALIST --title "Escapee" --reports-to O2

hdr "2. Roles with no team-building authority must not provision"
refuses_because "O2 Chief of Staff has no hiring authority" \
  "exceeds the delegation ceiling of" \
  create --caller O2 --template E0_SPECIALIST --title "CoS Helper"
refuses_because "O3 Audit cannot directly create audit specialists (approval-gated)" \
  "exceeds the delegation ceiling of" \
  create --caller O3 --template E4_AUDIT_ANALYST --title "Audit Analyst"
refuses_because "A0 Provisioning Steward cannot bypass its own ceiling" \
  "exceeds the delegation ceiling of" \
  create --caller A0 --template E0_SPECIALIST --title "Steward Helper"

hdr "3. Function-specific exceptions stay inside their function"
refuses_because "F0 Finance cannot mint a tools:admin holder (E2_TOOLING_ADMIN)" \
  "exceeds the delegation ceiling of" \
  create --caller F0 --template E2_TOOLING_ADMIN --title "Finance Tooling Admin"
refuses_because "F0 Finance cannot create a platform director" \
  "exceeds the delegation ceiling of" \
  create --caller F0 --template C2_PLATFORM_DIRECTOR --title "Finance Platform Dir"

hdr "4. The legitimate chain must work: Chief -> Director -> Manager -> Specialist"
must_allow "T0 creates a Director (C1_DIRECTOR_BUILDER)" DIR \
  create --caller T0 --template C1_DIRECTOR_BUILDER --title "TEST Director AI Engineering"
must_allow "Director creates a Manager (D1_MANAGER)" MGR \
  create --caller "${DIR:-none}" --template D1_MANAGER --title "TEST Agent Engineering Manager"
must_allow "Manager creates a Specialist (E0_SPECIALIST)" SPEC \
  create --caller "${MGR:-none}" --template E0_SPECIALIST --title "TEST AI Engineer"

hdr "5. Each new level must not exceed its own ceiling"
refuses_because "Manager cannot create a peer Manager" \
  "exceeds the delegation ceiling of" \
  create --caller "${MGR:-none}" --template D1_MANAGER --title "TEST Peer Manager"
refuses_because "Manager cannot create a Director (upward)" \
  "exceeds the delegation ceiling of" \
  create --caller "${MGR:-none}" --template C1_DIRECTOR_BUILDER --title "TEST Upward Director"
refuses_because "Specialist cannot create anything at all" \
  "exceeds the delegation ceiling of" \
  create --caller "${SPEC:-none}" --template E0_SPECIALIST --title "TEST Sub-specialist"
refuses_because "Director cannot create a chief (upward)" \
  "exceeds the delegation ceiling of" \
  create --caller "${DIR:-none}" --template B2_TECH_CHIEF --title "TEST Upward Chief"

hdr "5b. Chief seating is reserved to the enterprise operator"
must_allow "O1 may seat a functional chief" CHIEF \
  create --caller O1 --template B1_FUNCTION_CHIEF --title "TEST Interim Chief"
if [[ -n "${CHIEF:-}" ]]; then
  keys="$(grant_keys "$CHIEF")"
  [[ "$keys" == "agents:configure,skills:suggest-changes,tasks:assign_scope,tasks:manage_active_checkouts" ]] \
    && ok "seated chief holds exactly the B1_FUNCTION_CHIEF template" \
    || bad "seated chief grants are '$keys'"
  refuses_because "a seated chief cannot seat a peer chief" \
    "exceeds the delegation ceiling of" \
    create --caller "$CHIEF" --template B1_FUNCTION_CHIEF --title "TEST Peer Chief"
  refuses_because "a seated chief cannot seat a tech chief either" \
    "exceeds the delegation ceiling of" \
    create --caller "$CHIEF" --template B2_TECH_CHIEF --title "TEST Peer Tech Chief"
fi
refuses_because "T0 (a chief) cannot seat a chief even though B* templates now exist" \
  "exceeds the delegation ceiling of" \
  create --caller T0 --template B4_FINANCE_CHIEF --title "TEST Chief From Chief"
# These live cases intentionally prove the ordinary ceiling fires first. The
# independent chief-seat and enterprise-role gates are exercised offline by
# test_provisioning_policy.sh with widened ceiling VALUES passed to the pure
# create_policy_check function. The mutating provisioner itself has no ceiling
# override and always supplies its literal catalog.
refuses_because "no one may provision another enterprise operator" \
  "exceeds the delegation ceiling of" \
  create --caller O1 --template P1_PRESIDENT_COO --title "TEST Shadow President"
refuses_because "no one may provision the human owner role" \
  "exceeds the delegation ceiling of" \
  create --caller O1 --template P0_OWNER --title "TEST Shadow Owner"

hdr "6. Authority must strictly taper down the new chain"
T0_ID="$(q "SELECT id::text FROM agents WHERE company_id=:'company_id'::uuid AND metadata->>'orgRoleId'='T0';")"
for pair in "T0:$T0_ID" "DIRECTOR:${DIR:-}" "MANAGER:${MGR:-}" "SPECIALIST:${SPEC:-}"; do
  lbl="${pair%%:*}"; id="${pair#*:}"
  [[ -n "$id" ]] || { bad "$lbl missing"; continue; }
  printf '        %-11s grants=%-2s  parent=%-9s  keys=%s\n' \
    "$lbl" "$(grant_count "$id")" "$(parent_of "$id")" "$(grant_keys "$id")"
done
c_t0="$(qnum "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id';" "$T0_ID")"
c_d="$(qnum "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id';" "${DIR:-}")"
c_m="$(qnum "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id';" "${MGR:-}")"
c_s="$(qnum "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id';" "${SPEC:-}")"
if [[ "$c_t0$c_d$c_m$c_s" == *"(no result)"* ]]; then
  bad "cannot compare grant breadth — a count query returned nothing: chief=$c_t0 director=$c_d manager=$c_m specialist=$c_s"
elif [[ "$c_t0" -ge "$c_d" && "$c_d" -gt "$c_m" && "$c_m" -gt "$c_s" ]]; then
  ok "grant breadth decreases: chief($c_t0) >= director($c_d) > manager($c_m) > specialist($c_s)"
else
  bad "taper violated: chief=$c_t0 director=$c_d manager=$c_m specialist=$c_s"
fi
# `-eq 0` on an empty string is TRUE in bash, so this ZERO-grants claim used to
# pass against no database at all. String-compare the digits instead.
[[ "$c_s" == "0" ]] && ok "specialist has ZERO organizational-governance grants" \
                   || bad "specialist grant count is '$c_s', expected 0"

hdr "7. No descendant holds a company-wide organizational grant"
for pair in "DIRECTOR:${DIR:-}" "MANAGER:${MGR:-}" "SPECIALIST:${SPEC:-}"; do
  lbl="${pair%%:*}"; id="${pair#*:}"; [[ -n "$id" ]] || continue
  n="$(qnum "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id' AND scope IS NULL AND permission_key IN ('tasks:assign','agents:create','users:manage_permissions','joins:approve','agents:configure','tasks:assign_scope','tasks:manage_active_checkouts');" "$id")"
  [[ "$n" == "0" ]] && ok "$lbl holds no company-wide privileged grant" \
                    || bad "$lbl company-wide privileged grant count is '$n', expected 0"
done

hdr "8. Every SELF permission has exactly the agent's own subtree scope"
for row in \
  "DIRECTOR:${DIR:-}:agents:configure,tasks:assign_scope,tasks:manage_active_checkouts" \
  "MANAGER:${MGR:-}:tasks:assign_scope,tasks:manage_active_checkouts"; do
  lbl="${row%%:*}"; rest="${row#*:}"; id="${rest%%:*}"; want="${rest#*:}"
  [[ -n "$id" ]] || continue
  got="$(self_scope_keys "$id")"; errors="$(qnum "SELECT count(*) FROM principal_permission_grants WHERE company_id=:'company_id'::uuid AND principal_type='agent' AND principal_id=:'agent_id' AND permission_key IN ('agents:configure','tasks:assign_scope','tasks:manage_active_checkouts') AND scope IS DISTINCT FROM jsonb_build_object('subtreeRootAgentId', :'agent_id');" "$id")"
  [[ "$got" == "$want" && "$errors" == "0" ]] \
    && ok "$lbl SELF grants are exactly '$want' on its own subtreeRootAgentId" \
    || bad "$lbl SELF scope mismatch: own-scope='$got' errors='$errors', expected '$want' and 0"
done

hdr "9. Provisioned agents are born dormant and protected"
for pair in "DIRECTOR:${DIR:-}" "MANAGER:${MGR:-}" "SPECIALIST:${SPEC:-}"; do
  lbl="${pair%%:*}"; id="${pair#*:}"; [[ -n "$id" ]] || continue
  [[ "$(dormant "$id")" == "yes" ]] && ok "$lbl heartbeat disabled + wakeOnDemand false" || bad "$lbl not dormant"
  [[ "$(protected "$id")" == "yes" ]] && ok "$lbl assignment policy protected" || bad "$lbl not protected"
  [[ "$(legacy_flags_off "$id")" == "yes" ]] \
    && ok "$lbl legacy permission flags explicitly false" \
    || bad "$lbl legacy permission flags are not explicitly false"
  if backend_is_recording_stub; then
    title="$(create_call_title_for "$id")"
    [[ "$(create_call_payload_ok "$title")" == "true" ]] \
      && ok "$lbl agent.create payload is protected before permissions:update" \
      || bad "$lbl agent.create payload was not born protected"
  fi
done

if backend_is_recording_stub && [[ -n "${DIR:-}" ]]; then
  dir_title="$(create_call_title_for "$DIR")"
  [[ "$(create_call_parent "$dir_title")" == "$T0_ID" ]] \
    && ok "DIRECTOR agent.create payload uses the caller-selected-by-service parent" \
    || bad "DIRECTOR create payload accepted caller-controlled placement"
fi

hdr "10. Deactivation is descendant-only"
refuses_because "Manager cannot deactivate its own Director (upward)" \
  "is not inside" \
  deactivate --caller "${MGR:-none}" --target "${DIR:-none}"
refuses_because "Director cannot deactivate a chief in another function" \
  "is not inside" \
  deactivate --caller "${DIR:-none}" --target S0
refuses_because "Director cannot deactivate the President/COO" \
  "is not inside" \
  deactivate --caller "${DIR:-none}" --target O1

hdr "11. Owner/Board kill switch"
touch "$HERE/.provisioner-disabled"
refuses_because "all provisioning refused while kill switch engaged" \
  "kill switch is engaged" \
  create --caller T0 --template E0_SPECIALIST --title "TEST Killswitch"
rm -f "$HERE/.provisioner-disabled"
# This used to be a bare `ok "kill switch released"` — an unconditional PASS
# that asserted nothing and counted itself anyway, so it read green in an
# environment with no database at all. Assert the release instead:
# assert_enabled runs at org_provisioner.sh:323, ahead of the ceiling check at
# :356, so a create that comes back refused by the CEILING proves the switch is
# no longer engaged — and provisions nothing while proving it.
refuses_because "kill switch released — provisioning refuses on merit again, not on the switch" \
  "exceeds the delegation ceiling of" \
  create --caller T0 --template P1_PRESIDENT_COO --title "TEST Killswitch Released"

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
# An ABSENCE claim, so the one most able to go green for free. See qnum().
left="$(qnum "SELECT count(*) FROM agents WHERE company_id=:'company_id'::uuid AND metadata->>'provisionedBy'='org_provisioner' AND status <> 'terminated' AND title LIKE 'TEST%';")"
if [[ "$left" == "0" ]]; then ok "no TEST-provisioned agents remain active"
elif [[ "$left" == "(no result)" ]]; then bad "cannot confirm teardown — the database stopped answering mid-run"
else bad "$left test agent(s) still active"; fi

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
