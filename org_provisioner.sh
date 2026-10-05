#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# Constrained Org Provisioner
# ---------------------------------------------------------------------------
# Implements section 8 of paperclipai_enterprise_org_operating_model.md for the
# Paperclip installation on this machine (Podman/Quadlet, containerized
# PostgreSQL, authenticated deployment mode, server v2026.817.0).
#
# WHY THIS EXISTS
# ---------------
# Paperclip v2026.817.0 cannot express delegated recursive provisioning safely
# on its own. Three verified facts force a compensating control:
#
#   1. `agents:create` is authorized against a COMPANY resource, never a
#      subtree. A chief holding it natively could create agents anywhere,
#      including peers and new roots.  (report Constraint B)
#   2. Agent creation unconditionally applies a company-wide `tasks:assign`
#      grant (applyDefaultAgentTaskAssignGrant). Every new agent is born with
#      more authority than most role templates allow.  (report Constraint C)
#   3. The native member grant routes reject agent principals outright, so
#      `users:manage_permissions` does NOT give an agent the ability to
#      administer a descendant's grants.  (report Constraint A)
#
# This provisioner is therefore the ONLY component holding creation +
# grant-administration authority. It runs as the human/admin operator, in the
# same trust zone as the bootstrap. No autonomous agent receives database
# credentials, a general SQL capability, or native `agents:create`.
#
# THREAT MODEL / WHAT THIS DOES NOT DO
# ------------------------------------
# This is an operator-run CLI, not yet an agent-callable service. Agents cannot
# invoke it. Wiring it to an approval-gated request queue (so a chief can
# REQUEST a descendant and A0/O1 approves) is the remaining step before any
# agent-initiated org growth is possible. Until then, every descendant is
# created by a human running this command.
#
# INVARIANTS ENFORCED (report section 8.2)
# ----------------------------------------
#   1. Descendants only. reportsTo is set BY THE SERVICE to the caller's own
#      agent id and can never be supplied by the caller.
#   2. The requested role template must sit at or below the caller's
#      delegation ceiling.
#   3. The service, not the caller, decides placement.
#   4. Default grants are REPLACED, not appended to.
#   5. SELF scopes resolve to the NEW agent's id.
#   6. A child can never mint a template above its own ceiling (enforced
#      recursively because the ceiling is keyed on the caller's own template).
#   7. tools:admin / company-wide audit / human permission administration
#      require an explicit template exception.
#   8. Paperclip RBAC never implies external tool or data access.
#   9. Every operation is appended to an immutable grant log.
#  10. No agent receives raw database credentials.
#  11. Agents are born on the owner-decided assignment baseline (TOG-984):
#      company_default + a company-wide tasks:assign, so hand-backs work.
#  12. Kill switch: see PROVISIONER_DISABLED below.
#
# USAGE
#   ./org_provisioner.sh create --caller <ROLE_ID> --template <TEMPLATE> \
#                               --title "..." [--capabilities "..."]
#   ./org_provisioner.sh access <ROLE_ID|AGENT_UUID>
#   ./org_provisioner.sh tree
#   ./org_provisioner.sh deactivate --caller <ROLE_ID> --target <ROLE_ID>
#   ./org_provisioner.sh templates       # human view of the role template catalog
#   ./org_provisioner.sh template-keys   # machine view: "<template>\t<key,...>"
#   ./org_provisioner.sh ceiling         # who may provision what
#   ./org_provisioner.sh selftest        # privilege-ceiling regression suite
#
# Kill switch: create the file .provisioner-disabled next to this script, or
# export PROVISIONER_DISABLED=1, to refuse all mutating operations.
# ===========================================================================

COMPANY_ID="${COMPANY_ID:?Set COMPANY_ID}"
PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
PAPERCLIP_DB_CTR="${PAPERCLIP_DB_CTR:-paperclip-db}"
ADAPTER_TYPE="${ADAPTER_TYPE:-claude_local}"
AGENT_BUDGET_CENTS="${AGENT_BUDGET_CENTS:-0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GRANT_LOG="${GRANT_LOG:-$HERE/provisioner-grant-log.jsonl}"

# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; exit 1; }
# shellcheck source=lib/provisioning_policy.sh
. "$HERE/lib/provisioning_policy.sh" || { echo "ERROR: missing $HERE/lib/provisioning_policy.sh" >&2; exit 1; }

# Depend on the binary the SELECTED backend needs, not on podman unconditionally
# — demanding podman on a machine running the psql backend is a false failure.
for bin in jq curl "$(pcsql_required_bin)"; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: missing $bin" >&2; exit 1; }
done

resolve_cli() {
  [[ -n "${PAPERCLIP_CLI:-}" ]] && { echo "$PAPERCLIP_CLI"; return; }
  command -v paperclipai >/dev/null 2>&1 && { command -v paperclipai; return; }
  local c; c="$(find "$HOME/.npm/_npx" -maxdepth 4 -path '*/node_modules/.bin/paperclipai' 2>/dev/null | head -1)"
  [[ -n "$c" ]] || { echo "ERROR: no local paperclipai CLI" >&2; exit 1; }
  echo "$c"
}
PC_CLI="$(resolve_cli)"
pc() { "$PC_CLI" "$@" --api-base "$PAPERCLIP_API_URL"; }

