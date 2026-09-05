#!/usr/bin/env bash
# ===========================================================================
# tog-1072-pin-filing-conformance-gate.sh -- does every `pinned` line name
# bytes that are actually FILABLE?
#
# THE DEFECT THIS EXISTS FOR
#
# `upstream_draft_pins.txt` documents its own semantics:
#
#     pinned     the reviewed bytes.  This is what a grant may name.
#
# On 2026-09-05 the two `pinned` lines for the discord report named sha256
# 72879187...f806b32 -- the PRE-REMEDIATION blob. Scored by the filing gate
# that revision carries seven violations: two banned `TOG-676` ids, a leaked
# production run uuid, three lines naming all four tenants on this host, and
# an unbacked source read. A disclosure grant reading `main` would have named
# those bytes and authorized their publication.
#
# WHY THE EXISTING TWO GATES BOTH READ GREEN ON IT
#
# They check the two other properties, and between them they look like
# complete coverage:
#
#   upstream_draft_pin_audit.sh   does the digest still match the ref?
#                                 YES -- the stale branch genuinely still
#                                 holds the stale bytes, so it reports OK.
#   upstream-bundle-filing-gate   are the WORKING TREE / GATE_REF docs clean?
#                                 It scores whatever ref you hand it. Nothing
#                                 made it score the ref a PIN names.
#
# Pin drift and pin staleness-of-intent are different properties. The audit
# proves the pin still points where it did; it cannot notice that where it
# points stopped being the reviewed revision. This gate closes the seam by
# joining the two files that were never joined: for each `pinned` line, it
# scores THE PINNED REF with the filing gate.
#
# THE JOIN IS THE WHOLE POINT -- so it is verified, not assumed:
#   * a pinned line whose ref cannot be read is a FAILURE, never a skip
#     (a skip is how the 2026-08-30 fail-open hashed a missing file as a
#     value; an artifact that cannot be read is not an artifact that passed)
#   * the digest is re-derived from the ref and must equal the pin before the
#     content is scored, so this gate cannot pass a pin that has ALSO drifted
#   * SENDABLE is parsed out of the filing gate rather than restated here.
#     A hardcoded copy would silently stop covering a report the day someone
#     adds one to the bundle -- the exact rot class this workstream keeps
#     hitting. If the parse yields nothing, that is a hard error, not zero
#     checks passing.
#
# SCOPE, AND THE HOLE THAT SCOPING OPENED
#
# Only pinned paths the filing gate gates can be scored. The working notes
# (process-tree-reaping, checkout-policy, actor-runid-provenance) are declared
# do-not-sends and may keep internal ids; README.md is the local index and does
# not ship. Those are legitimately out of scope.
#
# But "out of scope" must be DECLARED, never inferred from absence. The first
# revision of this gate skipped any pinned path missing from SENDABLE, and on
# the very defect it was written for it printed:
#
#     skip  origin/tog-676-upstream-report:docs/upstream/discord-...
#           not in the filing gate's SENDABLE list
#
# The discord report is a SHIPPING report. It was absent from SENDABLE only
# because the gate entry for it lives on a branch that never reached `main`.
# So the one pin this gate exists to catch bought total exemption by being
# unlisted -- a gate that answers "is it listed?" when the question is "is it
# filable?". Exactly the failure it was built to close, one level up.
#
# So exemption is now an explicit allowlist, DO_NOT_SEND below. A pinned
# `docs/upstream/*` path that is in neither SENDABLE nor DO_NOT_SEND is a
# FAILURE: an unclassified pinned report is one nobody has decided about, and
# the safe default for "may a grant name these bytes?" is no.
#
# THE OTHER JOIN DIRECTION (TOG-1086)
#
# Everything above iterates `pinned` lines. That answers "is every pin
# filable?" -- and it is structurally incapable of answering "is every
# filable report pinned?", because a report with NO pin line is not a weak
# input to that loop, it is not an input at all.
#
# Measured on main 2026-09-05: `omniroute-truncated-reasoning-false-502` is in
# SENDABLE, is on origin/main, and is report 9 of the bundle TOG-1027 asks the
# owner to approve -- with zero pin lines, in any state, at any ref. Both pin
# gates read green on it. Deleting a DIFFERENT sendable report's pin line made
# this gate report FEWER violations (6 dirty -> 5 dirty): the score improves
# when the evidence is removed, which is the signature of a list-driven gate
# that cannot see an absent entry.
#
# That matters because `upstream_draft_pins.txt` says `pinned` is "the
# reviewed bytes. This is what a grant may name," and TOG-1027 requires an
# approval to bind to pinned commit and blob shas, NOT to paths. A report with
# no pin gives an approval nothing to name: it either binds by path (the thing
# TOG-1027 forbids) or omits the report while reading as complete.
#
# So the loop below runs the other way: for each SENDABLE report PRESENT at
# the ref under audit, there must be a `pinned` line naming that report AT
# THAT REF. An unpinned sendable report FAILS -- it is never a skip, for the
# same reason an unclassified pin is a failure above.
#
# Scoped to reports present at the audit ref on purpose. A SENDABLE report
# that does not exist at that ref (today: the discord report, pinned on its
# remediation branch and not yet on main) is not a gap in main's pin coverage,
# and failing it here would be a kill for the wrong reason.
#
# USAGE
#   verification/tog-1072-pin-filing-conformance-gate.sh
#   UPSTREAM_DRAFT_PINS=/path/to/pins.txt  ...   (score a different pin file)
#   PIN_AUDIT_REF=origin/main                    (ref the reverse loop audits)
#   PIN_GATE_STRICT=1                            (see below)
#
# EXIT 0 = every gated pinned line names filable bytes, and every sendable
#          report at the audit ref has a pin there.
# EXIT 1 = a pinned line names bytes the filing gate scores dirty, OR a
#          sendable report at the audit ref has no pin.
# EXIT 2 = the gate could not run (missing input, unparseable SENDABLE,
#          or an argument -- this gate takes none; see below).
#
# PIN_GATE_STRICT=1 additionally fails on pins whose ref is unreadable even
# when the path is not gated. Default is off so a pruned branch in a
# do-not-send line does not mask a real filing regression.
# ===========================================================================
set -uo pipefail

