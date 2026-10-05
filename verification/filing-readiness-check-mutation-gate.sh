#!/usr/bin/env bash
# =====================================================================================
# filing-readiness-check-mutation-gate.sh — proof that test_upstream_filing_readiness.sh is not vacuous.
#
# The suite is 22 green assertions about a four-gate readiness check, and 22 green
# assertions are worth nothing until somebody breaks the check and watches them go red.
#
# The stakes here are specific. This tool's output is the evidence under a RESERVED
# decision: it is what says "authorizing a filing today would execute nothing". If it
# silently degrades into a tool that reports four closed gates for the wrong reasons —
# or worse, reports them open — the owner spends a reserved decision on a measurement
# nobody falsified. An earlier incident already paid for authority granted against an unmeasured
# artifact. A gate built to prevent that recurrence, whose own tests are unfalsified,
# is the same mistake one level up.
#
# Each mutation below removes exactly ONE limb from a staged copy of the tool and
# asserts that the NAMED cases go red. The unmutated copy is asserted green FIRST, in
# the same staging directory: "the mutated suite failed" is unattributable without it,
# because a staging error produces the same red.
#
#   ./verification/filing-readiness-check-mutation-gate.sh
#
# Exit 0 = every mutation was detected by the case that claims to cover it.
# =====================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
SRC="$ROOT/upstream_filing_readiness.sh"
SUITE="$ROOT/test_upstream_filing_readiness.sh"
[ -f "$SRC" ]   || { echo "FATAL: cannot find upstream_filing_readiness.sh above $HERE" >&2; exit 4; }
[ -f "$SUITE" ] || { echo "FATAL: cannot find test_upstream_filing_readiness.sh above $HERE" >&2; exit 4; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$SRC"   "$STAGE/upstream_filing_readiness.sh"
cp "$SUITE" "$STAGE/test_upstream_filing_readiness.sh"
chmod +x "$STAGE"/*.sh

pass=0; fail=0
red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }

# --- BASELINE. Without this, every "the mutated suite went red" below is unattributable.
echo "=== baseline: the UNMUTATED copy passes in this same staging directory ==="
base_rc=0
"$STAGE/test_upstream_filing_readiness.sh" > "$STAGE/base.raw" 2>&1 || base_rc=$?
base_out="$(sed 's/\x1b\[[0-9;]*m//g' "$STAGE/base.raw")"
if [ "$base_rc" = "0" ]; then
  grn "  PASS  unmutated copy: suite green in $STAGE"; pass=$((pass+1))
else
  red "  FAIL  unmutated copy is ALREADY RED (rc=$base_rc) — every mutation below would"
  red "        go red for that reason instead of the mutation. Staging is broken."
  printf '%s\n' "$base_out" | grep -E 'FAIL' || true
  exit 1
fi
# A suite that scored zero assertions is not a green suite.
if grep -qE '  0 passed' <<<"$base_out"; then
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
  cp "$SRC" "$STAGE/upstream_filing_readiness.sh"; chmod +x "$STAGE/upstream_filing_readiness.sh"
  OLD="$old" NEW="$new" F="$STAGE/upstream_filing_readiness.sh" python3 - <<'PY' || { red "  FAIL  $name: mutation did not apply"; fail=$((fail+1)); return; }
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
  # exit 0 and every mutation would report "stayed GREEN". That is the same false-green
  # shape this whole gate exists to rule out.
  "$STAGE/test_upstream_filing_readiness.sh" > "$STAGE/out.raw" 2>&1 || rc=$?
  out="$(sed 's/\x1b\[[0-9;]*m//g' "$STAGE/out.raw")"
  if [ "$rc" = "0" ]; then
    red "  FAIL  $name: suite stayed GREEN with this limb removed — nothing covers it"
    fail=$((fail+1)); return
  fi
  local case_name ok=1
  for case_name in "$@"; do
    if grep -qF "FAIL  $case_name" <<<"$out"; then :; else
      red "  FAIL  $name: suite went red, but NOT on the case that claims to cover it:"
      red "        expected a red on: $case_name"
      ok=0
    fi
  done
  if [ "$ok" = "1" ]; then grn "  PASS  $name"; pass=$((pass+1)); else fail=$((fail+1)); fi
}

echo "=== each limb of the readiness gate, removed one at a time ==="

# 1. GATE A DEGRADED TO A LENGTH CHECK. The registry probe filters for entries the
#    CONSUMER would actually trust — exact key set, ed25519, and a PEM that parses.
#    Replacing that with `keys.length` scores a placeholder entry as a trusted
#    authorizer: the gate reports "an authorizer is provisioned" when nothing would
#    verify. This is the most likely way someone "fixes" this file while opening a hole.
#
#    The mutation is anchored on the LAST line of the filter plus the write, not on the
#    whole predicate body. A later fix rewrote that predicate (it had been reading
#    `publicKey`, a field no consumer reads) and this mutation silently stopped
#    applying — "mutation target appears 0 times", which the harness correctly reddens
#    rather than skipping. A narrower anchor keeps the mutation meaningful across edits
#    to the predicate it is protecting.
mutate "the authorizer usability filter degraded to an array length" \
  '    const ids = new Set(usable.map((k) => k.keyId));
    process.stdout.write(String(ids.size === usable.length ? usable.length : 0));' \
  '    process.stdout.write(String(v.keys.length));' \
  "a key entry with no public key does not count as a usable authorizer"

# 2. GATE B DEGRADED TO A ROUTE COUNT. The same mutation the deploy-drift gate exists for, one level
#    up: a count check passes when one route is swapped for another. Four routes before,
#    four after, and the gate reports the disclosure route deployed when it is not.
mutate "route identity degraded to a route count" \
  '  local missing=() r
  for r in "${REQUIRED_ROUTES[@]}"; do
    case " $deployed " in
      *" $r "*) ;;
      *) missing+=("$r") ;;
    esac
  done' \
  '  local missing=() r
  local ndep=0
  for r in $deployed; do ndep=$((ndep+1)); done
  [ "$ndep" -ge 4 ] || missing+=("(too few routes)")' \
  "a route swapped for another at unchanged count still closes route-deployed"

# 3. GATE C DEGRADED TO A GREP. The structural extraction is replaced by searching the
#    whole file for the word `actorSource`. This is the difference between "the host
#    propagates actorSource to the worker" and "the string appears somewhere in a
#    2000-line file" — two claims that happen to agree on today's host (the word occurs
#    zero times there, measured 2026-08-30) and come apart on any edit that names the
#    field without adding it to the dispatched actor. The host already computes it at
#    authz.js:176 via the same getActorInfo the plugin route calls, so that edit is
#    ordinary. The suite's decoy fixture is what holds this mutation down.
mutate "structural actor extraction degraded to a whole-file grep" \
  '  case " $keys " in
    *" actorSource "*)' \
  '  grep -q actorSource "$SERVER_ROUTES_FILE" && keys="actorSource"
  case " $keys " in
    *" actorSource "*)' \
  "actorSource on an unrelated route does not open actor-source"

# 4. GATE C's TOP-LEVEL-ONLY KEY WALK. Nested objects are skipped so a key inside a
#    nested literal is not mistaken for a key of the actor itself. Removing the depth
#    guard collects nested keys too, and the gate then reports actorSource propagated
#    when the actor the worker destructures still lacks it.
#
#    Pinned by the NESTED case, not the decoy case. The decoy puts the word on a
#    different route entirely, which the anchoring keeps out regardless of depth — it
#    would stay green here and testify to a guard it does not exercise. Only a key
#    nested INSIDE the actor literal reaches this guard.
mutate "the nesting depth guard removed from the actor key walk" \
  '      if (d === 0) {' \
  '      if (true) {' \
  "actorSource nested inside another object does not open actor-source"

# 5. GATE D FAIL-OPEN. An unreadable repository ceiling treated as "in scope" instead of
#    a refusal. This is the fail-open direction: the tool would report the destination
#    reachable having measured nothing about it.
mutate "an unset repository ceiling treated as in-scope" \
  '  [ -n "${ALLOWED_REPOS:-}" ] \
    || die "GH_APP_REPOS is unset or empty, so the repository ceiling could not be read. Measured nothing about destination scope."' \
  '  [ -n "${ALLOWED_REPOS:-}" ] || { record destination-scope open "no ceiling configured"; return 0; }' \
  "an unset GH_APP_REPOS refuses rather than assuming scope"

# 6. THE SILENT-GREEN LIMB. An empty plugins source read as zero rows instead of a
#    refusal. "I measured nothing" and "I measured everything and it is fine" must never
#    share an exit code — that conflation has hidden three defects on this board.
mutate "an empty plugins source read as zero rows" \
  '  [ -s "$rows" ] || die "the plugins source returned no rows — nothing was measured. Source: $src"' \
  '  [ -s "$rows" ] || { record route-deployed open "no rows"; return 0; }' \
  "an empty plugins source refuses (exit 2)"

# 7. A MISSING BROKER ROW SCORED AS A CLOSED GATE. "The broker is not installed at all"
#    and "the broker is installed without these routes" are different facts. Blurring
#    them reports a blocker that was never measured — wrong in the direction that looks
#    responsible, which is why it needs pinning.
mutate "a missing broker row scored as a closed gate rather than a refusal" \
  '  [ "$found" -eq 1 ] \
    || die "no deployed row for plugin '"'"'$PLUGIN_KEY'"'"' in the plugins source. Measured nothing about route deployment."' \
  '  [ "$found" -eq 1 ] || { record route-deployed closed "broker not installed"; return 0; }' \
  "a missing broker row refuses rather than reporting a closed route gate"

# 8. AN UNPARSEABLE DEPLOYED MANIFEST SKIPPED. A manifest that does not parse, scored
#    rather than refused, is a gate reported on evidence that was never read.
mutate "an unparseable deployed manifest scored instead of refused" \
  '    || die "the deployed manifest_json for '"'"'$PLUGIN_KEY'"'"' is empty or does not parse. Refusing rather than scoring it."' \
  '    || deployed=""' \
  "an unparseable deployed manifest refuses (exit 2)"

# 9. A MALFORMED REGISTRY SCORED AS CLOSED. Same shape as 7, on gate A: a registry whose
#    shape the probe does not understand must refuse, not be reported as "no keys".
mutate "a malformed authorizer registry scored as closed rather than refused" \
  '    || die "external_disclosure_authorizers.json at $REF is not the shape this gate reads ({version, keys[]}). Refusing rather than scoring it."' \
  '    || n=0' \
  "a registry with no keys[] refuses rather than scoring it closed"

# 10. THE IFS TAB-COLLAPSE REPAIR. Tab is an IFS whitespace character, so the rows are
#     translated to \x1f before being read. Removing that translation means the read
#     splits on a separator that is not in the data, so the ENTIRE line lands in `key`,
#     no row ever matches the broker, and the tool refuses.
#
#     Named on the BASELINE case, not on a refusal case, and the distinction matters:
#     several refusal cases below expect exit 2 already and would stay green while the
#     tool refused for a completely different reason. Only the baseline asserts the
#     all-open world is still readable, so only the baseline can testify that the row
#     parser still works.
mutate "the IFS tab-collapse repair removed" \
  "  tr '\\t' '\\037' < \"\$rows\" > \"\$rows.us\" && mv \"\$rows.us\" \"\$rows\"" \
  "  :" \
  "the all-open world exits 0" \
  "baseline: route-deployed is open"

# 11. THE ALL-FOUR-REPORTED GUARD. A probe that returns without recording is a gate
#     nobody measured, and scoring the run without it is the silent green this tool
#     exists to prevent.
#
#     The guard cannot be pinned by DELETING it: all four probes do record, so with the
#     guard gone the count is still 4 and nothing observable changes. That is not the
#     suite being vacuous — it is a backstop against a future edit, and a backstop is
#     invisible until the thing it backs up breaks. So it is mutated on its THRESHOLD
#     instead: with the guard demanding 3 records where 4 are written, it must fire and
#     refuse. That proves the guard is live, that its comparison is real, and that a
#     wrong record count genuinely stops the run rather than being reported.
mutate "the all-four-gates-reported guard demands the wrong count" \
  '  [ "$n" -eq 4 ] || die' \
  '  [ "$n" -eq 3 ] || die' \
  "the all-open world exits 0" \
  "baseline: authorizer-registry is open"

echo
echo "=== summary ==="
if [ "$fail" -eq 0 ]; then
  grn "  $pass check(s) passed, 0 failed — every limb is covered by the case that names it."
  exit 0
fi
red "  $pass passed, $fail FAILED — at least one limb of the readiness gate is not covered."
exit 1
