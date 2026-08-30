#!/usr/bin/env bash
# TOG-702 mutation gate.
#
# The fix makes secret redaction match on FRAGMENTS of a registered value, so a
# truncated secret -- the shape a 500-char error cap and an offset /log read
# actually produce -- is redacted. The suite in
# server/src/__tests__/run-secret-redaction.test.ts asserts that. This proves the
# suite can fail, which is the only thing that makes its green mean anything.
#
# Two directions matter, and a suite that catches only one is not a control:
#
#   UNDER-redaction -- revert to exact matching, or blind the matcher. The
#     original defect. Must go red.
#   OVER-redaction  -- redact everything, or match on anything. Trivially
#     satisfies "the secret is gone" while destroying every log in the product.
#     Must also go red.
#
# Plus a DECOY: a mutation to a genuinely unrelated line, which must stay GREEN.
# Without it, a suite that fails on any edit whatsoever would score a perfect
# result here while proving nothing about attribution.
#
# Exit 0 all mutants behaved · 1 a mutant survived (or the decoy died) · 2 refused.

set -euo pipefail

# /app is the shared deployed tree and is not ours to leave modified, and the
# fix lives in this repo as a patch rather than in /app at all. So the gate
# stages its own copy of the two files, applies the patch to them, and mutates
# that -- /app is only ever read. Point TOG702_SERVER_DIR at a real checkout to
# run against one instead.
UPSTREAM_DIR=${TOG702_SERVER_DIR:-/app/server}
SRC_REL="src/services/run-secret-redaction.ts"
TEST_REL="src/__tests__/run-secret-redaction.test.ts"
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PATCH=${TOG702_PATCH:-$REPO_ROOT/patches/TOG-702-truncated-secret-redaction.patch}
VITEST="$UPSTREAM_DIR/node_modules/.bin/vitest"

refuse() { printf 'REFUSED: %s\n' "$1" >&2; exit 2; }

