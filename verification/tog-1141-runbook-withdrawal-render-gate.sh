#!/usr/bin/env bash
# =====================================================================================
# Mutation gate for the WITHDRAWN rendering in the operator runbook generator.
#
# WHY THIS EXISTS
# ---------------
# TOG-703 (075b13e5) hand-edited the 🛑 NO-FORK withdrawal banner straight into
# docs/OPERATOR-RUNBOOK.md and never gave it a home in
# operator_runbook_classification.json. The doc is GENERATED. So the flow the
# file itself documents -- edit the JSON, `render >`, commit -- silently did two
# things at once:
#
#   1. deleted the owner's NO-FORK ruling (2026-09-05 05:07Z, TOG-847), and
#   2. UNCOMMENTED the prohibited command block underneath it, handing the next
#      operator a copy-pasteable route to a forbidden fork build.
#
# (2) is the one that hurts. A destroyed warning is visible in review; a
# re-armed command block reads like a normal runbook line.
#
# The `withdrawn` field (TOG-1140, d4c0b392) moves the banner into the
# generator. This gate proves the rendering is load-bearing rather than
# decorative, by deleting each branch of it and asserting the output goes wrong
# in the specific way that matters.
#
# WHAT TOG-1140 DID AND DID NOT DO -- read before editing a mutant.
# ----------------------------------------------------------------
# TOG-1140 stores the withdrawn section's `commands` string ALREADY COMMENTED,
# line by line, in the classification file. The renderer does not comment them
# out; it emits `v.commands` verbatim. So deleting `withdrawn` deletes the
# BANNER but leaves the block commented.
#
# That means the second hazard above is currently guarded by the literal bytes
# of one JSON string and by nothing else. Nothing ties the commenting to the
# withdrawal: re-pin `commands` from a pre-withdrawal source, or hand-edit a
# `#` off, and the block goes live while the banner still shouts above it.
# M2 is exactly that edit, and it is caught only because the render then stops
# matching the committed doc. Stated plainly so nobody reads M2's PASS as
# "the renderer suppresses the commands" -- it does not.
#
# A guard whose failure mode is "silently returns to green" has to be SHOWN to
# go red, or it is decoration -- same standard as tog-990.
#
#   exit 0  every mutant was caught, and the unmutated renderer still passes
#   exit 1  a mutant SURVIVED -- the withdrawal rendering does not guard
# =====================================================================================
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RENDERER="$HERE/operator_runbook.sh"
CLASSIFICATION="$HERE/operator_runbook_classification.json"
WORK="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-/tmp}/tog1141-render-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

ok()  { printf '  PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

# Render with a (possibly mutated) renderer + classification pair.
render_with() {
  local renderer="$1" classification="$2"
  bash "$renderer" render --classification "$classification" 2>&1
}

# The uncommented invocation of the withdrawn script. This exact line appearing
# at the start of a line inside the generated doc is the hazard: it is what an
# operator copy-pastes. Anchored, so the commented form (`# "$script"`) does not
# match it.
HAZARD='^"\$script"$'
BANNER='WITHDRAWN 2026-09-05 — DO NOT RUN ANY SCRIPT IN THIS SECTION'
# The second warning, printed on the "Exact commands." line itself, immediately
# above the fenced block. It is the one an operator sees when they have scrolled
# past the banner straight to the copy-pasteable part.
NOTE='WITHDRAWN — do not run these'

printf '== control: the unmutated renderer reproduces the committed doc\n\n'

control="$WORK/control.md"
render_with "$RENDERER" "$CLASSIFICATION" > "$control"

if diff -q "$HERE/docs/OPERATOR-RUNBOOK.md" "$control" >/dev/null; then
  ok 'control: render output is byte-identical to the committed runbook'
else
  bad 'control: render output already differs from the committed runbook'
  diff -u "$HERE/docs/OPERATOR-RUNBOOK.md" "$control" | head -30 | sed 's/^/         | /'
fi

grep -q "$BANNER" "$control" \
  && ok 'control: the NO-FORK withdrawal banner survives a render' \
  || bad 'control: the withdrawal banner is NOT in the rendered output'

grep -qE "$HAZARD" "$control" \
  && bad 'control: the prohibited invocation is live (uncommented) in the render' \
  || ok 'control: every command in the withdrawn section is commented out'

grep -q "$NOTE" "$control" \
  && ok 'control: the command block carries its own withdrawal note, not just the banner' \
  || bad 'control: the "Exact commands." line renders with no withdrawal note'

# The banner must precede the blast-radius line: it is the first thing read.
if awk '/^### 8\. TOG-516/{s=1} s&&/DO NOT RUN ANY SCRIPT/{print "banner";exit} s&&/^\*\*Blast radius/{print "blast";exit}' \
     "$control" | grep -qx banner; then
  ok 'control: the banner renders ABOVE the blast-radius line'
else
  bad 'control: the blast-radius line comes first; the banner is not the first thing read'
fi

printf '\n== mutants: each removes one load-bearing piece; the render must go wrong\n\n'

# ---- MUTANT 1: the actual accident. Drop `withdrawn` from the classification
# file entirely -- exactly the state main was in before TOG-1140, and exactly
# what a tidy-up of an "unused" key would produce. BOTH warnings must vanish:
# the banner at the top of the section AND the note on the command block.
m1c="$WORK/m1.json"
python3 - "$CLASSIFICATION" "$m1c" <<'PY'
import collections, json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src), object_pairs_hook=collections.OrderedDict)
d["items"]["TOG-516"].pop("withdrawn", None)
json.dump(d, open(dst, "w"), indent=2, ensure_ascii=False)
PY
m1="$WORK/m1.md"
render_with "$RENDERER" "$m1c" > "$m1"

