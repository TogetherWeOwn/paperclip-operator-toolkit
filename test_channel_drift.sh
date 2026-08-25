#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for channel_drift.sh — the outbound-drift check.
#
# WHY THIS RUNS ANYWHERE. Both sides are fabricable: the suite builds a
# throwaway git repo in mktemp and a fake handoff channel next to it. No VPS,
# no /paperclip mount, no network, no credential, and nothing it writes leaves
# the temp directory.
#
# THE THREE ASSERTIONS THAT CARRY THIS SUITE:
#
#   1. Content, not path. A drop named `TOG-151-tool.sh` whose bytes are the
#      committed `tool.sh` must PASS. This is the whole reason channel_drift.sh
#      exists rather than `tool_drift.sh compare --strict`, which matches on
#      path and therefore reports the compliant drops as violations. If this
#      assertion goes, the tool has silently become the thing it replaced.
#
#   2. Same-SIZE, different-CONTENT is caught. Inherited from TOG-212, which
#      was found by comparing a printed test count — a fingerprint that
#      collides. Pins that this never regresses into a size or count heuristic.
#
#   3. Runnable is a UNION of three tests. A file with no exec bit and no
#      script extension, but a shebang, is still runnable and must still be
#      checked. Each of the three is asserted on its own, with the other two
#      absent, so none can be removed while the suite stays green — and there
#      is a negative control, so making EVERYTHING runnable does not pass.
#
# WHY PASS AND FAIL PRINT THE SAME LABEL. CI's mutation gate requires the
# NAMED assertion to flip from PASS to FAIL, not merely that the suite went
# red — a mutation that breaks the tool some other way also goes red, and is
# otherwise indistinguishable from the detector working. That attribution only
# works if the two branches print an identical string, so `ok` and `bad` take
# the same label and any detail goes on a separate line. Do not inline the
# actual exit code into a label; it makes the assertion unnameable.
#
# Exit status only. No assertion matches human-readable prose, which drifts.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CD="${CHANNEL_DRIFT_SH:-$HERE/channel_drift.sh}"
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  if [ $# -gt 1 ]; then printf '        %s\n' "$2"; fi
  FAIL=$((FAIL+1))
}
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# want_rc <expected> <label> — asserts on $RC, printing <label> either way.
want_rc() {
  if [ "$RC" -eq "$1" ]; then ok "$2"; else bad "$2" "exit $RC, want $1"; fi
}
# want_out <grep-pattern> <label> — asserts on $OUT, printing <label> either way.
want_out() {
  if printf '%s' "$OUT" | grep -q "$1"; then ok "$2"; else bad "$2" "output did not match: $1"; fi
}

