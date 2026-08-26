#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# capability_gate.sh — the capability request + approval gate (TOG-387)
# ---------------------------------------------------------------------------
# An agent that needs a CAPABILITY it does not hold asks for it here, states
# the facts and the reasoning, and a responsible agent decides — or the gate
# says, on the record, that no agent may decide it and it stops for the owner.
#
#   requester (any live agent)  --submit-->  classified request
#   domain owner                --review-->  approved | awaiting custody | denied
#   custodian (CISO)        --countersign->  approved | denied
#   owner-reserved                        ->  NO AGENT MAY DECIDE. Stops here.
#
# It is the sibling of org_request_queue.sh, which brokers ORG PROVISIONING —
# "seat me an agent" — and shares its record layer (lib/reqrecord.sh) and its
# offline seams. It is a separate tool because the two differ in the only place
# that matters: WHO DECIDES. Provisioning derives authority from the delegation
# ceiling ("a leader may only approve what it could have done itself"), which
# is meaningless for a capability — there is no ceiling that says who may hand
# out a GitHub token. Capabilities derive authority from ownership of the
# domain, and custody of a credential is a second, independent key.
#
# ===========================================================================
# THE OWNER'S DECISION MODEL, ENCODED (2026-08-25)
# ===========================================================================
# Four asks ALWAYS stop for the owner: real money · deleting or rotating a
# credential · anything published outside the company · anything with no
# rollback. Encoded as OWNER_RESERVED_RULES below, and the encoding has one
# property that matters more than the rules themselves:
#
#   *** THE CLASSIFICATION IS DERIVED FROM THE REGISTRY, NEVER DECLARED BY
#       THE REQUESTER. ***
#
# There is no `--risk` flag, no `--reversible` flag, and no way to assert from
# the command line that an ask is routine. A gate whose risk class is supplied
# by the party asking is not a gate; it is a form. The requester supplies FACTS
# (what is true) and REASONING (why this unblocks the work). The registry
# supplies the CLASS. The two are kept apart on purpose, and every refusal
# below names which of them refused.
#
# An UNREGISTERED capability is owner-reserved (rule `unregistered_capability`),
# not refused. Fail-closed on authority, open on process: the requester still
# has a path, it just is not an agent-decided one, and the remedy — add the
# capability to the registry — is a reviewed commit in this file rather than a
# flag somebody can pass.
#
# ===========================================================================
# SAFER ALTERNATIVE FIRST (TOG-388's model, applied here by TOG-403)
# ===========================================================================
# "Prefer a narrower alternative that still fully unblocks the work over a
# broad grant that merely would." Encoded on BOTH keys:
#
#   ...to DENY, additionally one of:
#       --alternative "<a safer route that still fully unblocks the work>"
#                                                              (repeatable)
#     or
#       --no-safer-alternative "<what you looked at and why nothing works>"
#
#   ...to APPROVE a RISKY ask, at least one adjacent pair:
#       --considered "<route weighed>" --because "<why it did not unblock>"
#
# The flags are exclusive BY DECISION DIRECTION. `--alternative` is a way
# forward and belongs on a denial; `--considered/--because` is a rejected route
# and belongs on an approval. Each wrong combination has its own refusal.
#
# THE IMPLEMENTATION IS NOT A COPY. Parsing, refusal wording and record shape
# all come from `lib/reqrecord.sh`, which org_request_queue.sh now sources too.
# Two copies of the owner's decision model would become two decision models,
# and the divergence is invisible from either side — both files still refuse
# things, just no longer the same things.
#
# WHICH ASKS ARE RISKY is NOT shared, because the two flows read different
# facts: the queue reads a template's permission keys, this file reads the
# registry's `class` and `rollback` (see capability_risk_factors). Both DERIVE
# it; neither lets the decider declare it.
#
# THE COUNTERSIGNATURE IS ALWAYS RISKY, and that is the part TOG-388 had no
# reason to think about. `countersign` only ever runs on a `custody` request,
# which is only ever reached by `class: credential` — so there is no routine
# branch and the alternatives record is unconditional. The denial side is the
# one that matters most in the whole tool: a custodian's refusal is usually
# "not in this form" — a narrower scope, a shorter TTL, a brokered mint rather
# than the key — and a custody denial recording none of that leaves the
# requester blocked by the one agent who already knows the safer shape.
#
# "DOMAIN OWNER DECIDES, CISO HOLDS CUSTODY, TWO KEYS ON THE OWNER LINE."
# Read literally, and the third clause does real work. Where the two keys
# would collapse into one agent — the CISO is the requester, or the CISO owns
# the domain — the request does NOT fall back to one key. It becomes
# owner-reserved (`custody_conflict`). Two keys means two principals; if the
# org cannot supply the second, the owner is the second.
#
# ===========================================================================
# WHAT THIS TOOL DOES NOT DO, STATED LOUDLY
# ===========================================================================
# It does not GRANT anything. An approved request is a decision record with a
# named decider and a stated reason; something else — an operator, a broker, a
# provisioner — acts on it. That boundary is deliberate for now, but "approved"
# that silently does nothing is its own trap, so `list` and `thread` both
# render an approved request as `approved (not yet effected)` and the exit
# contract keeps them distinguishable. Wiring execution is a separate change
# and needs its own re-validation at grant time, exactly as org_request_queue's
# approval path re-reads state before calling the provisioner.
#
# ===========================================================================
# IDENTITY — THE GAP, AND WHAT TOG-399 CLOSED (AND DID NOT)
# ===========================================================================
# `--requester`, `--reviewer` and `--custodian` are UNAUTHENTICATED FLAGS on
# this CLI, the same as org_request_queue.sh's. Measured, not assumed: agent A0
# submitted a request as T0 and approved it as O1 in one shell session (TOG-387
# verification comment). Separation of duties held only because two different
# names were typed; nothing on the command line can tell that one process typed
# both.
#
# THEREFORE: this tool is safe ONLY when run by the operator, or reached through
# a transport that derives identity from an authenticated principal and refuses
# to accept it as an argument. That transport is mcp/org-request-mcp.mjs, and
# TOG-399 forwards these three commands through it: submit_capability_request,
# review_capability_request, countersign_capability_request write --requester /
# --reviewer / --custodian from the authenticated session, never from an
# argument, corroborated against heartbeat_runs. Over that path one process can
# no longer type two keys. Do not expose this CLI to agents over any OTHER path
# that lets the caller name itself.
#
# WHAT THE TRANSPORT DOES NOT CLOSE — say it in the record. On this host,
# concurrent agent runs share a uid and a PID namespace (no hidepid), so any run
# can read another live run's gateway credential out of /proc (32 foreign runs
# were readable, re-measured TOG-399). One actor can therefore drive TWO
# corroborated sessions — two real principals to the database, one actor in
# fact. The custody key is an ORGANIZATIONAL control on an absent TECHNICAL
# boundary until per-run credential isolation lands
# (docs/upstream/agent-run-credential-isolation.md). The only technical second
# key today is the owner/board, whose credential is in no container. Two rows
# with different principals are NOT proof of two keys; do not read them as such.
#
# TEST SEAMS (offline, no database — load-bearing for CI)
#   ORG_SNAPSHOT  path to a TSV org snapshot used instead of the live database:
#                 id \t orgRoleId \t template \t status \t reportsTo \t title
#
# USAGE
#   ./capability_gate.sh registry [--json]
#   ./capability_gate.sh classify   --capability <KEY> --action <ACTION>
#   ./capability_gate.sh who        --capability <KEY> --action <ACTION> \
#                                   [--requester <ROLE>]
#   ./capability_gate.sh submit     --requester <ROLE> --capability <KEY> \
#                                   --action <ACTION> --facts "..." \
#                                   --reasoning "..." [--title "..."]
#   ./capability_gate.sh review     --reviewer <ROLE> --request <ID> \
#                                   (--approve|--reject) --reason "..." \
#                                   [safer-alternative flags, below]
#   ./capability_gate.sh countersign --custodian <ROLE> --request <ID> \
#                                   (--approve|--reject) --reason "..." \
#                                   [safer-alternative flags, below]
#   ./capability_gate.sh comment    --request <ID> --author <ROLE> --body "..."
#   ./capability_gate.sh list       [--status pending|awaiting_custody|approved|
#                                             rejected|owner_reserved|expired|all]
#   ./capability_gate.sh thread     --request <ID>
#   ./capability_gate.sh owner-queue [--json]   # exit 1 if any are waiting
#   ./capability_gate.sh log
# ===========================================================================

