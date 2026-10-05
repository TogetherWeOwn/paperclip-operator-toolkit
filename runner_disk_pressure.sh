#!/usr/bin/env bash
# ===========================================================================
# runner_disk_pressure.sh — detect disk pressure on a self-hosted runner host.
# ---------------------------------------------------------------------------
# THE FAILURE THIS EXISTS FOR. A past incident filled a multi-runner host
# disk: runners died with `No space left on device` writing their own
# diagnostic logs, lost communication with GitHub, and queued checks sat
# unscheduled for hours — required checks frozen repo-wide, with hosted
# deployments threatened alongside. The evidence (the runners' own exception
# text naming the full path) sat in GitHub annotations the whole time with
# nothing reading it before jobs were scheduled onto a host that could
# not write.
#
# What this measures: `df -P` usage percent of one filesystem path (default
# `/`), against a warning and a critical threshold, plus a read-only `du`
# breakdown of the runner root so the annotation names the consumer instead
# of just the percentage. It is read-only: it stats, never deletes, never
# restarts anything. Reclaiming is the runbook's job
# (docs/runbooks/runner-disk-pressure.md), not this script's.
#
# What CI green on this suite does NOT mean: the offline suite below drives
# this detector against fixture directories and a stubbed `df`, so green
# proves the detector's logic, never that any host has headroom. The host is
# measured where the host is: the CI preflight step and the scheduled live
# workflow run this script against the real `/` on a self-hosted runner.
#
#   ./runner_disk_pressure.sh                          # human-readable, / at 80/90
#   ./runner_disk_pressure.sh --json                   # machine-readable
#   ./runner_disk_pressure.sh --path / --runner-root /opt/actions-runners \
#       --warn-pct 80 --crit-pct 90
#
# Exit status:
#   0  healthy (usage below warn; the measurement succeeded)
#   1  PRESSURE (usage at or above warn; at or above crit reads CRITICAL)
#   2  inconclusive or tool failure -- path unmeasurable, df unparseable,
#      or bad thresholds. NEVER reports healthy from a measurement it could
#      not make: a detector that goes green when it measured nothing is the
#      exact failure mode this card exists to prevent.
#
# The du breakdown NEVER changes the exit code. It is corroborating, not
# conclusive: a failed or missing breakdown is reported as a note while the
# df verdict stands on its own.
# ===========================================================================
set -uo pipefail

PATH_CHECK="/"
RUNNER_ROOTS=()
WARN_PCT=80
CRIT_PCT=90
JSON=0

