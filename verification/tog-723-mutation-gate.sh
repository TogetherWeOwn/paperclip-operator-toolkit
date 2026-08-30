#!/usr/bin/env bash
# =====================================================================================
# tog-723-mutation-gate.sh — proof that test_plugin_deploy_drift.sh is not vacuous.
#
# The suite is 19 green assertions about a detector, and 19 green assertions are worth
# nothing until somebody breaks the detector and watches them go red. TOG-723 exists
# BECAUSE a green signal meant nothing: main was merged and CI was green for days while
# the route it added did not exist in the running system. Shipping a detector for that
# whose own tests are unfalsified would be the same mistake one level up.
#
# Each mutation below removes exactly ONE limb from a staged copy of the detector and
# asserts that the NAMED cases go red. The unmutated copy is asserted green FIRST, in
# the same staging directory: "the mutated suite failed" is unattributable without it,
# because a staging error produces the same red.
#
#   ./verification/tog-723-mutation-gate.sh
#
# Exit 0 = every mutation was detected by the case that claims to cover it.
# =====================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
SRC="$ROOT/plugin_deploy_drift.sh"
SUITE="$ROOT/test_plugin_deploy_drift.sh"
FIXTURE="$ROOT/tests/fixtures/tog723/plugins-rows.tsv"
[ -f "$SRC" ]     || { echo "FATAL: cannot find plugin_deploy_drift.sh above $HERE" >&2; exit 4; }
[ -f "$SUITE" ]   || { echo "FATAL: cannot find test_plugin_deploy_drift.sh above $HERE" >&2; exit 4; }
[ -f "$FIXTURE" ] || { echo "FATAL: cannot find the deployed-rows fixture" >&2; exit 4; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/tests/fixtures/tog723"
cp "$FIXTURE" "$STAGE/tests/fixtures/tog723/plugins-rows.tsv"
cp "$SRC"   "$STAGE/plugin_deploy_drift.sh"
cp "$SUITE" "$STAGE/test_plugin_deploy_drift.sh"
chmod +x "$STAGE"/*.sh

pass=0; fail=0
red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }

# --- BASELINE. Without this, every "the mutated suite went red" below is unattributable.
echo "=== baseline: the UNMUTATED copy passes in this same staging directory ==="
base_out="$("$STAGE/test_plugin_deploy_drift.sh" 2>&1)" && base_rc=0 || base_rc=$?
if [ "$base_rc" = "0" ]; then
  grn "  PASS  unmutated copy: suite green in $STAGE"; pass=$((pass+1))
else
  red "  FAIL  unmutated copy is ALREADY RED (rc=$base_rc) — every mutation below would"
  red "        go red for that reason instead of the mutation. Staging is broken."
  printf '%s\n' "$base_out" | grep -E 'FAIL' || true
  exit 1
fi
# A suite that scored zero assertions is not a green suite.
if printf '%s' "$base_out" | grep -qE ': 0 passed'; then
  red "  FAIL  baseline ran ZERO assertions — nothing below could be detected"; exit 1
else
  grn "  PASS  baseline ran $(printf '%s' "$base_out" | grep -oE '[0-9]+ passed' | head -1)"; pass=$((pass+1))
fi
echo

# mutate <name> <old-literal> <new-literal> <case-that-must-go-red>...
#
# The trailing arguments are case NAMES that must flip to FAIL. A mutation that merely
# makes the suite red SOMEWHERE is not evidence for the case under test — that is how a
# gate passes while the case it names covers nothing.
mutate() {
  local name="$1" old="$2" new="$3"; shift 3
  cp "$SRC" "$STAGE/plugin_deploy_drift.sh"; chmod +x "$STAGE/plugin_deploy_drift.sh"
  OLD="$old" NEW="$new" F="$STAGE/plugin_deploy_drift.sh" python3 - <<'PY' || { red "  FAIL  $name: mutation did not apply"; fail=$((fail+1)); return; }
import os, sys
f = os.environ["F"]; old = os.environ["OLD"]; new = os.environ["NEW"]
s = open(f).read()
if s.count(old) != 1:
    print(f"mutation target appears {s.count(old)} times, expected exactly 1", file=sys.stderr)
    sys.exit(1)
open(f, "w").write(s.replace(old, new))
PY
  local out rc=0
  # The suite colours its verdicts, so `FAIL` and the case name are separated by an
  # escape sequence and a literal "FAIL  <name>" never matches. Strip ANSI before
  # grepping — without this every assertion below is unsatisfiable and the gate reports
  # a vacuous suite for a reason that has nothing to do with the suite.
  #
  # Captured to a FILE and stripped afterwards, never `suite | sed`: in a pipeline the
  # status belongs to sed, which always succeeds, so the mutated suite would read as
  # exit 0 and every mutation would report "stayed GREEN". That is the same
  # false-green shape this whole gate exists to rule out.
  "$STAGE/test_plugin_deploy_drift.sh" > "$STAGE/out.raw" 2>&1 || rc=$?
  out="$(sed 's/\x1b\[[0-9;]*m//g' "$STAGE/out.raw")"
  if [ "$rc" = "0" ]; then
    red "  FAIL  $name: suite stayed GREEN with this limb removed — nothing covers it"
    fail=$((fail+1)); return
  fi
  local case_name ok=1
  for case_name in "$@"; do
    if printf '%s' "$out" | grep -qF "FAIL  $case_name"; then :; else
      red "  FAIL  $name: suite went red, but NOT on the case that claims to cover it:"
      red "        expected a red on: $case_name"
      ok=0
    fi
  done
  if [ "$ok" = "1" ]; then grn "  PASS  $name"; pass=$((pass+1)); else fail=$((fail+1)); fi
}

echo "=== each limb of the detector, removed one at a time ==="

# 1. THE ONE THE ISSUE NAMES. Route identity replaced by route COUNT. This is the
#    mutation the issue calls out by name: "a count check passes when one route is
#    swapped for another". If the swapped-route case does not go red here, the detector
#    is a count check wearing an identity check's comments.
mutate "route identity degraded to a route count" \
  '        for (r in rk) if (!(r in dk)) printf "MISSING\t%s\t-\t-\t-\n", r
        for (r in dk) if (!(r in rk)) printf "EXTRA\t%s\t-\t-\t-\n", r' \
  '        nrk = 0; ndk = 0
        for (r in rk) nrk++
        for (r in dk) ndk++
        if (nrk != ndk) printf "MISSING\t(count differs)\t-\t-\t-\n"' \
  "a swapped route is caught despite an identical count" \
  "a repo route that is not deployed is MISSING and exits 4"

# 2. The per-field comparison removed, leaving only the route NAME set. The route set is
#    identical when only `auth` changed, so this is silently green without a case
#    pinned to the field values.
mutate "per-field route comparison removed" \
  '          if (rv != dv) printf "CHANGED\t%s\t%s\t%s\t%s\n", p[1], p[2], rv, dv' \
  '          if (0) printf "CHANGED\t%s\t%s\t%s\t%s\n", p[1], p[2], rv, dv' \
  "a changed auth is CHANGED and exits 4" \
  "the changed auth report names both auth values"

# 3. `auth` dropped from the compared fields. Subtler than mutation 2: every other field
#    is still compared, so the suite stays green unless a case pins auth specifically.
#    This is exactly the vacuity that was live in test_plugin_manifest_gate.sh until its
#    own mutation gate caught it.
mutate "auth dropped from the compared route fields" \
  'ROUTE_FIELDS=(method path auth capability checkoutPolicy companyResolution)' \
  'ROUTE_FIELDS=(method path capability checkoutPolicy companyResolution)' \
  "a changed auth is CHANGED and exits 4" \
  "the changed auth report names both auth values"

# 4. THE SILENT-GREEN LIMB. An empty source read as zero plugins instead of a refusal.
#    "I measured nothing" and "I measured everything and it matched" must never share an
#    exit code — that conflation has hidden three defects on this board.
#
#    The named case is the `routes` one, NOT "an empty source refuses (exit 2)". `check`
#    has a later compared-0 backstop that exits 2 on its own, so the `check` case stays
#    green with this limb deleted and would testify to a refusal it is not measuring.
#    `routes` has no backstop: with the limb gone it exits 0 printing nothing.
mutate "an empty plugins source read as zero rows" \
  '  [ -s "$rows" ] || die "the plugins source returned no rows — nothing was measured. Source: $src"' \
  '  [ -s "$rows" ] || { printf 0 > "$WORK/deployed.count"; return 0; }' \
  "an empty source refuses on the routes surface too (exit 2)"

# 5. A row whose manifest does not parse, skipped rather than refused. A skipped plugin
#    is one the tool reports nothing about while exiting 0 — an unmonitored plugin that
#    looks monitored.
#
#    Named on the MIXED case for the same reason as mutation 4: when every row is broken,
#    skipping them all trips the "parsed zero plugins" guard and the all-broken case exits
#    2 regardless. Only a broken row alongside good ones reaches the silent skip — 2
#    compared, exit 0, one plugin absent from a report that looks complete.
mutate "an unparseable manifest_json skipped instead of refused" \
  '      || die "the deployed manifest_json for '"'"'$key'"'"' is empty or does not parse. Refusing rather than skipping it."' \
  '      || continue' \
  "one unparseable row among good ones still refuses, rather than being skipped"

# 6. The compared-nothing guard. With --only naming an absent plugin, zero comparisons
#    happen and the run would print a green summary about an empty set.
mutate "the compared-zero guard removed" \
  '    die "compared 0 plugins ($unpaired had no counterpart under $ref:$pdir). Nothing was measured."' \
  '    : ' \
  "--only with an unknown key refuses (exit 2)"

# 7. The IFS tab-collapse repair. Tab is an IFS whitespace character, so without the
#    \x1f translation the three rows with an empty package_path shift every later column
#    left and their manifests arrive empty. This mutation restores the original bug.
#    The named case is the BASELINE. With the repair gone, the three rows with an empty
#    package_path shift their columns left and their manifests arrive empty, so the
#    detector refuses on the very first plugin and `deployed == repo exits 0` — the case
#    that gives every other exit-0 assertion its meaning — turns into exit 2.
mutate "the IFS tab-collapse repair reverted" \
  "  tr '\\t' '\\037' < \"\$rows\" > \"\$rows.us\" && mv \"\$rows.us\" \"\$rows\"" \
  '  :' \
  "deployed == repo exits 0"

# 8. The key-order canonicaliser removed. This one is a FALSE-POSITIVE limb rather than
#    a missed-detection limb, and it matters just as much: jsonb reorders object keys on
#    every real comparison, so without this the detector shouts on every plugin every
#    run, and a detector that is mostly noise gets muted.
mutate "the jsonb key-order canonicaliser removed" \
  'out.push(key + "\t" + f + "\t" + JSON.stringify(canon(r[f] === undefined ? null : r[f])));' \
  'out.push(key + "\t" + f + "\t" + JSON.stringify(r[f] === undefined ? null : r[f]));' \
  "nested key reordering is not drift"

# 9. The both-sides-empty guard. If the route walker is ever broken by a refactor, BOTH
#    surfaces degenerate to nothing, every leaf compares equal, and the detector prints
#    OK about a comparison that measured none of the fields it exists to compare.
mutate "the zero-vs-zero guard removed" \
  '      die "both route surfaces for '"'"'$key'"'"' are empty — the extractor measured none of the fields this detector compares"' \
  '      : ' \
  "a plugin with zero routes on BOTH sides refuses rather than reporting OK"

echo
echo "=== the fixture guards: a stubbed fixture must not read as the real artifact ==="

# The suite's value rests on the fixture being the REAL deployed artifact. The issue is
# explicit that a hand-written stub has passed over two real defects here before. These
# two mutations replace the fixture rather than the detector, and assert the suite
# notices — otherwise the fixture could quietly rot into a stub and everything stays
# green.
fixture_mutate() {
  local name="$1" body="$2"; shift 2
  cp "$SRC" "$STAGE/plugin_deploy_drift.sh"; chmod +x "$STAGE/plugin_deploy_drift.sh"
  printf '%s' "$body" > "$STAGE/tests/fixtures/tog723/plugins-rows.tsv"
  local out rc=0
  "$STAGE/test_plugin_deploy_drift.sh" > "$STAGE/out.raw" 2>&1 || rc=$?
  out="$(sed 's/\x1b\[[0-9;]*m//g' "$STAGE/out.raw")"
  cp "$FIXTURE" "$STAGE/tests/fixtures/tog723/plugins-rows.tsv"
  if [ "$rc" = "0" ]; then
    red "  FAIL  $name: suite stayed GREEN on a degraded fixture"; fail=$((fail+1)); return
  fi
  local case_name ok=1
  for case_name in "$@"; do
    if printf '%s' "$out" | grep -qF "FAIL  $case_name"; then :; else
      red "  FAIL  $name: suite went red, but not on: $case_name"; ok=0
    fi
  done
  if [ "$ok" = "1" ]; then grn "  PASS  $name"; pass=$((pass+1)); else fail=$((fail+1)); fi
}

# A one-row fixture cannot exercise enumeration at all.
fixture_mutate "a single-row fixture is rejected" \
  "$(awk -F'\t' '$1=="gh-token-broker"' "$FIXTURE")" \
  "the fixture carries more than one deployed plugin row"

# A fixture where every package_path is populated — the shape a hand-written stub would
# have — no longer covers the IFS column-shift case that broke three of six real rows.
fixture_mutate "a fixture with no empty package_path is rejected" \
  "$(awk -F'\t' 'BEGIN{OFS="\t"} {if ($2=="") $2="/stub/path"; print}' "$FIXTURE")" \
  "the fixture has rows with an empty package_path"

echo
if [ "$fail" -gt 0 ]; then
  red "tog-723-mutation-gate: $pass passed, $fail FAILED"
  red "A limb of the detector can be removed without any test noticing. The suite is vacuous there."
  exit 1
fi
grn "tog-723-mutation-gate: $pass passed, 0 failed"
grn "Every limb removed was caught by the case that claims to cover it."
