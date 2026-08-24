#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# Approval-gated Org Provisioning Request Queue
# ---------------------------------------------------------------------------
# Implements the report's `org.request_descendant` / `org.review_request`
# capabilities (sections 6 and 8) on top of org_provisioner.sh.
#
#   requester (chief/director/manager)  --submit-->  PENDING request
#   reviewer  (A0 steward, or O1)       --review-->  APPROVED -> provisioner
#                                                 \-> REJECTED
#
# SECURITY PROPERTIES
# -------------------
#   * Separation of duties. A requester can never approve its own request,
#     even if it otherwise holds review authority.
#   * Two-time validation. The delegation ceiling is checked at SUBMIT and
#     re-checked at APPROVAL against freshly-read state. A request approved
#     after the requester was demoted, moved, or terminated is refused —
#     the queue is not a way to bank stale authority (TOCTOU defence).
#   * Review authority is a closed set derived from the report:
#     P4_PROVISIONING_STEWARD (org.review_request) and P1_PRESIDENT_COO.
#     Holding `users:manage_permissions` does NOT confer review authority.
#   * Request ceiling is distinct from create ceiling. P3_AUDIT_RISK may
#     REQUEST audit specialists (report: "org.request_descendant, approval-
#     gated") while still being unable to CREATE anything directly.
#   * Template disablement (org.disable_template) is enforced at approval
#     time, so disabling a template immediately freezes pending requests
#     that would use it.
#   * Execution is delegated to org_provisioner.sh with the ORIGINAL
#     requester as caller, so every invariant in section 8.2 still applies.
#     The reviewer cannot redirect placement or widen the template.
#
# TRANSPORT NOTE
# --------------
# This is the authorization core. Agents still cannot reach it: exposing
# `submit` to agents requires registering an MCP tool application in
# Paperclip's tool gateway, which is a deliberate, separately-approved
# deployment step. Until then an operator submits on a requester's behalf,
# and the authorization decisions below are what actually bind.
#
# USAGE
#   ./org_request_queue.sh submit  --requester <ROLE> --template <T> \
#                                  --title "..." [--rationale "..."]
#   ./org_request_queue.sh list    [--status pending|approved|rejected|all]
#   ./org_request_queue.sh review  --reviewer <ROLE> --request <ID> \
#                                  (--approve|--reject) [--reason "..."]
#   ./org_request_queue.sh log                       # org.read_grant_log
#   ./org_request_queue.sh disable-template <T> --reviewer <ROLE>
#   ./org_request_queue.sh enable-template  <T> --reviewer <ROLE>
# ===========================================================================

COMPANY_ID="${COMPANY_ID:?Set COMPANY_ID}"
PAPERCLIP_DB_CTR="${PAPERCLIP_DB_CTR:-paperclip-db}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROV="$HERE/org_provisioner.sh"
QUEUE="${QUEUE:-$HERE/provisioner-request-queue.jsonl}"
DISABLED_TEMPLATES="${DISABLED_TEMPLATES:-$HERE/.provisioner-disabled-templates}"
GRANT_LOG="${GRANT_LOG:-$HERE/provisioner-grant-log.jsonl}"

command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }
[[ -x "$PROV" ]] || { echo "ERROR: org_provisioner.sh not found/executable" >&2; exit 1; }

# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; exit 1; }

die() { echo "REFUSED: $*" >&2; exit 2; }

# Roles permitted to review. Closed set, from the report.
REVIEW_AUTHORITY='["P4_PROVISIONING_STEWARD","P1_PRESIDENT_COO"]'

# Request ceiling = create ceiling, plus the report's explicit approval-gated
# exception for the independent audit function.
REQUEST_EXTRA='{"P3_AUDIT_RISK":["E4_AUDIT_ANALYST"]}'

# -Atq and ON_ERROR_STOP are this tool's flags; the backend choice is not its
# business. Wrapper keeps every call site below unchanged. See lib/pcsql.sh.
pcsql() { pcsql_run -Atq -v ON_ERROR_STOP=1 "$@"; }

