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
#   operator_runbook.sh check         [--classification F] < pending.json
#   operator_runbook.sh check-handoff [--classification F] [--handoff DIR]
#   operator_runbook.sh render        [--classification F]  > docs/OPERATOR-RUNBOOK.md
#   operator_runbook.sh explain
#
# `check` reads the live pending set on stdin — the same JSON array
# interaction_triage.sh consumes, so one query feeds both. Recipe:
# `interaction_triage.sh explain`.
#
# `render` reads NOTHING but the classification file, so CI can regenerate the
# document and diff it without any board access.
#
# ---------------------------------------------------------------------------
# THE HOLE `check` CANNOT SEE, AND WHY check-handoff EXISTS (TOG-851)
# ---------------------------------------------------------------------------
# `check` is driven by the PENDING INTERACTION SET. That makes it blind in one
# specific direction: an ask that never filed an interaction at all is not in
# its input, so it cannot be unclassified, cannot be stale, and cannot be
# not-withdrawn. It is simply invisible, and `check` passes clean.
#
# That is not hypothetical. TOG-846 shipped a complete, live-verified operator
# runbook — a one-key CLIProxy config change unlocking claude-fable-5-1 at
# identical price — filed ZERO interactions, was closed `done`, and had no entry
# in the classification file. Every gate in this tool passed while the artifact
# sat in /paperclip/operator-handoff/ with no path to a human. The guard built to
# stop capability asks from dying silently could not see the one that was.
#
# So `check-handoff` takes the OTHER input: the runbook files on disk. A file
# named TOG-<n>-*runbook*.md in the handoff directory with no entry anywhere in
# the classification file is an ERROR (exit 3). Two inputs, two failure modes:
#   check          catches an ask that filed a card nobody classified.
#   check-handoff  catches an ask that wrote a runbook and filed no card at all.
#
# It needs no board access and no credentials, so unlike `check` it runs in CI.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

CLASSIFICATION="$HERE/operator_runbook_classification.json"
HANDOFF="${HANDOFF_DIR:-/paperclip/operator-handoff}"

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

TWO INPUTS, TWO FAILURE MODES (TOG-851)
  `check` is driven by the pending interaction set. That makes it blind in one
  direction: an ask that never filed an interaction is not in its input, so it
  cannot be unclassified, cannot be stale, and cannot be not-withdrawn. It is
  invisible, and check passes clean.

  TOG-846 was exactly that. A complete, live-verified operator runbook — a
  one-key CLIProxy config change unlocking claude-fable-5-1 at identical price —
  with ZERO interactions, closed `done`, and no entry in the classification
  file. Every gate here passed while the artifact sat in the handoff directory
  with no path to a human.

  `check-handoff` takes the other input, the runbook FILES on disk:
    check          an ask that filed a card nobody classified.
    check-handoff  an ask that wrote a runbook and filed no card at all.

  A file named TOG-<n>-*runbook*.md in the handoff directory with no entry
  anywhere in the classification file is an ERROR (exit 3). Files that predate
  the gate are enumerated in GRANDFATHERED_HANDOFF with the reason each is not a
  stranded ask — an explicit list, so removing one is a visible diff. It reads
  no board and needs no credentials, so it runs in CI; `check` still cannot.
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

  # `pointers` (informational sections, not asks) is intentionally absent here:
  # a pointer neither requires nor forbids board state, so `check` ignores it.
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
    echo
    echo "NOTE: this half is driven by the pending interaction set, so it cannot see a"
    echo "runbook that never filed an interaction (TOG-846 was exactly that). Run"
    echo "\`check-handoff\` for that direction — clean here does not mean nothing is stranded."
  fi
  return $rc
}

