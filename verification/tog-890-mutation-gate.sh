#!/usr/bin/env bash
# =====================================================================================
# tog-890-mutation-gate.sh — proof that test_stale_descriptor_sweep.sh is not vacuous.
#
# The suite it guards is 40 green assertions about a detector, which is worth nothing
# until somebody breaks the detector and watches them go red. Each mutation below
# removes exactly ONE limb from a staged copy and asserts the NAMED case reddens. The
# unmutated copy is asserted green FIRST, in the same staging directory: "the mutated
# suite failed" is unattributable without it, because a staging error produces the same
# red. That baseline is the check this repo added after TOG-253, where two gates passed
# for months while proving nothing.
#
# WHY EACH LIMB HERE IS AT REAL RISK, which is the only justification for a mutation:
#
#   1/2. THE EXIT-5 REFUSALS look like defensive clutter. Deleting them is the obvious
#        tidy-up, and it is the edit that converts this detector into a permanent false
#        green — a mis-scoped query returns zero rows rather than an error, so "clean
#        board" and "read nothing" become the same output.
#
#   3.   THE UUID MASK reads as a redundant pre-pass, since the full scan already ran.
#        It is the only thing standing between `owner.agentId` and a phantom citation.
#
#   4.   THE LIVE-STATUS SET is one word from wrong. Adding `answered` is a plausible
#        reading of "the question got a reply", and it blinds the tool to the most
#        common stale shape.
#
#   5.   THE SUPERSESSION RULE (`some` rather than `every`) is a one-token edit that
#        reports every correctly-updated descriptor as broken.
#
#   6.   THE EXACT ACK MARKER invites being loosened to a prose sniff, which fails OPEN:
#        any agent writing "do not re-cut" silences the check unknowingly.
#
#   7.   PRINTING ACKNOWLEDGED CARDS looks like noise in a clean run. Dropping it is how
#        an allowlist entry that stopped being deliberate becomes invisible.
#
#   ./verification/tog-890-mutation-gate.sh
#
# Exit 0 = every mutation was detected by the case that claims to cover it.
# =====================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
SRC="$ROOT/scripts/stale_descriptor_sweep.js"
SUITE="$ROOT/test_stale_descriptor_sweep.sh"
[ -f "$SRC" ]   || { echo "FATAL: cannot find scripts/stale_descriptor_sweep.js above $HERE" >&2; exit 4; }
[ -f "$SUITE" ] || { echo "FATAL: cannot find test_stale_descriptor_sweep.sh above $HERE" >&2; exit 4; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/scripts"
cp "$SRC" "$STAGE/scripts/stale_descriptor_sweep.js"
cp "$SUITE" "$STAGE/test_stale_descriptor_sweep.sh"
chmod +x "$STAGE/test_stale_descriptor_sweep.sh" "$STAGE/scripts/stale_descriptor_sweep.js"

pass=0; fail=0
red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }

# --- BASELINE. Without this, every "the mutated suite went red" below is unattributable.
echo "=== baseline: the UNMUTATED copy passes in this same staging directory ==="
base_out="$("$STAGE/test_stale_descriptor_sweep.sh" 2>&1)" && base_rc=0 || base_rc=$?
if [ "$base_rc" = "0" ]; then
  grn "  PASS  unmutated copy: suite green in $STAGE"; pass=$((pass+1))
else
  red "  FAIL  unmutated copy is ALREADY RED (rc=$base_rc) — every mutation below would"
  red "        go red for that reason instead of the mutation. Staging is broken."
  printf '%s\n' "$base_out" | grep -E '^\s+FAIL' || true
  exit 1
fi
# A suite that scored zero assertions is not a green suite.
if printf '%s' "$base_out" | grep -qE 'passed 0,'; then
  red "  FAIL  baseline ran ZERO assertions — nothing below could be detected"; exit 1
else
  grn "  PASS  baseline ran $(printf '%s' "$base_out" | grep -oE 'passed [0-9]+' | head -1) assertions"; pass=$((pass+1))
fi
echo

