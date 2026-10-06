#!/usr/bin/env bash
# =====================================================================================
# snapshot-redaction-mutation-gate.sh — proof that the snapshot-sections selftest is
# not vacuous.
#
# The suite it guards is 29 green assertions about the two redaction builders that feed
# the world-readable operator snapshot file. Green is worth nothing until somebody
# breaks the redaction and
# watches it go red. Each mutation below reverts exactly ONE of the five review fixes in
# a THROWAWAY COPY and asserts the NAMED check reddens.
#
# The unmutated copy is asserted green FIRST, in the same staging directory: "the
# mutated suite failed" is unattributable without that baseline, because a staging error
# (a bad copy, a missing interpreter) produces an identical red. That baseline
# discipline exists because gates have passed for months proving nothing.
#
# Parse and cmp checks guard the other direction. A mutation whose anchor has DRIFTED
# edits nothing, the suite stays green, and a gate that reads "green means the mutation
# was caught" would report success having tested nothing — the exact false green this
# office keeps finding. Here an anchor that no longer matches is a hard error.
#
# WHY EACH FIX IS AT REAL RISK, which is the only justification for a mutation:
#
#   1. THE MODELS DIGEST (review F1a). `models_digest` reads like belt-and-braces beside
#      the _WARNING right under it, and deleting it leaves the warning in place — so the
#      output still LOOKS careful. But the warning names only the TYPE, so two different
#      malformed step lists produce identical bytes: a wholesale rewrite of a combo's
#      steps then diffs as no-change against the snapshot channel. A false clean
#      baseline is the worst failure available to a proof channel, and this is the one
#      the reviewer's own suggested patch did not fix.
#
#   2. THE CONFIG DIGEST (review F1b). Same defect one function over, and the same
#      temptation: `config` as a list, as null, and absent all collapsing to `{}` is
#      invisible until the day a config is rewritten and the diff says nothing changed.
#      A remediation that fixes a class in one function and leaves it in its sibling is
#      a pattern this office has shipped before.
#
#   3. THE BUILD INTEGRITY GATE (review F1c). `--build` already refuses to emit on a
#      LEAK, so the second refusal — on an integrity warning, exit 3 — reads as
#      redundant defensive clutter. It is not: the leak gate protects confidentiality,
#      this one protects integrity. Without it a section that audits perfectly clean but
#      is EMPTY BY FAILURE gets appended to the world-readable channel and becomes
#      somebody's baseline. Deleting it is invisible on every clean input.
#
#   4. THE NON-ANTHROPIC CREDENTIAL SHAPES (review F2). The auditor started life
#      matching sk-/sk-ant- only. AWS, Google and Slack shapes look like scope creep in
#      a file about an Anthropic router — until a passthrough config carries one. The
#      auditor is the backstop behind the structural allowlist; a backstop that only
#      catches the shapes somebody already thought of is the allowlist again.
#
#   5. THE SPLIT-CANARY ASSERTION. The GitHub canary is assembled from
#      fragments so this file does not trip CI's own Secret scan. That split is the
#      standard way to make a suite vacuous: break the assembly and "no credential
#      survives redaction" passes by planting nothing a pattern can find. Check 2b is
#      what stops that, so it gets a mutation of its own.
#
# Usage: ./verification/snapshot-redaction-mutation-gate.sh
# Exit:  0 all mutations caught · 1 a mutation survived · 2 the baseline is broken
# =====================================================================================
set -uo pipefail

SRC="omniroute/snapshot_sections.py"
[ -r "$SRC" ] || { echo "::error::$SRC not readable from $PWD"; exit 2; }

mut="$(mktemp -d)"
trap 'rm -rf "$mut"' EXIT
mkdir -p "$mut/omniroute"
cp "$SRC" "$mut/omniroute/"
orig="$mut/omniroute/.orig"
cp "$SRC" "$orig"

# --- baseline -----------------------------------------------------------------------
# Asserted in the staging directory, not the worktree: a copy that is broken on arrival
# must fail HERE, where the message says so, rather than as an unattributable red below.
if ! (cd "$mut" && python3 "$SRC" --selftest > base.out 2>&1); then
  echo "::error::the UNMUTATED staging copy is red; mutations prove nothing"
  cat "$mut/base.out"
  exit 2
fi
echo "  baseline: staging copy is green ($(grep -c '  PASS' "$mut/base.out") checks)"

rc=0

