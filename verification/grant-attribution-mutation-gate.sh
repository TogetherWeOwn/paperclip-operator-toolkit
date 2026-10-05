#!/usr/bin/env bash
# =====================================================================================
# grant-attribution-mutation-gate.sh — proof that test_grant_attribution.sh is not vacuous.
#
# The suite it guards is 39 green assertions about an attribution resolver, which is
# worth nothing until somebody breaks the resolver and watches them go red. Each
# mutation below removes exactly ONE limb from a staged copy and asserts the NAMED case
# reddens. The unmutated copy is asserted green FIRST, in the same staging directory:
# "the mutated suite failed" is unattributable without it, because a staging error
# produces the same red. That baseline is the check this repo added after an
# incident where two gates passed for months while proving nothing.
#
# WHY EACH LIMB HERE IS AT REAL RISK, which is the only justification for a mutation:
#
#   1/2. THE EXIT-5 REFUSALS look like defensive clutter, and #1 guards the shape that
#        is GREEN when it fails: zero grant rows reports "0 unattributable of 0" and
#        exits 0. A mis-scoped query returns zero rows rather than an error, so a
#        perfect audit derived from reading nothing is one typo away.
#
#   3.   THE AMBIGUITY REFUSAL is the tempting simplification — the candidates are
#        already sorted by |Δt|, so "just take the nearest" is a one-line edit. It
#        writes a confident, possibly wrong grantor into an audit trail, which is
#        strictly worse than a recorded gap.
#
#   4.   THE AGENT KEY on the join. Matching on time alone still passes the happy path
#        and attributes grants to whoever happened to act nearby.
#
#   5.   THE WINDOW BOUND reads as a magic number begging to be deleted. Without it any
#        permissions edit, days later, becomes the grantor of an unrelated row.
#
#   6.   THE ACTION FILTER looks redundant beside the entity filter. Dropping it lets
#        `issue.updated` — the single most common row in the table — attribute grants.
#
#   7.   DIRECT-WINS. If the join can overrule `granted_by_user_id`, an inference
#        silently replaces the one attribution the server actually recorded.
#
#   8.   THE SELF-GRANT CHECK is this office's charter metric. Deleting it is invisible
#        on a clean board, which is exactly when it is deleted.
#
#   9.   THE SELF-GRANT PRECEDENCE. The finding can stay in the report while the verdict
#        stops leading with it, and a scheduled job reads the verdict.
#
#  10.   THE DERIVED/DIRECT SPLIT. Counting an inference as a recorded fact is the
#        precise failure this whole card is about.
#
#   ./verification/grant-attribution-mutation-gate.sh
#
# Exit 0 = every mutation was detected by the case that claims to cover it.
# =====================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
SRC="$ROOT/scripts/grant_attribution.js"
SUITE="$ROOT/test_grant_attribution.sh"
[ -f "$SRC" ]   || { echo "FATAL: cannot find scripts/grant_attribution.js above $HERE" >&2; exit 4; }
[ -f "$SUITE" ] || { echo "FATAL: cannot find test_grant_attribution.sh above $HERE" >&2; exit 4; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/scripts"
cp "$SRC" "$STAGE/scripts/grant_attribution.js"
cp "$SUITE" "$STAGE/test_grant_attribution.sh"
chmod +x "$STAGE/test_grant_attribution.sh" "$STAGE/scripts/grant_attribution.js"

pass=0; fail=0
red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }

# --- BASELINE. Without this, every "the mutated suite went red" below is unattributable.
echo "=== baseline: the UNMUTATED copy passes in this same staging directory ==="
base_out="$("$STAGE/test_grant_attribution.sh" 2>&1)" && base_rc=0 || base_rc=$?
if [ "$base_rc" = "0" ]; then
  grn "  PASS  unmutated copy: suite green in $STAGE"; pass=$((pass+1))
else
  red "  FAIL  unmutated copy is ALREADY RED (rc=$base_rc) — every mutation below would"
  red "        go red for that reason instead of the mutation. Staging is broken."
  printf '%s\n' "$base_out" | grep -E '^\s+FAIL' || true
  exit 1