COMPANY_ID="${COMPANY_ID:?Set COMPANY_ID}"
PAPERCLIP_DB_CTR="${PAPERCLIP_DB_CTR:-paperclip-db}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

QUEUE="${CAPABILITY_QUEUE:-${QUEUE:-$HERE/capability-request-queue.jsonl}}"
GRANT_LOG="${CAPABILITY_LOG:-${GRANT_LOG:-$HERE/capability-grant-log.jsonl}}"
ORG_SNAPSHOT="${ORG_SNAPSHOT:-}"

REQUEST_TTL_DAYS="${REQUEST_TTL_DAYS:-7}"
MAX_CHAIN_DEPTH="${MAX_CHAIN_DEPTH:-16}"

# The record layer's parameters, set BEFORE sourcing it. See lib/reqrecord.sh
# for why these three diverge from org_request_queue.sh's literals.
REQ_ID_PREFIX="CAP"
REQRECORD_STATUS_EVENTS='{"request.submitted":true,"request.reviewed":true,"request.countersigned":true,"request.expired":true}'
REQRECORD_TERMINAL_EVENTS='{"request.countersigned":true,"request.expired":true}'
REQRECORD_OPEN_STATUSES='pending awaiting_custody'

# The tail of the denial-floor refusal (TOG-403). SET, not inherited: the
# library's default is org_request_queue.sh's, and it names `risk-record` —
# a command this gate does not have. A refusal that tells a custodian to run
# something that does not exist is a dead end wearing the costume of a next
# step, which is the one thing the safer-alternative model exists to prevent.
SAFERALT_NO_ALT_CONSEQUENCE='The second is always recorded on the thread, where `thread` renders it and the
  requester can answer it with `comment`. This gate has no audit-drain command,
  so the finding is read on the thread rather than queued for someone to close.'

command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

# shellcheck source=lib/reqrecord.sh
. "$HERE/lib/reqrecord.sh" || { echo "ERROR: missing $HERE/lib/reqrecord.sh" >&2; exit 1; }
# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; exit 1; }

# NOTE ON TERMINAL EVENTS. `request.reviewed` is NOT terminal here and is in
# org_request_queue.sh. A domain owner's approval of a custody capability moves
# the request to `awaiting_custody`, which is an open state — so counting it as
# terminal would make the countersignature look like a second decision on an
# already-decided request and trip the ambiguity refusal on every two-key
# approval. A rejection at review time IS terminal, and is written as a
# `request.countersigned` row with `key:"domain"` so the one-terminal-decision
# invariant still holds over exactly one event name. The row records which key
# refused; nothing infers it from the event.

pcsql() { pcsql_run -Atq -v ON_ERROR_STOP=1 "$@"; }

# ===========================================================================
# THE CAPABILITY REGISTRY
# ===========================================================================
# The authority map. Editing it is a reviewed commit; there is no runtime path
# that adds an entry, which is the whole reason the classification cannot be
# argued with at the command line.
#
#   domain    orgRoleId of the agent that OWNS this capability's domain and is
#             therefore its responsible decider.
#   class     credential | tool | data | spend | publish | infra
#             `credential` is the custody class: approving one hands over a
#             secret, so the CISO's second key is required.
#   rollback  full | partial | none — can the grant be taken back, and does
#             taking it back undo the effect? `none` is owner-reserved.
#   note      why the entry is classified the way it is. Not decorative: an
#             entry whose classification nobody can explain is an entry
#             somebody will quietly downgrade.
CAPABILITY_REGISTRY='{
  "github.repo.read":        {"domain":"T0","class":"tool",      "rollback":"full",
    "note":"Read-only clone access to a company repository."},
  "github.repo.push":        {"domain":"T0","class":"tool",      "rollback":"partial",
    "note":"Push access. Rollback is partial: a force-push can be reverted, a leaked secret in history cannot."},
  "github.token":            {"domain":"T0","class":"credential","rollback":"full",
    "note":"A minted GitHub App installation token. Custody class — it IS the credential."},
  "github.app.privatekey":   {"domain":"S0","class":"credential","rollback":"none",
    "note":"The App signing key. rollback=none: possession cannot be un-had, and every token it ever mints is downstream."},
  "omniroute.key.self":      {"domain":"T0","class":"credential","rollback":"full",
    "note":"A model-routing key scoped to this company only."},
  "omniroute.key.manage":    {"domain":"S0","class":"credential","rollback":"none",
    "note":"A management-scoped routing key. rollback=none: it can read and rebind OTHER companies keys before revocation lands. See TOG-386."},
  "paperclip.agent.create":  {"domain":"A0","class":"infra",     "rollback":"full",
    "note":"Seating an agent. Brokered by org_request_queue.sh, which enforces the delegation ceiling; listed here so an ask that arrives at the wrong door is ROUTED, not refused."},
  "paperclip.secret.read":   {"domain":"S0","class":"credential","rollback":"none",
    "note":"Reading a stored company secret. rollback=none: a secret that has been read is disclosed whatever happens next."},
  "vps.root.command":        {"domain":"S0","class":"infra",     "rollback":"none",
    "note":"Running a command as root on the host. rollback=none by construction — see TOG-393."},
  "company.spend":           {"domain":"F0","class":"spend",     "rollback":"none",
    "note":"Committing company money. Owner-reserved twice over."},
  "external.publish":        {"domain":"M0","class":"publish",   "rollback":"none",
    "note":"Anything leaving the company: a post, a package, a public repository."}
}'

# The closed set of actions. An action outside it is REFUSED rather than
# classified: a classifier that has never seen a verb cannot know whether it is
# dangerous, and guessing `routine` is the one wrong answer.
VALID_ACTIONS='["read","use","grant","rotate","delete","publish","spend"]'

# Custody is held by a FUNCTION, not a name. Resolving by template rather than
# by orgRoleId means re-seating the CISO under a different role id does not
# silently vacate custody.
CUSTODY_TEMPLATE="${CUSTODY_TEMPLATE:-B3_SECURITY_CHIEF}"

# Facts and reasoning must be present and must be more than a gesture. This is
# a FLOOR, not a quality check — no length threshold can tell an argument from
# a sentence. It exists because "n/a" and "-" are what an unenforced required
# field collects, and a record full of those cannot answer the question the
# owner asked it to answer.
MIN_FACTS_LEN="${MIN_FACTS_LEN:-40}"
MIN_REASONING_LEN="${MIN_REASONING_LEN:-40}"

# ===========================================================================
# WHICH ASKS ARE RISKY (TOG-403)
# ===========================================================================
# The owner's safer-alternative-first model says an approval of a RISKY ask
# must record which safer routes were weighed and why each failed. That needs a
# definition of risky, and it is derived from the REGISTRY — the same two facts
# the registry already carries, read by the same rule for every ask. There is
# no --risk flag here for the same reason there is no --reversible one.
#
# ALLOWLISTS, both of them, and not a `class == credential` test. A denylist
# ("risky unless it is one of the safe ones") silently opts every class added
# later into `routine`, which is the exact failure STATUS_EVENTS documents one
# file over. A new class must be argued into one of these two lists or the gate
# refuses to decide the ask at all.
RISK_CLASSES='{"credential":true,"spend":true,"publish":true}'
NONRISK_CLASSES='{"tool":true,"data":true,"infra":true}'

# capability_risk_factors <capability>
#   stdout: comma-separated factors, empty when routine
#   exit:   0 risky · 1 routine · 2 unregistered · 3 a value in neither list
#
# Exit 2 and 3 are FAIL-CLOSED and the caller must refuse rather than default,
# mirroring classify_risk's contract in org_request_queue.sh. In practice
# neither should reach a reviewer — an unregistered capability is already
# owner-reserved at submit — but "should not reach" is not a control.
capability_risk_factors() {
  local entry class rollback f=""
  entry="$(jq -c --arg k "$1" '.[$k] // empty' <<<"$CAPABILITY_REGISTRY")"
  [[ -n "$entry" ]] || { printf 'unregistered=%s' "$1"; return 2; }
  class="$(jq -r '.class' <<<"$entry")"
  rollback="$(jq -r '.rollback' <<<"$entry")"
  if   jq -e --arg c "$class" '.[$c] // false' <<<"$RISK_CLASSES"    >/dev/null 2>&1; then f="class_$class"
  elif jq -e --arg c "$class" '.[$c] // false' <<<"$NONRISK_CLASSES" >/dev/null 2>&1; then :
  else printf 'class=%s' "$class"; return 3
  fi
  # Rollback that does not undo the effect. `none` never reaches a reviewer —
  # rule no_rollback stops it for the owner — so in practice this is `partial`:
  # the github.repo.push case, where the force-push is revertible and the
  # secret that was in the history is not.
  case "$rollback" in
    full)         :;;
    partial|none) f="${f:+$f,}rollback_$rollback";;
    *) printf 'rollback=%s' "$rollback"; return 3;;
  esac
  printf '%s' "$f"
  [[ -n "$f" ]]
}

