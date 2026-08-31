#!/usr/bin/env bash
# ===========================================================================
# test_upstream_draft_pin_audit.sh — drive the audit against DIRTY inputs.
#
# The audit passing on the real pins proves nothing: a script that printed
# "OK" unconditionally would score identically.  Every case here feeds it an
# input that is WRONG in a specific way and asserts it exits non-zero AND
# names the reason.  Case 2 is the one that matters -- it is a byte-for-byte
# reconstruction of the 2026-08-30 fail-open, where a missing ref produced
# the empty-string digest and the sweep called it a value.
#
# Each case builds a throwaway git repo, so nothing here touches the real
# drafts, branches, or pins file.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="$HERE/upstream_draft_pin_audit.sh"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -f "$AUDIT" ] || { echo "FATAL: no upstream_draft_pin_audit.sh beside this test" >&2; exit 4; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pin_audit_test.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

EMPTY_SHA=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

# Build a scratch repo with one committed artifact on a branch.
# Prints the repo path.  The artifact deliberately ends in a newline so the
# trailing-newline case has something to lose.
make_repo() {
  local d="$1" content="${2:-hello upstream draft}"
  mkdir -p "$d/docs/upstream"
  git -C "$d" init -q 2>/dev/null
  git -C "$d" config user.email t@t.local
  git -C "$d" config user.name  t
  printf '%s\n' "$content" > "$d/docs/upstream/report.md"
  git -C "$d" add -A
  git -C "$d" commit -qm seed
  git -C "$d" branch -f real-branch HEAD
}

# Run the audit inside repo $1 with pins file content $2.
run_audit() {
  local repo="$1" pins="$2"
  printf '%s\n' "$pins" > "$repo/pins.txt"
  cp "$AUDIT" "$repo/upstream_draft_pin_audit.sh"
  chmod +x "$repo/upstream_draft_pin_audit.sh"
  ( cd "$repo" && UPSTREAM_DRAFT_PINS="$repo/pins.txt" \
      ./upstream_draft_pin_audit.sh ) > "$repo/out.log" 2>&1
  echo $? > "$repo/rc"
}

# ---------------------------------------------------------------------------
hdr "=== case 1: BASELINE — correct pin must pass (else nothing below means anything) ==="
R="$WORK/c1"; make_repo "$R"
TRUE_SHA="$(git -C "$R" show real-branch:docs/upstream/report.md | sha256sum | cut -d' ' -f1)"
run_audit "$R" "pinned  $TRUE_SHA  real-branch:docs/upstream/report.md"
if [ "$(cat "$R/rc")" = 0 ]; then ok "correct pin exits 0"; else
  bad "correct pin should exit 0, got $(cat "$R/rc")"; sed 's/^/      /' "$R/out.log"; fi

# ---------------------------------------------------------------------------
hdr "=== case 2: THE FAIL-OPEN — ref does not exist (2026-08-30 regression) ==="
# The original sweep pinned the empty-string digest here and called it green.
R="$WORK/c2"; make_repo "$R"
run_audit "$R" "pinned  $EMPTY_SHA  origin/branch-that-does-not-exist:docs/upstream/report.md"
rc="$(cat "$R/rc")"
if [ "$rc" != 0 ]; then ok "missing ref exits non-zero (rc=$rc)"; else
  bad "MISSING REF SCORED GREEN — this is the exact 2026-08-30 fail-open"; fi
if grep -q "ref does not exist" "$R/out.log"; then
  ok "names the cause: 'ref does not exist'"; else
  bad "did not name the missing ref"; sed 's/^/      /' "$R/out.log"; fi
if grep -q "NOT a mismatch" "$R/out.log"; then
  ok "distinguishes unreadable from mismatched"; else
  bad "reported it as an ordinary digest mismatch"; fi

