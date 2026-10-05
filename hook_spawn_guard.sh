#!/usr/bin/env bash
# ===========================================================================
# hook_spawn_guard.sh — do per-prompt/per-tool hooks leak processes?
#
# WHY THIS EXISTS. On 2026-10-03 ~1,025 node + ~1,023 python3
# processes from per-prompt hooks OOM-killed the paperclip container (40 GiB).
# The fleet settings at the time ran TWO hooks on every UserPromptSubmit:
# `bash pacer_tick.sh` (which `setsid nohup bash pacer_run.sh &` + `disown`,
# i.e. detached a python3 sampler per prompt) and `node gate-hook.mjs`.
# That is the 1:1 node:python3 pairing in the kernel OOM table. The feed the
# pacer rate-limited against had been stale since 09-04, so its MIN_INTERVAL
# gate never fired and EVERY prompt detached a child. A hook that detaches
# children survives its own death BY DESIGN (setsid escapes the process group
# the hook timeout kills), so at burst prompt rates the orphans accumulate
# faster than they exit.
#
# WHAT IT CHECKS. `check --settings <fleet-settings.json> [--hooks-dir <dir>]`
#   F1 detached-spawn: a hook command — or the script body it points at — that
#      backgrounds work. Detached children outlive the hook timeout kill and
#      are the OOM mechanism above.
#   F2 missing-timeout: a hook entry with no numeric `timeout`. Without one the
#      only bound is the harness default, which is not a reviewed choice.
#
# The checks are extension-aware, because each language detaches differently:
#   .sh        setsid / nohup / disown / a bare `&` that is neither `&&` nor
#              `&>`. Full-line `#` comments are stripped first, so a comment
#              that merely NAMES setsid does not trip the check.
#   .mjs/.js   `detached` (spawn detached:true) / child_process `fork(`. A
#              timer `.unref()` is explicitly NOT flagged: it shortens life.
#              A bare `&` is NOT checked here — in JS it is bitwise-AND or sits
#              inside regex classes like `[^\s;&|()]`, and flagging it fires on
#              the live model-guard (measured 2026-10-03).
#   .py        start_new_session / os.fork / os.setsid / daemon. A plain Popen
#              is NOT flagged: it stays in the hook's process group, so the
#              hook timeout kill still reaps it.
# Anything else (or an unresolvable body) is checked on the command string
# alone. Every approximation above is pinned by the suite, so a future
# "smarter" pattern cannot silently narrow it.
#
# Offline: reads one JSON file and optionally script bodies. No network, no
# credential, no /paperclip read. Exit 0 clean · 2 refused · 3 finding.
# ===========================================================================
set -uo pipefail

ME="$(basename "${BASH_SOURCE[0]}")"
EXIT_OK=0; EXIT_REFUSED=2; EXIT_FINDING=3

die() { printf '%s: %s\n' "$ME" "$*" >&2; exit $EXIT_REFUSED; }

usage() { die "usage: $ME check --settings <file> [--hooks-dir <dir>]"; }

SETTINGS=""; HOOKS_DIR=""
CMD="${1:-}"; shift 2>/dev/null || true
[ "$CMD" = "check" ] || usage
while [ $# -gt 0 ]; do
  case "$1" in
    --settings) SETTINGS="${2:-}"; shift 2 ;;
    --hooks-dir) HOOKS_DIR="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$SETTINGS" ] || usage
[ -f "$SETTINGS" ] || die "not a file: $SETTINGS"
[ -z "$HOOKS_DIR" ] || [ -d "$HOOKS_DIR" ] || die "not a directory: $HOOKS_DIR"

command -v python3 >/dev/null 2>&1 || die "python3 is required (stdlib json only)"

# --- enumerate hook entries: \x1f-separated (a unit separator, because bash
# treats TAB as collapsible IFS whitespace and would swallow an empty
# timeout field, shifting the command into its slot). Newlines and \x1f
# inside a command are flattened to spaces so one entry is one line. ---
ENTRIES="$(python3 - "$SETTINGS" <<'PY'
import json, sys
try:
    doc = json.load(open(sys.argv[1]))
