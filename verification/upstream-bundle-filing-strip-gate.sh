#!/usr/bin/env bash
# ===========================================================================
# upstream-bundle-filing-strip-gate.sh -- TOG-1069.
#
# TWO ASSERTIONS, AND THEY ARE DELIBERATELY BOTH HERE
#
#   A. Each of the seven sendable reports, stripped by the STRUCTURAL rule
#      (line 1 through the first `---` rule or first `## ` heading, whichever
#      comes first), leaks no text that discloses filing status, this internal
#      queue, or operator-reserved filing.
#
#   B. docs/upstream/README.md actually TEACHES that rule, and no longer
#      teaches the line-1-only edit it replaced.
#
# B is the one this gate exists for. A was already true on `main` and stayed
# true while the procedure was wrong, because the defect was never in the
# BYTES -- it was in the instructions a human follows to produce the filed
# copy. A gate that scores only the reports reads green on the whole failure.
#
# THE FAILURE THIS EXISTS FOR
#
# `main`'s README said the `DRAFT -- not filed` banner "is kept deliberately,
# and should be edited only by whoever actually files it". A filer who checks
# out `main` and follows `main` reads that as: edit line 1, send. Measured
# against main's blobs with the pattern below, a line-1-only edit ships NINE
# lines that tell the vendor the report is unfiled, that it is one of an
# internal batch, or that we hold no credential for their repository and
# filing is reserved to our operator.
#
# The correct structural rule existed only on an unmerged branch. Being right
# somewhere unreachable is the same as being wrong.
#
# WHY THE PATTERN IS POSITIONAL AND THE RULE IS NOT LEXICAL
#
# The residue pattern below is a DETECTOR, not the rule. Two earlier attempts
# tried to make a sentence list BE the rule and both came up short -- the
# first missed the three reports that say "Held with..." rather than "filed
# only by the operator", the second missed the ordinal openers ("Sixth
# upstream note...") which disclose the queue using no filing word at all.
# The rule a human follows is structural precisely so it cannot rot as
# wording drifts. This pattern only has to catch the phrasings that exist
# today, because assertion B keeps the structural rule in front of the filer.
#
# CARVE-OUT. `### Hard precondition -- do not file until ...` in the two
# OmniRoute reports is NOT holding boilerplate. Those are unmet verification
# preconditions and are load-bearing; they sit far below the boundary and are
# meant to survive. Matching them would teach the next reader to delete a
# warn-off, so they are excluded by name.
#
# THE SINGLE-`#` TRAP. The line-1 banner is a single-`#` heading and is NEVER
# the boundary. A boundary pattern of `^#{1,2} ` selects line 1 itself, the
# strip becomes a no-op, every preamble survives, and the run still prints
# PASS. Only `^## ` counts. `plugin-auth-surface.md` proves this is right: its
# `---` precedes its `#` title, so the title is correctly preserved.
#
# Reads blobs from a git ref when GATE_REF is set (default: working tree):
#   GATE_REF=origin/main verification/upstream-bundle-filing-strip-gate.sh
#
# Exit 0 = clean.  Exit 1 = at least one violation.  Exit 2 = cannot run.
# ===========================================================================

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

GATE_REF="${GATE_REF:-}"
DOC_DIR="docs/upstream"
README="$DOC_DIR/README.md"

# The seven cleared for sending. The three working notes (process-tree-reaping,
# checkout-policy, actor-runid-provenance) are do-not-sends and keep their
# internal framing deliberately -- adding a name here is what gates it.
SENDABLE=(
  agent-run-credential-isolation
  hindsight-company-config-bootstrap
  interaction-comment-supersession-default
  manifest-refresh-escalation
  omniroute-false-cliproxy-terminal-state
  omniroute-truncated-reasoning-false-502
  plugin-auth-surface
)

RESIDUE_PAT='not filed|do not file|filed only by the operator|filing status|held (here|with) the other|held with the others|upstream note for|pending the operator|this bundle'
CARVE_PAT='hard precondition|if any of the three cannot be run'

violations=0
checked=0