# ON_ERROR_STOP is this tool's own policy, not the shared helper's: a partial
# write during provisioning is worse than a refusal. Kept as a one-line wrapper
# so every call site below stays exactly as it was.
pcsql() { pcsql_run -v ON_ERROR_STOP=1 "$@"; }

die() { echo "REFUSED: $*" >&2; exit 2; }

assert_enabled() {
  if [[ -f "$HERE/.provisioner-disabled" || "${PROVISIONER_DISABLED:-0}" == "1" ]]; then
    die "provisioner kill switch is engaged (owner/board control)."
  fi
}

# ---------------------------------------------------------------------------
# ASSIGNMENT BASELINE — owner decision, TOG-984, 2026-09-05.
#
# Agents used to be born with assignmentPolicy.mode="protected" and
# canAssignTasks=false (old invariant 11). That posture broke hand-backs: on
# 2026-09-04, TOG-54, TOG-69 and TOG-586 each finished their work and then got
# 403 deny_policy_restricted -- "Target agent is protected and requires an
# explicit assignment grant" -- trying to hand the card back up the chain. Each
# card sat `blocked` under the wrong assignee until a human reassigned it.
#
# The mechanism has two halves, and BOTH have to be right or the hand-back
# fails again (server/src/services/authorization.ts):
#
#   target side -- mode="protected" on the TARGET returns {kind:"restricted"}
#                  before any grant is consulted.
#   actor  side -- the ACTOR needs `tasks:assign`. A SELF-scoped
#                  `tasks:assign_scope` only reaches inside its own subtree,
#                  and a hand-back is upward or lateral by definition. That is
#                  a motion a per-template grant could never authorize.
#
# So the baseline is company_default + a company-wide `tasks:assign`.
#
# WHY THIS IS NOT IN TEMPLATES_JSON. Two reasons, and the first is load-bearing:
#
#   1. org_request_queue.sh classify_risk runs a TOTALITY CHECK over template
#      keys and refuses (exit 3) on any key that is on neither RISK_KEYS nor
#      NONRISK_KEYS. `tasks:assign` is on NEITHER list. Adding it to templates
#      would break the provisioning queue's risk classifier for every template
#      carrying it -- the queue would stop, company-wide, on the next request.
#   2. A template says what a ROLE is for. This is not a role property; it is
#      one dated company-wide decision. Encoding it once, here, keeps it
#      auditable as the single fact it is instead of 15 copies that can drift.
#
# TO REVERSE THIS you need a NEW owner decision, not a quiet edit. Set
# ASSIGNMENT_BASELINE_MODE=protected and BASELINE_CAN_ASSIGN_TASKS=false, and
# flip the matching expectations in org_access_review.sh. Nobody may re-protect
# agents piecemeal: a partially-protected fleet reproduces the TOG-54 failure
# for exactly the agents that were re-protected, which is the hardest version
# of this bug to see, because the review stays green for everyone else.
# ---------------------------------------------------------------------------
ASSIGNMENT_BASELINE_MODE="${ASSIGNMENT_BASELINE_MODE:-company_default}"
BASELINE_CAN_ASSIGN_TASKS="${BASELINE_CAN_ASSIGN_TASKS:-true}"