# mutate <name> <old-literal> <new-literal> <case-that-must-go-red>...
#
# The trailing arguments are case NAMES that must flip to FAIL. A mutation that merely
# makes the suite red SOMEWHERE is not evidence for the case under test — that is how a
# gate passes while the case it names covers nothing.
mutate() {
  local name="$1" old="$2" new="$3"; shift 3
  cp "$SRC" "$STAGE/scripts/stale_descriptor_sweep.js"
  chmod +x "$STAGE/scripts/stale_descriptor_sweep.js"
  OLD="$old" NEW="$new" F="$STAGE/scripts/stale_descriptor_sweep.js" python3 - <<'PY' || { red "  FAIL  $name: mutation did not apply — the source moved, so this gate asserts nothing"; fail=$((fail+1)); return; }
import os, sys
f = os.environ["F"]; old = os.environ["OLD"]; new = os.environ["NEW"]
s = open(f).read()
if s.count(old) != 1:
    print(f"mutation target appears {s.count(old)} times, expected exactly 1", file=sys.stderr)
    sys.exit(1)
open(f, "w").write(s.replace(old, new))
PY
  # A mutation that breaks the parse would redden the suite for the wrong reason.
  if ! node --check "$STAGE/scripts/stale_descriptor_sweep.js" 2>/dev/null; then
    red "  FAIL  $name: the mutation broke the parse; it would fail for the wrong reason"
    fail=$((fail+1)); return
  fi
  # A mutation that changed no bytes is not a mutation.
  if cmp -s "$SRC" "$STAGE/scripts/stale_descriptor_sweep.js"; then
    red "  FAIL  $name: the staged copy is byte-identical to the original"
    fail=$((fail+1)); return
  fi
  local out rc=0
  out="$("$STAGE/test_stale_descriptor_sweep.sh" 2>&1)" || rc=$?
  if [ "$rc" = "0" ]; then
    red "  FAIL  $name: suite stayed GREEN with this limb removed — nothing covers it"
    fail=$((fail+1)); return
  fi
  local case_name ok=1
  for case_name in "$@"; do
    if printf '%s' "$out" | grep -qF "FAIL $case_name"; then :; else
      red "  FAIL  $name: suite went red, but NOT on the case that claims to cover it:"
      red "        expected a red on: $case_name"
      ok=0
    fi
  done
  if [ "$ok" = "1" ]; then grn "  PASS  $name"; pass=$((pass+1)); else fail=$((fail+1)); fi
}

echo "=== each limb of the detector, removed one at a time ==="

# 1. THE ONE THAT MATTERS MOST. Delete the zero-interaction refusal and the tool reports
#    a clean board having joined against an empty set. This is a permanent false green
#    and the state is reachable in production from a mis-scoped query.
mutate "zero interactions no longer refuses — a clean board from an empty read" \
  '  if (report.interactionsKnown === 0) {' \
  '  if (false) {' \
  "zero interactions -> exit 5 UNKNOWN" \
  "...and says it looked at nothing" \
  "...and never claims the board is clean"

# 2. The sibling refusal. "Nothing to sweep" and "nothing wrong" are different facts and
#    only the exit code distinguishes them.
mutate "zero blocked cards read as a clean board" \
  '  if (report.checked === 0) {' \
  '  if (false) {' \
  "zero blocked cards -> exit 5 UNKNOWN"

# 3. The UUID mask. Without it, owner.agentId contributes its own 8-char prefix and a
#    card is reported stale on the strength of its own owner field.
mutate "the UUID mask removed — owner.agentId becomes a phantom citation" \
  '  const masked = text.replace(UUID_RE, (m) => " ".repeat(m.length));' \
  '  const masked = text;' \
  "an agent id sharing a dead ask's 8-prefix is NOT a citation"

# 4. The live-status set. Adding `answered` is a plausible misreading of "the question
#    got a reply" and blinds the tool to the most common stale shape.
mutate "an answered ask treated as still live" \
  'const LIVE_STATUSES = new Set(["pending"]);' \
  'const LIVE_STATUSES = new Set(["pending", "answered"]);' \
  "a 'answered' interaction strands the card -> exit 1"

# 5. The supersession rule. `every` instead of `some` reports every correctly-updated
#    descriptor — the TOG-64 fix itself — as broken forever.
mutate "supersession read backwards: every citation must be live" \
  '  if (cited.some((c) => LIVE_STATUSES.has(c.status))) {' \
  '  if (cited.every((c) => LIVE_STATUSES.has(c.status))) {' \
  "one live citation among dead ones -> clean, exit 0"

