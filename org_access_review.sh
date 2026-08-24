#!/usr/bin/env bash
# ===========================================================================
# Periodic least-privilege access review
# ---------------------------------------------------------------------------
# Report section 8.2 invariant 11 ("privileged roles ... are included in
# periodic access review") and the A0 / O3 mandate. Turns the one-time
# post-bootstrap verification into a standing control.
#
# Checks, for every non-terminated agent in the company:
#   1. GRANT DRIFT       — live grants vs. the agent's declared role template
#   2. BROAD GRANTS      — company-wide privileged keys outside the allowed set
#   3. SCOPE INTEGRITY   — SELF-scoped grants must name the agent's OWN id
#   4. PROTECTION        — assignment policy must be 'protected'
#   5. LEGACY FLAGS      — canCreateAgents/canAssignTasks must not widen authority
#   6. DORMANCY          — heartbeat enabled/wakeOnDemand vs. expectation
#   7. ORPHAN GRANTS     — grants or memberships for agents that no longer exist
#   8. SUBTREE SANITY    — reporting chain is acyclic and rooted
#   9. SECRET PROJECTION — every env.* secret binding has a matching
#                          adapterConfig.env declaration that actually projects
#  10. STANDING OVERRIDES — provisioning requests decided under break-glass
#                          authority OVER the responsible leader, unacknowledged
#
# Read-only. Exits non-zero when findings exist, so it can be wired to CI,
# a cron, or a routine.
#
#   COMPANY_ID=<uuid> ./org_access_review.sh [--expect-dormant|--allow-active]
# ===========================================================================
set -uo pipefail

COMPANY_ID="${COMPANY_ID:?Set COMPANY_ID}"
PAPERCLIP_DB_CTR="${PAPERCLIP_DB_CTR:-paperclip-db}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPECT_DORMANT=1
[[ "${1:-}" == "--allow-active" ]] && EXPECT_DORMANT=0

FINDINGS=0
note()  { printf '  \033[33mFINDING\033[0m  %s\n' "$1"; FINDINGS=$((FINDINGS+1)); }
good()  { printf '  \033[32mOK\033[0m       %s\n' "$1"; }
hdr()   { printf '\n\033[1m%s\033[0m\n' "$1"; }

sql() { podman exec -i -e C="$COMPANY_ID" "$PAPERCLIP_DB_CTR" sh -c \
        'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq -F"|" -v cid="$C" -f -' <<<"$1"; }

# Declared role templates. Source of truth is the provisioner so the review and
# the provisioner can never drift apart.
TEMPLATE_EXPECT="$(
  COMPANY_ID="$COMPANY_ID" "$HERE/org_provisioner.sh" templates 2>/dev/null \
  | sed 's/  */ /g' | while read -r tpl rest; do
      [[ -n "$tpl" ]] || continue
      printf '%s|%s\n' "$tpl" "$(tr -d ' ' <<<"$rest" | tr ',' '\n' | sed 's/(SELF)//' | sort | paste -sd, -)"
    done
)"
# Executive profiles applied by the bootstrap, not provisionable (report 6/7).
TEMPLATE_EXPECT+=$'\n'"P1_PRESIDENT_COO|agents:configure,agents:create,audit:view_agent_actions,environments:manage,joins:approve,pipelines:write,skills:create,tasks:assign,tasks:manage_active_checkouts,tools:admin,tools:manage_connections,tools:manage_runtime,tools:use,tools:view_audit,users:invite,users:manage_permissions"
TEMPLATE_EXPECT+=$'\n'"P2_OWNER_COS|agents:suggest-changes,audit:view_agent_actions,skills:suggest-changes,tasks:assign"
TEMPLATE_EXPECT+=$'\n'"P3_AUDIT_RISK|agents:suggest-changes,audit:view_agent_actions,skills:suggest-changes,tools:view_audit"
TEMPLATE_EXPECT+=$'\n'"P4_PROVISIONING_STEWARD|agents:suggest-changes,audit:view_agent_actions,tools:view_audit"

# A template that legitimately grants NOTHING (E0_SPECIALIST) yields an empty
# expectation, which is still a valid expectation — so test whether the template
# is KNOWN separately from what it expects.
expected_for()      { grep -m1 "^$1|" <<<"$TEMPLATE_EXPECT" | cut -d'|' -f2-; }
template_is_known() { grep -q "^$1|" <<<"$TEMPLATE_EXPECT"; }