# ===========================================================================
# Org resolution — the same two seams org_request_queue.sh uses.
# ===========================================================================
resolve_agent() {
  if [[ -n "$ORG_SNAPSHOT" ]]; then
    awk -F'\t' -v k="$1" '($1==k || $2==k){print; exit}' "$ORG_SNAPSHOT"
    return
  fi
  PGV_COMPANY_ID="$COMPANY_ID" PGV_TEXT="$1" pcsql -F$'\t' <<'SQL'
SELECT a.id::text,
       COALESCE(a.metadata->>'orgRoleId',''),
       COALESCE(a.metadata->>'permissionProfile',''),
       a.status,
       COALESCE(a.reports_to::text,''),
       a.title
FROM agents a
WHERE a.company_id = :'company_id'::uuid
  AND (a.metadata->>'orgRoleId' = :'text' OR a.id::text = :'text')
ORDER BY a.created_at LIMIT 1;
SQL
}

f() { cut -f"$1" <<<"$2"; }   # field $1 of a resolve_agent row

# The live agent holding a given permission template, by template not by name.
resolve_by_template() {
  if [[ -n "$ORG_SNAPSHOT" ]]; then
    awk -F'\t' -v t="$1" '($3==t && $4!="terminated"){print; exit}' "$ORG_SNAPSHOT"
    return
  fi
  PGV_COMPANY_ID="$COMPANY_ID" PGV_TEXT="$1" pcsql -F$'\t' <<'SQL'
SELECT a.id::text,
       COALESCE(a.metadata->>'orgRoleId',''),
       COALESCE(a.metadata->>'permissionProfile',''),
       a.status,
       COALESCE(a.reports_to::text,''),
       a.title
FROM agents a
WHERE a.company_id = :'company_id'::uuid
  AND a.metadata->>'permissionProfile' = :'text'
  AND a.status <> 'terminated'
ORDER BY a.created_at LIMIT 1;
SQL
}

# Nearest LIVE ancestor of $1, walking reports_to upward. Emits a resolve_agent
# row, or nothing. Cycle-safe and depth-bounded: a malformed reporting chain is
# a data error and must not become an infinite loop inside an authority check.
nearest_live_ancestor() {
  local node="$1" seen=" $1 " depth=0 row parent
  row="$(resolve_agent "$node")"; [[ -n "$row" ]] || return 1
  parent="$(f 5 "$row")"
  while [[ -n "$parent" && $depth -lt $MAX_CHAIN_DEPTH ]]; do
    [[ "$seen" != *" $parent "* ]] || return 1      # cycle: fail closed
    seen+="$parent "
    row="$(resolve_agent "$parent")"; [[ -n "$row" ]] || return 1
    if [[ "$(f 4 "$row")" != "terminated" ]]; then printf '%s\n' "$row"; return 0; fi
    parent="$(f 5 "$row")"
    depth=$((depth+1))
  done
  return 1
}

is_descendant_of() {
  local ancestor="$1" node="$2" depth=0 row
  while [[ -n "$node" && $depth -lt $MAX_CHAIN_DEPTH ]]; do
    row="$(resolve_agent "$node")"; [[ -n "$row" ]] || return 1
    node="$(f 5 "$row")"
    [[ "$node" != "$ancestor" ]] || return 0
    depth=$((depth+1))
  done
  return 1
}

# ===========================================================================
# THE CLASSIFIER
# ===========================================================================
# classify_capability <capability> <action> [requesterAgentId]
#
#   stdout: "<mode>\t<deciderRole>\t<custodianRole>\t<rulesJson>"
#   mode:   owner    — owner-reserved; NO AGENT MAY DECIDE
#           custody  — domain owner approves, custodian countersigns (two keys)
#           domain   — domain owner alone decides
#
# rulesJson lists every owner-reserving rule that fired, each with the fact
# that triggered it. All rules are evaluated — the classifier does not stop at
# the first — because "why did this stop for the owner" is a question with more
# than one right answer and the record should carry all of them.
#
# Emitted on stdout rather than set in globals for the reason derive_leader
# documents: every caller invokes this in a command substitution, so a global
# would be mutated in a subshell and arrive empty.
# ---------------------------------------------------------------------------
OWNER_RESERVED_RULES='["real_money","credential_destruction","external_publication","no_rollback","unregistered_capability","no_live_decider","custody_conflict","requester_is_decider_at_root"]'

classify_capability() {
  local cap="$1" action="$2" requester_id="${3:-}"
  local rules='[]'
  local add='. + [{rule:$r,fact:$f}]'

  jq -e --arg a "$action" 'index($a) != null' <<<"$VALID_ACTIONS" >/dev/null 2>&1 \
    || { printf 'invalid\t\t\t%s\n' "$(jq -cn --arg a "$action" '[{rule:"unknown_action",fact:$a}]')"; return; }

  local entry; entry="$(jq -c --arg k "$cap" '.[$k] // empty' <<<"$CAPABILITY_REGISTRY")"

  if [[ -z "$entry" ]]; then
    # Fail closed on authority. An unknown capability has no known domain
    # owner, no known rollback and no known class, so there is nothing an agent
    # could be deciding ON. It goes to the owner.
    rules="$(jq -c --arg r unregistered_capability --arg f "$cap" "$add" <<<"$rules")"
    printf 'owner\t\t\t%s\n' "$rules"
    return
  fi

  local domain class rollback
  domain="$(jq -r '.domain' <<<"$entry")"
  class="$(jq -r '.class' <<<"$entry")"
  rollback="$(jq -r '.rollback' <<<"$entry")"

  # --- the owner's four, in the owner's words ------------------------------
  # 1. real money
  [[ "$action" == "spend" || "$class" == "spend" ]] \
    && rules="$(jq -c --arg r real_money --arg f "action=$action class=$class" "$add" <<<"$rules")"
  # 2. deleting or rotating a credential
  [[ ( "$action" == "rotate" || "$action" == "delete" ) && "$class" == "credential" ]] \
    && rules="$(jq -c --arg r credential_destruction --arg f "action=$action class=credential" "$add" <<<"$rules")"
  # 3. anything published outside the company
  [[ "$action" == "publish" || "$class" == "publish" ]] \
    && rules="$(jq -c --arg r external_publication --arg f "action=$action class=$class" "$add" <<<"$rules")"
  # 4. anything with no rollback
  [[ "$rollback" == "none" ]] \
    && rules="$(jq -c --arg r no_rollback --arg f "rollback=none" "$add" <<<"$rules")"

  # --- who would decide it, if anyone may ----------------------------------
  # INITIALISED, not merely declared. `local d_role` under `set -u` is an
  # UNSET variable, and the no-live-decider branch below never assigns it — so
  # the first `[[ -n "$d_id" ]]` aborted this function mid-way and it emitted
  # NOTHING. An empty mode is not "owner", so cmd_submit filed the request as
  # `pending`: an ask that should have stopped for the owner instead sat in a
  # queue nobody reviews and never appeared in `owner-queue`. Nothing errored.
  # Caught by section 4 of the suite, which is why that section asserts the
  # MODE rather than only that a refusal happened.
  local drow d_role="" d_id=""
  drow="$(resolve_agent "$domain")"
  if [[ -n "$drow" && "$(f 4 "$drow")" == "terminated" ]]; then
    drow="$(nearest_live_ancestor "$(f 1 "$drow")")" || drow=""
  fi
  if [[ -z "$drow" ]]; then
    rules="$(jq -c --arg r no_live_decider --arg f "domain=$domain" "$add" <<<"$rules")"
  else
    d_id="$(f 1 "$drow")"; d_role="$(f 2 "$drow")"; d_role="${d_role:-$d_id}"
    # Separation of duties, at classification time so `who` tells the truth
    # before anything is submitted. A requester that owns the domain cannot be
    # its own decider; the ask escalates one live level up. If there is no
    # level up, the requester is at the root of the chain and the only
    # remaining second pair of eyes is the owner's.
    if [[ -n "$requester_id" && "$requester_id" == "$d_id" ]]; then
      local up; up="$(nearest_live_ancestor "$d_id")" || up=""
      if [[ -z "$up" ]]; then
        rules="$(jq -c --arg r requester_is_decider_at_root --arg f "$d_role" "$add" <<<"$rules")"
        d_role=""; d_id=""
      else
        d_id="$(f 1 "$up")"; d_role="$(f 2 "$up")"; d_role="${d_role:-$d_id}"
      fi
    fi
  fi

  # --- custody: the second key ---------------------------------------------
  local cust_role="" cust_id=""
  if [[ "$class" == "credential" ]]; then
    local crow; crow="$(resolve_by_template "$CUSTODY_TEMPLATE")"
    if [[ -z "$crow" ]]; then
      rules="$(jq -c --arg r custody_conflict --arg f "no live $CUSTODY_TEMPLATE to hold custody" "$add" <<<"$rules")"
    else
      cust_id="$(f 1 "$crow")"; cust_role="$(f 2 "$crow")"; cust_role="${cust_role:-$cust_id}"
      # TWO KEYS MEANS TWO PRINCIPALS. Where they would collapse into one
      # agent the request does not quietly become a one-key approval — the
      # owner becomes the second key. This is the "two keys on the owner line"
      # clause doing work rather than decorating the sentence.
      if [[ -n "$requester_id" && "$cust_id" == "$requester_id" ]]; then
        rules="$(jq -c --arg r custody_conflict --arg f "custodian $cust_role is the requester" "$add" <<<"$rules")"
      elif [[ -n "$d_id" && "$cust_id" == "$d_id" ]]; then
        rules="$(jq -c --arg r custody_conflict --arg f "custodian $cust_role is also the domain owner" "$add" <<<"$rules")"
      fi
    fi
  fi

  if jq -e 'length > 0' <<<"$rules" >/dev/null; then
    printf 'owner\t%s\t%s\t%s\n' "$d_role" "$cust_role" "$rules"
  elif [[ "$class" == "credential" ]]; then
    printf 'custody\t%s\t%s\t%s\n' "$d_role" "$cust_role" "$rules"
  else
    printf 'domain\t%s\t%s\t%s\n' "$d_role" "$cust_role" "$rules"
  fi
}