fi
# A suite that scored zero assertions is not a green suite.
if grep -qE 'passed 0,' <<<"$base_out"; then
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
  cp "$SRC" "$STAGE/scripts/grant_attribution.js"
  chmod +x "$STAGE/scripts/grant_attribution.js"
  OLD="$old" NEW="$new" F="$STAGE/scripts/grant_attribution.js" python3 - <<'PY' || { red "  FAIL  $name: mutation did not apply — the source moved, so this gate asserts nothing"; fail=$((fail+1)); return; }
import os, sys
f = os.environ["F"]; old = os.environ["OLD"]; new = os.environ["NEW"]
s = open(f).read()
if s.count(old) != 1:
    print(f"mutation target appears {s.count(old)} times, expected exactly 1", file=sys.stderr)
    sys.exit(1)
open(f, "w").write(s.replace(old, new))
PY
  if ! node --check "$STAGE/scripts/grant_attribution.js" 2>/dev/null; then
    red "  FAIL  $name: the mutation broke the parse; it would fail for the wrong reason"
    fail=$((fail+1)); return
  fi
  if cmp -s "$SRC" "$STAGE/scripts/grant_attribution.js"; then
    red "  FAIL  $name: the staged copy is byte-identical to the original"
    fail=$((fail+1)); return
  fi
  local out rc=0
  out="$("$STAGE/test_grant_attribution.sh" 2>&1)" || rc=$?
  if [ "$rc" = "0" ]; then
    red "  FAIL  $name: suite stayed GREEN with this limb removed — nothing covers it"
    fail=$((fail+1)); return
  fi
  local case_name ok=1
  for case_name in "$@"; do
    if grep -qF "FAIL $case_name" <<<"$out"; then :; else
      red "  FAIL  $name: suite went red, but NOT on the case that claims to cover it:"
      red "        expected a red on: $case_name"
      ok=0
    fi
  done
  if [ "$ok" = "1" ]; then grn "  PASS  $name"; pass=$((pass+1)); else fail=$((fail+1)); fi
}

echo "=== each limb of the resolver, removed one at a time ==="

# 1. THE ONE THAT MATTERS MOST, because its failure is GREEN. Zero grant rows reports
#    full attribution coverage of nothing and exits 0.
mutate "zero grants no longer refuses — a perfect audit of an empty read" \
  '  if (report.checked === 0) {' \
  '  if (false) {' \
  "zero grant rows -> exit 5 UNKNOWN" \
  "...and says it read nothing" \
  "...and never claims everything is attributed"

# 2. The sibling refusal. An empty activity read makes every grant look anonymous —
#    loud and wrong, and it would send someone chasing 131 phantom findings.
mutate "zero activity rows report a false catastrophe" \
  '  if (report.activityKnown === 0) {' \
  '  if (false) {' \
  "zero activity rows -> exit 5 UNKNOWN" \
  "...and does not report 1 of 1 unattributable"

# 3. THE AMBIGUITY REFUSAL, collapsed to nearest-wins. The candidates are already sorted
#    by |Δt|, so this is the natural "simplification" — and it manufactures a grantor.
mutate "ambiguity resolved by nearest-timestamp instead of refused" \
  '    if (actors.size > 1) {' \
  '    if (false) {' \
  "two actors in the window -> UNATTRIBUTED, exit 1" \
  "...reported as ambiguous, naming both candidates"

# 4. THE AGENT KEY. Matching on time alone still passes the happy path, and attributes
#    every grant to whoever happened to be acting nearby.
mutate "the join keyed on time alone, not on the agent" \
  '    const candidates = (byPrincipal.get(g.principalId) || [])' \
  '    const candidates = [].concat(...byPrincipal.values())' \
  "another agent's activity does not attribute this grant" \
  "...exactly one row stays unattributable"

# 5. THE WINDOW BOUND. Without it a permissions edit made days later becomes the
#    grantor of an unrelated grant row.
mutate "the time window removed — any activity row attributes any grant" \
  '      .filter((c) => Math.abs(c.delta) <= WINDOW_SECONDS)' \
  '      .filter(() => true)' \
  "an activity row outside the window does not match"

# 6. THE ACTION FILTER. `issue.updated` is the second most common row in this table;
#    without the filter it attributes grants.
mutate "the action filter removed — issue.updated attributes a grant" \
  '    if (!GRANT_ACTIONS.includes(row.action)) continue;' \
  '    if (false) continue;' \
  "an unrelated action does not attribute a grant"

