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
# The direct manager decides when their ceiling contains the template; otherwise
# the walk continues upward and records the objective skip reason.
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
#   * EVERY decision carries a reason, approvals included — the record has to
#     answer "why was this approved", not only "who approved it".
#   * A denial is not a dead end. It carries a reason, it can be answered with
#     `comment`, and it can be amended by a NEW request that `--supersedes` it.
#     `thread` renders the whole exchange, not just the final verdict.
#   * SAFER ALTERNATIVES FIRST. A denial must additionally carry at least one
#     alternative that still fully unblocks the work, or an explicit recorded
#     finding that none exists; and granting a RISKY template requires the
#     alternatives that were weighed and why each failed. See the TOG-388
#     block below RISK_KEYS for what that control does and does not do.
#   * One denial may be re-argued MAX_SUPERSEDE_CHAIN (5) times in total. The
#     cap counts every amendment sharing a chain root, so it cannot be evaded
#     by pointing many amendments at the same denial instead of chaining them.
#   * A request id names exactly one submission. Ids are allocated under a
#     lock, and a record where one id names two submissions is refused rather
#     than resolved — a decision that does not bind to what was decided is not
#     a decision. See reqrecord_assert_unambiguous.
#   * A pending request past its expiry is expired everywhere it is read, with
#     no review attempt needed to make that true.
#   * A decision REACHES THE REQUESTER. Every terminal transition — approved,
#     rejected, expired, failed — emits a notification addressed to the agent
#     that submitted the request. Delivery is an outbox and NEVER a gate: the
#     decision is committed first, delivery is attempted after, and a failed
#     delivery is logged rather than retried into a different approver.
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
#                                  (--approve|--reject) --reason "..."
#                                  # --reason is required on BOTH decisions
#
#     ...to DENY, additionally one of (safer-alternative-first, TOG-388):
#                                  --alternative "<safer route that still
#                                                 fully unblocks the work>"
#                                                 # repeatable
#                                  --no-safer-alternative "<the finding>"
#
#     ...to APPROVE a RISKY template, at least one pair:
#                                  --considered "<route weighed>" \
#                                  --because   "<why it did not unblock>"
#
#   ./org_request_queue.sh comment --request <ID> --author <ROLE> --body "..."
#   ./org_request_queue.sh thread  --request <ID>
#   ./org_request_queue.sh overrides [--all] [--json]   # exit 1 if any are open
#   ./org_request_queue.sh ack-override --request <ID> --auditor <ROLE> \
#                                       --note "..."
#   ./org_request_queue.sh risk-record [--all] [--json] # exit 1 if any are open
#   ./org_request_queue.sh ack-risk --request <ID> --auditor <ROLE> --note "..."
#   ./org_request_queue.sh inbox   --for <ROLE|AGENT_ID> [--json] # decisions on MY requests
#   ./org_request_queue.sh notify  [--list|--drain] [--json]  # delivery outbox
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

# The record layer reads its caller parameters at source time. Set every
# provisioning-specific value before loading it; capability_gate.sh overrides
# the same parameters for its CAP id space and two-key status model.
REQ_ID_PREFIX="REQ"
REQRECORD_STATUS_EVENTS='{"request.submitted":true,"request.reviewed":true,"request.expired":true}'
REQRECORD_TERMINAL_EVENTS='{"request.reviewed":true,"request.expired":true}'
REQRECORD_OPEN_STATUSES='pending'
SAFERALT_NO_ALT_CONSEQUENCE='The second is always recorded on the thread and sent to the requester, and on a
  RISKY ask it becomes an OPEN audit item (risk-record) until an auditor closes it.'
# Preserve the queue's historical non-overridable lock path. The library accepts
# an override for other callers, but this flow has always derived it from QUEUE.
QUEUE_LOCK="${QUEUE}.lock"

# A reporting chain deeper than this is a data error, not an org.
MAX_CHAIN_DEPTH="${MAX_CHAIN_DEPTH:-16}"
# A pending request that nobody decides expires. It does NOT escalate.
REQUEST_TTL_DAYS="${REQUEST_TTL_DAYS:-7}"
# A denial resubmitted this many times is not a disagreement resubmission fixes.
MAX_SUPERSEDE_CHAIN="${MAX_SUPERSEDE_CHAIN:-5}"

# --- telling the requester (TOG-254) ---------------------------------------
# The transport that turns a notification into something the requester actually
# receives. It reads one notification JSON object on stdin; exit 0 means
# delivered. Unset is a supported, honest state — deliveries are recorded
# `pull_only` and the requester reads them with `inbox`, which needs no
# credentials, no network and no `column`.
#
# This is a seam rather than a hardcoded API call because the queue runs
# operator-side against Postgres and holds no Paperclip agent credential of its
# own. See notify_paperclip_issue.sh for the reference adapter.
REQUEST_NOTIFY_CMD="${REQUEST_NOTIFY_CMD:-}"
# A hung transport must not hold the reviewer's terminal. This bounds it where
# coreutils `timeout` exists; the guarantee that does not depend on it is the
# ORDERING — the decision is already durably in the queue before delivery is
# attempted, so even SIGKILL mid-delivery cannot lose or alter it.
REQUEST_NOTIFY_TIMEOUT="${REQUEST_NOTIFY_TIMEOUT:-10}"

command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }
[[ -x "$PROV" ]] || { echo "ERROR: org_provisioner.sh not found/executable" >&2; exit 1; }

# shellcheck source=lib/reqrecord.sh
. "$HERE/lib/reqrecord.sh" || { echo "ERROR: missing $HERE/lib/reqrecord.sh" >&2; exit 1; }
# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; exit 1; }


# Standing authority. This is the escalation floor when no leader can be
# derived, and the break-glass path over a derived leader. It is no longer the
# only way a request can be decided.
STANDING_AUTHORITY='["P4_PROVISIONING_STEWARD","P1_PRESIDENT_COO"]'

# Who may ACKNOWLEDGE a standing-authority override, clearing it from the open
# audit list. Deliberately NOT the same set: an override that its own author can
# retire is a log entry, not a control. P3 is the independent audit function and
# is the intended acknowledger; P1 is here so a dormant P3 cannot wedge the
# review permanently, and is still bound by the not-your-own-override rule.
AUDIT_AUTHORITY='["P3_AUDIT_RISK","P1_PRESIDENT_COO"]'

# Request ceiling = create ceiling, plus the report's explicit approval-gated
# exception for the independent audit function.
REQUEST_EXTRA='{"P3_AUDIT_RISK":["E4_AUDIT_ANALYST"]}'

# ===========================================================================
# SAFER-ALTERNATIVE-FIRST REVIEW (TOG-388)
# ===========================================================================
# The `Gated Autonomy` goal, quoting the owner's 2026-08-25 instruction:
#
#   "The responsible agent must then, when the ask is risky, propose safer
#    alternatives that still FULLY unblock the work. Only when no safer
#    alternative exists may the risky ask be granted — never lightly, never
#    without recording which alternatives were considered and why each failed."
#
# TOG-194/TOG-198 already made a denial answerable: it carries a reason, it can
# be answered with `comment`, and it can be amended with `--supersedes`. What
# was missing is the THINKING. A denial could say "too risky" and stop, and an
# approval of a capability that touches credentials or CI could be granted with
# nothing on the record but "approved — needed". Both are now refused.
#
#   * A DENIAL must carry --reason AND either at least one --alternative or an
#     explicit --no-safer-alternative finding. "No" without a next move is the
#     dead end the whole system exists to avoid; "no, and here is nothing" is
#     allowed, but it must be SAID and it becomes an open audit item.
#   * An APPROVAL of a RISKY template must carry at least one
#     --considered/--because pair. That is the record the owner audits later.
#
# WHAT THIS CONTROL CANNOT DO. It cannot tell a real alternative from the word
# "none" typed into --alternative. No script can. What it CAN do is make the
# omission impossible and the content NAMED, attributed and durable, so a
# reviewer who skips the thinking has to write down that they skipped it, under
# their own role id, in a record `risk-record` and org_access_review.sh both
# read. That is the same trade the standing-authority override design already
# made: convert a silent gap into a loud one. Stated plainly here because a
# control whose limits are undocumented gets trusted for more than it does.

# Permission keys whose grant makes an ask RISKY. Chosen against the owner line
# in the `Gated Autonomy` goal — real money, credentials, anything published
# outside the company, anything with no rollback — mapped onto this catalog:
#
#   tools:admin              administers the tool substrate for everyone; this
#                            is the master-key shape the goal names directly.
#   tools:manage_connections creates and edits credentialed tool connections.
#   tools:manage_runtime     changes the runtime other agents execute in; there
#                            is no clean rollback for work already run under it.
#   environments:manage      environment writes, which are secret-adjacent.
#   pipelines:write          CI/CD write is the path to anything published
#                            outside the company.
#   skills:create            a skill is code other agents execute. "Walls, not
#                            rules" cuts both ways: authoring the instructions
#                            a fleet runs is a capability, not a document.
#   users:manage_permissions absent from today's catalog on purpose — it is the
#                            master key, and it is listed here so that the day
#                            it appears it is risky by default rather than by
#                            somebody remembering.
RISK_KEYS='["tools:admin","tools:manage_connections","tools:manage_runtime","environments:manage","pipelines:write","skills:create","users:manage_permissions"]'

# Permission keys reviewed and judged NOT to make an ask risky. This list is not
# decoration and it is not the complement of RISK_KEYS — it is the second half
# of a TOTALITY CHECK. classify_risk refuses any template carrying a key on
# NEITHER list.
#
# That is the anti-rot property, and it is the reason to spend a list on it: the
# alternative shapes all fail the same way. A bare denylist silently opts every
# NEW permission key into "safe", so the day someone adds `secrets:read` to a
# template the classifier keeps answering "not risky" and the control quietly
# stops applying to the one grant it most exists for. The queue already learned
# this exact lesson once — see the status-event allowlist, where a denylist of event types
# made every new event a decision. An unclassified key is a question nobody has
# answered yet, and the honest answer to an unanswered question is to stop.
NONRISK_KEYS='["agents:configure","agents:suggest-changes","tasks:assign_scope","tasks:manage_active_checkouts","skills:suggest-changes","tools:view_audit","tools:use","audit:view_agent_actions"]'