# ---------------------------------------------------------------------------
# Role template catalog — report section 6.
# "SELF" resolves to the newly created agent's id at provisioning time.
# ---------------------------------------------------------------------------
TEMPLATES_JSON='{
  "B1_FUNCTION_CHIEF": [
    {"permissionKey":"agents:configure","self":true},
    {"permissionKey":"tasks:assign_scope","self":true},
    {"permissionKey":"tasks:manage_active_checkouts","self":true},
    {"permissionKey":"skills:suggest-changes","self":false}
  ],
  "B2_TECH_CHIEF": [
    {"permissionKey":"agents:configure","self":true},
    {"permissionKey":"tasks:assign_scope","self":true},
    {"permissionKey":"tasks:manage_active_checkouts","self":true},
    {"permissionKey":"skills:create","self":false},
    {"permissionKey":"environments:manage","self":false},
    {"permissionKey":"tools:manage_connections","self":false},
    {"permissionKey":"tools:view_audit","self":false},
    {"permissionKey":"tools:manage_runtime","self":false}
  ],
  "B3_SECURITY_CHIEF": [
    {"permissionKey":"agents:configure","self":true},
    {"permissionKey":"tasks:assign_scope","self":true},
    {"permissionKey":"tasks:manage_active_checkouts","self":true},
    {"permissionKey":"tools:view_audit","self":false},
    {"permissionKey":"audit:view_agent_actions","self":false},
    {"permissionKey":"agents:suggest-changes","self":true},
    {"permissionKey":"skills:suggest-changes","self":false}
  ],
  "B4_FINANCE_CHIEF": [
    {"permissionKey":"agents:configure","self":true},
    {"permissionKey":"tasks:assign_scope","self":true},
    {"permissionKey":"tasks:manage_active_checkouts","self":true},
    {"permissionKey":"skills:suggest-changes","self":false}
  ],
  "B5_LEGAL_COMPLIANCE_CHIEF": [
    {"permissionKey":"agents:configure","self":true},
    {"permissionKey":"tasks:assign_scope","self":true},
    {"permissionKey":"tasks:manage_active_checkouts","self":true},
    {"permissionKey":"audit:view_agent_actions","self":false},
    {"permissionKey":"agents:suggest-changes","self":true},
    {"permissionKey":"skills:suggest-changes","self":false}
  ],
  "C1_DIRECTOR_BUILDER": [
    {"permissionKey":"agents:configure","self":true},
    {"permissionKey":"tasks:assign_scope","self":true},
    {"permissionKey":"tasks:manage_active_checkouts","self":true},
    {"permissionKey":"skills:suggest-changes","self":false}
  ],
  "C2_PLATFORM_DIRECTOR": [
    {"permissionKey":"agents:configure","self":true},
    {"permissionKey":"tasks:assign_scope","self":true},
    {"permissionKey":"tasks:manage_active_checkouts","self":true},
    {"permissionKey":"environments:manage","self":false},
    {"permissionKey":"tools:manage_connections","self":false},
    {"permissionKey":"tools:view_audit","self":false},
    {"permissionKey":"tools:manage_runtime","self":false},
    {"permissionKey":"skills:suggest-changes","self":false}
  ],
  "C3_SECURITY_DIRECTOR": [
    {"permissionKey":"agents:configure","self":true},
    {"permissionKey":"tasks:assign_scope","self":true},
    {"permissionKey":"tasks:manage_active_checkouts","self":true},
    {"permissionKey":"tools:view_audit","self":false},
    {"permissionKey":"agents:suggest-changes","self":true},
    {"permissionKey":"skills:suggest-changes","self":false}
  ],
  "D1_MANAGER": [
    {"permissionKey":"tasks:assign_scope","self":true},
    {"permissionKey":"tasks:manage_active_checkouts","self":true}
  ],
  "D2_ORCHESTRATION_MANAGER": [
    {"permissionKey":"tasks:assign_scope","self":true}
  ],
  "E0_SPECIALIST": [],
  "E1_REVIEWER_COACH": [
    {"permissionKey":"agents:suggest-changes","self":false},
    {"permissionKey":"skills:suggest-changes","self":false}
  ],
  "E2_TOOLING_ADMIN": [
    {"permissionKey":"tools:admin","self":false},
    {"permissionKey":"tools:manage_connections","self":false},
    {"permissionKey":"tools:view_audit","self":false},
    {"permissionKey":"tools:use","self":false},
    {"permissionKey":"tools:manage_runtime","self":false},
    {"permissionKey":"tasks:assign_scope","self":true}
  ],
  "E3_PIPELINE_BUILDER": [
    {"permissionKey":"pipelines:write","self":false},
    {"permissionKey":"tasks:assign_scope","self":true}
  ],
  "E4_AUDIT_ANALYST": [
    {"permissionKey":"audit:view_agent_actions","self":false},
    {"permissionKey":"tools:view_audit","self":false}
  ]
}'