explain_rules() {   # human-readable, one per line, indented
  jq -r '.[] | "    - \(.rule): \(.fact)"' <<<"$1" 2>/dev/null
}

# ===========================================================================
reap_expired() {
  [[ -f "$QUEUE" ]] || return 0
  local rows rid exp
  rows="$(jq -s -r --argjson ev "$REQRECORD_STATUS_EVENTS" --arg open "$REQRECORD_OPEN_STATUSES" '
      ($open | split(" ")) as $o
      | map(select($ev[.event] // false))
      | group_by(.requestId)
      | map({rid: .[0].requestId, exp: (.[0].expiresAt // ""), last: .[-1].status})
      | map(select((.last as $s | $o | index($s)) != null and .exp != ""))
      | .[] | "\(.rid)\t\(.exp)"' "$QUEUE" 2>/dev/null)"
  [[ -n "$rows" ]] || return 0
  while IFS=$'\t' read -r rid exp; do
    [[ -n "$rid" ]] || continue
    expired "$exp" && append_queue "$(jq -cn --arg id "$rid" --arg at "$(now_iso)" --arg e "$exp" \
      '{event:"request.expired",requestId:$id,status:"expired",at:$at,expiredAt:$e}')"
  done <<<"$rows"
  return 0
}

# ===========================================================================
cmd_registry() {
  local fmt="text"
  [[ "${1:-}" == "--json" ]] && fmt="json"
  if [[ "$fmt" == "json" ]]; then printf '%s\n' "$CAPABILITY_REGISTRY" | jq .; return 0; fi
  { printf 'CAPABILITY\tDOMAIN\tCLASS\tROLLBACK\tNOTE\n'
    jq -r 'to_entries[] | [.key, .value.domain, .value.class, .value.rollback, .value.note] | @tsv' \
       <<<"$CAPABILITY_REGISTRY"; } | tabulate
  echo
  echo "actions: $(jq -r 'join(", ")' <<<"$VALID_ACTIONS")"
  echo "custody is held by whichever live agent carries $CUSTODY_TEMPLATE"
}

cmd_classify() {
  local cap="" action="" requester=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --capability) cap="$2";    shift 2;;
      --action)     action="$2"; shift 2;;
      --requester)  requester="$2"; shift 2;;
      # There is no --risk, --reversible or --routine, and adding one voids the
      # gate. See the header.
      --risk|--reversible|--routine|--severity)
        die "the risk class is derived from the registry, never supplied by the requester; '$1' does not exist.";;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$cap" && -n "$action" ]] || die "usage: classify --capability <KEY> --action <ACTION>"
  local rid=""
  if [[ -n "$requester" ]]; then
    local rrow; rrow="$(resolve_agent "$requester")"; [[ -n "$rrow" ]] || die "requester not found: $requester"
    rid="$(f 1 "$rrow")"
  fi
  local c; c="$(classify_capability "$cap" "$action" "$rid")"
  printf '%s\t%s\t%s\t%s\n' "$(f 1 "$c")" "$(f 2 "$c")" "$(f 3 "$c")" "$(f 4 "$c")"
}

cmd_who() {
  local cap="" action="" requester=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --capability) cap="$2";       shift 2;;
      --action)     action="$2";    shift 2;;
      --requester)  requester="$2"; shift 2;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$cap" && -n "$action" ]] || die "usage: who --capability <KEY> --action <ACTION> [--requester <ROLE>]"
  local rid=""
  if [[ -n "$requester" ]]; then
    local rrow; rrow="$(resolve_agent "$requester")"; [[ -n "$rrow" ]] || die "requester not found: $requester"
    rid="$(f 1 "$rrow")"
  fi
  local c mode decider cust rules
  c="$(classify_capability "$cap" "$action" "$rid")"
  mode="$(f 1 "$c")"; decider="$(f 2 "$c")"; cust="$(f 3 "$c")"; rules="$(f 4 "$c")"
  case "$mode" in
    invalid) die "'$action' is not a known action; known actions: $(jq -r 'join(", ")' <<<"$VALID_ACTIONS")";;
    owner)
      echo "OWNER-RESERVED — no agent may decide this."
      explain_rules "$rules"
      [[ -n "$decider" ]] && echo "    (the domain owner would have been $decider, and is not enough on its own)"
      return 0;;
    custody)
      echo "TWO KEYS: $decider decides, $cust countersigns as custodian."; return 0;;
    domain)
      echo "ONE KEY: $decider decides."; return 0;;
  esac
}

