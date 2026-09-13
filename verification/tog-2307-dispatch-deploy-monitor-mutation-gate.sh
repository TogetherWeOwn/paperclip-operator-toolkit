#!/usr/bin/env bash
# ===========================================================================
# tog-2307-dispatch-deploy-monitor-mutation-gate.sh
#
# Is test_dispatch_deploy_monitor.sh actually load-bearing against scripts/
# dispatch_deploy_monitor.sh, or does it merely pass on an unmutated wrapper?
#
# Mutants target the wrapper's specific promises: drift/refusal never read
# as healthy, an undocumented exit code is never trusted as a pass, and a
# re-arm is verified against the authoritative monitorNextCheckAt column
# rather than the request's own echo. Each mutant is planted against a COPY
# of the wrapper inside a fresh scene containing the unmodified test suite;
# only the artifact under test changes.
#
# EXIT CODES ARE ASSERTED EXACTLY: rc 0 pass, rc 1 fail (test suite's own
# convention). A mutant is killed only when the suite reports rc 1.
#
# Run from anywhere: ./verification/tog-2307-dispatch-deploy-monitor-mutation-gate.sh
# Exit 0 = every mutant killed and the positive control behaved.
# ===========================================================================

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOL_REL="scripts/dispatch_deploy_monitor.sh"
TOOL_SRC="$REPO_ROOT/$TOOL_REL"
TEST_SRC="$REPO_ROOT/test_dispatch_deploy_monitor.sh"

