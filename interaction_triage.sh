#!/usr/bin/env bash
# ===========================================================================
# interaction_triage.sh — for a set of PENDING issue-thread interactions, say
# WHO CAN ACTUALLY ANSWER EACH ONE (TOG-423).
#
# This is the companion to `interaction_route.sh check`, not a duplicate:
#
#   interaction_route.sh check   PRE-FLIGHT.  "I am about to create an
#                                interaction. Will anyone be able to answer it?"
#   interaction_triage.sh        POST-HOC.    "Here are the N interactions
#                                already pending. Which are dead, which are
#                                waiting on the owner, and which could an agent
#                                answer right now if anyone told them?"
#
# The second question is the one that mattered: when TOG-423 ran this against
# the live board, 13 of 49 pending interactions were already answerable by an
# agent. Nothing was blocking them. Nobody knew.
#
# ---------------------------------------------------------------------------
# THE GATE ORDER, AS ENFORCED
# ---------------------------------------------------------------------------
# Re-derived for TOG-423 by reading /app/server/dist (readable from an agent
# container), not inherited from the parent issue — two of the parent's claims
# were wrong. Cited to the deployed build:
#
#   :2953  request_confirmation carrying payload.toolAction is ALWAYS board-only.
#   :2946  assertAgentIssueMutationAllowed — the assignee gate. Delegates to
#          :2793, and this is the line the parent issue got wrong:
#
#              if (issue.assigneeAgentId === null) return true;
#
#          An UNASSIGNED issue passes the assignee gate for EVERY agent. It is
#          not a barrier there; it is wide open. The barrier only appears once
#          an issue HAS an assignee, because then a non-assignee is refused
#          ("Agent cannot mutate another agent's issue", or the in_progress
#          run-lock).
#   :2956  the review-verdict bypass. An in_review issue whose transition named
#          this interaction as `reviewInteractionId` skips the policy check
#          entirely — a board_only confirmation becomes agent-resolvable.
#   :2962  otherwise effectiveResolverPolicy must be "board_or_agents".
#   :2975  assertAgentInteractionActorAllowed — addressee must match if set,
#          the CREATOR may never resolve their own, and neither may the same run.
#
# ---------------------------------------------------------------------------
# THE COUNTERINTUITIVE PART — ASSIGNING AN ISSUE CAN KILL ITS QUESTION
# ---------------------------------------------------------------------------
# Because :2793 opens an unassigned issue to everyone and an assigned one to
# the assignee alone, ASSIGNING a pending question NARROWS its resolver set.
# Assign it to the person who asked it and the creator bar at :2975 closes the
# last door: the question becomes permanently unanswerable by any agent.
#
# "Assign the issue so someone owns the question" is therefore the exact wrong
# reflex, and it is the natural one. This tool reports that case as INERT and
# warns about it (`assign_would_kill`) before it happens.
#
# ---------------------------------------------------------------------------
# VERDICTS
# ---------------------------------------------------------------------------
#   AGENT_RESOLVABLE      an agent can answer this now. Names who.
#   AGENT_REVIEW_VERDICT  agent-resolvable via the :2956 review bypass.
#   OWNER_ONLY            board_only and not a review verdict. Only the owner.
#                         Correct for the five reserved matters; a routing bug
#                         for anything else.
#   INERT                 graded agent-resolvable, but NO AGENT can resolve it.
#                         Withdraw and re-cut. `--strict` exits 3 on these.
#
# A note on what INERT does NOT mean. A board user bypasses every gate above:
# assertIssueThreadInteractionResolutionAllowed returns "standard" for any
# non-agent actor after assertBoard, without consulting policy, addressee or
# the creator bar. So the owner can always resolve anything, and INERT never
# means "nobody at all". It means the author asked for `board_or_agents` — an
# agent answer — and the gate silently delivered owner-only. That gap between
# what was requested and what is reachable is the defect worth reporting, and
# it is invisible on the board: the interaction just sits there looking pending.
#
# ---------------------------------------------------------------------------
# INPUT — a JSON array on stdin. No database, no network, no credentials, so
# CI can run it. Produce it from the live board with the recipe in `explain`.
#
#   [{ "identifier":"TOG-1", "issueStatus":"in_review",
#      "kind":"request_confirmation", "effectiveResolverPolicy":"board_only",
#      "assigneeAgentId":null, "createdByAgentId":"a1",
#      "addresseeAgentId":null, "hasToolAction":false,
#      "namedReviewInteraction":false }]
#
# Missing optional fields default to null/false. `identifier`, `kind`,
# `effectiveResolverPolicy` and `createdByAgentId` are required; a row missing
# one is reported as MALFORMED and forces a non-zero exit, because a row this
# tool silently skipped would read as "nothing wrong here".
# ===========================================================================
set -uo pipefail

command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 2; }