# ===========================================================================
cmd_submit() {
  local requester="" cap="" action="" facts="" reasoning="" title=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --requester)  requester="$2"; shift 2;;
      --capability) cap="$2";       shift 2;;
      --action)     action="$2";    shift 2;;
      --facts)      facts="$2";     shift 2;;
      --reasoning)  reasoning="$2"; shift 2;;
      --title)      title="$2";     shift 2;;
      --risk|--reversible|--routine|--severity|--owner-reserved|--no-owner-review)
        die "the risk class is derived from the registry, never supplied by the requester; '$1' does not exist.";;
      --reviewer|--decider|--custodian)
        die "the decider is derived from the capability, never chosen by the requester; '$1' does not exist on submit.";;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$requester" && -n "$cap" && -n "$action" ]] \
    || die "usage: submit --requester <ROLE> --capability <KEY> --action <ACTION> --facts \"...\" --reasoning \"...\""

  # FACTS AND REASONING, before anything else is read, so the refusal cannot
  # depend on who is asking or on what was asked for.
  [[ -n "$facts" ]] || die "--facts is required: state what is TRUE — what you tried, what failed, what you measured."
  [[ -n "$reasoning" ]] || die "--reasoning is required: state WHY this capability unblocks the work."
  [[ ${#facts} -ge $MIN_FACTS_LEN ]] \
    || die "--facts is $((${#facts})) characters; the floor is $MIN_FACTS_LEN. A request that cannot be audited later is not a request."
  [[ ${#reasoning} -ge $MIN_REASONING_LEN ]] \
    || die "--reasoning is $((${#reasoning})) characters; the floor is $MIN_REASONING_LEN."

  reap_expired

  local row rq_id rq_tpl rq_status
  row="$(resolve_agent "$requester")"; [[ -n "$row" ]] || die "requester not found: $requester"
  rq_id="$(f 1 "$row")"; rq_tpl="$(f 3 "$row")"; rq_status="$(f 4 "$row")"
  [[ "$rq_status" != "terminated" ]] || die "requester $requester is terminated."

  local c mode decider cust rules
  c="$(classify_capability "$cap" "$action" "$rq_id")"
  mode="$(f 1 "$c")"; decider="$(f 2 "$c")"; cust="$(f 3 "$c")"; rules="$(f 4 "$c")"

  if [[ "$mode" == "invalid" ]]; then
    log_event "$(jq -cn --arg r "$requester" --arg a "$action" \
      '{event:"request.refused",reason:"unknown_action",requester:$r,action:$a}')"
    die "'$action' is not a known action; known actions: $(jq -r 'join(", ")' <<<"$VALID_ACTIONS")"
  fi

  # FAIL CLOSED ON AN UNRECOGNISED CLASSIFICATION. `pending` must be reached by
  # a classification that positively said so, never by falling off the end of a
  # case. The bug this guards was exactly that shape: classify_capability
  # aborted, returned an empty mode, and "not owner" filed the request as
  # decidable. An allowlist here, for the same reason STATUS_EVENTS is one.
  local status
  case "$mode" in
    owner)             status="owner_reserved";;
    custody|domain)    status="pending";;
    *) log_event "$(jq -cn --arg r "$requester" --arg c "$cap" --arg a "$action" --arg m "$mode" \
         '{event:"request.refused",reason:"unclassifiable",requester:$r,capability:$c,action:$a,mode:$m}')"
       die "could not classify '$action $cap' (mode='$mode'); refusing to file a request nobody is named to decide.";;
  esac

  local rid exp; exp="$(plus_days "$REQUEST_TTL_DAYS")"
  queue_lock
  rid="$(reqrecord_next_id)"
  append_queue "$(jq -cn --arg id "$rid" --arg st "$status" --arg r "$requester" --arg rid2 "$rq_id" \
    --arg t "$rq_tpl" --arg cap "$cap" --arg a "$action" --arg ti "$title" \
    --arg fa "$facts" --arg re "$reasoning" --arg m "$mode" --arg d "$decider" --arg cu "$cust" \
    --argjson ru "$rules" --arg at "$(now_iso)" --arg exp "$exp" \
    '{event:"request.submitted",requestId:$id,status:$st,
      requester:$r,requesterAgentId:$rid2,requesterTemplate:$t,
      capability:$cap,action:$a,title:$ti,
      facts:$fa,reasoning:$re,
      decisionMode:$m,
      derivedDecider:(if $d=="" then null else $d end),
      derivedCustodian:(if $cu=="" then null else $cu end),
      ownerReservedRules:$ru,
      submittedAt:$at,expiresAt:$exp}')"
  queue_unlock

  echo "SUBMITTED $rid  ($requester [$rq_tpl] asks to $action $cap)  status=$status"
  case "$mode" in
    owner)
      echo "  ** OWNER-RESERVED — NO AGENT MAY DECIDE THIS. **"
      explain_rules "$rules"
      echo "  It is now an open item in \`owner-queue\`. There is no reviewer flag that decides it;"
      echo "  \`review\` will refuse for every agent, including standing authority."
      ;;
    custody)
      echo "  TWO KEYS: $decider decides, then $cust countersigns as custodian."
      echo "    ./capability_gate.sh review --reviewer $decider --request $rid (--approve|--reject) --reason \"...\""
      ;;
    domain)
      echo "  ONE KEY: $decider decides."
      echo "    ./capability_gate.sh review --reviewer $decider --request $rid (--approve|--reject) --reason \"...\""
      ;;
  esac
  return 0
}

