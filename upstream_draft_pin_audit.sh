#!/usr/bin/env bash
# ===========================================================================
# upstream_draft_pin_audit.sh — are the upstream defect drafts still the
# bytes a disclosure grant would pin?
#
# THE FAILURE THIS EXISTS FOR
#
# These drafts are the artifact an external-disclosure grant NAMES BY DIGEST.
# Get the digest wrong and the grant authorizes the wrong bytes, or authorizes
# nothing while reporting success.  On 2026-08-30 a hash sweep over these
# branches did exactly that:
#
#     git show origin/does-not-exist:path | sha256sum
#     -> e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
#
# That is the sha256 of the EMPTY STRING.  `git show` wrote nothing to a pipe
# and exited 128; `sha256sum` hashed the empty stream and exited 0; the
# pipeline's status was the LAST stage's, so the failure was invisible.  A
# missing artifact hashed as a VALUE.  The sweep reported a well-formed digest
# for a file it never read.
#
# A second fail-open, found the same run: capturing the blob through
# command substitution strips the trailing newline, so an 8858-byte file
# digests as its first 8857 bytes.  Both wrong digests are 64 hex characters.
# Neither is the file.  Nothing about their SHAPE says they are wrong.
#
# So this script never treats a digest as evidence on its own.  For every
# pinned artifact it asserts, in order:
#
#   1. the ref exists                    (git rev-parse --verify)
#   2. the path exists at that ref       (git cat-file -e)
#   3. `git show` exited 0               (status captured, not piped away)
#   4. the bytes are non-empty           (an empty blob is never a pass)
#   5. the digest is not the empty-string digest  (belt and braces: this is
#      the exact value the 2026-08-30 sweep produced, so it is refused by
#      name even if checks 1-4 were somehow bypassed)
#   6. only THEN, that the digest equals the pin
#
# Checks 1-5 are the point.  Check 6 is the one everybody writes.
#
# Byte-exactness is preserved by streaming git's output to a temp file and
# hashing the FILE.  No `$(...)`, no pipe whose head can fail silently.
#
# USAGE
#   ./upstream_draft_pin_audit.sh            report drift, exit 1 if any
#   ./upstream_draft_pin_audit.sh --update   repin from git; moves each
#                                            replaced line to `superseded`
#                                            rather than deleting it
#
# Read-only by default.  --update rewrites upstream_draft_pins.txt and
# nothing else.  It never touches the drafts, the branches, or the registry.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINS="${UPSTREAM_DRAFT_PINS:-$HERE/upstream_draft_pins.txt}"
UPDATE=0
[ "${1:-}" = "--update" ] && UPDATE=1

# sha256 of the empty string — the exact value the fail-open sweep returned.
EMPTY_SHA=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

