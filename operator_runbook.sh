#!/usr/bin/env bash
# ===========================================================================
# operator_runbook.sh — turn the capability-bound asks into ONE runbook, and
# keep the decision queue for decisions (TOG-434).
#
# ---------------------------------------------------------------------------
# THE RULE THIS TOOL ENFORCES
# ---------------------------------------------------------------------------
#   If the answer is an ACTION only a human can perform  -> it is a RUNBOOK LINE.
#   If the answer is a JUDGEMENT only the owner may make -> it is a DECISION.
#   Never file the first as the second.
#
# Filed as a confirmation, "please run these three root commands" renders on the
# board as a decision awaiting judgement. Nobody triages it as work, so it ages
# out. That is not hypothetical: 47 of this company's 189 interactions have
# expired, and when TOG-434 swept the pending set, 21 of the 35 owner-only asks
# were requests for hands, not for a decision.
#
# ---------------------------------------------------------------------------
# WHAT IS MECHANICAL HERE AND WHAT IS NOT
# ---------------------------------------------------------------------------
# `interaction_triage.sh classify --only OWNER_ONLY` produces the candidate set
# mechanically, from the resolver gate. It cannot tell a decision from a
# capability request — that is a reading of what the ask SAYS, and it is a
# judgement. So the judgement is checked in as data
# (operator_runbook_classification.json) rather than re-improvised per run, and
# this tool renders it.
#
# The consequence worth having is `check`: a pending board_only interaction with
# no entry in that file is an ERROR (exit 3). A new capability-bound ask cannot
# quietly join the owner's queue without someone classifying it. The runbook
# rots LOUDLY instead of silently.
#
# ---------------------------------------------------------------------------
# ORDERING — BY BLAST RADIUS, NOT BY AGE
# ---------------------------------------------------------------------------
# The point of one document is that the owner works down it in one sitting
# instead of context-switching across 15 issue threads. Ordering by blast radius
# means the privilege-boundary changes come first, while attention is freshest,
# and the read-only ones come last where an interruption costs nothing.
#
#   1  changes a privilege boundary or a live credential
#   2  changes what runs, or who can reach it
#   3  scoped grant to a single agent
#   4  read-only, no state change
#
# ---------------------------------------------------------------------------
# USAGE
#   operator_runbook.sh check  [--classification F] < pending.json
#   operator_runbook.sh render [--classification F]  > docs/OPERATOR-RUNBOOK.md
#   operator_runbook.sh explain
#
# `check` reads the live pending set on stdin — the same JSON array
# interaction_triage.sh consumes, so one query feeds both. Recipe:
# `interaction_triage.sh explain`.
#
# `render` reads NOTHING but the classification file, so CI can regenerate the
# document and diff it without any board access.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

CLASSIFICATION="$HERE/operator_runbook_classification.json"

die() { echo "ERROR: $*" >&2; exit 2; }

# --- the rule, printed so nobody has to take it on trust -------------------
cmd_explain() {
  cat <<'EXPLAIN'
THE RULE
  If the answer is an ACTION only a human can perform  -> RUNBOOK LINE.
  If the answer is a JUDGEMENT only the owner may make -> DECISION BRIEF.
  Never file the first as the second.

WHY IT MATTERS
  A capability request filed as a request_confirmation renders as a decision
  awaiting judgement. It is not triaged as work, so it ages out. 47 of 189
  interactions in this company have expired. Of the 35 pending board_only asks
  swept for TOG-434, 21 were requests for hands and only 8 named a reserved
  matter.

THE FOUR CLASSES
  CAPABILITY  an action only a human can perform. Becomes a numbered runbook
              line: what it changes, exact commands, how to verify, how to undo.
  DECISION    a judgement naming one of the five reserved matters. Stays an
              interaction. Never a runbook line.
  MIXED       both. The runbook line carries the action; the reserved part is
              called out on the line so it is not executed by accident.
  MISROUTED   neither. An agent could answer it today. It reached the owner
              because the author hand-typed board_only. Re-cut, do not escalate.

WHY board_only AND NOT THE toolAction RULE
  routes/issues.js:2953 forces board-only on any request_confirmation carrying
  payload.toolAction. That is NOT what put these in the queue: zero of the 35
  carry toolAction. Every one is board_only because its author chose it. This
  is a habit, not a platform constraint, which is why the fix is a rule and a
  runbook rather than a patch.

BLAST RADIUS ORDERING
  1  changes a privilege boundary or a live credential
  2  changes what runs, or who can reach it
  3  scoped grant to a single agent
  4  read-only, no state change
  Highest first: the owner spends freshest attention where a mistake costs most.

INPUT
  The same JSON array interaction_triage.sh consumes. See its `explain`.
EXPLAIN
}