grep -q "$BANNER" "$m1" \
  && bad 'M1 banner survived without the withdrawn field; it is coming from somewhere else' \
  || ok 'M1 withdrawn field deleted -> the owner ruling vanishes from the doc'

grep -q "$NOTE" "$m1" \
  && bad 'M1 the command-block note survived the field deletion; it is hardcoded somewhere' \
  || ok 'M1 confirms the second loss: the command block also loses its withdrawal note'

# ---- MUTANT 2: the hazard TOG-1140 does NOT structurally prevent. Leave
# `withdrawn` fully intact -- banner, note, everything -- and take a single `#`
# off the invocation line inside the `commands` string. This is what re-pinning
# `commands` from a pre-withdrawal source looks like byte for byte. The section
# still shouts WITHDRAWN twice while the block below it is copy-pasteable.
#
# Nothing in the renderer catches this. It is caught ONLY because the render
# then stops matching the committed doc -- i.e. by control #1, the drift gate.
# That is the whole standing of the "regenerated, not hand-edited" CI step, and
# it is why arming that step (TOG-1141) is load-bearing rather than tidy-up.
m2c="$WORK/m2.json"
python3 - "$CLASSIFICATION" "$m2c" <<'PY'
import collections, json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src), object_pairs_hook=collections.OrderedDict)
v = d["items"]["TOG-516"]
before = v["commands"]
v["commands"] = before.replace('# "$script"', '"$script"', 1)
assert v["commands"] != before, 'M2 anchor not found in commands; the mutant did not apply'
json.dump(d, open(dst, "w"), indent=2, ensure_ascii=False)
PY
m2="$WORK/m2.md"
render_with "$RENDERER" "$m2c" > "$m2"

if grep -qE "$HAZARD" "$m2" && ! diff -q "$HERE/docs/OPERATOR-RUNBOOK.md" "$m2" >/dev/null; then
  ok 'M2 one `#` removed -> the command goes LIVE and the render stops matching the doc'
elif ! grep -qE "$HAZARD" "$m2"; then
  bad 'M2 uncommenting the invocation did not produce a live command; the anchor is wrong'
else
  bad 'M2 the command went live and the render STILL matches the committed doc -- the drift gate is blind to it'
fi

# ---- MUTANT 3: neuter the command-block note branch in the renderer itself
# (the classic "both arms print the same thing, simplify" edit) while leaving
# the classification file intact. The top banner still renders, so a reviewer
# skimming for WITHDRAWN calls the diff harmless -- and the operator who scrolls
# straight to the commands gets no warning at all.
m3="$WORK/m3.sh"
python3 - "$RENDERER" "$m3" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
withdrawn_arm = '               then "**Exact commands.** \\(v.withdrawn.commands_note)\\n\\n```\\n\\(v.commands)\\n```\\n"'
plain_arm     = '               then "**Exact commands.**\\n\\n```\\n\\(v.commands)\\n```\\n"'
assert withdrawn_arm in text, 'M3 anchor not found; the note branch has moved'
open(dst, "w").write(text.replace(withdrawn_arm, plain_arm, 1))
PY
m3out="$WORK/m3.md"
if render_with "$m3" "$CLASSIFICATION" > "$m3out" 2>/dev/null \
   && [ -s "$m3out" ] && ! grep -q "$NOTE" "$m3out" && grep -q "$BANNER" "$m3out"; then
  ok 'M3 note branch removed -> the command block loses its warning while the banner still reads fine'
elif [ -s "$m3out" ] && grep -q "$NOTE" "$m3out"; then
  bad 'M3 removing the note branch changed nothing; something else is emitting the note'
else
  bad 'M3 mutant renderer failed to produce output; the mutation did not apply cleanly'
fi

# ---- MUTANT 4: move the banner below the blast-radius line. Withdrawal is the
# first fact about this section; buried under the metadata it is a footnote an
# operator scrolls past. Asserts the POSITION is load-bearing, not just presence.
m4="$WORK/m4.sh"
python3 - "$RENDERER" "$m4" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
start = text.index('      + (if (v.withdrawn // "") != ""')
end = text.index('      + "**Blast radius \\(v.blast)**"', start)
block = text[start:end]
rest = text[:start] + text[end:]
anchor = '      + "**What it changes.** \\(v.changes)\\n\\n"'
assert anchor in rest, 'M4 relocation anchor not found'
open(dst, "w").write(rest.replace(anchor, block + anchor, 1))
PY
m4out="$WORK/m4.md"
if render_with "$m4" "$CLASSIFICATION" > "$m4out" 2>/dev/null \
   && ! diff -q "$HERE/docs/OPERATOR-RUNBOOK.md" "$m4out" >/dev/null; then
  ok 'M4 banner demoted below the blast radius -> the committed-doc gate catches the move'
else
  bad 'M4 moving the banner produced an identical doc; position is not actually pinned'
fi

printf '\n== %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || { printf '\nA MUTANT SURVIVED: the withdrawal rendering does not guard.\n'; exit 1; }
printf '\nAll mutants caught: the withdrawal rendering has been shown to go red.\n'
