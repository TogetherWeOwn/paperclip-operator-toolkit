#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for operator_runbook.sh.
# NO DATABASE, NO CREDENTIALS, NO NETWORK — this is what CI runs. One bounded
# exception: section 10 fetches a runbook's pinned commit from `origin` when a
# shallow clone lacks it, and fails loudly if it cannot.
#
# WHAT THIS SUITE IS ACTUALLY FOR
# ---------------------------------------------------------------------------
# The rendering is cosmetic and a broken render is obvious. `check` is not:
# it is the gate that stops a capability-bound ask from quietly joining the
# owner's queue unclassified, and it fails SILENTLY if it is wrong — the
# runbook simply goes stale and nobody learns until the asks expire again.
# So most of this suite is about `check`, and section 6 deletes each half of
# it from a staging copy to prove the test naming that half goes RED.
#
# Section 6 asserts the UNMUTATED copy passes in the same staging directory
# first. "The mutated suite failed" is unattributable without that baseline.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

TOOL="${TOOL_UNDER_TEST:-$HERE/operator_runbook.sh}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [[ -n "${2:-}" ]] && printf '       %s\n' "$2"; }
section() { printf '\n== %s\n' "$1"; }

# A minimal classification + matching input. Deliberately small: the real file
# is data, and a suite that pinned its contents would fail on every edit.
mk_classification() {
  cat > "$1" <<'EOF'
{
  "items": {
    "TOG-A": {"class":"CAPABILITY","blast":4,"credential":"read-only shell","changes":"nothing, it is a read","verify":"paste the output","undo":"n/a"},
    "TOG-B": {"class":"CAPABILITY","blast":1,"credential":"root","changes":"closes a privilege boundary","verify":"run the checker","undo":"one chmod","warning":"do not chown this directory"},
    "TOG-C": {"class":"MIXED","blast":2,"credential":"vendor account","changes":"moves a package and files a report","verify":"gate exits 0","undo":"move it back","reserved_part":"clause 5, outward commitment"},
    "TOG-M": {"class":"CAPABILITY","blast":3,"credential":"board admin","changes":"already a live runbook line","verify":"n/a","undo":"n/a","moved":true}
  },
  "decisions": { "TOG-D": {"clause":"1 - real money","summary":"approve a recurring charge"} },
  "misrouted": { "TOG-E": {"resolver":"any agent","summary":"merge a green PR"} }
}
EOF
}
mk_input() {  # $1=file, remaining args = identifiers to mark board_only
  local f="$1"; shift
  { printf '['
    local first=1
    for id in "$@"; do
      [[ $first -eq 1 ]] || printf ','
      first=0
      printf '{"identifier":"%s","effectiveResolverPolicy":"board_only","kind":"request_confirmation"}' "$id"
    done
    # one non-board_only row, which must be ignored throughout
    [[ $first -eq 1 ]] || printf ','
    printf '{"identifier":"TOG-IGNORED","effectiveResolverPolicy":"board_or_agents","kind":"ask_user_questions"}'
    printf ']'
  } > "$f"
}

CLS="$TMP/cls.json"; mk_classification "$CLS"
# TOG-M is marked moved, so ALIGNED deliberately does NOT contain it.
ALIGNED="$TMP/aligned.json"; mk_input "$ALIGNED" TOG-A TOG-B TOG-C TOG-D TOG-E

# ---------------------------------------------------------------------------
section "1. check — aligned input passes"
out="$("$TOOL" check --classification "$CLS" < "$ALIGNED" 2>&1)"; rc=$?
(( rc == 0 )) && ok "exit 0 when every board_only row is classified" \
              || bad "aligned input should exit 0, got $rc" "$out"
grep -q 'pending board_only: 5' <<<"$out" \
  && ok "counts only board_only rows (the board_or_agents row is excluded)" \
  || bad "expected 'pending board_only: 5'" "$out"
# The moved item is absent from the pending set and that is CORRECT, not stale.
# Without this the gate reports every finished line as stale the day the last
# withdrawal lands, becomes noise, and stops being read.
grep -q 'STALE' <<<"$out" \
  && bad "a moved item absent from pending must NOT be STALE" "$out" \
  || ok "a moved item is expected to be absent from the pending set"
grep -q 'moved to the runbook: 1' <<<"$out" && ok "reports how many lines have moved" \
  || bad "expected 'moved to the runbook: 1'" "$out"

# ---------------------------------------------------------------------------
section "2. check — an unclassified owner-only ask is an ERROR"
UNCL="$TMP/uncl.json"; mk_input "$UNCL" TOG-A TOG-B TOG-C TOG-D TOG-E TOG-NEW
out="$("$TOOL" check --classification "$CLS" < "$UNCL" 2>&1)"; rc=$?
(( rc == 3 )) && ok "exit 3 on an unclassified board_only interaction" \
              || bad "expected exit 3, got $rc" "$out"
# Pin the verdict to the branch that produced it: UNCLASSIFIED, not STALE.
grep -q 'UNCLASSIFIED' <<<"$out" && grep -q 'TOG-NEW' <<<"$out" \
  && ok "names the UNCLASSIFIED branch and the offending identifier" \
  || bad "expected UNCLASSIFIED + TOG-NEW in output" "$out"
grep -q 'STALE' <<<"$out" \
  && bad "must NOT report STALE here — wrong branch fired" "$out" \
  || ok "does not also fire the STALE branch"

# ---------------------------------------------------------------------------
section "3. check — a classified entry that is no longer pending is an ERROR"
STALE="$TMP/stale.json"; mk_input "$STALE" TOG-A TOG-B TOG-C TOG-D
out="$("$TOOL" check --classification "$CLS" < "$STALE" 2>&1)"; rc=$?
(( rc == 3 )) && ok "exit 3 on a stale classification entry" \
              || bad "expected exit 3, got $rc" "$out"
grep -q 'STALE' <<<"$out" && grep -q 'TOG-E' <<<"$out" \
  && ok "names the STALE branch and the entry to remove" \
  || bad "expected STALE + TOG-E" "$out"
grep -q 'UNCLASSIFIED' <<<"$out" \
  && bad "must NOT report UNCLASSIFIED here — wrong branch fired" "$out" \
  || ok "does not also fire the UNCLASSIFIED branch"

# ---------------------------------------------------------------------------
section "3b. check — a moved line whose interaction is STILL pending"
# The inverted failure: the runbook line is live AND the ask is still in the
# owner's queue, so the owner sees the same thing twice — once as work, once as
# a decision awaiting judgement. That is worse than either alone.
NOTW="$TMP/notw.json"; mk_input "$NOTW" TOG-A TOG-B TOG-C TOG-D TOG-E TOG-M
out="$("$TOOL" check --classification "$CLS" < "$NOTW" 2>&1)"; rc=$?
(( rc == 3 )) && ok "exit 3 when a moved line was never actually withdrawn" \
              || bad "expected exit 3, got $rc" "$out"
grep -q 'NOT WITHDRAWN' <<<"$out" && grep -q 'TOG-M' <<<"$out" \
  && ok "names the NOT WITHDRAWN branch and the offending identifier" \
  || bad "expected NOT WITHDRAWN + TOG-M" "$out"
grep -q 'UNCLASSIFIED' <<<"$out" \
  && bad "TOG-M is classified — the UNCLASSIFIED branch must not fire" "$out" \
  || ok "does not misreport a moved-but-pending line as unclassified"

# ---------------------------------------------------------------------------
section "4. check — input validation"
out="$("$TOOL" check --classification "$CLS" <<<'{"not":"an array"}' 2>&1)"; rc=$?
(( rc == 2 )) && ok "exit 2 on non-array stdin" || bad "expected exit 2, got $rc" "$out"
# A malformed or empty query must NEVER read as a clean board. This is the
# fail-open case: if validation exits a subshell instead of the process, check
# continues with empty input, reports "pending board_only: 0", and a truncated
# query looks like an empty owner queue.
out="$("$TOOL" check --classification "$CLS" </dev/null 2>&1)"; rc=$?
(( rc == 2 )) && ok "exit 2 on empty stdin" || bad "expected exit 2 on empty stdin, got $rc" "$out"
grep -q 'pending board_only: 0' <<<"$out" \
  && bad "FAIL-OPEN: empty stdin reported a board count instead of refusing" "$out" \
  || ok "empty stdin does not report a count (no fail-open to 'clean board')"