_usage() {
  cat <<'USAGE'
interaction_triage.sh — who can actually answer each pending interaction

  classify [--strict] [--json] [--only VERDICT]   < interactions.json
      Classify each row. Table by default.
        --strict      exit 3 if any row is INERT (dead question on the board)
        --json        emit one JSON object per row instead of a table
        --only V      print only rows with verdict V (repeatable)

  explain
      Print the enforced gate order with source citations, and the SQL/API
      recipe that produces the input for `classify`.

Exit: 0 clean · 2 usage/malformed input · 3 --strict found an INERT row
USAGE
}

# --------------------------------------------------------------------------
# The classifier. Kept as ONE jq program so the gate order is readable top to
# bottom in the same sequence the server enforces it. If you change this,
# change it here — nothing else in this file decides a verdict.
# --------------------------------------------------------------------------
_classify_jq() {
  jq -c '
    def req($f): if (.[$f] == null or .[$f] == "") then $f else empty end;

    .[] |
    . as $i |
    ([req("identifier"), req("kind"), req("effectiveResolverPolicy"),
      req("createdByAgentId")]) as $missing |

    if ($missing | length) > 0 then
      { identifier: ($i.identifier // "(no identifier)"),
        verdict: "MALFORMED",
        why: ("input row is missing required field(s): " + ($missing | join(", "))),
        resolvers: [], warnings: [] }
    else
      ($i.assigneeAgentId // null)                                as $assignee |
      ($i.addresseeAgentId // null)                               as $addressee |
      ($i.createdByAgentId)                                       as $creator |
      (($i.hasToolAction // false) and $i.kind == "request_confirmation") as $toolAction |
      (($i.issueStatus // "") == "in_review"
        and ($i.namedReviewInteraction // false)
        and ($i.kind == "request_confirmation"
             or $i.kind == "request_checkbox_confirmation"))      as $reviewVerdict |
      ($i.effectiveResolverPolicy == "board_or_agents")           as $policyOk |
      ($assignee == null)                                         as $unassigned |

      # :2946 -> :2793. Unassigned admits everyone ("*"); assigned admits the
      # assignee alone. This is the line the parent issue inverted.
      (if $unassigned then "*" else [$assignee] end)              as $passers |

      # :2975 addressee match, then the creator bar.
      (if $addressee == null then $passers
       elif $passers == "*" then [$addressee]
       else ($passers | map(select(. == $addressee))) end)        as $addressed |
      (if $addressed == "*" then "*"
       else ($addressed | map(select(. != $creator))) end)        as $eligible |

      (if $unassigned and $addressee == null and $creator != null
         then ["assigning this issue NARROWS who may answer it (:2793). Assigning it to the creator makes it permanently INERT (:2975) — assign_would_kill."]
         else [] end) as $w1 |
      (if (($i.issueStatus // "") == "in_progress") and ($unassigned | not)
         then ["issue is in_progress: the assignee holds a checkout run-lock (:2799), so only their live run can resolve this."]
         else [] end) as $w2 |

      if $toolAction then
        { identifier: $i.identifier, verdict: "OWNER_ONLY",
          why: "request_confirmation carries payload.toolAction — always board-only (:2953)",
          resolvers: [], warnings: ($w1 + $w2) }
      elif (($reviewVerdict | not) and ($policyOk | not)) then
        { identifier: $i.identifier, verdict: "OWNER_ONLY",
          why: ("effectiveResolverPolicy is " + $i.effectiveResolverPolicy
                + " and no in_review transition named it as reviewInteractionId (:2962)"),
          resolvers: [], warnings: ($w1 + $w2) }
      elif ($eligible != "*" and ($eligible | length) == 0) then
        { identifier: $i.identifier, verdict: "INERT",
          why: (if ($addressee != null and ($unassigned | not) and $addressee != $assignee)
                  then "addressed to an agent who cannot pass the assignee gate (:2946)"
                elif ($addressee != null and $addressee == $creator)
                  then "addressed to its own creator — creator bar (:2975)"
                else "the only agent who can pass the assignee gate IS the creator — creator bar (:2975)"
                end),
          resolvers: [], warnings: ($w1 + $w2) }
      else
        { identifier: $i.identifier,
          verdict: (if $reviewVerdict and ($policyOk | not)
                      then "AGENT_REVIEW_VERDICT" else "AGENT_RESOLVABLE" end),
          why: (if $reviewVerdict and ($policyOk | not)
                  then "in_review and named as reviewInteractionId — policy check bypassed (:2956)"
                elif $unassigned and $addressee == null
                  then "unassigned issue: any agent except the creator (:2793 + :2975)"
                else "resolvable by the named agent(s) below" end),
          resolvers: (if $eligible == "*" then ["<any agent except the creator>"] else $eligible end),
          warnings: ($w1 + $w2) }
      end
    end
  '
}

cmd_classify() {
  local strict=0 as_json=0; local -a only=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --strict) strict=1 ;;
      --json)   as_json=1 ;;
      --only)   only+=("${2:-}"); shift ;;
      -h|--help) _usage; return 0 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; _usage >&2; return 2 ;;
    esac
    shift
  done

  local input; input="$(cat)"
  if ! jq -e 'type == "array"' >/dev/null 2>&1 <<<"$input"; then
    echo "ERROR: stdin must be a JSON array of interaction objects" >&2; return 2
  fi

  local rows; rows="$(_classify_jq <<<"$input")" || { echo "ERROR: classification failed" >&2; return 2; }

  if [[ ${#only[@]} -gt 0 ]]; then
    local filter; filter="$(printf '%s\n' "${only[@]}" | jq -R . | jq -sc .)"
    rows="$(jq -c --argjson keep "$filter" 'select(.verdict as $v | $keep | index($v))' <<<"$rows")"
  fi

  if [[ $as_json -eq 1 ]]; then
    [[ -n "$rows" ]] && printf '%s\n' "$rows"
  else
    if [[ -z "$rows" ]]; then
      echo "(no rows matched)"
    else
      while IFS= read -r r; do
        printf '%-10s %-21s %s\n' \
          "$(jq -r '.identifier' <<<"$r")" \
          "$(jq -r '.verdict'    <<<"$r")" \
          "$(jq -r '.why'        <<<"$r")"
        jq -r '.resolvers[]? | "             resolver: " + .'  <<<"$r"
        jq -r '.warnings[]?  | "             WARNING:  " + .'  <<<"$r"
      done <<<"$rows"
      echo
      echo "-- totals --"
      jq -s -r 'group_by(.verdict)[] | "  \(.[0].verdict): \(length)"' <<<"$rows"
    fi
  fi

  # Counted against the UNFILTERED set: --only must never change the exit status.
  local all; all="$(_classify_jq <<<"$input")"
  local malformed inert
  malformed="$(jq -s '[.[] | select(.verdict == "MALFORMED")] | length' <<<"$all")"
  inert="$(jq -s '[.[] | select(.verdict == "INERT")] | length' <<<"$all")"

  if [[ "$malformed" -gt 0 ]]; then
    echo "ERROR: $malformed input row(s) MALFORMED — refusing to report a clean board" >&2
    return 2
  fi
  if [[ $strict -eq 1 && "$inert" -gt 0 ]]; then
    echo "STRICT: $inert interaction(s) are INERT — graded agent-resolvable, but no agent can resolve them (only the owner can). Withdraw and re-cut." >&2
    return 3
  fi
  return 0
}

cmd_explain() {
  cat <<'EXPLAIN'
THE GATE AN AGENT MUST PASS TO RESOLVE AN ISSUE-THREAD INTERACTION
Cited to the deployed build at /app/server/dist, re-derived for TOG-423.

  :2953  request_confirmation with payload.toolAction  -> ALWAYS board-only.
  :2946  assertAgentIssueMutationAllowed, which at :2793 reads
             if (issue.assigneeAgentId === null) return true;
         An UNASSIGNED issue is OPEN to every agent here. Only an ASSIGNED
         issue restricts, and then to the assignee alone.
  :2956  review-verdict bypass: issue in_review AND the transition into
         in_review named this interaction as `reviewInteractionId` AND the
         interaction was created by that same requester. Skips :2962 entirely,
         so a board_only confirmation becomes agent-resolvable. Used twice in
         this company's entire history.
  :2962  effectiveResolverPolicy must be "board_or_agents".
  :2975  addressee must match if set · the creator may NEVER resolve their own
         · the same run may never resolve one it created.

CONSEQUENCE MOST PEOPLE GET BACKWARDS
  Assigning a pending question NARROWS who can answer it. Assigning it to the
  agent who asked it makes it permanently unanswerable. Leave a question's
  issue unassigned unless you are deliberately handing it to a named resolver
  who is not the author.

PRODUCING THE INPUT FROM THE LIVE BOARD
  Requires read access to the Paperclip database. Emits exactly the shape
  `classify` expects:

    select json_agg(row_to_json(r)) from (
      select i.identifier,
             i.status                              as "issueStatus",
             i.assignee_agent_id::text             as "assigneeAgentId",
             t.kind,
             t.effective_resolver_policy           as "effectiveResolverPolicy",
             t.created_by_agent_id::text           as "createdByAgentId",
             t.addressee_agent_id::text            as "addresseeAgentId",
             (t.payload ? 'toolAction')            as "hasToolAction",
             exists (
               select 1 from activity_log al
               where al.company_id = t.company_id
                 and al.entity_type = 'issue'
                 and al.entity_id = i.id::text
                 and al.action = 'issue.updated'
                 and al.details->>'reviewInteractionId' = t.id::text
             )                                     as "namedReviewInteraction"
      from issue_thread_interactions t
      join issues i on i.id = t.issue_id
      where t.company_id = :company and t.status = 'pending'
      order by i.identifier
    ) r;

  Then:  psql -At -f pending.sql | ./interaction_triage.sh classify --strict
EXPLAIN
}

case "${1:-}" in
  classify) shift; cmd_classify "$@" ;;
  explain)  shift; cmd_explain ;;
  -h|--help|"") _usage ;;
  *) echo "ERROR: unknown subcommand '$1'" >&2; _usage >&2; exit 2 ;;
esac
