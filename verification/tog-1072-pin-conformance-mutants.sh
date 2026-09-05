#!/usr/bin/env bash
# ===========================================================================
# tog-1072-pin-conformance-mutants.sh -- mutation evidence for
# verification/tog-1072-pin-filing-conformance-gate.sh
#
# The gate under test answers: does every `pinned` line in
# upstream_draft_pins.txt name bytes the filing gate scores CLEAN?
#
# A PASS on a good pin file proves nothing on its own -- it is the same PASS a
# gate that had stopped reading the pin file would print. So each mutant
# re-introduces one defect and asserts the gate moves rc 0 -> rc 1 AND names
# the expected reason.
#
# WHY REASON-MATCHING IS NOT OPTIONAL HERE. A mutant that trips the gate for
# the wrong reason scores as a kill while proving nothing. This suite's own
# development produced one: M4 (a drifted pin) originally asserted only rc=1,
# and it passed against a build that reported "ref does not exist" -- a
# refusal, not a detection of drift. Every kill below is bound to its message.
#
# THE BASELINE IS A REAL ARM, NOT A FORMALITY. The gate must be GREEN on a
# clean pin file before any mutant is scored. If the baseline is red, every
# "kill" is the gate refusing all input and the run is meaningless. The clean
# fixture is built from the remediation ref, where the filing gate PASSes 7/7.
#
#   verification/tog-1072-pin-conformance-mutants.sh
# ===========================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

GATE="verification/tog-1072-pin-filing-conformance-gate.sh"
FILING="verification/upstream-bundle-filing-gate.sh"

