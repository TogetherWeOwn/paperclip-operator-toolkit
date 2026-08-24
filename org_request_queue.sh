#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# Approval-gated Org Provisioning Request Queue
# ---------------------------------------------------------------------------
# Implements the report's `org.request_descendant` / `org.review_request`
# capabilities (sections 6 and 8) on top of org_provisioner.sh.
#
#   requester (chief/director/manager)  --submit-->  PENDING request
#   the RESPONSIBLE LEADER              --review-->  APPROVED -> provisioner
#                                                 \-> REJECTED (with a reason,
#                                                     which can be answered)
#
# WHO DECIDES — see docs/responsible-leader.md for the full reasoning.
# ------------------------------------------------------------------
# The responsible leader is the nearest LIVE ancestor of the requester, walking
# reports_to upward, whose own delegation ceiling already contains the requested
# template — that is, a leader may only approve what it could have done itself.
# In the org as it stands this is the requester's direct manager in every case.
#
# The walk skips an ancestor only for `terminated` or an insufficient ceiling,
# and both are logged. Dormancy is NOT a skip reason: an idle leader is woken,
# never bypassed, and a pending request NEVER re-targets itself on a timer. A
# request that is not decided expires and must be resubmitted. Auto-escalation
# on timeout is approver-shopping with a clock and is deliberately absent.
#
# When the walk finds nobody — a root requester such as O3 audit, or an entirely
# terminated chain — the request escalates to the STANDING authority set
# (P4_PROVISIONING_STEWARD, P1_PRESIDENT_COO), which is the closed set this
# queue used to require for everything. That set also retains break-glass
# authority over any request, so one dormant leader cannot deadlock its subtree;
# a break-glass decision is recorded as an override naming the leader bypassed.
#
# SECURITY PROPERTIES
# -------------------
#   * Separation of duties. A requester can never approve its own request, even
#     if it otherwise holds review authority. The derived leader is a strict
#     ancestor, so it cannot be the requester; the identity check runs anyway,
#     and a reviewer that is a DESCENDANT of the requester is also refused (the
#     break-glass path is the only way to produce one, and it must not become a
#     way to seat a captive approver inside your own subtree).
#   * Two-time validation. The delegation ceiling is checked at SUBMIT and
#     re-checked at APPROVAL against freshly-read state. A request approved
#     after the requester was demoted, moved, or terminated is refused —
#     the queue is not a way to bank stale authority (TOCTOU defence). The
#     REVIEWER's authority is likewise derived at decision time, never cached
#     at submit, or the leader would be the same TOCTOU bug in a new place.
#   * Review authority is never inferred from a Paperclip permission key.
#     Holding `users:manage_permissions` does NOT confer review authority.
#   * Request ceiling is distinct from create ceiling. P3_AUDIT_RISK may
#     REQUEST audit specialists (report: "org.request_descendant, approval-
#     gated") while still being unable to CREATE anything directly.
#   * Template disablement (org.disable_template) is enforced at approval
#     time, so disabling a template immediately freezes pending requests
#     that would use it.
#   * Execution is delegated to org_provisioner.sh with the ORIGINAL
#     requester as caller, so every invariant in section 8.2 still applies.
#     The reviewer cannot redirect placement or widen the template. `review`
#     takes only a decision and a reason; there is no argument that can alter
#     a submitted request.
#   * A denial is not a dead end. It carries a reason, it can be answered with
#     `comment`, and it can be amended by a NEW request that `--supersedes` it.
#     `thread` renders the whole exchange, not just the final verdict.
#
# TRANSPORT NOTE
# --------------
# This is the authorization core. Agents reach it through the host-side MCP
# server (TOG-196), which is the only sanctioned transport. That server MUST
# derive requester and reviewer identity from the authenticated agent principal
# supplied by Paperclip's tool gateway, and MUST NOT accept either as a tool
# argument — an identity the model can fill in voids every property above.
#
# TEST SEAMS (offline, no database — these are load-bearing for CI)
#   ORG_SNAPSHOT  path to a TSV org snapshot used instead of the live database:
#                 id \t orgRoleId \t template \t status \t reportsTo \t title
#   PROV          path to org_provisioner.sh, so a suite can stub `ceiling`
#                 and `create` without podman or a live company.
#
# USAGE
#   ./org_request_queue.sh submit  --requester <ROLE> --template <T> \
#                                  --title "..." [--rationale "..."] \
#                                  [--supersedes <ID>]
#   ./org_request_queue.sh list    [--status pending|approved|rejected|all]
#   ./org_request_queue.sh who     --requester <ROLE> --template <T>
#   ./org_request_queue.sh review  --reviewer <ROLE> --request <ID> \
#                                  (--approve|--reject) [--reason "..."]
#   ./org_request_queue.sh comment --request <ID> --author <ROLE> --body "..."
#   ./org_request_queue.sh thread  --request <ID>
#   ./org_request_queue.sh log                       # org.read_grant_log
#   ./org_request_queue.sh disable-template <T> --reviewer <ROLE>
#   ./org_request_queue.sh enable-template  <T> --reviewer <ROLE>
# ===========================================================================

