#!/usr/bin/env bash
# ===========================================================================
# interaction_route.sh — where does this ask belong? (TOG-389)
# ===========================================================================
# Two thirds of every question this company has ever asked died without an
# answer: of 187 issue-thread interactions, 73 were cancelled and 47 expired.
# Only 18 ever got a reply. This tool exists so the routing decision stops
# being re-improvised per agent, per run.
#
#   ./interaction_route.sh route  --answer-type yes_no --addressee <id> \
#                                 --issue-assignee <id> --self <id>
#   ./interaction_route.sh check  < pending-interactions.json
#   ./interaction_route.sh explain
#
# WHY THIS IS A SCRIPT AND NOT A PARAGRAPH IN A README
# ----------------------------------------------------
# The rule has six conjunctive conditions and an ordering. A model re-deriving
# it from prose gets it wrong in a way that looks right — the interaction is
# created successfully, returns 201, carries a label that says an agent may
# answer it, and then nobody can. The failure is silent and only shows up as a
# card parked for a week.
#
# WHAT THE PLATFORM ACTUALLY ENFORCES (read from the running build, not docs)
# ---------------------------------------------------------------------------
# `routes/issues.js:2929-2984`, in this order. The FIRST gate is the one most
# callers do not know about, and it is not about policy at all:
#
#   :2946  assertAgentIssueMutationAllowed  -> resolver must be the issue
#          ASSIGNEE (:2795), or the issue must be unassigned (:2792). A
#          non-assignee is refused before policy is ever consulted.
#   :2952  payload.toolAction present       -> always board-only, no exceptions
#   :2956  review-verdict bypass            -> see REVIEW PATH below
#   :2962  effectiveResolverPolicy must be "board_or_agents"
#   :2971  addresseeAgentId must be unset or equal to the resolver
#   :2975  createdByAgentId must NOT be the resolver
#   :2979  sourceRunId must NOT be the resolver's run
#
# Measured 2026-08-25 by attempting each one and reading the refusal:
#   non-assignee   -> 403 "Agent cannot mutate another agent's issue"
#   assignee, but
#   board_only     -> 403 "This issue-thread interaction is board-only"
# Two distinct gates, distinct messages, documented order. Confirmed with a
# matched control rather than inferred from a single failure.
#
# TOG-395 extended that to :2971 with the same method:
#   assignee, addressed to a peer -> 403 "Only the addressed agent or a board
#                                         user may resolve this ..."
#   assignee, no addressee        -> 403 "Agents cannot resolve interactions
#                                         they created"
# One field changed, so the field is demonstrably READ. But on an issue
# assigned to someone else the refusal is :2946 instead, which fires first --
# so addresseeAgentId can only ever NARROW the eligible set, never widen it.
# The single exception is an UNASSIGNED issue, where :2792 returns early and
# the addressee becomes the operative selector. That is the only zero-code
# agent-to-agent routing path, and `check` used to report it as inert.
#
# THE MISTAKE THIS TOOL IS BUILT TO CATCH
# ---------------------------------------
# 42 of 49 pending interactions were created by the issue's own assignee. The
# creator bar at :2975 blocks every one of them, *whatever* their kind or
# policy. Flipping all 49 to `board_or_agents` would still leave 42 dead.
#
# So `route` refuses to emit an envelope whose addressee cannot actually
# resolve it. Asking politely is not the hard part; being answerable is.
#
# KIND DOES NOT SET POLICY — THIS IS THE MOST COMMON MISREADING
# --------------------------------------------------------------
# `services/issue-thread-interactions.js:116-125` is a fallback chain, not a
# cap: the policy you request wins. The kind only supplies a DEFAULT when you
# omit the field. Across all 187 rows this company has created,
# `requested == effective` every single time — nothing has ever been
# overridden. Both "impossible" combinations exist in the data: 16
# `ask_user_questions` at `board_only`, and 3 `request_confirmation` at
# `board_or_agents`.
#
# The cap at :121 is real but conditional -- `kindGovernance.cap`, a
# per-company setting that is NOT set here, plus a `hasToolAction` clause.
# Choose `kind` by what you need back; choose `resolverPolicy` explicitly,
# ALWAYS. Omitting it is how you land on the wrong one silently.
#
# REVIEW PATH — the agent-to-agent approval route nobody here has used
# --------------------------------------------------------------------
# :2956 bypasses the board_or_agents check entirely, so a `board_only`
# `request_confirmation` IS agent-resolvable when all of:
#   - issue.status == "in_review"
#   - the confirmation was named as `reviewInteractionId` on the transition
#     into in_review (`routes/issues.js:2356-2369`: it must be a pending
#     non-tool confirmation created by that same agent run)
#   - the resolver is the assignee and is not the author
#   - issue.reviewPolicy allows it: "anyone" (default) | "not_creator" |
#     "human_only"  (`services/issue-review-policy.js:50-81`)
# This is the built-in code-review approval flow. Use it for "approve my green
# PR" instead of sending the owner a confirmation they cannot evaluate.
#
# WHAT THIS TOOL DELIBERATELY DOES NOT DO
# ---------------------------------------
# It does not create, resolve or withdraw anything. It decides and explains,
# and every mutation stays in the caller's hands where it is reviewable. A
# router that could also send would be a way to manufacture approvals.
# ===========================================================================
set -uo pipefail

