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
# THE SECOND GATE, ADDED FOR TOG-492 — "AND THEN WHAT?"
# ---------------------------------------------------------------------------
# Everything above answers ONE question: who is allowed to answer this card.
# It never asked the next one, and that omission cost this company two days:
#
#     If the card IS answered, does anything actually happen?
#
# It frequently does not. `routes/issues.js:1253` — the FIRST line of
# queueResolvedInteractionContinuationWakeup, the function that turns an answer
# into work:
#
#     if (!input.issue.assigneeAgentId || isClosedIssueStatus(input.issue.status))
#         return;
#
# An UNASSIGNED issue silently drops the continuation wake. The card flips to
# `accepted`, the board shows it answered, and NOTHING RUNS. There is no error
# and no trace on the issue.
#
# TOG-38, TOG-58 and TOG-104 sat in exactly this state for two days: three
# healthy `board_only` cards the owner could have answered at any moment, on
# three issues with no assignee. Every one of those answers would have
# evaporated on :1253. `reviewAttention` read `covered` the entire time,
# because a pending card IS a maintained path — that field measures whether a
# path exists, not whether the far end of it is connected to anything.
#
# ---------------------------------------------------------------------------
# THE TWO GATES PULL IN OPPOSITE DIRECTIONS. THIS IS THE WHOLE POINT.
# ---------------------------------------------------------------------------
#   RESOLVER gate (:2793)     unassigned = OPEN to every agent. Assigning NARROWS.
#   CONTINUATION gate (:1253) unassigned = the answer WAKES NOBODY. Assigning FIXES.
#
# So there is no setting that is simply "safe", and the advice this tool used
# to give — leave a question's issue unassigned — is only half right. It
# maximises who may answer while guaranteeing the answer starts no work. Which
# half you want depends on who the question is actually for:
#
#   board_only / owner-reserved  -> ASSIGN IT. No agent can resolve it whatever
#                                   you do, so narrowing costs exactly nothing
#                                   and it is the only way the answer lands.
#                                   Assign it to the CREATOR for preference:
#                                   the creator bar (:2975) then also makes it
#                                   structurally impossible for an agent to
#                                   approve an owner-reserved matter.
#   board_or_agents              -> real trade-off. Leaving it unassigned buys
#                                   the widest resolver set at the cost of the
#                                   wake. Prefer naming an addressee who is not
#                                   the creator, then assigning to them: that
#                                   keeps one live resolver AND a live wake.
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
# CONTINUATION (reported alongside the verdict, never instead of it)
#   WAKES                 an answer wakes the assignee. The path is whole.
#   WAKES_ON_ACCEPT       accept wakes; a REJECTION is silent (:1263).
#   DEAD_WAKE             the card asked for a wake and will not get one — no
#                         assignee, or a closed issue (:1253). The answer is
#                         swallowed. `--strict-wake` exits 4 on these.
#   NO_WAKE_REQUESTED     policy is not a wake_* policy. Correct only if a human
#                         is watching, or the reviewPathLost branch applies.
#   UNKNOWN               the row carried no continuationPolicy, so this was NOT
#                         measured. Never treated as clean: under --strict-wake
#                         an UNKNOWN row is a hard error, not a pass.
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
#      "namedReviewInteraction":false, "continuationPolicy":"wake_assignee" }]
#
# Missing optional fields default to null/false. `identifier`, `kind`,
# `effectiveResolverPolicy` and `createdByAgentId` are required; a row missing
# one is reported as MALFORMED and forces a non-zero exit, because a row this
# tool silently skipped would read as "nothing wrong here".
#
# `continuationPolicy` is OPTIONAL and was added in TOG-492. Rows that omit it
# classify exactly as they did before — same verdict, same citation — and report
# continuation UNKNOWN. It is deliberately not required: making it mandatory
# would turn every existing caller into a MALFORMED error overnight, which is
# how a diagnostic tool becomes an outage. `issueStatus` is likewise optional
# for resolver classification, but a wake_* row without it reports UNKNOWN:
# absence is not proof that the issue is open.
# ===========================================================================
set -uo pipefail

command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 2; }

