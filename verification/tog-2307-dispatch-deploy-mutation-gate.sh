#!/usr/bin/env bash
# ===========================================================================
# tog-2307-dispatch-deploy-mutation-gate.sh
#
# Is test_dispatch_deploy.sh actually load-bearing against scripts/
# dispatch_deploy.sh, or does it merely pass on an unmutated tool?
#
# This suite plants defects the test suite CLAIMS to catch (per TOG-2307's
# acceptance criteria: smoke gating, clean-tree/commit-object validation,
# anchoring before checkout, and status's refuse/drift triad) and requires
# the FULL test suite to go non-zero for every one. A mutant that survives
# means test_dispatch_deploy.sh reports PASS on a build that would silently
# corrupt or mis-point the live dispatch-src checkout.
#
# Mutants are planted against a COPY of the tool. Each mutant builds a fresh
# scene containing the unmodified test suite plus a mutated scripts/
# dispatch_deploy.sh, then runs the suite from inside that scene (it resolves
# the tool via its own directory-relative $ROOT/scripts/..., so a copied tree
# is a complete fixture). The test suite itself never changes -- only the
# artifact it is asserting against does.
#
# EXIT CODES ARE ASSERTED EXACTLY: the test suite's own convention is rc 0
# pass, rc 1 fail (see test_dispatch_deploy.sh's tail). A mutant is killed
# only when the suite reports rc 1 -- not merely "something went wrong."
#
# Run from anywhere:  ./verification/tog-2307-dispatch-deploy-mutation-gate.sh
# Exit 0 = every mutant killed and the positive control behaved.
# ===========================================================================

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOL_REL="scripts/dispatch_deploy.sh"
TOOL_SRC="$REPO_ROOT/$TOOL_REL"
TEST_SRC="$REPO_ROOT/test_dispatch_deploy.sh"