# mutate <label> <owning-check-substring> <python-replacement-expression>
#
# The replacement runs against the pristine copy every time. Three guards stand between
# a mutation and a false green: the edit must CHANGE the file (cmp), the mutant must
# still PARSE (py_compile — a syntax error reddens every check and would let a mutation
# that tested nothing read as caught), and the named check must be the one that fails.
mutate() {
  local label="$1" owner="$2" script="$3"
  cp "$orig" "$mut/$SRC"

  MUT_PATH="$mut/$SRC" python3 -c "$script" || {
    echo "::error::$label — mutation script failed (anchor drifted?)"; return 1; }

  if cmp -s "$orig" "$mut/$SRC"; then
    echo "::error::$label — mutation changed nothing; the anchor has DRIFTED and this gate is testing the unmutated file"
    return 1
  fi
  if ! (cd "$mut" && python3 -m py_compile "$SRC" 2>/dev/null); then
    echo "::error::$label — mutant does not parse; a syntax error reddens everything and proves nothing"
    return 1
  fi

  local out; out="$(cd "$mut" && python3 "$SRC" --selftest 2>&1)"
  if [ -z "$(printf '%s' "$out" | grep -F 'SELFTEST FAILED')" ]; then
    echo "::error::$label — the suite stayed GREEN with the fix reverted"
    printf '%s\n' "$out" | tail -5
    return 1
  fi
  if [ -z "$(printf '%s' "$out" | grep -F "FAIL  $owner")" ]; then
    echo "::error::$label — suite went red, but NOT on its owning check '$owner'; something else caught it, so that check is still unproven"
    printf '%s\n' "$out" | grep -F 'FAIL' | head -5
    return 1
  fi
  echo "  ok: $label -> '$owner' goes red"
}

# 1. models digest (F1a) — drop the digest, KEEP the warning. The point is that the
#    warning alone does not make the row diffable.
mutate "F1a models_digest deleted (warning kept)" \
  "non-list models: a rewritten step list is not byte-identical" '
import os
from pathlib import Path
p = Path(os.environ["MUT_PATH"]); s = p.read_text()
needle = "        kept[\"models_digest\"] = _digest(models)\n"
if needle not in s: raise SystemExit("anchor missing: models_digest assignment")
p.write_text(s.replace(needle, "", 1))
' || rc=1

# 2. config digest (F1b) — collapse the non-dict branch back to a bare {}, which is
#    exactly the pre-review behaviour.
mutate "F1b non-dict config collapses to {} again" \
  "non-dict config is distinguishable from an empty one" '
import os, re
from pathlib import Path
p = Path(os.environ["MUT_PATH"]); s = p.read_text()
start = s.find("    if not isinstance(config, dict):")
if start < 0: raise SystemExit("anchor missing: non-dict config branch")
finish = s.find("    kept, dropped = _copy_allowed(config, CONFIG_SCALARS", start)
if finish < 0: raise SystemExit("anchor missing: end of non-dict config branch")
p.write_text(s[:start] + "    if not isinstance(config, dict):\n        return {}\n" + s[finish:])
' || rc=1

# 3. build integrity gate (F1c) — remove the exit-3 refusal in --build, leaving the
#    exit-1 leak gate untouched.
mutate "F1c --build integrity refusal removed" \
  "--build refuses to emit an empty-by-failure section" '
import os
from pathlib import Path
p = Path(os.environ["MUT_PATH"]); s = p.read_text()
start = s.find("        warnings = integrity_warnings(section)")
if start < 0: raise SystemExit("anchor missing: build integrity gate")
finish = s.find("        print(json.dumps(section, indent=1, sort_keys=True))", start)
if finish < 0: raise SystemExit("anchor missing: build emit line")
p.write_text(s[:start] + s[finish:])
' || rc=1

# 4. auditor credential shapes (F2) — drop the three non-Anthropic patterns.
mutate "F2 aws/google/slack shapes removed from SECRET_PATTERNS" \
  "auditor detects a aws credential shape" '
import os, re
from pathlib import Path
p = Path(os.environ["MUT_PATH"]); s = p.read_text()
out, dropped = [], 0
for line in s.splitlines(keepends=True):
    if re.search(r"\(\"(aws access key id|google api key|slack token)\"", line):
        dropped += 1
        continue
    out.append(line)
if dropped != 3: raise SystemExit(f"anchor missing: expected 3 shape lines, dropped {dropped}")
p.write_text("".join(out))
' || rc=1

# 5. the split canary — break the assembly so the planted value stops being
#    token-shaped. Check 2b is the only thing standing between this and a vacuous suite.
mutate "split GitHub canary assembly broken" \
  "the split GitHub canary is still token-shaped and still planted" '
import os
from pathlib import Path
p = Path(os.environ["MUT_PATH"]); s = p.read_text()
needle = "_GH_CANARY = \"gh\" \"p_\" + \"C\" * 32"
if needle not in s: raise SystemExit("anchor missing: _GH_CANARY assembly")
p.write_text(s.replace(needle, "_GH_CANARY = \"gh\" \"p_\" + \"C\" * 4", 1))
' || rc=1

# --- control ------------------------------------------------------------------------
# An all-kills run looks identical to a gate that is failing closed — every mutant red
# because the harness itself is broken. Restore the pristine copy and require it green
# again, so "5 mutations caught" means the mutations did it and not the staging.
cp "$orig" "$mut/$SRC"
if ! (cd "$mut" && python3 "$SRC" --selftest > restored.out 2>&1); then
  echo "::error::the RESTORED copy is red; this gate fails closed and its kills prove nothing"
  tail -5 "$mut/restored.out"
  exit 2
fi
echo "  control: restored copy is green again"

if [ $rc -eq 0 ]; then
  echo "snapshot-redaction-gate: all 5 review fixes are load-bearing"
else
  echo "::error::snapshot-redaction-gate: at least one review fix is NOT load-bearing"
fi
exit $rc