# Freshly resolve a live agent -> "<id>\t<template>\t<status>\t<title>"
resolve_live() {
  PGV_COMPANY_ID="$COMPANY_ID" PGV_TEXT="$1" pcsql -F$'\t' <<'SQL'
SELECT a.id::text, COALESCE(a.metadata->>'permissionProfile',''), a.status, a.title
FROM agents a
WHERE a.company_id = :'company_id'::uuid
  AND (a.metadata->>'orgRoleId' = :'text' OR a.id::text = :'text')
ORDER BY a.created_at LIMIT 1;
SQL
}

ceiling_for() { "$PROV" ceiling 2>/dev/null | awk -v t="$1" '$1==t{$1="";print}'; }

# May template $2 be REQUESTED by a caller whose profile is $1 ?
may_request() {
  local caller_tpl="$1" want="$2" line
  line="$(ceiling_for "$caller_tpl")"
  grep -qE "(^|[ ,])${want}([ ,]|$)" <<<"$line" && return 0
  jq -e --arg c "$caller_tpl" --arg w "$want" \
     '(.[$c] // []) | index($w) != null' <<<"$REQUEST_EXTRA" >/dev/null 2>&1
}

template_disabled() {
  [[ -f "$DISABLED_TEMPLATES" ]] && grep -qxF "$1" "$DISABLED_TEMPLATES"
}

log_event() { printf '%s\n' "$1" >> "$GRANT_LOG"; chmod 0600 "$GRANT_LOG" 2>/dev/null || true; }

append_queue() { printf '%s\n' "$1" >> "$QUEUE"; chmod 0600 "$QUEUE" 2>/dev/null || true; }

# Current state of a request id = its most recent record.
request_state() { [[ -f "$QUEUE" ]] || return 1; jq -c --arg id "$1" 'select(.requestId==$id)' "$QUEUE" | tail -1; }