note() { printf '%s\n' "$*"; }
fail() { violations=$((violations + 1)); printf '  FAIL  %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }

read_doc() {
  local path="$1"
  if [ -n "$GATE_REF" ]; then
    git cat-file blob "$GATE_REF:$path" 2>/dev/null
  else
    cat "$path" 2>/dev/null
  fi
}

command -v git >/dev/null || { echo "FATAL: git not on PATH" >&2; exit 2; }

note "Upstream bundle filing-strip gate (TOG-1069)"
if [ -n "$GATE_REF" ]; then note "Source: git ref '$GATE_REF'"; else note "Source: working tree"; fi
note ""

# --- A. the seven reports -------------------------------------------------
note "A. structural strip leaves no disclosure residue"
note ""
for name in "${SENDABLE[@]}"; do
  body="$(read_doc "$DOC_DIR/$name.md")"
  note "$name.md"
  if [ -z "$body" ]; then
    fail "unreadable or empty -- cannot gate a file I cannot read"
    note ""
    continue
  fi
  checked=$((checked + 1))
  before=$violations

  # Only `## ` and `---`. Never `# `. See THE SINGLE-`#` TRAP above.
  boundary="$(printf '%s\n' "$body" | grep -nE '^---[[:space:]]*$|^## ' | head -1 | cut -d: -f1)"
  if [ -z "$boundary" ]; then
    fail "no strip boundary (no '---' rule and no '## ' heading) -- the filing strip is undefined for this file"
    note ""
    continue
  fi

  residue="$(printf '%s\n' "$body" | tail -n +"$boundary" \
    | grep -nEi "$RESIDUE_PAT" | grep -viE "$CARVE_PAT")"
  if [ -n "$residue" ]; then
    while IFS= read -r hit; do
      fail "internal framing survives the strip at body line ${hit%%:*}: ${hit#*:}"
    done <<< "$residue"
  fi

  # The line-1-only strip MUST still be shown to leak. If it does not, either
  # the preambles were rewritten or the pattern has rotted -- and a gate whose
  # positive case has silently gone empty is measuring nothing. This is the
  # in-band control: it fires on THIS input, every run, not in a sibling suite.
  leak_n="$(printf '%s\n' "$body" | tail -n +2 \
    | grep -nEi "$RESIDUE_PAT" | grep -viE "$CARVE_PAT" | wc -l | tr -d ' ')"
  if [ "$leak_n" -eq 0 ]; then
    fail "line-1-only strip leaks nothing here -- the contrast this gate measures is gone; re-derive the pattern rather than deleting this check"
  fi

  if [ "$violations" -eq "$before" ]; then
    ok "boundary line $boundary; structural strip clean; line-1-only strip would leak $leak_n"
  fi
  note ""
done

# --- B. the README teaches the rule ---------------------------------------
note "B. docs/upstream/README.md carries the structural rule"
note ""
readme="$(read_doc "$README")"
if [ -z "$readme" ]; then
  fail "README.md unreadable or empty"
else
  rflat="$(printf '%s\n' "$readme" | tr '\n' ' ' | tr -s ' ')"
  rflat_lc="${rflat,,}"

  # B1. The rule is present. Each phrase is load-bearing and distinct: the
  #     rule is structural, it starts at line 1, it runs to a boundary, and
  #     the single-# banner is excluded from being that boundary.
  for phrase in \
    "structural, not lexical" \
    "first structural boundary" \
    "is never the boundary"
  do
    if [[ "$rflat_lc" != *"${phrase,,}"* ]]; then
      fail "README does not carry the rule: missing \"$phrase\""
    fi
  done

  # B2. The superseded instruction is GONE. This is the actual TOG-1069
  #     defect. Matched on the flattened body so a reflow cannot hide it, and
  #     matched as the CLAIM ("edited only by whoever files it") rather than
  #     the word "banner", which legitimately still appears in the new rule.
  if printf '%s\n' "$rflat" | grep -qEi 'should be edited only by whoever actually files it'; then
    fail "README still teaches the line-1-only edit: \"...should be edited only by whoever actually files it\" -- this is the instruction the structural rule supersedes"
  fi

  # B3. The per-file strip table is present and names every gated report.
  #
  #     SCOPED TO THE TABLE ROWS, not the section and not the file. Two
  #     narrowings, each forced by a mutant that survived the looser version:
  #
  #     - Whole-FILE matching passes even with no strip table at all, because
  #       every one of these names also appears in the "## The reports" index
  #       below. That is the state unfixed `main` is in.
  #     - Whole-SECTION matching still passes when a table ROW is deleted,
  #       because the carve-out prose in the same section names
  #       `plugin-auth-surface.md` and `hindsight-company-config-bootstrap.md`
  #       in passing. M4 survived on exactly this before it was narrowed.
  #
  #     So: extract the section, then keep only its table rows -- lines that
  #     start `| \`` and carry a `|`-delimited "delete lines 1-" column.
  rule_section="$(printf '%s\n' "$readme" \
    | awk '/^## How to strip a report before filing/{f=1;next} f&&/^## /{f=0} f')"
  if [ -z "$rule_section" ]; then
    fail "README has no '## How to strip a report before filing' section"
  else
    table_rows="$(printf '%s\n' "$rule_section" | grep -E '^\| `[a-z0-9-]+\.md` \| [0-9]+')"
    if [ -z "$table_rows" ]; then
      fail "README strip-rule section carries no per-file table -- the rule without its table sends the filer back to counting lines by eye"
    else
      for name in "${SENDABLE[@]}"; do
        if ! printf '%s\n' "$table_rows" | grep -qF "\`$name.md\`"; then
          fail "README strip table has no row for $name.md"
        fi
      done
    fi
  fi

  # B4. The carve-out survives. Without it a filer strips the two OmniRoute
  #     warn-offs, which is the opposite failure and turns the bundle gate red.
  if [[ "$rflat_lc" != *"hard precondition"* ]]; then
    fail "README no longer carries the 'Hard precondition' carve-out -- a filer would strip the two OmniRoute warn-offs"
  fi

  [ "$violations" -eq 0 ] && ok "rule, table, carve-out present; superseded line-1 instruction absent"
fi
note ""

note "-----------------------------------------------------------------"
if [ "$violations" -eq 0 ]; then
  note "PASS  $checked/7 reports strip clean; README teaches the structural rule"
  exit 0
fi
note "FAIL  $violations violation(s) across $checked report(s) + README"
exit 1