# 6. The exact marker loosened to a prose sniff. This is the fail-OPEN direction: any
#    agent who writes that phrase silences the check without knowing it exists.
mutate "the ack marker loosened to a prose sniff — fails open" \
  '  const acknowledged = text.toLowerCase().includes(ACK_MARKER);' \
  '  const acknowledged = /do not re-cut/i.test(text);' \
  "the same prose WITHOUT the exact marker is still a finding"

# 7. Acknowledged cards no longer printed. An allowlist entry that has quietly stopped
#    being deliberate becomes invisible — the detector drops a finding in silence.
mutate "acknowledged cards silently dropped from the report" \
  '  if (report.acknowledged.length > 0) {' \
  '  if (false) {' \
  "...but is still PRINTED, never silently dropped"

# --- TOG-908 limbs: fragile hosting. -------------------------------------------------
#
# 8. THE SELF-HOST EXEMPTION. Dropping it grades an ask hosted on its own card — the
#    SAFE shape, and the exact shape this check asks people to move to — as a finding.
#    A detector that reports its own remedy as a defect gets muted, and then the real
#    doomed findings go with it.
mutate "the self-hosted exemption removed — the safe shape reads as a finding" \
  '    if (row.identifier && it.hostIssue === row.identifier) continue; // self-hosted: safe' \
  '    if (false) continue;' \
  "an ask hosted on its OWN card is not reported"

# 9. THE UNKNOWN-HOST GUARD. This is the fail-WRONG direction and the subtler of the
#    two. If a reader stops supplying the join, every hostIssue is null; treating null
#    as "not mine" grades the entire board fragile and buries the doomed rows in noise.
#    Silence on missing data is the only safe reading.
mutate "missing hosting data treated as a finding rather than as unknown" \
  '    if (it.hostIssue === undefined || it.hostIssue === null) continue;' \
  '    if (false) continue;' \
  "an interaction with NO hosting data is not graded at all"

# 10. THE DOOMED/FRAGILE GRADE. Collapsing the grade so nothing is ever doomed keeps the
#     report looking identical while the exit code goes permanently green — the precise
#     false-green shape this repo keeps re-learning. A pending ask on a closed host is a
#     present defect, not a forecast.
mutate "nothing is ever graded doomed — the verdict goes permanently green" \
  '    const doomed = ["done", "cancelled"].includes(it.hostStatus);' \
  '    const doomed = false;' \
  "a live ask hosted on a DONE card -> exit 1" \
  "a cancelled host is doomed too -> exit 1"

# 11. THE DOOMED VERDICT ITSELF. The report can stay word-for-word correct while the
#     exit code stops gating on it. A scheduled job reads the code, not the prose.
mutate "doomed findings printed but no longer failing the run" \
  '  if ((report.doomed || []).length > 0) {' \
  '  if (false) {' \
  "a live ask hosted on a DONE card -> exit 1" \
  "json carries the DOOMED-HOST verdict"

# 12. HOSTING SCORED ON DEAD CITATIONS. Removing the live-only filter double-counts one
#     defect under two names and makes the fragile list grow without bound, which is how
#     a section stops being read at all.
mutate "hosting graded on dead citations too — one defect counted twice" \
  '    if (!LIVE_STATUSES.has(c.status)) continue; // dead citations are the sweep'"'"'s job' \
  '    if (false) continue;' \
  "...and is not double-counted as a hosting finding"

# --- RESTORE. A corrupted staging directory would make every result above suspect.
cp "$SRC" "$STAGE/scripts/stale_descriptor_sweep.js"
chmod +x "$STAGE/scripts/stale_descriptor_sweep.js"
if "$STAGE/test_stale_descriptor_sweep.sh" > "$STAGE/restored.txt" 2>&1; then
  grn "  PASS  restored copy is green again"; pass=$((pass+1))
else
  red "  FAIL  the restored copy is red; the staging dir was corrupted"
  cat "$STAGE/restored.txt"; fail=$((fail+1))
fi

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ] || exit 1