COMPANY_ID="${COMPANY_ID:?Set COMPANY_ID}"
PAPERCLIP_DB_CTR="${PAPERCLIP_DB_CTR:-paperclip-db}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROV="${PROV:-$HERE/org_provisioner.sh}"
QUEUE="${QUEUE:-$HERE/provisioner-request-queue.jsonl}"
DISABLED_TEMPLATES="${DISABLED_TEMPLATES:-$HERE/.provisioner-disabled-templates}"
GRANT_LOG="${GRANT_LOG:-$HERE/provisioner-grant-log.jsonl}"
ORG_SNAPSHOT="${ORG_SNAPSHOT:-}"

# A reporting chain deeper than this is a data error, not an org.
MAX_CHAIN_DEPTH="${MAX_CHAIN_DEPTH:-16}"
# A pending request that nobody decides expires. It does NOT escalate.
REQUEST_TTL_DAYS="${REQUEST_TTL_DAYS:-7}"
# A denial resubmitted this many times is not a disagreement resubmission fixes.
MAX_SUPERSEDE_CHAIN="${MAX_SUPERSEDE_CHAIN:-5}"

command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }
[[ -x "$PROV" ]] || { echo "ERROR: org_provisioner.sh not found/executable" >&2; exit 1; }

die() { echo "REFUSED: $*" >&2; exit 2; }

# Standing authority. This is the escalation floor when no leader can be
# derived, and the break-glass path over a derived leader. It is no longer the
# only way a request can be decided.
STANDING_AUTHORITY='["P4_PROVISIONING_STEWARD","P1_PRESIDENT_COO"]'

# Request ceiling = create ceiling, plus the report's explicit approval-gated
# exception for the independent audit function.
REQUEST_EXTRA='{"P3_AUDIT_RISK":["E4_AUDIT_ANALYST"]}'

now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
plus_days() { date -u -d "+$1 days" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
              || date -u -v "+$1d" +%Y-%m-%dT%H:%M:%SZ; }

pcsql() {
  podman exec -i -e PGV_COMPANY_ID -e PGV_TEXT "$PAPERCLIP_DB_CTR" sh -c \
    'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq -v ON_ERROR_STOP=1 \
       -v company_id="$PGV_COMPANY_ID" -v text="${PGV_TEXT:-}" "$@" -f -' _ "$@"
}

# Freshly resolve an agent by org role id OR uuid, live from state. Emits
# "<id>\t<orgRoleId>\t<template>\t<status>\t<reportsTo>\t<title>".
# Terminated agents are returned, not filtered — callers must SEE termination.
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

ceiling_for() { "$PROV" ceiling 2>/dev/null | awk -v t="$1" '$1==t{$1="";print}'; }

# May template $2 be CREATED by a caller whose profile is $1 ? (create ceiling)
may_create() {
  [[ -n "$1" && -n "$2" ]] || return 1
  grep -qE "(^|[ ,])${2}([ ,]|\$)" <<<"$(ceiling_for "$1")"
}