# --- check-handoff ---------------------------------------------------------
# The second input. See the header block: `check` is driven by the pending
# interaction set and is structurally blind to an ask that never filed one.
# This half is driven by the FILES, so it catches the opposite failure.
#
# Deliberately NOT reading the board: it needs no credentials, which is what
# lets CI run it on every push. `check` still cannot run there.
#
# GRANDFATHERED is an explicit, enumerated list rather than a date cutoff or a
# silent skip. Thirteen runbook files predate this gate; suppressing them
# quietly would make the gate's first run green and teach nobody anything, and a
# date cutoff rots invisibly the moment someone backdates a file. Each entry is
# named, with the reason it is not a stranded ask, so removing one is a visible
# diff someone has to justify. Anything NOT on this list and NOT classified is
# an error — which is precisely how TOG-846 would have been caught on the day it
# landed.
GRANDFATHERED_HANDOFF=(
  # id       reason it is not a stranded capability ask
  "TOG-111"  # already a live runbook line; this file is a correction note to it
  "TOG-151"  # done. superseded by the TOG-178 apply bundle
  "TOG-156"  # cancelled on the board; the plugin was never installed from this card
  "TOG-178"  # done. deployment deliberately STOPPED on provider callability, recorded on the card
  "TOG-196"  # done. the live runbook moved into git (mcp/deploy/install-runbook.md); the handoff file is a signpost
  "TOG-308"  # done. the restore was performed and verified on the incident thread
  "TOG-419"  # done. canonical source is PR #65 in this repo, not the handoff copy
  "TOG-485"  # done. the switch was executed and its verify chain ran green
  "TOG-514"  # done. executed 2026-08-26; the file now preserves the procedure, it is not an ask
  "TOG-679"  # done. the 47-agent repoint was completed via the console
  "TOG-747"  # blocked on TOG-881, which carries the deploy; tracked there, not stranded
)