# --- arguments: there are none, and pretending otherwise is a fail-open ------
# This gate is configured ENTIRELY by environment variable (UPSTREAM_DRAFT_PINS,
# FILING_GATE, PIN_AUDIT_REF, PIN_GATE_STRICT). It has never taken a flag.
#
# Before this check it also never REJECTED one. `... --pins /path/to/other.txt`
# ran to completion, silently scoring the REPO'S OWN pin file, and printed a
# full, real-looking pass/fail report for a file the caller never named. That
# is the wrong-ref reading in gate form: the operator believes they measured
# the ported file, the gate measured `main`, and both numbers are true of
# something. TOG-1083 was opened because exactly that confusion -- a real grep
# scored against the wrong ref -- closed a card whose criterion was still false.
#
# So an unrecognised argument is a hard error, the same treatment M5 already
# gives an empty SENDABLE parse: refuse to report a number rather than report
# one that answers a question nobody asked.
if [ "$#" -gt 0 ]; then
  echo "FATAL: this gate takes no arguments; got: $*" >&2
  echo "       It is configured by environment variable only. There is no" >&2
  echo "       --pins flag -- accepting one silently scored the repo's own" >&2
  echo "       pin file and reported it as the caller's. Use:" >&2
  echo "         UPSTREAM_DRAFT_PINS=/path/to/pins.txt $0" >&2
  echo "         PIN_AUDIT_REF=<ref>  FILING_GATE=<path>  PIN_GATE_STRICT=1" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

PINS="${UPSTREAM_DRAFT_PINS:-$REPO_ROOT/upstream_draft_pins.txt}"
GATE="${FILING_GATE:-$REPO_ROOT/verification/upstream-bundle-filing-gate.sh}"
STRICT="${PIN_GATE_STRICT:-0}"
# The ref the reverse loop audits for pin COVERAGE. Every sendable report that
# exists here must have a `pinned` line naming it at this ref.
AUDIT_REF="${PIN_AUDIT_REF:-origin/main}"

[ -f "$PINS" ] || { echo "FATAL: no pins file at $PINS" >&2; exit 2; }
[ -f "$GATE" ] || { echo "FATAL: no filing gate at $GATE" >&2; exit 2; }