out="$("$TOOL" check --classification "$CLS" <<<'[]' 2>&1)"; rc=$?
grep -q 'STALE' <<<"$out" && (( rc == 3 )) \
  && ok "a genuinely empty array is STALE, not clean (classified entries vanished)" \
  || bad "an empty array with a non-empty classification must be exit 3 STALE, got $rc" "$out"

out="$("$TOOL" check --classification "$TMP/does-not-exist.json" < "$ALIGNED" 2>&1)"; rc=$?
(( rc == 2 )) && ok "exit 2 on a missing classification file" || bad "expected exit 2, got $rc" "$out"
# A missing classification must never read as "nothing to classify".
grep -qi 'not found' <<<"$out" && ok "says the file is missing rather than passing vacuously" \
  || bad "expected a 'not found' message" "$out"

# ---------------------------------------------------------------------------
section "5. render — content and ordering"
doc="$("$TOOL" render --classification "$CLS" </dev/null 2>&1)"; rc=$?
(( rc == 0 )) && ok "render exits 0" || bad "render failed ($rc)" "$doc"

for id in TOG-A TOG-B TOG-C TOG-D TOG-E; do
  grep -q "$id" <<<"$doc" && ok "render includes $id" || bad "render dropped $id"
done

# Ordering is the whole point of one document: blast radius, highest first.
order="$(grep -oE '^### [0-9]+\. TOG-[A-Z]' <<<"$doc" | grep -oE 'TOG-[A-Z]' | tr '\n' ' ')"
# TOG-M is `moved` and still renders: moved means it BECAME a runbook line, so
# dropping it from the document would delete the very thing the withdrawal
# pointed the owner at.
[[ "$order" == "TOG-B TOG-C TOG-M TOG-A " ]] \
  && ok "runbook lines are ordered by blast radius (B=1, C=2, M=3, A=4)" \
  || bad "wrong order: '$order' (expected 'TOG-B TOG-C TOG-M TOG-A ')"
grep -q 'TOG-M' <<<"$doc" \
  && ok "a moved line still renders — the withdrawal points the owner AT it" \
  || bad "moved line was dropped from the document"

# Numbering must be contiguous from 1, or "work down the list" stops meaning anything.
nums="$(grep -oE '^### [0-9]+\.' <<<"$doc" | grep -oE '[0-9]+' | tr '\n' ' ')"
[[ "$nums" == "1 2 3 4 " ]] && ok "lines are numbered contiguously from 1" \
                            || bad "bad numbering: '$nums'"

# A decision must never render as a numbered runbook line — that is the exact
# confusion this whole tool exists to remove.
grep -qE '^### [0-9]+\. TOG-D' <<<"$doc" \
  && bad "TOG-D is a DECISION and must not be a numbered runbook line" \
  || ok "decisions are not numbered runbook lines"
grep -qE '^### [0-9]+\. TOG-E' <<<"$doc" \
  && bad "TOG-E is MISROUTED and must not be a numbered runbook line" \
  || ok "misrouted items are not numbered runbook lines"

grep -q 'clause 1 - real money' <<<"$doc" && ok "decision section cites the reserved clause" \
  || bad "expected the reserved clause on TOG-D"
grep -q 'do not chown this directory' <<<"$doc" && ok "renders the per-line warning" \
  || bad "warning not rendered"
grep -q 'clause 5, outward commitment' <<<"$doc" \
  && ok "MIXED line surfaces its owner-reserved part" \
  || bad "reserved_part not rendered for the MIXED line"
grep -q 'MIXED — part of this is owner-reserved' <<<"$doc" \
  && ok "MIXED line is flagged inline so it is not executed wholesale" \
  || bad "MIXED flag missing"
grep -q 'Runbook lines (capability requests) | 4' <<<"$doc" \
  && ok "summary table counts the runbook lines" || bad "summary count wrong"

# ---------------------------------------------------------------------------
section "5b. render — a line whose ONLY home is this document is marked as one"
# A `moved` line has had its standing interaction withdrawn, so this document is
# the last place the ask exists. Before this was generated it lived in a
# hand-written preamble on the board card — which any regeneration silently
# wiped, taking six asks with it. That is the exact failure this tool exists to
# prevent, so the marking has to come from the data, not from a human remembering.
grep -q 'ONLY HOME — no other card carries this ask' <<<"$doc" \
  && ok "the moved line is tagged ONLY HOME inline" \
  || bad "TOG-M is moved and must be tagged ONLY HOME on its own line" "$doc"
grep -q 'only remaining home for this ask' <<<"$doc" \
  && ok "the inline tag is explained, not just abbreviated" || bad "no explanation of ONLY HOME"
grep -q 'Read this before you start' <<<"$doc" \
  && ok "the up-front block that lists them is rendered" || bad "missing the up-front block"
grep -q '1 of the lines below have no card anywhere else' <<<"$doc" \
  && ok "the up-front block counts them" || bad "wrong count in the up-front block"
# The line NUMBER must match where the line actually renders. TOG-M is blast 3,
# so it sorts third. A reference to the wrong number is worse than none: it
# sends the reader to a line that is not the one being flagged.
grep -q '\*\*line 3 (TOG-M)\*\*' <<<"$doc" \
  && ok "the reference carries the line's real rendered number (3)" \
  || bad "expected '**line 3 (TOG-M)**' — reference drifted from the body" \
         "$(grep -o 'line [0-9]* (TOG-[A-Z])' <<<"$doc" | tr '\n' ' ')"
# Only the moved line may be tagged.
n_tag="$(grep -c 'ONLY HOME — no other card carries this ask' <<<"$doc")"
[[ "$n_tag" == "1" ]] && ok "exactly one line is tagged (not every line)" \
                      || bad "expected 1 ONLY HOME tag, got $n_tag"

# The empty case: with nothing moved, the block must VANISH, not render "0 of
# the lines below have no card anywhere else" — which reads like a finding.
CLS0="$TMP/cls_nomoved.json"
jq 'del(.items["TOG-M"].moved)' "$CLS" > "$CLS0"
doc0="$("$TOOL" render --classification "$CLS0" </dev/null 2>&1)"; rc=$?
(( rc == 0 )) && ok "renders with nothing moved" || bad "render failed ($rc)" "$doc0"
grep -q 'Read this before you start' <<<"$doc0" \
  && bad "the block must be omitted entirely when no line is moved" "$doc0" \
  || ok "no moved lines: the up-front block is omitted, not rendered as 0"
grep -q 'ONLY HOME' <<<"$doc0" \
  && bad "no line may be tagged ONLY HOME when none is moved" \
  || ok "no moved lines: no inline tag"
# ...and the document is otherwise intact, so the guard is not just blanking it.
grep -qE '^### 3\. TOG-M' <<<"$doc0" \
  && ok "the un-moved line still renders in its normal position" \
  || bad "dropping the marker dropped the line itself"

# ---------------------------------------------------------------------------
section "6. mutation — each half of check must be load-bearing"
STAGE="$TMP/stage"; mkdir -p "$STAGE"
cp "$TOOL" "$STAGE/operator_runbook.sh"; chmod +x "$STAGE/operator_runbook.sh"

# BASELINE FIRST. Without this, "the mutated copy failed" is unattributable —
# it could be failing because the staging directory itself is broken.
base_uncl=$(TOOL_UNDER_TEST="$STAGE/operator_runbook.sh" "$STAGE/operator_runbook.sh" check --classification "$CLS" < "$UNCL" >/dev/null 2>&1; echo $?)
base_stale=$(TOOL_UNDER_TEST="$STAGE/operator_runbook.sh" "$STAGE/operator_runbook.sh" check --classification "$CLS" < "$STALE" >/dev/null 2>&1; echo $?)
if (( base_uncl == 3 && base_stale == 3 )); then
  ok "BASELINE: the unmutated copy detects both branches in the staging dir"
else
  bad "BASELINE FAILED (uncl=$base_uncl stale=$base_stale) — mutation results below are meaningless"
fi