echo "Access review — company $COMPANY_ID — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --------------------------------------------------------------------------
hdr "1-2. Grant drift and unexpected broad authority"
while IFS='|' read -r role tpl id keys; do
  [[ -n "$id" ]] || continue
  label="${role:-$id}"
  if [[ -z "$tpl" ]]; then
    # Server built-in agents carry no role template; report them, do not fail on
    # a template comparison that cannot be made.
    good "$label — server built-in, no declared template (grants: ${keys:-none})"
    continue
  fi
  if ! template_is_known "$tpl"; then
    note "$label [$tpl] — no expectation on record for this template"
    continue
  fi
  exp="$(expected_for "$tpl")"
  if [[ "$keys" == "$exp" ]]; then
    if [[ -z "$exp" ]]; then
      good "$label [$tpl] — zero governance grants, exactly as the template specifies"
    else
      good "$label [$tpl] — grants match template exactly"
    fi
  else
    note "$label [$tpl] — GRANT DRIFT"
    printf '             expected: %s\n' "${exp:-<none>}"
    printf '             actual:   %s\n' "${keys:-<none>}"
  fi
done < <(sql "
SELECT COALESCE(a.metadata->>'orgRoleId',''),
       COALESCE(a.metadata->>'permissionProfile',''),
       a.id::text,
       COALESCE((SELECT string_agg(DISTINCT g.permission_key, ',' ORDER BY g.permission_key)
                 FROM principal_permission_grants g
                 WHERE g.company_id = a.company_id AND g.principal_type='agent'
                   AND g.principal_id = a.id::text), '')
FROM agents a
WHERE a.company_id = :'cid'::uuid AND a.status <> 'terminated'
ORDER BY 1, 3;")

# --------------------------------------------------------------------------
hdr "3. Scope integrity — SELF grants must name the holder's own subtree"
bad_scope="$(sql "
SELECT COALESCE(a.metadata->>'orgRoleId', a.title) || ' :: ' || g.permission_key || ' -> ' || g.scope::text
FROM agents a JOIN principal_permission_grants g
  ON g.company_id=a.company_id AND g.principal_type='agent' AND g.principal_id=a.id::text
WHERE a.company_id = :'cid'::uuid AND a.status <> 'terminated'
  AND g.scope IS NOT NULL
  AND g.scope <> jsonb_build_object('subtreeRootAgentId', a.id::text);")"
if [[ -z "$bad_scope" ]]; then good "every scoped grant is bound to its holder's own subtree"
else while read -r l; do [[ -n "$l" ]] && note "foreign scope: $l"; done <<<"$bad_scope"; fi

# --------------------------------------------------------------------------
hdr "4-5. Protected assignment and legacy permission flags"
unprot="$(sql "
SELECT COALESCE(metadata->>'orgRoleId', title)
FROM agents WHERE company_id = :'cid'::uuid AND status <> 'terminated'
  AND metadata->>'permissionProfile' IS NOT NULL
  AND COALESCE(permissions->'authorizationPolicy'->'assignmentPolicy'->>'mode','') <> 'protected';")"
[[ -z "$unprot" ]] && good "all role-templated agents have protected assignment" \
  || while read -r l; do [[ -n "$l" ]] && note "not protected: $l"; done <<<"$unprot"

legacy="$(sql "
SELECT COALESCE(metadata->>'orgRoleId', title) || ' (role=' || role || ', canCreateAgents=' || COALESCE(permissions->>'canCreateAgents','null') || ')'
FROM agents WHERE company_id = :'cid'::uuid AND status <> 'terminated'
  AND (role = 'ceo' OR (permissions->>'canCreateAgents')::boolean IS TRUE);")"
[[ -z "$legacy" ]] && good "no agent holds legacy creator authority (role=ceo or canCreateAgents)" \
  || while read -r l; do [[ -n "$l" ]] && note "legacy creator authority: $l"; done <<<"$legacy"

# --------------------------------------------------------------------------
hdr "6. Autonomy state"
active="$(sql "
SELECT COALESCE(metadata->>'orgRoleId', title) || ' (enabled=' || COALESCE(runtime_config->'heartbeat'->>'enabled','unset')
       || ', wakeOnDemand=' || COALESCE(runtime_config->'heartbeat'->>'wakeOnDemand','unset,DEFAULTS TRUE') || ')'
FROM agents WHERE company_id = :'cid'::uuid AND status NOT IN ('terminated','paused')
  AND (COALESCE(runtime_config->'heartbeat'->>'enabled','false') = 'true'
       OR COALESCE(runtime_config->'heartbeat'->>'wakeOnDemand','true') = 'true');")"
if [[ "$EXPECT_DORMANT" -eq 1 ]]; then
  [[ -z "$active" ]] && good "all agents dormant (heartbeat off AND wakeOnDemand off)" \
    || while read -r l; do [[ -n "$l" ]] && note "agent can be woken: $l"; done <<<"$active"
else
  [[ -z "$active" ]] && good "no agents wakeable" || while read -r l; do [[ -n "$l" ]] && good "wakeable (allowed): $l"; done <<<"$active"
fi
budget="$(sql "SELECT count(*) FROM budget_policies WHERE company_id = :'cid'::uuid;")"
runs="$(sql "SELECT count(*) FROM heartbeat_runs WHERE company_id = :'cid'::uuid;")"
if [[ "$budget" -eq 0 ]]; then
  if [[ -z "$active" ]]; then good "no enforced spend ceiling, but nothing is wakeable (safe while dormant)"
  else note "NO ENFORCED SPEND CEILING while agents are wakeable — set a budget policy before enabling autonomy"; fi
else good "$budget budget polic(ies) enforced"; fi
good "lifetime heartbeat runs: $runs"

# --------------------------------------------------------------------------
hdr "7. Orphaned grants and memberships"
orph_g="$(sql "
SELECT g.principal_id || ' (' || string_agg(g.permission_key, ',' ORDER BY g.permission_key) || ')'
FROM principal_permission_grants g
WHERE g.company_id = :'cid'::uuid AND g.principal_type='agent'
  AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id::text = g.principal_id AND a.status <> 'terminated')