# May template $2 be REQUESTED by a caller whose profile is $1 ?
may_request() {
  may_create "$1" "$2" && return 0
  jq -e --arg c "$1" --arg w "$2" \
     '(.[$c] // []) | index($w) != null' <<<"$REQUEST_EXTRA" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Responsible-leader derivation. Walks reports_to upward from the requester and
# returns the nearest live ancestor that could create the template itself.
#
#   stdout: "<mode>\t<agentId>\t<orgRole>\t<template>\t<skipsJson>"
#   mode:   leader   — a responsible leader was derived
#           escalate — chain exhausted; the standing authority set decides
#           cycle    — the reporting chain is malformed; fail closed
#
# The skip list travels on stdout rather than in a variable ON PURPOSE: every
# caller invokes this in a command substitution, so a global would be mutated in
# a subshell and silently arrive empty.
# ---------------------------------------------------------------------------
derive_leader() {
  local start_id="$1" template="$2" row parent seen=" $1 " depth=0 skips='[]'
  local skip='. + [{agent:$a,reason:$r}]'
  row="$(resolve_agent "$start_id")"
  [[ -n "$row" ]] || { printf 'cycle\t\t\t\t%s\n' "$skips"; return; }
  parent="$(f 5 "$row")"

  while [[ -n "$parent" && $depth -lt $MAX_CHAIN_DEPTH ]]; do
    [[ "$seen" != *" $parent "* ]] || { printf 'cycle\t\t\t\t%s\n' "$skips"; return; }
    seen+="$parent "
    row="$(resolve_agent "$parent")"
    [[ -n "$row" ]] || { skips="$(jq -c --arg a "$parent" --arg r missing "$skip" <<<"$skips")"; break; }

    local a_id a_role a_tpl a_status
    a_id="$(f 1 "$row")"; a_role="$(f 2 "$row")"
    a_tpl="$(f 3 "$row")"; a_status="$(f 4 "$row")"

    if [[ "$a_status" == "terminated" ]]; then
      skips="$(jq -c --arg a "${a_role:-$a_id}" --arg r terminated "$skip" <<<"$skips")"
    elif may_create "$a_tpl" "$template"; then
      printf 'leader\t%s\t%s\t%s\t%s\n' "$a_id" "${a_role:-$a_id}" "$a_tpl" "$skips"
      return
    else
      skips="$(jq -c --arg a "${a_role:-$a_id}" --arg r ceiling_insufficient "$skip" <<<"$skips")"
    fi

    parent="$(f 5 "$row")"
    depth=$((depth+1))
  done
  printf 'escalate\t\t\t\t%s\n' "$skips"
}

# Is $2 inside the reporting subtree of $1 ? Walks upward from the candidate.
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

template_disabled() { [[ -f "$DISABLED_TEMPLATES" ]] && grep -qxF "$1" "$DISABLED_TEMPLATES"; }

log_event()    { printf '%s\n' "$1" >> "$GRANT_LOG"; chmod 0600 "$GRANT_LOG" 2>/dev/null || true; }
append_queue() { printf '%s\n' "$1" >> "$QUEUE"; chmod 0600 "$QUEUE" 2>/dev/null || true; }

# Current state of a request = its most recent status-bearing record.
request_state() {
  [[ -f "$QUEUE" ]] || return 1
  jq -c --arg id "$1" 'select(.requestId==$id and has("status"))' "$QUEUE" | tail -1
}
request_submission() {
  [[ -f "$QUEUE" ]] || return 1
  jq -c --arg id "$1" 'select(.requestId==$id and .event=="request.submitted")' "$QUEUE" | tail -1
}

next_id() {
  local n=1
  [[ -f "$QUEUE" ]] && n=$(( $(jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" 2>/dev/null | wc -l) + 1 ))
  printf 'REQ-%03d' "$n"
}

# A pending request past its expiry is expired, not decidable. Expiry never
# re-targets the request to a different approver — see the header.
expired() {
  local exp="$1"
  [[ -n "$exp" && "$exp" != "null" ]] || return 1
  [[ "$(now_iso)" > "$exp" ]]
}

# --------------------------------------------------------------------------
cmd_submit() {
  local requester="" template="" title="" rationale="" supersedes=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --requester)  requester="$2";  shift 2;;
      --template)   template="$2";   shift 2;;
      --title)      title="$2";      shift 2;;
      --rationale)  rationale="$2";  shift 2;;
      --supersedes) supersedes="$2"; shift 2;;
      --reports-to|--parent) die "reportsTo is never caller-supplied; placement is derived from the requester.";;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$requester" && -n "$template" && -n "$title" ]] \
    || die "usage: submit --requester <ROLE> --template <T> --title <TITLE>"

  local row id tpl status
  row="$(resolve_agent "$requester")"; [[ -n "$row" ]] || die "requester not found: $requester"
  id="$(f 1 "$row")"; tpl="$(f 3 "$row")"; status="$(f 4 "$row")"
  [[ "$status" != "terminated" ]] || die "requester $requester is terminated."
  [[ -n "$tpl" ]] || die "requester has no permissionProfile; refusing to infer authority."

  if ! may_request "$tpl" "$template"; then
    log_event "$(jq -cn --arg r "$requester" --arg t "$tpl" --arg w "$template" \
      '{event:"request.refused",reason:"template_above_request_ceiling",requester:$r,requesterTemplate:$t,requestedTemplate:$w}')"
    echo "  requester template : $tpl" >&2
    echo "  requested          : $template" >&2
    die "template '$template' is above the request ceiling of '$tpl'."
  fi

  # An amendment must come from the SAME requester, and may only follow a
  # closed request. Nobody chains onto someone else's denial, and nobody forks
  # a request that is still live.
  local depth=0
  if [[ -n "$supersedes" ]]; then
    local prev prev_sub prev_status prev_requester
    prev="$(request_state "$supersedes")" || die "no such request: $supersedes"
    [[ -n "$prev" ]] || die "no such request: $supersedes"
    prev_sub="$(request_submission "$supersedes")"
    prev_status="$(jq -r '.status' <<<"$prev")"
    prev_requester="$(jq -r '.requesterAgentId' <<<"$prev_sub")"
    [[ "$prev_requester" == "$id" ]] \
      || die "only the original requester may supersede $supersedes."
    [[ "$prev_status" == "rejected" || "$prev_status" == "expired" ]] \
      || die "request $supersedes is '$prev_status'; only a rejected or expired request can be superseded."
    depth=$(( $(jq -r '.supersedeDepth // 0' <<<"$prev_sub") + 1 ))
    if [[ $depth -ge $MAX_SUPERSEDE_CHAIN ]]; then
      log_event "$(jq -cn --arg id "$supersedes" --arg r "$requester" --argjson d "$depth" \
        '{event:"request.refused",reason:"supersede_chain_exhausted",supersedes:$id,requester:$r,depth:$d}')"
      die "this request has already been resubmitted $depth times; escalate instead of resubmitting."
    fi
  fi

  local rid exp; rid="$(next_id)"; exp="$(plus_days "$REQUEST_TTL_DAYS")"
  append_queue "$(jq -cn --arg id "$rid" --arg r "$requester" --arg rid2 "$id" --arg t "$tpl" \
    --arg w "$template" --arg ti "$title" --arg ra "$rationale" --arg sup "$supersedes" \
    --argjson d "$depth" --arg at "$(now_iso)" --arg exp "$exp" \
    '{event:"request.submitted",requestId:$id,status:"pending",requester:$r,requesterAgentId:$rid2,
      requesterTemplate:$t,template:$w,title:$ti,rationale:$ra,
      supersedes:(if $sup=="" then null else $sup end),supersedeDepth:$d,
      submittedAt:$at,expiresAt:$exp}')"

  echo "SUBMITTED $rid  ($requester [$tpl] requests $template — \"$title\")  status=pending"
  [[ -n "$supersedes" ]] && echo "  supersedes $supersedes (resubmission $depth of $((MAX_SUPERSEDE_CHAIN-1)))"

  # Name the decider at submit time so the requester knows who was woken. This
  # is INFORMATIONAL ONLY and confers nothing: the leader is re-derived from
  # fresh state at decision time.
  local d skips; d="$(derive_leader "$id" "$template")"; skips="$(f 5 "$d")"
  case "$(f 1 "$d")" in
    leader)   echo "  responsible leader : $(f 3 "$d") [$(f 4 "$d")] — will be woken to decide.";;
    escalate) echo "  responsible leader : none in the reporting chain; escalated to the standing authority (A0 steward, O1).";;
    cycle)    echo "  responsible leader : UNRESOLVABLE (malformed reporting chain) — only the standing authority can decide this.";;
  esac
  jq -e 'length > 0' <<<"$skips" >/dev/null 2>&1 \
    && echo "  skipped in chain   : $(jq -r 'map("\(.agent) (\(.reason))")|join(", ")' <<<"$skips")"
  return 0
}

