#!/usr/bin/env bash
# =====================================================================================
# tog-990-handoff-copy-drift.sh — the operator runs the HANDOFF copy, not the repo copy.
#
# /paperclip/operator-handoff/deploy-window-manifest.py is a SEPARATE FILE from the
# reviewed deploy_window_manifest.py in this repo. Nothing links them: fixing the repo
# copy does not fix the host copy, and no test in this repo reads the host copy.
#
# Measured 2026-09-05: the host copy was pinned at ad324225 (TOG-992) while the repo
# copy had advanced to 59bd9caf (TOG-998). Both printed VERDICT: READY on the live
# tree, so the drift was INVISIBLE on a green. It only diverged on a red — and there
# the stale copy printed the exact "re-cut it" instruction TOG-998 measured wrong 7/7
# on this very tree, where re-cutting would pin the operator script to an unrelated
# feature branch. A wrong repair instruction on the one day the gate goes red is worse
# than no gate, because the operator trusts it.
#
# WHY THE REFERENCE IS A GIT OBJECT AND NOT THE WORKING TREE (TOG-999)
# -------------------------------------------------------------------
# The first version of this check resolved the reviewed side from the working tree:
#
#     REPO_COPY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy_window_manifest.py"
#
# Both operands were then editable files, so the check proved "these two agree", not
# "the operator runs the reviewed bytes". Measured 2026-09-05 by appending one line:
#
#     host copy alone mutated      -> exit 1   caught
#     BOTH copies mutated the same -> exit 0   NOT caught
#
# That second row is not a hypothetical. This checkout is a SHARED WORKSPACE with
# concurrent sibling runs: a rebase, a stray `git checkout`, or another card's run
# moves both sides at once and the guard stays green — the exact scenario it exists
# to catch. The original mutation test only ever moved one side, so the correlated
# mutant was never exercised.
#
# The reviewed side is now read from PINNED_BLOB, a content-addressed git object that
# no edit to the working tree can move. Two failure modes this introduces are guarded
# explicitly, because either one would reintroduce a false green:
#
#   1. An absent/unfetched object. Measured: `git cat-file blob <absent-but-wellformed>`
#      exits 128 and writes ZERO bytes. Piped or redirected carelessly that lands as an
#      EMPTY reference file whose sha256 is e3b0c442…, which would then be compared
#      against the host copy and reported as ordinary drift — or, worse, matched by an
#      equally empty host copy. So: assert the read succeeded AND assert non-empty.
#   2. The right object, wrong bytes. Belt and braces: the extracted content is asserted
#      against PINNED_SHA256, a recorded constant. If git ever hands back something else,
#      this check fails loudly rather than silently redefining what "reviewed" means.
#
# It is deliberately a byte comparison and not a "does it still work" test: the failure
# mode is not a broken gate, it is a gate that works correctly while giving superseded
# ADVICE, which no behavioural assertion on the current green state can see.
#
#   exit 0  host copy is byte-identical to the reviewed, PINNED gate
#   exit 1  drift — the operator would run bytes nobody reviewed at this revision
#   exit 2  could not evaluate
#
# MAINTENANCE: when deploy_window_manifest.py is legitimately revised and re-reviewed,
# update PINNED_REV, PINNED_BLOB and PINNED_SHA256 together, in the same commit as the
# revision, and re-sync the handoff copy. Updating the pin is a REVIEW action — it is
# the one edit that redefines what these bytes are being held to.
# =====================================================================================
set -Eeuo pipefail

# The reviewed revision. PINNED_BLOB is the immutable object actually read; PINNED_REV
# and the path are recorded so a human can see where the blob came from.
PINNED_REV="2d0db03b217f50d75e460c464f356014d0ca3a16"
PINNED_PATH="deploy_window_manifest.py"
PINNED_BLOB="254dc6a2503e94e7fb9dc93ab07ae46481e1456e"
PINNED_SHA256="24e5d8d49f34f571de2a697dd6d464a6be9c0fe4a78e0103fba3727e37ed934d"