# --- read stdin once, validate --------------------------------------------
# Sets the global INPUT rather than echoing it. That is not a style choice:
# `input="$(read_input)"` runs the function in a subshell, so a `die` inside it
# exits the SUBSHELL and the caller sails on with an empty string. Empty input
# then renders as "pending board_only: 0" — a malformed or truncated query
# reading as a clean board, which is the exact failure this gate exists to
# prevent. A check that measured nothing must not read green.
INPUT=""
read_input() {
  INPUT="$(cat)"
  [[ -n "${INPUT//[[:space:]]/}" ]] \
    || die "stdin was empty. Expected a JSON array of pending interactions (see: interaction_triage.sh explain). Refusing to report an empty board as clean."
  jq -e 'type == "array"' >/dev/null 2>&1 <<<"$INPUT" \
    || die "stdin must be a JSON array of pending interactions (see: interaction_triage.sh explain)"
}

# The owner-only candidate set: board_only, which is what reaches the owner.
# Deliberately NOT re-deriving the resolver gate here — interaction_triage.sh
# owns that. This tool only needs "did it reach the owner".
pending_board_only() {
  jq -r '.[] | select(.effectiveResolverPolicy == "board_only") | .identifier' <<<"$1" | sort -u
}

cmd_check() {
  read_input
  local input="$INPUT"
  [[ -f "$CLASSIFICATION" ]] || die "classification file not found: $CLASSIFICATION"
  jq -e 'type=="object"' >/dev/null 2>&1 <"$CLASSIFICATION" || die "classification file is not a JSON object"

  local classified; classified="$(jq -r '(.items|keys[]),(.decisions|keys[]),(.misrouted|keys[])' "$CLASSIFICATION" | sort -u)"
  local pending;    pending="$(pending_board_only "$input")"

  # The state machine. An item that has MOVED to the runbook is SUPPOSED to be
  # absent from the pending set — that is the whole point of the exercise. If
  # "classified but not pending" always meant STALE, then the day the last
  # withdrawal lands every line reports stale, the gate becomes noise, and
  # people stop reading it. So `moved: true` is the marker that says "expected
  # to be gone", and the interesting failure inverts: a moved line that is
  # STILL pending means the withdrawal never actually happened.
  local moved; moved="$(jq -r '.items | to_entries[] | select(.value.moved == true) | .key' "$CLASSIFICATION" | sort -u)"
  local not_moved; not_moved="$(comm -23 <(printf '%s\n' "$classified") <(printf '%s\n' "$moved"))"

  local unclassified stale not_withdrawn rc=0
  unclassified="$(comm -23 <(printf '%s\n' "$pending") <(printf '%s\n' "$classified"))"
  # stale = classified, NOT marked moved, and no longer pending
  stale="$(comm -13 <(printf '%s\n' "$pending") <(printf '%s\n' "$not_moved"))"
  # not_withdrawn = marked moved, but still sitting in the owner's queue
  not_withdrawn="$(comm -12 <(printf '%s\n' "$pending") <(printf '%s\n' "$moved"))"

  local n_pending n_moved
  n_pending="$(printf '%s\n' "$pending" | grep -c . || true)"
  n_moved="$(printf '%s\n' "$moved" | grep -c . || true)"
  echo "pending board_only: $n_pending"
  echo "moved to the runbook: $n_moved"

  if [[ -n "${unclassified//[[:space:]]/}" ]]; then
    echo
    echo "UNCLASSIFIED — these reached the owner and nobody has said whether they are"
    echo "decisions or capability requests. Classify each in $(basename "$CLASSIFICATION"):"
    printf '  %s\n' $unclassified
    rc=3
  fi

  if [[ -n "${not_withdrawn//[[:space:]]/}" ]]; then
    echo
    echo "NOT WITHDRAWN — these are live runbook lines, but the interaction standing in"
    echo "for them is STILL pending in the owner's queue. The owner sees the same ask"
    echo "twice, once as work and once as a decision. Chase the author to withdraw it:"
    printf '  %s\n' $not_withdrawn
    rc=3
  fi

  if [[ -n "${stale//[[:space:]]/}" ]]; then
    echo
    echo "STALE — classified, never marked moved, and no longer pending (answered or"
    echo "re-cut by someone else). Remove from the classification file, or set"
    echo "moved:true if it became a runbook line:"
    printf '  %s\n' $stale
    rc=3
  fi

  if (( rc == 0 )); then
    echo "OK: every pending board_only interaction is classified; every moved line"
    echo "has actually been withdrawn; nothing classified has gone stale."
  fi
  return $rc
}