next_id() {
  local n=1
  [[ -f "$QUEUE" ]] && n=$(( $(jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" 2>/dev/null | wc -l) + 1 ))
  printf 'REQ-%03d' "$n"
}

# --------------------------------------------------------------------------
cmd_submit() {
  local requester="" template="" title="" rationale=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --requester) requester="$2"; shift 2;;
      --template)  template="$2";  shift 2;;
      --title)     title="$2";     shift 2;;
      --rationale) rationale="$2"; shift 2;;
      --reports-to|--parent) die "reportsTo is never caller-supplied; placement is derived from the requester.";;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$requester" && -n "$template" && -n "$title" ]] \
    || die "usage: submit --requester <ROLE> --template <T> --title <TITLE>"

  local row id tpl status
  row="$(resolve_live "$requester")"; [[ -n "$row" ]] || die "requester not found: $requester"
  id="$(cut -f1 <<<"$row")"; tpl="$(cut -f2 <<<"$row")"; status="$(cut -f3 <<<"$row")"
  [[ "$status" != "terminated" ]] || die "requester $requester is terminated."
  [[ -n "$tpl" ]] || die "requester has no permissionProfile; refusing to infer authority."

  if ! may_request "$tpl" "$template"; then
    log_event "$(jq -cn --arg r "$requester" --arg t "$tpl" --arg w "$template" \
      '{event:"request.refused",reason:"template_above_request_ceiling",requester:$r,requesterTemplate:$t,requestedTemplate:$w}')"
    echo "  requester template : $tpl" >&2
    echo "  requested          : $template" >&2
    die "template '$template' is above the request ceiling of '$tpl'."
  fi

  local rid; rid="$(next_id)"
  append_queue "$(jq -cn --arg id "$rid" --arg r "$requester" --arg rid2 "$id" --arg t "$tpl" \
    --arg w "$template" --arg ti "$title" --arg ra "$rationale" \
    '{event:"request.submitted",requestId:$id,status:"pending",requester:$r,requesterAgentId:$rid2,
      requesterTemplate:$t,template:$w,title:$ti,rationale:$ra}')"
  echo "SUBMITTED $rid  ($requester [$tpl] requests $template — \"$title\")  status=pending"
  echo "  awaiting review by a holder of org.review_request (A0 steward) or O1."
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

  local rec; rec="$(request_state "$rid")" || die "no such request: $rid"
  [[ -n "$rec" ]] || die "no such request: $rid"
  local cur; cur="$(jq -r '.status' <<<"$rec")"
  [[ "$cur" == "pending" ]] || die "request $rid is already '$cur'; decisions are final."

  local rvrow rv_id rv_tpl rq_role rq_id_at_submit template title
  rvrow="$(resolve_live "$reviewer")"; [[ -n "$rvrow" ]] || die "reviewer not found: $reviewer"
  rv_id="$(cut -f1 <<<"$rvrow")"; rv_tpl="$(cut -f2 <<<"$rvrow")"
  rq_role="$(jq -r '.requester' <<<"$rec")"
  rq_id_at_submit="$(jq -r '.requesterAgentId' <<<"$rec")"
  template="$(jq -r '.template' <<<"$rec")"
  title="$(jq -r '.title' <<<"$rec")"

  # Review authority is a closed set — not inferred from any permission key.
  jq -e --arg t "$rv_tpl" 'index($t) != null' <<<"$REVIEW_AUTHORITY" >/dev/null \
    || { log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" --arg t "$rv_tpl" \
           '{event:"review.refused",reason:"no_review_authority",requestId:$id,reviewer:$r,reviewerTemplate:$t}')"
         die "$reviewer [$rv_tpl] does not hold org.review_request."; }

  # Separation of duties.
  [[ "$rv_id" != "$rq_id_at_submit" ]] \
    || { log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" \
           '{event:"review.refused",reason:"self_approval",requestId:$id,reviewer:$r}')"
         die "a requester cannot review its own request ($rid)."; }

  if [[ "$decision" == "rejected" ]]; then
    append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg re "$reason" \
      '{event:"request.reviewed",requestId:$id,status:"rejected",reviewer:$rv,reason:$re}')"
    echo "REJECTED $rid by $reviewer${reason:+ — $reason}"
    return 0
  fi

  # --- approval-time re-validation (TOCTOU defence) -----------------------
  template_disabled "$template" \
    && { log_event "$(jq -cn --arg id "$rid" --arg w "$template" \
           '{event:"review.refused",reason:"template_disabled",requestId:$id,template:$w}')"
         die "template '$template' is currently disabled by the provisioning steward."; }

  local now; now="$(resolve_live "$rq_role")"
  [[ -n "$now" ]] || die "requester $rq_role no longer exists; refusing to execute a stale request."
  local now_id now_tpl now_status
  now_id="$(cut -f1 <<<"$now")"; now_tpl="$(cut -f2 <<<"$now")"; now_status="$(cut -f3 <<<"$now")"
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
    append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg e "$out" \
      '{event:"request.reviewed",requestId:$id,status:"failed",reviewer:$rv,error:$e}')"
    echo "$out" >&2
    die "provisioner rejected the approved request; queue marked failed (no partial state)."
  fi
  local new_id; new_id="$(grep -oE 'PROVISIONED [A-Z0-9_]+ -> [0-9a-f-]{36}' <<<"$out" | awk '{print $4}')"
  append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg n "$new_id" --arg re "$reason" \
    '{event:"request.reviewed",requestId:$id,status:"approved",reviewer:$rv,newAgentId:$n,reason:$re}')"
  echo "APPROVED $rid by $reviewer"
  echo "$out"
}

# --------------------------------------------------------------------------
cmd_list() {
  local want="pending"
  [[ "${1:-}" == "--status" ]] && want="$2"
  [[ -f "$QUEUE" ]] || { echo "(queue empty)"; return 0; }
  jq -r --arg w "$want" '
    [inputs? // empty] as $_ | .' /dev/null 2>/dev/null || true
  jq -s --arg w "$want" -r '
    group_by(.requestId)
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
  local row tpl_of; row="$(resolve_live "$reviewer")"; [[ -n "$row" ]] || die "reviewer not found"
  tpl_of="$(cut -f2 <<<"$row")"
  jq -e --arg t "$tpl_of" 'index($t) != null' <<<"$REVIEW_AUTHORITY" >/dev/null \
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
  list)             shift; cmd_list "$@";;
  log)              [[ -f "$GRANT_LOG" ]] && cat "$GRANT_LOG" || echo "(no log)";;
  disable-template) shift; cmd_set_template "$1" no  "${@:2}";;
  enable-template)  shift; cmd_set_template "$1" yes "${@:2}";;
  *) sed -n '/^# USAGE/,/^# ====/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1;;
esac
