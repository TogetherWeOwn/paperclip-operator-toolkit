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
# The tools are EXECUTABLE and that mode is load-bearing, not cosmetic: the
# coverage gate (TOG-357) tells "matched a tool" from "matched a README" by the
# mode git recorded. Fixtures that are all mode 644 give that gate nothing to
# fire on, and it would sit here untested while looking covered.
chmod +x "$REPO/alpha.sh" "$REPO/beta.js" "$REPO/lib/util.sh"
git -C "$REPO" add -A >/dev/null
git -C "$REPO" commit -qm "fixtures"
git -C "$REPO" branch -M main

# A second ref with the SAME content at mode 644. This exists to isolate the
# two halves of the coverage gate from each other: against `main` an empty
# fingerprint is caught by the executable check as well as the emptiness check,
# so a test using only `main` passes even with the emptiness check deleted —
# it is covered by its neighbour, which is not coverage. Against `noexec` the
# executable check cannot fire (there are none to match), so the emptiness
# check is the only thing standing between a wrong directory and a green.
git -C "$REPO" checkout -q -b noexec
git -C "$REPO" update-index --chmod=-x alpha.sh beta.js lib/util.sh
git -C "$REPO" commit -qm "same content, no executables"
git -C "$REPO" checkout -q main

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
mk "$SRC/token-cache.json"     '{"token":"canary"}
'
fp > "$WORK/secret.fp"
leaked=0
for p in creds.env id.pem x.key audit.jsonl token-cache.json; do
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
# THE COVERAGE GATE (TOG-357). The failure being pinned here is not a missed
# drift — it is a comparison that never happened reporting itself as clean.
#
# Before this gate, fingerprinting a directory that held none of these tools
# produced identical:0 drifted:0 unversioned:0, which fell through every
# condition to "no drift" and exit 0. TOG-212's operator searched the wrong
# directory and found nothing, so the wrong directory is the BASE case for this
# ask, and a false green there re-arms the exact assumption the tool exists to
# retire. Exit 2 (refused: we did not measure) not 3 (drift: we measured and it
# differed) — the two want different next actions from whoever reads the code.
hdr "coverage gate — a comparison that measured nothing must never read green"

EMPTY="$WORK/emptydir"; mkdir -p "$EMPTY"
( cd "$EMPTY" && "$DRIFT" fingerprint . ) > "$WORK/empty.fp"
[ "$(grep -cv '^#' "$WORK/empty.fp" || true)" -eq 0 ] && ok "an empty dir fingerprints to no entries" \
                                                      || bad "the empty fixture was not empty"
run "$WORK/empty.fp"
[ "$RC" -eq 2 ] && ok "an empty fingerprint refuses (exit 2)" \
                || bad "an empty fingerprint exited $RC, want 2 — a measurement that never happened read as clean"
[ "$RC" -ne 0 ] && ok "an empty fingerprint is never exit 0" || bad "an empty fingerprint exited 0"

# Against a ref with no executables, the emptiness check is UNASSISTED. Without
# this the assertion above is satisfied by the executable check next to it, and
# deleting the emptiness check entirely leaves this suite green — which is the
# same "passes for the wrong reason" defect the gate itself exists to stop.
run "$WORK/empty.fp" --ref noexec
[ "$RC" -eq 2 ] && ok "an empty fingerprint refuses even when the ref has no executables" \
                || bad "empty fp vs a no-executable ref exited $RC, want 2 — the emptiness check is not carrying its own weight"

# The near miss that survives the emptiness check: a directory sharing a path
# with the ref, but only a documentation path. Non-zero entries, a genuine
# match, still not the directory the tools run from.
DOCONLY="$WORK/doconly"; mkdir -p "$DOCONLY"
mk "$DOCONLY/docs/x.md" '# doc
'
( cd "$DOCONLY" && "$DRIFT" fingerprint . ) > "$WORK/doconly.fp"
[ "$(grep -cv '^#' "$WORK/doconly.fp" || true)" -eq 1 ] && ok "the doc-only fixture has exactly one entry" \
                                                        || bad "the doc-only fixture is not one entry"
run "$WORK/doconly.fp"
[ "$RC" -eq 2 ] && ok "matching only a non-executable refuses (exit 2)" \
                || bad "doc-only match exited $RC, want 2 — a README made a wrong directory read as clean"
grep -q 'identical: 1' <<< "$OUT" && ok "the doc-only match really did match a path" \
                                  || bad "the doc-only fixture never matched, so the gate fired for the wrong reason"

