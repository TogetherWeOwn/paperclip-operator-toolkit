#!/usr/bin/env bash
# =====================================================================================
# tog-998-mutation-gate.sh — proof that test_deploy_window_manifest.py is not vacuous.
#
# The suite it guards is 13 green assertions about the deploy-window gate, which is
# worth nothing until somebody breaks the gate and watches them go red. Each mutation
# below removes exactly ONE limb from a staged copy and asserts the NAMED case reddens.
# The unmutated copy is asserted green FIRST, in the same staging directory: "the
# mutated suite failed" is unattributable without it, because a staging error produces
# the same red.
#
# WHY EACH LIMB HERE IS AT REAL RISK, which is the only justification for a mutation:
#
#   1. THE DESCENDANCY DISCRIMINATOR is the whole TOG-998 defect, and it is the
#      reading a careful person arrives at unaided: "HEAD is past the pin, so the
#      line advanced, so re-cut." Measured on the real staging tree it is wrong
#      7/7 — every red was a stray checkout of a DESCENDANT feature commit, and
#      re-cutting would have pinned the operator script to that feature branch.
#      This is mutant #8, the case TOG-998 asked for.
#
#   2. THE INVERTED PRESENCE TEST is a one-token slip (`== 0` -> `!= 0`) that
#      silently swaps the two repairs: strays get told to re-cut and genuinely
#      rewritten trees get told to check out a commit that is not there.
#
#   3. COLLAPSING THE TWO STATES back to one TREE_DRIFT restores the original bug
#      wholesale. It is the obvious "simplify this enum" cleanup.
#
#   4. THE OPERATOR WORDING is the actual deliverable — a human reads the printed
#      line, not the state name. Re-introducing "re-cut it" on the stray path is
#      how the fix regresses while every state assertion stays green.
#
#   5. THE HASH-BEATS-TREE ORDERING (TOG-992) is load-bearing and adjacent to the
#      code being changed here: if a tree verdict can overwrite a hash verdict, a
#      tampered script goes green, which is the exact failure the gate exists for.
#
#   6. THE PRESENCE CHECK'S COMMIT PEEL (`^{commit}`) looks redundant. Without it a
#      stale ref or a tag-shaped object answers "present" and a genuinely gone pin
#      is reported as a stray checkout.
#
#   7. TREE_UNREADABLE DEGRADATION keeps an unreadable tree from being reported as
#      a confident repair instruction.
#
#   ./verification/tog-998-mutation-gate.sh
#
# Exit 0 = every mutation was detected by the case that claims to cover it.
# =====================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

reset_stage() {
  cp "$ROOT/deploy_window_manifest.py" "$STAGE/"
  cp "$ROOT/test_deploy_window_manifest.py" "$STAGE/"
}
reset_stage

run_suite() {
  (cd "$STAGE" && python3 -m unittest -v test_deploy_window_manifest.py)
}

baseline="$(run_suite 2>&1)" || {
  printf 'FAIL: unmutated suite is already red\n%s\n' "$baseline" >&2
  exit 1
}
baseline_count="$(printf '%s\n' "$baseline" | grep -oE 'Ran [0-9]+ tests' | grep -oE '[0-9]+' | tail -1)"
[[ -n "$baseline_count" && "$baseline_count" -gt 0 ]] || { echo 'FAIL: baseline ran zero tests' >&2; exit 1; }
printf 'PASS: baseline green, %s tests\n' "$baseline_count"

# mutate <name> <file> <old> <new> <expected-failing-test>
mutate() {
  local name="$1" file="$2" old="$3" new="$4" expected="$5"
  reset_stage
  OLD="$old" NEW="$new" FILE="$STAGE/$file" python3 - <<'PY'
import os, pathlib, sys
path = pathlib.Path(os.environ["FILE"])
source = path.read_text()
old = os.environ["OLD"]
count = source.count(old)
if count != 1:
    print(f"mutation target appears {count} times, expected exactly 1", file=sys.stderr)
    raise SystemExit(1)
path.write_text(source.replace(old, os.environ["NEW"]))
PY
  python3 -m py_compile "$STAGE/$file"
  local output rc=0 count
  output="$(run_suite 2>&1)" || rc=$?
  count="$(printf '%s\n' "$output" | grep -oE 'Ran [0-9]+ tests' | grep -oE '[0-9]+' | tail -1 || true)"
  # The mutant must FAIL, must still run the whole suite (not error out early),
  # and must be caught by the NAMED case -- not merely by something.
  if [[ "$rc" -eq 0 || "$count" != "$baseline_count" || "$output" != *"$expected"* ]]; then
    printf 'FAIL: %s was not caught by %s\n%s\n' "$name" "$expected" "$output" >&2
    exit 1
  fi
  printf 'PASS: %s -> caught by %s\n' "$name" "$expected"
}

# 1. MUTANT #8, the case TOG-998 asked for: decide by descendancy instead of by
#    whether the pin is still reachable. This is the original defect restored.
mutate descendancy-discriminator deploy_window_manifest.py \
  '    return "TREE_STRAY_CHECKOUT" if present else "TREE_PIN_GONE"' \
  '    return "TREE_PIN_GONE" if is_ancestor(tree, expected, live) else "TREE_STRAY_CHECKOUT"' \
  test_stray_checkout_of_a_descendant_is_not_a_recut

# 2. Invert the presence test.
mutate inverted-presence deploy_window_manifest.py \
  '        return None
    return done.returncode == 0


# WHY PIN-PRESENCE' \
  '        return None
    return done.returncode != 0


# WHY PIN-PRESENCE' \
  test_stray_checkout_of_a_descendant_is_not_a_recut

# 3. Collapse the split back into one state.
mutate collapsed-states deploy_window_manifest.py \
  '                row["state"] = classify_drift(tree, expected, live)' \
  '                row["state"] = "TREE_STRAY_CHECKOUT"' \
  test_unreachable_pin_is_the_only_recut

# 4. Regress only the operator-facing words, leaving every state correct.
mutate recut-wording deploy_window_manifest.py \
  '                print("          the pinned commit is STILL PRESENT in this tree:"' \
  '                print("          re-cut it"); print("          _"' \
  test_stray_checkout_advice_never_says_recut

# 5. Let a tree verdict overwrite a hash verdict (the TOG-992 guarantee).
mutate hash-verdict-overwritten deploy_window_manifest.py \
  '            if not ok:' \
  '            if False:' \
  test_tampered_superseded_script_stays_red

# 6. Drop the commit peel from the presence check.
mutate missing-commit-peel deploy_window_manifest.py \
  '            ["git", "-C", str(tree), "cat-file", "-e", f"{rev}^{{commit}}"],' \
  '            ["git", "-C", str(tree), "cat-file", "-e", rev],' \
  test_a_present_non_commit_object_is_not_a_checkout_target

# 7. Stop degrading an unreadable tree.
mutate unreadable-degradation deploy_window_manifest.py \
  '            elif live is None:
                row["state"] = "TREE_UNREADABLE"' \
  '            elif live is None and False:
                row["state"] = "TREE_UNREADABLE"' \
  test_unreadable_tree_degrades_not_crashes

printf '\nPASS: %s mutations detected, each by its named case\n' 7
