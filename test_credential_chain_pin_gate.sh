#!/usr/bin/env bash
# ===========================================================================
# test_credential_chain_pin_gate.sh — can the pin control actually fail?
# TOG-310.
#
# The pin check in credential_chain_audit.sh is a DETECTOR, not a boundary:
# every agent shares uid `node`, so anyone who can rewrite the credential helper
# can rewrite the pin file next to it.  All such a control ever buys is that a
# swap has to be loud.  Which means the only property worth asserting about it
# is that it is still capable of being loud — and that is not something reading
# the code establishes.  This runs the suite against copies of the tools with
# specific defects put back, and requires the NAMED assertions to go red.
#
# Each mutation below is a real state this repo has actually been in:
#
#   downgrade-reads-as-current  the pin file's first form was a flat known-good
#       list, so a live helper matching ANY reviewed build read OK.  The
#       2026-08-24 03:32 swap installed 49cfcd95 — a build this repo shipped.
#       The control could not have caught the incident it was written for.
#
#   helper-changed-without-repin  TOG-238 edited gh-app-token.js and merged
#       without touching the pin file.  Once that build was deployed the audit
#       reported DRIFT on the reviewed tip of main: a red verdict on the correct
#       state, which is how a detector gets muted rather than fixed.
#
#   unparseable-pin-line-ignored  the fail-open direction.  A pin file line the
#       parser skips instead of refusing turns "this file pins nothing" into
#       "this file pins everything", silently.
#
# WHY A BASELINE, AND WHY AN EXACT FAILURE SET (TOG-253, TOG-339).  "The mutated
# suite failed" is worth nothing on its own: a staged copy missing a dependency
# fails for reasons that have nothing to do with the mutation, and a mutation
# that deletes assertions makes a suite pass by having less to say.  So each
# check below asserts, in order:
#
#   1. the UNMUTATED copy passes in the same staging directory;
#   2. the mutation changed the file at all (or the code moved and the sed is
#      now aiming at nothing);
#   3. the mutated copy still parses (or it fails for the wrong reason);
#   4. the mutated suite fails on EXACTLY the named assertions — no more, no
#      fewer;
#   5. the mutated suite still ran the same NUMBER of assertions as the
#      baseline, so a mutation cannot be "survived" by removing tests.
#
# Exit: 0 every gate held | 1 a gate did not | 2 setup error
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 2

SUITE=test_credential_chain_audit.sh
# Everything the suite reads out of its own directory.  Staging fewer files than
# this is the TOG-253 failure: the copy fails in the staging dir no matter what
# the mutation did.
DEPS=(credential_chain_audit.sh credential_chain_pins.txt staged_root_scripts.txt
      credential_chain_lockdown.sh gh-app-token.js "$SUITE")

for f in "${DEPS[@]}"; do
  [[ -r "$HERE/$f" ]] || { echo "ERROR: missing $f; this gate cannot stage the suite" >&2; exit 2; }
done

TMP="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/tog310-gate-XXXXXX")" || exit 2
trap 'rm -rf "$TMP"' EXIT

rc=0
note() { printf '  %s\n' "$*"; }
fail() { printf '::error::%s\n' "$*"; rc=1; }

stage() { local d="$1"; mkdir -p "$d" && cp "${DEPS[@]}" "$d/"; }

# strip ANSI, then the descriptions of failing assertions, one per line.
failed_descs() { sed 's/\x1b\[[0-9;]*m//g' <<<"$1" | sed -n 's/^  FAIL  //p' | sort; }
# "45 passed, 0 failed" -> 45 0
counts() { sed 's/\x1b\[[0-9;]*m//g' <<<"$1" | sed -n 's/^\([0-9]*\) passed, \([0-9]*\) failed$/\1 \2/p' | tail -1; }

# --- 1. baseline ------------------------------------------------------------
BASE="$TMP/baseline"; stage "$BASE" || exit 2
base_out="$(cd "$BASE" && "./$SUITE" 2>&1)"; base_rc=$?
read -r base_pass base_fail <<<"$(counts "$base_out")"
if [[ $base_rc -ne 0 || "${base_fail:-x}" != "0" || -z "${base_pass:-}" ]]; then
  echo "::error::the UNMUTATED suite does not pass in a staging directory — every result below would be unattributable"
  tail -30 <<<"$base_out"
  exit 1
