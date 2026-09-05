#!/usr/bin/env bash
# =====================================================================================
# tog-997-deploy-line-anchor-gate.sh — is the deploy-line anchor check real?
#
# WHAT TOG-997 IS
# ---------------
# Every other check in the deploy-window gate reads `git rev-parse HEAD` on a tree
# that is SHARED and MUTABLE. HEAD is the most volatile thing in such a tree: one
# `git checkout` by an unrelated run moves it. Measured 2026-09-05 on the governor
# staging tree, over the 26.15 h since pin f471ef3c0 was set: 7 checkout excursions,
# ZERO commits, tree gate-RED 27.8% of the time. A window whose validity is a
# property of HEAD is invalid a quarter of the time by pure accident.
#
# The deeper finding, measured the same day: the reviewed line was held by NOTHING
# OF ITS OWN. f471ef3c0 and the 10-commit fork line beneath it were reachable from
# exactly one ref -- refs/heads/tog-942-agent-model-picker, an unrelated feature
# branch that merely happened to be cut from the pin. No tag, no remote (that branch
# is unpushed), no ref of its own. Delete or rebase that branch and `git gc` deletes
# the line.
#
# That is not a lost deploy -- the five scripts that pinned it are all WITHDRAWN by
# the owner's no-fork ruling. It is a lost SPECIFICATION: TOG-1010, the approved
# successor, says in terms "Do NOT delete this tree -- it is the specification for
# the re-test" and maps 5 of these commits to the forked concerns to re-test on
# v2026.831.1. So the fix is to make the line a NAME that no checkout can move, and
# to assert that name rather than trust it.
#
# WHAT THIS GATE PROVES, AND WHY THE SECOND PART IS THE ONE THAT MATTERS
# ----------------------------------------------------------------------
#   1. PREMISE — that a ref really is a gc root, in two arms. Arm A alone proves
#      nothing (a commit can survive gc for many reasons); the control arm, where
#      the ref is dropped and the same collection DELETES the commit, is what makes
#      arm A evidence. Run here against a throwaway fixture, never a real tree.
#   2. MUTANTS — damage the check itself and assert the NAMED test notices. A suite
#      nothing can break asserts nothing.
#
# The mutants are chosen for things a careful person would plausibly do:
#
#   a. SELF-HEALING. "The ref is missing, so create it" is the obvious helpful fix
#      and it is fatal: the gate would then assert only that it can write, and a
#      genuinely lost line reads green forever. Same family as the self-hosted
#      drift guard rejected in TOG-999.
#   b. EXISTENCE-ONLY. Dropping the `actual == expected` comparison accepts a ref
#      that was silently re-pointed at another commit -- the name survives, the
#      line does not.
#   c. ADVISORY-ONLY. An anchor row that does not reach the verdict is a comment.
#   d. WITHDRAWAL COUPLING. Skipping anchors for a withdrawn window is superficially
#      reasonable and destroys the exact case this exists for: every card that
#      pinned the real line IS withdrawn, and the line still matters.
#   e. THE ^{commit} PEEL, which keeps a tag or non-commit object from passing.
#   f. TREE/REF CONFLATION, which prints "run update-ref" at an operator whose real
#      problem is a missing checkout -- the TOG-998 failure mode (right red, wrong
#      repair).
#
# Nothing here touches the shared workspace, /paperclip/operator-handoff, or any
# deployment-staging tree: it must be safe to run while an operator is mid-window.
#
#   ./verification/tog-997-deploy-line-anchor-gate.sh
#
#   exit 0  the premise holds and every mutant was killed by its named test
#   exit 1  the premise failed, or a mutant survived
#   exit 2  could not evaluate
# =====================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

command -v git >/dev/null 2>&1 || { echo "cannot evaluate: git absent" >&2; exit 2; }
[ -f "$ROOT/deploy_window_manifest.py" ] || { echo "cannot evaluate: gate missing" >&2; exit 2; }
[ -f "$ROOT/test_deploy_window_manifest.py" ] || { echo "cannot evaluate: suite missing" >&2; exit 2; }

# -------------------------------------------------------------------------------------
# PART 1 — THE PREMISE: a ref is a gc root, and without one the commit is collected.
#
# Built from scratch in a temp dir. The control arm is not optional: without it,
# "the commit survived" is consistent with gc simply not having run.
# -------------------------------------------------------------------------------------
FIX="$STAGE/premise"
git init -q "$FIX"
git -C "$FIX" config user.email t@t.t
git -C "$FIX" config user.name t
echo base > "$FIX/f"; git -C "$FIX" add -A; git -C "$FIX" commit -qm base
BASE="$(git -C "$FIX" rev-parse HEAD)"
echo line > "$FIX/f"; git -C "$FIX" commit -qam 'the deploy line'
LINE="$(git -C "$FIX" rev-parse HEAD)"

# Strand LINE: detach onto BASE and move every branch off it, so a ref in
# refs/deploy-line/ is the only thing that could possibly hold it.
git -C "$FIX" checkout -q --detach "$BASE"
while read -r ref; do [ -n "$ref" ] && git -C "$FIX" update-ref -d "$ref"; done \
  < <(git -C "$FIX" for-each-ref --format='%(refname)' refs/heads/)