# Mutation A: neuter the unclassified branch.
sed 's/^  if \[\[ -n "${unclassified\/\/\[\[:space:\]\]\/}" \]\]; then/  if false; then/' \
  "$TOOL" > "$STAGE/mut_a.sh"; chmod +x "$STAGE/mut_a.sh"
if ! cmp -s "$TOOL" "$STAGE/mut_a.sh"; then
  rc=$("$STAGE/mut_a.sh" check --classification "$CLS" < "$UNCL" >/dev/null 2>&1; echo $?)
  (( rc != 3 )) && ok "removing the UNCLASSIFIED branch makes section 2 go red (exit $rc)" \
                || bad "mutation A changed nothing — section 2 is not pinned to that branch"
else
  bad "mutation A did not apply — the sed pattern no longer matches the source"
fi

# Mutation B: neuter the stale branch.
sed 's/^  if \[\[ -n "${stale\/\/\[\[:space:\]\]\/}" \]\]; then/  if false; then/' \
  "$TOOL" > "$STAGE/mut_b.sh"; chmod +x "$STAGE/mut_b.sh"
if ! cmp -s "$TOOL" "$STAGE/mut_b.sh"; then
  rc=$("$STAGE/mut_b.sh" check --classification "$CLS" < "$STALE" >/dev/null 2>&1; echo $?)
  (( rc != 3 )) && ok "removing the STALE branch makes section 3 go red (exit $rc)" \
                || bad "mutation B changed nothing — section 3 is not pinned to that branch"
else
  bad "mutation B did not apply — the sed pattern no longer matches the source"
fi

# Mutation C: neuter the not-withdrawn branch.
sed 's/^  if \[\[ -n "${not_withdrawn\/\/\[\[:space:\]\]\/}" \]\]; then/  if false; then/' \
  "$TOOL" > "$STAGE/mut_c.sh"; chmod +x "$STAGE/mut_c.sh"
if ! cmp -s "$TOOL" "$STAGE/mut_c.sh"; then
  rc=$("$STAGE/mut_c.sh" check --classification "$CLS" < "$NOTW" >/dev/null 2>&1; echo $?)
  (( rc != 3 )) && ok "removing the NOT WITHDRAWN branch makes section 3b go red (exit $rc)" \
                || bad "mutation C changed nothing — section 3b is not pinned to that branch"
else
  bad "mutation C did not apply — the sed pattern no longer matches the source"
fi

# ---------------------------------------------------------------------------
section "6b. check-handoff — a runbook that never filed an interaction"
# The hole this closes: `check` is driven by the pending interaction set, so an
# ask that filed NO interaction is not in its input and cannot fail any of its
# branches. A shipped runbook filed zero
# interactions, was closed done, and every gate passed while the artifact sat on
# disk with no delivery path. These tests pin the second input.
HDIR_OK="$TMP/handoff_ok";   mkdir -p "$HDIR_OK"
HDIR_BAD="$TMP/handoff_bad"; mkdir -p "$HDIR_BAD"
HCLS="$TMP/hcls.json"
cat > "$HCLS" <<'JSON'
{ "items": { "TOG-846": { "class":"CAPABILITY","blast":2,"credential":"host",
    "changes":"c","verify":"v","undo":"u","moved":true,"never_carded":true } },
  "decisions": {}, "misrouted": {}, "closed": {} }
JSON
: > "$HDIR_OK/TOG-846-cliproxy-update-runbook.md"
: > "$HDIR_BAD/TOG-846-cliproxy-update-runbook.md"
: > "$HDIR_BAD/TOG-999-orphan-runbook.md"

out="$("$TOOL" check-handoff --classification "$HCLS" --handoff "$HDIR_OK" 2>&1)"; rc=$?
(( rc == 0 )) && ok "exit 0 when every runbook artifact is classified" \
              || bad "expected exit 0, got $rc" "$out"

out="$("$TOOL" check-handoff --classification "$HCLS" --handoff "$HDIR_BAD" 2>&1)"; rc=$?
(( rc == 3 )) && ok "exit 3 on a runbook artifact with no classification entry" \
              || bad "expected exit 3, got $rc" "$out"
grep -q 'UNREGISTERED' <<<"$out" && grep -q 'TOG-999' <<<"$out" \
  && ok "names the UNREGISTERED branch and the stranded identifier" \
  || bad "expected UNREGISTERED + TOG-999" "$out"
# The classified one must NOT be reported: a gate that also names the line that
# IS registered is noise, and noise is what stops these being read.
grep -q 'TOG-846' <<<"$out" \
  && bad "TOG-846 is classified and must not be reported as unregistered" "$out" \
  || ok "does not report a correctly-registered artifact"

# THE REGRESSION THAT MATTERS. This is the literal stranded-runbook defect: the artifact
# exists, it filed no interaction, and it is absent from the classification file.
# If this ever goes green again, the hole is back.
HCLS_EMPTY="$TMP/hcls_empty.json"
jq '.items = {}' "$HCLS" > "$HCLS_EMPTY"
rc=$("$TOOL" check-handoff --classification "$HCLS_EMPTY" --handoff "$HDIR_OK" >/dev/null 2>&1; echo $?)
(( rc == 3 )) && ok "that failure mode is caught (artifact on disk, no entry, no card)" \
              || bad "THE HOLE IS OPEN: a stranded runbook passed clean (exit $rc)"

# An entry anywhere in the file counts as registered — decisions/misrouted/closed
# are classifications too, and demanding an `items` entry would force a genuine
# decision to be mis-filed as a runbook line to silence the gate.
for sect in decisions misrouted closed; do
  C2="$TMP/hcls_$sect.json"
  jq --arg s "$sect" '.items = {} | .[$s] = {"TOG-846":{"clause":"1","summary":"s","resolver":"r","outcome":"o","evidence":"e"}}' "$HCLS" > "$C2"
  rc=$("$TOOL" check-handoff --classification "$C2" --handoff "$HDIR_OK" >/dev/null 2>&1; echo $?)
  (( rc == 0 )) && ok "an entry in .$sect counts as registered" \
                || bad "an entry in .$sect should satisfy the gate, got $rc"
done

# Fail-open guards. An unread directory must never read as "nothing stranded" —
# the same failure §4 pins for `check`.
out="$("$TOOL" check-handoff --classification "$HCLS" --handoff "$TMP/no_such_dir" 2>&1)"; rc=$?
(( rc == 2 )) && ok "exit 2 on a missing handoff directory" || bad "expected exit 2, got $rc" "$out"
grep -qi 'OK:' <<<"$out" \
  && bad "FAIL-OPEN: an unreadable handoff directory reported clean" "$out" \
  || ok "a missing handoff directory does not report clean"
out="$("$TOOL" check-handoff --classification "$TMP/does-not-exist.json" --handoff "$HDIR_OK" 2>&1)"; rc=$?
(( rc == 2 )) && ok "exit 2 on a missing classification file" || bad "expected exit 2, got $rc" "$out"

# Case-insensitivity is load-bearing: a real file in the handoff directory is
# named `tog-351`, and a gate that missed it on case would pass silently.
HDIR_LC="$TMP/handoff_lc"; mkdir -p "$HDIR_LC"; : > "$HDIR_LC/tog-555-lower-runbook.md"
out="$("$TOOL" check-handoff --classification "$HCLS" --handoff "$HDIR_LC" 2>&1)"; rc=$?
(( rc == 3 )) && grep -q 'TOG-555' <<<"$out" \
  && ok "a lowercase tog-* filename is caught and normalised to TOG-555" \
  || bad "lowercase filename slipped past the gate (exit $rc)" "$out"

# A non-runbook file must not trip it, or the gate becomes noise and stops being read.
HDIR_N="$TMP/handoff_noise"; mkdir -p "$HDIR_N"
: > "$HDIR_N/TOG-777-findings.md"; : > "$HDIR_N/TOG-778-verify.sh"; : > "$HDIR_N/README.md"
rc=$("$TOOL" check-handoff --classification "$HCLS" --handoff "$HDIR_N" >/dev/null 2>&1; echo $?)
(( rc == 0 )) && ok "non-runbook files in the handoff directory are ignored" \
              || bad "a findings/script/README file tripped the gate (exit $rc)"

