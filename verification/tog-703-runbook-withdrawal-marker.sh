#!/usr/bin/env bash
# =============================================================================
# tog-703-runbook-withdrawal-marker.sh — the RUNBOOK must not route an operator
# to a fork-building script without saying it is withdrawn.
#
# WHY THIS EXISTS, GIVEN tog-916-no-fork-guard.sh ALREADY PASSES.
# That gate holds a property of the SCRIPTS: every fork-building script refuses
# before it can build. Measured 2026-09-05, it was green while
# docs/OPERATOR-RUNBOOK.md section 8 still said, in the imperative, "Run v2
# (TOG-516-operator-v2.sh)" with no withdrawal marker anywhere in the section
# and a copy-pasteable command block underneath. A guard can be reachable in
# the REPO and absent from the PROCEDURE. The operator reads the runbook.
#
# WHY NOT LEAN ON THE sha256 CHECK IN THAT COMMAND BLOCK.
# A hash gate compares bytes; it cannot see a withdrawn authorisation. The v2
# hash there is in fact stale (file drifted to 66e41134 when the guard was
# added), so today it happens to fail — but that is an accident, and the
# obvious "fix" is to re-pin it, which silently re-arms the whole section.
# Withdrawal has to be asserted as withdrawal, independently of any hash.
#
# WHAT IS ASSERTED. For each fork-building script name that appears in the
# runbook, the section containing it carries an explicit withdrawal marker.
# Discovery is BY MEASUREMENT: the script set is recomputed from the staging
# directory (contains `podman build` AND sources the no-fork guard), never
# hardcoded — so a tenth script mentioned in the runbook tomorrow fails here
# instead of slipping through.
#
# EXPIRY: lapses with TOG-1010. A concern surviving the v2026.831.1 re-test
# goes upstream as a PR, not through these scripts or this runbook section.
# =============================================================================
set -Eeuo pipefail

STAGING="${STAGING_DIR:-/paperclip/instances/default/data/deployment-staging}"
RUNBOOK="${RUNBOOK_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docs/OPERATOR-RUNBOOK.md}"

pass=0; fail=0
ok()   { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }

test -r "$RUNBOOK" || { printf 'runbook not readable: %s\n' "$RUNBOOK" >&2; exit 2; }

# --- discover the fork-building scripts by measurement -----------------------
mapfile -t scripts < <(
  for f in "$STAGING"/*.sh; do
    [ -f "$f" ] || continue
    grep -q 'podman build' "$f" 2>/dev/null || continue
    grep -q 'no-fork-guard' "$f" 2>/dev/null || continue
    basename "$f"
  done | sort
)
test "${#scripts[@]}" -gt 0 || { printf 'discovered no fork-building scripts — check STAGING_DIR\n' >&2; exit 2; }
printf '\n== fork-building scripts discovered: %d\n\n' "${#scripts[@]}"

# Section boundaries: '### ' headings.
mapfile -t heads < <(grep -n '^### ' "$RUNBOOK" | cut -d: -f1)
total_lines=$(wc -l < "$RUNBOOK")

section_bounds() { # $1=line -> echoes "start end"
  local line=$1 start=1 end=$total_lines h
  for h in "${heads[@]}"; do
    if [ "$h" -le "$line" ]; then start=$h; else end=$((h-1)); break; fi
  done
  printf '%s %s\n' "$start" "$end"
}

# A marker must be an explicit withdrawal/prohibition, not merely the word "not".
MARKER_RE='WITHDRAWN|DO NOT RUN|NO[- ]FORK|not authorised'

for s in "${scripts[@]}"; do
  mapfile -t hits < <(grep -Fn "$s" "$RUNBOOK" | cut -d: -f1)
  if [ "${#hits[@]}" -eq 0 ]; then
    ok "$s is not mentioned in the runbook (nothing to route)"
    continue
  fi
  for line in "${hits[@]}"; do
    read -r start end < <(section_bounds "$line")
    hdr=$(sed -n "${start}p" "$RUNBOOK" | cut -c1-60)
    if sed -n "${start},${end}p" "$RUNBOOK" | grep -Eq "$MARKER_RE"; then
      ok "$s @${line} — section '${hdr}' carries a withdrawal marker"
    else
      bad "$s @${line} — section '${hdr}' (lines ${start}-${end}) routes to a prohibited build with NO withdrawal marker"
    fi
  done
done

# --- the successor path must be named, or the operator has nowhere to go -----
printf '\n== the withdrawal must name where the work went instead\n\n'
if grep -q 'TOG-1010' "$RUNBOOK"; then
  ok "runbook names the successor path TOG-1010"
else
  bad "runbook withdraws the fork build but never names TOG-1010 as the successor"
fi

printf '\n== %d passed, %d failed\n\n' "$pass" "$fail"
test "$fail" -eq 0 || exit 1
printf 'No runbook section routes an operator to a fork build without withdrawing it.\n'
