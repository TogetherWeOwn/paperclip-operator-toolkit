#!/usr/bin/env bash
# Filing gate for the upstream defect-report bundle.
#
# Checks the seven "send with edits" reports against the upstream project's
# CONTRIBUTING rules and against this company's own disclosure rules, so the
# same input gives the same answer every time instead of being re-judged by
# eye on each review pass.
#
# Scope note: the three working notes (process-tree-reaping, checkout-policy,
# actor-runid-provenance) are deliberately NOT gated -- they are do-not-sends
# and are allowed to keep internal ids. README.md is the local index and does
# not ship. Adding a file to SENDABLE is what puts it under the gate.
#
# Reads blobs from a git ref when GATE_REF is set (default: the working tree),
# so the same gate can be run against a pinned commit:
#   GATE_REF=origin/main verification/upstream-bundle-filing-gate.sh
#
# Exit 0 = every gated report is clean. Exit 1 = at least one violation.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

GATE_REF="${GATE_REF:-}"
DOC_DIR="docs/upstream"

SENDABLE=(
  agent-run-credential-isolation
  hindsight-company-config-bootstrap
  interaction-comment-supersession-default
  manifest-refresh-escalation
  omniroute-false-cliproxy-terminal-state
  omniroute-truncated-reasoning-false-502
  plugin-auth-surface
  discord-plugin-proactive-job-scope
)

# Agent uuid prefixes confirmed to belong to real roster agents. A report that
# ships one of these is disclosing who works here.
REAL_AGENT_PREFIXES='6a02a7ed|974632dd'

# Source paths a report may cite. Check 6 asserts that a report claiming a
# local source read names only files this host can actually produce.
# Built from the filesystem rather than hardcoded, so it cannot go stale.
#
# FULL PATHS, not basenames. An earlier revision indexed basenames only, which
# under-reported absent citations: report 10's `db/models.ts` and
# `src/sse/services/auth.ts` are OmniRoute files that are nowhere on this box,
# but both scored present against unrelated host files that happen to share a
# basename -- `/app/server/src/routes/auth.ts` (an Express auth router) and a
# `pi-local` adapter model cache. `grep -c` for the three symbols report 10
# attributes to them returns 0 in those files. Matching on the citation as a
# path SUFFIX keeps the check honest: `db/models.ts` only counts as present if
# some indexed file actually ends in `db/models.ts`.
#
# Scoped to the deployed server and this repo -- deliberately NOT `find /`.
# Two reasons, both learned by getting it wrong:
#   1. Correctness. A `/` scan sweeps other runs' /tmp scratch. Measured during
#      this gate's own development: 105 indexed files belonged to a sibling
#      run's scratch dir, which is deleted when that run ends. A citation could
#      pass only because another run happened to be live -- the same input
#      would give a different answer an hour later, which is exactly what a
#      gate exists to prevent.
#   2. Cost. A recursive scan of / walks /proc and every node_modules. An
#      earlier `-r /` search in this workstream ran 11+ minutes at ~600% CPU
#      and had to be killed by the operator.
# /app/server/dist is the shipped server -- the thing a "does this symbol exist
# in the product" question is actually about.
#
# INSTALLED PLUGINS ARE IN SCOPE, AND THEIR node_modules PRUNE IS LIFTED.
# A vendor plugin ships as a package under the plugin root, so it is excluded
# twice over by the two rules above: it is outside both roots, AND it lives
# under a node_modules/ path. That made check 6 report an INSTALLED vendor file
# as "absent from this host" -- the exact inversion the check exists to catch.
# Measured: the discord report cites `escalation-state.js`, which is really at
# <plugin-root>/paperclip-plugin-discord/dist/escalation-state.js, and the gate
# failed the report for citing a file it was merely unable to look at. A gate
# that manufactures an absent-source violation against a source we do hold
# blocks a cleared report and teaches the next reviewer to wave check 6 through.
#
# The prune is lifted ONLY for this root. /app and the repo keep it: there the
# prune is what stops a dependency's own sources from answering "does this
# symbol exist in the product". Plugin packages ARE the product under scrutiny.
PLUGIN_ROOT=/paperclip/.paperclip/plugins
SEARCH_ROOTS=(/app "$REPO_ROOT")
HOST_SOURCE_INDEX="$(find "${SEARCH_ROOTS[@]}" \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) \
  -not -path '*/node_modules/*' 2>/dev/null | sort -u)"
if [ -d "$PLUGIN_ROOT" ]; then
  HOST_SOURCE_INDEX="$HOST_SOURCE_INDEX
$(find "$PLUGIN_ROOT" \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) \
  2>/dev/null | sort -u)"
fi