# ---------------------------------------------------------------------------
# Delegation ceiling — report section 8.3, verbatim.
# Templates absent from this map (P0_OWNER, P1_PRESIDENT_COO, every E*) have an
# empty may_create list and therefore cannot provision anything.
# ---------------------------------------------------------------------------
CEILING_JSON='{
  "P1_PRESIDENT_COO": ["B1_FUNCTION_CHIEF","B2_TECH_CHIEF","B3_SECURITY_CHIEF","B4_FINANCE_CHIEF","B5_LEGAL_COMPLIANCE_CHIEF","C1_DIRECTOR_BUILDER","C2_PLATFORM_DIRECTOR","C3_SECURITY_DIRECTOR","D1_MANAGER","D2_ORCHESTRATION_MANAGER","E0_SPECIALIST","E1_REVIEWER_COACH","E2_TOOLING_ADMIN","E3_PIPELINE_BUILDER","E4_AUDIT_ANALYST"],
  "B1_FUNCTION_CHIEF": ["C1_DIRECTOR_BUILDER","D1_MANAGER","D2_ORCHESTRATION_MANAGER","E0_SPECIALIST","E1_REVIEWER_COACH","E3_PIPELINE_BUILDER"],
  "B2_TECH_CHIEF": ["C1_DIRECTOR_BUILDER","C2_PLATFORM_DIRECTOR","D1_MANAGER","D2_ORCHESTRATION_MANAGER","E0_SPECIALIST","E1_REVIEWER_COACH","E2_TOOLING_ADMIN","E3_PIPELINE_BUILDER"],
  "B3_SECURITY_CHIEF": ["C3_SECURITY_DIRECTOR","D1_MANAGER","E0_SPECIALIST","E1_REVIEWER_COACH","E4_AUDIT_ANALYST"],
  "B4_FINANCE_CHIEF": ["C1_DIRECTOR_BUILDER","D1_MANAGER","E0_SPECIALIST","E1_REVIEWER_COACH"],
  "B5_LEGAL_COMPLIANCE_CHIEF": ["C1_DIRECTOR_BUILDER","D1_MANAGER","E0_SPECIALIST","E1_REVIEWER_COACH","E4_AUDIT_ANALYST"],
  "C1_DIRECTOR_BUILDER": ["D1_MANAGER","D2_ORCHESTRATION_MANAGER","E0_SPECIALIST","E1_REVIEWER_COACH","E3_PIPELINE_BUILDER"],
  "C2_PLATFORM_DIRECTOR": ["D1_MANAGER","D2_ORCHESTRATION_MANAGER","E0_SPECIALIST","E1_REVIEWER_COACH","E2_TOOLING_ADMIN","E3_PIPELINE_BUILDER"],
  "C3_SECURITY_DIRECTOR": ["D1_MANAGER","E0_SPECIALIST","E1_REVIEWER_COACH","E4_AUDIT_ANALYST"],
  "D1_MANAGER": ["E0_SPECIALIST","E1_REVIEWER_COACH"],
  "D2_ORCHESTRATION_MANAGER": [],
  "P0_OWNER": [],
  "P2_OWNER_COS": [],
  "P3_AUDIT_RISK": [],
  "P4_PROVISIONING_STEWARD": [],
  "E0_SPECIALIST": [],
  "E1_REVIEWER_COACH": [],
  "E2_TOOLING_ADMIN": [],
  "E3_PIPELINE_BUILDER": [],
  "E4_AUDIT_ANALYST": []
}'

# Resolve an agent by org role id OR uuid. Emits "<id>\t<template>\t<title>".
lookup_agent() {
  PGV_COMPANY_ID="$COMPANY_ID" PGV_TEXT="$1" pcsql -Atq -F$'\t' <<'SQL'
SELECT a.id::text,
       COALESCE(a.metadata->>'permissionProfile',''),
       a.title
FROM agents a
WHERE a.company_id = :'company_id'::uuid
  AND a.status <> 'terminated'
  AND (a.metadata->>'orgRoleId' = :'text' OR a.id::text = :'text')
ORDER BY a.created_at
LIMIT 1;
SQL
}

# True when descendant is inside ancestor's reporting subtree.
is_descendant_of() {
  local ancestor="$1" descendant="$2" res
  res="$(PGV_COMPANY_ID="$COMPANY_ID" PGV_AGENT_ID="$ancestor" PGV_TEXT="$descendant" pcsql -Atq <<'SQL'
WITH RECURSIVE sub AS (
  SELECT id FROM agents WHERE company_id = :'company_id'::uuid AND id = :'agent_id'::uuid
  UNION ALL
  SELECT a.id FROM agents a JOIN sub s ON a.reports_to = s.id
  WHERE a.company_id = :'company_id'::uuid
)
SELECT EXISTS (SELECT 1 FROM sub WHERE id = :'text'::uuid AND id <> :'agent_id'::uuid);
SQL
)"
  [[ "$res" == "t" ]]
}

log_event() {
  # Immutable append-only provisioning/grant log (invariant 9).
  printf '%s\n' "$1" >> "$GRANT_LOG"
  chmod 0600 "$GRANT_LOG" 2>/dev/null || true
}

# The human user id this provisioner writes into `granted_by_user_id`.
#
# The column is USER-TYPED — there is no agent-typed grantor column anywhere in
# `principal_permission_grants` — and this tool is operator-run by design (see
# the header). So the truthful value is the operator who executed the command,
# with the REQUESTING AGENT recorded separately in activity_log. That is the
# two-key shape the grant log needs: who asked, and who actually ran it.
#
# This RESOLVES rather than guesses. If the company does not have exactly one
# active owner, it refuses instead of picking one — attributing a grant to the
# wrong human is worse than the null this whole change exists to remove.
PROVISIONER_OPERATOR_USER_ID="${PROVISIONER_OPERATOR_USER_ID:-}"
resolve_operator_user_id() {
  [[ -n "$PROVISIONER_OPERATOR_USER_ID" ]] && { printf '%s' "$PROVISIONER_OPERATOR_USER_ID"; return; }
  local rows n
  rows="$(PGV_COMPANY_ID="$COMPANY_ID" pcsql -Atq <<'SQL'
SELECT principal_id FROM company_memberships
WHERE company_id = :'company_id'::uuid
  AND principal_type = 'user' AND membership_role = 'owner' AND status = 'active';
SQL
)"
  # `grep -c .` counts NON-EMPTY lines. `wc -l` would score the empty string as
  # 1 on some shells and 0 on others, and "found 1 owner" from an empty read is
  # the failure this whole card is about.
  n="$(grep -c . <<<"$rows" || true)"
  [[ "$n" == "1" ]] || die "cannot resolve the operator user id: found $n active owners for this company. Set PROVISIONER_OPERATOR_USER_ID explicitly."
  printf '%s' "$rows"
}