# --------------------------------------------------------------------------
# who — answer "who decides this?" without submitting anything.
cmd_who() {
  local requester="" template=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --requester) requester="$2"; shift 2;;
      --template)  template="$2";  shift 2;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$requester" && -n "$template" ]] || die "usage: who --requester <ROLE> --template <T>"
  local row; row="$(resolve_agent "$requester")"; [[ -n "$row" ]] || die "requester not found: $requester"
  local d; d="$(derive_leader "$(f 1 "$row")" "$template")"
  printf '%s\t%s\t%s\t%s\n' "$(f 1 "$d")" "$(f 3 "$d")" "$(f 4 "$d")" "$(f 5 "$d")"
}

# --------------------------------------------------------------------------
cmd_review() {
  local reviewer="" rid="" decision="" reason=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reviewer) reviewer="$2"; shift 2;;
      --request)  rid="$2";      shift 2;;
      --approve)  decision="approved"; shift;;
      --reject)   decision="rejected"; shift;;
      --reason)   reason="$2";   shift 2;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$reviewer" && -n "$rid" && -n "$decision" ]] \
    || die "usage: review --reviewer <ROLE> --request <ID> (--approve|--reject)"

  local rec sub; rec="$(request_state "$rid")" || die "no such request: $rid"
  [[ -n "$rec" ]] || die "no such request: $rid"
  sub="$(request_submission "$rid")"
  local cur; cur="$(jq -r '.status' <<<"$rec")"
  [[ "$cur" == "pending" ]] || die "request $rid is already '$cur'; decisions are final."

  local rq_role rq_id_at_submit template title exp
  rq_role="$(jq -r '.requester' <<<"$sub")"
  rq_id_at_submit="$(jq -r '.requesterAgentId' <<<"$sub")"
  template="$(jq -r '.template' <<<"$sub")"
  title="$(jq -r '.title' <<<"$sub")"
  exp="$(jq -r '.expiresAt // ""' <<<"$sub")"

  if expired "$exp"; then
    append_queue "$(jq -cn --arg id "$rid" --arg at "$(now_iso)" \
      '{event:"request.expired",requestId:$id,status:"expired",at:$at}')"
    die "request $rid expired at $exp; resubmit it with --supersedes $rid."
  fi

  local rvrow rv_id rv_tpl
  rvrow="$(resolve_agent "$reviewer")"; [[ -n "$rvrow" ]] || die "reviewer not found: $reviewer"
  rv_id="$(f 1 "$rvrow")"; rv_tpl="$(f 3 "$rvrow")"
  [[ "$(f 4 "$rvrow")" != "terminated" ]] || die "reviewer $reviewer is terminated."

  # --- authority, derived fresh from live state at DECISION time -----------
  local d mode leader_id leader_role standing="no" override="no"
  d="$(derive_leader "$rq_id_at_submit" "$template")"
  mode="$(f 1 "$d")"; leader_id="$(f 2 "$d")"; leader_role="$(f 3 "$d")"
  jq -e --arg t "$rv_tpl" 'index($t) != null' <<<"$STANDING_AUTHORITY" >/dev/null && standing="yes"

  if [[ "$mode" == "leader" && "$rv_id" == "$leader_id" ]]; then
    :                                        # the responsible leader itself
  elif [[ "$standing" == "yes" ]]; then
    [[ "$mode" == "leader" ]] && override="yes"
  else
    log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" --arg t "$rv_tpl" \
                 --arg m "$mode" --arg l "$leader_role" \
      '{event:"review.refused",reason:"not_the_responsible_leader",requestId:$id,
        reviewer:$r,reviewerTemplate:$t,mode:$m,responsibleLeader:(if $l=="" then null else $l end)}')"
    if [[ "$mode" == "leader" ]]; then
      echo "  responsible leader : $leader_role" >&2
    else
      echo "  responsible leader : none derivable; only the standing authority (A0, O1) may decide this." >&2
    fi
    die "$reviewer [$rv_tpl] is not the responsible leader for $rid and does not hold standing authority."
  fi

  # Separation of duties. Derivation cannot produce the requester, but the
  # standing-authority path is not derived, so both checks run on every path.
  [[ "$rv_id" != "$rq_id_at_submit" ]] \
    || { log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" \
           '{event:"review.refused",reason:"self_approval",requestId:$id,reviewer:$r}')"
         die "a requester cannot review its own request ($rid)."; }
  # A reviewer inside the requester's own subtree is a captive approver, not a
  # reviewer. Derivation cannot produce one; the standing-authority path can.
  #
  # EXEMPTION: a ROOT requester. If the requester has no reports_to then every
  # other agent in the company is inside its subtree, so this rule could only
  # ever deadlock — it would make the root's own requests undecidable, which is
  # exactly what the standing floor exists to prevent. The root (O1) still
  # cannot self-approve. This is a stated limit of the control, not an oversight:
  # a compromised root operator is outside what a subtree rule can reach.
  local rq_row; rq_row="$(resolve_agent "$rq_id_at_submit")"
  if [[ -n "$(f 5 "$rq_row")" ]] && is_descendant_of "$rq_id_at_submit" "$rv_id"; then
    log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" --arg q "$rq_role" \
      '{event:"review.refused",reason:"reviewer_is_descendant_of_requester",requestId:$id,reviewer:$r,requester:$q}')"
    die "$reviewer reports into $rq_role's own subtree; a captive approver is not a reviewer."
  fi

  local override_json='null'
  [[ "$override" == "yes" ]] && override_json="$(jq -cn --arg l "$leader_role" '{bypassedLeader:$l}')"

  if [[ "$decision" == "rejected" ]]; then
    [[ -n "$reason" ]] || die "a denial must carry a reason — the requester has to know what to answer."
    append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg re "$reason" \
      --arg at "$(now_iso)" --argjson ov "$override_json" \
      '{event:"request.reviewed",requestId:$id,status:"rejected",reviewer:$rv,reason:$re,at:$at,override:$ov}')"
    echo "REJECTED $rid by $reviewer — $reason"
    echo "  the requester may answer with: comment --request $rid --author $rq_role --body \"...\""
    echo "  or amend and resubmit with:    submit --requester $rq_role ... --supersedes $rid"
    return 0
  fi

  # --- approval-time re-validation (TOCTOU defence) -----------------------
  template_disabled "$template" \
    && { log_event "$(jq -cn --arg id "$rid" --arg w "$template" \
           '{event:"review.refused",reason:"template_disabled",requestId:$id,template:$w}')"
         die "template '$template' is currently disabled by the provisioning steward."; }

  local now; now="$(resolve_agent "$rq_role")"
  [[ -n "$now" ]] || die "requester $rq_role no longer exists; refusing to execute a stale request."
  local now_id now_tpl now_status
  now_id="$(f 1 "$now")"; now_tpl="$(f 3 "$now")"; now_status="$(f 4 "$now")"
  [[ "$now_status" != "terminated" ]] \
    || die "requester $rq_role is terminated; refusing to execute a stale request."
  [[ "$now_id" == "$rq_id_at_submit" ]] \
    || die "requester identity changed since submission; refusing to execute a stale request."
  may_request "$now_tpl" "$template" \
    || { log_event "$(jq -cn --arg id "$rid" --arg t "$now_tpl" --arg w "$template" \
           '{event:"review.refused",reason:"ceiling_changed_since_submit",requestId:$id,requesterTemplateNow:$t,template:$w}')"
         die "requester's ceiling changed since submission ($now_tpl may no longer request $template)."; }

  # Execute with the ORIGINAL requester as caller. The provisioner re-applies
  # every section 8.2 invariant, including service-set placement.
  local out rc
  out="$("$PROV" create --caller "$rq_role" --template "$template" --title "$title" 2>&1)"; rc=$?
  if [[ $rc -ne 0 ]]; then
    append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg e "$out" --arg at "$(now_iso)" \
      '{event:"request.reviewed",requestId:$id,status:"failed",reviewer:$rv,error:$e,at:$at}')"
    echo "$out" >&2
    die "provisioner rejected the approved request; queue marked failed (no partial state)."
  fi
  local new_id; new_id="$(grep -oE 'PROVISIONED [A-Z0-9_]+ -> [0-9a-f-]{36}' <<<"$out" | awk '{print $4}')"
  append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg n "$new_id" --arg re "$reason" \
    --arg at "$(now_iso)" --argjson ov "$override_json" \
    '{event:"request.reviewed",requestId:$id,status:"approved",reviewer:$rv,newAgentId:$n,reason:$re,at:$at,override:$ov}')"
  echo "APPROVED $rid by $reviewer"
  [[ "$override" == "yes" ]] && echo "  NOTE: decided under standing authority, bypassing the responsible leader ($leader_role)."
  echo "$out"
}

