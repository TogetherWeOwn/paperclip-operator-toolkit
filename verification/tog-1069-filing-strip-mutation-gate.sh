#!/usr/bin/env bash
# ===========================================================================
# tog-1069-filing-strip-mutation-gate.sh
#
# Is verification/upstream-bundle-filing-strip-gate.sh actually load-bearing?
#
# A gate that cannot be shown to go RED is not evidence. This suite plants a
# defect the strip gate CLAIMS to catch, runs it, and requires a non-zero
# exit for every one. A mutant that survives means the gate reports PASS on
# text carrying the defect.
#
# WHY MUTATE THE INPUT, NOT THE GATE
#
# Both are done here, deliberately, because they answer different questions:
#
#   INPUT mutants (M1-M4) ask "does the gate see a real defect?" They are the
#   ones that matter -- they reproduce the TOG-1069 failure and its cousins
#   in the artifact, and they keep working when the gate is refactored.
#
#   GATE mutants (M5-M6) ask "is this specific limb live, or is it dead code
#   passing for free?" Check 4 of the sibling bundle gate was dead once for
#   exactly this reason -- a line-anchored grep that could never match the
#   wrapped text it was written for, reporting ok forever. A limb that no
#   input can exercise is indistinguishable from an absent limb.
#
# EXIT CODES ARE ASSERTED EXACTLY. A mutant that "dies" by moving the gate
# from rc 1 to rc 2 has not been caught -- it has crashed the gate, and a
# crash is not a finding. Every kill below requires the gate's own failure
# code (1), not merely non-zero.
#
# Run from anywhere:  ./verification/tog-1069-filing-strip-mutation-gate.sh
# Exit 0 = every mutant killed and both controls behaved.
# ===========================================================================

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE_REL="verification/upstream-bundle-filing-strip-gate.sh"
GATE_SRC="$REPO_ROOT/$GATE_REL"