# apply_exact_grants <agent_id> <grants_json> <requesting_agent_id>
#
# TOG-870. This function used to write grants with a raw INSERT that named no
# grantor at all, and it is the reason 25 rows on this board are the only ones
# whose author cannot be recovered by ANY means. Every other anonymous row can
# be recovered by joining activity_log on (entity_id, timestamp); these could
# not, because bypassing the API meant no activity_log row was ever written.
#
# TWO columns now carry attribution and BOTH are required:
#
#   granted_by_user_id  the operator who ran the command. It is the only
#                       attribution the grants table itself can hold.
#   an activity_log row the REQUESTING AGENT, which the user-typed column
#                       cannot express. This is what the recovery join reads,
#                       and it is what makes an agent-initiated grant
#                       attributable at all.
#
# Both are written INSIDE the same transaction as the grants. A grant that
# commits without its attribution is the exact defect being fixed here, and
# leaving the activity insert outside the transaction would reintroduce it on
# any partial failure.
#
# The requesting agent id is a REQUIRED argument with no default. A default
# would silently restore anonymous rows the first time a new call site forgot
# to pass it — which is precisely how the original 25 were written.
apply_exact_grants() {
  local agent_id="$1" grants_json="$2" requested_by="${3:-}" operator
  [[ -n "$requested_by" ]] || die "apply_exact_grants: refusing to write grants with no requesting agent (an unattributed grant is unrecoverable)."
  operator="$(resolve_operator_user_id)" || return 1
  PGV_COMPANY_ID="$COMPANY_ID" PGV_AGENT_ID="$agent_id" PGV_GRANTS="$grants_json" \
  PGV_A="$operator" PGV_B="$requested_by" \
    pcsql -q >/dev/null <<'SQL'
BEGIN;
INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
VALUES (:'company_id'::uuid, 'agent', :'agent_id', 'active', 'member')
ON CONFLICT (company_id, principal_type, principal_id)
DO UPDATE SET status = 'active', updated_at = NOW();

-- Invariant 4: REPLACE. This is what removes the server's automatic
-- company-wide tasks:assign grant applied at creation time.
DELETE FROM principal_permission_grants
WHERE company_id = :'company_id'::uuid
  AND principal_type = 'agent'
  AND principal_id = :'agent_id';

INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key, scope, granted_by_user_id)
SELECT :'company_id'::uuid, 'agent', :'agent_id', g->>'permissionKey',
       CASE WHEN g->'scope' IS NULL OR g->'scope' = 'null'::jsonb THEN NULL ELSE g->'scope' END,
       :'a'
FROM jsonb_array_elements(:'grants'::jsonb) AS g;

-- The recovery row. `entity_id` is the principal RECEIVING the grants, which
-- is the key the attribution join uses; `actor_id` is the agent that asked.
-- The action must stay one of the strings scripts/grant_attribution.js reads
-- as grant-bearing, or these rows become invisible to the audit again.
INSERT INTO activity_log
  (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, details, responsible_user_id)
VALUES
  (:'company_id'::uuid, 'agent', :'b', 'agent.permissions_updated', 'agent', :'agent_id',
   :'b'::uuid,
   jsonb_build_object(
     'source', 'org_provisioner.sh',
     'operatorUserId', :'a',
     'permissionKeys', (SELECT COALESCE(jsonb_agg(g->>'permissionKey'), '[]'::jsonb)
                          FROM jsonb_array_elements(:'grants'::jsonb) AS g)),
   :'a');
COMMIT;
SQL
}

read_effective_access() {
  local ref="$1" row id
  row="$(lookup_agent "$ref")"; [[ -n "$row" ]] || die "no such agent: $ref"
  id="$(cut -f1 <<<"$row")"
  PGV_COMPANY_ID="$COMPANY_ID" PGV_AGENT_ID="$id" pcsql -Atq -F$'\t' <<'SQL'
SELECT COALESCE(a.metadata->>'orgRoleId', a.title),
       COALESCE(a.metadata->>'permissionProfile','(none)'),
       COALESCE(p.metadata->>'orgRoleId', p.title, 'ROOT (Owner/Board)'),
       COALESCE(g.permission_key,'(no governance grants)'),
       CASE WHEN g.scope IS NULL THEN 'company-wide'
            WHEN g.scope = jsonb_build_object('subtreeRootAgentId', a.id::text) THEN 'SELF-subtree'
            ELSE g.scope::text END
FROM agents a
LEFT JOIN agents p ON p.id = a.reports_to
LEFT JOIN principal_permission_grants g
  ON g.company_id = a.company_id AND g.principal_type = 'agent' AND g.principal_id = a.id::text
WHERE a.id = :'agent_id'::uuid
ORDER BY 4;
SQL
}

