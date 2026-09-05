#!/usr/bin/env bash
# =====================================================================================
# tog-1002-built-card-mutation-gate.sh — do the BUILT-card tests actually catch anything?
#
# WHY THIS EXISTS
# ---------------
# TOG-1002 enrolled TOG-586 in the deploy window as a BUILT card: an artifact the
# operator builds on the host from a pinned revision, with nothing staged to hash. The
# new tests in test_deploy_window_manifest.py pass. That is not evidence they work —
# a suite that asserts nothing also passes.
#
# This gate damages the gate under test in ways a careless edit or a "helpful" cleanup
# genuinely would, and asserts the suite NOTICES each one. The mutants are chosen from
# the specific mistakes this change could plausibly attract:
#
#   1. The pin is realigned to ee6a85be — the exact wrong commit TOG-979's title names,
#      which is not an ancestor of main and whose preflight demands a binary absent from
#      this host. This is the failure the pin exists to prevent.
#   2. A broken built pin is downgraded to green, so a bad revision stops failing the
#      window.
#   3. BUILT_UNREADABLE is collapsed into BUILT_PIN_GONE — the right red with the WRONG
#      repair advice, the TOG-998 failure mode. This one is here because the first
#      implementation of this change had exactly that defect and the suite caught it.
#   4. The operator's "do NOT build ee6a85be" warning is deleted, leaving a bare
#      revision that does not steer anyone away from the trap.
#   5. Built cards stop being evaluated at all — the original TOG-1002 defect, restored.
#
# A surviving mutant means the assertion that should have died on it is missing or
# vacuous. Fixtures are built in a temp dir; the shared workspace is never written.
#
#   exit 0  every mutant was killed
#   exit 1  a mutant survived
#   exit 2  could not evaluate (missing source, broken fixture)
# =====================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE_SRC="$HERE/deploy_window_manifest.py"
TEST_SRC="$HERE/test_deploy_window_manifest.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for f in "$GATE_SRC" "$TEST_SRC"; do
  [ -f "$f" ] || { echo "cannot evaluate: missing $f" >&2; exit 2; }
done

# The class under test. Running only it keeps a mutant's kill attributable to the
# BUILT assertions rather than to unrelated staged-card coverage.
CLASS="test_deploy_window_manifest.TestBuiltAtInstallTimeCards"

run_suite() { # dir -> exit code of the BUILT test class
  (cd "$1" && python3 -m unittest "$CLASS" >/dev/null 2>&1)
}

fixture() { # dir
  mkdir -p "$1/verification"
  cp "$GATE_SRC" "$1/deploy_window_manifest.py"
  cp "$TEST_SRC" "$1/test_deploy_window_manifest.py"
}

# --- control: unmutated source must PASS, or every kill below is meaningless ----------
CONTROL="$TMP/control"
fixture "$CONTROL"
if ! run_suite "$CONTROL"; then
  echo "cannot evaluate: the BUILT test class does not pass unmutated." >&2
  (cd "$CONTROL" && python3 -m unittest "$CLASS" 2>&1 | tail -20) >&2
  exit 2
fi
echo "control: unmutated BUILT suite passes"

killed=0
survived=0

mutant() { # name  sed-expression-or-python  description
  local name="$1"; shift
  local mutate="$1"; shift
  local desc="$1"
  local dir="$TMP/$name"
  fixture "$dir"

  if ! ( cd "$dir" && eval "$mutate" ); then
    echo "  [ERROR] $name: mutation command failed" >&2
    survived=$((survived + 1)); return
  fi

  # A mutation that changes nothing proves nothing — it would "survive" for the wrong
  # reason, or worse, be counted as killed by an unrelated flake.
  if cmp -s "$dir/deploy_window_manifest.py" "$CONTROL/deploy_window_manifest.py"; then
    echo "  [ERROR] $name: mutation was a no-op (source unchanged)" >&2
    survived=$((survived + 1)); return
  fi

  if run_suite "$dir"; then
    echo "  [SURVIVED] $name — $desc"
    survived=$((survived + 1))
  else
    echo "  [killed]   $name — $desc"
    killed=$((killed + 1))
  fi
}

echo
echo "mutants:"

# 1. The pin realigned to the wrong commit TOG-979's title names.
mutant realign-pin-to-ee6a85be \
  "sed -i 's/49374f556395126b24c1d9310c4d8728167ccd55/ee6a85be00000000000000000000000000000000/' deploy_window_manifest.py" \
  "revision pin changed to ee6a85be (TOG-979's wrong commit)"

# 2. A missing revision stops being a failure.
# Anchored on the assignment, not on a literal indent: an indentation-sensitive sed
# silently becomes a no-op when the code is reformatted, which reads as a survivor.
mutant pin-gone-turns-green \
  "python3 - <<'EOF'
import pathlib
p=pathlib.Path('deploy_window_manifest.py'); s=p.read_text()
old='row[\"state\"] = \"BUILT_PIN_GONE\"'
assert s.count(old)==1, s.count(old)
p.write_text(s.replace(old,'row[\"state\"] = \"BUILT_PIN_OK\"',1))
EOF" \
  "BUILT_PIN_GONE downgraded to BUILT_PIN_OK"

# 3. Unreadable repo collapsed into pin-gone: right red, wrong repair (TOG-998 shape).
mutant unreadable-collapsed-into-pin-gone \
  "python3 - <<'EOF'
import re,pathlib
p=pathlib.Path('deploy_window_manifest.py'); s=p.read_text()
s=s.replace('        if git_head(SOURCE_REPO) is None:\n            row[\"state\"] = \"BUILT_UNREADABLE\"\n        else:\n            present','        if False:\n            row[\"state\"] = \"BUILT_UNREADABLE\"\n        else:\n            present',1)
p.write_text(s)
EOF" \
  "repo-readability probe removed; unreadable repo reports BUILT_PIN_GONE"

# 4. The operator loses the warning that steers them off the trap.
mutant drop-ee6a85be-warning \
  "sed -i '/Do NOT build ee6a85be/d' deploy_window_manifest.py" \
  "the 'do NOT build ee6a85be' operator warning deleted"

# 5. The original TOG-1002 defect restored: built cards never evaluated.
mutant built-cards-not-evaluated \
  "python3 - <<'EOF'
import pathlib
p=pathlib.Path('deploy_window_manifest.py'); s=p.read_text()
s=s.replace('    for row in evaluate_built():','    for row in []:',1)
p.write_text(s)
EOF" \
  "evaluate_built() results dropped — the card vanishes from the window again"

echo
echo "$killed mutant(s) killed, $survived survived"
if [ "$survived" -ne 0 ]; then
  echo "FAIL: a mutant survived — the BUILT assertions do not cover it."
  exit 1
fi
echo "PASS: every mutant was killed by the BUILT test class."