# And the gate must not be a blunt instrument: a real deployment holds the
# tools but legitimately not every doc, and that is the case this whole tool
# exists to report on. If this goes red the gate is refusing honest work.
DEPLOYED="$WORK/exec-no-docs"; mkdir -p "$DEPLOYED"
# Built from the ref, not from $SRC: earlier sections deliberately mutate $SRC,
# so copying from it would seed this fixture with real drift and the assertion
# below would fail for a reason that has nothing to do with the coverage gate.
git -C "$REPO" show "main:alpha.sh" > "$DEPLOYED/alpha.sh"
git -C "$REPO" show "main:beta.js"  > "$DEPLOYED/beta.js"
( cd "$DEPLOYED" && "$DRIFT" fingerprint . ) > "$WORK/execonly.fp"
run "$WORK/execonly.fp"
[ "$RC" -eq 0 ] && ok "executables present, docs absent: still exit 0" \
                || bad "a legitimate partial deployment exited $RC, want 0 — the gate over-refuses"
grep -q 'coverage:' <<< "$OUT" && ok "compare reports coverage on every run" \
                               || bad "no coverage line in the report"

# ---------------------------------------------------------------------------
# manifest / locate (TOG-357). TOG-212 asked an operator to fingerprint "the
# directory the tools run from" and they could not find one — the ask assumed
# the answer to the question it was asking. These two subcommands are that
# search, split along the same seam as the rest: manifest needs the clone,
# locate needs only bash and coreutils.
hdr "manifest — the names locate searches for"
MAN="$WORK/tools.manifest"
( cd "$REPO" && "$DRIFT" manifest ) > "$MAN"; man_rc=$?
[ "$man_rc" -eq 0 ] && ok "manifest exits 0 in a checkout" || bad "manifest exited $man_rc"
grep -qx 'alpha.sh' "$MAN" && ok "manifest lists an executable tool" || bad "manifest missed alpha.sh"
grep -qx 'util.sh'  "$MAN" && ok "manifest lists a nested executable by basename" || bad "manifest missed lib/util.sh"
grep -qx 'x.md'     "$MAN" && bad "manifest listed a non-executable doc" || ok "manifest omits non-executables"
[ "$( ( cd "$WORK" && "$DRIFT" manifest >/dev/null 2>&1 ); echo $? )" -eq 2 ] \
  && ok "manifest outside a checkout: exit 2" || bad "manifest outside a checkout: wrong code"

hdr "locate — find the directory before fingerprinting it"
loc() { ( cd "${2:-$WORK}" && "$DRIFT" locate $1 2>&1 ); }
LOC_OUT="$( "$DRIFT" locate "$MAN" "$SRC" 2>&1 )"; LOC_RC=$?
[ "$LOC_RC" -eq 0 ] && ok "locate exits 0 when it finds a candidate" || bad "locate exited $LOC_RC, want 0"
head -n 20 <<< "$LOC_OUT" | grep -qE "^[0-9]+	$SRC$" \
  && ok "locate names the deployed directory" || bad "locate did not name $SRC"
# Ranking is the whole output: the operator fingerprints the top line.
TOP="$(grep -vE '^#|^$' <<< "$LOC_OUT" | grep -E '^[0-9]+	' | head -1 | cut -f2)"
[ "$TOP" = "$SRC" ] && ok "the deployed directory ranks first" || bad "top-ranked was '$TOP', want $SRC"

BARE="$WORK/nothing-here"; mkdir -p "$BARE"
"$DRIFT" locate "$MAN" "$BARE" >/dev/null 2>&1
[ $? -eq 3 ] && ok "locate finds nothing: exit 3, not 0" || bad "locate on an empty root did not exit 3"

printf '# only comments\n' > "$WORK/empty.manifest"
[ "$( "$DRIFT" locate "$WORK/empty.manifest" "$SRC" >/dev/null 2>&1; echo $? )" -eq 2 ] \
  && ok "an all-comment manifest refuses (exit 2)" || bad "an empty manifest did not refuse"
[ "$( "$DRIFT" locate >/dev/null 2>&1; echo $? )" -eq 2 ] \
  && ok "locate with no manifest: exit 2" || bad "locate with no manifest: wrong code"
[ "$( "$DRIFT" locate "$WORK/nosuch.manifest" >/dev/null 2>&1; echo $? )" -eq 2 ] \
  && ok "locate with an unreadable manifest: exit 2" || bad "locate unreadable manifest: wrong code"

# ---------------------------------------------------------------------------
printf '\n'
if [ "$FAIL" -eq 0 ]; then printf '\033[32mtool_drift: %d passed, 0 failed\033[0m\n' "$PASS"; exit 0
else printf '\033[31mtool_drift: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"; exit 1; fi