[ -x "$CD" ] || { echo "no executable channel_drift.sh at $CD" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- the fabricated world ---------------------------------------------------
REPO="$WORK/repo"; CHAN="$WORK/channel"
mkdir -p "$REPO" "$CHAN"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@example.invalid
git -C "$REPO" config user.name  Test
git -C "$REPO" config commit.gpgsign false

mk() { mkdir -p "$(dirname "$1")"; printf '%s' "$2" > "$1"; }

mk "$REPO/tool.sh"        '#!/bin/sh
echo tool v1
'
mk "$REPO/lib/helper.sh"  'helper() { :; }
'
mk "$REPO/notes.md"       '# notes
'
# The canonical channel README (TOG-373). The name is the REAL one on purpose:
# channel_drift.sh hardcodes this table rather than reading it from config, so
# the fixture has to use the same name or the suite would be testing a
# mechanism the tool does not have. If someone renames the canonical file in
# the repo, `required mirror source is not on <ref>` fires here too.
mk "$REPO/handoff-channel-README.md" '# Operator handoff drop

Rules:
- Writing here is a proposal, not a deployment.
- A RUNNABLE file must be a MIRROR of something already committed.
'
git -C "$REPO" add -A >/dev/null
git -C "$REPO" commit -qm fixtures
git -C "$REPO" branch -M main

# An empty exemption file, so the suite never picks up the repo's real one.
EX="$WORK/exempt.txt"; printf '# none\n' > "$EX"

# The default fabricated world is a CORRECTLY INSTALLED channel: the required
# README is present and byte-identical. Every "exits 0" assertion in this suite
# depends on that, and the required-mirror section below is the one place that
# deliberately breaks it.
# Loud on failure. A silent `cp` error here would leave every "exits 0"
# assertion in the suite passing-or-failing for a reason that has nothing to do
# with what it claims to test.
install_readme() {
  cp "$REPO/handoff-channel-README.md" "$CHAN/README.md" \
    || { echo "FIXTURE BROKEN: cannot install the canonical README into the channel" >&2; exit 2; }
}
reset_channel() { rm -rf "$CHAN"; mkdir -p "$CHAN"; install_readme; }
# Run a check against the fabricated channel, from inside the fabricated repo.
run() { OUT="$( cd "$REPO" && "$CD" check --dir "$CHAN" --exempt "$EX" "$@" 2>&1 )"; RC=$?; }
# Same, with an explicit exemption file.
run_ex() { local e="$1"; shift; OUT="$( cd "$REPO" && "$CD" check --dir "$CHAN" --exempt "$e" "$@" 2>&1 )"; RC=$?; }

# ---------------------------------------------------------------------------
hdr "the hash is git-compatible (everything else is downstream of this)"
mismatch=0
for f in "$REPO/tool.sh" "$REPO/lib/helper.sh"; do
  got="$( len=$(wc -c < "$f"); { printf 'blob %d\0' "$len"; cat "$f"; } | sha1sum | cut -d' ' -f1 )"
  want="$(git -C "$REPO" hash-object "$f")"
  [ "$got" = "$want" ] || { mismatch=1; echo "    $f: $got != $want"; }
done
if [ "$mismatch" -eq 0 ]; then ok "the coreutils blob hash equals git hash-object"
else bad "the coreutils blob hash equals git hash-object" "see mismatches above"; fi

# ---------------------------------------------------------------------------
hdr "a correctly installed channel with no drops is clean"
reset_channel
run
want_rc 0 "no runnable artifacts exits 0"

# ---------------------------------------------------------------------------
hdr "ASSERTION 1 — content, not path (this is why the tool exists)"
reset_channel
# Same bytes as the committed tool.sh, under the issue-prefixed drop name.
cp "$REPO/tool.sh" "$CHAN/TOG-151-tool.sh"; chmod +x "$CHAN/TOG-151-tool.sh"
run
want_rc 0 "a prefixed drop matching a committed blob passes"

reset_channel
# Bytes of a file that lives at a DIFFERENT path in the repo, under a name that
# matches nothing. Content addressing must still pass it: the repo is allowed
# to move and rename its own files without breaking a compliant drop.
cp "$REPO/lib/helper.sh" "$CHAN/REFERENCE-something-else.sh"
run
want_rc 0 "a renamed drop matching a blob at another path passes"

# ---------------------------------------------------------------------------
hdr "unversioned — the TOG-356 case"
reset_channel
mk "$CHAN/TOG-152-armswitch.sh" '#!/bin/sh
echo never reviewed
'
chmod +x "$CHAN/TOG-152-armswitch.sh"
run
want_rc 3 "a drop whose content is in no commit fails"
want_out 'TOG-152-armswitch.sh' "the report names the offending file"

# ---------------------------------------------------------------------------
hdr "ASSERTION 2 — same size, different content is caught (no size heuristic)"
reset_channel
# `echo tool v1` -> `echo tool v2`: identical byte length, different content,
# and the drop is named so it maps onto the committed tool.sh.
mk "$CHAN/TOG-151-tool.sh" '#!/bin/sh
echo tool v2
'
chmod +x "$CHAN/TOG-151-tool.sh"
if [ "$(wc -c < "$CHAN/TOG-151-tool.sh")" = "$(wc -c < "$REPO/tool.sh")" ]; then
  ok "fixture: the tampered drop is byte-for-byte the same SIZE as the original"
else
  bad "fixture: the tampered drop is byte-for-byte the same SIZE as the original" \
      "the fixture drifted; the size-heuristic assertion below proves nothing"
fi
run
want_rc 3 "a same-size, different-content drop fails"

# ---------------------------------------------------------------------------
hdr "stale is distinguished from unversioned (they need different fixes)"
# The fixture above is the stale case: a tracked path of that name exists.
want_out 'STALE' "a drop whose name maps to a tracked path reports STALE"
reset_channel
mk "$CHAN/TOG-999-brand-new.sh" '#!/bin/sh
:
'
chmod +x "$CHAN/TOG-999-brand-new.sh"
run
want_out 'UNVERSIONED' "a drop whose name maps to nothing reports UNVERSIONED"

# ---------------------------------------------------------------------------
hdr "ASSERTION 3 — runnable is a union; each test carries its own case"
# (a) exec bit alone: no script extension, no shebang.
reset_channel
mk "$CHAN/TOG-300-payload" 'not a script by name or shebang
'
chmod +x "$CHAN/TOG-300-payload"
run
want_rc 3 "the exec bit alone makes a file runnable"

# (b) extension alone: not executable, no shebang.
reset_channel
mk "$CHAN/TOG-196-probe.mjs" 'console.log("run by node, never chmod +x");
'
chmod 0644 "$CHAN/TOG-196-probe.mjs"
run
want_rc 3 "a script extension alone makes a file runnable"

# (c) shebang alone: not executable, and named like evidence.
reset_channel
mk "$CHAN/TOG-301-findings.md" '#!/bin/sh
echo smuggled
'
chmod 0644 "$CHAN/TOG-301-findings.md"
run
want_rc 3 "a shebang alone makes a file runnable, whatever it is named"

# The negative control for the three above. Without it, a mutation that made
# EVERY file runnable would satisfy all three and this suite would prove
# nothing about the classifier — only that it is not empty.
reset_channel
mk "$CHAN/TOG-302-findings.md" '# a genuine evidence document

No shebang, no exec bit, no script extension.
'
chmod 0644 "$CHAN/TOG-302-findings.md"
run
want_rc 0 "an inert evidence document is NOT runnable and is ignored"

# ---------------------------------------------------------------------------
hdr "exemptions"
reset_channel
mk "$CHAN/TOG-303-vendor.sh" '#!/bin/sh
:
'
chmod +x "$CHAN/TOG-303-vendor.sh"
run
want_rc 3 "baseline: the file fails before it is exempted"

EX2="$WORK/exempt-with-entry.txt"
printf '# test\nTOG-303-vendor.sh\tthird-party, may not be redistributed\n' > "$EX2"
run_ex "$EX2"
want_rc 0 "an exemption with a stated reason passes the file"

run_ex "$EX2" --strict
want_rc 3 "--strict fails while an exemption is open"

EX3="$WORK/exempt-no-reason.txt"
printf '# test\nTOG-303-vendor.sh\n' > "$EX3"
run_ex "$EX3"
want_rc 2 "an exemption with no reason is REFUSED, not honoured"

EX4="$WORK/exempt-blank-reason.txt"
printf '# test\nTOG-303-vendor.sh\t   \n' > "$EX4"
run_ex "$EX4"
want_rc 2 "an exemption whose reason is only whitespace is REFUSED too"

# An exemption naming a file that is not there must not fail the run — the
# entry is simply inert — and must not resurrect anything either.
reset_channel
run_ex "$EX2"
want_rc 0 "an exemption for an absent file is inert"

# ---------------------------------------------------------------------------
# ASSERTION 4 — the required mirror (TOG-373).
#
# The channel README states the byte-for-byte rule, is root-owned so only the
# operator can install it, and is not runnable by ANY of the three tests above.
# Before this existed it was the one artifact in the channel with no receipt:
# hand-retyped out of a markdown fence, truncated, or never installed at all,
# and a clean run said nothing. Absence is the failure here, which is exactly
# what the runnable sweep cannot express — it only sees files that are there.
hdr "ASSERTION 4 — a required mirror is checked by name, and absence is a finding"
reset_channel
run
want_rc 0 "baseline: the required README installed and matching exits 0"

reset_channel
rm -f "$CHAN/README.md"
run
want_rc 3 "a MISSING required mirror fails"
want_out 'MISSING' "the report names absence as its own category"
want_out 'README.md' "the report names the missing file"

# Present, wrong bytes. Distinct from missing: someone installed SOMETHING.
reset_channel
mk "$CHAN/README.md" '# Operator handoff drop

Rules:
- Writing here is a proposal, not a deployment.
'
chmod 0644 "$CHAN/README.md"
# The point of this whole mechanism: this file is inert by all three runnable
# tests, so the sweep would never look at it. Pin that, or the assertion below
# could be passing because README.md accidentally became runnable — which
# would report it as UNVERSIONED and prove nothing about required mirrors.
inert=1
[ -x "$CHAN/README.md" ] && inert=0
case "$(head -c 2 "$CHAN/README.md")" in '#!') inert=0 ;; esac
case "$CHAN/README.md" in *.sh|*.bash|*.py|*.mjs|*.cjs|*.js) inert=0 ;; esac
if [ "$inert" -eq 1 ]; then ok "fixture: the required README is NOT runnable by any of the three tests"
else bad "fixture: the required README is NOT runnable by any of the three tests" \
         "it is runnable, so the assertion below would fire from the sweep instead"; fi