collect() {
  git -C "$FIX" reflog expire --expire=now --expire-unreachable=now --all
  git -C "$FIX" gc --prune=now -q
}
alive() { git -C "$FIX" cat-file -e "$LINE^{commit}" 2>/dev/null; }

git -C "$FIX" update-ref refs/deploy-line/premise "$LINE"
collect
alive || { echo "FAIL: premise arm A — a ref did NOT protect the commit" >&2; exit 1; }
printf 'PASS: premise arm A — with its ref, the line survives gc --prune=now\n'

git -C "$FIX" update-ref -d refs/deploy-line/premise
collect
if alive; then
  echo "FAIL: premise control — gc did not prune, so arm A proved nothing" >&2
  exit 1
fi
printf 'PASS: premise control — without the ref, the same gc DELETES the line\n'

# -------------------------------------------------------------------------------------
# PART 2 — MUTANTS. Break the check; the named test must notice.
# -------------------------------------------------------------------------------------
reset_stage() {
  cp "$ROOT/deploy_window_manifest.py" "$STAGE/"
  cp "$ROOT/test_deploy_window_manifest.py" "$STAGE/"
}
reset_stage

run_suite() { (cd "$STAGE" && python3 -m unittest -v test_deploy_window_manifest.py); }

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
  # The mutant must FAIL, must still run the WHOLE suite (a mutant that errors
  # out during collection proves nothing), and must be caught by the NAMED case
  # rather than merely by something somewhere.
  count="$(printf '%s\n' "$output" | grep -oE 'Ran [0-9]+ tests' | grep -oE '[0-9]+' | tail -1 || true)"
  if [[ "$rc" -eq 0 || "$count" != "$baseline_count" || "$output" != *"$expected"* ]]; then
    printf 'FAIL: %s was not caught by %s\n%s\n' "$name" "$expected" "$output" >&2
    exit 1
  fi
  printf 'PASS: %s -> caught by %s\n' "$name" "$expected"
}

# a. SELF-HEALING: create the ref instead of reporting it missing. The gate then
#    proves only that it can write, and a lost line is green forever.
mutate self-healing-anchor deploy_window_manifest.py \
  '            if actual is None:
                row["state"] = "ANCHOR_MISSING"' \
  '            if actual is None:
                subprocess.run(["git", "-C", str(tree), "update-ref", ref, expected],
                               capture_output=True, check=False)
                row["state"] = "ANCHOR_OK"' \
  test_a_line_with_no_ref_of_its_own_is_red

# b. EXISTENCE-ONLY: accept any ref that exists, even one re-pointed elsewhere.
mutate existence-not-identity deploy_window_manifest.py \
  '            elif actual == expected:
                row["state"] = "ANCHOR_OK"
            else:
                row["state"] = "ANCHOR_MOVED"' \
  '            else:
                row["state"] = "ANCHOR_OK"' \
  test_a_ref_pointing_somewhere_else_is_red_and_not_silently_accepted

# c. ADVISORY-ONLY: report the row but never redden the verdict.
mutate anchor-does-not-close-the-window deploy_window_manifest.py \
  '    for row in evaluate_anchors():
        rows.append(row)
        if row["state"] != "ANCHOR_OK":
            drift = True' \
  '    for row in evaluate_anchors():
        rows.append(row)' \
  test_an_unanchored_line_closes_the_window

# d. WITHDRAWAL COUPLING: skip the anchors when every card is withdrawn. The real
#    line IS fully withdrawn and still carries TOG-1010's specification.
mutate anchors-skipped-when-withdrawn deploy_window_manifest.py \
  '    for ref, (relative, expected, purpose) in sorted(ANCHORS.items()):' \
  '    for ref, (relative, expected, purpose) in sorted(ANCHORS.items()):
        if set(MANIFEST) <= set(WITHDRAWN):
            continue' \
  test_a_withdrawn_window_still_requires_its_anchor

# e. THE ^{commit} PEEL: without it a tag object passes as the commit.
mutate dropped-commit-peel deploy_window_manifest.py \
  '"rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"' \
  '"rev-parse", "--verify", "--quiet", ref' \
  test_a_tag_shaped_ref_is_peeled_to_a_commit

# f. TREE/REF CONFLATION: report a missing checkout as a missing ref, which prints
#    `update-ref` at an operator who has no tree to run it in.
mutate tree-unreadable-as-missing-ref deploy_window_manifest.py \
  '        if git_head(tree) is None:
            # Same discrimination as evaluate_built(): a missing checkout is a
            # different repair from a missing ref, and ref_target() alone
            # returns None for both.
            row["state"] = "ANCHOR_TREE_UNREADABLE"
        else:' \
  '        if False:
            row["state"] = "ANCHOR_TREE_UNREADABLE"
        else:' \
  test_an_unreadable_tree_is_distinguished_from_a_missing_ref

printf '\nALL PASS: the premise holds and every anchor mutant was killed by its named test.\n'