GROUP BY g.principal_id;")"
[[ -z "$orph_g" ]] && good "no grants belong to removed or terminated agents" \
  || while read -r l; do [[ -n "$l" ]] && note "orphaned grants: $l"; done <<<"$orph_g"

orph_m="$(sql "
SELECT count(*) FROM company_memberships m
WHERE m.company_id = :'cid'::uuid AND m.principal_type='agent' AND m.status='active'
  AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id::text = m.principal_id AND a.status <> 'terminated');")"
[[ "$orph_m" -eq 0 ]] && good "no active memberships for removed or terminated agents" \
  || note "$orph_m active membership(s) reference removed/terminated agents"

# --------------------------------------------------------------------------
hdr "8. Reporting chain sanity"
cyc="$(sql "
WITH RECURSIVE walk(start_id, cur_id, depth) AS (
  SELECT id, reports_to, 1 FROM agents WHERE company_id = :'cid'::uuid AND status <> 'terminated'
  UNION ALL
  SELECT w.start_id, a.reports_to, w.depth + 1
  FROM walk w JOIN agents a ON a.id = w.cur_id
  WHERE w.cur_id IS NOT NULL AND w.depth < 60
)
SELECT count(*) FROM walk WHERE depth >= 60;")"
[[ "$cyc" -eq 0 ]] && good "reporting chains terminate (no cycles within depth 60)" \
  || note "$cyc agent(s) have a reporting chain that does not terminate — possible cycle"

dangling="$(sql "
SELECT count(*) FROM agents a WHERE a.company_id = :'cid'::uuid AND a.status <> 'terminated'
  AND a.reports_to IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM agents p WHERE p.id = a.reports_to AND p.status <> 'terminated');")"
[[ "$dangling" -eq 0 ]] && good "no agent reports to a removed or terminated manager" \
  || note "$dangling agent(s) report to a removed/terminated manager (orphaned subtree)"

# --------------------------------------------------------------------------
# 9. SECRET PROJECTION INTEGRITY
#
# A binding row in company_secret_bindings is the GRANT. An entry in the agent's
# adapterConfig.env is the DECLARATION. The runtime needs BOTH: heartbeat.ts
# builds the run environment from adapterConfig.env and resolves each
# secret_ref against the bindings. A grant with no declaration projects nothing,
# silently — and GET /api/agents/me/secrets still reports delivery:"env",
# because that field is derived from the binding's config_path prefix alone and
# describes intent, never outcome (TOG-175).
#
# That combination is why every agent secret on this company — including
# GH_APP_* — had never once reached a run, while every surface said it had
# (TOG-172 / TOG-173). This check is the recurrence guard: it compares the two
# halves directly instead of trusting either one's self-report.
# --------------------------------------------------------------------------
hdr "9. Secret env projection integrity (grant vs. declaration)"

proj_rows="$(sql "
WITH b AS (
  SELECT b.target_id AS agent_id,
         substring(b.config_path from 5) AS env_name,
         b.secret_id::text              AS secret_id,
         b.required
  FROM company_secret_bindings b
  WHERE b.company_id = :'cid'::uuid
    AND b.target_type = 'agent'
    AND b.config_path LIKE 'env.%'
),
d AS (
  SELECT a.id::text        AS agent_id,
         e.key             AS env_name,
         e.value->>'secretId' AS secret_id,
         e.value->>'type'     AS ref_type
  FROM agents a
  CROSS JOIN LATERAL jsonb_each(COALESCE(a.adapter_config->'env', '{}'::jsonb)) AS e(key, value)
  WHERE a.company_id = :'cid'::uuid AND a.status <> 'terminated'
)
SELECT COALESCE(ag.name, b.agent_id), b.env_name,
       CASE
         WHEN d.agent_id IS NULL                THEN 'MISSING'
         WHEN d.secret_id IS DISTINCT FROM b.secret_id THEN 'MISMATCH'
         WHEN d.ref_type <> 'secret_ref'        THEN 'BADTYPE'
         ELSE 'OK'
       END