cmd_create() {
  assert_enabled
  local caller_ref="" template="" title="" capabilities=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --caller) caller_ref="$2"; shift 2;;
      --template) template="$2"; shift 2;;
      --title) title="$2"; shift 2;;
      --capabilities) capabilities="$2"; shift 2;;
      --reports-to|--parent)
        # Invariant 3: placement is the service's decision, never the caller's.
        die "reportsTo cannot be supplied by the caller; the service sets it to the caller's own subtree.";;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$caller_ref" && -n "$template" && -n "$title" ]] \
    || die "usage: create --caller <ROLE> --template <TEMPLATE> --title <TITLE>"

  local row caller_id caller_template
  row="$(lookup_agent "$caller_ref")"; [[ -n "$row" ]] || die "caller not found in company: $caller_ref"
  caller_id="$(cut -f1 <<<"$row")"
  caller_template="$(cut -f2 <<<"$row")"
  [[ -n "$caller_template" ]] || die "caller has no permissionProfile; refusing to infer authority."

  # Invariants 2 + 6 plus the independent chief/enterprise-role assertions.
  # The function is pure and sourceable for tests; this mutating entry point has
  # no environment seam and always supplies the literal catalogs above.
  if ! create_policy_check "$caller_template" "$template" "$CEILING_JSON" "$TEMPLATES_JSON"; then
    if [[ "$CREATE_POLICY_REASON" == "template_above_ceiling" ]]; then
      echo "  caller template : $caller_template" >&2
      echo "  requested       : $template" >&2
      echo "  permitted       : ${CREATE_POLICY_ALLOWED:-(none - this role may not provision)}" >&2
    fi
    log_event "$(jq -cn --arg c "$caller_template" --arg cid "$caller_id" --arg r "$template" \
      --arg reason "$CREATE_POLICY_REASON" \
      '{event:"create.refused",reason:$reason,callerTemplate:$c,callerAgentId:$cid,requestedTemplate:$r}')"
    die "$CREATE_POLICY_MESSAGE"
  fi

  # Create natively. Invariant 1/3: reportsTo is the CALLER, chosen here.
  #
  # Invariant 13 (TOG-689): the cheap model profile is born with an explicitly
  # FALSY `effort`. `effort` is valid on the claude_local CLI lane and ships in
  # that adapter's own default cheap profile, but the ACP engine lane refuses
  # it -- "does not advertise config option 'effort'" -- and an agent that dies
  # that way cannot self-heal, because self-repair requires it to be running.
  #
  # OMITTING the key does not work. resolveModelProfileApplication spreads the
  # ADAPTER DEFAULT FIRST and the stored profile second, so an absent key is
  # re-supplied as "low" at run time. Both lanes guard on TRUTHINESS, so ""
  # suppresses the ACP option while leaving the CLI lane working.
  #
  # We write it even though the host currently normalizes an absent cheap
  # profile to {enabled:false}, which never reaches the merge and so is already
  # safe TODAY. That safety is incidental, not defensive: the moment anyone
  # flips enabled:true -- the single most likely edit to this profile -- the
  # adapter default reappears and the agent is fatal again. Pinning "" here
  # makes the born state safe in BOTH positions.
  #
  # Scoped to claude_local because that is the adapter whose cheap profile
  # carries `effort`. ADAPTER_TYPE is overridable, and writing a cheap profile
  # for an adapter that does not declare one would invent config the host would
  # then have to validate. Adapters are opted in here explicitly, never by
  # default -- a new adapter with the same defect must be added to this list.
  #
  # TOG-3348: Paperclip migration 0236 (v2026.916.0) deletes
  # runtime_config.modelProfiles outright -- upstream PR #12683 removes the
  # cheap/recovery model distinction entirely (recovery work now runs on the
  # agent's single configured model, there is no replacement field) -- and
  # `shared/validators/agent.ts` rejects the key on every write from then on.
  # Dropping this block pre-upgrade would reopen TOG-689 today; sending it
  # unconditionally post-upgrade would 400 every claude_local agent creation.
  # Neither timing is known in advance from here, so `build_create_payload`
  # is tried WITH the legacy field first and, only if the host's response
  # names `modelProfiles` as the rejection, retried once WITHOUT it -- "attempt
  # the action and read the failure reason," not a version guess.
  local payload out new_id cheap_profile_json='{}'
  case "$ADAPTER_TYPE" in
    claude_local) cheap_profile_json='{"cheap":{"enabled":false,"adapterConfig":{"effort":""}}}' ;;
  esac

  build_create_payload() {
    local cheap="$1"
    jq -cn \
      --arg name "$title" --arg title "$title" --arg parent "$caller_id" \
      --arg adapter "$ADAPTER_TYPE" --arg tpl "$template" --arg cap "$capabilities" \
      --argjson cheap "$cheap" \
      --arg mode "$ASSIGNMENT_BASELINE_MODE" \
      --argjson can_assign "$BASELINE_CAN_ASSIGN_TASKS" \
      --argjson budget "$AGENT_BUDGET_CENTS" '
      {
        name:$name, role:"general", title:$title, capabilities:$cap,
        adapterType:$adapter, adapterConfig:{},
        runtimeConfig:({heartbeat:{enabled:false, wakeOnDemand:false}}
                       + (if ($cheap|length) > 0 then {modelProfiles:$cheap} else {} end)),
        budgetMonthlyCents:$budget,
        permissions:{canCreateAgents:false, canCreateSkills:false, canAssignTasks:$can_assign,
                     authorizationPolicy:{assignmentPolicy:{mode:$mode}}},
        metadata:{permissionProfile:$tpl, provisionedBy:"org_provisioner"},
        reportsTo:$parent
      }'
  }

  # Never let a validation rejection trip `set -e` here -- both attempts must
  # run to completion so the fallback branch below can inspect the response.
  try_create() { pc agent create --company-id "$COMPANY_ID" --payload-json "$1" --json 2>&1 || true; }

  payload="$(build_create_payload "$cheap_profile_json")"
  out="$(try_create "$payload")"
  new_id="$(jq -r '.id // empty' <<<"$out" 2>/dev/null || true)"

  if [[ -z "$new_id" && "$cheap_profile_json" != '{}' ]] && grep -qi 'modelprofiles' <<<"$out"; then
    echo "NOTE: host rejected legacy runtimeConfig.modelProfiles (TOG-3348, migration 0236) -- retrying create without it" >&2
    payload="$(build_create_payload '{}')"
    out="$(try_create "$payload")"
    new_id="$(jq -r '.id // empty' <<<"$out" 2>/dev/null || true)"
  fi
  [[ -n "$new_id" && "$new_id" != "null" ]] || die "agent creation failed: $out"

  # Invariant 11 (as amended by TOG-984): the assignment baseline, plus legacy
  # creator flags still off. Must run BEFORE the grant replacement, because this
  # route itself rewrites the tasks:assign grant -- and apply_exact_grants below
  # is a REPLACE, so whatever this route writes is authoritative only until then.
  # That is why the baseline key is also injected into grants_json: setting the
  # flag here and stopping would leave the agent on the right MODE with the
  # wrong GRANTS, which fails the actor-side half of the check and reproduces
  # the TOG-54 403 on the agent's first hand-back.
  pc agent permissions:update "$new_id" --payload-json \
    "$(jq -cn --arg mode "$ASSIGNMENT_BASELINE_MODE" --argjson can_assign "$BASELINE_CAN_ASSIGN_TASKS" \
       '{canCreateAgents:false, canCreateSkills:false, canAssignTasks:$can_assign,
         authorizationPolicy:{assignmentPolicy:{mode:$mode}}}')" --json >/dev/null

  # Invariant 5: resolve SELF to the NEW agent's id.
  # The template set, plus the company-wide assignment baseline (TOG-984). The
  # baseline is unioned in HERE rather than added to TEMPLATES_JSON on purpose
  # -- see the ASSIGNMENT BASELINE block above; putting `tasks:assign` in a
  # template breaks classify_risk's totality check and stops the request queue.
  local grants_json
  grants_json="$(jq -c --arg id "$new_id" --arg t "$template" \
    --argjson want_assign "$BASELINE_CAN_ASSIGN_TASKS" '
    (.[$t] | map({permissionKey:.permissionKey,
                  scope: (if .self then {subtreeRootAgentId:$id} else null end)}))
    + (if $want_assign then [{permissionKey:"tasks:assign", scope:null}] else [] end)
    | unique_by([.permissionKey, (.scope|tostring)])' \
    <<<"$TEMPLATES_JSON")"

  # The CALLER is the requesting agent: invariant 1 makes it this agent's parent
  # and the principal whose ceiling authorized the template.
  apply_exact_grants "$new_id" "$grants_json" "$caller_id"

  log_event "$(jq -cn --arg cid "$caller_id" --arg ct "$caller_template" --arg nid "$new_id" \
    --arg t "$template" --arg title "$title" --argjson g "$grants_json" \
    --arg mode "$ASSIGNMENT_BASELINE_MODE" --argjson ca "$BASELINE_CAN_ASSIGN_TASKS" \
    '{event:"create.applied",callerAgentId:$cid,callerTemplate:$ct,
      newAgentId:$nid,template:$t,title:$title,reportsTo:$cid,
      previousGrants:["tasks:assign (server default, replaced)"],newGrants:$g,
      assignmentBaseline:{mode:$mode,canAssignTasks:$ca,decision:"TOG-984 owner decision 2026-09-05"}}')"

  echo "PROVISIONED $template -> $new_id ($title), reports to $caller_ref"
  echo "--- effective access ---"
  read_effective_access "$new_id" | awk -F'\t' '{printf "  %-28s %-14s %s\n", $4, $5, ""}'
}

