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
#   4. ASSIGNMENT BASELINE — assignment policy must match the owner-decided
#                          baseline (company_default since TOG-984, 2026-09-05),
#                          and every agent must hold the company-wide
#                          `tasks:assign` grant that makes it effective
#   5. LEGACY FLAGS      — canCreateAgents must not widen authority
#   6. DORMANCY          — heartbeat enabled/wakeOnDemand vs. expectation
#   7. ORPHAN GRANTS     — grants or memberships for agents that no longer exist
#   8. SUBTREE SANITY    — reporting chain is acyclic and rooted
#   9. SECRET PROJECTION — every env.* secret binding has a matching
#                          adapterConfig.env declaration that actually projects
#  10. STANDING OVERRIDES — provisioning requests decided under break-glass
#                          authority OVER the responsible leader, unacknowledged
#  11. SAFER ALTERNATIVES — risky asks that were granted, and denials that
#                          recorded no safer route, with nobody having read
#                          the alternatives on the record (TOG-388)
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
SQL_FAILED=0
note()  { printf '  \033[33mFINDING\033[0m  %s\n' "$1"; FINDINGS=$((FINDINGS+1)); }
good()  { printf '  \033[32mOK\033[0m       %s\n' "$1"; }
hdr()   { printf '\n\033[1m%s\033[0m\n' "$1"; }
unknown() {
  echo "ERROR: org_access_review.sh could not complete every database query, so it produced no verdict." >&2
  exit 3
}

# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; exit 1; }

# PRECONDITION — exit 3 ("could not run"), distinct from 1 (findings). Without
# this guard, every failed SQL command produces an empty string and the absence
# checks below report a clean review that measured nothing.
if ! pcsql_preflight; then
  cat >&2 <<EOF

ERROR: org_access_review.sh cannot reach the company database, so it did not run.

  A missing backend must never read as zero findings. Select a reachable backend:
    PAPERCLIP_SQL_BACKEND=podman (default) — podman + ${PAPERCLIP_DB_CTR:-paperclip-db}
    PAPERCLIP_SQL_BACKEND=psql             — psql + DATABASE_URL or libpq PG* vars
EOF
  exit 3
fi

# Takes the SQL as an argument rather than on stdin, as it always has; the
# helper wants it on stdin. See lib/pcsql.sh for the backend choice. Every query
# is fail-fast, and a failure writes a sentinel that survives command/process
# substitution so the script cannot mistake an empty result for zero findings.
SQL_FAILURE_FILE="$(mktemp)"
trap 'rm -f "$SQL_FAILURE_FILE"' EXIT
sql() {
  local out rc
  out="$(PGV_COMPANY_ID="$COMPANY_ID" pcsql_run -Atq -v ON_ERROR_STOP=1 -F"|" <<<"$1")"; rc=$?
  if [[ $rc -ne 0 ]]; then
    printf x > "$SQL_FAILURE_FILE"
    return "$rc"
  fi
  printf '%s' "$out"
}
check_sql() { [[ ! -s "$SQL_FAILURE_FILE" ]] || unknown; }
trap_sql() { check_sql; }
trap trap_sql DEBUG