# --- what the filing gate covers -------------------------------------------
# Parsed from the gate's SENDABLE array. Restating the list here would let the
# two drift apart on green.
SENDABLE="$(awk '
  /^SENDABLE=\(/ { inarr = 1; next }
  inarr && /^\)/  { inarr = 0 }
  inarr           { gsub(/[ \t]/, "", $0); if ($0 != "" && $0 !~ /^#/) print }
' "$GATE")"

if [ -z "$SENDABLE" ]; then
  echo "FATAL: parsed an EMPTY SENDABLE list out of $GATE." >&2
  echo "       Every pin would score as 'not gated' and this gate would pass" >&2
  echo "       while checking nothing. Refusing to report a vacuous green." >&2
  exit 2
fi

is_gated() {
  local want="$1" n
  while IFS= read -r n; do
    [ "$n" = "$want" ] && return 0
  done <<< "$SENDABLE"
  return 1
}

# Explicitly declared do-not-sends and non-shipping files. This list is
# deliberately literal and short: exemption from a disclosure check is a
# decision someone made, and it should cost an edit here to claim one.
# `README.md` is the local index; the three working notes are the
# do-not-sends named in the filing gate's own scope note.
DO_NOT_SEND='README actor-runid-provenance checkout-policy process-tree-reaping'

is_declared_exempt() {
  local want="$1" n
  for n in $DO_NOT_SEND; do
    [ "$n" = "$want" ] && return 0
  done
  return 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tog1072.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Where per-ref filing-gate results are cached. Defaults to this run's temp
# dir, so a normal invocation caches nothing across runs and cannot serve a
# stale answer. PIN_GATE_CACHE_DIR lets a caller (the mutation suite, which
# re-runs this gate seven times over the same refs) share one cache and turn
# ~20s per run into ~20s per suite.
#
# The cache key includes a digest of the FILING GATE ITSELF, so editing the
# gate invalidates every entry. Keying on the ref alone would let the mutation
# suite's anchoring control -- which deliberately swaps in a different filing
# gate -- read the real gate's cached verdict and score a false pass.
CACHE_DIR="${PIN_GATE_CACHE_DIR:-$WORK}"
mkdir -p "$CACHE_DIR" 2>/dev/null || CACHE_DIR="$WORK"
GATE_ID="$(sha256sum < "$GATE" | cut -c1-16)"

pass=0; fail=0; skip=0; seen=0

ok()   { printf '  \033[32mOK   \033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mDIRTY\033[0m %s\n' "$1"; fail=$((fail+1)); }
note() { printf '        %s\n' "$1"; }

printf '\033[1mTOG-1072 pin/filing conformance gate\033[0m\n'
printf '  pins:  %s\n' "$PINS"
printf '  gate:  %s\n' "$GATE"
printf '  gated: %s\n\n' "$(printf '%s\n' "$SENDABLE" | tr '\n' ' ')"

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    pinned[[:space:]]*) : ;;
    *) continue ;;
  esac
  # shellcheck disable=SC2086
  set -- $line
  want="$2"; target="$3"
  ref="${target%%:*}"; path="${target#*:}"
  name="$(basename "$path" .md)"
  seen=$((seen+1))

  if ! is_gated "$name"; then
    if is_declared_exempt "$name"; then
      printf '  \033[90mskip \033[0m %s\n' "$target"
      note "declared do-not-send / non-shipping -- exempt by name, not by omission"
      skip=$((skip+1))
      if [ "$STRICT" = 1 ] && ! git rev-parse --verify -q "$ref" >/dev/null 2>&1; then
        bad "$target"
        note "PIN_GATE_STRICT: ref does not exist -- $ref"
      fi
    else
      # Unclassified. Not exempt, and the filing gate cannot score it because
      # it is not in SENDABLE. This is the discord-report case: a shipping
      # report that silently escaped every check by being unlisted.
      bad "$target"
      note "UNCLASSIFIED pinned report -- in neither the filing gate's SENDABLE"
      note "list nor the declared do-not-send list, so NOTHING scores these bytes."
      note "A grant may name this digest. Either add '$name' to SENDABLE in the"
      note "filing gate, or declare it in DO_NOT_SEND here with a reason."
    fi
    continue
  fi

  # The ref must be readable. An unreadable pinned artifact is a failure, not
  # a skip: a grant can still name this digest.
  if ! git rev-parse --verify -q "$ref" >/dev/null 2>&1; then
    bad "$target"
    note "ref does not exist: $ref -- a grant may still name this digest"
    continue
  fi
  if ! git cat-file -e "$ref:$path" 2>/dev/null; then
    bad "$target"
    note "path not present at $ref"
    continue
  fi
  if ! git show "$ref:$path" > "$WORK/blob" 2>/dev/null; then
    bad "$target"; note "git show failed for $ref:$path"; continue
  fi
  [ -s "$WORK/blob" ] || { bad "$target"; note "blob is EMPTY"; continue; }

  # Re-derive the digest. If the pin has ALSO drifted, say so here rather than
  # scoring content the pin does not actually name.
  got="$(sha256sum < "$WORK/blob" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    bad "$target"
    note "pin does not match the ref -- pinned $want, actual $got"
    note "scoring skipped: these are not the bytes the pin names"
    continue
  fi

  # The join: score THE PINNED REF with the filing gate, and read out only
  # this report's section.
  #
  # Cached per ref. The filing gate rebuilds a `find`-based source index on
  # every invocation, which dominates its runtime; scoring one ref once and
  # slicing per report took this gate from a 2-minute timeout to seconds.
  # Keyed on the ref alone because that is the gate's only input -- same ref,
  # same whole-bundle output, and each report's section is read out of it.
  cache="$CACHE_DIR/gate.$GATE_ID.$(printf '%s' "$ref" | tr -c 'A-Za-z0-9' '_')"
  if [ ! -f "$cache" ]; then
    GATE_REF="$ref" "$GATE" > "$cache" 2>&1
  fi
  # The section ends at the BLANK LINE the filing gate prints after each
  # report, not merely at the next unindented line.
  #
  # Terminating only on `/^[^ ]/` was wrong, and wrong in a way that was
  # invisible until the numbers were checked by hand. The filing gate's
  # trailing summary -- `  FAIL  gated 5 of 8 reports -- the rest were
  # unreadable` and its total -- is INDENTED, and a blank line does not match
  # `^[^ ]`. So the summary fell inside whichever report happens to be LAST in
  # SENDABLE. Measured on the pre-remediation discord pin: the card's seven
  # violations were reported as eight, the extra one being a bundle-level
  # count that belongs to no report.
  #
  # Over-counting is the benign half. The other half is a FALSE DIRTY: a
  # clean report that sits last in SENDABLE would inherit any bundle-level
  # FAIL -- e.g. a DIFFERENT report being unreadable -- and this gate would
  # report that a grant naming its digest authorizes a violation it does not
  # contain. Pinned by the `last-in-SENDABLE` control in the mutation suite.
  report="$(awk -v n="$name.md" '
    $0 == n                          { p = 1; next }
    p && (/^[^ ]/ || /^[[:space:]]*$/) { p = 0 }
    p
  ' "$cache")"

  if [ -z "$report" ]; then
    bad "$target"
    note "the filing gate produced no section for $name.md -- it did not score"
    note "the pinned bytes at all, so this pin is unverified"
    continue
  fi

  hits="$(printf '%s\n' "$report" | grep -c 'FAIL')"
  if [ "$hits" -gt 0 ]; then
    bad "$target"
    note "the filing gate scores these pinned bytes DIRTY ($hits violation(s)):"
    printf '%s\n' "$report" | grep 'FAIL' | sed 's/^ */          /'
    note "a disclosure grant naming this digest would authorize the above"
  else
    ok "$target"
  fi
done < "$PINS"

printf '\n  %d pinned line(s): %d filable, %d dirty, %d not gated\n' \
  "$seen" "$pass" "$fail" "$skip"

# --- the reverse loop: is every SENDABLE report actually pinned? ------------
#
# Driven by SENDABLE, not by the pin file, so a report with no pin line is an
# INPUT here rather than an absence nothing iterates. See the header.
unpinned=0
covered=0
absent=0

printf '\n\033[1m  pin coverage of SENDABLE at %s\033[0m\n' "$AUDIT_REF"

if ! git rev-parse --verify -q "$AUDIT_REF" >/dev/null 2>&1; then
  # Never a silent skip. If the audit ref is unreadable the coverage question
  # was not asked, and a green that omits it would overstate what ran.
  echo "  FATAL: audit ref '$AUDIT_REF' does not exist -- pin coverage was not" >&2
  echo "         checked. Set PIN_AUDIT_REF, or fetch the ref. Refusing to" >&2
  echo "         report a green that silently skipped half this gate." >&2
  exit 2
fi

while IFS= read -r name; do
  [ -n "$name" ] || continue
  path="docs/upstream/$name.md"

  # Only reports that EXIST at the audit ref are in scope. One that does not
  # (the discord report, pinned on its remediation branch) is not a hole in
  # this ref's coverage.
  if ! git cat-file -e "$AUDIT_REF:$path" 2>/dev/null; then
    printf '  \033[90mn/a  \033[0m %s\n' "$name"
    note "not present at $AUDIT_REF -- not this ref's to pin"
    absent=$((absent+1))
    continue
  fi

  # Is there a `pinned` line naming this path AT THIS REF? Matching the ref
  # too, not just the path: a pin naming these bytes on some other branch does
  # not tell a grant reading this ref what to bind to.
  #
  # The ref and path are interpolated into a regex, so their `.` and `/` are
  # escaped first. Unescaped, `502.md` would also match `502xmd` -- a wrong
  # match here would report a report as pinned when it is not, which is the
  # exact false green this loop exists to prevent.
  target_re="$(printf '%s:%s' "$AUDIT_REF" "$path" | sed 's/[][\.^$*+?(){}|\/]/\\&/g')"
  if grep -qE "^pinned[[:space:]]+[0-9a-f]{64}[[:space:]]+$target_re[[:space:]]*$" "$PINS"; then
    printf '  \033[32mPIN  \033[0m %s\n' "$name"
    covered=$((covered+1))
  else
    printf '  \033[31mNOPIN\033[0m %s\n' "$name"
    note "SENDABLE report present at $AUDIT_REF with NO pinned line for that ref."
    note "\`pinned\` is 'the reviewed bytes -- what a grant may name'. With none,"
    note "an approval covering this bundle binds this report BY PATH or omits it"
    note "while reading as complete. Add a pinned line for $AUDIT_REF:$path."
    unpinned=$((unpinned+1))
  fi
done <<< "$SENDABLE"

printf '\n  %d sendable report(s) at %s: %d pinned, %d UNPINNED (%d not at this ref)\n' \
  "$((covered+unpinned))" "$AUDIT_REF" "$covered" "$unpinned" "$absent"

# The reverse loop must have had something to check. If every sendable report
# were absent from the audit ref, "0 unpinned" would mean nothing was asked.
if [ "$((covered+unpinned))" = 0 ]; then
  echo "  FATAL: no SENDABLE report exists at $AUDIT_REF -- pin coverage checked" >&2
  echo "         NOTHING. A green here would mean only that the ref is empty." >&2
  exit 2
fi

# A run that scored nothing must never read as green -- that is the failure
# mode the whole upstream-pin workstream exists to prevent.
if [ "$seen" = 0 ]; then
  echo "  FATAL: the pins file contains no pinned lines -- nothing was checked." >&2
  exit 2
fi
if [ "$pass" = 0 ] && [ "$fail" = 0 ]; then
  echo "  FATAL: every pinned line was skipped -- this gate checked NOTHING." >&2
  echo "         A green here would mean only that no pin is gated." >&2
  exit 2
fi

if [ "$fail" = 0 ] && [ "$unpinned" = 0 ]; then
  printf '\nPASS -- every gated pin names filable bytes, and every sendable report\n'
  printf '        at %s has a pin there\n' "$AUDIT_REF"
  exit 0
fi

# Both directions are reported, so a run that trips both does not hide one.
[ "$fail" -gt 0 ] && \
  printf '\nFAIL -- %d pinned line(s) name bytes that are not filable\n' "$fail"
[ "$unpinned" -gt 0 ] && \
  printf '\nFAIL -- %d SENDABLE report(s) at %s have NO pinned line\n' \
    "$unpinned" "$AUDIT_REF"
exit 1