run
want_rc 3 "a required mirror whose bytes are not the committed blob fails"
want_out 'NOT THE COMMITTED COPY' "a tampered required mirror is not reported as UNVERSIONED"

# An exemption is the one mute path, and it costs a stated reason and a
# --strict failure, exactly as it does for a drop. No second escape hatch.
EX5="$WORK/exempt-readme.txt"
printf '# test\nREADME.md\tmid-migration, operator installs it next window\n' > "$EX5"
run_ex "$EX5"
want_rc 0 "an exemption with a reason covers a required mirror too"
run_ex "$EX5" --strict
want_rc 3 "--strict fails while a required mirror is exempted"

# The canonical blob missing from the ref must REFUSE, not render a verdict.
# TOG-357's rule: a comparison that did not happen must never read as an
# answer. Without this, renaming handoff-channel-README.md in the repo would
# silently condemn every correctly installed channel as tampered.
#
# In a SEPARATE repo, deliberately. Building this ref inside $REPO — an orphan
# branch, or `git rm --cached` — leaves that working tree half-checked-out, and
# the three sections after this one then pass for the wrong reason: the channel
# fails because the fixture broke, not because the assertion held. That is the
# vacuous green this repo keeps writing gates against, so it is designed out
# rather than cleaned up after.
reset_channel
REPO2="$WORK/repo-no-canonical"
mkdir -p "$REPO2"
git -C "$REPO2" init -q
git -C "$REPO2" config user.email t@example.invalid
git -C "$REPO2" config user.name  Test
git -C "$REPO2" config commit.gpgsign false
mk "$REPO2/tool.sh" '#!/bin/sh
echo tool v1
'
git -C "$REPO2" add -A >/dev/null && git -C "$REPO2" commit -qm "no canonical readme"
git -C "$REPO2" branch -M main
OUT="$( cd "$REPO2" && "$CD" check --dir "$CHAN" --exempt "$EX" 2>&1 )"; RC=$?
want_rc 2 "a ref with no canonical blob REFUSES rather than passing or failing"