# 7. DIRECT-WINS. If the join can overrule the column the server wrote, an inference
#    silently replaces the only attribution that was ever a recorded fact.
mutate "the join overrules granted_by_user_id" \
  '    if (g.grantedByUserId) {' \
  '    if (false) {' \
  "granted_by_user_id wins -> counted direct" \
  "...and the nearby activity row does not make it derived"

# 8. THE SELF-GRANT CHECK — this office's charter metric. Deleting it is invisible on a
#    clean board, which is precisely when somebody deletes it.
mutate "the self-grant control never fires" \
  '  return rows.filter((r) => r.actorType === "agent" && r.actorId === r.principalId);' \
  '  return [];' \
  "a principal granting ITSELF -> exit 1" \
  "...names the principal" \
  "a self-grant outranks UNATTRIBUTED in the verdict"

# 9. THE PRECEDENCE. The self-grant can stay in the printed report while the verdict
#    stops leading with it — and a scheduled job gates on the verdict, not the prose.
#    `report.selfGrants.length > 0` appears TWICE — once in verdictFor, once in render —
#    so this target must span the following lines to hit the verdict branch only. $'...'
#    is required: a plain '\n' reaches python as a literal backslash-n and matches zero
#    times, which the count-!=-1 guard would report as a mutation that did not apply.
mutate "a self-grant no longer outranks a merely-anonymous row" \
  $'  if (report.selfGrants.length > 0) {\n    return {\n      verdict: "SELF-GRANT",' \
  $'  if (false) {\n    return {\n      verdict: "SELF-GRANT",' \
  "a self-grant outranks UNATTRIBUTED in the verdict"

# 10. THE DERIVED/DIRECT SPLIT — counting an inference as a recorded fact, which is the
#     exact defect this card is about. The tool would then claim 106 attributed rows
#     with no way to tell which 97 are inferences.
mutate "a derived inference counted as a direct record" \
  '        source: "direct",' \
  '        source: "derived",' \
  "granted_by_user_id wins -> counted direct" \
  "direct and derived are counted separately"

# --- RESTORE. A corrupted staging directory would make every result above suspect.
cp "$SRC" "$STAGE/scripts/grant_attribution.js"
chmod +x "$STAGE/scripts/grant_attribution.js"
if "$STAGE/test_grant_attribution.sh" > "$STAGE/restored.txt" 2>&1; then
  grn "  PASS  restored copy is green again"; pass=$((pass+1))
else
  red "  FAIL  the restored copy is red; the staging dir was corrupted"
  cat "$STAGE/restored.txt"; fail=$((fail+1))
fi

# =====================================================================================
# PART TWO: the WRITE path. test_grant_write_attribution.sh guards the provisioner
# change that stops this repo minting new anonymous rows, and it needs the same proof.
#
# It stages differently on purpose: that suite EXTRACTS its subject from
# org_provisioner.sh by path, so the mutation has to land in a staged copy of the
# provisioner AND the suite has to be pointed at it. The extraction is itself the thing
# most at risk here — a rename upstream makes the suite extract nothing, and a suite
# that tests an empty function passes everything. The extraction guard is asserted below
# by mutating the function name and requiring a FATAL, not a green run.
# =====================================================================================
WSUITE="$ROOT/test_grant_write_attribution.sh"
if [ ! -f "$WSUITE" ]; then
  red "  FAIL  cannot find test_grant_write_attribution.sh — the write path is unguarded"
  fail=$((fail+1))