fi
BASE_TOTAL=$base_pass
note "baseline: $base_pass assertions, all passing, in a staged copy"

# The named assertions have to EXIST in the baseline before their absence can
# mean anything.  Without this, renaming a test silently converts every gate
# below into "the suite failed for some other reason".
for want in \
  "a downgrade to a previously reviewed build is a HOLE, not OK" \
  "the expected pin is the sha256 of gh-app-token.js in this checkout" \
  "the superseded flat format is refused, not read as expected" \
  "an unknown state word is refused, not ignored"
do
  grep -qF "$want" <<<"$(sed 's/\x1b\[[0-9;]*m//g' <<<"$base_out")" \
    || fail "baseline does not contain the assertion \"$want\"; this gate is aiming at nothing"
done
[[ $rc -eq 0 ]] || exit 1

# --- 2. the gates -----------------------------------------------------------
# gate <label> <file-to-mutate> <sed-expr> <expected-failing-desc>...
gate() {
  local label="$1" target="$2" expr="$3"; shift 3
  local want; want="$(printf '%s\n' "$@" | sort)"
  local d="$TMP/$label"; stage "$d" || { fail "$label: could not stage"; return; }

  sed -i "$expr" "$d/$target"
  if cmp -s "$HERE/$target" "$d/$target"; then
    fail "$label: the mutation changed nothing — $target moved and this gate is now blind"
    return
  fi
  if [[ "$target" == *.sh ]] && ! bash -n "$d/$target" 2>/dev/null; then
    fail "$label: the mutation broke the parse; the suite would fail for the wrong reason"
    return
  fi

  local out; out="$(cd "$d" && "./$SUITE" 2>&1)"
  local got_pass got_fail; read -r got_pass got_fail <<<"$(counts "$out")"
  if [[ "${got_fail:-0}" == "0" ]]; then
    fail "$label: the suite PASSED against the mutation"
    return
  fi
  if [[ $(( ${got_pass:-0} + ${got_fail:-0} )) -ne $BASE_TOTAL ]]; then
    fail "$label: the mutated run made $(( ${got_pass:-0} + ${got_fail:-0} )) assertions, baseline made $BASE_TOTAL — assertions went missing, so a red here is not attributable"
    return
  fi
  local got; got="$(failed_descs "$out")"
  if [[ "$got" != "$want" ]]; then
    fail "$label: wrong assertions went red"
    printf '    want:\n%s\n    got:\n%s\n' "$(sed 's/^/      /' <<<"$want")" "$(sed 's/^/      /' <<<"$got")"
    return
  fi
  note "ok  $label"
}

# The flat known-good list, restored exactly.  Any build we ever reviewed reads
# as the build that is supposed to be running.
gate "downgrade-reads-as-current" credential_chain_audit.sh \
  's|^pin_is_expected() .*|pin_is_expected() { pin_was_reviewed "$1" \|\| [[ "$1" == "$PIN_EXPECTED" ]]; }|' \
  "a downgrade to a previously reviewed build is a HOLE, not OK"

# TOG-238's actual miss: the helper changes, the pin does not.
gate "helper-changed-without-repin" credential_chain_pins.txt \
  's/^expected  [0-9a-f]\{64\}/expected  0000000000000000000000000000000000000000000000000000000000000000/' \
  "the expected pin is the sha256 of gh-app-token.js in this checkout"

# Leniency toward a line the parser does not understand: skip it instead of
# refusing the file.  An ignored line and an unusable file must not read alike —
# a pin file that pins nothing would then be indistinguishable from one that
# pins the right thing.
gate "unknown-state-word-ignored" credential_chain_audit.sh \
  "s|^      \*) PINS_STATE=\"malformed\"; PINS_WHY=\"line \$_lineno: unknown state '\$state'\"; break ;;|      *) : ;;|" \
  "an unknown state word is refused, not ignored"

# The other half of the same refusal, and the one that carries the superseded
# flat format: a line whose second field is not a hash.  Gated separately
# because the two checks fail independently — the previous gate leaves this one
# intact, which is exactly how a half-removed control survives review.
gate "non-hash-pin-line-skipped" credential_chain_audit.sh \
  's|^      PINS_STATE="malformed"; PINS_WHY="line \$_lineno: not a sha256"; break|      continue|' \
  "the superseded flat format is refused, not read as expected"

[[ $rc -eq 0 ]] && printf '\npin gates: all held\n'
exit $rc