except (OSError, ValueError) as e:
    print("unreadable settings: %s" % e, file=sys.stderr)
    sys.exit(2)
hooks = doc.get("hooks")
if not isinstance(hooks, dict):
    sys.exit(0)
for event, groups in hooks.items():
    if not isinstance(groups, list):
        continue
    for i, g in enumerate(groups):
        if not isinstance(g, dict):
            continue
        for h in (g.get("hooks") or []):
            if not isinstance(h, dict):
                continue
            cmd = h.get("command", "") if isinstance(h.get("command"), str) else ""
            cmd = cmd.replace("\x1f", " ").replace("\n", " ")
            print("%s\x1f%s\x1f%s\x1f%s" % (
                event, i,
                h.get("timeout") if isinstance(h.get("timeout"), int) else "",
                cmd))
PY
)" || exit $EXIT_REFUSED

FINDINGS=0
finding() { FINDINGS=$((FINDINGS+1)); printf 'FINDING %s %s\n' "$1" "$2"; }

# A bare & that backgrounds: neither `&&` (list operator), `&>` (redirect to
# file) nor `>&` (fd duplication, as in `2>&1`). ERE has no lookbehind, so the
# (possibly empty) neighbours are captured and the first char re-anchored.
has_background_op() {
  local t="$1"
  [[ "$t" =~ (^|[^&>])\&([^&>]|$) ]]
}

checked_bodies=""
scan_body() {
  local path="$1" where="$2" ext body code
  ext="${path##*.}"
  body="$(cat "$path" 2>/dev/null)" || return 0
  # Full-line comments name tools without using them; strip them first.
  code="$(grep -vE '^[[:space:]]*#' <<<"$body")"
  case "$ext" in
    sh)
      if grep -qwE 'setsid|nohup|disown' <<<"$code" || has_background_op "$code"; then
        finding "detached-spawn" "$where body $path detaches (setsid/nohup/bare-&/disown)"
      fi
      ;;
    mjs|js|cjs)
      if grep -qE 'detached|fork[[:space:]]*\(' <<<"$code"; then
        finding "detached-spawn" "$where body $path detaches (detached/fork)"
      fi
      ;;
    py)
      if grep -qE 'start_new_session|os\.fork|os\.setsid|daemon' <<<"$code"; then
        finding "detached-spawn" "$where body $path detaches (fork/setsid/daemon)"
      fi
      ;;
  esac
}

check_body() {
  local cmd="$1" path=""
  # Prefer an absolute script path named in the command; fall back to a
  # basename lookup under --hooks-dir so fixtures stay hermetic.
  if [[ "$cmd" =~ (/[^[:space:]]+\.(sh|mjs|js|cjs|py)) ]]; then
    path="${BASH_REMATCH[1]}"
    [ -f "$path" ] || path=""
  fi
  if [ -z "$path" ] && [ -n "$HOOKS_DIR" ]; then
    local base
    base="$(basename "$(awk '{print $1}' <<<"$cmd")" 2>/dev/null)"
    [ -n "$base" ] && [ -f "$HOOKS_DIR/$base" ] && path="$HOOKS_DIR/$base"
  fi
  [ -n "$path" ] || return 0
  case "$checked_bodies" in *"|$path|"*) return 0;; esac
  checked_bodies="$checked_bodies|$path|"
  scan_body "$path" "$2"
}

while IFS=$'\x1f' read -r event idx timeout cmd; do
  [ -n "$cmd" ] || continue
  where="$event[$idx] ${cmd:0:80}"
  if [[ "$cmd" =~ setsid || "$cmd" =~ nohup || "$cmd" =~ disown ]] || has_background_op "$cmd"; then
    finding "detached-spawn" "$where command detaches (setsid/nohup/bare-&/disown)"
  fi
  if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
    finding "missing-timeout" "$where has no numeric hook timeout"
  fi
  check_body "$cmd" "$where"
done <<<"$ENTRIES"

if [ "$FINDINGS" -gt 0 ]; then
  printf '%s: %d finding(s)\n' "$ME" "$FINDINGS" >&2
  exit $EXIT_FINDING
fi
echo "$ME: clean"
