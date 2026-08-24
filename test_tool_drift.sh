#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for tool_drift.sh — the running-vs-reviewed check.
#
# WHY THIS RUNS ANYWHERE. The thing under test compares content hashes against
# a git ref. Both halves are fabricable: the suite builds a THROWAWAY git repo
# in mktemp, commits fixtures into it, and mutates a working copy. No VPS, no
# network, no credential, and nothing it writes leaves the temp directory.
#
# THE TWO ASSERTIONS THAT CARRY THIS SUITE, both of which encode TOG-212:
#
#   1. The coreutils hash equals `git hash-object`. That equality is the ONLY
#      reason the fingerprint side can run on a box with no git and no clone,
#      which is the entire deployment story. If it ever stops holding, every
#      comparison reports total drift and the tool is worthless — so it is
#      asserted directly rather than assumed.
#
#   2. Same-SIZE, different-CONTENT is detected. TOG-212 was found by comparing
#      a printed test count (114 vs 156), which is a fingerprint that collides
#      and drifts for innocent reasons; CONTRIBUTING.md forbids gating on one.
#      This pins that the tool never regresses into a count or size heuristic.
#
# Exit status only. No assertion here matches human-readable prose, which
# drifts — they match exit codes and machine-readable paths.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIFT="${TOOL_DRIFT_SH:-$HERE/tool_drift.sh}"
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -x "$DRIFT" ] || { echo "no executable tool_drift.sh at $DRIFT" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- the fabricated world ---------------------------------------------------
# A real git repo, so `git ls-tree` has something authoritative to read, and a
# separate "deployed" directory standing in for the VPS.
REPO="$WORK/repo"; SRC="$WORK/deployed"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@example.invalid
git -C "$REPO" config user.name  Test
git -C "$REPO" config commit.gpgsign false

mk() { mkdir -p "$(dirname "$1")"; printf '%s' "$2" > "$1"; }

mk "$REPO/alpha.sh"     '#!/bin/sh
echo alpha
'
mk "$REPO/beta.js"      'console.log("beta");
'
mk "$REPO/lib/util.sh"  'util() { :; }
'
mk "$REPO/docs/x.md"    '# doc
'
git -C "$REPO" add -A >/dev/null
git -C "$REPO" commit -qm "fixtures"
git -C "$REPO" branch -M main

# The deployed copy starts identical.
cp -r "$REPO" "$SRC"; rm -rf "$SRC/.git"

fp()      { ( cd "$SRC"  && "$DRIFT" fingerprint . ); }
compare() { ( cd "$REPO" && "$DRIFT" compare "$@" ); }
# Run a comparison, capture exit code and output.
run() { OUT="$( compare "$@" 2>&1 )"; RC=$?; }

# ---------------------------------------------------------------------------
hdr "the hash is git-compatible (this is what lets the far side have no git)"
fp > "$WORK/base.fp"
hash_mismatch=0
while IFS=$'\t' read -r h rel; do
  case "$h" in '#'*|'') continue ;; esac
  want="$(git -C "$REPO" hash-object "$SRC/$rel")"
  [ "$h" = "$want" ] || { hash_mismatch=1; echo "    $rel: $h != $want"; }
done < "$WORK/base.fp"
[ "$hash_mismatch" -eq 0 ] && ok "every fingerprint equals git hash-object" \
                           || bad "a fingerprint disagrees with git hash-object"

# ---------------------------------------------------------------------------
hdr "clean comparison"
run "$WORK/base.fp"
[ "$RC" -eq 0 ] && ok "identical trees exit 0" || bad "identical trees exit $RC, want 0"

run - <<< "$(cat "$WORK/base.fp")"
[ "$RC" -eq 0 ] && ok "fingerprint on stdin via '-'" || bad "stdin form exit $RC, want 0"

# ---------------------------------------------------------------------------
hdr "drift detection"
# One byte, inside a file that keeps the SAME BYTE LENGTH. A size or line-count
# check cannot see this; a content hash must. See the header.
before_len=$(wc -c < "$SRC/alpha.sh")
mk "$SRC/alpha.sh" '#!/bin/sh
echo alphb
'
after_len=$(wc -c < "$SRC/alpha.sh")
if [ "$before_len" -eq "$after_len" ]; then ok "fixture keeps byte length identical (size heuristic would be blind)"
else bad "fixture changed length ($before_len -> $after_len); the same-size assertion below is not testing what it claims"; fi

fp > "$WORK/drift.fp"
run "$WORK/drift.fp"
[ "$RC" -eq 3 ] && ok "same-size content change exits 3" || bad "content change exits $RC, want 3"
grep -q 'alpha.sh' <<< "$OUT" && ok "the drifted path is named" || bad "drifted path not named"

# THE REGRESSION THIS SUITE WAS WRITTEN AGAINST. A `trap ... RETURN` over a
# `local` temp path fired after the local went out of scope; under `set -u`
# that aborted the function with 1, silently replacing the documented drift
# code. The tool still printed the right report, so only an exit-status
# assertion catches it. Never gate on the prose.
[ "$RC" -ne 1 ] && ok "drift does not leak a generic exit 1" || bad "drift exited 1 — the documented code was replaced"