# ===========================================================================
# review — the domain owner's key.
cmd_review() {
  local reviewer="" rid="" decision="" reason=""
  # The safer-alternative contract, from the SHARED implementation in
  # lib/reqrecord.sh (TOG-403) — the same four flags, the same refusals and the
  # same record shape as org_request_queue.sh, because it is the same decision
  # model. A second copy here would be a second model within a quarter.
  saferalt_reset
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reviewer) reviewer="$2"; shift 2;;
      --request)  rid="$2";      shift 2;;
      --approve)  decision="approved"; shift;;
      --reject)   decision="rejected"; shift;;
      --reason)   reason="$2";   shift 2;;
      *) saferalt_parse_arg "$@"
         [[ $SAFERALT_SHIFT -gt 0 ]] || die "unknown argument: $1"
         shift "$SAFERALT_SHIFT";;
    esac
  done
  [[ -n "$reviewer" && -n "$rid" && -n "$decision" ]] \
    || die "usage: review --reviewer <ROLE> --request <ID> (--approve|--reject) --reason \"...\""
  # Every decision carries a reason, approvals included. "Why was this
  # approved" is the question an audit comes back for, and the approval path is
  # the one that historically went unguarded. Checked before anything is read,
  # so the refusal cannot depend on who is asking.
  [[ -n "$reason" ]] || die "every decision must carry --reason, an approval as much as a denial."
  # Argument SHAPE, checked here for the same reason: it does not depend on
  # which request was named, so it must not be reachable only for some of them.
  # This is the half of the model that covers denials, and it is unconditional
  # — a denial on this gate must leave the requester somewhere to go whether
  # the ask was risky or routine.
  saferalt_assert_direction "$decision"

  reap_expired
  reqrecord_assert_unambiguous "$rid"

  local rec sub; rec="$(reqrecord_state "$rid")" || die "no such request: $rid"
  [[ -n "$rec" ]] || die "no such request: $rid"
  sub="$(request_submission "$rid")"

  local cur cap action rq_role rq_id
  cur="$(jq -r '.status' <<<"$rec")"
  cap="$(jq -r '.capability' <<<"$sub")"
  action="$(jq -r '.action' <<<"$sub")"
  rq_role="$(jq -r '.requester' <<<"$sub")"
  rq_id="$(jq -r '.requesterAgentId' <<<"$sub")"

  [[ "$cur" != "expired" ]] || die "request $rid expired; resubmit it."
  [[ "$cur" != "awaiting_custody" ]] \
    || die "request $rid already carries the domain owner's key; it needs the custodian: countersign --custodian ... --request $rid"
  [[ "$cur" != "owner_reserved" ]] || {
    log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" --argjson ru "$(jq -c '.ownerReservedRules' <<<"$sub")" \
      '{event:"review.refused",reason:"owner_reserved",requestId:$id,reviewer:$r,rules:$ru}')"
    echo "  this ask is owner-reserved because:" >&2
    explain_rules "$(jq -c '.ownerReservedRules' <<<"$sub")" >&2
    # THE LOAD-BEARING REFUSAL. No agent decides this — not the domain owner,
    # not the CISO, not the President & COO. There is deliberately no flag,
    # no role and no escalation path below that reaches past this line.
    die "$rid is OWNER-RESERVED; no agent may decide it. It waits in \`owner-queue\`."
  }
  [[ "$cur" == "pending" ]] || die "request $rid is already '$cur'; decisions are final."

  # --- authority, re-derived from live state at DECISION time --------------
  # Never the value cached at submit. A decider derived at submit and trusted
  # at approval is the same TOCTOU bug org_request_queue.sh documents, arriving
  # in a new file. The submitted `derivedDecider` is INFORMATIONAL and is not
  # read here; if the org changed underneath, this re-derivation is what
  # notices.
  local c mode decider cust rules
  c="$(classify_capability "$cap" "$action" "$rq_id")"
  mode="$(f 1 "$c")"; decider="$(f 2 "$c")"; cust="$(f 3 "$c")"; rules="$(f 4 "$c")"

  # Re-classification can turn a decidable request owner-reserved — the CISO
  # was terminated, the domain owner's chain went dark. That must stop the
  # approval, not be logged and stepped over.
  if [[ "$mode" == "owner" || "$mode" == "invalid" ]]; then
    log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" --argjson ru "$rules" \
      '{event:"review.refused",reason:"reclassified_owner_reserved_since_submit",requestId:$id,reviewer:$r,rules:$ru}')"
    explain_rules "$rules" >&2
    die "$rid re-classified as OWNER-RESERVED since it was submitted; no agent may decide it now."
  fi

  local rvrow rv_id rv_role
  rvrow="$(resolve_agent "$reviewer")"; [[ -n "$rvrow" ]] || die "reviewer not found: $reviewer"
  rv_id="$(f 1 "$rvrow")"; rv_role="$(f 2 "$rvrow")"
  [[ "$(f 4 "$rvrow")" != "terminated" ]] || die "reviewer $reviewer is terminated."

  local drow d_id; drow="$(resolve_agent "$decider")"; d_id="$(f 1 "$drow")"
  if [[ "$rv_id" != "$d_id" ]]; then
    log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" --arg d "$decider" --arg c "$cap" \
      '{event:"review.refused",reason:"not_the_domain_owner",requestId:$id,reviewer:$r,domainOwner:$d,capability:$c}')"
    echo "  the domain owner for $cap is $decider" >&2
    # NO STANDING-AUTHORITY OVERRIDE HERE, and its absence is a decision.
    # org_request_queue.sh has one so a dormant leader cannot deadlock a
    # subtree, and the cost is bounded: the worst case is an agent seated a
    # level early. For a capability the worst case is a credential in the wrong
    # hands, so the same trade comes out the other way. A dormant domain owner
    # makes the request expire, and an expired capability request is a delay.
    # A break-glass path is a standing way around every rule above it.
    die "$reviewer is not the domain owner for $cap and there is no override path here."
  fi
  [[ "$rv_id" != "$rq_id" ]] \
    || { log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" \
           '{event:"review.refused",reason:"self_approval",requestId:$id,reviewer:$r}')"
         die "a requester cannot decide its own capability request ($rid)."; }

  # --- is this a RISKY ask? (TOG-403) --------------------------------------
  # Derived from the registry, never asked of the reviewer — the same rule the
  # owner-reserved classification follows and for the same reason.
  local risk_factors="" risky="no" rc_risk
  risk_factors="$(capability_risk_factors "$cap")"; rc_risk=$?
  case $rc_risk in
    0) risky="yes";;
    1) risky="no";;
    2) log_event "$(jq -cn --arg id "$rid" --arg c "$cap" \
         '{event:"review.refused",reason:"risk_unclassifiable",requestId:$id,capability:$c}')"
       die "'$cap' is not in the registry, so its risk cannot be read; refusing to decide an ask whose risk is unknown.";;
    3) log_event "$(jq -cn --arg id "$rid" --arg c "$cap" --arg k "$risk_factors" \
         '{event:"review.refused",reason:"unclassified_registry_value",requestId:$id,capability:$c,value:$k}')"
       die "'$cap' carries [$risk_factors], which is on neither the risky nor the non-risky list in capability_gate.sh. Somebody extended the registry without deciding whether the new value is risky; that decision is theirs to make, not a default's.";;
  esac

  # The alternatives record, on an approval of a risky ask. Placed AFTER the
  # authority checks, which is the one place this diverges from
  # org_request_queue.sh's ordering — deliberately. The queue checks it first
  # so that its standing-authority override cannot shrug the refusal off; this
  # gate has no override, so the domain-owner check is already absolute and
  # putting the risk check ahead of it would only mean a stranger's malformed
  # approval got told about the ask's risk class instead of being told it is
  # not the decider. Each refusal stays pinned to its own gate.
  if [[ "$decision" == "approved" && "$risky" == "yes" ]]; then
    if [[ "$(jq -r 'length' <<<"$SAFERALT_CONSIDERED")" -eq 0 ]]; then
      log_event "$(jq -cn --arg id "$rid" --arg c "$cap" --arg r "$reviewer" --arg f "$risk_factors" \
        '{event:"review.refused",reason:"risky_grant_without_alternatives_record",requestId:$id,capability:$c,reviewer:$r,riskFactors:($f|split(","))}')"
      echo "  risk factors : $risk_factors" >&2
    fi
    saferalt_assert_grant_record "'$action $cap'" \
      "review --reviewer $reviewer --request $rid --reject --reason \"...\" --alternative \"...\""
  fi

  local risk_json
  risk_json="$(jq -cn --arg f "$risk_factors" \
    '{risky:($f != ""), factors:(if $f=="" then [] else ($f|split(",")) end)}')"

  if [[ "$decision" == "rejected" ]]; then
    # Written as `request.countersigned` with key:"domain" so the
    # one-terminal-decision invariant covers exactly one event name. The row
    # says which key refused; nothing infers it.
    append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg re "$reason" --arg at "$(now_iso)" \
      --argjson risk "$risk_json" --argjson sa "$(saferalt_decision_json)" \
      '{event:"request.countersigned",requestId:$id,status:"rejected",key:"domain",
        reviewer:$rv,reason:$re,at:$at,risk:$risk} + $sa')"
    echo "REJECTED $rid by $reviewer (domain owner) — $reason"
    saferalt_announce "$reviewer" "$rid" "$rq_role" "$risk_factors"
    return 0
  fi

  if [[ "$mode" == "custody" ]]; then
    append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg re "$reason" \
      --arg cu "$cust" --arg at "$(now_iso)" \
      --argjson risk "$risk_json" --argjson sa "$(saferalt_decision_json)" \
      '{event:"request.reviewed",requestId:$id,status:"awaiting_custody",key:"domain",
        reviewer:$rv,reason:$re,awaitingCustodian:$cu,at:$at,risk:$risk} + $sa')"
    echo "KEY 1 of 2 — $rid approved by $reviewer (domain owner) — $reason"
    saferalt_announce_grant "$reviewer" "$risk_factors"
    echo "  still needs the custodian's key:"
    echo "    ./capability_gate.sh countersign --custodian $cust --request $rid (--approve|--reject) --reason \"...\""
    return 0
  fi

  append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg re "$reason" --arg at "$(now_iso)" \
    --argjson risk "$risk_json" --argjson sa "$(saferalt_decision_json)" \
    '{event:"request.countersigned",requestId:$id,status:"approved",key:"domain",
      reviewer:$rv,reason:$re,at:$at,risk:$risk} + $sa')"
  echo "APPROVED $rid by $reviewer (domain owner) — $reason"
  saferalt_announce_grant "$reviewer" "$risk_factors"
  echo "  NOT YET EFFECTED: this is a decision record. Nothing has been granted."
}

# --------------------------------------------------------------------------
# Surfacing. A record that is written and not shown is a record nobody reads —
# the argument org_request_queue.sh's announce_override makes, reached here by
# the same road. Both are said to the DECIDER's face, on stdout, at the moment
# of the decision.
saferalt_announce() {   # <decider> <requestId> <requesterRole> <riskFactors>
  if [[ "$(jq -r 'length' <<<"$SAFERALT_ALTS")" -gt 0 ]]; then
    echo "  safer alternatives offered:"
    jq -r '.[] | "    - " + .' <<<"$SAFERALT_ALTS"
  else
    printf '\n  ** NO SAFER ALTERNATIVE FOUND **\n'
    printf '  %s recorded that nothing safer would unblock this work:\n' "$1"
    printf '    %s\n' "$SAFERALT_NO_ALT"
    [[ -n "$4" ]] && printf '  This was a RISKY ask (%s).\n' "$4"
    printf '\033[1;33mNO SAFER ALTERNATIVE\033[0m recorded on %s by %s.\n' "$2" "$1" >&2
  fi
  # This gate has no `--supersedes`, so "amend and resubmit" is a NEW request
  # and the thread does not follow it. `comment` is therefore the only way to
  # answer a denial on the record it was made on, which is why it exists.
  echo "  the requester may answer on the record with:"
  echo "    ./capability_gate.sh comment --request $2 --author $3 --body \"...\""
}

saferalt_announce_grant() {   # <decider> <riskFactors>
  [[ -n "$2" ]] || return 0
  printf '\n  ** RISKY ASK GRANTED ** (risk factors: %s)\n' "$2"
  printf '  Safer alternatives considered, and why each failed:\n'
  jq -r '.[] | "    - \(.alternative)\n        failed because: \(.whyItFailed)"' <<<"$SAFERALT_CONSIDERED"
  printf '\033[1;33mRISKY ASK GRANTED\033[0m by %s (%s).\n' "$1" "$2" >&2
}