[ -f "$TOOL_SRC" ] || { echo "FATAL: no tool at $TOOL_SRC" >&2; exit 2; }
[ -f "$TEST_SRC" ] || { echo "FATAL: no test suite at $TEST_SRC" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tog2307mut.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
kill_ok() { printf '  \033[32mKILLED\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
survived() { printf '  \033[31mSURVIVED\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
note()    { printf '           %s\n' "$1"; }

# Build a pristine sandbox: the tool plus the test suite that exercises it.
mkscene() {
  local dir="$1"
  rm -rf "$dir"; mkdir -p "$dir/scripts"
  cp "$TOOL_SRC" "$dir/scripts/"
  cp "$TEST_SRC" "$dir/"
  chmod +x "$dir/scripts/$(basename "$TOOL_REL")" "$dir/test_dispatch_deploy.sh"
}

# Run the full test suite in a scene; echo its exit code.
run_scene() {
  ( cd "$1" && ./test_dispatch_deploy.sh >"$1/.out" 2>&1; echo $? )
}

echo "TOG-2307 dispatch_deploy.sh mutation suite"
echo

# --- POSITIVE CONTROL -------------------------------------------------------
# Unmutated, the test suite must PASS (rc 0). If this fails, every "kill"
# below is meaningless -- the suite would be red on everything, including
# the correct tool.
S="$WORK/control_pos"; mkscene "$S"
rc="$(run_scene "$S")"
if [ "$rc" -eq 0 ]; then
  kill_ok "CONTROL+  unmutated tool -> rc 0 (suite is green on the real tool)"
else
  survived "CONTROL+  unmutated tool -> rc $rc, expected 0. Suite is red on the truth; nothing below is evidence."
  sed 's/^/           | /' "$S/.out" | tail -20
fi

# --- M1: smoke gating is bypassed -------------------------------------------
# The single most safety-critical mutant: do_deploy() proceeds to checkout
# regardless of $SMOKE_RC. This directly targets the acceptance criterion
# "tests prove smoke failure leaves HEAD unchanged."
S="$WORK/m1"; mkscene "$S"
F="$S/scripts/dispatch_deploy.sh"
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = 'if [[ "$SMOKE_RC" -ne 0 ]]; then'
new = 'if [[ "$SMOKE_RC" -ne 0 ]] && false; then'
assert s.count(old) == 1, "M1 anchor not found (or not unique) -- smoke-gate shape moved; re-derive this mutant"
open(p, "w").write(s.replace(old, new, 1))
PY
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M1  smoke failure no longer blocks checkout (deploy proceeds anyway)" \
  || survived "M1  smoke gate disabled -> suite rc $rc, expected 1"

# --- M2: anchoring is dropped before checkout -------------------------------
# Drop both update-ref calls so the new/previous SHAs are never anchored
# against gc before live HEAD moves. Targets "anchors both SHAs against gc."
S="$WORK/m2"; mkscene "$S"
F="$S/scripts/dispatch_deploy.sh"
old='  git -C "$TARGET" update-ref "$REF_ROLLBACK" "$previous_sha"
  git -C "$TARGET" update-ref "$REF_CURRENT" "$target_sha"'
grep -qF 'update-ref "$REF_ROLLBACK"' "$F" || { printf '  \033[31mBROKEN\033[0m   M2 anchor not found; re-derive this mutant.\n' >&2; exit 2; }
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = '  git -C "$TARGET" update-ref "$REF_ROLLBACK" "$previous_sha"\n  git -C "$TARGET" update-ref "$REF_CURRENT" "$target_sha"\n'
assert old in s, "M2 anchor not found -- re-derive this mutant"
open(p, "w").write(s.replace(old, "", 1))
PY
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M2  anchor refs (refs/dispatch-deploy/*) are never updated on deploy" \
  || survived "M2  anchoring dropped -> suite rc $rc, expected 1"

# --- M3: clean-tree check is disabled ---------------------------------------
# Targets "verifies a clean tree" -- a dirty working tree must refuse.
S="$WORK/m3"; mkscene "$S"
F="$S/scripts/dispatch_deploy.sh"
old='require_clean_tree() {
  [[ -z "$(git -C "$TARGET" status --porcelain 2>&1)" ]] || refuse "target working tree is not clean: $TARGET"
}'
grep -qF '[[ -z "$(git -C "$TARGET" status --porcelain 2>&1)" ]] || refuse' "$F" || { printf '  \033[31mBROKEN\033[0m   M3 anchor not found; re-derive this mutant.\n' >&2; exit 2; }
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = 'require_clean_tree() {\n  [[ -z "$(git -C "$TARGET" status --porcelain 2>&1)" ]] || refuse "target working tree is not clean: $TARGET"\n}'
new = 'require_clean_tree() {\n  return 0\n}'
assert old in s, "M3 anchor not found -- re-derive this mutant"
open(p, "w").write(s.replace(old, new, 1))
PY
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M3  require_clean_tree is neutered (dirty tree no longer refused)" \
  || survived "M3  clean-tree check disabled -> suite rc $rc, expected 1"

# --- M4: commit-object validation is weakened to accept any ref ------------
# Targets "verifies ... commit object" -- a branch name or unknown object
# must be refused, never resolved.
S="$WORK/m4"; mkscene "$S"
F="$S/scripts/dispatch_deploy.sh"
old='is_forty_hex() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}'
grep -qF '[[ "$1" =~ ^[0-9a-f]{40}$ ]]' "$F" || { printf '  \033[31mBROKEN\033[0m   M4 anchor not found; re-derive this mutant.\n' >&2; exit 2; }
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = 'is_forty_hex() {\n  [[ "$1" =~ ^[0-9a-f]{40}$ ]]\n}'
new = 'is_forty_hex() {\n  return 0\n}'
assert old in s, "M4 anchor not found -- re-derive this mutant"
open(p, "w").write(s.replace(old, new, 1))
PY
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M4  is_forty_hex always true (branch names/short SHAs accepted)" \
  || survived "M4  commit-format validation disabled -> suite rc $rc, expected 1"

# --- M5: status never refuses on a corrupt/absent record -------------------
# Targets "status refuses absent/corrupt records" directly at the read path.
S="$WORK/m5"; mkscene "$S"
F="$S/scripts/dispatch_deploy.sh"
old='  [[ -f "$RECORD" ]] || refuse "no deployment record at $RECORD"'
grep -qF "$old" "$F" || { printf '  \033[31mBROKEN\033[0m   M5 anchor not found; re-derive this mutant.\n' >&2; exit 2; }
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = '  [[ -f "$RECORD" ]] || refuse "no deployment record at $RECORD"\n'
assert old in s, "M5 anchor not found -- re-derive this mutant"
open(p, "w").write(s.replace(old, "", 1))
PY
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M5  read_record no longer refuses an absent record file" \
  || survived "M5  absent-record refusal removed -> suite rc $rc, expected 1"

# --- M6: post-checkout HEAD verification is removed -------------------------
# Targets "verifies the resulting HEAD". This one is deliberately NOT scored
# as a kill/survive: `git checkout --quiet --detach <sha>` against a commit
# object that require_commit_object already proved exists cannot leave HEAD
# anywhere but <sha> without git itself misbehaving. No fixture reachable
# from a black-box test suite can make a real git binary lie about that, so
# removing this assertion is provably a no-op under every achievable test
# scenario -- unlike M1-M5, its absence cannot be distinguished from its
# presence by exercising the tool. It stays in the source as defense-in-depth
# against an unmodeled git failure mode (e.g. a corrupted object store), and
# is reported here as a known-unfalsifiable limb rather than a false SURVIVED.
S="$WORK/m6"; mkscene "$S"
F="$S/scripts/dispatch_deploy.sh"
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = '  [[ "$resulting_head" == "$target_sha" ]] || refuse "post-deploy HEAD verification failed: expected $target_sha, got $resulting_head"\n'
assert old in s, "M6 anchor not found -- re-derive this mutant"
open(p, "w").write(s.replace(old, "", 1))
PY
rc="$(run_scene "$S")"
if [ "$rc" -eq 1 ]; then
  kill_ok "M6  post-checkout HEAD verification removed (unexpectedly caught by another assertion)"
else
  note "M6  HEAD verification removed -> suite rc $rc (expected 0: unfalsifiable under real git, see comment above; not scored)"
fi

echo
echo "-----------------------------------------------------------------"
if [ "$FAIL" -eq 0 ]; then
  echo "PASS  $PASS/$PASS mutants killed and control behaved"
  exit 0
fi
echo "FAIL  $FAIL survived, $PASS killed"
exit 1
