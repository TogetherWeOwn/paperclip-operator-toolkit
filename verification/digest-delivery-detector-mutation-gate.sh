#!/usr/bin/env bash
# =====================================================================================
# digest-delivery-detector-mutation-gate.sh — proof that test_discord_job_health.sh is not vacuous.
#
# The Discord daily digest has never posted. It read as HEALTHY in two consecutive
# write-ups because 37 of its 38 hourly rows are `succeeded` — the vendor's hour gate
# returns before doing any work. The detector written to catch that inherited a smaller
# version of the same hole: it inferred the digest's health from its FAILURE count, so
# it could only ever see a digest that died loudly.
#
# That distinction is not academic. Adding `plugin_config` rows for the other three
# companies removes every denial — and routes their issue and agent counts into OUR
# private #control-room through resolveChannel's defaultChannelId fallback. A detector
# scored on failures alone goes GREEN on that state, certifying a cross-company data
# leak as the fix. The delivery check is the only thing standing between those two
# readings, and it is exactly the limb a reasonable person would simplify away as
# redundant with the failure count.
#
# So each mutation below removes exactly ONE limb from a staged copy of the detector and
# asserts the NAMED cases go red. The unmutated copy is asserted green FIRST, in the
# same staging directory: "the mutated suite failed" is unattributable without it — a
# staging error produces the same red.
#
#   ./verification/digest-delivery-detector-mutation-gate.sh
#
# Exit 0 = every mutation was detected by the case that claims to cover it.
# =====================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
SRC="$ROOT/scripts/discord_job_health.js"
SUITE="$ROOT/test_discord_job_health.sh"
[ -f "$SRC" ]   || { echo "FATAL: cannot find scripts/discord_job_health.js above $HERE" >&2; exit 4; }
[ -f "$SUITE" ] || { echo "FATAL: cannot find test_discord_job_health.sh above $HERE" >&2; exit 4; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/scripts"
cp "$SRC" "$STAGE/scripts/discord_job_health.js"
cp "$SUITE" "$STAGE/test_discord_job_health.sh"
chmod +x "$STAGE/test_discord_job_health.sh" "$STAGE/scripts/discord_job_health.js"

pass=0; fail=0
red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }

# --- BASELINE. Without this, every "the mutated suite went red" below is unattributable.
echo "=== baseline: the UNMUTATED copy passes in this same staging directory ==="
base_out="$("$STAGE/test_discord_job_health.sh" 2>&1)" && base_rc=0 || base_rc=$?
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
  grn "  PASS  baseline ran $(printf '%s' "$base_out" | grep -oE 'passed [0-9]+' | head -1)"; pass=$((pass+1))
fi
echo

# mutate <name> <old-literal> <new-literal> <case-that-must-go-red>...
#
# The trailing arguments are case NAMES that must flip to FAIL. A mutation that merely
# makes the suite red SOMEWHERE is not evidence for the case under test — that is how a
# gate passes while the case it names covers nothing.
mutate() {
  local name="$1" old="$2" new="$3"; shift 3
  cp "$SRC" "$STAGE/scripts/discord_job_health.js"
  chmod +x "$STAGE/scripts/discord_job_health.js"
  OLD="$old" NEW="$new" F="$STAGE/scripts/discord_job_health.js" python3 - <<'PY' || { red "  FAIL  $name: mutation did not apply"; fail=$((fail+1)); return; }
import os, sys
f = os.environ["F"]; old = os.environ["OLD"]; new = os.environ["NEW"]
s = open(f).read()
if s.count(old) != 1:
    print(f"mutation target appears {s.count(old)} times, expected exactly 1", file=sys.stderr)
    sys.exit(1)
open(f, "w").write(s.replace(old, new))
PY
  # A mutation that breaks the parse would redden the suite for the wrong reason.
  if ! node --check "$STAGE/scripts/discord_job_health.js" 2>/dev/null; then
    red "  FAIL  $name: the mutation broke the parse; it would fail for the wrong reason"
    fail=$((fail+1)); return
  fi
  local out rc=0
  out="$("$STAGE/test_discord_job_health.sh" 2>&1)" || rc=$?
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

echo "=== each limb of the detector, removed one at a time ==="

# 1. THE ONE THAT MATTERS MOST, and the exact shape of the bug as it shipped: score the
#    gated job on its failure count and call a clean-but-silent digest "UNPROVEN" at
#    exit 0. This is what a revert produces, and it is what goes green on the forbidden
#    cross-company config workaround.
mutate "delivery not required — clean runs read as green" \
  '      } else if (delivered > 0) {
        verdict = "healthy";
      } else {
        verdict = "NOT_DELIVERED";
      }' \
  '      } else {
        verdict = "UNPROVEN (gated: succeeded rows may be no-ops)";
      }' \
  "clean runs + zero sends -> NOT_DELIVERED" \
  "and it does NOT read healthy"

# 2. The opposite error, and the reason §3 of the suite exists: a detector hardcoded to
#    distrust every gated job satisfies §2 while measuring nothing at all.
mutate "delivery never believed — a real send still reads broken" \
  '      } else if (delivered > 0) {
        verdict = "healthy";' \
  '      } else if (false) {
        verdict = "healthy";' \
  "one send metric -> healthy, exit 0"

# 3. Zero-of-zero folded into a pass. A window containing no scheduled send says nothing
#    about delivery; reading it as success is how a monitor reports green while blind.
mutate "an unmeasurable window read as a pass" \
  '      } else if (opportunities === 0) {' \
  '      } else if (false) {' \
  "no send opportunity -> exit 5 UNKNOWN"

# 4. The null-error hole. `plugin_job_runs` currently has no failed row with a null
#    error, so nothing in production would reveal this — but a failed run whose error
#    text is absent is still a failure, and scoring it "ok" reports a defect as a pass.
mutate "a failed run with no error text scored as a success" \
  '  if (!error) return "other";' \
  '  if (!error) return "ok";' \
  "failed+null error -> FAILING, exit 1" \
  "counted as a failure, not a success"

# 5. The refusal itself. The UNMEASURED verdict is worthless if it still exits 0 — the
#    distinction between "nothing to report" and "could not look" lives in the exit code
#    or nowhere. See the repo's standing rule: a check that measured nothing is not green.
mutate "the unmeasurable-window refusal exits zero" \
  '    process.exit(5);
  }
  const broken' \
  '    process.exit(0);
  }
  const broken' \
  "no send opportunity -> exit 5 UNKNOWN"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ] || exit 1