# ===========================================================================
# countersign — the custodian's key.
cmd_countersign() {
  local custodian="" rid="" decision="" reason=""
  saferalt_reset
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --custodian) custodian="$2"; shift 2;;
      --request)   rid="$2";       shift 2;;
      --approve)   decision="approved"; shift;;
      --reject)    decision="rejected"; shift;;
      --reason)    reason="$2";    shift 2;;
      *) saferalt_parse_arg "$@"
         [[ $SAFERALT_SHIFT -gt 0 ]] || die "unknown argument: $1"
         shift "$SAFERALT_SHIFT";;
    esac
  done
  [[ -n "$custodian" && -n "$rid" && -n "$decision" ]] \
    || die "usage: countersign --custodian <ROLE> --request <ID> (--approve|--reject) --reason \"...\""
  [[ -n "$reason" ]] || die "every decision must carry --reason, an approval as much as a denial."
  saferalt_assert_direction "$decision"

  # THE CUSTODIAN'S APPROVAL IS ALWAYS A RISKY GRANT, so the alternatives
  # record is required unconditionally and is asserted here, before anything is
  # read. cmd_review derives riskiness from the capability because a domain
  # decision can be routine; a countersignature cannot. This command refuses
  # any request that does not classify as `custody` a few lines down, and
  # `custody` is reached only by `class: credential` — handing over a secret.
  # There is deliberately no routine branch and no test for one.
  #
  # The denial side matters more here than anywhere else in either tool. A
  # custodian's refusal is the one most likely to be "not in this form" rather
  # than "no" — a narrower scope, a shorter TTL, a brokered mint instead of the
  # key itself — and a custody denial that records none of that is the worst
  # case of the whole class: the requester is blocked by the one agent who
  # already knows the safer shape.
  [[ "$decision" != "approved" ]] || saferalt_assert_grant_record \
    "a countersignature always hands over a credential, which" \
    "countersign --custodian $custodian --request $rid --reject --reason \"...\" --alternative \"<the narrower form>\""

  reap_expired
  reqrecord_assert_unambiguous "$rid"

  local rec sub; rec="$(reqrecord_state "$rid")" || die "no such request: $rid"
  [[ -n "$rec" ]] || die "no such request: $rid"
  sub="$(request_submission "$rid")"

  local cur cap action rq_id
  cur="$(jq -r '.status' <<<"$rec")"
  cap="$(jq -r '.capability' <<<"$sub")"
  action="$(jq -r '.action' <<<"$sub")"
  rq_id="$(jq -r '.requesterAgentId' <<<"$sub")"

  [[ "$cur" != "expired" ]] || die "request $rid expired; resubmit it."
  # owner_reserved is named BEFORE the generic arm. It is not a final decision
  # and must not be described as one — "decisions are final" tells a requester
  # its ask was decided, when in fact nobody has decided it and nobody may.
  # A wrong reason on a correct refusal is still a wrong answer.
  [[ "$cur" != "owner_reserved" ]] || {
    log_event "$(jq -cn --arg id "$rid" --arg r "$custodian" \
      '{event:"countersign.refused",reason:"owner_reserved",requestId:$id,custodian:$r}')"
    die "$rid is OWNER-RESERVED and has no domain-owner key yet; no agent may give it one."
  }
  [[ "$cur" != "pending" ]] \
    || die "request $rid has no domain-owner key yet; the custodian countersigns, it does not decide first."
  [[ "$cur" == "awaiting_custody" ]] || die "request $rid is '$cur'; decisions are final."

  # Custody, like the domain owner, is re-derived from live state.
  local c mode decider cust rules
  c="$(classify_capability "$cap" "$action" "$rq_id")"
  mode="$(f 1 "$c")"; decider="$(f 2 "$c")"; cust="$(f 3 "$c")"; rules="$(f 4 "$c")"
  if [[ "$mode" != "custody" ]]; then
    log_event "$(jq -cn --arg id "$rid" --arg r "$custodian" --arg m "$mode" --argjson ru "$rules" \
      '{event:"countersign.refused",reason:"reclassified_since_submit",requestId:$id,custodian:$r,mode:$m,rules:$ru}')"
    explain_rules "$rules" >&2
    die "$rid no longer classifies as a two-key custody request (now '$mode'); refusing to countersign a stale classification."
  fi

  local crow c_id; crow="$(resolve_agent "$custodian")"
  [[ -n "$crow" ]] || die "custodian not found: $custodian"
  c_id="$(f 1 "$crow")"
  [[ "$(f 4 "$crow")" != "terminated" ]] || die "custodian $custodian is terminated."

  local wantrow want_id; wantrow="$(resolve_agent "$cust")"; want_id="$(f 1 "$wantrow")"
  if [[ "$c_id" != "$want_id" ]]; then
    log_event "$(jq -cn --arg id "$rid" --arg r "$custodian" --arg w "$cust" \
      '{event:"countersign.refused",reason:"not_the_custodian",requestId:$id,custodian:$r,expected:$w}')"
    die "$custodian does not hold custody; that is $cust [$CUSTODY_TEMPLATE]."
  fi

  # The two keys must be two principals, and the requester is neither of them.
  # classify_capability already turns both collisions into owner_reserved at
  # submit; this is the same check at decision time, against fresh state,
  # because the org can change in between.
  local drow d_id; drow="$(resolve_agent "$decider")"; d_id="$(f 1 "$drow")"
  [[ "$c_id" != "$rq_id" ]] || die "the requester cannot countersign its own request ($rid)."
  [[ "$c_id" != "$d_id" ]] || die "the custodian and the domain owner are the same agent; two keys means two principals."

  local key1; key1="$(jq -c --arg id "$rid" \
    'select(.requestId==$id and .event=="request.reviewed" and .status=="awaiting_custody")' "$QUEUE" | tail -1)"
  local key1_by; key1_by="$(jq -r '.reviewer // ""' <<<"$key1")"

  # Every countersignature is a credential decision, so the risk record on the
  # row is a constant, not a derivation. Written anyway, in the same shape
  # cmd_review writes, so one query reads both keys' rows.
  local risk_factors risk_json
  risk_factors="$(capability_risk_factors "$cap")" || true
  risk_json="$(jq -cn --arg f "$risk_factors" \
    '{risky:($f != ""), factors:(if $f=="" then [] else ($f|split(",")) end)}')"

  append_queue "$(jq -cn --arg id "$rid" --arg cu "$custodian" --arg re "$reason" \
    --arg st "$decision" --arg k1 "$key1_by" --arg at "$(now_iso)" \
    --argjson risk "$risk_json" --argjson sa "$(saferalt_decision_json)" \
    '{event:"request.countersigned",requestId:$id,status:$st,key:"custody",
      custodian:$cu,reason:$re,domainOwner:$k1,at:$at,risk:$risk} + $sa')"

  if [[ "$decision" == "approved" ]]; then
    echo "APPROVED $rid — two keys: $key1_by (domain) + $custodian (custody)"
    echo "  custodian's reason: $reason"
    saferalt_announce_grant "$custodian" "$risk_factors"
    echo "  NOT YET EFFECTED: this is a decision record. Nothing has been granted."
  else
    echo "REJECTED $rid by $custodian (custodian) — $reason"
    echo "  the domain owner had approved it; custody refused. Both are on the record."
    local rq_role; rq_role="$(jq -r '.requester' <<<"$sub")"
    saferalt_announce "$custodian" "$rid" "$rq_role" "$risk_factors"
  fi
}

# ===========================================================================
# comment — how a decider asks for a fact without deciding, and how a requester
# answers a denial (TOG-403).
#
# TOG-387 left this open and TOG-403 was asked to settle it: does the
# alternatives model make `comment` unnecessary? It does not — it makes it
# NECESSARY, and the argument runs the other way from the obvious one.
#
# The model now REQUIRES a denial to carry a way forward. A decider who is one
# fact short of understanding the ask still has to produce one, so it will
# produce the best alternative it can imagine from an incomplete picture. That
# is a worse outcome than the old dead end, because a plausible wrong
# alternative reads as diligence and the requester will go and try it. Forcing
# an answer out of someone who has not finished reading the question
# manufactures bad answers; the fix is to let them ask.
#
# It matters more here than in org_request_queue.sh for a second reason: that
# tool has `--supersedes`, so a denied requester can amend against the same
# thread. This one does not. Without `comment` the only move after a denial is
# a brand-new CAP id that carries none of the exchange, so the reasoning the
# owner asked to be recorded is scattered across ids nothing links.
#
# Restricted to the PARTIES — requester, domain owner, custodian — all derived
# fresh, never read from the submission. And deliberately no standing-authority
# arm: `review` refuses to let standing authority decide a capability, so
# letting it write into the decision record would be the same override arriving
# by a quieter door.
cmd_comment() {
  local rid="" author="" body=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --request) rid="$2";    shift 2;;
      --author)  author="$2"; shift 2;;
      --body)    body="$2";   shift 2;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$rid" && -n "$author" && -n "$body" ]] \
    || die "usage: comment --request <ID> --author <ROLE> --body \"...\""

  reqrecord_assert_unambiguous "$rid"
  local sub; sub="$(request_submission "$rid")" || die "no such request: $rid"
  [[ -n "$sub" ]] || die "no such request: $rid"

  local cap action rq_id
  cap="$(jq -r '.capability' <<<"$sub")"
  action="$(jq -r '.action' <<<"$sub")"
  rq_id="$(jq -r '.requesterAgentId' <<<"$sub")"

  local arow a_id; arow="$(resolve_agent "$author")"; [[ -n "$arow" ]] || die "author not found: $author"
  a_id="$(f 1 "$arow")"
  [[ "$(f 4 "$arow")" != "terminated" ]] || die "author $author is terminated."

  # Derived fresh, exactly as the decision paths do. A party list cached at
  # submit is the same TOCTOU bug those paths already refuse to repeat.
  local c decider cust; c="$(classify_capability "$cap" "$action" "$rq_id")"
  decider="$(f 2 "$c")"; cust="$(f 3 "$c")"

  local ok="no"
  [[ "$a_id" == "$rq_id" ]] && ok="yes"
  if [[ -n "$decider" ]]; then
    [[ "$a_id" == "$(f 1 "$(resolve_agent "$decider")")" ]] && ok="yes"
  fi
  if [[ -n "$cust" ]]; then
    [[ "$a_id" == "$(f 1 "$(resolve_agent "$cust")")" ]] && ok="yes"
  fi
  [[ "$ok" == "yes" ]] || {
    log_event "$(jq -cn --arg id "$rid" --arg a "$author" \
      '{event:"comment.refused",reason:"not_a_party",requestId:$id,author:$a}')"
    die "$author is not a party to $rid; the thread is the record of a decision, not a discussion board."
  }

  # `request.comment` is NOT in REQRECORD_STATUS_EVENTS and must never be. A
  # comment that carried a status would land last and become the request's
  # state, which is precisely the denylist failure lib/reqrecord.sh's header
  # documents. It carries no `status` key at all.
  append_queue "$(jq -cn --arg id "$rid" --arg a "$author" --arg b "$body" --arg at "$(now_iso)" \
    '{event:"request.comment",requestId:$id,author:$a,body:$b,at:$at}')"
  echo "COMMENT recorded on $rid by $author"
}