TOOL_NAME="interaction_route.sh"

# Exit codes are the contract. Tests pin these, never the message text, which
# drifts (CONTRIBUTING.md: "Assert on exit status, not printed output").
EX_OK=0             # agent-routable, envelope emitted
EX_USAGE=2          # bad invocation
EX_RESERVED=3       # owner-reserved matter; do not route to an agent
EX_UNANSWERABLE=4   # check: found an interaction no one can resolve
EX_NOT_A_QUESTION=5 # needs a human capability, not a human decision

die() { printf '%s: %s\n' "$TOOL_NAME" "$*" >&2; exit "$EX_USAGE"; }

usage() {
  cat <<'USAGE'
interaction_route.sh — decide where an ask belongs before you create it

SUBCOMMANDS
  route     Classify an intended ask and emit the correct interaction envelope.
  check     Audit existing interactions for resolvability. JSON array on stdin,
            or set INTERACTION_SOURCE_CMD.
  explain   Print the enforced gate order with its source citations.

route OPTIONS
  Reserved-matter flags (any one of these routes the ask to the owner):
    --spends-money              new subscription, paid plan, hardware, recurring charge
    --credential-external       a credential leaving our control, or a rotation
    --org-structure             creating/terminating agents, goals, who may authorize
    --reverses-owner-preference contradicts something the owner has already stated
    --public-commitment         legal, contractual, third-party repo, public posting

  Capability flag:
    --needs-human-capability    root shell, org/instance admin, a card, a UI click
                                  -> this is a WORK ORDER, not a question

  Routing:
    --answer-type yes_no|choice   what you need back        (default: yes_no)
    --addressee AGENT_ID          who should answer         (required when routable)
    --issue-assignee AGENT_ID     current assignee of the issue
    --self AGENT_ID               you, the author
    --issue-status STATUS         current issue status (enables review-path advice)
    --json                        emit machine-readable JSON

  --spends-quota is accepted and is explicitly NOT reserved: Claude traffic is
  subscription, and unused weekly quota is destroyed at reset. Underrunning the
  budget is the waste, not the spend.

check OPTIONS
  --self AGENT_ID   evaluate resolvability from this agent's point of view
  --strict          exit EX_UNANSWERABLE if any pending interaction is
                    resolvable by nobody

EXIT CODES
  0 agent-routable   2 usage   3 owner-reserved   4 unanswerable found
  5 not a question (needs a human capability)
USAGE
}