[ -f "$GATE_SRC" ] || { echo "FATAL: no gate at $GATE_SRC" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tog1069mut.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
kill_ok() { printf '  \033[32mKILLED\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
survived() { printf '  \033[31mSURVIVED\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
note()    { printf '           %s\n' "$1"; }

# Build a pristine sandbox: the gate plus the docs it reads. The gate resolves
# REPO_ROOT from its own location, so a copied tree is a complete fixture.
mkscene() {
  local dir="$1"
  rm -rf "$dir"; mkdir -p "$dir/verification" "$dir/docs/upstream"
  cp "$GATE_SRC" "$dir/verification/"
  cp "$REPO_ROOT"/docs/upstream/*.md "$dir/docs/upstream/"
  chmod +x "$dir/verification/$(basename "$GATE_REL")"
}

# Run the gate in a scene; echo its exit code.
run_scene() {
  ( cd "$1" && ./verification/upstream-bundle-filing-strip-gate.sh >"$1/.out" 2>&1; echo $? )
}

echo "TOG-1069 filing-strip gate mutation suite"
echo

# --- POSITIVE CONTROL -----------------------------------------------------
# Unmutated, the gate must PASS (rc 0). If this fails, every "kill" below is
# meaningless -- the gate would be red on everything, including the truth.
S="$WORK/control_pos"; mkscene "$S"
rc="$(run_scene "$S")"
if [ "$rc" -eq 0 ]; then
  kill_ok "CONTROL+  unmutated tree -> rc 0 (gate is green on the real fix)"
else
  survived "CONTROL+  unmutated tree -> rc $rc, expected 0. Gate is red on the truth; nothing below is evidence."
  sed 's/^/           | /' "$S/.out" | tail -12
fi

# --- NEGATIVE CONTROL -----------------------------------------------------
# The gate must be red on the ACTUAL pre-fix artifact -- not a synthetic
# mutant, the real README `main` shipped. This is the strongest single piece
# of evidence here: it is the defect as it existed, not as I imagine it.
S="$WORK/control_neg"; mkscene "$S"
if git -C "$REPO_ROOT" cat-file -e origin/main:docs/upstream/README.md 2>/dev/null; then
  git -C "$REPO_ROOT" show origin/main:docs/upstream/README.md > "$S/docs/upstream/README.md"
  rc="$(run_scene "$S")"
  if [ "$rc" -eq 1 ]; then
    kill_ok "CONTROL-  real pre-fix README from origin/main -> rc 1"
    note "$(grep -c FAIL "$S/.out") violation(s), incl. the superseded line-1 instruction"
  else
    survived "CONTROL-  real pre-fix README -> rc $rc, expected 1. The gate does NOT catch the defect it was written for."
  fi
else
  note "CONTROL-  skipped: origin/main not fetched in this checkout"
fi

# --- M1: the TOG-1069 defect itself ---------------------------------------
# Restore the superseded sentence alongside the new rule. This is the CEO's
# point 2 -- porting the rule without deleting the old instruction ships a
# README that contradicts itself, and a filer reading top-down hits the wrong
# instruction twenty lines first.
S="$WORK/m1"; mkscene "$S"
printf '\n%s\n' 'The `DRAFT — not filed` banner each one opens with is kept deliberately, and should be edited only by whoever actually files it.' \
  >> "$S/docs/upstream/README.md"
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M1  README re-adds the line-1-only instruction beside the rule" \
  || survived "M1  README re-adds the line-1-only instruction -> rc $rc, expected 1"

# --- M2: the rule is dropped entirely -------------------------------------
# The straight regression: someone reverts the README, or a merge drops the
# section. This is the state `main` was in.
S="$WORK/m2"; mkscene "$S"
awk '/^## How to strip a report before filing/{f=1} f&&/^## The reports/{f=0} !f' \
  "$S/docs/upstream/README.md" > "$S/.r" && mv "$S/.r" "$S/docs/upstream/README.md"
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M2  README loses the whole strip-rule section" \
  || survived "M2  README loses the strip-rule section -> rc $rc, expected 1"

# --- M3: a disclosure line BELOW the boundary -----------------------------
# The report-side defect: a filing-status sentence in the report BODY, where
# no strip removes it. Planted below the structural boundary so only
# assertion A can catch it. Uses a phrasing already in the pattern.
S="$WORK/m3"; mkscene "$S"
F="$S/docs/upstream/manifest-refresh-escalation.md"
b="$(grep -nE '^---[[:space:]]*$|^## ' "$F" | head -1 | cut -d: -f1)"
awk -v n="$((b + 4))" 'NR==n{print "Held with the others pending the operator'"'"'s decision."} {print}' \
  "$F" > "$S/.f" && mv "$S/.f" "$F"
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M3  disclosure line planted below the strip boundary" \
  || survived "M3  disclosure line below boundary -> rc $rc, expected 1"

# --- M4: the strip table loses a file -------------------------------------
# The rule without its table sends the filer back to eyeballing line numbers.
# This is also the check that proves B3 is scoped to the rule SECTION: the
# removed name still appears in the "## The reports" index below, so a
# whole-file match would pass this mutant.
S="$WORK/m4"; mkscene "$S"
sed -i '/^| `plugin-auth-surface.md` | 13/d' "$S/docs/upstream/README.md"
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M4  strip table drops plugin-auth-surface.md (name still in the index below)" \
  || survived "M4  strip table drops a file -> rc $rc, expected 1"

# --- M5: the single-# boundary trap ---------------------------------------
# GATE mutant. Widen the boundary pattern to `^#{1,2} `. Line 1 of every
# report is `# DRAFT ...`, so the boundary becomes line 1, the strip becomes
# a no-op, and every preamble survives. The gate must not report PASS while
# stripping nothing -- this is the exact mistake the README warns about, and
# a gate that makes it silently is worse than no gate.
S="$WORK/m5"; mkscene "$S"
# Edited in python, not sed: the anchor is dense with regex metacharacters and
# a sed that silently matched nothing would make this mutant a free pass.
# The assert below turns "anchor moved" into a hard error rather than a kill.
python3 - "$S/verification/upstream-bundle-filing-strip-gate.sh" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """grep -nE '^---[[:space:]]*$|^## '"""
new = """grep -nE '^---[[:space:]]*$|^#{1,2} '"""
assert s.count(old) >= 1, "M5 anchor not found -- the boundary pattern moved; re-derive this mutant"
open(p, "w").write(s.replace(old, new))
PY
rc="$(run_scene "$S")"
if [ "$rc" -eq 1 ]; then
  kill_ok "M5  boundary widened to ^#{1,2} (strip becomes a no-op on line 1)"
  note "killed by the in-band control: line-1-only leak and structural leak become the same set"
else
  survived "M5  boundary widened to ^#{1,2} -> rc $rc, expected 1"
fi

# --- M6: the superseded-instruction check is removed ----------------------
# GATE mutant against assertion B2 specifically -- the limb that encodes the
# actual TOG-1069 finding. Neuter it and re-run M1's input. If M1 still dies,
# it was dying on some other limb and B2 is dead code.
S="$WORK/m6"; mkscene "$S"
python3 - "$S/verification/upstream-bundle-filing-strip-gate.sh" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "should be edited only by whoever actually files it"
assert old in s, "M6 anchor not found -- B2's pattern moved; re-derive this mutant"
open(p, "w").write(s.replace(old, "ZZ_NEVER_MATCHES_ANYTHING_ZZ"))
PY
printf '\n%s\n' 'The `DRAFT — not filed` banner each one opens with is kept deliberately, and should be edited only by whoever actually files it.' \
  >> "$S/docs/upstream/README.md"
rc="$(run_scene "$S")"
if [ "$rc" -eq 0 ]; then
  kill_ok "M6  B2 neutered -> M1's input now PASSES, proving B2 is the limb that catches it"
else
  survived "M6  B2 neutered but gate still rc $rc -- M1 dies on some OTHER limb; B2 may be dead code"
  sed 's/^/           | /' "$S/.out" | grep FAIL | head -5
fi

echo
echo "-----------------------------------------------------------------"
if [ "$FAIL" -eq 0 ]; then
  echo "PASS  $PASS/$PASS mutants killed and controls behaved"
  exit 0
fi
echo "FAIL  $FAIL survived, $PASS killed"
exit 1