cmd_deactivate() {
  assert_enabled
  local caller_ref="" target_ref=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --caller) caller_ref="$2"; shift 2;;
      --target) target_ref="$2"; shift 2;;
      *) die "unknown argument: $1";;
    esac
  done
  local crow trow caller_id target_id
  crow="$(lookup_agent "$caller_ref")"; [[ -n "$crow" ]] || die "caller not found"
  trow="$(lookup_agent "$target_ref")"; [[ -n "$trow" ]] || die "target not found"
  caller_id="$(cut -f1 <<<"$crow")"; target_id="$(cut -f1 <<<"$trow")"
  # Invariant 1: descendants only — never a peer, parent, or another subtree.
  is_descendant_of "$caller_id" "$target_id" \
    || die "$target_ref is not inside $caller_ref's reporting subtree."
  # A revocation is an attributable act too — arguably more so than a grant.
  # The empty grants array means the activity row is the ONLY record of who
  # stripped this agent's authority.
  apply_exact_grants "$target_id" '[]' "$caller_id"
  pc agent terminate "$target_id" --json >/dev/null
  # Terminating the agent does not retire its company membership, and a stale
  # 'active' membership is exactly the drift the access review flags. Archive it
  # to the same terminal status the native archiveMember route uses.
  PGV_COMPANY_ID="$COMPANY_ID" PGV_AGENT_ID="$target_id" pcsql -q >/dev/null <<'SQL'