# Template -> permission keys, read LIVE from the provisioner's catalog rather
# than copied here. A copy would keep answering with yesterday's catalog after
# the real one changed, which is the specific way a classifier goes quietly
# wrong; test_responsible_leader.sh makes the same argument about its ceiling
# stub. Emits the comma-joined key list, or nothing if the template is unknown.
#
# Deliberately `template-keys` and not `templates`: the human view is padded by
# `column`, which is util-linux and is ABSENT in the paperclip container, where
# it prints nothing at all rather than failing. A risk classifier reading an
# empty catalog would answer "no keys, not risky" for every template on earth.
template_keys() {
  "$PROV" template-keys 2>/dev/null | awk -F'\t' -v t="$1" '$1==t{print $2; found=1} END{exit !found}'
}

# Is template $1 risky? Prints the comma-separated risk factors and returns 0
# when it is, prints nothing and returns 1 when it is not.
#
# FAILS CLOSED IN BOTH DIRECTIONS, and the two failures are different:
#   return 2 — the catalog could not be read, or the template is not in it. The
#              classifier has no opinion, and "no opinion" must never render as
#              "not risky".
#   return 3 — the template carries a key on neither list. Someone extended the
#              catalog without deciding whether the new grant is risky, and the
#              decision belongs to them, not to a default.
# Callers must distinguish >=2 from 1. Treating any non-zero as "not risky" is
# precisely the bug this function is shaped to prevent.
classify_risk() {
  local keys factors
  keys="$(template_keys "$1")" || return 2
  [[ -n "$keys" ]] || return 1                 # a template with no grants at all
  local unknown
  unknown="$(jq -rn --arg k "$keys" --argjson r "$RISK_KEYS" --argjson s "$NONRISK_KEYS" \
    '($k|split(",")) - $r - $s | join(",")')"
  if [[ -n "$unknown" ]]; then
    printf '%s\n' "$unknown"
    return 3
  fi
  factors="$(jq -rn --arg k "$keys" --argjson r "$RISK_KEYS" \
    '[($k|split(","))[] | select(. as $x | $r | index($x))] | join(",")')"
  [[ -n "$factors" ]] || return 1
  printf '%s\n' "$factors"
  return 0
}

# -Atq and ON_ERROR_STOP are this tool's flags; the backend choice is not its
# business. Wrapper keeps every call site below unchanged. See lib/pcsql.sh.
pcsql() { pcsql_run -Atq -v ON_ERROR_STOP=1 "$@"; }

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
       regexp_replace(COALESCE(a.title,''), E'[\\t\\r\\n]+', ' ', 'g')
FROM agents a
WHERE a.company_id = :'company_id'::uuid
  AND (a.metadata->>'orgRoleId' = :'text' OR a.id::text = :'text')
ORDER BY a.created_at LIMIT 1;
SQL
}

f() { cut -f"$1" <<<"$2"; }   # field $1 of a resolve_agent row

ceiling_for() { "$PROV" ceiling 2>/dev/null | awk -v t="$1" '$1==t{$1="";print}'; }

# May template $2 be CREATED by a caller whose profile is $1 ? (create ceiling)
#
# The ceiling is a comma-separated list, so the entries are split out and matched
# LITERALLY, one at a time. This used to interpolate $2 into a `grep -E` pattern
# instead, which inverted the question: the caller supplies --template, so a
# metacharacter stopped asking "is my template in the ceiling?" and started
# asking "does the ceiling match my pattern?" — and `.*` matches every ceiling
# there is. `[[ x == "$y" ]]` with the right side QUOTED is the literal
# comparison; unquoting it would reintroduce the same class of bug as a glob.
#
# derive_leader calls this too, so the bypass also chose the approver: under a
# pattern every ancestor looked able to create the template, which made the
# requester's own manager the responsible leader for a template nobody was
# entitled to. See TOG-255 and section 11 of test_responsible_leader.sh.
may_create() {
  [[ -n "$1" && -n "$2" ]] || return 1
  local entry
  while IFS= read -r entry; do
    [[ "$entry" == "$2" ]] && return 0
  done < <(ceiling_for "$1" | tr ', \t' '\n' | grep -v '^$')
  return 1
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


# --- serialising the queue --------------------------------------------------
# The append-only record, its lock, derived expiry and one-decision invariants
# live in lib/reqrecord.sh. This file keeps only provisioning-specific writers
# and views; every read and write below calls the sourced implementation.

# Materialise expiry for every request that has aged out, so `thread` and `list`
# show it and the audit trail records that it happened. Idempotent, and safe to
# call from a read path: it writes a DERIVED fact, never a decision. On a
# read-only queue it fails quietly and reqrecord_state() still derives correctly.
reap_expired() {
  [[ -f "$QUEUE" ]] || return 0
  local rows rid exp
  rows="$(jq -s -r --argjson ev "$REQRECORD_STATUS_EVENTS" '
      map(select($ev[.event] // false))
      | group_by(.requestId)
      | map({rid: .[0].requestId, exp: (.[0].expiresAt // ""), last: .[-1].status})
      | map(select(.last == "pending" and .exp != ""))
      | .[] | "\(.rid)\t\(.exp)"' "$QUEUE" 2>/dev/null)"
  [[ -n "$rows" ]] || return 0
  while IFS=$'\t' read -r rid exp; do
    [[ -n "$rid" ]] || continue
    if expired "$exp"; then
      append_queue "$(jq -cn --arg id "$rid" --arg at "$(now_iso)" --arg e "$exp" \
        '{event:"request.expired",requestId:$id,status:"expired",at:$at,expiredAt:$e}')"
      # Expiry was the quietest dead end of the three: nothing woke on it at
      # all. It notifies from whichever read path reaps it, once — the
      # idempotency guard in emit_notification is what makes that safe, since
      # `list` reaps on every invocation.
      emit_notification "$rid" expired >/dev/null 2>&1 || true
    fi
  done <<<"$rows"
  return 0
}

# ===========================================================================
# Telling the requester (TOG-254)
# ===========================================================================
# TOG-198 asked how the requester LEARNS a request was decided. Until now the
# answer was "it polls", which for an expiry meant "it does not". Four terminal
# transitions notify — approved, rejected, expired AND failed. `failed` is in
# that list because a provisioner refusal ends the request just as finally as a
# denial does, and it was the one terminal state nobody had named.
#
# THE ORDERING IS THE SECURITY PROPERTY. Delivery is not a control and must
# never become one: a notification that fails must not block, alter or
# re-target a decision, or the notifier becomes a way to influence
# authorization. That is enforced structurally, not by intent —
#
#   1. The decision row is appended to the queue BEFORE any notification work
#      begins. Every failure mode below — bad transport, hang, SIGKILL, full
#      disk — happens to a decision that is already final.
#   2. Delivery runs in a subshell with its status swallowed. It cannot fail a
#      caller, and there is no code path from here back into reviewer
#      derivation, the ceiling check, or the queue's decision rows.
#   3. Retry re-reads the recipient from the recorded notify.queued row and
#      NEVER re-derives it. Re-deriving would let an org change between
#      decision and retry silently re-point a notification at a different
#      agent, which is precisely the "notifier as authorization influence"
#      hazard, arriving through the back door.
#
# The recipient is the agent id recorded at SUBMIT time, not the role string. A
# role can be re-pointed at a different agent; the decision was made about a
# specific principal and is delivered to that principal.

# Has this request already had a notification queued? Terminal states are final
# and one-shot, so requestId alone is the idempotency key. This matters because
# expiry is reaped from READ paths — `list` must not re-notify on every run.
notify_already() {
  [[ -f "$QUEUE" ]] || return 1
  jq -s -e --arg id "$1" 'any(.[]; .event=="notify.queued" and .requestId==$id)' \
     "$QUEUE" >/dev/null 2>&1
}

# The human/agent-readable body. The requester has to be able to ACT on this,
# so each terminal state carries its next move rather than just its verdict.
notify_body() {
  local rid="$1" status="$2" role="$3" tpl="$4" title="$5" reason="$6" newid="$7" rv="$8"
  # The decision row itself, so the safer-alternatives record travels WITH the
  # decision instead of being something the requester has to go and look up.
  # An alternative the requester never receives is the same dead end as no
  # alternative at all — that is the whole argument TOG-254 made about reasons,
  # and it applies with more force to the part that says what to do next.
  local dec="${9:-}"
  printf 'Request %s (%s — "%s") is now %s.\n' "$rid" "$tpl" "$title" "$status"
  case "$status" in
    approved) printf 'Approved by %s. Seated agent id: %s\n' "$rv" "${newid:-unknown}"
              printf 'Reason given: %s\n' "$reason"
              if jq -e '.risk.risky == true' <<<"${dec:-null}" >/dev/null 2>&1; then
                printf '\nThis was a RISKY ask (%s). It was granted only after these safer\n' \
                       "$(jq -r '.risk.factors|join(", ")' <<<"$dec")"
                printf 'alternatives were weighed and found not to fully unblock the work:\n'
                jq -r '.alternativesConsidered[]? | "  - \(.alternative)\n      failed because: \(.whyItFailed)"' <<<"$dec"
              fi;;
    rejected) printf 'Denied by %s.\nReason given: %s\n\n' "$rv" "$reason"
              if jq -e '(.alternatives // []) | length > 0' <<<"${dec:-null}" >/dev/null 2>&1; then
                printf 'SAFER ALTERNATIVES OFFERED — each of these is meant to fully unblock\n'
                printf 'the work you asked for. Try one before resubmitting:\n'
                jq -r '.alternatives[] | "  - " + .' <<<"$dec"
                printf '\n'
              elif jq -e '(.noSaferAlternative // null) != null' <<<"${dec:-null}" >/dev/null 2>&1; then
                printf 'NO SAFER ALTERNATIVE was found. The reviewer recorded this finding,\n'
                printf 'and it is now an open item in the standing access review:\n'
                printf '  %s\n' "$(jq -r '.noSaferAlternative' <<<"$dec")"
                printf 'If you disagree, say so on the record with `comment` — that is what\n'
                printf 'the auditor reading the open item will see.\n\n'
              fi
              printf 'You can answer this. Either:\n'
              printf '  ./org_request_queue.sh comment --request %s --author %s --body "..."\n' "$rid" "$role"
              printf '  ./org_request_queue.sh submit --requester %s --template %s --title "%s" --supersedes %s\n' \
                     "$role" "$tpl" "$title" "$rid";;
    expired)  printf 'Nobody decided it before it aged out. It did NOT move to another\n'
              printf 'approver — expiry never re-targets a request. Resubmit it to the same\n'
              printf 'leader:\n'
              printf '  ./org_request_queue.sh submit --requester %s --template %s --title "%s" --supersedes %s\n' \
                     "$role" "$tpl" "$title" "$rid";;
    failed)   printf 'It was APPROVED by %s, but the provisioner then refused it, so no agent\n' "$rv"
              printf 'was seated and no partial state was left behind.\n'
              printf 'Provisioner error: %s\n\n' "$reason"
              printf 'This needs the error fixed and a fresh request:\n'
              printf '  ./org_request_queue.sh submit --requester %s --template %s --title "%s" --supersedes %s\n' \
                     "$role" "$tpl" "$title" "$rid";;
  esac
}

# Set by emit_notification for callers that want to report delivery state.
# Never consulted by any authorization path.
NOTIFY_RESULT=""

# emit_notification <requestId> <status> [reason] [newAgentId] [reviewer]
#
# STDOUT-SILENT on purpose: this is reached from read paths (`list` reaps
# expiry), and a notifier that prints into a TSV listing corrupts the listing.
# The record is the queue; `notify --list` and `inbox` are how it is read.
emit_notification() {
  local rid="$1" status="$2" reason="${3:-}" newid="${4:-}" rv="${5:-}"
  NOTIFY_RESULT=""
  notify_already "$rid" && { NOTIFY_RESULT="already"; return 0; }

  local sub; sub="$(request_submission "$rid" 2>/dev/null)" || return 0
  [[ -n "$sub" ]] || return 0

  local role aid tpl title nissue
  role="$(jq -r '.requester // ""' <<<"$sub")"
  aid="$(jq -r '.requesterAgentId // ""' <<<"$sub")"
  tpl="$(jq -r '.template // ""' <<<"$sub")"
  title="$(jq -r '.title // ""' <<<"$sub")"
  nissue="$(jq -r '.notifyIssue // ""' <<<"$sub")"

  # Read back the decision row rather than threading its fields through five
  # more positional parameters. Safe by ordering: cmd_review appends the row
  # before it calls here, exactly as property 1 above requires. `expired` has
  # no reviewed row and gets an empty string, which notify_body treats as "no
  # record" rather than as an error.
  local dec=""
  if [[ -f "$QUEUE" ]]; then
    dec="$(jq -c --arg id "$rid" \
      'select(.event=="request.reviewed" and .requestId==$id)' "$QUEUE" 2>/dev/null | tail -1)"
  fi

  local body; body="$(notify_body "$rid" "$status" "$role" "$tpl" "$title" "$reason" "$newid" "$rv" "$dec")"

  # The field below is `decision`, NOT `status`: a notification is not a state
  # transition, and a row that merely LOOKS like one is indistinguishable from
  # one to any query filtering on shape instead of on event name. Belt to
  # the status-event allowlist's braces — either alone fixes it; both means a future query
  # written either way stays correct.
  local payload
  payload="$(jq -cn --arg id "$rid" --arg s "$status" --arg a "$aid" --arg r "$role" \
    --arg t "$tpl" --arg ti "$title" --arg re "$reason" --arg n "$newid" \
    --arg rv "$rv" --arg b "$body" --arg at "$(now_iso)" --arg ni "$nissue" \
    '{event:"notify.queued",requestId:$id,decision:$s,
      recipientAgentId:$a,recipientRole:$r,
      notifyIssue:(if $ni=="" then null else $ni end),
      template:$t,title:$ti,
      reason:(if $re=="" then null else $re end),
      newAgentId:(if $n=="" then null else $n end),
      reviewer:(if $rv=="" then null else $rv end),
      body:$b,at:$at}')"

  # A malformed payload must NEVER reach the queue. One unparseable row breaks
  # every reader of the decision record, and the notifier — the component least
  # entitled to affect decisions — must not be able to do that. Drop it and
  # record the failure instead.
  if ! jq -e 'type=="object"' <<<"$payload" >/dev/null 2>&1; then
    NOTIFY_RESULT="failed"
    return 0
  fi

  # Intent is recorded BEFORE delivery is attempted. A crash between the two
  # leaves a queued-but-undelivered notification, which `notify --drain` can
  # finish; the reverse order would lose the notification silently.
  append_queue "$payload"
  notify_deliver "$payload"
}

# Attempt one delivery for an already-queued notification. Records the outcome
# and ALWAYS returns 0 — see property 2 above.
notify_deliver() {
  local payload="$1" rid out rc
  rid="$(jq -r '.requestId' <<<"$payload")"

  if [[ -z "$REQUEST_NOTIFY_CMD" ]]; then
    append_queue "$(jq -cn --arg id "$rid" --arg at "$(now_iso)" \
      '{event:"notify.pull_only",requestId:$id,at:$at,
        detail:"REQUEST_NOTIFY_CMD unset; requester reads this with `inbox`"}')"
    NOTIFY_RESULT="pull_only"
    return 0
  fi

  # Subshell + swallowed status: a transport that exits non-zero, hangs, or
  # dies on a signal cannot propagate into the caller's control flow.
  out="$(
    if command -v timeout >/dev/null 2>&1; then
      printf '%s' "$payload" | timeout "$REQUEST_NOTIFY_TIMEOUT" \
        bash -c "$REQUEST_NOTIFY_CMD" 2>&1
    else
      printf '%s' "$payload" | bash -c "$REQUEST_NOTIFY_CMD" 2>&1
    fi
  )" && rc=0 || rc=$?

  if [[ $rc -eq 0 ]]; then
    append_queue "$(jq -cn --arg id "$rid" --arg at "$(now_iso)" --arg d "$out" \
      '{event:"notify.delivered",requestId:$id,at:$at,detail:$d}')"
    NOTIFY_RESULT="delivered"
  else
    append_queue "$(jq -cn --arg id "$rid" --arg at "$(now_iso)" --arg d "$out" \
      --argjson rc "$rc" \
      '{event:"notify.failed",requestId:$id,at:$at,exit:$rc,detail:$d}')"
    NOTIFY_RESULT="failed"
  fi
  return 0
}

