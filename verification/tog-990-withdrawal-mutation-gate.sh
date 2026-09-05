#!/usr/bin/env bash
# =====================================================================================
# Mutation gate for the WITHDRAWN table (owner ruling 2026-09-05 05:07Z: no fork).
#
# WHY THIS EXISTS
# ---------------
# The withdrawal check is the only thing standing between an operator and
# TOG-916-operator-v5.sh, which builds a forked vendor image pinned to
# v2026.817.0 -- the version tonight's upgrade moves away from. Every hash in
# MANIFEST is still CORRECT for that script, so the pre-existing hash gate
# printed `[ok] TOG-916 OK` after the ruling landed. The bytes never drifted;
# the authorisation did.
#
# A guard whose failure mode is "silently returns to green" has to be shown to
# go red, or it is decoration. Each mutant below removes exactly one load-bearing
# piece and asserts the gate NOTICES.
#
# The important mutant is #1: it is the actual accident this guard exists for --
# someone tidies the "redundant" table away and the forbidden script goes green
# again. A gate that survives #1 is worthless no matter how many others pass.
#
#   exit 0  every mutant was caught, and the unmutated gate still passes
#   exit 1  a mutant SURVIVED -- the guard does not guard
# =====================================================================================
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$HERE/deploy_window_manifest.py"
WORK="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-/tmp}/tog990-withdraw-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

# Run a mutated copy of the gate; echo "<exit>|<stdout+stderr>".
run_mutant() {
  local src="$1" rc=0 out
  out="$(python3 "$src" 2>&1)" || rc=$?
  printf '%s|%s' "$rc" "$out"
}

check() {
  local name="$1" expect_rc="$2" expect_grep="$3" got="$4"
  local rc="${got%%|*}" out="${got#*|}"
  if [ "$rc" = "$expect_rc" ] && printf '%s' "$out" | grep -qE "$expect_grep"; then
    printf '  PASS  %s\n' "$name"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s\n         expected exit %s matching /%s/, got exit %s\n' \
      "$name" "$expect_rc" "$expect_grep" "$rc"
    printf '%s\n' "$out" | sed 's/^/         | /' | head -15
    fail=$((fail + 1))
  fi
}

printf '== control: the unmutated gate authorises ONLY the two cards the owner kept\n\n'

control="$(run_mutant "$GATE")"
check "control exits 0 (window still opens for the surviving cards)" \
  0 'VERDICT: READY' "$control"
check "control authorises TOG-881 and TOG-586, and says so explicitly" \
  0 'may be run: TOG-881, TOG-586' "$control"
check "control marks TOG-916 STOP, not ok" \
  0 '\[STOP\] TOG-916 +WITHDRAWN' "$control"

# A control that only checks the verdict line would pass even if the row said
# `ok`. Assert the forbidden card is NOWHERE described as runnable.
if printf '%s' "${control#*|}" | grep -qE '\[ok +\] TOG-(916|703|749|754|847)'; then
  printf '  FAIL  control: a withdrawn card is still rendered [ok]\n'
  fail=$((fail + 1))
else
  printf '  PASS  control: no withdrawn card is rendered [ok]\n'
  pass=$((pass + 1))
fi

printf '\n== mutants: each removes one load-bearing piece; the gate must notice\n\n'

# ---- MUTANT 1: the real accident. Delete the whole withdrawal short-circuit, as
# a tidy-up would. The hashes are untouched and still correct, so the gate must
# NOT be able to fall back to a clean green over the forbidden script.
m1="$WORK/m1.py"
python3 - "$GATE" "$m1" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
start = text.index("        if card in WITHDRAWN:")
end = text.index("        if not target.is_file():", start)
open(dst, "w").write(text[:start] + text[end:])
PY
check "M1 short-circuit deleted -> the pre-ruling state returns: 0 withdrawn, 6 staged" \
  0 '6 runnable staged card\(s\).*0 withdrawn by the owner' "$(run_mutant "$m1")"