# Is $1 a path suffix of any indexed file, on a segment boundary?
# Pure-bash for the same reason the loop below is: `grep -q` in a pipeline
# under `set -o pipefail` SIGPIPEs the writer and turns a hit into a miss.
cited_file_present() {
  local cite="$1" line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    [ "$line" = "$cite" ] && return 0
    [[ "$line" == */"$cite" ]] && return 0
  done <<< "$HOST_SOURCE_INDEX"
  return 1
}

violations=0
checked=0

note() { printf '%s\n' "$*"; }
fail() {
  violations=$((violations + 1))
  printf '  FAIL  %s\n' "$*"
}

# Emit the file's bytes from the configured source.
read_doc() {
  local name="$1" path="$DOC_DIR/$name.md"
  if [ -n "$GATE_REF" ]; then
    git cat-file blob "$GATE_REF:$path" 2>/dev/null
  else
    cat "$path" 2>/dev/null
  fi
}

note "Upstream bundle filing gate"
if [ -n "$GATE_REF" ]; then
  note "Source: git ref '$GATE_REF'"
else
  note "Source: working tree"
fi
note ""

for name in "${SENDABLE[@]}"; do
  body="$(read_doc "$name")"
  if [ -z "$body" ]; then
    note "$name.md"
    fail "unreadable or empty -- cannot gate a file I cannot read"
    note ""
    continue
  fi
  checked=$((checked + 1))
  note "$name.md"
  before=$violations

  # 1. Internal issue ids. CONTRIBUTING bans "any {PREFIX}-{NUMBER} identifier
  #    that isn't a public GitHub issue number", so this is deliberately
  #    case-insensitive: a branch-style `tog-233` in a script path is banned
  #    just as much as `TOG-233` in prose.
  #    Carve-outs are for genuine non-issue tokens that share the shape:
  #      - model and package names  (claude-haiku-4-5-20251001, gpt-oss-20b)
  #      - HTTP/RFC-ish tokens      (SHA-256, UTF-8, HTTP-502)
  #    Public GitHub refs (#6623) do not match this pattern at all.
  ids="$(printf '%s\n' "$body" \
    | grep -nEio '\b[A-Za-z]{2,10}-[0-9]+\b' \
    | grep -Eiv ':(claude|gpt|haiku|opus|sonnet|fable|sha|utf|iso|rfc|http|omniroute|node|pg|x)-[0-9]+$')"
  if [ -n "$ids" ]; then
    while IFS= read -r hit; do
      fail "internal issue id at line ${hit%%:*}: ${hit#*:}"
    done <<< "$ids"
  fi

  # 2. Real agent uuids. Role-neutral placeholders (agent-A, <agent-B>) are the
  #    sanctioned replacement and do not match.
  uuids="$(printf '%s\n' "$body" | grep -nEi "\b($REAL_AGENT_PREFIXES)\b")"
  if [ -n "$uuids" ]; then
    while IFS= read -r hit; do
      fail "real roster agent id at line ${hit%%:*}: ${hit#*:}"
    done <<< "$uuids"
  fi

  # 2b. ANY host identifier in uuid shape, not just the two roster agents in
  #     REAL_AGENT_PREFIXES. The bundle leaked a *run* uuid next to an agent
  #     uuid, and a run id is not on that allowlist -- neither is a company id,
  #     a workspace id, or the next agent hired. An identifier-shaped token is
  #     never load-bearing in a vendor defect report: every real one in this
  #     bundle was replaced by a placeholder, so the clean revision contains
  #     zero and this check has no false positives to trade against.
  anyuuid="$(printf '%s\n' "$body" \
    | grep -nEi '\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b')"
  if [ -n "$anyuuid" ]; then
    while IFS= read -r hit; do
      fail "host identifier (uuid shape) at line ${hit%%:*}: ${hit#*:}"
    done <<< "$anyuuid"
  fi

  # 3. Host path layout. An absolute path rooted at the install root tells a
  #    reader the host's on-disk layout; <instance-root>/... does not.
  #    Matched on '/paperclip/' rather than '/paperclip/instances/': the
  #    company, agent-instruction and acp-engine trees all sit beside
  #    instances/ and disclose the same layout. The clean revision contains no
  #    occurrence of either form.
  paths="$(printf '%s\n' "$body" | grep -nE '/paperclip/')"
  if [ -n "$paths" ]; then
    while IFS= read -r hit; do
      fail "absolute host path at line ${hit%%:*}: ${hit#*:}"
    done <<< "$paths"
  fi

  # 3b. Names of OTHER TENANTS on this host.
  #
  #     This is a disclosure class the first seven reports never exercised, so
  #     nothing here caught it: they describe host mechanisms, while the discord
  #     report describes a defect whose whole mechanism is "the loop iterates
  #     every company on the box". Naming them tells a vendor who else is a
  #     customer -- that is not our disclosure to make, and it is not load-
  #     bearing: company-A/B/C/D carries the ordering argument exactly as well.
  #
  #     Deliberately NOT built by querying the control plane. A gate that reads
  #     the live roster gives a different answer as tenants come and go, and the
  #     caller here (an unprivileged agent token) gets 403 on /api/companies
  #     anyway -- so the query would fail open and silently check nothing. The
  #     list is literal and reviewable; adding a tenant means editing it.
  #
  #     Our own company name is included. It is the one a report is most likely
  #     to name innocently, and it identifies the filer.
  TENANTS='Octavo Foundry|TWO Gaming|TogetherWeOwn|Untended'
  tenants="$(printf '%s\n' "$body" | grep -nE "$TENANTS")"
  if [ -n "$tenants" ]; then
    while IFS= read -r hit; do
      fail "tenant name at line ${hit%%:*}: ${hit#*:}"
    done <<< "$tenants"
  fi

  # 4. The specific false claim the CEO review caught. The installed-plugin
  #    table contradicts it, so it must never come back -- including via
  #    copy-forward from the do-not-send working note that still carries it.
  #
  #    Matched against a whitespace-flattened copy of the body, NOT line by
  #    line. Both real occurrences of this claim wrap across a line break --
  #    "no installed\nplugin ... declares `apiRoutes`" in the pre-remediation
  #    revision of this report, and "no installed\nplugin declares `apiRoutes`"
  #    in the checkout-policy working note. A line-anchored grep matches
  #    neither, so the original form of this check was dead: it reported ok on
  #    a revision that carried the claim verbatim. Reflowing a paragraph must
  #    not decide whether the gate can see a banned sentence.
  #
  #    Because the match is whole-body, there is no line number to report; the
  #    flattened excerpt is echoed instead so the operator can find it.
  flat="$(printf '%s\n' "$body" | tr '\n' ' ' | tr -s ' ')"
  claim="$(printf '%s\n' "$flat" \
    | grep -oEi 'no installed[[:space:]]+plugin[^.]{0,80}declares .?apiRoutes.?[^.]{0,20}')"
  if [ -n "$claim" ]; then
    while IFS= read -r hit; do
      fail "refuted apiRoutes-adoption claim: ${hit}"
    done <<< "$claim"
  fi

  # 5. Internal framing that survives the filing strip.
  #
  #    These drafts deliberately KEEP their "DRAFT -- not filed" preamble: they
  #    are unfiled, and the banner is edited by whoever files them. So the gate
  #    must not demand the preamble be absent. What it must enforce is that the
  #    documented strip is SUFFICIENT -- that deleting the preamble removes all
  #    of this text, leaving nothing for a filer to miss.
  #
  #    The strip boundary is structural, not a sentence list: line 1 through the
  #    first `---` rule or first `## ` heading, whichever comes first. Two
  #    lexical lists were written for this and both came up short (one missed
  #    three files, the next missed a body-level reference and two ordinal
  #    openers that use no filing word at all), so the rule is positional.
  #
  #    The single-`#` banner on line 1 is NEVER the boundary. Matching `^#{1,2} `
  #    selects line 1 itself, the strip becomes a no-op, and every preamble
  #    survives while the run still looks like it did something. Only `## `
  #    counts. plugin-auth-surface is the case that proves this is right: its
  #    `---` precedes its `#` title, so the title is correctly preserved.
  #
  #    Carve-out: the `### Hard precondition -- do not file until ...` sections
  #    in the two OmniRoute reports are NOT holding boilerplate. They are unmet
  #    verification preconditions and are load-bearing; check 5 must leave them
  #    alone or an over-broad strip would silently delete a warn-off.
  boundary="$(printf '%s\n' "$body" | grep -nE '^---[[:space:]]*$|^## ' | head -1 | cut -d: -f1)"
  if [ -z "$boundary" ]; then
    fail "no strip boundary (no '---' rule and no '## ' heading) -- the filing strip is undefined for this file"
  else
    residue="$(printf '%s\n' "$body" | tail -n +"$boundary" \
      | grep -nEi 'not filed|do not file|filed only by the operator|filing status|held (here|with) the other|held with the others|upstream note for|pending the operator|this bundle' \
      | grep -viE 'hard precondition|if any of the three cannot be run')"
    if [ -n "$residue" ]; then
      while IFS= read -r hit; do
        fail "internal framing survives the strip at body line ${hit%%:*}: ${hit#*:}"
      done <<< "$residue"
    fi
  fi

  # 6. A local-source-read assertion for a file this host does not have.
  #
  #    This class has now recurred twice. Report 9 originally said its cited
  #    vendor functions were read locally; they were not, and it was rewritten
  #    to say so. Report 10 then made the same assertion about a v3.8.49 tree
  #    that does not exist here -- two reports in one bundle, about the same
  #    vendor, contradicting each other on whether we hold their source. That
  #    contradiction is exactly the credibility failure this bundle cannot
  #    afford, so it is now mechanical rather than left to the next reviewer.
  #
  #    The mechanical fact is "this report cites a vendor source file that is
  #    nowhere on this host". Detecting the ENGLISH assertion instead was tried
  #    first and rejected: the two real claims are phrased differently ("read
  #    access to OmniRoute's source", "citations were read directly from ...
  #    available on this host"), the honest downgrades are phrased as negations
  #    of the same words, and a regex that separates them is exactly the kind of
  #    check that reports ok on text carrying the defect. Check 4 was already
  #    dead once for a near-identical reason.
  #
  #    So: cite an absent source file and you must carry the explicit
  #    do-not-file precondition marker. Basename presence, not content -- the
  #    failure caught is "nowhere on this box". A report may still cite absent
  #    vendor code as an acknowledged reconstruction; it may not do so silently.
  #    Lookups below are pure-bash matches, deliberately NOT
  #    `printf ... | grep -qxF`. Under `set -o pipefail`, `grep -q` exits the
  #    moment it matches, the upstream printf takes SIGPIPE, and the pipeline
  #    reports 141 -- so a HIT intermittently reads as a MISS. That raced: it
  #    mis-reported different files on different runs of the same input.
  #
  #    ONE-SEGMENT AND BARE CITATIONS COUNT TOO. An earlier revision required
  #    at least TWO directory segments, which left the gate blind to most of
  #    the bundle it guards: eight one-segment citations were in scope,
  #    including the `plugin-job-store.ts` a CEO review blocked a report on.
  #    Mutants proved it -- an absent vendor file cited as `nowhereatall.ts:396`
  #    or `src/nowhereatall.ts:396`, with no do-not-file marker, both passed.
  #
  #    The two-segment rule was there to spare one real false positive: "a new
  #    `dist/manifest.js` there" in manifest-refresh-escalation is prose about
  #    a build artifact, and failing it taught the next reviewer to wave the
  #    check through. Suffix matching (see `cited_file_present`) spares it for
  #    the right reason instead: four plugins really do build a
  #    `dist/manifest.js` under this repo, so the citation resolves and the
  #    check stays quiet. That case is pinned as a control in
  #    verification/tog-1029-filing-gate-check5-mutants.sh -- if it ever starts
  #    failing again, the fix is not to re-narrow the pattern.
  #
  #    RESTORED after d9033479 replaced this check in place rather than adding
  #    alongside it. Checks 5 and 6 are orthogonal -- 5 asks "does internal
  #    framing survive the strip", 6 asks "is a cited vendor file absent here"
  #    -- and the tog-1029 suite went 4/4 surviving while the bundle still read
  #    PASS 7/7, because every gated report happens to carry the marker today.
  cited_absent=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    cited_file_present "$f" && continue
    cited_absent="$cited_absent $f"
  done <<< "$(printf '%s\n' "$body" \
    | grep -oE '[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*\.(ts|tsx|js|mjs)\b' \
    | sort -u)"

  if [ -n "${cited_absent# }" ]; then
    # The marker both downgraded reports carry. Matched on the flattened body
    # so a line break inside the heading cannot hide it.
    flat_lc="${flat,,}"
    if [[ "$flat_lc" == *"hard precondition"* && "$flat_lc" == *"do not file"* ]]; then
      note "  note  cites source absent from this host (${cited_absent# }) -- carries the do-not-file precondition"
    else
      fail "cites vendor source absent from this host (${cited_absent# }) with no 'Hard precondition / do not file' marker -- an unbacked source read"
    fi
  fi

  if [ "$violations" -eq "$before" ]; then
    note "  ok    no internal ids, no roster ids, no host paths, no refuted claim, strip is sufficient, no unbacked source read"
  fi
  note ""
done

# The gate is only meaningful if it actually opened the files it claims to
# cover. A silent zero-file run must not read as green.
if [ "$checked" -ne "${#SENDABLE[@]}" ]; then
  fail "gated $checked of ${#SENDABLE[@]} reports -- the rest were unreadable"
fi

if [ "$violations" -eq 0 ]; then
  note "PASS -- ${#SENDABLE[@]} reports clean"
  exit 0
fi

note "FAIL -- $violations violation(s) across ${#SENDABLE[@]} reports"
exit 1