# Current delivery state per notified request: delivered | failed | pull_only |
# queued. The LAST outcome row wins, so a drained retry supersedes its failure.
notify_states() {
  [[ -f "$QUEUE" ]] || return 0
  jq -s -r '
    map(select(.event | startswith("notify.")))
    | group_by(.requestId)
    | map({rid: .[0].requestId,
           q:   (map(select(.event=="notify.queued")) | .[0]),
           last:(map(select(.event!="notify.queued")) | last)})
    | map({rid, status:.q.decision, role:.q.recipientRole, agent:.q.recipientAgentId,
           state:(if .last == null then "queued"
                  else (.last.event | ltrimstr("notify.")) end),
           at:.q.at, body:.q.body, detail:(.last.detail // "")})
    | .[] | @json' "$QUEUE" 2>/dev/null
}

# --------------------------------------------------------------------------
cmd_submit() {
  local requester="" template="" title="" rationale="" supersedes="" notify_issue=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --requester)  requester="$2";  shift 2;;
      --template)   template="$2";   shift 2;;
      --title)      title="$2";      shift 2;;
      --rationale)  rationale="$2";  shift 2;;
      --supersedes) supersedes="$2"; shift 2;;
      # Where the requester wants to be TOLD. Recorded at submit, addressed to
      # at decision time. It cannot affect who decides — but "not a control
      # issue", which is what this comment used to say, was too strong. A
      # delivery address is interpolated into a URL by whatever transport ships
      # it, so an unvalidated one lets the least-privileged party in the flow
      # choose the route an operator-credentialed request takes. It did: see
      # the TOG-198 review note in notify_paperclip_issue.sh. Validated here so
      # a hostile address is never RECORDED, and again in the transport so a
      # restored or hand-edited queue is still refused.
      --notify-issue) notify_issue="$2"; shift 2;;
      --reports-to|--parent) die "reportsTo is never caller-supplied; placement is derived from the requester.";;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$requester" && -n "$template" && -n "$title" ]] \
    || die "usage: submit --requester <ROLE> --template <T> --title <TITLE>"

  # Resolve display metadata without moving the validation gate: malformed
  # delivery addresses are still refused before requester validity is revealed.
  local row id tpl status requester_title
  row="$(resolve_agent "$requester")"
  id="$(f 1 "$row")"; tpl="$(f 3 "$row")"; status="$(f 4 "$row")"; requester_title="$(f 6 "$row")"
  if [[ -n "$notify_issue" && ! "$notify_issue" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
    log_event "$(jq -cn --arg r "$requester" --arg rid "$id" --arg rt "$requester_title" --arg n "$notify_issue" \
      '{event:"request.refused",reason:"malformed_notify_issue",requester:$r,
        requesterAgentId:(if $rid=="" then null else $rid end),
        requesterTitle:(if $rt=="" then null else $rt end),notifyIssue:$n}')"
    die "--notify-issue '$notify_issue' is not a well-formed issue id."
  fi
  reap_expired

  [[ -n "$row" ]] || die "requester not found: $requester"
  [[ "$status" != "terminated" ]] || die "requester $requester is terminated."
  [[ -n "$tpl" ]] || die "requester has no permissionProfile; refusing to infer authority."

  if ! may_request "$tpl" "$template"; then
    log_event "$(jq -cn --arg r "$requester" --arg rid "$id" --arg rt "$requester_title" \
      --arg t "$tpl" --arg w "$template" \
      '{event:"request.refused",reason:"template_above_request_ceiling",requester:$r,
        requesterAgentId:$rid,requesterTitle:(if $rt=="" then null else $rt end),
        requesterTemplate:$t,requestedTemplate:$w}')"
    echo "  requester template : $tpl" >&2
    echo "  requested          : $template" >&2
    die "template '$template' is above the request ceiling of '$tpl'."
  fi

  # An amendment must come from the SAME requester, and may only follow a
  # closed request. Nobody chains onto someone else's denial, and nobody forks
  # a request that is still live.
  local depth=0 root=""
  if [[ -n "$supersedes" ]]; then
    reqrecord_assert_unambiguous "$supersedes"
    local prev prev_sub prev_status prev_requester path_depth root_count
    prev="$(reqrecord_state "$supersedes")" || die "no such request: $supersedes"
    [[ -n "$prev" ]] || die "no such request: $supersedes"
    prev_sub="$(request_submission "$supersedes")"
    prev_status="$(jq -r '.status' <<<"$prev")"
    prev_requester="$(jq -r '.requesterAgentId' <<<"$prev_sub")"
    [[ "$prev_requester" == "$id" ]] \
      || die "only the original requester may supersede $supersedes."
    [[ "$prev_status" == "rejected" || "$prev_status" == "expired" ]] \
      || die "request $supersedes is '$prev_status'; only a rejected or expired request can be superseded."

    # THE CAP COUNTS AMENDMENTS OF ONE DENIAL, NOT THE LENGTH OF ONE PATH.
    # supersedeDepth = prev.depth + 1 measures a single chain, so N amendments
    # all pointing at the SAME denial are each depth 1, forever — one denial
    # could be re-argued without limit, which is how a rubber stamp is
    # manufactured. Every amendment therefore carries the ROOT of its chain and
    # the cap counts submissions sharing that root.
    root="$(jq -r '.chainRoot // .requestId' <<<"$prev_sub")"
    root_count="$(jq -r --arg r "$root" \
      'select(.event=="request.submitted" and (.chainRoot // "")==$r)|.requestId' "$QUEUE" 2>/dev/null | wc -l)"
    # Path depth is kept as a floor so a queue written before chainRoot existed
    # is still bounded by the old rule rather than by nothing.
    path_depth=$(( $(jq -r '.supersedeDepth // 0' <<<"$prev_sub") + 1 ))
    depth=$(( root_count + 1 ))
    [[ $path_depth -gt $depth ]] && depth=$path_depth
    # `>` not `>=`: MAX_SUPERSEDE_CHAIN is the number of resubmissions ALLOWED,
    # and the docs and the CLI both say five. `>=` allowed four.
    if [[ $depth -gt $MAX_SUPERSEDE_CHAIN ]]; then
      log_event "$(jq -cn --arg id "$supersedes" --arg root "$root" --arg r "$requester" \
        --arg rid "$id" --arg rt "$requester_title" --argjson d "$depth" \
        '{event:"request.refused",reason:"supersede_chain_exhausted",supersedes:$id,chainRoot:$root,
          requester:$r,requesterAgentId:$rid,requesterTitle:(if $rt=="" then null else $rt end),depth:$d}')"
      die "request $root has already been resubmitted $MAX_SUPERSEDE_CHAIN times; escalate instead of resubmitting."
    fi
  fi

  # Derive the decider BEFORE the append, so the routing decision becomes part
  # of the durable record instead of a line of terminal output. Until TOG-390
  # this was computed afterwards purely to print, which meant the queue held no
  # answer to "who was this actually routed at?" — and any later check of
  # whether that agent could receive it had to re-derive from state that had
  # since moved. A routing decision nobody recorded is one nobody can audit.
  local d skips; d="$(derive_leader "$id" "$template")"; skips="$(f 5 "$d")"
  local lmode lid lrole leader_title leader_row
  lmode="$(f 1 "$d")"; lid="$(f 2 "$d")"; lrole="$(f 3 "$d")"
  leader_row="$(resolve_agent "$lid")"; leader_title="$(f 6 "$leader_row")"

  # Allocate and append as ONE critical section. reqrecord_next_id() derives the id by
  # counting rows, so a concurrent submitter that reads between our count and
  # our append takes the same id.
  local rid exp; exp="$(plus_days "$REQUEST_TTL_DAYS")"
  queue_lock
  rid="$(reqrecord_next_id)"
  append_queue "$(jq -cn --arg id "$rid" --arg r "$requester" --arg rid2 "$id" --arg rt "$requester_title" --arg t "$tpl" \
    --arg w "$template" --arg ti "$title" --arg ra "$rationale" --arg sup "$supersedes" \
    --arg root "$root" --argjson d "$depth" --arg at "$(now_iso)" --arg exp "$exp" \
    --arg ni "$notify_issue" \
    --arg lm "$lmode" --arg lid "$lid" --arg lr "$lrole" --arg lt "$leader_title" \
    '{event:"request.submitted",requestId:$id,status:"pending",requester:$r,requesterAgentId:$rid2,
      requesterTitle:(if $rt=="" then null else $rt end),
      requesterTemplate:$t,template:$w,title:$ti,rationale:$ra,
      supersedes:(if $sup=="" then null else $sup end),supersedeDepth:$d,
      chainRoot:(if $root=="" then null else $root end),
      notifyIssue:(if $ni=="" then null else $ni end),
      responsibleLeaderMode:(if $lm=="" then null else $lm end),
      responsibleLeaderAgentId:(if $lid=="" then null else $lid end),
      responsibleLeader:(if $lr=="" then null else $lr end),
      responsibleLeaderTitle:(if $lt=="" then null else $lt end),
      submittedAt:$at,expiresAt:$exp}')"
  queue_unlock

  echo "SUBMITTED $rid  ($requester [$tpl] requests $template — \"$title\")  status=pending"
  [[ -n "$supersedes" ]] && echo "  supersedes $supersedes (resubmission $depth of $MAX_SUPERSEDE_CHAIN)"

  # Name the decider at submit time so the requester knows who was woken. This
  # is INFORMATIONAL ONLY and confers nothing: the leader is re-derived from
  # fresh state at decision time.
  case "$lmode" in
    leader)   echo "  responsible leader : $lrole [$(f 4 "$d")]";;
    escalate) echo "  responsible leader : none in the reporting chain; escalated to the standing authority (A0 steward, O1).";;
    cycle)    echo "  responsible leader : UNRESOLVABLE (malformed reporting chain) — only the standing authority can decide this.";;
  esac
  jq -e 'length > 0' <<<"$skips" >/dev/null 2>&1 \
    && echo "  skipped in chain   : $(jq -r 'map("\(.agent) (\(.reason))")|join(", ")' <<<"$skips")"

  # "— will be woken to decide" is what this line used to promise, and on this
  # company it was usually false: 138 of 144 agents cannot be woken on demand,
  # so the wake is refused and the request waits until its TTL with nobody
  # having looked at it. Say what is actually true about reachability, and say
  # it at submit time while the requester is still standing here to read it.
  #
  # This NEVER blocks the submission. A request that was recorded and flagged
  # is recoverable; one that was refused because a liveness probe could not
  # reach its database is lost, and the probe is the least reliable component
  # in this path. The gate reports, the human decides.
  announce_reachability "$rid" "$lid" "$lrole"
  return 0
}

