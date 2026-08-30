#!/usr/bin/env bash
# ===========================================================================
# tog-676-monitor-mutation-gate.sh — proof that
# test_discord_job_health_monitor.sh is not vacuous.
# ---------------------------------------------------------------------------
# A green suite is not evidence until it can be shown to go red. This gate
# removes one limb of discord_job_health_monitor.sh at a time and asserts the
# suite catches each removal. The mutants are the ways this wrapper could
# silently become a false green:
#
#   * report a broken digest without its delivery evidence
#   * turn an unmeasurable detector into a healthy claim
#   * accept a garbage payload because the exit status was 0
#   * retry a failure on the long interval, delaying rediscovery
#   * drop the note that a failing digest is the EXPECTED state, so a future
#     reader silences a working detector
#   * replace the issue's execution policy instead of merging into it
#   * leak the Paperclip bearer into argv
#   * swallow the detector's exit status
#
# A mutation that does not change the file is a FAILED gate, not a passing
# one: a sed that silently matched nothing would otherwise score as a kill.
# That check is why this file exists rather than a one-off shell loop.
#
# Exit 0 only if the baseline is green AND every mutant is killed.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/discord_job_health_monitor.sh"
SUITE="$ROOT/test_discord_job_health_monitor.sh"
PASS=0; FAIL=0

ok()  { printf '  \033[32m  PASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31m  FAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -f "$SRC" ]   || { echo "FATAL: cannot find discord_job_health_monitor.sh above $HERE" >&2; exit 4; }
[ -f "$SUITE" ] || { echo "FATAL: cannot find test_discord_job_health_monitor.sh above $HERE" >&2; exit 4; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tog676_monitor_mutation.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

stage() {
  local dest="$1"
  mkdir -p "$dest"
  cp "$SRC" "$dest/discord_job_health_monitor.sh"
  cp "$SUITE" "$dest/test_discord_job_health_monitor.sh"
  chmod +x "$dest/discord_job_health_monitor.sh" "$dest/test_discord_job_health_monitor.sh"
}

hdr "=== baseline: the UNMUTATED copy passes in this same staging directory ==="
BASE="$WORK/baseline"
stage "$BASE"
if bash -c "cd '$BASE' && ./test_discord_job_health_monitor.sh" > "$WORK/baseline.log" 2>&1; then
  ok "unmutated copy: suite green in $BASE"
  ok "baseline ran $(grep -oE 'passed [0-9]+' "$WORK/baseline.log" | tail -1)"
else
  bad "unmutated copy FAILED — the gate cannot attribute anything to a mutation"
  sed -e 's/\x1b\[[0-9;]*m//g' "$WORK/baseline.log" | tail -20
  printf '\npassed %d, failed %d\n' "$PASS" "$FAIL"
  exit 1
fi

# mutate <description> <python-old> <python-new>
# Applies an exact string replacement, verifies the file actually changed, then
# requires the suite to fail.
n=0
mutate() {
  local desc="$1" old="$2" new="$3"
  n=$((n+1))
  local dir="$WORK/mut$n"
  stage "$dir"
  # Mutate only NON-COMMENT lines. An anchor that also appears in the header
  # prose would otherwise be "mutated" in a comment, changing no behaviour --
  # the suite rightly stays green and the gate scores a false survivor.
  local rc
  OLD="$old" NEW="$new" python3 - "$dir/discord_job_health_monitor.sh" <<'PY'
import os, sys
p = sys.argv[1]
old, new = os.environ["OLD"], os.environ["NEW"]
lines = open(p).readlines()
hits = [i for i, l in enumerate(lines)
        if old in l and not l.lstrip().startswith("#")]
if not hits:
    sys.exit(3 if not any(old in l for l in lines) else 4)
i = hits[0]
lines[i] = lines[i].replace(old, new, 1)
open(p, "w").writelines(lines)
PY
  rc=$?
  case "$rc" in
    0) ;;
    3) bad "$desc — mutation anchor not found; the gate would have scored a phantom kill"; return ;;
    4) bad "$desc — anchor exists only in comments; mutating it proves nothing"; return ;;
    *) bad "$desc — mutation step failed (rc=$rc)"; return ;;
  esac
  if cmp -s "$SRC" "$dir/discord_job_health_monitor.sh"; then
    bad "$desc — mutation did not change the file"
    return
  fi
  if bash -c "cd '$dir' && ./test_discord_job_health_monitor.sh" >/dev/null 2>&1; then
    bad "$desc — SURVIVED: the suite passed against a broken wrapper"
  else
    ok "$desc"
  fi
}

hdr "=== each limb of the monitor, removed one at a time ==="

mutate "delivery evidence dropped from the report" \
  '\(.delivered) / \(.sendOpportunities) opportunities' \
  'n/a'

mutate "an unmeasurable detector reported as healthy" \
  '**UNKNOWN: the detector did not produce a valid measurement.**' \
  '**All Discord scheduled jobs healthy, and every time-gated job proved a delivery.**'

mutate "payload validation removed — garbage scored as a measurement" \
  'and (.jobs | length > 0)' \
  ''

mutate "a failed measurement retries on the long interval" \
  'NEXT_HOURS="$ERROR_RETRY_HOURS"' \
  'NEXT_HOURS="$INTERVAL_HOURS"'

mutate "the expected-steady-state note removed, inviting a silencing" \
  'until a vendor release lands' \
  'soon'

mutate "execution policy replaced instead of merged" \
  '($policy + {' \
  '({'

mutate "the Paperclip bearer moved into argv" \
  'status="$(curl --config "$cfg")" || { rm -f "$cfg"; return 1; }' \
  'status="$(curl -H "Authorization: Bearer $PAPERCLIP_API_KEY" --config "$cfg")" || { rm -f "$cfg"; return 1; }'

mutate "the detector exit status swallowed" \
  'exit "$DETECTOR_RC"' \
  'exit 0'

printf '\npassed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