# ---------------------------------------------------------------------------
hdr "=== case 3: path missing at a ref that DOES exist ==="
R="$WORK/c3"; make_repo "$R"
run_audit "$R" "pinned  $EMPTY_SHA  real-branch:docs/upstream/no-such-file.md"
if [ "$(cat "$R/rc")" != 0 ]; then ok "missing path exits non-zero"; else
  bad "missing path scored green"; fi
if grep -q "path not present" "$R/out.log"; then
  ok "names the missing path"; else bad "did not name the missing path"; fi

# ---------------------------------------------------------------------------
hdr "=== case 4: empty blob must never be a pass ==="
R="$WORK/c4"; mkdir -p "$R/docs/upstream"
git -C "$R" init -q; git -C "$R" config user.email t@t.local; git -C "$R" config user.name t
: > "$R/docs/upstream/report.md"          # zero bytes, legitimately committed
git -C "$R" add -A; git -C "$R" commit -qm empty; git -C "$R" branch -f real-branch HEAD
run_audit "$R" "pinned  $EMPTY_SHA  real-branch:docs/upstream/report.md"
if [ "$(cat "$R/rc")" != 0 ]; then
  ok "empty blob refused even though its digest MATCHES the pin"; else
  bad "empty blob accepted because the digest matched — fail-open intact"; fi
if grep -qE "EMPTY|empty-string" "$R/out.log"; then
  ok "names emptiness as the cause"; else bad "did not name emptiness"; fi

# ---------------------------------------------------------------------------
hdr "=== case 5: ordinary drift — content changed under a valid pin ==="
R="$WORK/c5"; make_repo "$R" "original text"
STALE="$(git -C "$R" show real-branch:docs/upstream/report.md | sha256sum | cut -d' ' -f1)"
printf 'edited text\n' > "$R/docs/upstream/report.md"
git -C "$R" add -A; git -C "$R" commit -qm edit; git -C "$R" branch -f real-branch HEAD
run_audit "$R" "pinned  $STALE  real-branch:docs/upstream/report.md"
if [ "$(cat "$R/rc")" != 0 ]; then ok "content drift exits non-zero"; else
  bad "content drift scored green"; fi
if grep -q "actual" "$R/out.log"; then ok "prints the actual digest"; else
  bad "did not print the actual digest"; fi

# ---------------------------------------------------------------------------
hdr "=== case 6: trailing-newline sensitivity (the \$(...) mangling bug) ==="
# A digest computed through command substitution loses the trailing newline.
# The audit must NOT match that value -- it must hash the real bytes.
R="$WORK/c6"; make_repo "$R" "newline sensitive"
git -C "$R" show real-branch:docs/upstream/report.md > "$R/full.bin"
MANGLED="$(printf '%s' "$(cat "$R/full.bin")" | sha256sum | cut -d' ' -f1)"
STREAMED="$(sha256sum < "$R/full.bin" | cut -d' ' -f1)"
if [ "$MANGLED" != "$STREAMED" ]; then
  ok "fixture is valid: mangled and streamed digests differ"
  run_audit "$R" "pinned  $MANGLED  real-branch:docs/upstream/report.md"
  if [ "$(cat "$R/rc")" != 0 ]; then
    ok "audit refuses the newline-stripped digest"; else
    bad "audit accepted a digest that is missing the trailing newline"; fi
else
  bad "fixture invalid: digests identical, cannot test newline stripping"
fi

# ---------------------------------------------------------------------------
hdr "=== case 7: a pins file with no pinned lines must be FATAL, not green ==="
R="$WORK/c7"; make_repo "$R"
run_audit "$R" "# only a comment, nothing pinned"
rc="$(cat "$R/rc")"
if [ "$rc" != 0 ]; then ok "empty pin set exits non-zero (rc=$rc)"; else
  bad "a pins file that checks NOTHING reported success"; fi

# ---------------------------------------------------------------------------
printf '\n\033[1mpassed %d, failed %d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ] || exit 1
exit 0