# --------------------------------------------------------------------------
# Report whether the agent we just routed at can actually receive the decision.
#
# Advisory by construction — see the note at the call site. Absent
# queue_liveness.sh the submission still stands and simply says nothing, which
# is the honest degradation: this tool has never made the promise before and a
# missing checker must not start failing submissions that used to work.
announce_reachability() {
  local rid="$1" lid="$2" lrole="$3"
  local probe="$HERE/queue_liveness.sh"
  [[ -n "$lid" && -x "$probe" ]] || return 0

  local out rc verdict cause
  out="$("$probe" probe --agent "$lid" 2>/dev/null)"; rc=$?
  IFS=$'\t' read -r verdict cause _ _ _ <<<"$out"
  case "$rc" in
    0) echo "  reachability       : $lrole can receive this decision." ;;
    4) printf '\033[1;33m  reachability       : %s IS DORMANT (%s) — it will NOT be woken.\033[0m\n' "${lrole:-$lid}" "$cause"
       echo "  This request has been recorded, but routing it here enqueues it into silence."
       echo "  Escalate to the standing authority, or hold it until the agent is restored:"
       echo "      ./queue_liveness.sh probe --agent $lid --explain"
       [[ "$cause" == undetermined ]] && \
         echo "  NOTE: throttled vs disabled could not be established — treat as unreachable, not as dead." ;;
    *) echo "  reachability       : UNKNOWN for ${lrole:-$lid} ($cause) — could not measure. Do not read this as reachable." ;;
  esac
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
  # The four safer-alternative flags are parsed by the SHARED contract in
  # lib/reqrecord.sh (TOG-403), not inline here, so this flow and
  # capability_gate.sh cannot end up enforcing two versions of the owner's
  # model. Behaviour is unchanged; the definition moved.
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

  # EVERY decision carries a reason, not just a denial. A denial needs one so
  # the requester knows what to answer; an approval needs one because "why was
  # this approved" is the question an audit actually comes back for, and the
  # approval path was the unguarded one. Checked before anything is read so the
  # refusal cannot depend on who is asking.
  [[ -n "$reason" ]] || die "every decision must carry --reason: a denial so the requester can answer it, an approval so the record can answer 'why'."

  # --- safer-alternative-first (TOG-388) -----------------------------------
  # Argument-shape checks run BEFORE the request is read, for the same reason
  # the --reason check does: a refusal that depends on who is asking, or on
  # which request was named, is a refusal a reviewer can shop around.
  saferalt_assert_direction "$decision"
  local n_alt n_cons
  n_alt="$(jq -r 'length' <<<"$SAFERALT_ALTS")"
  n_cons="$(jq -r 'length' <<<"$SAFERALT_CONSIDERED")"

  reap_expired
  reqrecord_assert_unambiguous "$rid"

  local rec sub; rec="$(reqrecord_state "$rid")" || die "no such request: $rid"
  [[ -n "$rec" ]] || die "no such request: $rid"
  sub="$(request_submission "$rid")"

  local rq_role rq_id_at_submit template title exp
  rq_role="$(jq -r '.requester' <<<"$sub")"
  rq_id_at_submit="$(jq -r '.requesterAgentId' <<<"$sub")"
  template="$(jq -r '.template' <<<"$sub")"
  title="$(jq -r '.title' <<<"$sub")"
  exp="$(jq -r '.expiresAt // ""' <<<"$sub")"

  # Expiry is derived by reqrecord_state(), so this fires whether or not anyone
  # has observed the request before now.
  local cur; cur="$(jq -r '.status' <<<"$rec")"
  [[ "$cur" != "expired" ]] \
    || die "request $rid expired at $exp; resubmit it with --supersedes $rid."
  # "Decisions are final" is a property of ONE REQUEST, not of the exchange. It
  # exists so that a decided id cannot be re-decided into a different answer —
  # the record must keep meaning what it meant. It is not a dead end: this same
  # command prints the two ways forward on every denial, `comment` answers a
  # denial on the record, and `--supersedes` amends and resubmits it. See the
  # header, notify_body, and section 8 of test_responsible_leader.sh.
  [[ "$cur" == "pending" ]] || die "request $rid is already '$cur'; decisions are final. To carry it forward: comment --request $rid --author <ROLE> --body \"...\", or submit ... --supersedes $rid."

  # --- is this a RISKY ask? (TOG-388) --------------------------------------
  # Derived from the template's own permission keys, never asked of the
  # reviewer. A reviewer-declared risk level is a checkbox the reviewer can
  # clear by declaring the ask safe, which makes the control optional for
  # exactly the reviewer it is meant to bind.
  local risk_factors="" risky="no" rc_risk
  risk_factors="$(classify_risk "$template")"; rc_risk=$?
  case $rc_risk in
    0) risky="yes";;
    1) risky="no";;
    2) log_event "$(jq -cn --arg id "$rid" --arg w "$template" \
         '{event:"review.refused",reason:"risk_unclassifiable",requestId:$id,template:$w}')"
       die "cannot read the permission keys for template '$template' from $PROV; refusing to decide an ask whose risk is unknown.";;
    3) log_event "$(jq -cn --arg id "$rid" --arg w "$template" --arg k "$risk_factors" \
         '{event:"review.refused",reason:"unclassified_permission_key",requestId:$id,template:$w,keys:$k}')"
       die "template '$template' grants permission key(s) [$risk_factors] that are on neither RISK_KEYS nor NONRISK_KEYS in org_request_queue.sh. Somebody extended the catalog without deciding whether the new grant is risky; that decision is theirs to make, not a default's.";;
  esac

  # Only when no safer alternative exists may the risky ask be granted — and
  # never without recording which alternatives were considered and why each
  # failed. That record is the artifact the owner audits, so its absence is the
  # thing that has to be impossible.
  if [[ "$decision" == "approved" && "$risky" == "yes" && $n_cons -eq 0 ]]; then
    log_event "$(jq -cn --arg id "$rid" --arg w "$template" --arg r "$reviewer" --arg f "$risk_factors" \
      '{event:"review.refused",reason:"risky_grant_without_alternatives_record",requestId:$id,template:$w,reviewer:$r,riskFactors:($f|split(","))}')"
    echo "  risk factors : $risk_factors" >&2
    saferalt_assert_grant_record "'$template'" \
      "review --reviewer $reviewer --request $rid --reject --reason \"...\" --alternative \"...\""
  fi

  local rvrow rv_id rv_tpl reviewer_title
  rvrow="$(resolve_agent "$reviewer")"; [[ -n "$rvrow" ]] || die "reviewer not found: $reviewer"
  rv_id="$(f 1 "$rvrow")"; rv_tpl="$(f 3 "$rvrow")"; reviewer_title="$(f 6 "$rvrow")"
  [[ "$(f 4 "$rvrow")" != "terminated" ]] || die "reviewer $reviewer is terminated."

  # --- authority, derived fresh from live state at DECISION time -----------
  local d mode leader_id leader_role leader_title leader_row standing="no" override="no"
  d="$(derive_leader "$rq_id_at_submit" "$template")"
  mode="$(f 1 "$d")"; leader_id="$(f 2 "$d")"; leader_role="$(f 3 "$d")"
  leader_row="$(resolve_agent "$leader_id")"; leader_title="$(f 6 "$leader_row")"
  jq -e --arg t "$rv_tpl" 'index($t) != null' <<<"$STANDING_AUTHORITY" >/dev/null && standing="yes"

  if [[ "$mode" == "leader" && "$rv_id" == "$leader_id" ]]; then
    :                                        # the responsible leader itself
  elif [[ "$standing" == "yes" ]]; then
    [[ "$mode" == "leader" ]] && override="yes"
  else
    log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" --arg rvid "$rv_id" --arg rvt "$reviewer_title" \
                 --arg t "$rv_tpl" --arg m "$mode" --arg l "$leader_role" --arg lid "$leader_id" --arg lt "$leader_title" \
      '{event:"review.refused",reason:"not_the_responsible_leader",requestId:$id,
        reviewer:$r,reviewerAgentId:$rvid,reviewerTitle:(if $rvt=="" then null else $rvt end),
        reviewerTemplate:$t,mode:$m,responsibleLeader:(if $l=="" then null else $l end),
        responsibleLeaderAgentId:(if $lid=="" then null else $lid end),
        responsibleLeaderTitle:(if $lt=="" then null else $lt end)}')"
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
    || { log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" --arg rvid "$rv_id" --arg rvt "$reviewer_title" \
           '{event:"review.refused",reason:"self_approval",requestId:$id,reviewer:$r,
             reviewerAgentId:$rvid,reviewerTitle:(if $rvt=="" then null else $rvt end)}')"
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
    local requester_title_at_submit
    requester_title_at_submit="$(jq -r '.requesterTitle // ""' <<<"$sub")"
    log_event "$(jq -cn --arg id "$rid" --arg r "$reviewer" --arg rvid "$rv_id" --arg rvt "$reviewer_title" \
      --arg q "$rq_role" --arg qid "$rq_id_at_submit" --arg qt "$requester_title_at_submit" \
      '{event:"review.refused",reason:"reviewer_is_descendant_of_requester",requestId:$id,
        reviewer:$r,reviewerAgentId:$rvid,reviewerTitle:(if $rvt=="" then null else $rvt end),
        requester:$q,requesterAgentId:$qid,requesterTitle:(if $qt=="" then null else $qt end)}')"
    die "$reviewer reports into $rq_role's own subtree; a captive approver is not a reviewer."
  fi

  local override_json='null'
  [[ "$override" == "yes" ]] && override_json="$(jq -cn --arg l "$leader_role" --arg id "$leader_id" --arg t "$leader_title" \
    '{bypassedLeader:$l,bypassedLeaderAgentId:$id,bypassedLeaderTitle:(if $t=="" then null else $t end)}')"

  # An override is an open audit item from the moment it is taken, and whoever
  # takes it is told so to their face. Writing it to the queue and saying
  # nothing is how a logged bypass becomes an unread one.
  #
  # On STDOUT, not stderr, and deliberately: the reviewer may be an agent
  # reaching this over the mcp_remote transport, and a tool wrapper returns the
  # command's stdout as the result while stderr is routinely discarded. A
  # notice the reviewer never receives is the failure this whole change exists
  # to fix. The stderr copy is one line, for an operator watching a terminal
  # with stdout piped somewhere else.
  announce_override() {
    [[ "$override" == "yes" ]] || return 0
    printf '\n  ** STANDING-AUTHORITY OVERRIDE **\n'
    printf '  %s decided this OVER the responsible leader (%s).\n' "$reviewer" "$leader_role"
    printf '  It is now an OPEN item in the standing access review (org_access_review.sh\n'
    printf '  check 10) until an auditor other than %s closes it with a reason:\n' "$reviewer"
    printf '      ./org_request_queue.sh ack-override --request %s --auditor <ROLE> --note "..."\n\n' "$rid"
    printf '\033[1;33mSTANDING-AUTHORITY OVERRIDE\033[0m on %s (bypassed %s) — now an open audit item.\n' \
           "$rid" "$leader_role" >&2
  }

  # Risk is recorded on EVERY decision, not only on the ones it gated. A denial
  # of a risky ask and a denial of a routine one look identical afterwards
  # otherwise, and "was this ask risky at the time it was decided" is a question
  # the audit asks about the whole queue, not about the approvals it happened to
  # stop. It also pins the classification to the decision: if RISK_KEYS changes
  # next quarter, the record still says what was known when the call was made.
  local risk_json
  risk_json="$(jq -cn --arg f "$risk_factors" \
    '{risky:($f != ""), factors:(if $f=="" then [] else ($f|split(",")) end)}')"

  if [[ "$decision" == "rejected" ]]; then
    append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg rvid "$rv_id" --arg rvt "$reviewer_title" --arg re "$reason" \
      --arg at "$(now_iso)" --argjson ov "$override_json" --argjson risk "$risk_json" \
      --argjson sa "$(saferalt_decision_json)" \
      '{event:"request.reviewed",requestId:$id,status:"rejected",reviewer:$rv,reviewerAgentId:$rvid,
        reviewerTitle:(if $rvt=="" then null else $rvt end),reason:$re,at:$at,override:$ov,
        risk:$risk} + $sa')"
    echo "REJECTED $rid by $reviewer — $reason"
    announce_override
    if [[ "$n_alt" -gt 0 ]]; then
      echo "  safer alternatives offered:"
      jq -r '.[] | "    - " + .' <<<"$SAFERALT_ALTS"
    else
      # Said to the reviewer's face, in the same shape as announce_override and
      # for the same reason: a finding recorded and not surfaced is a finding
      # nobody reads. It becomes an OPEN audit item only when the ask was risky
      # — see the narrowing argument in cmd_risk_record. On a routine ask it is
      # still recorded, still rendered by `thread`, and still reaches the
      # requester, which is what stops it being a dead end.
      printf '\n  ** NO SAFER ALTERNATIVE FOUND **\n'
      printf '  %s recorded that nothing safer would unblock this work:\n' "$reviewer"
      printf '    %s\n' "$SAFERALT_NO_ALT"
      if [[ "$risky" == "yes" ]]; then
        printf '  This was a RISKY ask (%s), so it is now an OPEN item in the\n' "$risk_factors"
        printf '  standing access review until an auditor other than %s closes it:\n' "$reviewer"
        printf '      ./org_request_queue.sh ack-risk --request %s --auditor <ROLE> --note "..."\n\n' "$rid"
        printf '\033[1;33mNO SAFER ALTERNATIVE\033[0m recorded on %s by %s — now an open audit item.\n' \
               "$rid" "$reviewer" >&2
      else
        printf '  Recorded on the thread. The requester can dispute it with `comment`.\n\n'
      fi
    fi
    echo "  the requester may answer with: comment --request $rid --author $rq_role --body \"...\""
    echo "  or amend and resubmit with:    submit --requester $rq_role ... --supersedes $rid"
    # AFTER the decision row is durably appended and after the reviewer has
    # been told. Nothing below can change the verdict or this function's exit.
    emit_notification "$rid" rejected "$reason" "" "$reviewer"
    announce_notify "$rq_role"
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
    append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg rvid "$rv_id" --arg rvt "$reviewer_title" \
      --arg e "$out" --arg at "$(now_iso)" \
      '{event:"request.reviewed",requestId:$id,status:"failed",reviewer:$rv,reviewerAgentId:$rvid,
        reviewerTitle:(if $rvt=="" then null else $rvt end),error:$e,at:$at}')"
    echo "$out" >&2
    # A provisioner refusal ends the request as finally as a denial does, and
    # it was the terminal state nobody had named. Notify BEFORE die(), or the
    # one path where the requester is most confused is the one that says least.
    emit_notification "$rid" failed "$out" "" "$reviewer"
    die "provisioner rejected the approved request; queue marked failed (no partial state)."
  fi
  local new_id; new_id="$(grep -oE 'PROVISIONED [A-Z0-9_]+ -> [0-9a-f-]{36}' <<<"$out" | awk '{print $4}')"
  append_queue "$(jq -cn --arg id "$rid" --arg rv "$reviewer" --arg rvid "$rv_id" --arg rvt "$reviewer_title" \
    --arg n "$new_id" --arg re "$reason" \
    --arg at "$(now_iso)" --argjson ov "$override_json" --argjson risk "$risk_json" \
    --argjson sa "$(saferalt_decision_json)" \
    '{event:"request.reviewed",requestId:$id,status:"approved",reviewer:$rv,reviewerAgentId:$rvid,
      reviewerTitle:(if $rvt=="" then null else $rvt end),newAgentId:$n,reason:$re,at:$at,override:$ov,
      risk:$risk} + $sa')"
  echo "APPROVED $rid by $reviewer"
  announce_override
  if [[ "$risky" == "yes" ]]; then
    printf '\n  ** RISKY ASK GRANTED ** (risk factors: %s)\n' "$risk_factors"
    printf '  Safer alternatives considered, and why each failed:\n'
    jq -r '.[] | "    - \(.alternative)\n        failed because: \(.whyItFailed)"' <<<"$SAFERALT_CONSIDERED"
    printf '  This is an OPEN item in the standing access review until an auditor other\n'
    printf '  than %s reads that record and closes it:\n' "$reviewer"
    printf '      ./org_request_queue.sh ack-risk --request %s --auditor <ROLE> --note "..."\n\n' "$rid"
    printf '\033[1;33mRISKY ASK GRANTED\033[0m on %s (%s) — now an open audit item.\n' \
           "$rid" "$risk_factors" >&2
  fi
  echo "$out"
  # The requester needs the seated agent's id, not just "yes" — that id is the
  # whole point of having asked.
  emit_notification "$rid" approved "$reason" "$new_id" "$reviewer"
  announce_notify "$rq_role"
}