[ -f "$TOOL_SRC" ] || { echo "FATAL: no tool at $TOOL_SRC" >&2; exit 2; }
[ -f "$TEST_SRC" ] || { echo "FATAL: no test suite at $TEST_SRC" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tog2307monmut.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
kill_ok() { printf '  \033[32mKILLED\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
survived() { printf '  \033[31mSURVIVED\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

mkscene() {
  local dir="$1"
  rm -rf "$dir"; mkdir -p "$dir/scripts"
  cp "$TOOL_SRC" "$dir/scripts/"
  cp "$TEST_SRC" "$dir/"
  chmod +x "$dir/scripts/$(basename "$TOOL_REL")" "$dir/test_dispatch_deploy_monitor.sh"
}

run_scene() {
  ( cd "$1" && ./test_dispatch_deploy_monitor.sh >"$1/.out" 2>&1; echo $? )
}

echo "TOG-2307 dispatch_deploy_monitor.sh mutation suite"
echo

# --- POSITIVE CONTROL -------------------------------------------------------
S="$WORK/control_pos"; mkscene "$S"
rc="$(run_scene "$S")"
if [ "$rc" -eq 0 ]; then
  kill_ok "CONTROL+  unmutated wrapper -> rc 0 (suite is green on the real wrapper)"
else
  survived "CONTROL+  unmutated wrapper -> rc $rc, expected 0. Suite is red on the truth; nothing below is evidence."
  sed 's/^/           | /' "$S/.out" | tail -20
fi

# --- M1: undocumented exit codes are no longer normalised to refused -------
# Targets "an undocumented exit code is treated as refused, not as a pass":
# the *) branch of the interval case statement is the only place that
# clamps STATUS_RC to 2. Removing the clamp lets an unrecognised detector
# exit code (e.g. 7) pass through as its raw value instead of being folded
# into the safe "refused" bucket.
S="$WORK/m1"; mkscene "$S"
F="$S/scripts/dispatch_deploy_monitor.sh"
old='  *) STATUS_RC=2; NEXT_HOURS="$ERROR_RETRY_HOURS" ;;'
grep -qF "$old" "$F" || { printf '  \033[31mBROKEN\033[0m   M1 anchor not found; re-derive this mutant.\n' >&2; exit 2; }
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = '  *) STATUS_RC=2; NEXT_HOURS="$ERROR_RETRY_HOURS" ;;\n'
new = '  *) NEXT_HOURS="$ERROR_RETRY_HOURS" ;;\n'
assert old in s, "M1 anchor not found -- re-derive this mutant"
open(p, "w").write(s.replace(old, new, 1))
PY
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M1  undocumented exit codes pass through instead of normalising to refused (2)" \
  || survived "M1  exit-code normalisation removed -> suite rc $rc, expected 1"

# --- M2: re-arm verification reads the request's own echo, not the column --
# Targets "the monitor is armed against the authoritative column, not our
# own echo": switch STORED_NEXT from the top-level monitorNextCheckAt
# column to the nested executionPolicy.monitor.nextCheckAt, which the
# server echoes back verbatim from the request whether or not the column
# was actually persisted.
S="$WORK/m2"; mkscene "$S"
F="$S/scripts/dispatch_deploy_monitor.sh"
old='STORED_NEXT="$(jq -r '\''.monitorNextCheckAt // empty'\'' "$PATCH_RESPONSE" 2>/dev/null)"'
grep -qF "$old" "$F" || { printf '  \033[31mBROKEN\033[0m   M2 anchor not found; re-derive this mutant.\n' >&2; exit 2; }
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = 'STORED_NEXT="$(jq -r \'.monitorNextCheckAt // empty\' "$PATCH_RESPONSE" 2>/dev/null)"'
new = 'STORED_NEXT="$(jq -r \'.executionPolicy.monitor.nextCheckAt // empty\' "$PATCH_RESPONSE" 2>/dev/null)"'
assert old in s, "M2 anchor not found -- re-derive this mutant"
open(p, "w").write(s.replace(old, new, 1))
PY
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M2  re-arm verification reads the request echo instead of the authoritative column" \
  || survived "M2  authoritative-column check bypassed -> suite rc $rc, expected 1"

# --- M3: HTTP failure from Paperclip is no longer refused -------------------
# Targets "Paperclip failures are exit 2 and never a health claim": widen
# the PATCH success case from HTTP 2xx to accept anything, so a 500 is
# treated as a successful re-arm.
S="$WORK/m3"; mkscene "$S"
F="$S/scripts/dispatch_deploy_monitor.sh"
old='case "$PATCH_STATUS" in
  2*) ;;'
grep -qF '$PATCH_STATUS" in' "$F" || { printf '  \033[31mBROKEN\033[0m   M3 anchor not found; re-derive this mutant.\n' >&2; exit 2; }
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = 'case "$PATCH_STATUS" in\n  2*) ;;'
new = 'case "$PATCH_STATUS" in\n  *) ;;\n  2*) ;;'
assert old in s, "M3 anchor not found -- re-derive this mutant"
open(p, "w").write(s.replace(old, new, 1))
PY
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M3  an HTTP 500 from Paperclip is accepted as a successful re-arm" \
  || survived "M3  PATCH-status check widened -> suite rc $rc, expected 1"

# --- M4: the bearer token is written into the curl config unquoted/wrong ----
# Targets "the bearer token never reaches argv": route the token onto the
# curl command line via -H instead of the config file. request() no longer
# stays argv-clean.
S="$WORK/m4"; mkscene "$S"
F="$S/scripts/dispatch_deploy_monitor.sh"
old="  status=\"\$(curl --config \"\$cfg\")\" || { rm -f \"\$cfg\"; return 1; }"
grep -qF "$old" "$F" || { printf '  \033[31mBROKEN\033[0m   M4 anchor not found; re-derive this mutant.\n' >&2; exit 2; }
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = '  status="$(curl --config "$cfg")" || { rm -f "$cfg"; return 1; }'
new = '  status="$(curl --config "$cfg" -H "Authorization: Bearer $PAPERCLIP_API_KEY")" || { rm -f "$cfg"; return 1; }'
assert old in s, "M4 anchor not found -- re-derive this mutant"
open(p, "w").write(s.replace(old, new, 1))
PY
rc="$(run_scene "$S")"
[ "$rc" -eq 1 ] \
  && kill_ok "M4  bearer token leaks onto the curl argv via an extra -H flag" \
  || survived "M4  argv leak introduced -> suite rc $rc, expected 1"

echo
echo "-----------------------------------------------------------------"
if [ "$FAIL" -eq 0 ]; then
  echo "PASS  $PASS/$PASS mutants killed and control behaved"
  exit 0
fi
echo "FAIL  $FAIL survived, $PASS killed"
exit 1