UPDATE company_memberships
   SET status = 'archived', updated_at = NOW()
 WHERE company_id = :'company_id'::uuid
   AND principal_type = 'agent'
   AND principal_id = :'agent_id';
SQL
  log_event "$(jq -cn --arg c "$caller_id" --arg t "$target_id" \
    '{event:"deactivate.applied",callerAgentId:$c,targetAgentId:$t,newGrants:[]}')"
  echo "DEACTIVATED $target_ref (grants stripped, agent terminated)"
}

cmd_tree() {
  PGV_COMPANY_ID="$COMPANY_ID" pcsql -P pager=off <<'SQL'
WITH RECURSIVE t AS (
  SELECT id, title, metadata, reports_to, 0 AS depth,
         COALESCE(metadata->>'orgRoleId', metadata->>'permissionProfile', title) AS sortkey
  FROM agents WHERE company_id = :'company_id'::uuid AND reports_to IS NULL AND status <> 'terminated'
  UNION ALL
  SELECT a.id, a.title, a.metadata, a.reports_to, t.depth + 1,
         t.sortkey || '/' || COALESCE(a.metadata->>'orgRoleId', a.title)
  FROM agents a JOIN t ON a.reports_to = t.id
  WHERE a.company_id = :'company_id'::uuid AND a.status <> 'terminated'
)
SELECT repeat('    ', depth) || COALESCE(metadata->>'orgRoleId','·') || ' ' || title AS org,
       COALESCE(metadata->>'permissionProfile','(built-in)') AS template,
       (SELECT count(*) FROM principal_permission_grants g
         WHERE g.company_id = :'company_id'::uuid AND g.principal_type='agent'
           AND g.principal_id = t.id::text) AS grants
FROM t ORDER BY sortkey;
SQL
}

# `column` is util-linux and is NOT installed in the paperclip agent container.
# It does not error there, it prints NOTHING — so a reader piped through it sees
# an empty catalog rather than a failure. `ceiling` is read by
# org_request_queue.sh's may_create(), which means on such a box every ceiling
# check answered "not in the ceiling" and every request was refused at submit.
# Fail-closed, so nothing was ever wrongly granted, but it is still a catalog
# that silently reads as empty, and the risk classifier added in TOG-388 must
# never inherit that failure mode. Ugly and complete beats pretty and absent.
tabulate() { if command -v column >/dev/null 2>&1; then column -t -s$'\t'; else cat; fi; }

case "${1:-}" in
  create)     shift; cmd_create "$@";;
  deactivate) shift; cmd_deactivate "$@";;
  access)     shift; read_effective_access "${1:?agent ref}" \
                | awk -F'\t' 'NR==1{printf "%s  [%s]  parent=%s\n",$1,$2,$3} {printf "  %-30s %s\n",$4,$5}';;
  tree)       cmd_tree;;
  templates)  jq -r 'to_entries[] | "\(.key)\t\(.value|map(.permissionKey + (if .self then "(SELF)" else "" end))|join(", ")//"(no governance grants)")"' <<<"$TEMPLATES_JSON" | tabulate;;
  ceiling)    jq -r 'to_entries[] | "\(.key)\t\(.value|join(", ")//"(may not provision)")"' <<<"$CEILING_JSON" | tabulate;;
  # MACHINE-READABLE catalog: "<template>\t<key,key,...>", one row per template,
  # never padded and never piped through anything optional. `templates` above is
  # the human view and carries "(SELF)" markers and alignment; a parser must not
  # have to strip either. A template with no governance grants emits an EMPTY
  # second field rather than a placeholder word, so "no keys" and "a key called
  # (no governance grants)" cannot be confused.
  template-keys)
    jq -r 'to_entries[] | "\(.key)\t\(.value|map(.permissionKey)|join(","))"' <<<"$TEMPLATES_JSON";;
  *) sed -n '/^# USAGE/,/^# Kill switch/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//';;
esac