# Both overridable so the mutation gate can stage this script outside the repo. Neither
# override can weaken the check: HOST_COPY only chooses which file is under test, and
# REPO_ROOT only chooses which object store is asked for PINNED_BLOB — a blob id is
# content-addressed, so any store that returns it returns byte-identical content.
HOST_COPY="${HOST_COPY:-/paperclip/operator-handoff/deploy-window-manifest.py}"
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

fail() { printf 'FAIL: %s\n' "$1"; exit "${2:-1}"; }

REF_COPY="$(mktemp)"
trap 'rm -f "$REF_COPY"' EXIT

# --- resolve the reviewed side from the immutable object ------------------------------
# Not `git show REV:path`: that re-resolves through a commit, and a commit is a name.
# The blob id IS the content, so nothing in the working tree or on any branch can move it.
if ! git -C "$REPO_ROOT" cat-file blob "$PINNED_BLOB" > "$REF_COPY" 2>/dev/null; then
  fail "cannot read pinned reviewed blob ${PINNED_BLOB:0:16} ($PINNED_REV:$PINNED_PATH).
  The object is absent from this checkout — most likely a shallow clone or an
  unfetched revision. Run: git -C '$REPO_ROOT' fetch --all --tags
  Refusing to fall back to the working-tree copy: that is the mutable reference
  this check exists to stop using." 2
fi

# An absent object writes ZERO bytes on the way to its non-zero exit. Belt and braces:
# never let an empty reference be compared as though it were the reviewed gate.
[ -s "$REF_COPY" ] || fail "pinned reviewed blob ${PINNED_BLOB:0:16} extracted EMPTY (sha256 e3b0c442…).
  An empty reference would compare as ordinary drift, or match an equally empty
  host copy. Treating this as could-not-evaluate rather than a verdict." 2

ref_sha="$(sha256sum "$REF_COPY" | cut -d' ' -f1)"
if [ "$ref_sha" != "$PINNED_SHA256" ]; then
  printf 'FAIL: the pinned reviewed blob does not hash to the recorded constant.\n\n'
  printf '  expected %s  (PINNED_SHA256)\n' "${PINNED_SHA256:0:16}"
  printf '  got      %s  (git cat-file blob %s)\n\n' "${ref_sha:0:16}" "${PINNED_BLOB:0:16}"
  printf '  This check refuses to redefine "reviewed" from whatever git handed back.\n'
  printf '  Either the pin was edited without re-review, or the object store is wrong.\n'
  exit 2
fi

# --- compare the handoff copy against it ----------------------------------------------
[ -f "$HOST_COPY" ] || fail "handoff copy missing: $HOST_COPY — the operator has no gate to run" 1

host_sha="$(sha256sum "$HOST_COPY" | cut -d' ' -f1)"

if [ "$ref_sha" != "$host_sha" ]; then
  printf 'FAIL: handoff copy has drifted from the reviewed copy.\n\n'
  printf '  reviewed %s  %s:%s (blob %s)\n' \
    "${ref_sha:0:16}" "${PINNED_REV:0:12}" "$PINNED_PATH" "${PINNED_BLOB:0:12}"
  printf '  handoff  %s  %s\n\n' "${host_sha:0:16}" "$HOST_COPY"
  printf '  Both copies can still print READY on a green tree, so this drift is\n'
  printf '  invisible until the day the gate goes red and the operator is given\n'
  printf '  advice from a superseded revision. Sync it from the PINNED object --\n'
  printf '  not from the working tree, which may itself have moved:\n\n'
  printf '    git -C "%s" cat-file blob %s > "%s"\n\n' \
    "$REPO_ROOT" "$PINNED_BLOB" "$HOST_COPY"
  printf '  Write the BYTES (as above) rather than replacing the file, so the\n'
  printf '  handoff copy keeps its mode; the operator invokes it directly.\n'
  exit 1
fi

# The operator invokes it directly, so a lost executable bit is a real breakage.
[ -x "$HOST_COPY" ] || fail "handoff copy is not executable: $HOST_COPY" 1

printf 'PASS: handoff copy matches the reviewed gate pinned at %s:%s\n' \
  "${PINNED_REV:0:12}" "$PINNED_PATH"
printf '      sha256 %s, blob %s, mode %s\n' \
  "${ref_sha:0:16}" "${PINNED_BLOB:0:12}" "$(stat -c '%a' "$HOST_COPY")"