PASS=0; FAIL=0
ok()   { printf '  \033[32mOK  \033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mDRIFT\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
note() { printf '       %s\n' "$1"; }

[ -f "$PINS" ] || { echo "FATAL: no pins file at $PINS" >&2; exit 4; }
command -v git >/dev/null || { echo "FATAL: git not on PATH" >&2; exit 4; }
git -C "$HERE" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "FATAL: $HERE is not a git repository" >&2; exit 4; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/upstream_pin_audit.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BLOB="$WORK/blob"

# Resolve one artifact to a digest, or to a NAMED FAILURE.  Prints the digest
# on stdout and returns 0 only when all five preconditions hold; otherwise
# prints nothing and returns non-zero with the reason on stderr.
resolve() {
  local ref="$1" path="$2"

  git -C "$HERE" rev-parse --verify -q "$ref" >/dev/null 2>&1 \
    || { echo "ref does not exist: $ref" >&2; return 2; }

  git -C "$HERE" cat-file -e "$ref:$path" 2>/dev/null \
    || { echo "path not present at $ref: $path" >&2; return 3; }

  # Status captured directly -- NOT through a pipe, which is what hid the
  # original failure.
  if ! git -C "$HERE" show "$ref:$path" > "$BLOB" 2>/dev/null; then
    echo "git show failed for $ref:$path" >&2; return 4
  fi

  [ -s "$BLOB" ] || { echo "blob is EMPTY at $ref:$path" >&2; return 5; }

  local sha
  sha="$(sha256sum < "$BLOB" | cut -d' ' -f1)"

  [ "$sha" != "$EMPTY_SHA" ] \
    || { echo "digest is the empty-string sha256 at $ref:$path" >&2; return 6; }

  printf '%s' "$sha"
}

# ---------------------------------------------------------------------------
# --update: recompute every pinned line, demoting replaced pins to superseded
#
# This is a TRANSACTION: every row is prepared and validated into a staging
# file first, and the live pins file is replaced only when ALL rows resolve.
# A single unresolvable artifact (missing ref/path, empty blob, failed read)
# or a single unparseable line aborts the whole refresh with a non-zero exit
# and leaves the original pins byte-identical.  The pre-transaction code copied
# the good rows through, preserved the bad row unchanged, and exited 0 -- a
# partial refresh reported as success against bytes a disclosure grant pins.
# ---------------------------------------------------------------------------
if [ "$UPDATE" = 1 ]; then
  NEW="$WORK/pins.new"
  STAGED_NOTES="$WORK/repinned.notes"
  : > "$NEW" || { echo "aborted: cannot stage refresh output" >&2; exit 4; }
  : > "$STAGED_NOTES" || { echo "aborted: cannot stage refresh output" >&2; exit 4; }
  changed=0
  unparseable=0
  unresolved=0
  fail_update() { echo "aborted: $1; $PINS left untouched" >&2; exit 4; }
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      pinned[[:space:]]*)
        set -- $line
        if [ "$#" -lt 3 ]; then
          printf '%s\n' "$line" >> "$NEW" \
            || fail_update "cannot stage refresh output"
          unparseable=$((unparseable+1))
          echo "REFUSING to complete: malformed pinned line (expected 'pinned <sha256> <ref>:<path>'), NOT repinned: $line" >&2
        else
          oldsha="$2"; target="$3"
          ref="${target%%:*}"; path="${target#*:}"
          if sha="$(resolve "$ref" "$path" 2>"$WORK/err")"; then
            if [ "$sha" != "$oldsha" ]; then
              printf 'superseded  %s  %s\n' "$oldsha" "$target" >> "$NEW" \
                || fail_update "cannot stage refresh output"
              changed=1
              # Staged, not printed: claiming a repin that a later row aborts
              # would report an update that never landed.
              printf 'repinned %s\n' "$target" >> "$STAGED_NOTES" \
                || fail_update "cannot stage refresh output"
            fi
            printf 'pinned  %s  %s\n' "$sha" "$target" >> "$NEW" \
              || fail_update "cannot stage refresh output"
          else
            echo "REFUSING to repin $target: $(cat "$WORK/err")" >&2
            printf '%s\n' "$line" >> "$NEW" \
              || fail_update "cannot stage refresh output"
            unresolved=$((unresolved+1))
          fi
        fi
        ;;
      superseded[[:space:]]*|''|'#'*) printf '%s\n' "$line" >> "$NEW" \
        || fail_update "cannot stage refresh output" ;;
      *)
        # Same blind spot as the audit loop, but worse: --update would copy an
        # unparseable line through unchanged and print "no change", so a
        # dropped artifact survives the very command meant to refresh it.
        printf '%s\n' "$line" >> "$NEW" \
          || fail_update "cannot stage refresh output"
        unparseable=$((unparseable+1))
        echo "REFUSING to complete: unparseable pin line, NOT repinned: $line" >&2
        ;;
    esac
  done < "$PINS"
  if [ "$unparseable" != 0 ] || [ "$unresolved" != 0 ]; then
    echo "aborted: $unparseable unparseable line(s), $unresolved unresolvable artifact(s); $PINS left untouched" >&2
    exit 4
  fi
  while IFS= read -r repinned || [ -n "$repinned" ]; do
    note "$repinned"
  done < "$STAGED_NOTES"
  cp "$NEW" "$PINS" || { echo "aborted: could not replace $PINS" >&2; exit 4; }
  [ "$changed" = 1 ] && echo "pins updated: $PINS" || echo "no change: $PINS"
  exit 0
fi

# ---------------------------------------------------------------------------
# audit
# ---------------------------------------------------------------------------
printf '\033[1mupstream draft pin audit\033[0m  (pins: %s)\n\n' "$PINS"

SEEN=0
UNKNOWN=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    pinned[[:space:]]*) : ;;
    superseded[[:space:]]*) continue ;;
    ''|'#'*) continue ;;
    *)
      # A line that is neither a comment, a blank, nor one of the two states
      # is NOT "nothing to check" -- it is an artifact that fell out of the
      # audit.  The loop above dispatches on a literal prefix, so a third
      # state word, or a typo in `pinned`, drops the line silently: the
      # artifact count goes DOWN and every remaining line still says OK, so
      # the run stays green while checking one thing fewer.
      #
      # Found when a reviewed-but-unshippable state was proposed.  The temptation is concrete: a
      # SEND WITH EDITS verdict invites a third state ("needs_edits",
      # "reviewed") to record bytes that were reviewed but must not ship, and
      # nothing here would have said so.  Fail loudly and name the line.
      UNKNOWN=$((UNKNOWN+1))
      bad "unparseable pin line: $line"
      note "state word is neither 'pinned' nor 'superseded' -- this artifact was NOT checked"
      note "the audit understands exactly two states; see the header of the pins file"
      continue
      ;;
  esac
  set -- $line
  want="$2"; target="$3"
  ref="${target%%:*}"; path="${target#*:}"
  SEEN=$((SEEN+1))

  if ! got="$(resolve "$ref" "$path" 2>"$WORK/err")"; then
    bad "$target"
    note "$(cat "$WORK/err")"
    note "this is NOT a mismatch -- the artifact could not be read at all"
    continue
  fi

  if [ "$got" = "$want" ]; then
    ok "$target"
  else
    bad "$target"
    note "pinned $want"
    note "actual $got"
  fi
done < "$PINS"

printf '\n  %d pinned artifact(s): %d ok, %d drifted' "$SEEN" "$PASS" "$FAIL"
[ "$UNKNOWN" = 0 ] || printf ', %d UNPARSEABLE (not checked)' "$UNKNOWN"
printf '\n'

if [ "$SEEN" = 0 ]; then
  echo "  FATAL: the pins file contains no pinned lines -- nothing was checked." >&2
  exit 4
fi

[ "$FAIL" = 0 ] || exit 1
exit 0
