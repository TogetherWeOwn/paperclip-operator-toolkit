#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for operator_runbook.sh (TOG-434).
# NO DATABASE, NO CREDENTIALS, NO NETWORK — this is what CI runs.
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
section "6b. check-handoff — a runbook that never filed an interaction (TOG-851)"
# The hole this closes: `check` is driven by the pending interaction set, so an
# ask that filed NO interaction is not in its input and cannot fail any of its
# branches. TOG-846 shipped a complete operator runbook, filed zero
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

# THE REGRESSION THAT MATTERS. This is the literal TOG-846 defect: the artifact
# exists, it filed no interaction, and it is absent from the classification file.
# If this ever goes green again, the hole is back.
HCLS_EMPTY="$TMP/hcls_empty.json"
jq '.items = {}' "$HCLS" > "$HCLS_EMPTY"
rc=$("$TOOL" check-handoff --classification "$HCLS_EMPTY" --handoff "$HDIR_OK" >/dev/null 2>&1; echo $?)
(( rc == 3 )) && ok "TOG-846's own failure mode is caught (artifact on disk, no entry, no card)" \
              || bad "THE TOG-846 HOLE IS OPEN: a stranded runbook passed clean (exit $rc)"

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
  # and TOG-174 — cancelled with the key still un-rotated — is precisely the
  # entry that must never be read as "completed".
  thin="$(jq -r '(.closed//{}) | to_entries[] | select(((.value.outcome//"")|length)==0 or ((.value.evidence//"")|length)==0) | .key' "$REAL")"
  [[ -z "$thin" ]] && ok "every retired line carries an outcome and its evidence" \
    || bad "retired lines missing outcome/evidence: $(tr '\n' ' ' <<<"$thin")"
  "$TOOL" render </dev/null >/dev/null 2>&1 && ok "shipped classification renders" || bad "shipped classification fails to render"
else
  bad "shipped classification file not found at $REAL"
fi

# ---------------------------------------------------------------------------
section "8. retired lines are recorded, never silently dropped"
# The failure this pins: a line leaves the live list and simply vanishes, so the
# next operator reads its absence as "never asked" or "already done". One entry
# in the shipped file (TOG-174) was CANCELLED WITHOUT THE WORK BEING DONE, so
# the distinction is load-bearing, not decorative.
CLOSED_ONE="$STAGE/closed_one.json"
cat >"$CLOSED_ONE" <<'JSON'
{ "items": { "TOG-1": { "class":"CAPABILITY","blast":1,"credential":"root",
    "changes":"c","verify":"v","undo":"u","moved":true } },
  "decisions": {}, "misrouted": {},
  "closed": { "TOG-2": { "blast":1,"outcome":"cancelled, NOT performed","evidence":"probe X measured it unchanged" } } }
JSON
out="$("$TOOL" render --classification "$CLOSED_ONE" </dev/null 2>&1)"
grep -q 'TOG-2' <<<"$out" && ok "a retired line still appears in the document" \
  || bad "a retired line vanished from the render — absence reads as 'never asked'"
grep -q 'cancelled, NOT performed' <<<"$out" && ok "its outcome is carried" || bad "outcome dropped"
grep -q 'probe X measured it unchanged' <<<"$out" && ok "its evidence is carried" || bad "evidence dropped"
# It must NOT be renumbered into the live list — that would send an operator to
# redo finished work, or worse, treat a live line as finished.
grep -q '### 2\. TOG-2' <<<"$out" && bad "retired line was numbered into the live runbook list" \
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

printf '\n== totals\n  passed: %d\n  failed: %d\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