else
  echo
  echo "=== PART TWO: the provisioner write path ==="
  WSTAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE" "$WSTAGE"' EXIT
  mkdir -p "$WSTAGE/lib" "$WSTAGE/scripts"
  cp "$ROOT/org_provisioner.sh" "$WSTAGE/org_provisioner.sh"
  cp "$WSUITE" "$WSTAGE/test_grant_write_attribution.sh"
  cp "$ROOT/lib/pcsql.sh" "$WSTAGE/lib/pcsql.sh"
  cp "$SRC" "$WSTAGE/scripts/grant_attribution.js"
  chmod +x "$WSTAGE/test_grant_write_attribution.sh"

  wbase="$("$WSTAGE/test_grant_write_attribution.sh" 2>&1)" && wrc=0 || wrc=$?
  if [ "$wrc" = "0" ]; then
    grn "  PASS  unmutated provisioner: write suite green in $WSTAGE"; pass=$((pass+1))
  else
    red "  FAIL  the write suite is ALREADY RED in staging (rc=$wrc) — every mutation"
    red "        below would go red for that reason instead of the mutation."
    printf '%s\n' "$wbase" | grep -E 'FAIL' || true
    exit 1
  fi
  if grep -qE 'passed 0,' <<<"$wbase"; then
    red "  FAIL  write baseline ran ZERO assertions"; exit 1
  else
    grn "  PASS  write baseline ran $(printf '%s' "$wbase" | grep -oE 'passed [0-9]+' | head -1) assertions"; pass=$((pass+1))
  fi

  # wmutate <name> <old> <new> <case...>   — same contract as mutate(), against the
  # staged provisioner. `--json`/`node --check` do not apply; bash -n is the parse gate.
  wmutate() {
    local name="$1" old="$2" new="$3"; shift 3
    cp "$ROOT/org_provisioner.sh" "$WSTAGE/org_provisioner.sh"
    OLD="$old" NEW="$new" F="$WSTAGE/org_provisioner.sh" python3 - <<'PY' || { red "  FAIL  $name: mutation did not apply — the source moved, so this gate asserts nothing"; fail=$((fail+1)); return; }
import os, sys
f = os.environ["F"]; old = os.environ["OLD"]; new = os.environ["NEW"]
s = open(f).read()
if s.count(old) != 1:
    print(f"mutation target appears {s.count(old)} times, expected exactly 1", file=sys.stderr)
    sys.exit(1)
open(f, "w").write(s.replace(old, new))
PY
    if ! bash -n "$WSTAGE/org_provisioner.sh" 2>/dev/null; then
      red "  FAIL  $name: the mutation broke the parse; it would fail for the wrong reason"
      fail=$((fail+1)); return
    fi
    local out rc=0
    out="$("$WSTAGE/test_grant_write_attribution.sh" 2>&1)" || rc=$?
    if [ "$rc" = "0" ]; then
      red "  FAIL  $name: write suite stayed GREEN with this limb removed"
      fail=$((fail+1)); return
    fi
    local case_name ok=1
    for case_name in "$@"; do
      if grep -qF "FAIL $case_name" <<<"$out"; then :; else
        red "  FAIL  $name: suite went red, but NOT on the case that claims to cover it:"
        red "        expected a red on: $case_name"
        ok=0
      fi
    done
    if [ "$ok" = "1" ]; then grn "  PASS  $name"; pass=$((pass+1)); else fail=$((fail+1)); fi
  }

  # W1. THE WHOLE POINT. Drop the column from the INSERT and every new grant is
  #     anonymous again — the pre-fix state, which produced 25 unrecoverable rows.
  wmutate "granted_by_user_id dropped from the grants INSERT" \
    "INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key, scope, granted_by_user_id)" \
    "INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key, scope)" \
    "the grants INSERT names the granted_by_user_id column"

  # W2. THE ACTIVITY ROW, which is the ONLY attribution that can name an AGENT. The
  #     grants table's column is user-typed; without this row an agent-initiated grant
  #     is anonymous forever no matter what the column says.
  #     The mutation renames the TARGET TABLE rather than deleting the statement: an
  #     assertion that merely substring-matched "INSERT INTO activity_log" would still
  #     pass here, so this also proves the suite anchors the table name.
  wmutate "the activity_log row written to a different table" \
    $'INSERT INTO activity_log\n' \
    $'INSERT INTO activity_log_archive\n' \
    "an activity_log row accompanies the grants"

  # W3. THE ACTION STRING. Changing it keeps every row written and makes all of them
  #     invisible to scripts/grant_attribution.js — a silent, total loss of the audit
  #     with no failure anywhere. This is the subtlest way the fix stops working.
  wmutate "the activity action changed to one the reader does not recognise" \
    "'agent.permissions_updated', 'agent', :'agent_id'," \
    "'agent.grants_applied', 'agent', :'agent_id'," \
    "...with an action the attribution join recognises"

  # W4. THE REFUSAL, defaulted instead. A default requesting-agent is the exact edit
  #     that reintroduces anonymous rows the first time a call site forgets the
  #     argument, and it fails silently and permanently.
  wmutate "a missing requesting agent defaulted instead of refused" \
    '  [[ -n "$requested_by" ]] || die "apply_exact_grants: refusing to write grants with no requesting agent (an unattributed grant is unrecoverable)."' \
    '  [[ -n "$requested_by" ]] || requested_by="00000000-0000-0000-0000-000000000000"' \
    "a missing requesting agent -> REFUSED" \
    "...and no write transaction reached the database"

  # W5. THE OWNER-COUNT GUARD, relaxed to "take the first". Attributing a grant to the
  #     wrong human is worse than the null this change removes, and on a one-owner
  #     board the mutation is invisible — which is when it gets made.
  wmutate "an ambiguous owner resolved by taking the first row" \
    '  [[ "$n" == "1" ]] || die "cannot resolve the operator user id: found $n active owners for this company. Set PROVISIONER_OPERATOR_USER_ID explicitly."' \
    '  rows="$(head -1 <<<"$rows")"' \
    "two owners -> REFUSED rather than picking one" \
    "zero owners -> REFUSED, no grant written"

  # W7. THE CALL-SITE GUARD. §9 is the assertion that catches a forgotten argument
  #     BEFORE anyone runs the provisioner against a real database, and it is the one
  #     limb here that lives in the suite rather than the function.
  wmutate "a call site drops the requesting agent" \
    'apply_exact_grants "$target_id" '"'"'[]'"'"' "$caller_id"' \
    'apply_exact_grants "$target_id" '"'"'[]'"'"'' \
    "no call site passes only two arguments"

  # W6. THE TRANSACTION. Splitting the attribution into a SECOND transaction looks like
  #     a harmless reordering and reintroduces the defect on any partial failure: the
  #     grant lands, its attribution does not. Note the mutation splits rather than
  #     deletes — deleting the COMMIT would be caught by the parse/1-COMMIT check for a
  #     reason that has nothing to do with atomicity, and would prove less.
  wmutate "attribution split into a second transaction" \
    $'\n-- The recovery row.' \
    $'\nCOMMIT;\nBEGIN;\n-- The recovery row.' \
    "the write is a single transaction" \
    "grants and activity_log are inside the same BEGIN/COMMIT"

  # W7. THE EXTRACTION ITSELF — the failure mode unique to this suite's design. Rename
  #     the function upstream and a naive suite extracts nothing, defines nothing, and
  #     passes everything. It must FATAL instead. This one asserts a specific exit code
  #     rather than a named red, because the suite must die before it scores anything.
  cp "$ROOT/org_provisioner.sh" "$WSTAGE/org_provisioner.sh"
  python3 - "$WSTAGE/org_provisioner.sh" <<'PY'
import sys
f = sys.argv[1]; s = open(f).read()
s = s.replace("apply_exact_grants() {", "apply_grants_renamed() {", 1)
open(f, "w").write(s)
PY
  eout="$("$WSTAGE/test_grant_write_attribution.sh" 2>&1)" && erc=0 || erc=$?
  if [ "$erc" = "2" ] && grep -q "could not extract apply_exact_grants" <<<"$eout"; then
    grn "  PASS  a renamed function makes the suite FATAL, not silently green"; pass=$((pass+1))
  else
    red "  FAIL  a renamed apply_exact_grants did not produce the extraction FATAL"
    red "        rc=$erc — a suite that extracts nothing tests nothing and passes"
    fail=$((fail+1))
  fi

  cp "$ROOT/org_provisioner.sh" "$WSTAGE/org_provisioner.sh"
  if "$WSTAGE/test_grant_write_attribution.sh" > "$WSTAGE/restored.txt" 2>&1; then
    grn "  PASS  restored provisioner is green again"; pass=$((pass+1))
  else
    red "  FAIL  the restored provisioner is red; the staging dir was corrupted"
    cat "$WSTAGE/restored.txt"; fail=$((fail+1))
  fi
fi

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ] || exit 1