cmd_check_handoff() {
  [[ -f "$CLASSIFICATION" ]] || die "classification file not found: $CLASSIFICATION"
  jq -e 'type=="object"' >/dev/null 2>&1 <"$CLASSIFICATION" || die "classification file is not a JSON object"
  # A missing handoff directory must not read as "nothing is stranded" — that is
  # the same fail-open `check` was fixed for. Say it measured nothing.
  [[ -d "$HANDOFF" ]] || die "handoff directory not found: $HANDOFF (refusing to report an unread directory as clean)"

  # `pointers` is intentionally absent here too: an informational section is not
  # a classification, so it can neither register an artifact nor strand one.
  local classified; classified="$(jq -r '(.items|keys[]),(.decisions|keys[]),(.misrouted|keys[]),((.closed//{})|keys[])' "$CLASSIFICATION" | sort -u)"

  # Identifiers that have a runbook artifact sitting in the handoff directory.
  # Case-insensitive on the TOG- prefix and normalised upward: one real file is
  # named `tog-351`, and a gate that missed it because of case would be exactly
  # the silent pass this is meant to remove.
  local present; present="$(
    find "$HANDOFF" -maxdepth 1 -type f \( -iname 'TOG-*runbook*.md' -o -iname 'TOG-*runbook*.markdown' \) -printf '%f\n' 2>/dev/null \
      | grep -oiE '^TOG-[0-9]+' | tr '[:lower:]' '[:upper:]' | sort -u
  )"

  local grandfathered; grandfathered="$(printf '%s\n' "${GRANDFATHERED_HANDOFF[@]}" | sort -u)"
  local unregistered
  unregistered="$(comm -23 <(printf '%s\n' "$present") <(printf '%s\n' "$classified") \
                  | comm -23 - <(printf '%s\n' "$grandfathered"))"

  local n_present n_gf
  n_present="$(printf '%s\n' "$present" | grep -c . || true)"
  n_gf="$(printf '%s\n' "$grandfathered" | grep -c . || true)"
  echo "handoff directory: $HANDOFF"
  echo "runbook artifacts found: $n_present"
  echo "grandfathered (predate this gate): $n_gf"

  if [[ -n "${unregistered//[[:space:]]/}" ]]; then
    echo
    echo "UNREGISTERED — a runbook artifact exists for these, but they appear NOWHERE in"
    echo "$(basename "$CLASSIFICATION"). Nothing will ever deliver them to a human: they"
    echo "filed no interaction, so \`check\` cannot see them either. Add an entry (or"
    echo "grandfather it here with the reason it is not an ask):"
    printf '  %s\n' $unregistered
    return 3
  fi

  echo "OK: every runbook artifact in the handoff directory is registered or explicitly"
  echo "grandfathered. No capability-bound ask is stranded on disk."
  return 0
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
      "### \(n). \(id) — \(v.credential)\n\n"
      # A WITHDRAWN line. The authorisation is gone but the section is retained,
      # because deleting it would read to the next operator as "this was never
      # asked" — the exact state the closed-list comment below guards against.
      # The banner goes ABOVE the blast-radius line, not below it: it is a stop
      # sign, and a stop sign under the risk rating is read second.
      # This is a SOURCE field for a reason: the banner was hand-edited straight
      # into the .md on 2026-09-05, which the render-drift gate correctly caught
      # as staleness. Regenerating without this field would have silently deleted
      # an owner-ruling stop sign, so the fix is to give the withdrawal a home in
      # the data rather than to re-blank the document.
      + (if (v.withdrawn // "") != ""
         then ("> 🛑 **WITHDRAWN \(v.withdrawn.date) — DO NOT RUN ANY SCRIPT IN THIS SECTION.**\n"
              + (v.withdrawn.body | split("\n") | map(if . == "" then ">" else "> " + . end) | join("\n"))
              + "\n\n")
         else "" end)
      + "**Blast radius \(v.blast)**"
      + (if v.class == "MIXED" then "  ·  **MIXED — part of this is owner-reserved**" else "" end)
      + (if v.moved == true then "  ·  **ONLY HOME — no other card carries this ask**" else "" end)
      + "\n\n"
      # Two different ways a line can be the only home, and they must not be
      # narrated the same way. The common case is a card that WAS raised and has
      # since been withdrawn. The other is TOG-846: an ask that never filed an
      # interaction at all, so there was never anything to withdraw. Printing
      # "its interaction has been withdrawn" over that one states a fact that did
      # not happen, and an operator who goes looking for the withdrawn card finds
      # no trace — which reads as a bookkeeping error and undermines the line.
      # A WITHDRAWN line. The authorisation is gone but the section is retained,
      # because deleting it would read to the next operator as "this was never
      # asked" — the exact state the closed-list comment below guards against.
      # This is a SOURCE field for a reason: the banner was hand-edited straight
      # into the .md on 2026-09-05, which the render-drift gate correctly caught
      # as staleness. Regenerating without this field would have silently deleted
      # an owner-ruling stop sign, so the fix is to give the withdrawal a home in
      # the data rather than to re-blank the document.
      + (if v.moved == true
         then (if v.never_carded == true
               then "> **This line is the only home this ask has ever had.** It never filed an\n"
                  + "> interaction, so there is no card to withdraw and no thread to find —\n"
                  + "> if you skip it here, nothing else will surface it.\n\n"
               else "> **This line is the only remaining home for this ask.** Its standing\n"
                  + "> interaction has been withdrawn, so if you skip it here, nothing else\n"
                  + "> will surface it.\n\n"
               end)
         else "" end)
      + "**What it changes.** \(v.changes)\n\n"
      + (if (v.warning // "") != "" then "> ⚠️ **\(v.warning)**\n\n" else "" end)
      + "**Verify.** \(v.verify)\n\n"
      + "**Undo.** \(v.undo)\n\n"
      + (if (v.reserved_part // "") != "" then "**Owner-reserved part.** \(v.reserved_part)\n\n" else "" end)
      + (if (v.note // "") != "" then "**Note.** \(v.note)\n\n" else "" end)
      + (if (v.commands // "") != ""
         then (if (v.withdrawn // "") != ""
               then "**Exact commands.** \(v.withdrawn.commands_note)\n\n```\n\(v.commands)\n```\n"
               else "**Exact commands.**\n\n```\n\(v.commands)\n```\n"
               end)
         else "**Exact commands.** In the **\(id) issue thread** — the author verified them there. (Deliberately the issue thread, not the interaction: "
            + (if v.never_carded == true
               then "this ask never filed an interaction at all, so the thread is the only place they exist."
               else "the interaction gets withdrawn once this line exists, and a runbook that points at a withdrawn card points at nothing."
               end)
            + ")\n"
         end);

    (.items | to_entries | sort_by(.value.blast, .key)) as $items
    | (.decisions | to_entries | sort_by(.key)) as $decisions
    | (.misrouted | to_entries | sort_by(.key)) as $misrouted
    # Retired lines. A runbook that silently DROPS a line reads, to the next
    # operator, as "this was never asked" — and one of the entries below was
    # cancelled without the underlying change ever being made, which is exactly
    # the state that must not disappear quietly. So closure is recorded with the
    # measurement that closed it, and never re-numbered into the live list.
    | ((.closed // {}) | to_entries | sort_by(.key)) as $closed
    # Informational pointers. NOT asks, NOT decisions: no blast radius, no
    # `check` coupling, no numbering, no count. Entries without a title render
    # nothing, so a half-filled row cannot emit an empty heading.
    | ((.pointers // []) | map(select((.title // "") != ""))) as $pointers
    # The lines whose standing interaction has been WITHDRAWN. Numbered here,
    # from the same sorted array the body is rendered from, so the reference
    # cannot drift from the line it points at the way a hand-written list does.
    | ($items | to_entries
       | map(select(.value.value.moved == true))
       | map("**line \(.key + 1) (\(.value.key))**")) as $only_home
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
    + "| — of those, whose ONLY home is this document | \($only_home|length) |\n"
    + "| Genuine decisions, correctly reserved | \($decisions|length) |\n"
    + "| Misrouted — an agent can answer these | \($misrouted|length) |\n"
    + "| Retired since the last revision (recorded, not deleted) | \($closed|length) |\n"
    + "\n"
    + "\($note)\n"
    + "\n---\n\n"
    + (if ($only_home|length) > 0
       then "## Read this before you start\n\n"
          + "**\($only_home|length) of the lines below have no card anywhere else.** Their standing\n"
          + "interaction has been withdrawn, so the runbook line is the only remaining home for\n"
          + "that ask — if you skip it here, nothing else will surface it:\n\n"
          + "> \($only_home | join(", "))\n\n"
          + "Each is also marked **ONLY HOME** on its own line below.\n\n---\n\n"
       else "" end)
    + "## Runbook lines\n\n"
    + ([ $items | to_entries[] | line_block(.value.key; .value.value; .key + 1) ] | join("\n"))
    + "\n---\n\n"
    # A pointer section is unnumbered and uncounted by construction: it sits
    # outside the numbered list and the summary table, so existing line numbers,
    # counts and ordering cannot shift under it. Absent or empty, it renders
    # nothing and the document is byte-identical to before.
    + (if ($pointers|length) > 0
       then "## Pointers — where to look next\n\n"
          + "These are informational only: not asks, not decisions. They need no\n"
          + "triage, require no board state, and forbid nothing.\n\n"
          + ([ $pointers[]
                | "### \(.title)"
                + (if (.id // "") != "" then " (\(.id))" else "" end)
                + "\n\n\(.body // "")\n" ] | join("\n"))
          + "\n---\n\n"
       else "" end)
    + "## Not runbook lines — genuine decisions\n\n"
    + "These name a reserved matter and stay in the decision queue. They are listed\n"
    + "here only so the queue can be reconciled against one document.\n\n"
    # An EMPTY list under this heading would read as "nothing is reserved to the
    # owner", which is the opposite of true — it means every reserved question
    # that was open has been answered. Say which one it is.
    + (if ($decisions|length) == 0
       then "_None open._ Every decision previously listed here has been answered; each is\nrecorded in the retired section below with its outcome. This is not a statement\nthat nothing is reserved — the five reserved matters are unchanged."
       else ([ $decisions[] | "- **\(.key)** — _reserved clause \(.value.clause)._ \(.value.summary)" ] | join("\n")) end)
    + "\n\n---\n\n"
    + "## Not runbook lines — misrouted\n\n"
    + "No agent is blocked on the owner for these. Each reached the owner because its\n"
    + "author hand-typed `board_only`. They should be re-cut as `board_or_agents`\n"
    + "and answered internally.\n\n"
    + (if ($misrouted|length) == 0
       then "_None open._ All three previously listed here were answered internally on\n2026-08-27; see the retired section below."
       else ([ $misrouted[] | "- **\(.key)** — resolvable by \(.value.resolver). \(.value.summary)" ] | join("\n")) end)
    + (if ($closed|length) > 0
       then "\n\n---\n\n"
          + "## Retired — do not work these, but do not assume they were done\n\n"
          + "These left the live list since the last revision. Each carries the measurement\n"
          + "that retired it, because \"absent from the runbook\" and \"actually completed\" are\n"
          + "not the same thing and one of the entries below is the difference.\n\n"
          + ([ $closed[] | "- **\(.key)** — \(.value.outcome)\n  \(.value.evidence)" ] | join("\n"))
       else "" end)
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
      --handoff) HANDOFF="${2:-}"; shift 2 ;;
      --handoff=*) HANDOFF="${1#*=}"; shift ;;
      *) args+=("$1"); shift ;;
    esac
  done
  case "$sub" in
    render)  cmd_render ;;
    check)   cmd_check ;;
    check-handoff) cmd_check_handoff ;;
    explain) cmd_explain ;;
    ""|-h|--help|help)
      sed -n '/^# USAGE/,/^# ====/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      ;;
    *) die "unknown subcommand: $sub (try: render, check, check-handoff, explain)" ;;
  esac
}
main "$@"
