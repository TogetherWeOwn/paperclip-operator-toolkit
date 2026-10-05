#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for hook_spawn_guard.sh.
#
# WHY THIS RUNS ANYWHERE. The guard reads one JSON file and optional script
# bodies. The suite fabricates both in mktemp: a fleet-settings-shaped JSON
# and hook bodies exhibiting each detach pattern. No /paperclip read, no
# network, no credential, and nothing it writes leaves the temp directory.
#
# THE ASSERTIONS THAT CARRY THIS SUITE:
#   1. The OOM shape is caught. A UserPromptSubmit hook whose body runs
#      `setsid nohup ... &` + `disown` (the exact pacer_tick.sh mechanism that
#      OOM-killed the container on 2026-10-03) exits 3 with a detached-spawn
#      finding. If this assertion goes, the guard has become the thing that
#      watched the outage happen.
#   2. Same-label PASS/FAIL printing (see test_channel_drift.sh header). CI's
#      mutation gate needs the NAMED assertion to flip, not merely red.
#   3. `&&`, `&>` and `>&` are not backgrounding. A body that only chains
#      commands, redirects stdout, or duplicates fds (`2>&1`) must NOT trip
#      detached-spawn — otherwise the guard fires on ordinary scripts and
#      gets muted.
#   4. A comment that NAMES setsid does not trip it. The pacer header
#      documents its own detach in prose; flagging prose is the same mute
#      path as (3).
#   5. JS regex `&` does not trip it. The live model-guard carries
#      `[^\s;&|()]` classes; flagging that fires the guard on the current
#      fleet settings, which the suite pins as clean.
#   6. A hook entry with no numeric timeout is a missing-timeout finding.
#
# Exit status only. No assertion matches human-readable prose, which drifts.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="${HOOK_SPAWN_GUARD_SH:-$HERE/hook_spawn_guard.sh}"
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  if [ $# -gt 1 ]; then printf '        %s\n' "$2"; fi
  FAIL=$((FAIL+1))
}
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -x "$GUARD" ] || { echo "no executable hook_spawn_guard.sh at $GUARD" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- fabricated hook bodies -------------------------------------------------
# The OOM mechanism, verbatim in shape: detach onto a new session, background,
# disown. (Real pacer_tick.sh lines 93-95, names changed.)
cat > "$WORK/detaching_tick.sh" <<'SH'
#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tick() {
  setsid nohup bash "$HERE/sampler_run.sh" \
    >/dev/null 2>>"$HERE/tick.log" &
  disown 2>/dev/null
}
tick
exit 0
SH

# Ordinary chaining and redirection only: must stay clean.
cat > "$WORK/plain_chain.sh" <<'SH'
#!/usr/bin/env bash
set -uo pipefail
command -v flock >/dev/null 2>&1 && check || fallback
result="$(probe 2>&1)" && report "$result" &> "$LOG"
exit 0
SH

# Prose that names the tool without using it: must stay clean.
cat > "$WORK/prose_only.sh" <<'SH'
#!/usr/bin/env bash
# This hook deliberately does NOT setsid/nohup/disown anything: detaching
# children from a per-prompt hook leaks processes.
exit 0
SH

# A node hook with & inside regex classes (the live model-guard shape) and a
# .unref() timer: must stay clean.
cat > "$WORK/regex_hook.mjs" <<'JS'
#!/usr/bin/env node
const flagPattern = /(?:--model)(?:=|\s+)("[^"]*"|[^\s;&|()]+)/gi;
setTimeout(() => process.exit(0), 8000).unref();
JS

# A node hook that really detaches: must be caught.
cat > "$WORK/detaching_hook.mjs" <<'JS'
#!/usr/bin/env node
import { spawn } from "node:child_process";
spawn("node", ["worker.mjs"], { detached: true, stdio: "ignore" }).unref();
JS

mk_settings() {
  local cmd="$1" timeout_json="$2" out="$3"
  printf '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":%s,"timeout":%s}]}]}}' \
    "$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$timeout_json" > "$out"
}

run() { OUT="$("$GUARD" check --settings "$1" 2>&1)"; RC=$?; }
# want_rc <expected> <label> — asserts on $RC, printing <label> either way.
want_rc() {
  if [ "$RC" -eq "$1" ]; then ok "$2"; else bad "$2" "exit $RC, want $1 :: $OUT"; fi
}
# want_out <grep-pattern> <label> — asserts on $OUT, printing <label> either way.
want_out() {
  if grep -q "$1" <<<"$OUT"; then ok "$2"; else bad "$2" "output did not match: $1 :: $OUT"; fi
}

# ---------------------------------------------------------------------------
hdr "the OOM shape is caught"
mk_settings "bash $WORK/detaching_tick.sh" 5 "$WORK/s-detach.json"
run "$WORK/s-detach.json"; want_rc 3 "detaching sh body exits 3"
want_out "detached-spawn" "detaching sh body names detached-spawn"

mk_settings "node $WORK/detaching_hook.mjs" 10 "$WORK/s-jsdetach.json"
run "$WORK/s-jsdetach.json"; want_rc 3 "detached mjs body exits 3"
want_out "detached-spawn" "detached mjs body names detached-spawn"

# The command string itself detaches even when the body is absent.
mk_settings "setsid nohup bash $WORK/plain_chain.sh >/dev/null 2>&1 &" 5 "$WORK/s-cmd.json"
run "$WORK/s-cmd.json"; want_rc 3 "detaching command string exits 3"

# ---------------------------------------------------------------------------
hdr "ordinary scripts stay clean"
mk_settings "bash $WORK/plain_chain.sh" 5 "$WORK/s-chain.json"
run "$WORK/s-chain.json"; want_rc 0 "chained commands and redirects exit 0"

mk_settings "bash $WORK/prose_only.sh" 5 "$WORK/s-prose.json"
run "$WORK/s-prose.json"; want_rc 0 "prose naming setsid exits 0"

mk_settings "node $WORK/regex_hook.mjs" 5 "$WORK/s-regex.json"
run "$WORK/s-regex.json"; want_rc 0 "JS regex ampersand and unref exit 0"

# ---------------------------------------------------------------------------
hdr "missing timeout is a finding"
mk_settings "bash $WORK/plain_chain.sh" null "$WORK/s-notime.json"
run "$WORK/s-notime.json"; want_rc 3 "timeout-less hook exits 3"
want_out "missing-timeout" "timeout-less hook names missing-timeout"

# ---------------------------------------------------------------------------
hdr "refusals"
run /nonexistent-settings.json; want_rc 2 "missing settings file exits 2"
printf 'not json' > "$WORK/s-bad.json"
run "$WORK/s-bad.json"; want_rc 2 "unparseable settings exits 2"

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