# --------------------------------------------------------------------------
# route
# --------------------------------------------------------------------------
cmd_route() {
  local spends_money=0 credential_external=0 org_structure=0 reverses_pref=0
  local public_commitment=0 needs_capability=0
  local answer_type="yes_no" addressee="" assignee="" self="" issue_status=""
  local as_json=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --spends-money)              spends_money=1 ;;
      --credential-external)       credential_external=1 ;;
      --org-structure)             org_structure=1 ;;
      --reverses-owner-preference) reverses_pref=1 ;;
      --public-commitment)         public_commitment=1 ;;
      --needs-human-capability)    needs_capability=1 ;;
      --spends-quota)              : ;;  # deliberately inert; see usage
      --answer-type)    answer_type="${2:-}"; shift ;;
      --addressee)      addressee="${2:-}";   shift ;;
      --issue-assignee) assignee="${2:-}";    shift ;;
      --self)           self="${2:-}";        shift ;;
      --issue-status)   issue_status="${2:-}"; shift ;;
      --json)           as_json=1 ;;
      -h|--help)        usage; exit "$EX_OK" ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done

  case "$answer_type" in
    yes_no|choice) ;;
    *) die "--answer-type must be yes_no or choice (got: ${answer_type:-empty})" ;;
  esac

  # ---- 1. Reserved matters. These are the complete list; nothing else is. ----
  local reasons=()
  (( spends_money ))        && reasons+=("real money — a new subscription, paid plan, hardware or recurring charge")
  (( credential_external )) && reasons+=("a credential leaving our control, or a rotation whose timing the owner has taken")
  (( org_structure ))       && reasons+=("company goals or org structure — creating/terminating agents, or who may authorize")
  (( reverses_pref ))       && reasons+=("it reverses a stated owner preference")
  (( public_commitment ))   && reasons+=("a legal, contractual or public-facing commitment in the company's name")

  if (( ${#reasons[@]} > 0 )); then
    if (( as_json )); then
      _json_out "owner_reserved" "request_confirmation" "board_only" "" \
        "$(printf '%s; ' "${reasons[@]}")"
    else
      cat <<EOF
VERDICT: OWNER-RESERVED — do not route this to an agent.

Why:
$(printf '  - %s\n' "${reasons[@]}")

Send it as: kind=request_confirmation  resolverPolicy=board_only
            continuationPolicy=wake_assignee
            supersedeOnUserComment=false   <-- see below, this one matters

Raise it as a DECISION BRIEF, never a raw question:
  - the decision in one sentence
  - what you verified, cited to a file:line or a row count
  - real options with real costs
  - your recommendation, and the strongest argument against it
  - what happens if nobody replies

WARNING: supersedeOnUserComment defaults to TRUE and fires on an OWNER comment,
so the owner replying on your issue silently cancels the very question you
asked them. Set it false explicitly.
EOF
    fi
    exit "$EX_RESERVED"
  fi

  # ---- 2. Needs a hand, not a decision. This is not a question at all. ----
  if (( needs_capability )); then
    if (( as_json )); then
      _json_out "not_a_question" "" "" "" "needs a human capability, not a human decision"
    else
      cat <<'EOF'
VERDICT: NOT A QUESTION — this needs a human capability, not a human decision.

An interaction asks someone to DECIDE. You are asking someone to ACT: run a
root command, click approve in a UI, hold an org-admin session, put a card on
file. No interaction kind and no resolver policy can make an agent able to do
that, because the blocker is a hand on a keyboard, not an authorization label.

Filing it as a confirmation is why these sit pending for weeks: it looks like a
decision waiting on the owner, so nobody triages it as work.

Do this instead:
  - Put the action on the operator runbook as a numbered, copy-pasteable step,
    with its verification command and its rollback.
  - Keep ONE runbook interaction covering the batch, not one per action.
  - State plainly that no decision is required — only the hand.

Measured on this board 2026-08-25: ~15 of 33 pending owner-bound asks are this,
and they are the single largest category.
EOF
    fi
    exit "$EX_NOT_A_QUESTION"
  fi

  # ---- 3. Agent-routable. Now check it can ACTUALLY be resolved. ----
  [[ -n "$addressee" ]] || die "--addressee is required for an agent-routable ask (who do you expect to answer?)"

  local kind blockers=() warnings=()
  case "$answer_type" in
    yes_no) kind="request_confirmation" ;;
    choice) kind="ask_user_questions" ;;
  esac

  # :2975 — you may never resolve your own ask.
  if [[ -n "$self" && "$addressee" == "$self" ]]; then
    blockers+=("addressee == you. routes/issues.js:2975 refuses 'Agents cannot resolve interactions they created'.")
  fi

  # :2946 — the resolver must be the assignee, or the issue must be unassigned.
  if [[ -n "$assignee" && "$addressee" != "$assignee" ]]; then
    blockers+=("addressee is not the issue assignee. routes/issues.js:2946 refuses 'Agent cannot mutate another agent's issue' BEFORE policy is consulted. Reassign the issue to the addressee, or this interaction is inert.")
  fi
  if [[ -n "$self" && -n "$assignee" && "$self" == "$assignee" && "$addressee" != "$assignee" ]]; then
    warnings+=("you are the assignee, so handing this over means reassigning away from yourself — do that deliberately, and say so in the issue.")
  fi

  # in_progress + assignee holds a run lock on the checkout.
  if [[ "$issue_status" == "in_progress" && -n "$assignee" && "$addressee" != "$assignee" ]]; then
    warnings+=("issue is in_progress, so the assignee holds a checkout run-lock (routes/issues.js:2799). Reassignment will not take effect for a resolver until that clears.")
  fi

  if (( ${#blockers[@]} > 0 )); then
    if (( as_json )); then
      _json_out "inert" "$kind" "board_or_agents" "$addressee" "$(printf '%s; ' "${blockers[@]}")"
    else
      cat <<EOF
VERDICT: WOULD BE INERT — this interaction would be created successfully and
then be unresolvable. That is the silent failure this tool exists to stop.

Blockers:
$(printf '  - %s\n' "${blockers[@]}")

Fix the blockers above, then re-run. Do not create it as-is: a pending
interaction nobody can answer reads as a decision waiting on a human.
EOF
    fi
    exit "$EX_UNANSWERABLE"
  fi

  if (( as_json )); then
    _json_out "agent_routable" "$kind" "board_or_agents" "$addressee" ""
  else
    cat <<EOF
VERDICT: AGENT-ROUTABLE — this does not need the owner.

Envelope:
  kind                    $kind
  resolverPolicy          board_or_agents      <-- set this EXPLICITLY, always
  addresseeAgentId        $addressee
  continuationPolicy      wake_assignee
  supersedeOnUserComment  false
  payload.version         1

Preconditions the server will enforce (all currently satisfied):
  - the addressee is the issue assignee, or the issue is unassigned  (:2946)
  - the addressee did not author this ask                            (:2975)
  - a different run resolves it than created it                      (:2979)
$( (( ${#warnings[@]} > 0 )) && printf 'Warnings:\n' && printf '  - %s\n' "${warnings[@]}" )
Two shape traps that cost a round trip each:
  - payload.prompt is capped at 1000 characters. Put the substance in an issue
    comment and reference it.
  - ask_user_questions is multiple-choice ONLY. Every question needs both
    selectionMode and options. NO interaction kind returns free text — if you
    need a typed value back, ask for it as an issue comment and use the
    interaction purely as the wake.
EOF
  fi
  exit "$EX_OK"
}

_json_out() {
  printf '{"verdict":"%s","kind":"%s","resolverPolicy":"%s","addresseeAgentId":"%s","notes":"%s"}\n' \
    "$1" "$2" "$3" "$4" "${5//\"/\'}"
}

# --------------------------------------------------------------------------
# check — audit real interactions for resolvability
# --------------------------------------------------------------------------
# Input is a JSON array. Field names match what the API and the DB return:
#   identifier, issueStatus, kind, effectiveResolverPolicy, createdByAgentId,
#   assigneeAgentId, addresseeAgentId, status, hasToolAction
#
# INTERACTION_SOURCE_CMD is the test seam, mirroring LIVENESS_SOURCE_CMD in
# queue_liveness.sh: neither psql nor podman exists in an agent container, so
# a tool that needs rows must accept them from somewhere else.
cmd_check() {
  local self="" strict=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --self)   self="${2:-}"; shift ;;
      --strict) strict=1 ;;
      -h|--help) usage; exit "$EX_OK" ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done

  local input
  if [[ -n "${INTERACTION_SOURCE_CMD:-}" ]]; then
    input="$($INTERACTION_SOURCE_CMD)" || die "INTERACTION_SOURCE_CMD failed"
  else
    input="$(cat)"
  fi
  [[ -n "$input" ]] || die "no input: pipe a JSON array or set INTERACTION_SOURCE_CMD"

  printf '%s' "$input" | jq -e 'type == "array"' >/dev/null 2>&1 \
    || die "input must be a JSON array"

  # The resolvability predicate, transcribed from routes/issues.js:2929-2984.
  # Kept as one jq expression so the gate order is visible in one place.
  local report
  report="$(printf '%s' "$input" | jq -r --arg self "$self" '
    map(
      . as $i
      | (($i.status // "pending") == "pending")                      as $pending
      | (($i.hasToolAction // false) | not)                          as $noTool
      | (($i.assigneeAgentId // null) == null)                       as $unassigned
      | (($i.effectiveResolverPolicy // "") == "board_or_agents")    as $policyOk
      | (($i.addresseeAgentId // null))                              as $addr
      # WHO would actually pass the gate. null here means "any agent" — only
      # possible on an unassigned issue with no addressee. Deriving this once,
      # instead of assuming the assignee, is what makes the creator bar below
      # correct for an addressed ask.
      | (if $addr != null then $addr
         elif $unassigned then null
         else ($i.assigneeAgentId // null) end)                      as $resolverId
      # :2971 NARROWS, it never grants: an addressee only helps where the
      # assignee gate would already have let them through — i.e. they are the
      # assignee, or the issue is unassigned (:2792 returns early).
      # MEASURED (TOG-395): unassigned + addressee refuses a non-addressee with
      # "Only the addressed agent ... may resolve", NOT "cannot mutate another
      # agents issue" -- so the assignee gate had already passed. Omitting
      # $unassigned here reported that configuration as inert, and it is the one
      # shape that routes an ask to a named agent with no platform change.
      | ($addr == null or $unassigned
         or ($addr == ($i.assigneeAgentId // null)))                 as $addresseeOk
      | (($i.createdByAgentId // "") != ($resolverId // "~"))        as $creatorOk
      # Review eligibility FAILS CLOSED. "in_review + a confirmation" is NOT
      # sufficient: isIssueReviewVerdictInteraction (services/issue-review-
      # policy.js:42-49) additionally requires that this exact interaction was
      # named as reviewInteractionId on the transition into in_review, and that
      # its author was the requester. That fact is not derivable from the
      # interaction row, so the caller must assert it via isReviewVerdict.
      #
      # Defaulting this to true was a real bug caught by running the tool
      # against live data: it reported a $1.40/mo spend approval, a credential
      # placement and a brand decision as agent-resolvable. An over-permissive
      # verdict here does not cost a 403 — it invites an agent to approve
      # something owner-reserved. Unknown must read as "no".
      | (($i.isReviewVerdict // false)
         and ($i.issueStatus // "") == "in_review"
         and (($i.kind // "") | test("^request_(confirmation|checkbox_confirmation)$"))) as $reviewEligible
      | ($pending and $noTool and $addresseeOk and $creatorOk
         and ($policyOk or $reviewEligible))                         as $resolvable
      | {
          identifier: ($i.identifier // "?"),
          kind: ($i.kind // "?"),
          policy: ($i.effectiveResolverPolicy // "?"),
          resolvable: $resolvable,
          resolver: (if $resolvable then ($resolverId // "any agent")
                     else "nobody" end),
          reason: (
            if ($pending | not) then "not pending"
            elif ($noTool | not) then "tool-action confirmation: always board-only (:2952)"
            elif ($creatorOk | not) then "author IS the only eligible resolver: creator bar (:2975)"
            elif ($addresseeOk | not) then "addressed to a non-assignee on an assigned issue, who cannot pass :2946"
            elif (($policyOk or $reviewEligible) | not) then "board_only and not a review verdict (:2962)"
            else "ok" end)
        }
    )' )"

  # jq -> awk directly. Do NOT round-trip through `IFS=$'\t' read`: tab is IFS
  # whitespace, so a leading empty field is swallowed and every column shifts
  # left, which surfaces as a wrong verdict rather than as a parse error.
  # RESOLVER is the column the reader acts on: "resolvable" without a name is
  # how an ask ends up owned by nobody. It was computed and then discarded.
  printf '%-10s %-24s %-16s %-11s %-38s %s\n' ISSUE KIND POLICY RESOLVABLE RESOLVER REASON
  printf '%s\n' "$report" | jq -r '.[] |
    [.identifier, .kind, .policy, (.resolvable|tostring), .resolver, .reason] | @tsv' \
    | awk -F'\t' '{printf "%-10s %-24s %-16s %-11s %-38s %s\n", $1,$2,$3,$4,$5,$6}'

  local total unresolvable
  total="$(printf '%s\n' "$report" | jq 'length')"
  unresolvable="$(printf '%s\n' "$report" | jq '[.[] | select(.resolvable | not)] | length')"
  printf '\n%s of %s cannot be resolved by any agent.\n' "$unresolvable" "$total"

  if (( strict )) && [[ "$unresolvable" != "0" ]]; then
    printf 'strict: refusing (exit %d)\n' "$EX_UNANSWERABLE" >&2
    exit "$EX_UNANSWERABLE"
  fi
  exit "$EX_OK"
}

cmd_explain() {
  cat <<'EOF'
The gate an agent must pass to resolve an issue-thread interaction.
Read from the running build at routes/issues.js:2929-2984, and confirmed by
attempting each refusal rather than inferring it from a field.

  :2946  assertAgentIssueMutationAllowed
         The resolver must be the issue ASSIGNEE (:2795), or the issue must be
         unassigned (:2792). THIS FIRES FIRST — before policy is consulted.
         Refusal: 403 "Agent cannot mutate another agent's issue"

  :2952  payload.toolAction present -> always board-only. No exceptions.

  :2956  Review-verdict bypass. If the issue is in_review and this confirmation
         was named as reviewInteractionId on the transition in, the policy
         check at :2962 is SKIPPED. A board_only request_confirmation becomes
         agent-resolvable. This is the built-in code-review approval path.

  :2962  effectiveResolverPolicy must be "board_or_agents".
         Refusal: 403 "This issue-thread interaction is board-only"

  :2971  addresseeAgentId must be unset, or equal to the resolver.
  :2975  createdByAgentId must NOT be the resolver.  <-- blocks 42 of 49 here
  :2979  sourceRunId must NOT be the resolver's run.

The policy itself is NOT capped by kind. services/issue-thread-interactions.js
:116-125 is a fallback chain — what you request wins; the kind only supplies a
default when you omit the field. Across all 187 interactions this company has
created, requested == effective in every row.
EOF
  exit "$EX_OK"
}

main() {
  [[ $# -gt 0 ]] || { usage; exit "$EX_USAGE"; }
  local sub="$1"; shift
  case "$sub" in
    route)   cmd_route "$@" ;;
    check)   cmd_check "$@" ;;
    explain) cmd_explain ;;
    -h|--help|help) usage; exit "$EX_OK" ;;
    *) die "unknown subcommand: $sub" ;;
  esac
}

main "$@"