_usage() {
  cat <<'USAGE'
interaction_triage.sh — who can actually answer each pending interaction

  classify [--strict] [--strict-wake] [--json] [--only VERDICT]   < interactions.json
      Classify each row. Table by default.
        --strict      exit 3 if any row is INERT (dead question on the board)
        --strict-wake exit 4 if any row is DEAD_WAKE (an answer that starts
                      nothing). Refuses with exit 2 if any row is UNKNOWN,
                      because a wake path that was never measured must not
                      report green.
        --json        emit one JSON object per row instead of a table
        --only V      print only rows with verdict V (repeatable)

  explain
      Print the enforced gate order with source citations, and the SQL/API
      recipe that produces the input for `classify`.

Exit: 0 clean · 2 usage/malformed/unmeasured · 3 --strict found an INERT row
      4 --strict-wake found a DEAD_WAKE row
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

    # ---- SECOND GATE: the continuation wake (TOG-492) --------------------
    # routes/issues.js:1253, first line of the function that turns an answer
    # into work. Evaluated independently of the resolver verdict below,
    # because a card can be perfectly answerable AND completely inert.
    ($i.continuationPolicy // null)                              as $cp |
    ($i.issueStatus // null)                                     as $issueStatus |
    (($i.assigneeAgentId // null) == null)                       as $noAssignee |
    (($issueStatus == "done") or ($issueStatus == "cancelled")) as $closedIssue |
    (if $cp == null then
       { c: "UNKNOWN",
         w: "row carried no continuationPolicy — the wake path was NOT measured" }
     elif $issueStatus == null or $issueStatus == "" then
       { c: "UNKNOWN",
         w: "row carried no issueStatus — issue openness was NOT measured" }
     elif ($cp == "wake_assignee" or $cp == "wake_assignee_on_accept") then
       (if $closedIssue then
          { c: "DEAD_WAKE",
            w: ("policy is " + $cp + " but the issue is " + $issueStatus
                + " — :1253 returns on isClosedIssueStatus (:1126)."
                + (if $noAssignee then " It also has NO ASSIGNEE." else "" end)),
            fix: "Move the issue to an open status through the normal resume path before answering; if it is also unassigned, assign it only after reopening. Assignment alone cannot repair a closed-issue wake." }
        elif $noAssignee then
          { c: "DEAD_WAKE",
            w: ("policy is " + $cp + " but the issue has NO ASSIGNEE — :1253 returns "
                + "before waking anyone. The answer lands and nothing starts."),
            fix: "Assign the issue; for a board_only card assign it to the creator." }
        elif $cp == "wake_assignee_on_accept" then
          { c: "WAKES_ON_ACCEPT",
            w: "accept wakes the assignee; a REJECTION wakes nobody (:1263)." }
        else
          { c: "WAKES",
            w: "assignee present and issue open — an answer wakes them (:1253)." }
        end)
     else
       { c: "NO_WAKE_REQUESTED",
         w: ("continuationPolicy is " + ($cp | tostring)
             + " — no wake requested (:1265). An answer starts nothing unless "
             + "the in_review reviewPathLost branch fires, which also needs an assignee.") }
     end) as $cont |
    (if $cont.c == "DEAD_WAKE"
       then ["the wake path is DEAD (:1253): " + $cont.w
             + " Remediation: " + $cont.fix]
       else [] end) as $w3 |

    (if ($missing | length) > 0 then
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
    end) as $out |

    # The continuation is reported ALONGSIDE the verdict, never folded into it.
    # A DEAD_WAKE card is not "INERT" — INERT means nobody may answer, and these
    # cards may very much be answered. They just answer into a void. Collapsing
    # the two would lose exactly the distinction TOG-492 was raised about.
    $out + {
      continuation:    (if $out.verdict == "MALFORMED" then "UNKNOWN" else $cont.c end),
      continuationWhy: (if $out.verdict == "MALFORMED"
                          then "not measured — the row is MALFORMED" else $cont.w end),
      warnings: (($out.warnings // [])
                 + (if $out.verdict == "MALFORMED" then [] else $w3 end))
    }
  '
}

cmd_classify() {
  local strict=0 strict_wake=0 as_json=0; local -a only=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --strict) strict=1 ;;
      --strict-wake) strict_wake=1 ;;
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
        jq -r '"             continuation: " + .continuation + " — " + .continuationWhy' <<<"$r"
        jq -r '.resolvers[]? | "             resolver: " + .'  <<<"$r"
        jq -r '.warnings[]?  | "             WARNING:  " + .'  <<<"$r"
      done <<<"$rows"
      echo
      echo "-- totals --"
      jq -s -r 'group_by(.verdict)[] | "  \(.[0].verdict): \(length)"' <<<"$rows"
      echo "-- continuation --"
      jq -s -r 'group_by(.continuation)[] | "  \(.[0].continuation): \(length)"' <<<"$rows"
    fi
  fi

  # Counted against the UNFILTERED set: --only must never change the exit status.
  local all; all="$(_classify_jq <<<"$input")"
  local malformed inert dead_wake unmeasured unmeasured_status
  malformed="$(jq -s '[.[] | select(.verdict == "MALFORMED")] | length' <<<"$all")"
  inert="$(jq -s '[.[] | select(.verdict == "INERT")] | length' <<<"$all")"
  dead_wake="$(jq -s '[.[] | select(.continuation == "DEAD_WAKE")] | length' <<<"$all")"
  unmeasured="$(jq -s '[.[] | select(.continuation == "UNKNOWN")] | length' <<<"$all")"
  unmeasured_status="$(jq -s '[.[] | select(.continuation == "UNKNOWN" and (.continuationWhy | contains("issueStatus")))] | length' <<<"$all")"

  if [[ "$malformed" -gt 0 ]]; then
    echo "ERROR: $malformed input row(s) MALFORMED — refusing to report a clean board" >&2
    return 2
  fi
  # Order matters: refuse the unmeasured case BEFORE any strict verdict. A
  # combined --strict --strict-wake run must not let INERT hide the fact that
  # the wake path was never measured.
  if [[ $strict_wake -eq 1 && "$unmeasured" -gt 0 ]]; then
    if [[ "$unmeasured_status" -gt 0 ]]; then
      echo "ERROR: $unmeasured_status row(s) carry no issueStatus — issue openness was not measured, refusing to report the wake path clean. Add issueStatus to the input (see \`explain\`)." >&2
    else
      echo "ERROR: $unmeasured row(s) carry no continuationPolicy — the wake path was not measured, refusing to report it clean. Add continuationPolicy to the input (see \`explain\`)." >&2
    fi
    return 2
  fi
  if [[ $strict -eq 1 && "$inert" -gt 0 ]]; then
    echo "STRICT: $inert interaction(s) are INERT — graded agent-resolvable, but no agent can resolve them (only the owner can). Withdraw and re-cut." >&2
    return 3
  fi
  if [[ $strict_wake -eq 1 && "$dead_wake" -gt 0 ]]; then
    echo "STRICT-WAKE: $dead_wake interaction(s) have a DEAD wake path (:1253) — they can be answered, but the answer starts nothing. Read each row's branch-specific Remediation warning; assigning repairs an unassigned issue but cannot repair a closed one." >&2
    return 4
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
  agent who asked it makes it permanently unanswerable by any agent.

THE SECOND GATE — AND THEN WHAT? (added TOG-492)
  :1253  queueResolvedInteractionContinuationWakeup, first line:
             if (!input.issue.assigneeAgentId
                 || isClosedIssueStatus(input.issue.status)) return;
         An UNASSIGNED issue silently drops the continuation wake. The card
         flips to `accepted`, the board shows it answered, and nothing runs.
  :1263  wake_assignee_on_accept wakes only on `accepted`. A REJECTION is
         silent — and a rejection is a real answer that should start real work.
  :1265  any other policy: no wake, except the in_review `reviewPathLost`
         branch, which is itself downstream of the :1253 assignee check.

  So `reviewAttention: covered` does NOT mean the question is live. A pending
  card counts as a maintained path whether or not anything is attached to the
  far end of it.

SO WHICH IS IT — ASSIGN, OR NOT?
  The two gates pull opposite ways, so the honest answer is "it depends on who
  the question is for", and the tool now tells you both halves per row.

    board_only / owner-reserved   ASSIGN IT, to the CREATOR by preference.
                                  No agent can resolve it regardless, so
                                  narrowing the resolver set costs nothing,
                                  and it is the only way the owner's answer
                                  starts work. Assigning to the creator also
                                  closes :2975 permanently, so no agent can
                                  ever approve an owner-reserved matter.

    board_or_agents               A REAL trade-off. Unassigned = widest
                                  resolver set, dead wake. Best of both:
                                  name an addressee who is not the creator,
                                  then assign the issue to that same agent —
                                  one live resolver AND a live wake.

  TOG-38, TOG-58 and TOG-104 were the first case: three healthy board_only
  cards, three unassigned issues, six cards raised, none ever answered, and
  every answer would have died on :1253 anyway.

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
             t.continuation_policy                 as "continuationPolicy",
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
  Or, to sweep for answers that would start nothing:
         psql -At -f pending.sql | ./interaction_triage.sh classify --strict-wake
EXPLAIN
}

case "${1:-}" in
  classify) shift; cmd_classify "$@" ;;
  explain)  shift; cmd_explain ;;
  -h|--help|"") _usage ;;
  *) echo "ERROR: unknown subcommand '$1'" >&2; _usage >&2; exit 2 ;;
esac