# ...and the fixture repo is still intact, so everything after this section is
# still measuring what it says it measures.
if [ -f "$REPO/handoff-channel-README.md" ]; then
  ok "fixture: the main fixture repo survived the refusal test"
else
  bad "fixture: the main fixture repo survived the refusal test" \
      "the canonical file is gone; every assertion below this line is now vacuous"
fi

# ---------------------------------------------------------------------------
hdr "refusals — an unrecognised input must never exit 0 (TOG-201)"
( cd "$REPO" && "$CD" >/dev/null 2>&1 ); RC=$?
want_rc 2 "no subcommand refuses"
( cd "$REPO" && "$CD" fingerprint >/dev/null 2>&1 ); RC=$?
want_rc 2 "an unrecognised subcommand refuses"
( cd "$REPO" && "$CD" check --nope >/dev/null 2>&1 ); RC=$?
want_rc 2 "an unknown option refuses"
( cd "$REPO" && "$CD" check --dir "$CHAN" positional >/dev/null 2>&1 ); RC=$?
want_rc 2 "an unexpected positional argument refuses"
( cd "$REPO" && "$CD" check --dir "$WORK/no-such-dir" >/dev/null 2>&1 ); RC=$?
want_rc 2 "a missing channel directory refuses"
( cd "$REPO" && "$CD" check --dir "$CHAN" --exempt "$WORK/no-such-file" >/dev/null 2>&1 ); RC=$?
want_rc 2 "an unreadable EXPLICIT exemption file refuses"
( cd "$REPO" && "$CD" check --dir "$CHAN" --ref no/such/ref >/dev/null 2>&1 ); RC=$?
want_rc 2 "an unknown ref refuses"
( cd "$WORK" && "$CD" check --dir "$CHAN" >/dev/null 2>&1 ); RC=$?
want_rc 2 "running outside a git checkout refuses"
( cd "$REPO" && "$CD" --help >/dev/null 2>&1 ); RC=$?
want_rc 0 "--help answers instead of refusing"