usage() {
  cat <<'USAGE'
usage: runner_disk_pressure.sh [--json] [--path DIR] [--runner-root DIR]
                              [--warn-pct N] [--crit-pct N] [-h|--help]

  --path DIR        filesystem path whose usage is measured (default: /)
  --runner-root DIR runner install root listed for the top-consumer
                    breakdown; repeatable (default: none; e.g.
                    /opt/actions-runners and /home/gha-runner)
  --warn-pct N      WARNING at or above N percent (default: 80)
  --crit-pct N      CRITICAL at or above N percent (default: 90)
  --json            machine-readable output on stdout
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1 ;;
    --path) shift; [[ $# -gt 0 ]] || { echo "ERROR: --path needs a value" >&2; exit 2; }; PATH_CHECK="$1" ;;
    --runner-root) shift; [[ $# -gt 0 ]] || { echo "ERROR: --runner-root needs a value" >&2; exit 2; }; RUNNER_ROOTS+=("$1") ;;
    --warn-pct) shift; [[ $# -gt 0 ]] || { echo "ERROR: --warn-pct needs a value" >&2; exit 2; }; WARN_PCT="$1" ;;
    --crit-pct) shift; [[ $# -gt 0 ]] || { echo "ERROR: --crit-pct needs a value" >&2; exit 2; }; CRIT_PCT="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

for n in "$WARN_PCT" "$CRIT_PCT"; do
  [[ "$n" =~ ^[1-9][0-9]?$ ]] || { echo "ERROR: thresholds must be integers 1-99" >&2; exit 2; }
done
[[ "$WARN_PCT" -lt "$CRIT_PCT" ]] || { echo "ERROR: --warn-pct ($WARN_PCT) must be below --crit-pct ($CRIT_PCT)" >&2; exit 2; }

# json_escape: backslash and double-quote only. Paths here are operator flags
# (/ , /opt/actions-runners), not adversary input; control characters in a
# mount path would already have broken df long before this line.
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

NOTES=()
note() { NOTES+=("$1"); }

# DF_BIN / DU_BIN are test hooks (default df/du): the offline suite points
# them at stubs because a PATH shim does not survive this environment — every
# non-interactive bash re-sources BASH_ENV, which hard-resets PATH and voids
# the shim before the detector runs. Absolute-path overrides are immune.
DF_BIN="${DF_BIN:-df}"
DU_BIN="${DU_BIN:-du}"

# --- the measurement -------------------------------------------------------
DF_OUT="$("$DF_BIN" -P -- "$PATH_CHECK" 2>&1)" || {
  echo "ERROR: df failed for '$PATH_CHECK': $DF_OUT" >&2
  exit 2
}
# df -P prints exactly two lines for one path: header + one data row. Anything
# else (zero rows, wrapped rows) is unparseable, not healthy.
DF_ROWS="$(printf '%s\n' "$DF_OUT" | tail -n +2 | grep -c .)"
[[ "$DF_ROWS" -eq 1 ]] || { echo "ERROR: unparseable df output for '$PATH_CHECK' ($DF_ROWS data rows)" >&2; exit 2; }
USE_RAW="$(printf '%s\n' "$DF_OUT" | awk 'NR==2 {print $5}')"
[[ "$USE_RAW" =~ ^([0-9]+)%$ ]] || { echo "ERROR: unparseable df Use% field '$USE_RAW' for '$PATH_CHECK'" >&2; exit 2; }
USE_PCT="${BASH_REMATCH[1]}"
AVAIL="$(printf '%s\n' "$DF_OUT" | awk 'NR==2 {print $4}')"
MOUNT="$(printf '%s\n' "$DF_OUT" | awk 'NR==2 {print $6}')"

STATUS="ok"
[[ "$USE_PCT" -ge "$WARN_PCT" ]] && STATUS="pressure"
[[ "$USE_PCT" -ge "$CRIT_PCT" ]] && STATUS="critical"

# --- the breakdown (corroborating only) ------------------------------------
# Repeatable: pass both the bundle layout (/opt/actions-runners) and the
# legacy hand-installed layout (/home/gha-runner); absent roots are a note.
BREAKDOWN_LINES=()
for ((r = 0; r < ${#RUNNER_ROOTS[@]}; r++)); do
  RROOT="${RUNNER_ROOTS[$r]}"
  if [[ -d "$RROOT" ]]; then
    DU_OUT="$("$DU_BIN" -x -s -- "$RROOT"/* 2>/dev/null)" && {
      while IFS= read -r line; do
        [[ -n "$line" ]] && BREAKDOWN_LINES+=("$line")
      done < <(printf '%s\n' "$DU_OUT" | sort -rn | head -n 10)
    } || note "du breakdown of '$RROOT' failed; headline verdict stands on df alone"
  else
    note "runner root '$RROOT' not present; headline verdict stands on df alone"
  fi
done

# --- report ----------------------------------------------------------------
if [[ "$JSON" -eq 1 ]]; then
  {
    printf '{"status":"%s","path":"%s","mount":"%s","use_pct":%s,"avail_kb":"%s","warn_pct":%s,"crit_pct":%s,"top_consumers":[' \
      "$STATUS" "$(json_escape "$PATH_CHECK")" "$(json_escape "$MOUNT")" "$USE_PCT" "$(json_escape "$AVAIL")" "$WARN_PCT" "$CRIT_PCT"
    first=1
    # Index loop, not `for x in ${arr[@]}`: unquoted expansion word-splits
    # entries, so a path or note containing a space would shatter into
    # fragments. Indexing keeps each element whole.
    for ((i = 0; i < ${#BREAKDOWN_LINES[@]}; i++)); do
      line="${BREAKDOWN_LINES[$i]}"
      size="${line%%[[:space:]]*}"; entry="${line#*[[:space:]]}"
      [[ "$first" -eq 1 ]] && first=0 || printf ','
      printf '{"kb":%s,"path":"%s"}' "$(json_escape "$size")" "$(json_escape "$entry")"
    done
    printf '],"notes":['
    first=1
    for ((i = 0; i < ${#NOTES[@]}; i++)); do
      [[ "$first" -eq 1 ]] && first=0 || printf ','
      printf '"%s"' "$(json_escape "${NOTES[$i]}")"
    done
    printf ']}\n'
  }
else
  case "$STATUS" in
    critical) echo "CRITICAL: disk usage ${USE_PCT}% on '${PATH_CHECK}' (mount ${MOUNT}, avail ${AVAIL}K) at/above ${CRIT_PCT}%" ;;
    pressure) echo "WARNING: disk usage ${USE_PCT}% on '${PATH_CHECK}' (mount ${MOUNT}, avail ${AVAIL}K) at/above ${WARN_PCT}%" ;;
    *)        echo "OK: disk usage ${USE_PCT}% on '${PATH_CHECK}' (mount ${MOUNT}, avail ${AVAIL}K) below ${WARN_PCT}%" ;;
  esac
  if [[ "${#BREAKDOWN_LINES[@]}" -gt 0 ]]; then
    echo "top consumers under runner roots (KB):"
    printf '  %s\n' "${BREAKDOWN_LINES[@]}"
  fi
  for ((i = 0; i < ${#NOTES[@]}; i++)); do echo "note: ${NOTES[$i]}"; done
  if [[ "$STATUS" != "ok" ]]; then
    echo "reclaim per docs/runbooks/runner-disk-pressure.md; this script deletes nothing"
  fi
fi

case "$STATUS" in
  ok) exit 0 ;;
  *)  exit 1 ;;
esac