# ===========================================================================
cmd_list() {
  local want="pending"
  [[ "${1:-}" == "--status" ]] && want="$2"
  [[ -f "$QUEUE" ]] || { echo "(queue empty)"; return 0; }
  reap_expired
  jq -s --arg w "$want" --argjson ev "$REQRECORD_STATUS_EVENTS" -r '
    map(select($ev[.event] // false))
    | group_by(.requestId)
    | map({rid: .[0].requestId, sub: .[0], last: .[-1]})
    | map(select($w == "all" or .last.status == $w))
    | .[]
    | "\(.rid)\t\(.last.status)\(if .last.status=="approved" then " (not yet effected)" else "" end)\t\(.sub.requester)\t\(.sub.action) \(.sub.capability)\t\(.sub.decisionMode)\t\(.last.reviewer // .last.custodian // "-")"
  ' "$QUEUE" | { printf 'ID\tSTATUS\tREQUESTER\tASK\tMODE\tDECIDED BY\n'; cat; } | tabulate
}

# owner-queue — the asks that stop for the owner, as a list somebody reads.
# Same cron/CI contract as org_request_queue.sh's `overrides`: exit 1 when the
# list is non-empty, so a queue nobody drained is a finding rather than a file.
cmd_owner_queue() {
  local fmt="text"
  [[ "${1:-}" == "--json" ]] && fmt="json"
  [[ -f "$QUEUE" ]] || { [[ "$fmt" == "text" ]] && echo "(queue empty)"; return 0; }
  reap_expired
  local rows
  rows="$(jq -s -c --argjson ev "$REQRECORD_STATUS_EVENTS" '
    map(select($ev[.event] // false))
    | group_by(.requestId)
    | map({rid: .[0].requestId, sub: .[0], last: .[-1]})
    | map(select(.last.status == "owner_reserved"))
    | map({requestId:.rid, requester:.sub.requester, capability:.sub.capability,
           action:.sub.action, facts:.sub.facts, reasoning:.sub.reasoning,
           rules:.sub.ownerReservedRules, submittedAt:.sub.submittedAt,
           expiresAt:.sub.expiresAt})
    | .[]' "$QUEUE")"
  if [[ "$fmt" == "json" ]]; then
    [[ -n "$rows" ]] && printf '%s\n' "$rows"
  elif [[ -z "$rows" ]]; then
    echo "no capability requests are waiting on the owner"
  else
    while IFS= read -r r; do
      [[ -n "$r" ]] || continue
      printf '\n=== %s — %s asks to %s %s ===\n' \
        "$(jq -r '.requestId' <<<"$r")" "$(jq -r '.requester' <<<"$r")" \
        "$(jq -r '.action' <<<"$r")" "$(jq -r '.capability' <<<"$r")"
      echo "  stops for the owner because:"
      explain_rules "$(jq -c '.rules' <<<"$r")"
      printf '  FACTS     : %s\n' "$(jq -r '.facts' <<<"$r")"
      printf '  REASONING : %s\n' "$(jq -r '.reasoning' <<<"$r")"
      printf '  submitted %s, expires %s\n' "$(jq -r '.submittedAt' <<<"$r")" "$(jq -r '.expiresAt' <<<"$r")"
    done <<<"$rows"
  fi
  local n; n="$(jq -s 'length' <<<"$rows")"
  [[ "${n:-0}" -eq 0 ]]
}

cmd_thread() {
  local rid=""
  while [[ $# -gt 0 ]]; do
    case "$1" in --request) rid="$2"; shift 2;; *) die "unknown argument: $1";; esac
  done
  [[ -n "$rid" ]] || die "usage: thread --request <ID>"
  [[ -f "$QUEUE" ]] || die "no such request: $rid"
  reap_expired
  # `thread` is the view that renders the record AS AUTHORITATIVE, so it is the
  # worst place to render a tampered one without complaint.
  reqrecord_assert_unambiguous "$rid"
  # The safer-alternatives record travels WITH the decision, on every row that
  # carries one. An alternative the requester never reads is the same dead end
  # as no alternative at all, and `thread` is where the requester reads.
  jq -r --arg id "$rid" '
    def saferalt:
      (if ((.alternatives // []) | length) > 0
       then "\n        safer alternatives offered:\n" +
            ((.alternatives | map("          - " + .)) | join("\n"))
       else "" end) +
      (if (.noSaferAlternative // null) != null
       then "\n        NO SAFER ALTERNATIVE: \(.noSaferAlternative)"
       else "" end) +
      (if ((.alternativesConsidered // []) | length) > 0
       then "\n        alternatives considered and why each failed:\n" +
            ((.alternativesConsidered
              | map("          - \(.alternative)\n              failed because: \(.whyItFailed)"))
             | join("\n"))
       else "" end);
    select(.requestId==$id) |
    if   .event=="request.submitted" then
      "\($id)  SUBMITTED  \(.requester) [\(.requesterTemplate)] asks to \(.action) \(.capability)  [\(.decisionMode)]" +
      "\n        FACTS     : \(.facts)" +
      "\n        REASONING : \(.reasoning)" +
      (if (.ownerReservedRules | length) > 0
       then "\n        OWNER-RESERVED: " + (.ownerReservedRules | map("\(.rule) (\(.fact))") | join("; "))
       else "" end)
    elif .event=="request.reviewed" then
      "\($id)  KEY 1/2    \(.reviewer) (domain) approved — \(.reason)\n        awaiting custodian \(.awaitingCustodian)" + saferalt
    elif .event=="request.countersigned" then
      "\($id)  \(.status|ascii_upcase)   by \(.reviewer // .custodian) (\(.key)) — \(.reason)" +
      (if .status=="approved" and .key=="custody" then "\n        two keys: \(.domainOwner) (domain) + \(.custodian) (custody)" else "" end) +
      (if .status=="approved" then "\n        NOT YET EFFECTED — decision record only" else "" end) + saferalt
    elif .event=="request.comment" then
      "\($id)  COMMENT    \(.author): \(.body)"
    elif .event=="request.expired" then "\($id)  EXPIRED    undecided; resubmission required"
    else empty end' "$QUEUE"
}

case "${1:-}" in
  registry)    shift; cmd_registry "$@";;
  classify)    shift; cmd_classify "$@";;
  who)         shift; cmd_who "$@";;
  submit)      shift; cmd_submit "$@";;
  review)      shift; cmd_review "$@";;
  countersign) shift; cmd_countersign "$@";;
  comment)     shift; cmd_comment "$@";;
  list)        shift; cmd_list "$@";;
  owner-queue) shift; cmd_owner_queue "$@";;
  thread)      shift; cmd_thread "$@";;
  log)         [[ -f "$GRANT_LOG" ]] && cat "$GRANT_LOG" || echo "(no log)";;
  *) sed -n '/^# USAGE/,/^# ====/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1;;
esac