# M1 asserts the mutant behaves DIFFERENTLY from the control (6 runnable, not 2).
# Spell the consequence out so the red is self-explaining.
m1out="$(run_mutant "$m1")"
if printf '%s' "${m1out#*|}" | grep -qE '\[ok +\] TOG-916'; then
  printf '  PASS  M1 confirms the danger: without the guard, TOG-916 renders [ok] = RUN THIS\n'
  pass=$((pass + 1))
else
  printf '  FAIL  M1 did not reproduce the hazard; the mutant may not be exercising the guard\n'
  fail=$((fail + 1))
fi

# ---- MUTANT 2: withdraw the runner but leave a superseded card enrolled. The
# gate would then print "DO NOT RUN — superseded by TOG-916's script" at an
# operator forbidden to run TOG-916: advice to execute a forbidden artifact.
# This must be exit 2 (cannot evaluate), never a green with a footnote.
m2="$WORK/m2.py"
sed 's|^    "TOG-703": (\n|XXX|' "$GATE" > "$m2"
python3 - "$GATE" "$m2" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
# Drop TOG-703 from WITHDRAWN only, leaving it in SUPERSEDED_BY -> inconsistent.
block = re.search(
    r'WITHDRAWN: dict\[str, tuple\[str, str\]\] = \{.*?\n\}\n', text, re.S).group(0)
mutated = re.sub(
    r'    "TOG-703": \(\n(?:.*?\n)*?    \),\n', '', block, count=1)
open(dst, "w").write(text.replace(block, mutated))
PY
check "M2 runner withdrawn, superseded card left behind -> exit 2, names the fault" \
  2 'TOG-703 is superseded by TOG-916, but TOG-916 is WITHDRAWN' "$(run_mutant "$m2")"

# ---- MUTANT 3: neuter the invariant to always return None (the classic
# "make the check pass" edit). M2's inconsistency must then survive, proving the
# invariant -- not some incidental side effect -- is what caught it.
m3="$WORK/m3.py"
python3 - "$m2" "$m3" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
text = re.sub(
    r'(def withdrawal_invariant\(\) -> str \| None:\n(?:    ".*?"""\n)?)',
    r'\1    return None\n', text, count=1, flags=re.S)
# Robust fallback: inject an early return right after the docstring closes.
if "    return None\n" not in text.split("def withdrawal_invariant")[1][:400]:
    i = text.index("def withdrawal_invariant")
    j = text.index('"""', text.index('"""', i) + 3) + 3
    text = text[:j] + "\n    return None" + text[j:]
open(dst, "w").write(text)
PY
m3out="$(run_mutant "$m3")"
m3rc="${m3out%%|*}"
if [ "$m3rc" != "2" ]; then
  printf '  PASS  M3 neutered invariant lets M2 through (exit %s) — the invariant is what catches it\n' "$m3rc"
  pass=$((pass + 1))
else
  printf '  FAIL  M3 still exits 2; M2 was caught by something other than the invariant\n'
  fail=$((fail + 1))
fi

# ---- MUTANT 4: semantic, not string-matching. Keep the table and the
# short-circuit, but let a withdrawn card fall through when its file is present
# -- the plausible "only stop it if it is missing" bug. Must still not be [ok].
m4="$WORK/m4.py"
python3 - "$GATE" "$m4" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
text = text.replace(
    "        if card in WITHDRAWN:",
    "        if card in WITHDRAWN and not target.is_file():", 1)
open(dst, "w").write(text)
PY
m4out="$(run_mutant "$m4")"
if printf '%s' "${m4out#*|}" | grep -qE '\[ok +\] TOG-916'; then
  printf '  PASS  M4 "stop only when absent" reintroduces the [ok] on TOG-916 — caught by the control assertion\n'
  pass=$((pass + 1))
else
  printf '  FAIL  M4 did not change behaviour; the guard may not depend on the file check as believed\n'
  fail=$((fail + 1))
fi

printf '\n== %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || { printf '\nA MUTANT SURVIVED: the withdrawal guard does not guard.\n'; exit 1; }
printf '\nAll mutants caught: the withdrawal guard has been shown to go red.\n'