# ---------------------------------------------------------------------------
hdr "--quiet is exit-status-only"
reset_channel
mk "$CHAN/TOG-304-x.sh" '#!/bin/sh
:
'
chmod +x "$CHAN/TOG-304-x.sh"
run --quiet
want_rc 3 "--quiet still fails on drift"
if [ -z "$OUT" ]; then ok "--quiet prints nothing"; else bad "--quiet prints nothing" "printed: $OUT"; fi

# ---------------------------------------------------------------------------
hdr "the check reads the ref, not the working tree"
# A drop matching an UNCOMMITTED working-tree file must still fail: the point
# is that review happened, and an uncommitted file has not been reviewed.
reset_channel
mk "$REPO/uncommitted.sh" '#!/bin/sh
echo not yet committed
'
cp "$REPO/uncommitted.sh" "$CHAN/TOG-305-uncommitted.sh"; chmod +x "$CHAN/TOG-305-uncommitted.sh"
run
want_rc 3 "matching an uncommitted working-tree file does not count"
rm -f "$REPO/uncommitted.sh"

# ---------------------------------------------------------------------------
hdr "--ref selects which history is authoritative"
reset_channel
git -C "$REPO" checkout -q -b side
mk "$REPO/sidetool.sh" '#!/bin/sh
echo only on side
'
git -C "$REPO" add -A >/dev/null && git -C "$REPO" commit -qm side
git -C "$REPO" checkout -q main
git -C "$REPO" show side:sidetool.sh > "$CHAN/TOG-306-sidetool.sh"
chmod +x "$CHAN/TOG-306-sidetool.sh"
run
want_rc 3 "a blob that exists only on another branch fails against main"
run --ref side
want_rc 0 "the same blob passes against the branch that holds it"

# ---------------------------------------------------------------------------
printf '\n\033[1mchannel_drift: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