FROM b
LEFT JOIN d  ON d.agent_id = b.agent_id AND d.env_name = b.env_name
LEFT JOIN agents ag ON ag.id::text = b.agent_id
ORDER BY 1, 2;")"

proj_total=0; proj_bad=0
while IFS='|' read -r pname penv pstate; do
  [[ -n "$penv" ]] || continue
  proj_total=$((proj_total+1))
  case "$pstate" in
    OK)       ;;
    MISSING)  note "$pname: binding grants \$$penv but adapterConfig.env has no entry — this secret projects NOTHING at runtime"; proj_bad=$((proj_bad+1)) ;;
    MISMATCH) note "$pname: adapterConfig.env.$penv points at a DIFFERENT secret than the binding grants"; proj_bad=$((proj_bad+1)) ;;
    BADTYPE)  note "$pname: adapterConfig.env.$penv is not a secret_ref — it will not resolve"; proj_bad=$((proj_bad+1)) ;;
  esac
done <<<"$proj_rows"

[[ "$proj_bad" -eq 0 ]] && good "all $proj_total env.* secret binding(s) have a matching adapterConfig.env declaration"

# The reverse direction: a declaration naming a secret that is NOT granted will
# fail to resolve at run time, which is a different failure from not projecting.
orphan_decl="$(sql "
SELECT COALESCE(a.name, a.id::text) || ' :: ' || e.key
FROM agents a
CROSS JOIN LATERAL jsonb_each(COALESCE(a.adapter_config->'env', '{}'::jsonb)) AS e(key, value)
WHERE a.company_id = :'cid'::uuid AND a.status <> 'terminated'
  AND e.value->>'type' = 'secret_ref'
  AND NOT EXISTS (
    SELECT 1 FROM company_secret_bindings b
    WHERE b.company_id = :'cid'::uuid AND b.target_type = 'agent'
      AND b.target_id = a.id::text
      AND b.config_path = 'env.' || e.key
      AND b.secret_id::text = e.value->>'secretId');")"
if [[ -z "$orphan_decl" ]]; then
  good "no adapterConfig.env entry references a secret the agent is not granted"
else
  while read -r od; do [[ -n "$od" ]] && note "declared but not granted: $od"; done <<<"$orphan_decl"
fi

# ---------------------------------------------------------------------------
hdr "10. Standing-authority overrides on the provisioning queue"
# TOG-194 gave the standing authority set (P4/P1) a break-glass path to decide a
# request OVER the responsible leader derived from the reporting chain, so a
# dormant leader cannot deadlock its subtree. The design accepted that trade on
# the explicit condition that the bypass is VISIBLE — docs/responsible-leader.md
# says the control is that it "is visible to org_access_review.sh". This is that
# sentence being true. Until this check existed, an override was written to the
# queue and read by nobody.
#
# Read-only, no database: it shells out to the queue's own reporting command so
# the two cannot drift, and that command is DB-free by construction.
QUEUE_CLI="${QUEUE_CLI:-$HERE/org_request_queue.sh}"
if [[ ! -x "$QUEUE_CLI" ]]; then
  note "org_request_queue.sh not found next to this script — standing-authority overrides went UNREVIEWED"
else
  ov_json="$(COMPANY_ID="$COMPANY_ID" "$QUEUE_CLI" overrides --json 2>/dev/null)"; ov_rc=$?
  if [[ $ov_rc -gt 1 ]]; then
    note "could not read the provisioning request queue (exit $ov_rc) — standing-authority overrides went UNREVIEWED"
  elif [[ -z "$ov_json" ]]; then
    good "no unacknowledged standing-authority overrides on the provisioning queue"
  else
    while IFS= read -r ov; do
      [[ -n "$ov" ]] || continue
      note "$(jq -r '"standing-authority override, unacknowledged: \(.reviewer) decided \(.requestId) over the responsible leader \(.bypassedLeader) at \(.at) (\(.requester) requesting \(.template)) — clear it with: org_request_queue.sh ack-override --request \(.requestId) --auditor <ROLE> --note \"...\""' <<<"$ov")"
    done <<<"$ov_json"
  fi
fi

# --------------------------------------------------------------------------
printf '\n\033[1mACCESS REVIEW: %d finding(s)\033[0m\n' "$FINDINGS"
[[ "$FINDINGS" -eq 0 ]]