for f in "$GATE" "$FILING"; do
  [ -x "$f" ] || { echo "FAIL -- missing or non-executable $f"; exit 2; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PINS="$WORK/pins.txt"
CLEAN="$WORK/clean.txt"

# --- fixtures are BUILT, not borrowed from remote branches -----------------
#
# The first version of this suite pinned its fixtures to two real refs
# (origin/docs/discord-proactive-job-scope-remediation for the clean arm,
# origin/tog-676-upstream-report for the dirty one). That was measured wrong
# before it shipped: `actions/checkout@v4` clones --depth=1 --single-branch,
# so NEITHER ref exists in CI. Reproduced against a faithful shallow clone,
# the suite exited 2 with "clean fixture ref does not exist" -- it would have
# been a permanently red step that never once scored a mutant, which is the
# unregistered-suite failure wearing a green checkmark's clothes.
#
# The fixtures are also not the point. What is under test is the GATE's
# decision procedure -- does it fail a pin whose bytes the filing gate scores
# dirty -- not any particular report's contents. So the suite writes its own
# docs into a scratch git repo and pins those. Self-contained, runs anywhere,
# and no longer coupled to where the bundle's remediation happens to live.
FIX="$WORK/fixture-repo"
mkdir -p "$FIX/docs/upstream" "$FIX/verification"
git -C "$FIX" init -q
git -C "$FIX" config user.email ci@local
git -C "$FIX" config user.name ci

# A clean report: nothing the filing gate objects to.
cat > "$FIX/docs/upstream/agent-run-credential-isolation.md" <<'CLEANDOC'
# Credential isolation between concurrent runs

**Status:** DRAFT -- not filed.

---

## Summary

A run's gateway credential is readable by any process sharing its uid, so two
concurrently authenticated sessions are not two independent principals.

## Impact

An organizational control stands in for a technical boundary.
CLEANDOC

# A SECOND clean sendable report. Two of them, because M6 (TOG-1086) removes
# one report's pin line and the suite must still be measuring the COVERAGE
# failure. With only one pinned sendable doc, removing its pin would empty the
# gate's forward loop and trip the "every pinned line was skipped" hard error
# first -- rc=2 for a different reason, a kill that proves nothing.
cat > "$FIX/docs/upstream/interaction-comment-supersession-default.md" <<'CLEAN2DOC'
# Interaction supersession defaults to on

**Status:** DRAFT -- not filed.

---

## Summary

An interaction is cancelled by an owner comment unless the creator opts out,
so a reply to a question silently cancels the question.

## Impact

Two thirds of questions raised were resolved without an answer.
CLEAN2DOC

# A dirty report: one banned internal id, one uuid-shaped host identifier.
# Both are checks the filing gate already had before this card.
cat > "$WORK/dirty-doc.md" <<'DIRTYDOC'
# Manifest refresh escalation

**Status:** DRAFT -- not filed.  Tracked internally as TOG-318.

---

## Summary

Production row: run `748c6532-09cb-4636-95e3-2c1d48cc2edf` refreshed twice.
DIRTYDOC

# A shipping-looking report that is in NEITHER the filing gate's SENDABLE nor
# the conformance gate's DO_NOT_SEND. This is the discord report's exact
# position on main, and M2 pins it. It must exist at the fixture ref, or M2
# would fail as "path not present" -- a kill for the wrong reason.
cat > "$WORK/unclass-doc.md" <<'UNCLASSDOC'
# An upstream report nobody classified

**Status:** DRAFT -- not filed.

---

## Summary

Nothing lists this file, so nothing scores it.
UNCLASSDOC

cp "$FILING" "$FIX/verification/"
cp "$GATE" "$FIX/verification/"

# --- the fixture is TWO commits, and the split is load-bearing -------------
#
# The reverse (coverage) loop added for TOG-1086 audits a NAMED ref: every
# sendable report present THERE must have a pin naming it at that ref. So the
# audit ref must contain exactly the reports the baseline pin file covers.
#
# `manifest-refresh-escalation` (the dirty doc) is in SENDABLE, so if it sat
# at the audit ref the baseline would go red as NOPIN -- and pinning it to fix
# that would trip the forward loop, which is M1's entire subject. It cannot be
# both the dirty-content fixture and a covered report.
#
# So: commit 1 (`fixture-main`) holds only the two CLEAN sendable docs and is
# what the coverage loop audits. Commit 2 (`FIX_REF`) adds the dirty and
# unclassified docs, and is what the forward-loop arms pin. Each loop gets a
# ref shaped for the question it asks.
git -C "$FIX" add -A
git -C "$FIX" commit -qm 'fixture bundle: clean sendable reports'
git -C "$FIX" branch -f fixture-main HEAD
AUDIT_REF="fixture-main"

mv "$WORK/dirty-doc.md"  "$FIX/docs/upstream/manifest-refresh-escalation.md"
mv "$WORK/unclass-doc.md" "$FIX/docs/upstream/not-in-sendable.md"
git -C "$FIX" add -A
git -C "$FIX" commit -qm 'fixture bundle: add dirty + unclassified reports'
FIX_REF="$(git -C "$FIX" rev-parse HEAD)"

# Sanity-check the fixtures actually have the properties the arms below need.
# A fixture that silently stopped being dirty would turn M1 into a false pass.
( cd "$FIX" && GATE_REF="$FIX_REF" ./verification/upstream-bundle-filing-gate.sh \
    > "$WORK/fixcheck.txt" 2>&1 )
if ! awk '$0=="agent-run-credential-isolation.md"{p=1;next} p&&/^[^ ]/{p=0} p' \
     "$WORK/fixcheck.txt" | grep -q '  ok'; then
  echo "FAIL -- the CLEAN fixture does not score clean; arms would be meaningless"
  sed -n '1,40p' "$WORK/fixcheck.txt"; exit 2
fi
if ! awk '$0=="manifest-refresh-escalation.md"{p=1;next} p&&/^[^ ]/{p=0} p' \
     "$WORK/fixcheck.txt" | grep -q 'FAIL'; then
  echo "FAIL -- the DIRTY fixture does not score dirty; M1 would be a false pass"
  sed -n '1,40p' "$WORK/fixcheck.txt"; exit 2
fi
if ! awk '$0=="interaction-comment-supersession-default.md"{p=1;next} p&&/^[^ ]/{p=0} p' \
     "$WORK/fixcheck.txt" | grep -q '  ok'; then
  echo "FAIL -- the SECOND clean fixture does not score clean; M6 would be a"
  echo "        kill for the wrong reason (forward loop, not coverage)"
  sed -n '1,40p' "$WORK/fixcheck.txt"; exit 2
fi
# The two clean docs must be the ONLY sendable reports at the audit ref, or
# the baseline coverage loop goes red on a report the pin file never covers.
audit_sendable="$(git -C "$FIX" ls-tree --name-only "$AUDIT_REF" docs/upstream/ | wc -l)"
if [ "$audit_sendable" -ne 2 ]; then
  echo "FAIL -- expected exactly 2 reports at $AUDIT_REF, found $audit_sendable."
  echo "        The baseline's coverage arm would not be measuring what it claims."
  git -C "$FIX" ls-tree --name-only "$AUDIT_REF" docs/upstream/; exit 2
fi
echo "fixtures: clean docs score clean, dirty doc scores dirty (self-contained repo)"

fixsha() { git -C "$FIX" show "${2:-$FIX_REF}:docs/upstream/$1.md" | sha256sum | cut -d' ' -f1; }

# --- the clean pin file ----------------------------------------------------
# Both clean sendable docs, pinned at the AUDIT REF. Pinning them there rather
# than at FIX_REF is what makes the baseline green in both directions: the
# forward loop scores the bytes, and the coverage loop finds a pin for every
# sendable report present at the ref it audits. (The blobs are identical at
# both commits -- commit 2 only ADDS files -- so the forward loop scores the
# same content either way.)
{
  echo "# fixture pin file for the TOG-1072 mutation suite"
  printf 'pinned  %s  %s:docs/upstream/agent-run-credential-isolation.md\n' \
    "$(fixsha agent-run-credential-isolation "$AUDIT_REF")" "$AUDIT_REF"
  printf 'pinned  %s  %s:docs/upstream/interaction-comment-supersession-default.md\n' \
    "$(fixsha interaction-comment-supersession-default "$AUDIT_REF")" "$AUDIT_REF"
} > "$CLEAN"

pinned_count="$(grep -c '^pinned' "$CLEAN")"
echo "fixture: $pinned_count pinned line(s) at the fixture commit"

caught=0; missed=0
arg_ok=0

# Share one filing-gate result cache across every arm below. The filing gate
# rebuilds a `find` index per invocation, which dominates runtime; this suite
# runs the gate under test eight times. The cache key includes a digest of the
# filing gate, so the anchoring control -- which swaps in a different one --
# still gets a cold score rather than the real gate's cached verdict.
export PIN_GATE_CACHE_DIR="$WORK/cache"
mkdir -p "$PIN_GATE_CACHE_DIR"

# Every arm runs the gate INSIDE the fixture repo, against the fixture's copy
# of the filing gate. Both scripts resolve REPO_ROOT from their own location,
# so running the real tree's copies here would score the real bundle instead.
# ANSI colour is stripped from the captured output before any arm matches on
# it. The gate prints its per-report verdicts as `\033[31mNOPIN\033[0m name`,
# so a reset sequence sits between the label and the report name and a literal
# "NOPIN <name>" never matches the raw bytes. M6 scored WRONG-REASON on
# exactly that before this was added -- the gate was correct and the assertion
# was matching the wrong string.
run_gate() {
  local rc
  ( cd "$FIX" && UPSTREAM_DRAFT_PINS="$PINS" PIN_GATE_CACHE_DIR="$PIN_GATE_CACHE_DIR" \
      PIN_AUDIT_REF="$AUDIT_REF" "./$GATE" ) > "$WORK/out.raw" 2>&1
  rc=$?
  sed -e 's/\x1b\[[0-9;]*m//g' "$WORK/out.raw" > "$WORK/out.txt"
  echo $rc
}

# --- baseline --------------------------------------------------------------
cp "$CLEAN" "$PINS"
base_rc="$(run_gate)"
if [ "$base_rc" -ne 0 ]; then
  echo "FAIL -- baseline is NOT green (rc=$base_rc). Mutants cannot be scored:"
  echo "        a gate that refuses everything would score 100% kills."
  grep -E 'DIRTY|FATAL' "$WORK/out.txt" | head
  exit 1
fi
# The baseline must also have actually CHECKED something.
if ! grep -qE "$pinned_count pinned line\(s\): $pinned_count filable" "$WORK/out.txt"; then
  echo "FAIL -- baseline is green but did not score all $pinned_count pins:"
  grep 'pinned line(s)' "$WORK/out.txt"
  exit 1
fi
# The baseline must also have run the COVERAGE loop and found full coverage.
# Without this assertion a build whose reverse loop silently checked nothing
# would still show a green baseline, and M6 below would be the only thing
# standing between that and a false pass.
if ! grep -qE '2 sendable report\(s\) at .*: 2 pinned, 0 UNPINNED' "$WORK/out.txt"; then
  echo "FAIL -- baseline is green but did not report full pin coverage:"
  grep -E 'sendable report|UNPINNED' "$WORK/out.txt" || echo "        (no coverage line at all)"
  exit 1
fi
echo "baseline: PASS, $pinned_count/$pinned_count pins scored filable,"
echo "          2/2 sendable reports at $AUDIT_REF pinned (rc=0)"
echo ""

# mutate <name> <expected-substring> <mutation-fn>
mutate() {
  local name="$1" want="$2" fn="$3" rc
  cp "$CLEAN" "$PINS"
  "$fn" "$PINS"
  if cmp -s "$CLEAN" "$PINS"; then
    echo "  MISSED  $name -- the mutation edited nothing (anchor drifted)"
    missed=$((missed + 1)); return
  fi
  rc="$(run_gate)"
  if [ "$rc" -eq 0 ]; then
    echo "  SURVIVED  $name -- gate still rc=0"
    missed=$((missed + 1)); return
  fi
  if ! grep -qF "$want" "$WORK/out.txt"; then
    echo "  WRONG-REASON  $name -- rc=$rc but never said: $want"
    echo "                got: $(grep -m2 -E 'DIRTY|FATAL|UNCLASSIFIED' "$WORK/out.txt" | tr '\n' ' ')"
    missed=$((missed + 1)); return
  fi
  echo "  killed  $name (rc=$rc, reason matched)"
  caught=$((caught + 1))
}

# M1 -- THE CARD'S DEFECT. Add a pinned line naming the DIRTY fixture doc.
# Its digest and ref agree, so the pin AUDIT stays green -- exactly how the
# real defect survived two gates -- but the bytes carry filing violations.
m1() {
  printf 'pinned  %s  %s:docs/upstream/manifest-refresh-escalation.md\n' \
    "$(fixsha manifest-refresh-escalation)" "$FIX_REF" >> "$1"
}
mutate "M1 pin names bytes the filing gate scores dirty" \
  "the filing gate scores these pinned bytes DIRTY" m1

# M2 -- the discord case: a shipping report pinned but absent from SENDABLE.
# Must fail as UNCLASSIFIED, not be skipped into silence. `not-in-sendable`
# is a name the fixture's filing gate does not list and DO_NOT_SEND does not
# declare, which is precisely the discord report's position on main.
m2() {
  printf 'pinned  %s  %s:docs/upstream/not-in-sendable.md\n' \
    "$(fixsha not-in-sendable)" "$FIX_REF" >> "$1"
}
mutate "M2 unclassified pinned report is not silently skipped" \
  "UNCLASSIFIED pinned report" m2

# M3 -- an unreadable ref must FAIL, never skip. A missing artifact scoring as
# a pass is the exact 2026-08-30 fail-open this workstream exists for.
#
# The substituted ref is a NAME, not a 40-hex string. First cut used
# `deadbeef...deadbeef` and this arm scored a WRONG-REASON: `git rev-parse
# --verify` returns 0 for any well-formed 40-hex, echoing it back without
# resolving it to an object, so the gate got past the ref check and failed at
# `cat-file -e` with "path not present" instead. Same rc, different check --
# the arm would have claimed to pin the ref-existence branch while never
# reaching it.
# The anchor is $AUDIT_REF because that is what the pin lines name. It was
# $FIX_REF until the fixture split, and this arm went MISSED ("the mutation
# edited nothing") the moment the pins moved -- a drifted anchor, caught only
# because `mutate` refuses a no-op edit rather than scoring it as a kill.
m3() { sed -i "s|^pinned\(.*\)$AUDIT_REF:|pinned\1refs/heads/no-such-ref-tog1072:|" "$1"; }
mutate "M3 unreadable pinned ref fails rather than skipping" \
  "ref does not exist" m3

# M4 -- a drifted digest must be reported as drift, and the content must NOT
# be scored: passing content the pin does not name would be a false green.
m4() { sed -i '0,/^pinned  [0-9a-f]\{64\}/s//pinned  00000000000000000000000000000000000000000000000000000000deadbeef/' "$1"; }
mutate "M4 drifted pin is caught as drift, not scored as content" \
  "pin does not match the ref" m4

# M5 -- a pin file with no pinned lines must be a hard error. A gate that
# reports success having checked nothing is the failure mode this whole
# workstream is about.
m5() { sed -i 's/^pinned/# pinned/' "$1"; }
mutate "M5 empty pin set is a hard error, not a vacuous pass" \
  "no pinned lines" m5

# M6 -- TOG-1086, THE OTHER JOIN DIRECTION. Remove a sendable report's pin
# line entirely. Before the coverage loop this mutation made the gate report
# FEWER violations -- measured on the real pin file 2026-09-05, deleting the
# plugin-auth-surface line took it from 6 dirty to 5 dirty, rc=1 both times.
# Deleting the evidence improved the score, and rc never moved, so no rc-only
# assertion could have caught it.
#
# The kill is bound to the report's NAME, not merely to rc or to the word
# UNPINNED: the card requires the gate to say WHICH report lost its pin. A
# gate that failed with a bare count would still leave an operator hunting.
#
# Note this arm asserts a kill on a mutation that leaves the OTHER pin intact,
# so the forward loop stays green and rc=1 can only come from coverage.
m6() { sed -i '/interaction-comment-supersession-default/d' "$1"; }
mutate "M6 sendable report with NO pin line is caught, and named" \
  "NOPIN interaction-comment-supersession-default" m6

# M7 -- the coverage loop must audit a REAL ref. Point it at one that does not
# exist: it must refuse (rc=2), never quietly report zero unpinned reports.
# An unreadable audit ref means the coverage question was not asked, and this
# suite's whole premise is that "checked nothing" must not read as "found
# nothing".
cp "$CLEAN" "$PINS"
( cd "$FIX" && UPSTREAM_DRAFT_PINS="$PINS" PIN_GATE_CACHE_DIR="$PIN_GATE_CACHE_DIR" \
    PIN_AUDIT_REF="refs/heads/no-such-audit-ref-tog1086" "./$GATE" ) \
    > "$WORK/m7.txt" 2>&1
m7_rc=$?
if [ "$m7_rc" -eq 2 ] && grep -q "audit ref .* does not exist" "$WORK/m7.txt"; then
  echo "  killed  M7 unreadable audit ref refuses (rc=2) rather than reporting 0 unpinned"
  caught=$((caught + 1))
else
  echo "  MISSED  M7 unreadable audit ref -- expected rc=2 + 'audit ref does not exist', got rc=$m7_rc"
  missed=$((missed + 1))
fi

echo ""

# M8 -- AN UNRECOGNISED ARGUMENT MUST BE A HARD ERROR, NOT A SILENT REBASE
# ONTO THE REPO'S OWN PIN FILE.
#
# This one mutates the INVOCATION, not the pin file, so it does not go through
# mutate(). The gate takes no flags and never has. Before TOG-1083 it also did
# not reject one: `--pins /elsewhere.txt` ran to completion against the repo's
# own upstream_draft_pins.txt and printed a full pass/fail report the caller
# read as being about the file they named. That is the wrong-ref reading in
# gate form, and it is the failure that closed TOG-1083's parent card once
# already -- a real number, scored against a ref nobody asked for.
#
# Kill criteria, all three required:
#   rc=2          (hard error, the M5 treatment -- not a content failure)
#   says so       (names the argument, so the operator can see what was refused)
#   scored NOTHING (no pin tally printed: a refusal that still reports a number
#                   would leave the operator with the wrong-ref reading anyway)
cp "$CLEAN" "$PINS"
( cd "$FIX" && UPSTREAM_DRAFT_PINS="$PINS" PIN_GATE_CACHE_DIR="$PIN_GATE_CACHE_DIR" \
    PIN_AUDIT_REF="$AUDIT_REF" \
    "./$GATE" --pins /nonexistent/tog1072-not-a-real-pin-file.txt ) \
    > "$WORK/argmut.txt" 2>&1
arg_rc=$?
if [ "$arg_rc" -ne 2 ]; then
  echo "  SURVIVED  M8 unrecognised argument is refused (rc=$arg_rc, wanted 2)"
  if grep -q 'pinned line(s):' "$WORK/argmut.txt"; then
    echo "            and it SCORED: $(grep -m1 'pinned line(s):' "$WORK/argmut.txt" | sed 's/^ *//')"
    echo "            -- that tally is about the repo's own pin file, not the"
    echo "               one the caller named."
  fi
  missed=$((missed + 1))
elif ! grep -qF 'takes no arguments' "$WORK/argmut.txt"; then
  echo "  WRONG-REASON  M8 rc=2 but never said the argument was the problem"
  echo "                got: $(grep -m1 FATAL "$WORK/argmut.txt")"
  missed=$((missed + 1))
elif grep -q 'pinned line(s):' "$WORK/argmut.txt"; then
  echo "  WRONG-REASON  M8 refused with rc=2 but still printed a pin tally"
  missed=$((missed + 1))
else
  echo "  killed  M8 unrecognised argument is refused, nothing scored (rc=2, reason matched)"
  caught=$((caught + 1))
fi

# M8's paired control: the SAME invocation with the argument REMOVED must be
# GREEN. Without it, a gate that had simply broken and refused every run would
# score M8 as a kill -- the refusal must be caused by the argument.
( cd "$FIX" && UPSTREAM_DRAFT_PINS="$PINS" PIN_GATE_CACHE_DIR="$PIN_GATE_CACHE_DIR" \
    PIN_AUDIT_REF="$AUDIT_REF" \
    "./$GATE" ) > "$WORK/argctl.txt" 2>&1
argctl_rc=$?
if [ "$argctl_rc" -eq 0 ]; then
  echo "          arg control: the same run WITHOUT the flag is green (rc=0) --"
  echo "                       M8 is the argument, not a gate that refuses all"
  arg_ok=1
else
  echo "          arg control: FAILED -- the flagless run is also non-zero"
  echo "                       (rc=$argctl_rc), so M8's rc=2 proves nothing"
  arg_ok=0
fi

echo ""

# --- negative control ------------------------------------------------------
# A benign rewrite of the pin file that changes bytes without changing meaning
# must stay GREEN. Without this, "any edit trips it" would look like detection.
cp "$CLEAN" "$PINS"
printf '\n# a trailing comment: benign, changes no pin\n' >> "$PINS"
sed -i 's/^pinned  /pinned   /' "$PINS"   # extra space; the parser splits on whitespace
neg_rc="$(run_gate)"
if [ "$neg_rc" -eq 0 ]; then
  echo "negative control: benign rewrite stays GREEN (rc=0) -- the gate reads"
  echo "                  meaning, not bytes"
  neg_ok=1
else
  echo "negative control: FAILED -- a benign rewrite turned the gate red (rc=$neg_rc)."
  echo "                  Every kill above is suspect: the gate may be reacting"
  echo "                  to edits rather than to unfilable pins."
  grep -E 'DIRTY|FATAL' "$WORK/out.txt" | head -3
  neg_ok=0
fi

# --- anchoring control -----------------------------------------------------
# Prove the gate reads the FILING GATE it claims to join, not just the pin
# file. Point it at a filing gate whose SENDABLE is empty: it must refuse
# loudly rather than pass every pin as "not gated".
cp "$CLEAN" "$PINS"
sed '/^SENDABLE=(/,/^)/{ /^SENDABLE=(/!{ /^)/!d } }' "$FILING" > "$FIX/verification/empty-gate.sh"
chmod +x "$FIX/verification/empty-gate.sh"
( cd "$FIX" && UPSTREAM_DRAFT_PINS="$PINS" PIN_GATE_CACHE_DIR="$PIN_GATE_CACHE_DIR" \
    PIN_AUDIT_REF="$AUDIT_REF" \
    FILING_GATE="$FIX/verification/empty-gate.sh" "./$GATE" ) > "$WORK/anchor.txt" 2>&1
anchor_rc=$?
if [ "$anchor_rc" -eq 2 ] && grep -q 'EMPTY SENDABLE' "$WORK/anchor.txt"; then
  echo "anchoring control: a filing gate with no SENDABLE is refused (rc=2) --"
  echo "                   the join is real, not assumed"
  anchor_ok=1
else
  echo "anchoring control: FAILED -- expected rc=2 and 'EMPTY SENDABLE', got rc=$anchor_rc"
  head -3 "$WORK/anchor.txt"
  anchor_ok=0
fi

# --- section-boundary control ----------------------------------------------
# The gate reads each report's verdict by slicing the filing gate's output
# between that report's heading and the end of its section. Prove the slice
# STOPS at the section end, by pinning a clean report that sits LAST in
# SENDABLE while the run also carries a bundle-level FAIL.
#
# This is a control because the gate failed it. The slice originally ended
# only at the next unindented line, and the filing gate's trailing summary
# (`  FAIL  gated 5 of 8 reports ...`) is INDENTED, with a blank line before
# it that `^[^ ]` does not match. So the bundle summary fell inside whichever
# report was last in SENDABLE. Measured on the real pre-remediation discord
# pin, the card's seven violations were reported as eight.
#
# The over-count was the harmless half. This control targets the other half:
# a CLEAN report inheriting another report's failure and being declared
# unfilable. The fixture run always carries a bundle-level FAIL, because most
# of SENDABLE does not exist in the fixture repo ("gated N of 8 reports").
cp "$CLEAN" "$PINS"
awk '
  /^SENDABLE=\(/ { print; inarr = 1; next }
  inarr && /^\)/ { print "  agent-run-credential-isolation"; print; inarr = 0; next }
  inarr && /agent-run-credential-isolation/ { next }
  { print }
' "$FILING" > "$FIX/verification/last-entry-gate.sh"
chmod +x "$FIX/verification/last-entry-gate.sh"
if ! tail -3 "$FIX/verification/last-entry-gate.sh" >/dev/null 2>&1 || \
   ! awk '/^SENDABLE=\(/{i=1;next} i&&/^\)/{print last; exit} i{last=$1}' \
       "$FIX/verification/last-entry-gate.sh" | grep -qx 'agent-run-credential-isolation'; then
  echo "section-boundary control: SETUP FAILED -- the clean doc is not last in"
  echo "                          SENDABLE, so the control would prove nothing"
  bound_ok=0
else
  ( cd "$FIX" && UPSTREAM_DRAFT_PINS="$PINS" PIN_GATE_CACHE_DIR="$PIN_GATE_CACHE_DIR" \
      PIN_AUDIT_REF="$AUDIT_REF" \
      FILING_GATE="$FIX/verification/last-entry-gate.sh" "./$GATE" ) > "$WORK/bound.txt" 2>&1
  bound_rc=$?
  # The run must genuinely carry a bundle-level FAIL, or there is nothing to
  # leak and a green here is vacuous.
  ( cd "$FIX" && GATE_REF="$FIX_REF" ./verification/last-entry-gate.sh ) \
      > "$WORK/bundlecheck.txt" 2>&1
  if ! grep -q 'FAIL  gated .* of .* reports' "$WORK/bundlecheck.txt"; then
    echo "section-boundary control: SETUP FAILED -- no bundle-level FAIL in the"
    echo "                          fixture run, so nothing could leak anyway"
    bound_ok=0
  elif [ "$bound_rc" -eq 0 ] && grep -q 'OK' "$WORK/bound.txt"; then
    echo "section-boundary control: a clean report LAST in SENDABLE still scores"
    echo "                          OK (rc=0) while the run carries a bundle-level"
    echo "                          FAIL -- the slice stops at the section end"
    bound_ok=1
  else
    echo "section-boundary control: FAILED -- a clean report scored DIRTY (rc=$bound_rc)."
    echo "                          The section slice is leaking another report's"
    echo "                          or the bundle summary's FAIL into this one."
    sed -e 's/\x1b\[[0-9;]*m//g' "$WORK/bound.txt" | grep -A3 DIRTY | head -6
    bound_ok=0
  fi
fi

echo ""
echo "mutants: $caught killed, $missed survived/miscounted"

if [ "$missed" -eq 0 ] && [ "$neg_ok" -eq 1 ] && [ "$anchor_ok" -eq 1 ] && [ "$bound_ok" -eq 1 ] && [ "$arg_ok" -eq 1 ]; then
  echo "PASS -- every mutant killed for the right reason; all five controls hold"
  exit 0
fi
echo "FAIL -- the suite did not fully validate the gate"
exit 1