# --------------------------------------------------------------------------
# comment — how a leader asks for more information without denying, and how a
# requester answers a denial. Restricted to the parties to the decision, so the
# thread stays a record of the decision and not a discussion board.
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

  local sub; sub="$(request_submission "$rid")" || die "no such request: $rid"
  [[ -n "$sub" ]] || die "no such request: $rid"
  local rq_id template; rq_id="$(jq -r '.requesterAgentId' <<<"$sub")"
  template="$(jq -r '.template' <<<"$sub")"

  local arow; arow="$(resolve_agent "$author")"; [[ -n "$arow" ]] || die "author not found: $author"
  local a_id a_tpl; a_id="$(f 1 "$arow")"; a_tpl="$(f 3 "$arow")"

  local d; d="$(derive_leader "$rq_id" "$template")"
  local ok="no"
  [[ "$a_id" == "$rq_id" ]] && ok="yes"
  [[ "$(f 1 "$d")" == "leader" && "$a_id" == "$(f 2 "$d")" ]] && ok="yes"
  jq -e --arg t "$a_tpl" 'index($t) != null' <<<"$STANDING_AUTHORITY" >/dev/null && ok="yes"
  [[ "$ok" == "yes" ]] \
    || die "$author is neither the requester nor the responsible leader for $rid."

  append_queue "$(jq -cn --arg id "$rid" --arg a "$author" --arg b "$body" --arg at "$(now_iso)" \
    '{event:"request.comment",requestId:$id,author:$a,body:$b,at:$at}')"
  echo "COMMENT recorded on $rid by $author"
}