# Mutation D: neuter the unregistered branch of check-handoff. Placed here, not
# with A-C, because it needs the fixtures section 6b builds above.
sed 's/^  if \[\[ -n "${unregistered\/\/\[\[:space:\]\]\/}" \]\]; then/  if false; then/' \
  "$TOOL" > "$STAGE/mut_d.sh"; chmod +x "$STAGE/mut_d.sh"
if ! cmp -s "$TOOL" "$STAGE/mut_d.sh"; then
  base_unreg=$("$STAGE/operator_runbook.sh" check-handoff --classification "$HCLS" --handoff "$HDIR_BAD" >/dev/null 2>&1; echo $?)
  (( base_unreg == 3 )) && ok "BASELINE: the unmutated copy detects the unregistered branch" \
                        || bad "BASELINE FAILED (unreg=$base_unreg) — mutation D below is meaningless"
  rc=$("$STAGE/mut_d.sh" check-handoff --classification "$HCLS" --handoff "$HDIR_BAD" >/dev/null 2>&1; echo $?)
  (( rc != 3 )) && ok "removing the UNREGISTERED branch makes section 6b go red (exit $rc)" \
                || bad "mutation D changed nothing — section 6b is not pinned to that branch"
else
  bad "mutation D did not apply — the sed pattern no longer matches the source"
fi

# ---------------------------------------------------------------------------
section "6c. the shipped tree passes check-handoff"
# The grandfather list is enumerated in the tool. If someone adds a runbook file
# and neither classifies nor grandfathers it, this goes red in CI on their push
# — which is the entire point of building this half.
if [[ -d /paperclip/operator-handoff ]]; then
  out="$("$TOOL" check-handoff 2>&1)"; rc=$?
  (( rc == 0 )) && ok "the live handoff directory is fully registered or grandfathered" \
                || bad "a runbook artifact on this host is stranded" "$out"
else
  ok "handoff directory absent on this runner — skipped (CI has no /paperclip)"
fi