[ -f "$UPSTREAM_DIR/$SRC_REL" ]  || refuse "redaction source not found at $UPSTREAM_DIR/$SRC_REL"
[ -f "$UPSTREAM_DIR/$TEST_REL" ] || refuse "test file not found at $UPSTREAM_DIR/$TEST_REL"
[ -f "$PATCH" ]  || refuse "patch not found at $PATCH"
[ -x "$VITEST" ] || refuse "vitest not executable at $VITEST"
command -v git >/dev/null || refuse "git is required to apply the patch"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Shadow tree: symlink the server directory so node_modules and the module graph
# resolve exactly as upstream, then replace the two files under test with real,
# writable copies. Nothing under $UPSTREAM_DIR is ever written.
#
# The repo root is mirrored too, not just the server directory: server/tsconfig.json
# extends ../tsconfig.base.json, so a stage that only shadows the server resolves
# no tsconfig and vitest fails to transform anything -- which would look like a
# red suite rather than a broken harness.
REPO_PARENT=$(cd "$UPSTREAM_DIR/.." && pwd)
SERVER_NAME=$(basename "$UPSTREAM_DIR")
for entry in "$REPO_PARENT"/*; do
  [ "$(basename "$entry")" = "$SERVER_NAME" ] && continue
  ln -s "$entry" "$WORK/$(basename "$entry")"
done

STAGE="$WORK/$SERVER_NAME"
mkdir -p "$STAGE"
for entry in "$UPSTREAM_DIR"/*; do
  [ "$(basename "$entry")" = "src" ] && continue
  ln -s "$entry" "$STAGE/$(basename "$entry")"
done
cp -rs "$UPSTREAM_DIR/src" "$STAGE/src" || refuse "could not build shadow src tree"
rm -f "$STAGE/$SRC_REL" "$STAGE/$TEST_REL"
cp "$UPSTREAM_DIR/$SRC_REL"  "$STAGE/$SRC_REL"
cp "$UPSTREAM_DIR/$TEST_REL" "$STAGE/$TEST_REL"
chmod u+w "$STAGE/$SRC_REL" "$STAGE/$TEST_REL"

# Apply the fix on top. If it does not apply, refuse rather than scoring a tree
# we did not build.
UPSTREAM_SRC_SHA=$(sha256sum < "$STAGE/$SRC_REL" | cut -d' ' -f1)
( cd "$STAGE" && git apply -p2 "$PATCH" ) || refuse "patch does not apply to $UPSTREAM_DIR"
[ "$(sha256sum < "$STAGE/$SRC_REL" | cut -d' ' -f1)" != "$UPSTREAM_SRC_SHA" ] \
  || refuse "patch applied but changed nothing"

SRC="$STAGE/$SRC_REL"
BACKUP="$WORK/patched.ts"
cp "$SRC" "$BACKUP"
ORIGINAL_SHA=$(sha256sum < "$BACKUP" | cut -d' ' -f1)

# Run the suite against whatever is currently staged. Echoes rc only.
run_suite() {
  ( cd "$STAGE" && timeout 600 "$VITEST" run "$TEST_REL" \
      --config /dev/null --environment node >"$WORK/out.txt" 2>&1 ) && echo 0 || echo $?
}

PASS=0
FAIL=0

# --- 0. Baseline. The unmutated fix must be GREEN, or nothing below means
#        anything: a mutant "failing" a suite that was already red proves zero.
printf '\n=== baseline (unmutated) ===\n'
rc=$(run_suite)
if [ "$rc" = "0" ]; then
  printf '  PASS  baseline green (rc=0)\n'
  PASS=$((PASS + 1))
else
  printf '  FAIL  baseline is RED (rc=%s) -- every mutant result below is meaningless\n' "$rc"
  tail -25 "$WORK/out.txt" | sed 's/^/        /'
  exit 1
fi

# assert_mutant <label> <expect: red|green> <sed program...>
assert_mutant() {
  local label=$1 expect=$2; shift 2
  cp "$BACKUP" "$SRC"
  local applied=0
  for prog in "$@"; do
    if perl -0777 -pi -e "$prog" "$SRC"; then applied=1; fi
  done
  [ "$applied" = "1" ] || { printf '  FAIL  %-42s could not apply mutation\n' "$label"; FAIL=$((FAIL+1)); return; }

  # A mutation that changed no bytes is a rotted anchor pretending to be a pass.
  if [ "$(sha256sum < "$SRC" | cut -d' ' -f1)" = "$ORIGINAL_SHA" ]; then
    printf '  FAIL  %-42s anchor did not match; file unchanged\n' "$label"
    FAIL=$((FAIL + 1)); return
  fi

  local rc; rc=$(run_suite)
  if [ "$expect" = "red" ]; then
    if [ "$rc" != "0" ]; then
      printf '  PASS  %-42s killed (rc=%s)\n' "$label" "$rc"; PASS=$((PASS+1))
    else
      printf '  FAIL  %-42s SURVIVED -- suite is blind to this\n' "$label"; FAIL=$((FAIL+1))
    fi
  else
    if [ "$rc" = "0" ]; then
      printf '  PASS  %-42s decoy stayed green (rc=0)\n' "$label"; PASS=$((PASS+1))
    else
      printf '  FAIL  %-42s decoy went RED -- suite fails on unrelated edits\n' "$label"
      tail -15 "$WORK/out.txt" | sed 's/^/        /'
      FAIL=$((FAIL+1))
    fi
  fi
}

printf '\n=== under-redaction mutants (the original defect) ===\n'

# The exact defect this issue is about: drop fragment matching, keep whole-value.
assert_mutant "revert to exact substring matching" red \
  's/\n  return redactFragments\(exact, index\);/\n  return exact;/'

# Blind the matcher by raising the floor above any realistic truncation, which
# is how a "tuning" change would silently reintroduce the defect.
assert_mutant "fragment floor raised above a 500-cut" red \
  's/^const MIN_FRAGMENT_LENGTH = 16;/const MIN_FRAGMENT_LENGTH = 4096;/m'

# Drop the JSON-escaped variant: transcripts are JSON, so this reintroduces the
# leak for exactly the surface TOG-638 leaked through.
assert_mutant "stop indexing the JSON-escaped spelling" red \
  's/return escaped === value \? \[value\] : \[value, escaped\];/return [value];/'

# Anchor matching at the start of the value only -- catches a prefix, misses the
# interior slice an offset /log read produces.
assert_mutant "only match fragments at offset 0" red \
  's/if \(hasEnoughDistinctChars\(variant, i\)\) \{/if (i === 0) {/'

printf '\n=== over-redaction mutants (a redactor that eats everything) ===\n'

# The degenerate "fix": redact the whole string. Satisfies any test that only
# asks "is the secret gone".
assert_mutant "redact every string wholesale" red \
  's/^export function redactRegisteredSecretValues<T>\(input: T, values: string\[\]\): T \{\n/export function redactRegisteredSecretValues<T>(input: T, values: string[]): T {\n  if (typeof input === "string" \&\& values.length > 0) return REDACTED_EVENT_VALUE as T;\n/m'

# Match on any 16 chars regardless of content: destroys ordinary log text that
# happens to share a run of characters with a registered value.
assert_mutant "drop the distinct-character floor" red \
  's/^const MIN_FRAGMENT_DISTINCT_CHARS = 6;/const MIN_FRAGMENT_DISTINCT_CHARS = 0;/m'

# Trust the rolling hash instead of confirming character by character. A hash
# collision would then redact unrelated text -- and this is the single most
# tempting "optimisation" someone will make to this file.
assert_mutant "trust the hash without confirming chars" red \
  's/      let length = 0;\n      while \(length < MIN_FRAGMENT_LENGTH && input\[inputFrom \+ length\] === source\.text\[offset \+ length\]\) length \+= 1;\n      if \(length < MIN_FRAGMENT_LENGTH\) continue;/      let length = MIN_FRAGMENT_LENGTH;/'

printf '\n=== decoy (must stay GREEN) ===\n'

# A real behavioural edit on a path this suite does not claim to cover: the size
# of the prefilter table. It changes collision rate and nothing observable. If
# this goes red, the suite is reacting to edits rather than to behaviour, and its
# kills above cannot be attributed to the mutations that caused them.
assert_mutant "prefilter table resized (no behaviour change)" green \
  's/^const FRAGMENT_FILTER_BITS = 16;/const FRAGMENT_FILTER_BITS = 12;/m'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