# ---------------------------------------------------------------------------
hdr "a tool that was never imported at all"
cp -r "$SRC" "$WORK/src2"; SRC_ORIG="$SRC"; SRC="$WORK/src2"
mk "$SRC/alpha.sh" '#!/bin/sh
echo alpha
'                                   # undo the drift, isolate this case
mk "$SRC/never_imported.sh" 'echo hi
'
fp > "$WORK/extra.fp"
run "$WORK/extra.fp"
[ "$RC" -eq 3 ] && ok "an unversioned tool exits 3" || bad "unversioned tool exits $RC, want 3"
grep -q 'never_imported.sh' <<< "$OUT" && ok "the unversioned path is named" || bad "unversioned path not named"
SRC="$SRC_ORIG"

# ---------------------------------------------------------------------------
hdr "present in the repo, absent at the source"
grep -v 'docs/x.md' "$WORK/base.fp" > "$WORK/missing.fp"
run "$WORK/missing.fp"
[ "$RC" -eq 0 ] && ok "not-deployed is informational by default (exit 0)" \
               || bad "not-deployed exits $RC by default, want 0"
run "$WORK/missing.fp" --strict
[ "$RC" -eq 3 ] && ok "--strict makes not-deployed count" || bad "--strict exits $RC, want 3"

# ---------------------------------------------------------------------------
hdr "secrets are never read"
# Extensions that would otherwise match, plus the .gitignore'd secret shapes.
mk "$SRC/creds.env"            'TOKEN=canary
'
mk "$SRC/id.pem"               'canary
'
mk "$SRC/x.key"                'canary
'
mk "$SRC/audit.jsonl"          '{"canary":1}
'
mk "$SRC/.gh-app-token.json"   '{"token":"canary"}
'
fp > "$WORK/secret.fp"
leaked=0
for p in creds.env id.pem x.key audit.jsonl .gh-app-token.json; do
  grep -qF "$p" "$WORK/secret.fp" && { leaked=1; echo "    fingerprinted: $p"; }
done
[ "$leaked" -eq 0 ] && ok "no secret-shaped file is fingerprinted" || bad "a secret-shaped file was fingerprinted"
grep -q 'canary' "$WORK/secret.fp" && bad "fixture content reached the fingerprint output" \
                                   || ok "no fixture content in the output"

# ---------------------------------------------------------------------------
hdr "pruned directories"
mkdir -p "$SRC/node_modules/pkg" "$SRC/.git"
mk "$SRC/node_modules/pkg/index.js" 'module.exports=1
'
mk "$SRC/.git/config" '[core]
'
fp > "$WORK/prune.fp"
grep -q 'node_modules' "$WORK/prune.fp" && bad "node_modules was fingerprinted" || ok "node_modules is pruned"
grep -qE '^[0-9a-f]+\s+\.git/' "$WORK/prune.fp" && bad ".git was fingerprinted" || ok ".git is pruned"

# ---------------------------------------------------------------------------
hdr "refusals — the default is refusal, and it is never exit 0"
r() { ( cd "${2:-$REPO}" && "$DRIFT" $1 >/dev/null 2>&1 ); echo $?; }
[ "$(r '')" -ne 0 ]                        && ok "no subcommand refuses"       || bad "no subcommand exited 0"
[ "$(r 'bogus')" -ne 0 ]                   && ok "unknown subcommand refuses"  || bad "unknown subcommand exited 0"
[ "$(r 'compare')" -eq 2 ]                 && ok "compare with no file: exit 2" || bad "compare with no file: wrong code"
[ "$(r "compare $WORK/base.fp --nope")" -eq 2 ] && ok "unknown option: exit 2" || bad "unknown option: wrong code"
[ "$(r "compare $WORK/nosuch.fp")" -eq 2 ] && ok "unreadable file: exit 2"     || bad "unreadable file: wrong code"
[ "$(r "compare $WORK/base.fp --ref no-such-ref")" -eq 2 ] && ok "bad ref: exit 2" || bad "bad ref: wrong code"
[ "$(r "compare $WORK/base.fp" "$WORK")" -eq 2 ] && ok "outside a checkout: exit 2" || bad "outside a checkout: wrong code"
[ "$(r 'fingerprint /no/such/dir')" -eq 2 ] && ok "fingerprint bad dir: exit 2" || bad "fingerprint bad dir: wrong code"

# ---------------------------------------------------------------------------
hdr "paths containing spaces"
mk "$SRC/a file.sh" 'echo spaced
'
fp > "$WORK/space.fp"
grep -q 'a file.sh' "$WORK/space.fp" && ok "a spaced path is fingerprinted" || bad "spaced path missing"
run "$WORK/space.fp"
[ "$RC" -eq 3 ] && ok "a spaced path is compared as one path" || bad "spaced path compare exit $RC, want 3"

# ---------------------------------------------------------------------------
printf '\n'
if [ "$FAIL" -eq 0 ]; then printf '\033[32mtool_drift: %d passed, 0 failed\033[0m\n' "$PASS"; exit 0
else printf '\033[31mtool_drift: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"; exit 1; fi