# ---------------------------------------------------------------------------
section "7. the shipped classification file is well-formed"
REAL="$HERE/operator_runbook_classification.json"
if [[ -f "$REAL" ]]; then
  jq -e 'type=="object"' >/dev/null "$REAL" && ok "shipped classification is valid JSON" \
    || bad "shipped classification is not a JSON object"
  # Every item needs the four fields a runbook line is made of. A line missing
  # "undo" is worse than no line: it reads as complete and is not.
  missing="$(jq -r '.items | to_entries[] | select((.value.credential|not) or (.value.changes|not) or (.value.verify|not) or (.value.undo|not) or (.value.blast|not)) | .key' "$REAL")"
  [[ -z "$missing" ]] && ok "every runbook line has credential, changes, verify, undo, blast" \
    || bad "incomplete runbook lines: $(tr '\n' ' ' <<<"$missing")"
  bad_class="$(jq -r '.items | to_entries[] | select(.value.class != "CAPABILITY" and .value.class != "MIXED") | .key' "$REAL")"
  [[ -z "$bad_class" ]] && ok "only CAPABILITY and MIXED items become runbook lines" \
    || bad "wrong class in items: $(tr '\n' ' ' <<<"$bad_class")"
  bad_blast="$(jq -r '.items | to_entries[] | select(.value.blast < 1 or .value.blast > 4) | .key' "$REAL")"
  [[ -z "$bad_blast" ]] && ok "every blast radius is in 1..4" || bad "bad blast radius: $bad_blast"
  # An identifier may not appear in two classes at once. `closed` is included:
  # a retired line that is ALSO still live is the ambiguity that would let an
  # operator read "done" and "do this" about the same ask on one page.
  dupes="$(jq -r '[(.items|keys[]),(.decisions|keys[]),(.misrouted|keys[]),((.closed//{})|keys[])] | group_by(.) | map(select(length>1)) | flatten | unique[]' "$REAL")"
  [[ -z "$dupes" ]] && ok "no identifier is classified twice" || bad "classified twice: $dupes"
  # A retired line must carry the MEASUREMENT that retired it. Without it the
  # section degrades into a list of things someone decided to stop tracking,
  # and a shipped entry — cancelled with the key still un-rotated — is precisely the
  # entry that must never be read as "completed".
  thin="$(jq -r '(.closed//{}) | to_entries[] | select(((.value.outcome//"")|length)==0 or ((.value.evidence//"")|length)==0) | .key' "$REAL")"
  [[ -z "$thin" ]] && ok "every retired line carries an outcome and its evidence" \
    || bad "retired lines missing outcome/evidence: $(tr '\n' ' ' <<<"$thin")"
  "$TOOL" render </dev/null >/dev/null 2>&1 && ok "shipped classification renders" || bad "shipped classification fails to render"

  # `withdrawn` is a SOURCE field: the 🛑 banner only
  # renders because this field exists. Nothing before this asserted the field
  # itself survives a regeneration — `del(.. | .withdrawn?)` on this file once
  # rendered 0 banners and left every other section 7 check, and the whole
  # render-drift gate in test_omniroute_rehearsal.sh, green. Section 9 now covers
  # the # WITHDRAWN header and deletion control; these checks also cover other
  # command wording and banners on items without that header.
  #
  # Any item whose `commands` contains the literal string "WITHDRAWN" is
  # asserting, in its own data, that it has been withdrawn — so it MUST also
  # carry a `withdrawn` object with a non-empty `body`. That is the general
  # form the issue asked for: the next withdrawn line is covered by what it
  # says about itself, not by naming one item.
  unmarked_withdrawn="$(jq -r '
    .items | to_entries[]
    | select((.value.commands // "") | test("WITHDRAWN"))
    | select((.value.withdrawn.body // "") | length == 0)
    | .key' "$REAL")"
  [[ -z "$unmarked_withdrawn" ]] \
    && ok "every item whose commands say WITHDRAWN carries a withdrawn.body" \
    || bad "WITHDRAWN in commands with no withdrawn.body: $(tr '\n' ' ' <<<"$unmarked_withdrawn")"

  # At least one shipped item must actually exercise this path, or the check
  # above is vacuously true. The NO-FORK ruling is that item.
  n_withdrawn="$(jq -r '[.items[] | select((.withdrawn.body // "") | length > 0)] | length' "$REAL")"
  [[ "$n_withdrawn" -ge 1 ]] && ok "the shipped classification carries at least one withdrawn item" \
    || bad "no shipped item carries a withdrawn object — this suite would not have caught the deletion"

  # The render itself must still show the banner for every withdrawn item, and
  # the banner must sit ABOVE the blast-radius line — it is a stop sign, and a
  # stop sign read second is read as a footnote. This is the render-side half
  # the issue asked to pair with the source-level assertion above.
  doc_real="$("$TOOL" render --classification "$REAL" </dev/null 2>&1)"
  bad_order=""
  while IFS= read -r wid; do
    [[ -n "$wid" ]] || continue
    section_ok="$(awk -v id="$wid" '
      $0 ~ ("^### [0-9]+\\. " id " ") { infound=1 }
      infound && /^### [0-9]+\./ && $0 !~ ("^### [0-9]+\\. " id " ") { exit }
      infound && /🛑/            { print "banner"; exit }
      infound && /\*\*Blast radius/ { print "blast"; exit }
    ' <<<"$doc_real")"
    [[ "$section_ok" == "banner" ]] || bad_order+="$wid "
  done < <(jq -r '.items | to_entries[] | select((.value.withdrawn.body // "") | length > 0) | .key' "$REAL")
  [[ -z "$bad_order" ]] \
    && ok "every withdrawn item renders its 🛑 banner above its blast-radius line" \
    || bad "withdrawn item(s) missing the banner or rendered it below blast radius: $bad_order"
else
  ok "shipped classification absent in this checkout — skipped (operator data stays private)"
fi

# ---------------------------------------------------------------------------
section "8. retired lines are recorded, never silently dropped"
# The failure this pins: a line leaves the live list and simply vanishes, so the
# next operator reads its absence as "never asked" or "already done". One entry
# in the shipped file was CANCELLED WITHOUT THE WORK BEING DONE, so
# the distinction is load-bearing, not decorative.
CLOSED_ONE="$STAGE/closed_one.json"
cat >"$CLOSED_ONE" <<'JSON'
{ "items": { "TASK-1": { "class":"CAPABILITY","blast":1,"credential":"root",
    "changes":"c","verify":"v","undo":"u","moved":true } },
  "decisions": {}, "misrouted": {},
  "closed": { "TASK-2": { "blast":1,"outcome":"cancelled, NOT performed","evidence":"probe X measured it unchanged" } } }
JSON
out="$("$TOOL" render --classification "$CLOSED_ONE" </dev/null 2>&1)"
grep -q 'TASK-2' <<<"$out" && ok "a retired line still appears in the document" \
  || bad "a retired line vanished from the render — absence reads as 'never asked'"
grep -q 'cancelled, NOT performed' <<<"$out" && ok "its outcome is carried" || bad "outcome dropped"
grep -q 'probe X measured it unchanged' <<<"$out" && ok "its evidence is carried" || bad "evidence dropped"
# It must NOT be renumbered into the live list — that would send an operator to
# redo finished work, or worse, treat a live line as finished.
grep -q '### 2\. TASK-2' <<<"$out" && bad "retired line was numbered into the live runbook list" \
  || ok "retired line is not numbered into the live list"
# And the live count must not include it.
grep -q '| Runbook lines (capability requests) | 1 |' <<<"$out" \
  && ok "the live count excludes retired lines" || bad "retired line leaked into the live count"
# Empty decisions must SAY so, not render a bare heading that reads as
# "nothing is reserved to the owner".
grep -q '_None open._' <<<"$out" && ok "an empty decisions list says so explicitly" \
  || bad "empty decisions rendered as a bare heading"
# Back-compat: a classification with no `closed` key at all must still render.
NOCLOSED="$STAGE/noclosed.json"
jq 'del(.closed)' "$CLOSED_ONE" >"$NOCLOSED"
if "$TOOL" render --classification "$NOCLOSED" </dev/null >/dev/null 2>&1; then
  ok "a classification with no closed section still renders"
else
  bad "render broke on a classification without a closed section"
fi

# ---------------------------------------------------------------------------
section "9. a withdrawal survives a source-side regeneration"
# THE HOLE THIS CLOSES. The render-drift gate
# asserts render == the shipped document. That catches a hand-edit to the
# DOCUMENT — which is what it once caught. It is structurally blind to a
# deletion at the SOURCE followed by a regeneration, because afterwards the
# source and the document agree: they simply agree on a document with no stop
# sign. Measured:
#
#   jq 'del(.. | .withdrawn?)' operator_runbook_classification.json > tmp && mv tmp ...
#   ./operator_runbook.sh render > <shipped-document>
#   -> 0 🛑 banners, test_operator_runbook.sh 79/0, test_omniroute_rehearsal.sh 73/0
#
# The NO-FORK stop sign was gone and nothing in CI noticed.
# verification/tog-703-runbook-withdrawal-marker.sh asserts this property but
# cannot run in CI — it measures from a host STAGING_DIR no runner can reach.
# These assertions are the hermetic, source-level half of the same property.
#
# THE WITNESS IS `commands`, NOT `withdrawn`. Keying the rule on the presence of
# the `withdrawn` object would be circular: deleting the object deletes the
# obligation with it, which is exactly the mutation that got through. The
# witness has to be a field the deletion does NOT touch, so it is the
# `# WITHDRAWN` header inside the retained `commands` block — the procedure text
# is kept deliberately (so the retired steps stay legible), which is what makes
# it a durable anchor.
if [[ -f "$REAL" ]]; then
  # Any item whose commands block announces itself as WITHDRAWN must carry the
  # structured object that renders the banner. Generalised by construction: the
  # next withdrawn line is covered the day its commands say so, by measurement
  # rather than by name.
  wq='[.items | to_entries[] | select((.value.commands? // "") | test("(^|\n)# *WITHDRAWN"))]'

  claim_n="$(jq -r "$wq | length" "$REAL")"
  # NON-VACUITY. A rule that selects nothing passes forever and pins nothing.
  # If this ever legitimately reaches 0 — every withdrawal retired — delete this
  # section with the measurement that retired it, do not let it idle green.
  (( claim_n > 0 )) \
    && ok "the withdrawal rule selects $claim_n item(s) — it is not vacuous" \
    || bad "NO item declares WITHDRAWN in its commands — this whole section is vacuous"

  # The assertion the source-deletion mutation fails on.
  unmarked="$(jq -r "$wq"'[] | select(((.value.withdrawn.body? // "") | length) == 0) | .key' "$REAL")"
  [[ -z "$unmarked" ]] \
    && ok "every WITHDRAWN commands block carries a withdrawn object with a body" \
    || bad "WITHDRAWN in commands but no withdrawn.body: $(tr '\n' ' ' <<<"$unmarked")"

  # The banner is dated because "withdrawn" with no date cannot be aged out, and
  # commands_note is what replaces the bare "**Exact commands.**" lead-in — an
  # empty one renders a withdrawn command block that reads exactly like a live one.
  thin_w="$(jq -r "$wq"'[] | select(((.value.withdrawn.date? // "") | length) == 0 or ((.value.withdrawn.commands_note? // "") | length) == 0) | .key' "$REAL")"
  [[ -z "$thin_w" ]] \
    && ok "every withdrawal carries a date and a commands_note" \
    || bad "withdrawal missing date/commands_note: $(tr '\n' ' ' <<<"$thin_w")"

  # RENDER SIDE. Ordering is the property that makes the banner a stop sign
  # rather than a footnote: a 🛑 printed BELOW the risk rating is read second,
  # after the operator has already started sizing up the job.
  rendered="$TMP/real_render.md"
  if "$TOOL" render --classification "$REAL" </dev/null >"$rendered" 2>/dev/null; then
    ord_bad=""; ord_n=0
    while read -r id; do
      [[ -n "$id" ]] || continue
      ord_n=$((ord_n+1))
      # The section body: from this item's heading to the next heading.
      body="$(awk -v id="$id" '
        $0 ~ "^### [0-9]+\\. " id " " {inb=1; next}
        inb && /^### / {exit}
        inb {print}' "$rendered")"
      [[ -n "$body" ]] || { ord_bad="$ord_bad $id(no-section)"; continue; }
      banner_at="$(grep -n '🛑' <<<"$body" | head -1 | cut -d: -f1)"
      blast_at="$(grep -n '^\*\*Blast radius' <<<"$body" | head -1 | cut -d: -f1)"
      [[ -n "$banner_at" && -n "$blast_at" && $banner_at -lt $blast_at ]] \
        || ord_bad="$ord_bad $id(banner=${banner_at:-none},blast=${blast_at:-none})"
    done < <(jq -r "$wq"'[] | .key' "$REAL")
    [[ -z "$ord_bad" ]] \
      && ok "each withdrawn section renders 🛑 ABOVE its Blast radius line ($ord_n checked)" \
      || bad "withdrawn banner missing or below the blast line:$ord_bad"
  else
    bad "shipped classification failed to render — cannot check banner ordering"
  fi

  # POSITIVE CONTROL. Without this, the four assertions above are unfalsifiable:
  # a green tells us nothing about whether they would catch the deletion. This
  # replays the exact mutation from a prior review on a STAGING COPY and
  # requires the source assertion to go red on it.
  MUT="$TMP/withdrawn_deleted.json"
  jq 'del(.. | .withdrawn?)' "$REAL" >"$MUT"
  if jq -e "$wq"'[] | select((.value.withdrawn? // null) != null)' "$MUT" >/dev/null 2>&1; then
    # The mutation silently no-opped. Scoring that as a pass would accuse the
    # gate at the moment the mutant failed to apply.
    bad "MUTATION DID NOT APPLY — del(.withdrawn) left objects behind; control is meaningless"
  else
    mut_unmarked="$(jq -r "$wq"'[] | select(((.value.withdrawn.body? // "") | length) == 0) | .key' "$MUT")"
    [[ -n "$mut_unmarked" ]] \
      && ok "CONTROL: deleting withdrawn at the source goes RED here ($(tr '\n' ' ' <<<"$mut_unmarked"))" \
      || bad "CONTROL FAILED: the source deletion still passes — this section does not close the hole"
    # And the regenerated document really does lose the stop sign, which is the
    # consequence the source assertion is standing in for.
    mut_render="$TMP/mut_render.md"
    if "$TOOL" render --classification "$MUT" </dev/null >"$mut_render" 2>/dev/null; then
      (( $(grep -c '🛑' "$mut_render") == 0 )) \
        && ok "CONTROL: the regenerated document loses every 🛑 banner" \
        || bad "CONTROL: banners survived the source deletion — re-derive what this gate pins"
    else
      bad "CONTROL: mutated classification failed to render"
    fi
  fi
else
  ok "shipped classification absent in this checkout — skipped (operator data stays private)"
fi

# ---------------------------------------------------------------------------
section "10. a pinned checkout satisfies its own step-0 SUMS block"
# A prior incident: a runbook said `git checkout --detach <sha>`
# and, six lines later, `sha256sum --check --strict` against r3 lane hashes that
# tree does not carry (3/6 FAILED). Earlier sections were green on that pair, because
# nothing resolved the SUMS paths AT the pinned commit. This does.
#
# For every classification entry (at any depth) whose `commands` open a checksum
# heredoc, take the `git checkout --detach <sha>` that precedes it, read each
# listed file with `git cat-file blob <sha>:<path>` (the exact bytes a checkout
# writes, no textconv), and compare its sha256 to the block. A pin that is not in
# the local object store (a shallow CI clone holds only the PR head) is FETCHED by
# full sha; if that fails the gate is RED. It never skips.
#
# Output contract of pin_sums_gate: `SELECTED <entry>` for every entry it
# gates, then `OK ...` per verified entry and `FAIL ...` per defect; exit 1 iff
# any FAIL. A block with no pin before it, a pin or heredoc it cannot read, a
# tree moved after the pin, an empty or malformed block, a path absent at the pin
# and an unresolvable pin are all defects: each is a way for this gate to go
# quiet while the pair is still wrong.

# ONE predicate opens a checksum block: a non-comment line naming sha256sum with
# a `<<`. It both SELECTS the entry and starts the PARSE, so what is gated and
# what is checked cannot drift apart (the first cut matched by substring and
# parsed by exact line; an indented block start passed with no output at all).
sums_start() { [[ $1 != "#"* && $1 == *sha256sum* && $1 == *"<<"* ]]; }

pin_sums_gate() {  # $1=classification.json  $2=git repository to resolve pins in
  local cls="$1" repo="$2" key b64 cmds raw line pin full path want got n rc=0 erc
  local in_sums blk_n has delim dash fetch_out blob="$TMP/pin_blob.$$"
  local -a depth
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    echo "FAIL $repo is not a git checkout — pins cannot be resolved"; return 1
  fi
  while IFS=$'\t' read -r key b64; do
    [[ -n "$key" ]] || continue
    cmds="$(base64 -d <<<"$b64")"; has=0
    while IFS= read -r raw || [[ -n "$raw" ]]; do
      line="${raw#"${raw%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
      if sums_start "$line"; then has=1; break; fi
    done <<<"$cmds"
    (( has )) || continue
    echo "SELECTED $key"
    pin=""; full=""; in_sums=0; n=0; blk_n=0; erc=0; delim=""; dash=0
    while IFS= read -r raw || [[ -n "$raw" ]]; do
      if (( in_sums )); then
        # inside the heredoc: the terminator is exact, `<<-` strips leading tabs
        line="$raw"; (( dash )) && line="${raw#"${raw%%[!$'\t']*}"}"
        if [[ $line == "$delim" ]]; then in_sums=0; continue; fi
        [[ -n "$pin" && -n "$full" ]] || continue   # already reported above
        if [[ $raw =~ ^[[:space:]]*([0-9a-f]{64})[[:space:]]+\*?(.+)$ ]]; then
          want="${BASH_REMATCH[1]}"; path="${BASH_REMATCH[2]}"; n=$((n+1))
          if git -C "$repo" cat-file blob "${full}:${path}" >"$blob" 2>/dev/null; then
            got="$(sha256sum <"$blob" | cut -d' ' -f1)"
            if [[ "$got" != "$want" ]]; then
              echo "FAIL $key: $path at ${full:0:12} hashes to $got but the SUMS block says $want"; rc=1; erc=1
            fi
          else
            echo "FAIL $key: $path does not exist at ${full:0:12} (SUMS block says $want)"; rc=1; erc=1
          fi
        elif [[ -n "$raw" ]]; then
          echo "FAIL $key: malformed SUMS line (want '<64 hex>  <path>'): $raw"; rc=1; erc=1
        fi
        continue
      fi
      line="${raw#"${raw%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
      [[ $line == "#"* ]] && continue
      if [[ $line =~ ^git[[:space:]]+(checkout|switch)[[:space:]]+--detach[[:space:]]+([0-9a-f]{7,40})$ ]]; then
        pin="${BASH_REMATCH[2]}"; full=""
      elif [[ $line =~ (^|[[:space:];\&\|])git[[:space:]]+(checkout|switch)([[:space:]]|$) ]]; then
        echo "FAIL $key: tree moved by a line the gate cannot read as a pin (want 'git checkout --detach <hex sha>'): $line"; rc=1; erc=1
      elif sums_start "$line"; then
        blk_n=$((blk_n+1))
        if [[ $line == *"<<<"* ]] || ! [[ $line =~ \<\<(-?)[[:space:]]*[\'\"]?([A-Za-z_][A-Za-z0-9_]*)[\'\"]? ]]; then
          echo "FAIL $key: cannot read the heredoc delimiter on: $line"; rc=1; erc=1
          continue
        fi
        dash=0; [[ ${BASH_REMATCH[1]} == "-" ]] && dash=1
        delim="${BASH_REMATCH[2]}"; in_sums=1
        if [[ -z "$pin" ]]; then
          echo "FAIL $key: SUMS block with no 'git checkout --detach <sha>' before it"; rc=1; erc=1
        elif [[ -z "$full" ]]; then
          full="$(git -C "$repo" rev-parse --verify -q "${pin}^{commit}" 2>/dev/null)"
          fetch_out=""
          if [[ -z "$full" && ${#pin} -eq 40 ]]; then
            # --depth=1 only when the clone is ALREADY shallow: on a full clone it
            # would write the pin into the shared .git/shallow and truncate history.
            depth=(); [[ "$(git -C "$repo" rev-parse --is-shallow-repository 2>/dev/null)" == true ]] && depth=(--depth=1)
            fetch_out="$(git -C "$repo" fetch --no-tags ${depth[@]+"${depth[@]}"} origin "$pin" 2>&1)"
            full="$(git -C "$repo" rev-parse --verify -q "${pin}^{commit}" 2>/dev/null)"
          elif [[ -z "$full" ]]; then
            fetch_out="abbreviated pin: only a full 40-hex sha can be fetched"
          fi
          if [[ -z "$full" ]]; then
            echo "FAIL $key: pin $pin is not in $repo and could not be fetched from origin ($(tr '\n' ' ' <<<"$fetch_out" | cut -c1-200))"; rc=1; erc=1
          fi
        fi
      fi
    done <<<"$cmds"
    if (( in_sums == 1 )); then echo "FAIL $key: SUMS block is never closed"; rc=1; erc=1; fi
    if (( n == 0 && erc == 0 )); then echo "FAIL $key: SUMS block lists no files — it pins nothing"; rc=1; erc=1; fi
    if (( erc == 0 )); then echo "OK $key: $n file(s) match at pin ${full:0:12}"; fi
  done < <(jq -r '
      path(.. | objects | select(((.commands // null) | type) == "string")) as $p
      | "\($p | map(tostring) | join("/"))\t\(getpath($p).commands | @base64)"' "$cls")
  rm -f "$blob"
  return $rc
}

# A throwaway repository whose pins we control. c1 -> c2 changes a.sh only, so a
# SUMS block written for c2 and pinned at c1 is exactly the wrong-pin shape: one
# file wrong, the rest right.
GR="$TMP/pinrepo"
mkdir -p "$GR" && git -C "$GR" init -q 2>/dev/null
gitq() { git -C "$GR" -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false "$@"; }
printf 'a v1\n' >"$GR/a.sh"; printf 'b\n' >"$GR/b.sh"
gitq add a.sh b.sh && gitq commit -q -m c1 && C1="$(gitq rev-parse HEAD)"
printf 'a v2\n' >"$GR/a.sh"
gitq add a.sh && gitq commit -q -m c2 && C2="$(gitq rev-parse HEAD)"
A2="$(sha256sum <"$GR/a.sh" | cut -d' ' -f1)"; B2="$(sha256sum <"$GR/b.sh" | cut -d' ' -f1)"
A1="$(gitq show "$C1:a.sh" | sha256sum | cut -d' ' -f1)"
# c3 is DANGLING (no ref reaches it): a full clone of GR never contains it, so it
# is the pin that a full clone must fetch.
C3="$(gitq commit-tree "$C2^{tree}" -p "$C2" -m c3)"

mk_pin_cls() {  # $1=out file  $2=entry key  $3=commands text
  jq -n --arg k "$2" --arg c "$3" '{items:{($k):{class:"CAPABILITY",blast:1,credential:"x",changes:"x",verify:"x",undo:"x",commands:$c}}}' >"$1"
}
SUMS_OPEN="sha256sum --check --strict <<'SUMS'"
pin_cmds() {  # $1=pin sha (or ""), remaining args = SUMS lines; $SUMS_OPEN is the block-start line
  local sha="$1"; shift
  [[ -z "$sha" ]] || printf 'git checkout --detach %s\n' "$sha"
  printf '%s\n' "$SUMS_OPEN"; printf '%s\n' "$@"; printf 'SUMS\n'
}
run_gate() { pin_sums_gate "$1" "$GR" 2>&1; }

# BASELINE. A gate that is red on a correct pair would make every control below
# pass for the wrong reason, so the correct pair goes first.
mk_pin_cls "$TMP/pin_good.json" FIX "$(pin_cmds "$C2" "$A2  a.sh" "$B2  b.sh")"
out="$(run_gate "$TMP/pin_good.json")"; rc=$?
(( rc == 0 )) && grep -q '^OK items/FIX' <<<"$out" && ! grep -q '^FAIL' <<<"$out" \
  && ok "BASELINE: a pin that carries every SUMS file is green" \
  || bad "BASELINE: the correct pair must pass, rc=$rc" "$out"

# POSITIVE CONTROL — the incident. Pin c1, SUMS written for c2.
mk_pin_cls "$TMP/pin_bad.json" FIX "$(pin_cmds "$C1" "$A2  a.sh" "$B2  b.sh")"
out="$(run_gate "$TMP/pin_bad.json")"; rc=$?
(( rc != 0 )) && grep -q '^FAIL items/FIX: a.sh' <<<"$out" \
  && ok "CONTROL: a wrong pin (c1 pinned, c2 hashes) goes RED naming the file" \
  || bad "CONTROL FAILED: a pin whose files do not match the SUMS block passed, rc=$rc" "$out"
grep -q "$A1" <<<"$out" && grep -q "$A2" <<<"$out" \
  && ok "the finding carries BOTH hashes (at the pin and in the SUMS block)" \
  || bad "finding must show the hash at the pin ($A1) and the SUMS hash ($A2)" "$out"
grep -q 'FAIL items/FIX: b.sh' <<<"$out" \
  && bad "b.sh is identical at c1 and c2 and must not be reported" "$out" \
  || ok "only the drifted file is reported (b.sh matches at both commits)"

# The block-start line as an operator or an author might actually write it. Each
# is a WRONG pair (c1 pinned, c2 hashes) and must be RED naming a.sh; before the
# selector and parser shared one predicate, the first two passed with no output.
for variant in "  $SUMS_OPEN" "$SUMS_OPEN " $'\t'"$SUMS_OPEN" \
               "sha256sum -c --strict <<'SUMS'" "sha256sum --check --strict --quiet <<'SUMS'" \
               "sha256sum --check --strict <<SUMS" "sha256sum --check --strict <<\"SUMS\""; do
  mk_pin_cls "$TMP/pin_var.json" FIX "$(SUMS_OPEN="$variant" pin_cmds "$C1" "$A2  a.sh")"
  out="$(run_gate "$TMP/pin_var.json")"; rc=$?
  (( rc != 0 )) && grep -q '^FAIL items/FIX: a.sh' <<<"$out" \
    && ok "CONTROL: block start [$variant] is selected, parsed and RED on a wrong pin" \
    || bad "CONTROL FAILED: block start [$variant] let a wrong pair through, rc=$rc" "$out"
done
# `<<-` strips leading tabs from the body and the terminator; the gate must read
# the delimiter off the line and honour that, or a tab-indented block never closes.
mk_pin_cls "$TMP/pin_dash.json" FIX "$(printf 'git checkout --detach %s\nsha256sum --check --strict <<-SUMS\n\t%s  a.sh\n\t%s  b.sh\n\tSUMS\n' "$C2" "$A2" "$B2")"
out="$(run_gate "$TMP/pin_dash.json")"; rc=$?
(( rc == 0 )) && grep -q '^OK items/FIX: 2 file' <<<"$out" \
  && ok "a tab-indented '<<-' block with a correct pair is green (terminator read from the line)" \
  || bad "a correct tab-indented '<<-' pair must pass, rc=$rc" "$out"

# A here-string is not a block the gate can read; it must say so, not pass.
mk_pin_cls "$TMP/pin_here.json" FIX "$(printf 'git checkout --detach %s\nsha256sum -c <<<"%s  a.sh"\n' "$C1" "$A2")"
out="$(run_gate "$TMP/pin_here.json")"; rc=$?
(( rc != 0 )) && grep -q 'cannot read the heredoc delimiter' <<<"$out" \
  && ok "CONTROL: a here-string checksum line is RED, not ignored" \
  || bad "CONTROL FAILED: a here-string checksum line was skipped, rc=$rc" "$out"

# An entry nested deeper than items/<ID>. The old selector walked two levels and
# the non-vacuity count walked all of them, so this was counted and never checked.
jq -n --arg c "$(pin_cmds "$C1" "$A2  a.sh")" '{items:{grp:{DEEP:{commands:$c}}}}' >"$TMP/pin_deep.json"
out="$(run_gate "$TMP/pin_deep.json")"; rc=$?
(( rc != 0 )) && grep -q '^FAIL items/grp/DEEP: a.sh' <<<"$out" \
  && ok "CONTROL: an entry nested below items/<ID> is gated, and RED on a wrong pin" \
  || bad "CONTROL FAILED: a nested entry was not gated, rc=$rc" "$out"

# Two entries: the second is wrong. 'OK count >= 1' would have been satisfied by
# the first; the verdict has to be per entry.
jq -n --arg g "$(pin_cmds "$C2" "$A2  a.sh")" --arg b "$(pin_cmds "$C1" "$A2  a.sh")" \
  '{items:{GOOD:{commands:$g},BAD:{commands:$b}}}' >"$TMP/pin_two.json"
out="$(run_gate "$TMP/pin_two.json")"; rc=$?
(( rc != 0 )) && grep -q '^OK items/GOOD' <<<"$out" && grep -q '^FAIL items/BAD: a.sh' <<<"$out" \
  && [[ "$(grep -c '^SELECTED ' <<<"$out")" == 2 ]] \
  && ok "CONTROL: with one good and one wrong entry the gate selects both and fails the wrong one" \
  || bad "CONTROL FAILED: a wrong entry hid behind a good one, rc=$rc" "$out"

# Each remaining defect is a way the gate could go quiet while the pair is wrong.
mk_pin_cls "$TMP/pin_nopath.json" FIX "$(pin_cmds "$C1" "$A1  a.sh" "$B2  c.sh")"
out="$(run_gate "$TMP/pin_nopath.json")"; rc=$?
(( rc != 0 )) && grep -q 'c.sh does not exist at' <<<"$out" \
  && ok "CONTROL: a SUMS path absent at the pin is RED, not skipped" \
  || bad "CONTROL FAILED: a path missing at the pin passed, rc=$rc" "$out"

mk_pin_cls "$TMP/pin_nocommit.json" FIX "$(pin_cmds "$(printf '1%.0s' {1..40})" "$A2  a.sh")"
out="$(run_gate "$TMP/pin_nocommit.json")"; rc=$?
(( rc != 0 )) && grep -q 'could not be fetched' <<<"$out" \
  && ok "CONTROL: a pin that is neither local nor fetchable is RED, not skipped" \
  || bad "CONTROL FAILED: an unresolvable pin passed silently, rc=$rc" "$out"

# The failure text of one entry must not leak into another's.
jq -n --arg a "$(pin_cmds "$(printf '1%.0s' {1..40})" "$A2  a.sh")" --arg b "$(pin_cmds "deadbee" "$A2  a.sh")" \
  '{items:{FIRST:{commands:$a},SECOND:{commands:$b}}}' >"$TMP/pin_logs.json"
out="$(run_gate "$TMP/pin_logs.json")"
second="$(grep '^FAIL items/SECOND' <<<"$out")"
[[ "$second" == *"abbreviated pin"* && "$second" != *"fatal"* && "$second" != *"couldn't find"* ]] \
  && ok "an abbreviated unknown pin reports itself, not the previous entry's fetch error" \
  || bad "SECOND entry's failure must be its own: $second" "$out"

mk_pin_cls "$TMP/pin_nopin.json" FIX "$(pin_cmds "" "$A2  a.sh")"
out="$(run_gate "$TMP/pin_nopin.json")"; rc=$?
(( rc != 0 )) && grep -q 'no .git checkout --detach' <<<"$out" \
  && ok "CONTROL: a SUMS block with no pin before it is RED" \
  || bad "CONTROL FAILED: a SUMS block against an unpinned tree passed, rc=$rc" "$out"

mk_pin_cls "$TMP/pin_unreadable.json" FIX "$(printf 'git checkout --detach "$SHA"\n'; pin_cmds "" "$A2  a.sh")"
out="$(run_gate "$TMP/pin_unreadable.json")"; rc=$?
(( rc != 0 )) && grep -q 'cannot read as a pin' <<<"$out" \
  && ok "CONTROL: a pin the gate cannot read (a variable) is RED, not ignored" \
  || bad "CONTROL FAILED: an unparseable pin was ignored, rc=$rc" "$out"

# The tree moved AFTER a good pin: the block would be checked against a stale pin.
mk_pin_cls "$TMP/pin_moved.json" FIX "$(printf 'git checkout --detach %s\ngit switch --detach %s\n' "$C2" "$C1"; pin_cmds "" "$A2  a.sh")"
out="$(run_gate "$TMP/pin_moved.json")"; rc=$?
mk_pin_cls "$TMP/pin_moved2.json" FIX "$(printf 'git checkout --detach %s\ngit checkout main\n' "$C2"; pin_cmds "" "$A2  a.sh")"
out2="$(run_gate "$TMP/pin_moved2.json")"; rc2=$?
# the first form is a legitimate re-pin to C1 (switch --detach <sha> IS a pin), so
# its wrong hash is what must fail; the second moves the tree to a branch.
(( rc != 0 )) && grep -q '^FAIL items/FIX: a.sh' <<<"$out" \
  && (( rc2 != 0 )) && grep -q 'tree moved' <<<"$out2" \
  && ok "CONTROL: a later 'git switch --detach' re-pins; a later 'git checkout <branch>' is RED" \
  || bad "CONTROL FAILED: a tree move after the pin went unflagged, rc=$rc/$rc2" "$out $out2"

mk_pin_cls "$TMP/pin_empty.json" FIX "$(pin_cmds "$C2")"
out="$(run_gate "$TMP/pin_empty.json")"; rc=$?
(( rc != 0 )) && grep -q 'lists no files' <<<"$out" \
  && ok "CONTROL: an empty SUMS block is RED (it would pin nothing)" \
  || bad "CONTROL FAILED: an empty SUMS block passed, rc=$rc" "$out"

mk_pin_cls "$TMP/pin_junk.json" FIX "$(pin_cmds "$C2" "$A2  a.sh" "not-a-hash  b.sh")"
out="$(run_gate "$TMP/pin_junk.json")"; rc=$?
(( rc != 0 )) && grep -q 'malformed SUMS line' <<<"$out" \
  && ok "CONTROL: a malformed SUMS line is RED, not dropped" \
  || bad "CONTROL FAILED: a malformed SUMS line was dropped, rc=$rc" "$out"

# The fetch paths. A depth-1 clone holds only the tip, exactly like the CI
# checkout; c1 is then reachable only by an explicit fetch of its full sha.
git -C "$GR" config uploadpack.allowAnySHA1InWant true
SH="$TMP/pinshallow"
if git clone -q --depth=1 "file://$GR" "$SH" >/dev/null 2>&1 && ! git -C "$SH" cat-file -e "${C1}^{commit}" 2>/dev/null; then
  mk_pin_cls "$TMP/pin_fetch.json" FIX "$(pin_cmds "$C1" "$A1  a.sh" "$B2  b.sh")"
  out="$(pin_sums_gate "$TMP/pin_fetch.json" "$SH" 2>&1)"; rc=$?
  (( rc == 0 )) && git -C "$SH" cat-file -e "${C1}^{commit}" 2>/dev/null \
    && ok "a pin missing from a shallow clone is fetched by full sha, then verified" \
    || bad "shallow-clone pin was not fetched and verified, rc=$rc" "$out"
  mk_pin_cls "$TMP/pin_fetchbad.json" FIX "$(pin_cmds "$C1" "$A2  a.sh")"
  out="$(pin_sums_gate "$TMP/pin_fetchbad.json" "$SH" 2>&1)"; rc=$?
  (( rc != 0 )) && grep -q '^FAIL items/FIX: a.sh' <<<"$out" \
    && ok "CONTROL: a fetched pin with wrong hashes is still RED" \
    || bad "CONTROL FAILED: a fetched pin skipped verification, rc=$rc" "$out"
else
  bad "could not build a depth-1 clone lacking c1 — the fetch path is unproved"
fi
# A FULL clone must stay full. `--depth=1` on it writes the pin into the shared
# .git/shallow and truncates `git log`, for every worktree on that object store.
FC="$TMP/pinfull"
if git clone -q "file://$GR" "$FC" >/dev/null 2>&1 \
   && [[ "$(git -C "$FC" rev-parse --is-shallow-repository)" == false ]] \
   && ! git -C "$FC" cat-file -e "${C3}^{commit}" 2>/dev/null; then
  mk_pin_cls "$TMP/pin_full.json" FIX "$(pin_cmds "$C3" "$A2  a.sh" "$B2  b.sh")"
  out="$(pin_sums_gate "$TMP/pin_full.json" "$FC" 2>&1)"; rc=$?
  (( rc == 0 )) && git -C "$FC" cat-file -e "${C3}^{commit}" 2>/dev/null \
    && [[ "$(git -C "$FC" rev-parse --is-shallow-repository)" == false ]] \
    && [[ "$(git -C "$FC" rev-list --count "$C3")" == 3 ]] \
    && ok "CONTROL: fetching an absent pin into a FULL clone leaves it full (3 commits behind the pin)" \
    || bad "CONTROL FAILED: the gate shallowed a full clone or failed to fetch, rc=$rc" "$out"
else
  bad "could not build a full clone lacking c3 — the stays-full control is unproved"
fi

# THE REAL FILE. Non-vacuity first: if no entry opens a SUMS block the gate
# passes forever and pins nothing; retire this section with the last such block.
# The count comes from the gate's own SELECTED lines, so what is counted is what
# is gated, and every selected entry must come back OK.
if [[ -f "$REAL" ]]; then
  out="$(pin_sums_gate "$REAL" "$HERE" 2>&1)"; rc=$?
  sel_n="$(grep -c '^SELECTED ' <<<"$out")"; ok_n="$(grep -c '^OK ' <<<"$out")"
  (( sel_n > 0 )) \
    && ok "$sel_n shipped entry(ies) open a SUMS block — the gate is not vacuous" \
    || bad "NO shipped entry opens a SUMS block — this section is vacuous"
  (( rc == 0 && sel_n > 0 && ok_n == sel_n )) \
    && ok "every shipped SUMS block ($ok_n of $sel_n) matches the commit its own checkout pins ($(grep '^OK ' <<<"$out" | head -1))" \
    || bad "a shipped runbook pins a commit that does not carry its own SUMS hashes ($ok_n of $sel_n OK), rc=$rc" "$out"
fi

printf '\n== totals\n  passed: %d\n  failed: %d\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