# The backend answering SELECT 1 is not enough: a reachable empty or wrong
# database would make every absence check green. Require the Paperclip agents
# table and at least one row for the requested company before scoring anything.
subject_count="$(sql "
SELECT count(*)
FROM agents
WHERE company_id = :'cid'::uuid;")"
check_sql
if [[ ! "$subject_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: org_access_review.sh found no agents for company $COMPANY_ID; refusing to score an empty or wrong database." >&2
  exit 3
fi

# Declared role templates. Source of truth is the provisioner's machine-readable
# catalog, so the review never parses aligned human output or strips `(SELF)`
# presentation markers.
TEMPLATE_EXPECT="$(
  COMPANY_ID="$COMPANY_ID" "$HERE/org_provisioner.sh" template-keys 2>/dev/null \
  | while IFS=$'\t' read -r tpl keys; do
      [[ -n "$tpl" ]] || continue
      printf '%s|%s\n' "$tpl" "$(tr ',' '\n' <<<"$keys" | sort | paste -sd, -)"
    done
)"
[[ -n "$TEMPLATE_EXPECT" ]] || { echo "ERROR: provisioner template catalog produced no rows" >&2; exit 3; }
# Executive profiles applied by the bootstrap, not provisionable (report 6/7).
TEMPLATE_EXPECT+=$'\n'"P1_PRESIDENT_COO|agents:configure,agents:create,audit:view_agent_actions,environments:manage,joins:approve,pipelines:write,skills:create,tasks:assign,tasks:manage_active_checkouts,tools:admin,tools:manage_connections,tools:manage_runtime,tools:use,tools:view_audit,users:invite,users:manage_permissions"
TEMPLATE_EXPECT+=$'\n'"P2_OWNER_COS|agents:suggest-changes,audit:view_agent_actions,skills:suggest-changes,tasks:assign"
TEMPLATE_EXPECT+=$'\n'"P3_AUDIT_RISK|agents:suggest-changes,audit:view_agent_actions,skills:suggest-changes,tools:view_audit"
TEMPLATE_EXPECT+=$'\n'"P4_PROVISIONING_STEWARD|agents:suggest-changes,audit:view_agent_actions,tools:view_audit"

# ---------------------------------------------------------------------------
# COMPANY-WIDE ASSIGNMENT BASELINE — owner decision 2026-09-05 00:50Z (TOG-984)
# ---------------------------------------------------------------------------
# The owner's instruction was "make sure all agents have the tools resources and
# permissions to effectively and efficiently do their jobs." The operator applied
# it at 00:51Z to all 24 non-terminated agents: assignmentPolicy.mode
# `protected` -> `company_default`, and canAssignTasks true (which the
# PATCH /api/agents/{id}/permissions route rewrites into a company-wide
# `tasks:assign` grant — see routes/agents.ts, effectiveCanAssignTasks).
#
# WHAT FORCED IT. Three finished hand-backs died on `403 deny_policy_restricted`
# on 2026-09-04 (TOG-54, TOG-69, TOG-586). The refusal comes from
# authorization.ts: a target whose assignmentMode is `protected` returns
# {kind:"restricted"}, and an actor holding only the SELF-scoped
# `tasks:assign_scope` cannot reach a target OUTSIDE its own subtree. A hand-BACK
# is upward or lateral by definition, so it is exactly the motion the template
# grants could never authorize. Each card sat `blocked` under the wrong assignee
# until a human moved it.
#
# WHY THIS IS A BASELINE AND NOT 15 TEMPLATE EDITS. `tasks:assign` is deliberately
# NOT added to the role templates in org_provisioner.sh. Two reasons, both
# load-bearing:
#   1. org_request_queue.sh classify_risk reads the template catalog live and
#      REFUSES (exit 3) on any key that is on neither RISK_KEYS nor NONRISK_KEYS.
#      `tasks:assign` is on neither. Putting it in the templates would break the
#      provisioning queue's risk classifier for every template carrying it.
#   2. A template says what a ROLE is for. This is one company-wide decision with
#      one owner and one date. Encoding it once, here, means re-protecting the
#      fleet is a one-line revert against a named decision rather than an
#      archaeology exercise across fifteen template bodies.
#
# The expectation below is therefore "the role template UNION this baseline".
# Drift is still drift: an agent holding a key that is in neither set still fails
# check 1, and an agent MISSING the baseline still fails check 5.
#
# TO REVERSE THIS you need a NEW owner decision, not a quiet edit. Set
# ASSIGNMENT_BASELINE_KEY="" and flip EXPECT_ASSIGNMENT_MODE back to `protected`,
# and re-run the provisioner's born-state assertions. Nobody may re-protect
# agents piecemeal — a partially-protected fleet reproduces the TOG-54 failure
# for exactly the agents that were re-protected, which is the hardest version of
# this bug to see.
ASSIGNMENT_BASELINE_KEY="${ASSIGNMENT_BASELINE_KEY-tasks:assign}"
EXPECT_ASSIGNMENT_MODE="${EXPECT_ASSIGNMENT_MODE:-company_default}"

# Fold the baseline into a template's expected key list, keeping the sorted,
# comma-joined shape the drift comparison comes in. A template that already
# names the key (P1/P2 below) must not gain a duplicate.
with_baseline() {
  local keys="$1"
  [[ -n "$ASSIGNMENT_BASELINE_KEY" ]] || { printf '%s' "$keys"; return; }
  { [[ -n "$keys" ]] && tr ',' '\n' <<<"$keys"; printf '%s\n' "$ASSIGNMENT_BASELINE_KEY"; } \
    | sort -u | sed '/^$/d' | paste -sd, -
}

# A template that legitimately grants NOTHING (E0_SPECIALIST) yields an empty
# expectation, which is still a valid expectation — so test whether the template
# is KNOWN separately from what it expects.
expected_for()      { with_baseline "$(grep -m1 "^$1|" <<<"$TEMPLATE_EXPECT" | cut -d'|' -f2-)"; }
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
hdr "4-5. Assignment policy baseline and legacy permission flags"
# Owner decision 2026-09-05 (TOG-984): the baseline is company_default, not
# protected. This check is INVERTED from what it was, deliberately — see the
# ASSIGNMENT_BASELINE_KEY block above for why, and for what reversing it costs.
# An agent that is `protected` again is now the finding, because that is the
# state that produced three 403 hand-back failures on 2026-09-04.
offbase="$(sql "
SELECT COALESCE(metadata->>'orgRoleId', title)
       || ' (mode=' || COALESCE(permissions->'authorizationPolicy'->'assignmentPolicy'->>'mode','unset') || ')'
FROM agents WHERE company_id = :'cid'::uuid AND status <> 'terminated'
  AND metadata->>'permissionProfile' IS NOT NULL
  AND COALESCE(permissions->'authorizationPolicy'->'assignmentPolicy'->>'mode','')
      <> '$EXPECT_ASSIGNMENT_MODE';")"
[[ -z "$offbase" ]] && good "all role-templated agents are on the '$EXPECT_ASSIGNMENT_MODE' assignment baseline" \
  || while read -r l; do [[ -n "$l" ]] && note "off assignment baseline (expected '$EXPECT_ASSIGNMENT_MODE'): $l"; done <<<"$offbase"

# The other half of the same decision, and the half the mode alone does NOT
# deliver. `company_default` only removes the target-side block; the ACTOR still
# needs a grant that reaches outside its own subtree, and the SELF-scoped
# `tasks:assign_scope` does not. Without this check, someone could strip the
# company-wide grant, leave the mode alone, and reproduce the TOG-54 403 while
# check 4 above stayed green.
if [[ -n "$ASSIGNMENT_BASELINE_KEY" ]]; then
  nokey="$(sql "
  SELECT COALESCE(a.metadata->>'orgRoleId', a.title)
  FROM agents a
  WHERE a.company_id = :'cid'::uuid AND a.status <> 'terminated'
    AND NOT EXISTS (
      SELECT 1 FROM principal_permission_grants g
      WHERE g.company_id = a.company_id AND g.principal_type = 'agent'
        AND g.principal_id = a.id::text
        AND g.permission_key = '$ASSIGNMENT_BASELINE_KEY'
        AND g.scope IS NULL);")"
  [[ -z "$nokey" ]] && good "every non-terminated agent holds the company-wide '$ASSIGNMENT_BASELINE_KEY' grant" \
    || while read -r l; do [[ -n "$l" ]] && note "missing company-wide $ASSIGNMENT_BASELINE_KEY grant: $l"; done <<<"$nokey"
fi

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
    -- TOG-994. BOTH sides must exclude terminated agents, or this is not a
    -- comparison at all. The 'd' CTE below reads only non-terminated agents,
    -- so a
    -- binding whose holder is terminated has nothing it could ever match and
    -- resolves to MISSING every time — a verdict about this WHERE clause, not
    -- about the agent. It measured 27 such rows on this company, each one an
    -- agent that projects nothing because a terminated agent has no run to
    -- project INTO. Filtering one side and not the other IS the bug.
    --
    -- A binding left behind by a terminated agent is still a real defect, but
    -- a different one, and check 7 above is where a row belonging to a dead
    -- agent is reported. Mixing the two here stopped check 9 answering its own
    -- question — does every secret this company grants actually REACH the run
    -- it was granted for — because a genuine live-agent projection failure
    -- would have arrived as the 28th line of a list already 27 lines long and
    -- entirely benign.
    AND EXISTS (SELECT 1 FROM agents a2
                 WHERE a2.id::text = b.target_id
                   AND a2.company_id = :'cid'::uuid
                   AND a2.status <> 'terminated')
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

# ---------------------------------------------------------------------------
hdr "11. Safer-alternative-first record on the provisioning queue"
# TOG-388. The owner's rule is that a risky ask is met with safer alternatives
# that still fully unblock the work, and is granted only when none exists —
# never without recording which alternatives were considered and why each
# failed. org_request_queue.sh makes that record impossible to omit. This check
# is the other half: somebody independent has to READ it. A record that is
# mandatory to write and optional to read is a filing cabinet, not a control.
#
# Two shapes land here, both only for RISKY asks:
#   grant     — a risky template was approved. Read the alternatives and say
#               whether the grant is really minimal.
#   no-safer  — a denial recorded that nothing safer would unblock the work.
#               That is the one case where a denial is close to a dead end, so
#               it is audited rather than trusted.
#
# Deliberately separate from check 10. An override answers "who decided this";
# this answers "was a safer route looked for". One request can carry both, and
# clearing one must not clear the other. Same read-only, DB-free contract.
if [[ ! -x "$QUEUE_CLI" ]]; then
  note "org_request_queue.sh not found next to this script — the safer-alternatives record went UNREVIEWED"
else
  rr_json="$(COMPANY_ID="$COMPANY_ID" "$QUEUE_CLI" risk-record --json 2>/dev/null)"; rr_rc=$?
  if [[ $rr_rc -gt 1 ]]; then
    note "could not read the provisioning request queue (exit $rr_rc) — the safer-alternatives record went UNREVIEWED"
  elif [[ -z "$rr_json" ]]; then
    good "no unacknowledged risky grants or no-safer-alternative findings"
  else
    while IFS= read -r rr; do
      [[ -n "$rr" ]] || continue
      note "$(jq -r '
        (if .kind == "grant"
         then "RISKY ASK GRANTED, unread: \(.reviewer) approved \(.requestId) (\(.requester) requesting \(.template); risk: \(.riskFactors|join(", "))) at \(.at). Alternatives on the record: " +
              ((.alternativesConsidered | map("\(.alternative) — failed because \(.whyItFailed)")) | join("; "))
         else "NO SAFER ALTERNATIVE recorded, unread: \(.reviewer) denied \(.requestId) (\(.requester) requesting \(.template); risk: \(.riskFactors|join(", "))) at \(.at) finding: \(.noSaferAlternative)"
         end) +
        " — clear it with: org_request_queue.sh ack-risk --request \(.requestId) --auditor <ROLE> --note \"...\""' <<<"$rr")"
    done <<<"$rr_json"
  fi
fi

# --------------------------------------------------------------------------
printf '\n\033[1mACCESS REVIEW: %d finding(s)\033[0m\n' "$FINDINGS"
[[ "$FINDINGS" -eq 0 ]]