# --------------------------------------------------------------------------
# thread — the whole exchange, following supersedes links backwards, so a
# reviewer sees why the earlier attempts were denied and not just this one.
cmd_thread() {
  local rid=""
  while [[ $# -gt 0 ]]; do
    case "$1" in --request) rid="$2"; shift 2;; *) die "unknown argument: $1";; esac
  done
  [[ -n "$rid" ]] || die "usage: thread --request <ID>"
  [[ -f "$QUEUE" ]] || die "no such request: $rid"

  local chain=() cur="$rid" depth=0 sub
  while [[ -n "$cur" && "$cur" != "null" && $depth -lt $((MAX_SUPERSEDE_CHAIN + 2)) ]]; do
    sub="$(request_submission "$cur")"; [[ -n "$sub" ]] || break
    chain=("$cur" "${chain[@]}")
    cur="$(jq -r '.supersedes // ""' <<<"$sub")"
    depth=$((depth+1))
  done
  [[ ${#chain[@]} -gt 0 ]] || die "no such request: $rid"

  local r
  for r in "${chain[@]}"; do
    jq -r --arg id "$r" 'select(.requestId==$id) |
      if   .event=="request.submitted" then
        "\($id)  SUBMITTED  \(.requester) [\(.requesterTemplate)] requests \(.template) — \"\(.title)\"" +
        (if (.rationale // "") != "" then "\n        rationale: \(.rationale)" else "" end) +
        (if (.supersedes // null) != null then "\n        supersedes \(.supersedes)" else "" end)
      elif .event=="request.comment"  then "\($id)  COMMENT    \(.author): \(.body)"
      elif .event=="request.expired"  then "\($id)  EXPIRED    undecided; resubmission required"
      elif .event=="request.reviewed" then
        "\($id)  \(.status|ascii_upcase)   by \(.reviewer)" +
        (if (.reason // "") != "" then " — \(.reason)" else "" end) +
        (if (.override // null) != null then "\n        (standing-authority override; bypassed \(.override.bypassedLeader))" else "" end) +
        (if (.newAgentId // "") != "" then "\n        provisioned \(.newAgentId)" else "" end)
      else empty end' "$QUEUE"
  done
}

# --------------------------------------------------------------------------
cmd_list() {
  local want="pending"
  [[ "${1:-}" == "--status" ]] && want="$2"
  [[ -f "$QUEUE" ]] || { echo "(queue empty)"; return 0; }
  jq -s --arg w "$want" -r '
    map(select(.event != "request.comment"))
    | group_by(.requestId)
    | map({rid: .[0].requestId, sub: .[0], last: .[-1]})
    | map(select($w == "all" or .last.status == $w))
    | .[]
    | "\(.rid)\t\(.last.status)\t\(.sub.requester) [\(.sub.requesterTemplate)]\t\(.sub.template)\t\(.sub.title)\t\(.last.reviewer // "-")"
  ' "$QUEUE" | { printf 'ID\tSTATUS\tREQUESTER\tTEMPLATE\tTITLE\tREVIEWER\n'; cat; } | column -t -s$'\t'
}

cmd_set_template() {
  local tpl="$1" enable="$2" reviewer=""
  shift 2
  while [[ $# -gt 0 ]]; do
    case "$1" in --reviewer) reviewer="$2"; shift 2;; *) die "unknown argument: $1";; esac
  done
  [[ -n "$reviewer" ]] || die "usage: (disable|enable)-template <T> --reviewer <ROLE>"
  local row tpl_of; row="$(resolve_agent "$reviewer")"; [[ -n "$row" ]] || die "reviewer not found"
  tpl_of="$(f 3 "$row")"
  # Template disablement is a company-wide control, not a subtree decision, so
  # it stays with the standing authority and is deliberately NOT chain-derived.
  jq -e --arg t "$tpl_of" 'index($t) != null' <<<"$STANDING_AUTHORITY" >/dev/null \
    || die "$reviewer [$tpl_of] does not hold org.disable_template."
  touch "$DISABLED_TEMPLATES"
  if [[ "$enable" == "no" ]]; then
    grep -qxF "$tpl" "$DISABLED_TEMPLATES" || echo "$tpl" >> "$DISABLED_TEMPLATES"
    log_event "$(jq -cn --arg t "$tpl" --arg r "$reviewer" '{event:"template.disabled",template:$t,by:$r}')"
    echo "DISABLED template $tpl (by $reviewer)"
  else
    grep -vxF "$tpl" "$DISABLED_TEMPLATES" > "$DISABLED_TEMPLATES.tmp" 2>/dev/null || true
    mv "$DISABLED_TEMPLATES.tmp" "$DISABLED_TEMPLATES"
    log_event "$(jq -cn --arg t "$tpl" --arg r "$reviewer" '{event:"template.enabled",template:$t,by:$r}')"
    echo "ENABLED template $tpl (by $reviewer)"
  fi
}

case "${1:-}" in
  submit)           shift; cmd_submit "$@";;
  review)           shift; cmd_review "$@";;
  who)              shift; cmd_who "$@";;
  comment)          shift; cmd_comment "$@";;
  thread)           shift; cmd_thread "$@";;
  list)             shift; cmd_list "$@";;
  log)              [[ -f "$GRANT_LOG" ]] && cat "$GRANT_LOG" || echo "(no log)";;
  disable-template) shift; cmd_set_template "$1" no  "${@:2}";;
  enable-template)  shift; cmd_set_template "$1" yes "${@:2}";;
  *) sed -n '/^# USAGE/,/^# ====/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1;;
esac