# --- render ----------------------------------------------------------------
# jq does the whole document. Keeping it in one filter means the ordering is a
# property of the data (sort_by blast, then identifier), not of a shell loop
# that could silently drop a row.
# render takes NO input. The classification file is the whole source, so the
# document is a pure function of checked-in data: same file in, same file out,
# no board access, no credentials. `check` is the half that needs the live
# board. Keeping them separate is what lets CI render and diff the runbook.
cmd_render() {
  [[ -f "$CLASSIFICATION" ]] || die "classification file not found: $CLASSIFICATION"

  local generated_note
  generated_note='Generated from `operator_runbook_classification.json` by `operator_runbook.sh render`. Do not hand-edit — edit the classification file and regenerate. Validate it against the live board with `operator_runbook.sh check < pending.json`.'

  jq -r --arg note "$generated_note" '
    def esc: .;
    def line_block(id; v; n):
      "### \(n). \(id) — \(v.credential)\n"
      + "\n**Blast radius \(v.blast)**"
      + (if v.class == "MIXED" then "  ·  **MIXED — part of this is owner-reserved**" else "" end)
      + "\n\n"
      + "**What it changes.** \(v.changes)\n\n"
      + (if (v.warning // "") != "" then "> ⚠️ **\(v.warning)**\n\n" else "" end)
      + "**Verify.** \(v.verify)\n\n"
      + "**Undo.** \(v.undo)\n\n"
      + (if (v.reserved_part // "") != "" then "**Owner-reserved part.** \(v.reserved_part)\n\n" else "" end)
      + (if (v.note // "") != "" then "**Note.** \(v.note)\n\n" else "" end)
      + (if (v.commands // "") != ""
         then "**Exact commands.**\n\n```\n\(v.commands)\n```\n"
         else "**Exact commands.** In the **\(id) issue thread** — the author verified them there. (Deliberately the issue thread, not the interaction: the interaction gets withdrawn once this line exists, and a runbook that points at a withdrawn card points at nothing.)\n"
         end);

    (.items | to_entries | sort_by(.value.blast, .key)) as $items
    | (.decisions | to_entries | sort_by(.key)) as $decisions
    | (.misrouted | to_entries | sort_by(.key)) as $misrouted
    |
      "# Operator runbook — actions no agent can perform\n"
    + "\n"
    + "> **This document is not a decision queue.** Every numbered line below is an\n"
    + "> action that has already been decided and that needs human hands, a human\n"
    + "> credential, or a click no agent holds. Nothing here is asking you to choose.\n"
    + "\n"
    + "**The rule, for everyone, going forward:** if the answer is an action only a\n"
    + "human can perform, it is a runbook line. If the answer is a judgement only the\n"
    + "owner may make, it is a decision brief. Never file the first as the second.\n"
    + "\n"
    + "Ordered by **blast radius**, highest first, so you can work down it in one\n"
    + "sitting: `1` changes a privilege boundary or a live credential · `2` changes\n"
    + "what runs or who can reach it · `3` a scoped grant to one agent · `4`\n"
    + "read-only.\n"
    + "\n"
    + "| | count |\n|---|---|\n"
    + "| Runbook lines (capability requests) | \($items|length) |\n"
    + "| Genuine decisions, correctly reserved | \($decisions|length) |\n"
    + "| Misrouted — an agent can answer these | \($misrouted|length) |\n"
    + "\n"
    + "\($note)\n"
    + "\n---\n\n"
    + "## Runbook lines\n\n"
    + ([ $items | to_entries[] | line_block(.value.key; .value.value; .key + 1) ] | join("\n"))
    + "\n---\n\n"
    + "## Not runbook lines — genuine decisions\n\n"
    + "These name a reserved matter and stay in the decision queue. They are listed\n"
    + "here only so the queue can be reconciled against one document.\n\n"
    + ([ $decisions[] | "- **\(.key)** — _reserved clause \(.value.clause)._ \(.value.summary)" ] | join("\n"))
    + "\n\n---\n\n"
    + "## Not runbook lines — misrouted\n\n"
    + "No agent is blocked on the owner for these. Each reached the owner because its\n"
    + "author hand-typed `board_only`. They should be re-cut as `board_or_agents`\n"
    + "and answered internally.\n\n"
    + ([ $misrouted[] | "- **\(.key)** — resolvable by \(.value.resolver). \(.value.summary)" ] | join("\n"))
    + "\n"
  ' "$CLASSIFICATION"
}

main() {
  local sub="${1:-}"; shift || true
  local args=()
  while (( $# )); do
    case "$1" in
      --classification) CLASSIFICATION="${2:-}"; shift 2 ;;
      --classification=*) CLASSIFICATION="${1#*=}"; shift ;;
      *) args+=("$1"); shift ;;
    esac
  done
  case "$sub" in
    render)  cmd_render ;;
    check)   cmd_check ;;
    explain) cmd_explain ;;
    ""|-h|--help|help)
      sed -n '/^# USAGE/,/^# ====/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      ;;
    *) die "unknown subcommand: $sub (try: render, check, explain)" ;;
  esac
}
main "$@"