# Tell the REVIEWER what happened to the requester's notification. A silent
# delivery failure on the reviewer's side is how "we notify the requester"
# decays back into "it polls" without anyone noticing.
announce_notify() {
  case "$NOTIFY_RESULT" in
    delivered) echo "  requester $1 notified.";;
    pull_only) echo "  requester $1 will see this via: inbox --for $1 (no push transport configured)";;
    failed)    echo "  NOTICE: delivery to $1 FAILED — the decision stands. Retry: notify --drain" ;;
  esac
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

  reqrecord_assert_unambiguous "$rid"
  local sub; sub="$(request_submission "$rid")" || die "no such request: $rid"
  [[ -n "$sub" ]] || die "no such request: $rid"
  local rq_id template; rq_id="$(jq -r '.requesterAgentId' <<<"$sub")"
  template="$(jq -r '.template' <<<"$sub")"

  local arow; arow="$(resolve_agent "$author")"; [[ -n "$arow" ]] || die "author not found: $author"
  local a_id a_tpl author_title
  a_id="$(f 1 "$arow")"; a_tpl="$(f 3 "$arow")"; author_title="$(f 6 "$arow")"
  # cmd_review refuses a terminated reviewer; this path resolved the author and
  # never checked, so a terminated agent could still write into the record of a
  # live decision.
  [[ "$(f 4 "$arow")" != "terminated" ]] || die "author $author is terminated."

  local d; d="$(derive_leader "$rq_id" "$template")"
  local ok="no"
  [[ "$a_id" == "$rq_id" ]] && ok="yes"
  [[ "$(f 1 "$d")" == "leader" && "$a_id" == "$(f 2 "$d")" ]] && ok="yes"
  jq -e --arg t "$a_tpl" 'index($t) != null' <<<"$STANDING_AUTHORITY" >/dev/null && ok="yes"
  [[ "$ok" == "yes" ]] \
    || die "$author is neither the requester nor the responsible leader for $rid."

  append_queue "$(jq -cn --arg id "$rid" --arg a "$author" --arg aid "$a_id" --arg atitle "$author_title" \
    --arg b "$body" --arg at "$(now_iso)" \
    '{event:"request.comment",requestId:$id,author:$a,authorAgentId:$aid,
      authorTitle:(if $atitle=="" then null else $atitle end),body:$b,at:$at}')"
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
  reap_expired

  local chain=() cur="$rid" depth=0 sub
  while [[ -n "$cur" && "$cur" != "null" && $depth -lt $((MAX_SUPERSEDE_CHAIN + 2)) ]]; do
    sub="$(request_submission "$cur")"; [[ -n "$sub" ]] || break
    chain=("$cur" "${chain[@]}")
    cur="$(jq -r '.supersedes // ""' <<<"$sub")"
    depth=$((depth+1))
  done
  [[ ${#chain[@]} -gt 0 ]] || die "no such request: $rid"

  # `thread` is the path that RENDERS the record as authoritative — it is what
  # a reviewer reads to see why REQ-001..003 were denied. Rendering a tampered
  # record without complaint is worse here than anywhere else, because the
  # whole purpose of this view is to be believed. Every request in the chain is
  # checked, not just the one asked for: a forged decision three amendments
  # back still changes what this view means.
  local r
  for r in "${chain[@]}"; do reqrecord_assert_unambiguous "$r"; done

  for r in "${chain[@]}"; do
    jq -r --arg id "$r" '
      def actor($title; $agentId; $legacy):
        if (($title // "") != "" and ($agentId // "") != "")
        then "\($title) [\($agentId)]"
        elif (($legacy // "") != "") then $legacy
        elif (($agentId // "") != "") then $agentId
        else "?" end;
      select(.requestId==$id) |
      if   .event=="request.submitted" then
        "\($id)  SUBMITTED  \(actor(.requesterTitle; .requesterAgentId; .requester)) [\(.requesterTemplate)] requests \(.template) — \"\(.title)\"" +
        (if (.responsibleLeaderAgentId // "") != "" then
           "\n        responsible leader: \(actor(.responsibleLeaderTitle; .responsibleLeaderAgentId; .responsibleLeader))"
         elif (.responsibleLeaderMode // "") == "escalate" then
           "\n        responsible leader: standing authority (reporting chain exhausted)"
         elif (.responsibleLeaderMode // "") == "cycle" then
           "\n        responsible leader: unresolvable reporting chain"
         else "" end) +
        (if (.rationale // "") != "" then "\n        rationale: \(.rationale)" else "" end) +
        (if (.supersedes // null) != null then "\n        supersedes \(.supersedes)" else "" end)
      elif .event=="request.comment"  then "\($id)  COMMENT    \(actor(.authorTitle; .authorAgentId; .author)): \(.body)"
      elif .event=="request.expired"  then "\($id)  EXPIRED    undecided; resubmission required"
      elif .event=="request.reviewed" then
        "\($id)  \(.status|ascii_upcase)   by \(actor(.reviewerTitle; .reviewerAgentId; .reviewer))" +
        (if (.reason // "") != "" then " — \(.reason)" else "" end) +
        (if (.override // null) != null then
           "\n        (standing-authority override; bypassed \(actor(.override.bypassedLeaderTitle; .override.bypassedLeaderAgentId; .override.bypassedLeader)))"
         else "" end) +
        # The safer-alternatives record (TOG-388). `thread` is the view a
        # reviewer reads before deciding an amendment and the view an audit
        # reads afterwards, so what was OFFERED and what was RULED OUT has to
        # appear here. Rendering only reasons would leave the amendment looking
        # like a resubmission of the same ask rather than the answer to a
        # specific alternative.
        (if ((.risk.risky // false) == true)
         then "\n        RISK: \(.risk.factors|join(", "))" else "" end) +
        (if ((.alternatives // []) | length) > 0
         then "\n        safer alternatives offered:\n" +
              ((.alternatives | map("          - " + .)) | join("\n"))
         else "" end) +
        (if (.noSaferAlternative // null) != null
         then "\n        NO SAFER ALTERNATIVE found: \(.noSaferAlternative)" else "" end) +
        (if ((.alternativesConsidered // []) | length) > 0
         then "\n        alternatives considered and why each failed:\n" +
              ((.alternativesConsidered
                | map("          - \(.alternative)\n              failed because: \(.whyItFailed)"))
               | join("\n"))
         else "" end) +
        (if (.newAgentId // "") != "" then "\n        provisioned \(.newAgentId)" else "" end)
      elif .event=="override.acknowledged" then
        "\($id)  OVERRIDE-ACK  by \(actor(.auditorTitle; .auditorAgentId; .auditor)) — \(.note)"
      elif .event=="risk.acknowledged" then
        "\($id)  RISK-ACK   by \(actor(.auditorTitle; .auditorAgentId; .auditor)) — \(.note)"
      else empty end' "$QUEUE"
  done
}

# --------------------------------------------------------------------------
# overrides — the standing-authority bypasses, as a list somebody is expected to
# read. The queue has recorded `override.bypassedLeader` since the derivation
# change landed, but recording is not surfacing: before this, seeing one meant
# already knowing the request id and opening its thread, or grepping the JSONL.
#
# Deliberately DB-free and `column`-free so it can run anywhere — this is what
# org_access_review.sh check 10 shells out to, and that has to work on a CI
# runner and inside a container, not only on the VPS.
#
# Exit status: 1 when unacknowledged overrides exist, 0 when none. That is the
# same cron/CI contract org_access_review.sh already uses. `die` still exits 2,
# so a real error stays distinguishable from a finding.
cmd_overrides() {
  local want="open" fmt="text"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all)  want="all";  shift;;
      --json) fmt="json";  shift;;
      *) die "usage: overrides [--all] [--json]";;
    esac
  done
  [[ -f "$QUEUE" ]] || { [[ "$fmt" == "text" ]] && echo "(queue empty — no overrides)"; return 0; }

  local rows
  rows="$(jq -s -c --arg w "$want" '
    (map(select(.event=="override.acknowledged"))
     | map({key:.requestId, value:{auditor:.auditor, note:.note, at:.at}})
     | from_entries) as $ack
    | (map(select(.event=="request.submitted"))
       | map({key:.requestId, value:{requester:.requester, template:.template, title:.title}})
       | from_entries) as $sub
    | map(select(.event=="request.reviewed" and (.override // null) != null)
          | {requestId, status, reviewer, at,
             bypassedLeader: .override.bypassedLeader,
             requester: ($sub[.requestId].requester // "?"),
             template:  ($sub[.requestId].template  // "?"),
             title:     ($sub[.requestId].title     // ""),
             ack:       ($ack[.requestId] // null)})
    | map(select($w == "all" or .ack == null))
    | .[]' "$QUEUE")"

  if [[ "$fmt" == "json" ]]; then
    [[ -n "$rows" ]] && printf '%s\n' "$rows"
  elif [[ -z "$rows" ]]; then
    echo "no unacknowledged standing-authority overrides"
  else
    printf 'REQUEST\tDECISION\tREVIEWER\tBYPASSED LEADER\tWHEN\tREQUESTER\tTEMPLATE\tACK\n'
    jq -r '[.requestId, .status, .reviewer, .bypassedLeader, .at, .requester, .template,
            (if .ack == null then "OPEN" else "acked by \(.ack.auditor)" end)] | @tsv' <<<"$rows"
  fi

  # Only OPEN ones are a finding; --all is a report, not a gate.
  local open_n
  open_n="$(jq -s 'map(select(.ack == null)) | length' <<<"$rows")"
  [[ "${open_n:-0}" -eq 0 ]]
}

# --------------------------------------------------------------------------
# ack-override — an auditor closes out a bypass, on the record and with a note.
#
# The point of the acknowledgement is that it makes the open list DRAIN. A
# finding that can never clear trains everyone to ignore the report, which is
# the same failure as not reporting it. So: overrides accumulate until an
# auditor looks at each one and says, in writing, what they concluded.
cmd_ack_override() {
  local rid="" auditor="" note=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --request) rid="$2";     shift 2;;
      --auditor) auditor="$2"; shift 2;;
      --note)    note="$2";    shift 2;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$rid" && -n "$auditor" ]] || die "usage: ack-override --request <ID> --auditor <ROLE> --note \"...\""
  [[ -n "$note" ]] || die "an acknowledgement must carry a note — 'seen' is not a review finding."
  [[ -f "$QUEUE" ]] || die "no such request: $rid"

  local ov
  ov="$(jq -s -c --arg id "$rid" \
        'map(select(.event=="request.reviewed" and .requestId==$id and (.override // null) != null)) | .[-1] // empty' \
        "$QUEUE")"
  [[ -n "$ov" ]] || die "$rid carries no standing-authority override to acknowledge."

  jq -e -s --arg id "$rid" 'any(.[]; .event=="override.acknowledged" and .requestId==$id)' "$QUEUE" >/dev/null \
    && die "$rid is already acknowledged."

  local row; row="$(resolve_agent "$auditor")"
  [[ -n "$row" ]] || die "auditor $auditor not found."
  local a_id a_tpl a_status auditor_title
  a_id="$(f 1 "$row")"; a_tpl="$(f 3 "$row")"; a_status="$(f 4 "$row")"; auditor_title="$(f 6 "$row")"
  [[ "$a_status" != "terminated" ]] || die "auditor $auditor is terminated."
  jq -e --arg t "$a_tpl" 'index($t) != null' <<<"$AUDIT_AUTHORITY" >/dev/null \
    || die "$auditor [$a_tpl] does not hold override-acknowledgement authority."

  # Not your own override. The whole value of the acknowledgement is that a
  # second pair of eyes saw the bypass; letting the bypasser clear it turns the
  # open list back into a write-only log.
  local rv_role rv_row rv_id
  rv_role="$(jq -r '.reviewer' <<<"$ov")"
  rv_id="$(jq -r '.reviewerAgentId // ""' <<<"$ov")"
  if [[ -z "$rv_id" ]]; then
    rv_row="$(resolve_agent "$rv_role")"
    rv_id="$(f 1 "$rv_row")"
  fi
  if [[ -n "$rv_id" && "$rv_id" == "$a_id" ]]; then
    log_event "$(jq -cn --arg id "$rid" --arg a "$auditor" \
      '{event:"override.ack_refused",reason:"self_acknowledgement",requestId:$id,auditor:$a}')"
    die "$auditor took this override; it cannot also clear it."
  fi

  append_queue "$(jq -cn --arg id "$rid" --arg a "$auditor" --arg aid "$a_id" --arg atitle "$auditor_title" \
    --arg n "$note" --arg at "$(now_iso)" \
    '{event:"override.acknowledged",requestId:$id,auditor:$a,auditorAgentId:$aid,
      auditorTitle:(if $atitle=="" then null else $atitle end),note:$n,at:$at}')"
  echo "ACKNOWLEDGED override on $rid by $auditor — $note"
}

# --------------------------------------------------------------------------
# risk-record — the safer-alternatives record, as a list somebody is expected to
# read (TOG-388). Two decision shapes land here, and they are the two the owner
# said must never be taken lightly:
#
#   grant       a RISKY ask was approved. The record must show which safer
#               alternatives were weighed and why each failed.
#   no-safer    a denial recorded that nothing safer would unblock the work.
#               That is the reviewer declining to offer a way forward, which is
#               allowed but is the one case where a denial IS close to a dead
#               end, so it is audited rather than trusted.
#
# Deliberately a SEPARATE command and a separate acknowledgement event from
# `overrides`. They answer different questions — "who decided this" versus "was
# a safer route looked for" — and a request can carry both at once. Folding
# them together would also silently change the meaning of the exit status that
# org_access_review.sh check 10 already gates on, which is how a working alarm
# gets repurposed into a broken one.
#
# Same DB-free, `column`-free, exit-1-on-findings contract as `overrides`.
cmd_risk_record() {
  local want="open" fmt="text"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all)  want="all";  shift;;
      --json) fmt="json";  shift;;
      *) die "usage: risk-record [--all] [--json]";;
    esac
  done
  [[ -f "$QUEUE" ]] || { [[ "$fmt" == "text" ]] && echo "(queue empty — no risk record)"; return 0; }

  local rows
  rows="$(jq -s -c --arg w "$want" '
    (map(select(.event=="risk.acknowledged"))
     | map({key:.requestId, value:{auditor:.auditor, note:.note, at:.at}})
     | from_entries) as $ack
    | (map(select(.event=="request.submitted"))
       | map({key:.requestId, value:{requester:.requester, template:.template, title:.title}})
       | from_entries) as $sub
    # Both classes are gated on the ask having been RISKY, and that is a
    # deliberate narrowing of what lands in front of an auditor. Every denial
    # must leave the requester somewhere to go — that duty is unconditional and
    # cmd_review enforces it on routine and risky asks alike. But the owner
    # instruction the audit item exists to serve is specifically about risky
    # asks, and a list that also collected "no safer route to seat a specialist"
    # would be mostly noise within a month. An open list nobody finishes reading
    # is the same failure as no list, which is the argument cmd_ack_override
    # already makes about acknowledgements draining.
    | map(select(.event=="request.reviewed"
                 and ((.risk.risky // false) == true)
                 and (   (.status=="approved")
                      or ((.noSaferAlternative // null) != null)))
          | {requestId, status, reviewer, at,
             kind: (if (.noSaferAlternative // null) != null then "no-safer" else "grant" end),
             riskFactors: (.risk.factors // []),
             noSaferAlternative: (.noSaferAlternative // null),
             alternativesConsidered: (.alternativesConsidered // []),
             requester: ($sub[.requestId].requester // "?"),
             template:  ($sub[.requestId].template  // "?"),
             title:     ($sub[.requestId].title     // ""),
             ack:       ($ack[.requestId] // null)})
    | map(select($w == "all" or .ack == null))
    | .[]' "$QUEUE")"

  if [[ "$fmt" == "json" ]]; then
    [[ -n "$rows" ]] && printf '%s\n' "$rows"
  elif [[ -z "$rows" ]]; then
    echo "no unacknowledged risky grants or no-safer-alternative findings"
  else
    printf 'REQUEST\tKIND\tDECISION\tREVIEWER\tTEMPLATE\tRISK FACTORS\tWHEN\tACK\n'
    jq -r '[.requestId, .kind, .status, .reviewer, .template,
            (if (.riskFactors|length) > 0 then (.riskFactors|join(",")) else "-" end), .at,
            (if .ack == null then "OPEN" else "acked by \(.ack.auditor)" end)] | @tsv' <<<"$rows"
  fi

  local open_n
  open_n="$(jq -s 'map(select(.ack == null)) | length' <<<"$rows")"
  [[ "${open_n:-0}" -eq 0 ]]
}

# --------------------------------------------------------------------------
# ack-risk — an auditor reads the safer-alternatives record and closes it out.
#
# Same shape and the same reasoning as ack-override: the open list has to be
# able to DRAIN or the report trains everyone to ignore it, and the bypasser
# cannot be the one who clears it or the record is write-only. The auditor set
# is AUDIT_AUTHORITY, not STANDING_AUTHORITY, for the reason stated there — a
# control its own subject can retire is a log entry.
cmd_ack_risk() {
  local rid="" auditor="" note=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --request) rid="$2";     shift 2;;
      --auditor) auditor="$2"; shift 2;;
      --note)    note="$2";    shift 2;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$rid" && -n "$auditor" ]] || die "usage: ack-risk --request <ID> --auditor <ROLE> --note \"...\""
  [[ -n "$note" ]] || die "an acknowledgement must carry a note — 'seen' is not a review finding."
  [[ -f "$QUEUE" ]] || die "no such request: $rid"

  local item
  item="$(jq -s -c --arg id "$rid" \
        'map(select(.event=="request.reviewed" and .requestId==$id
                    and (   ((.risk.risky // false) == true and .status=="approved")
                         or ((.noSaferAlternative // null) != null)))) | .[-1] // empty' \
        "$QUEUE")"
  [[ -n "$item" ]] || die "$rid carries no risky grant or no-safer-alternative finding to acknowledge."

  jq -e -s --arg id "$rid" 'any(.[]; .event=="risk.acknowledged" and .requestId==$id)' "$QUEUE" >/dev/null \
    && die "$rid is already acknowledged."

  local row a_id a_tpl a_status auditor_title
  row="$(resolve_agent "$auditor")"; [[ -n "$row" ]] || die "auditor $auditor not found."
  a_id="$(f 1 "$row")"; a_tpl="$(f 3 "$row")"; a_status="$(f 4 "$row")"; auditor_title="$(f 6 "$row")"
  [[ "$a_status" != "terminated" ]] || die "auditor $auditor is terminated."
  jq -e --arg t "$a_tpl" 'index($t) != null' <<<"$AUDIT_AUTHORITY" >/dev/null \
    || die "$auditor [$a_tpl] does not hold override-acknowledgement authority."

  local rv_role rv_row rv_id
  rv_role="$(jq -r '.reviewer' <<<"$item")"
  rv_id="$(jq -r '.reviewerAgentId // ""' <<<"$item")"
  if [[ -z "$rv_id" ]]; then
    rv_row="$(resolve_agent "$rv_role")"
    rv_id="$(f 1 "$rv_row")"
  fi
  if [[ -n "$rv_id" && "$rv_id" == "$a_id" ]]; then
    log_event "$(jq -cn --arg id "$rid" --arg a "$auditor" \
      '{event:"risk.ack_refused",reason:"self_acknowledgement",requestId:$id,auditor:$a}')"
    die "$auditor took this decision; it cannot also clear its risk record."
  fi

  append_queue "$(jq -cn --arg id "$rid" --arg a "$auditor" --arg aid "$a_id" --arg atitle "$auditor_title" \
    --arg n "$note" --arg at "$(now_iso)" \
    '{event:"risk.acknowledged",requestId:$id,auditor:$a,auditorAgentId:$aid,
      auditorTitle:(if $atitle=="" then null else $atitle end),note:$n,at:$at}')"
  echo "ACKNOWLEDGED risk record on $rid by $auditor — $note"
}

# --------------------------------------------------------------------------
# inbox — the PULL half, and the reason a failed push is not a dead end.
#
# This is the path that works with no credentials, no network, no transport
# configured and no `column`. Push can always fail; if the only answer to a
# failed push were another push, the design would have replaced one dead end
# with a less obvious one.
cmd_inbox() {
  local who="" json="no"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --for)  who="$2"; shift 2;;
      --json) json="yes"; shift;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$who" ]] || die "usage: inbox --for <ROLE|AGENT_ID>"
  [[ -f "$QUEUE" ]] || { echo "(no decisions)"; return 0; }
  reap_expired

  # Match the AGENT ID as well as the role. `--for` names ONE principal, but the
  # queue records whichever spelling the submitter used: an operator at a shell
  # types a role id (MGR), and the MCP transport — which has no role to type,
  # only an authenticated session — passes the agent uuid. Both `role` and
  # `agent` are written into the notify row at DECISION time from the submission
  # record, never by whoever is reading, so accepting either widens nothing.
  # What it stops is one agent's inbox being split in two by which door it
  # happened to submit through, which would make a decision unreadable to the
  # very principal it was addressed to. (TOG-312)
  local rows; rows="$(notify_states | jq -c --arg w "$who" 'select(.role==$w or .agent==$w)')"
  if [[ "$json" == "yes" ]]; then printf '%s\n' "${rows:-}"; return 0; fi
  [[ -n "$rows" ]] || { echo "(no decisions for $who)"; return 0; }

  jq -r '"\(.rid)\t\(.status|ascii_upcase)\t\(.at)\t\(.state)"' <<<"$rows" \
    | { printf 'ID\tDECISION\tAT\tDELIVERY\n'; cat; } | tabulate
  echo
  jq -r '"--- \(.rid) ---\n\(.body)"' <<<"$rows"
}

# --------------------------------------------------------------------------
# notify — the outbox itself. `--drain` retries failed deliveries.
#
# The retry re-reads the recipient from the recorded notify.queued row and
# never re-derives it from the org. That is deliberate and load-bearing: a
# retry that re-derived could be re-pointed at a different agent by an org
# change made between the decision and the retry, which would make the notifier
# a way to influence who learns about an authorization decision.
cmd_notify() {
  local mode="list" json="no"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --list)  mode="list";  shift;;
      --drain) mode="drain"; shift;;
      --json)  json="yes";   shift;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -f "$QUEUE" ]] || { echo "(no notifications)"; return 0; }

  if [[ "$mode" == "drain" ]]; then
    local rid n=0
    while read -r rid; do
      [[ -n "$rid" ]] || continue
      local q; q="$(jq -c --arg id "$rid" \
        'select(.event=="notify.queued" and .requestId==$id)' "$QUEUE" | head -1)"
      [[ -n "$q" ]] || continue
      notify_deliver "$q"          # same payload, same recipient, by construction
      echo "  $rid -> $NOTIFY_RESULT"
      n=$((n+1))
    done < <(notify_states | jq -r 'select(.state=="failed" or .state=="queued") | .rid')
    [[ $n -eq 0 ]] && echo "(nothing to drain)"
  fi

  local rows; rows="$(notify_states)"
  if [[ "$json" == "yes" ]]; then printf '%s\n' "${rows:-}"
  elif [[ -z "$rows" ]]; then echo "(no notifications)"
  else
    jq -r '"\(.rid)\t\(.status)\t\(.role)\t\(.state)"' <<<"$rows" \
      | { printf 'ID\tDECISION\tRECIPIENT\tDELIVERY\n'; cat; } | tabulate
  fi

  # Same cron/CI contract as `overrides`: an undelivered decision is an
  # operational finding. pull_only is NOT a failure — it is a configured state.
  local bad; bad="$(notify_states | jq -r 'select(.state=="failed" or .state=="queued") | .rid' | wc -l)"
  [[ "$bad" -eq 0 ]] || { echo "$bad notification(s) undelivered." >&2; return 1; }
  return 0
}

# --------------------------------------------------------------------------
cmd_list() {
  local want="pending"
  [[ "${1:-}" == "--status" ]] && want="$2"
  [[ -f "$QUEUE" ]] || { echo "(queue empty)"; return 0; }
  # So an aged-out request leaves the pending inbox on its own, rather than
  # sitting there looking decidable until somebody attempts a review.
  reap_expired
  jq -s --arg w "$want" --argjson ev "$REQRECORD_STATUS_EVENTS" -r '
    # A set, not an array: `$acked[.rid]` evaluates .rid against the row being
    # rendered, where `index(.rid)` would evaluate it against the array itself.
    (map(select(.event=="override.acknowledged")) | map({key:.requestId, value:true}) | from_entries) as $acked
    # Only status-bearing events may become `last`. A comment, acknowledgement
    # or notification landing there would give the request a null status and
    # silently drop it from every filtered listing. See the status-event allowlist.
    | map(select($ev[.event] // false))
    | group_by(.requestId)
    | map({rid: .[0].requestId, sub: .[0], last: .[-1]})
    | map(select($w == "all" or .last.status == $w))
    | .[]
    | "\(.rid)\t\(.last.status)\t\(.sub.requester) [\(.sub.requesterTemplate)]\t\(.sub.template)\t\(.sub.title)\t\(.last.reviewer // "-")\t" +
      (if (.last.override // null) == null then "-"
       elif $acked[.rid] then "bypassed \(.last.override.bypassedLeader) (acked)"
       else "BYPASSED \(.last.override.bypassedLeader) — UNREVIEWED" end)
  ' "$QUEUE" | { printf 'ID\tSTATUS\tREQUESTER\tTEMPLATE\tTITLE\tREVIEWER\tOVERRIDE\n'; cat; } | tabulate
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
  overrides)        shift; cmd_overrides "$@";;
  ack-override)     shift; cmd_ack_override "$@";;
  risk-record)      shift; cmd_risk_record "$@";;
  ack-risk)         shift; cmd_ack_risk "$@";;
  inbox)            shift; cmd_inbox "$@";;
  notify)           shift; cmd_notify "$@";;
  log)              [[ -f "$GRANT_LOG" ]] && cat "$GRANT_LOG" || echo "(no log)";;
  disable-template) shift; cmd_set_template "$1" no  "${@:2}";;
  enable-template)  shift; cmd_set_template "$1" yes "${@:2}";;
  *) sed -n '/^# USAGE/,/^# ====/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1;;
esac
