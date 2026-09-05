#!/usr/bin/env bash
# =====================================================================================
# deploy_window_open.sh — THE operator entry point for the TOG-990 deploy window.
#
# Run THIS, not the gate directly. Operator procedure: docs/deploy-window.md
#
# Running `python3 /paperclip/operator-handoff/deploy-window-manifest.py` yourself
# BYPASSES the drift check below — silently, because the bypassed check is the thing
# that would have warned you. It will print VERDICT: READY and exit 0 either way.
#
# WHY THIS FILE EXISTS, AND WHY THE CHECK IS NOT INSIDE THE GATE
# --------------------------------------------------------------
# The operator runs /paperclip/operator-handoff/deploy-window-manifest.py, which is a
# SEPARATE FILE from the reviewed deploy_window_manifest.py in this repo. Nothing links
# them. Measured 2026-09-05: the handoff copy sat one commit behind the reviewed one
# while BOTH printed "VERDICT: READY" on a green tree. The drift was invisible on a
# green and only diverged on a red — where the stale copy emitted the "re-cut it"
# repair advice that TOG-998 measured wrong 7/7 on this very tree.
#
# The obvious fix — have the gate hash itself against the reviewed copy — was built and
# then REJECTED on evidence. Restoring the genuine stale bytes (ad324225) as the handoff
# copy and re-running produced exit=0 READY: the stale revision does not CONTAIN the
# self-check, so a self-hosted guard is structurally blind to the exact case it exists
# for. It kills a one-byte tamper (a mutant that does contain the check) and survives
# real staleness, which is the mutant that matters. A check an attacker-or-accident can
# remove by being old is not a check.
#
# So the comparison must be made by something the stale copy cannot disable: this
# wrapper, which verifies the handoff copy BEFORE invoking it, and refuses to invoke it
# at all on drift. verification/tog-990-handoff-copy-drift.sh holds the comparison and
# is registered nowhere (CI runners have no /paperclip), so this is its only caller.
#
# TOG-999: that comparison's reviewed side is a PINNED, content-addressed git blob, not
# the working-tree copy. Both operands used to be editable files, so mutating BOTH
# identically -- a rebase or a stray checkout in this shared workspace -- passed at
# exit 0. verification/tog-999-drift-pin-mutation-gate.sh covers that correlated case.
#
# ORDER IS THE WHOLE POINT: check first, then run. Running first would take advice from
# unreviewed bytes before learning they were unreviewed.
#
#   exit 0  handoff copy is the reviewed gate AND the window is READY
#   exit 1  drift in the gate itself, or the window is not READY
#   exit 2  could not evaluate
# =====================================================================================
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIFT_CHECK="$HERE/verification/tog-990-handoff-copy-drift.sh"
HOST_GATE="/paperclip/operator-handoff/deploy-window-manifest.py"

[ -x "$DRIFT_CHECK" ] || { printf 'ERROR: drift check missing or not executable: %s\n' "$DRIFT_CHECK"; exit 2; }

printf '== step 1/2: is the gate the operator runs the gate that was reviewed?\n\n'
# Deliberately NOT `|| true`: a red here must stop the window.
if ! "$DRIFT_CHECK"; then
  printf '\nREFUSING to run the window gate: the copy on this host is not the reviewed one.\n'
  printf 'Sync it as instructed above, then re-run this script.\n'
  exit 1
fi

printf '\n== step 2/2: does the window itself verify?\n\n'
rc=0
python3 "$HOST_GATE" "$@" || rc=$?

if [ "$rc" -eq 0 ]; then
  printf '\nWINDOW OPEN: the gate is the reviewed one and every staged card verified.\n'
else
  printf '\nWINDOW CLOSED (gate exit %s): the gate is reviewed, but the window did not verify.\n' "$rc"
fi
exit "$rc"
