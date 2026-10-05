#!/usr/bin/env bash
# runner_capacity_headroom.sh — source-only runner capacity check.
#
# Answers the capacity half of a runner-fleet move from read-only GitHub
# Actions job data. It changes nothing: no host command, no runner mutation,
# no credential, no network call. The caller supplies the jobs JSON (captured
# separately via an authorized read path); this script only measures it.
#
# THE ONE COUNTING RULE: only runner-assigned execution minutes are compute.
# A job with no `runner_name` — queued behind no runner, or a cancelled run
# that never landed — contributes timestamp span but zero compute. This tool
# counts (completed_at - started_at) only when `runner_name` is nonempty and
# both clocks parse, and reports everything it excluded, by cause.
#
# COHORTS are caller-owned: --cohort NAME=GLOB assigns each runner-assigned
# job to the first matching cohort (shell glob against runner_name);
# unmatched jobs land in `other`. The verdict compares the TARGET cohort's
# peak concurrency against --slots. Cohort names, globs and slot counts are
# deployment facts this script never invents — pass them explicitly. Never
# raise slots from a queue count alone.
#
# VERDICT RULES: a measured sample needs >=24h span AND >=10 matched completed
# attempts per arm (trial adequacy: >=24h and >=10 matched completed attempts
# per arm); anything thinner is INCONCLUSIVE, never GO. GO means the observed
# target peak fits inside the slots. NO-GO means it does not. Either is a
# measured answer (exit 0). Exit 2 is refusal: unreadable input, zero
# runner-assigned jobs, no parseable clocks, no cohorts, or no target — an
# unmeasured pool is never reported healthy.
#
# Usage:
#   ./runner_capacity_headroom.sh --jobs <jobs.json> --slots <N>
#     --cohort <NAME=GLOB> [--cohort ...] [--target <NAME>]
#     [--min-hours 24] [--min-attempts 10]
#   jobs.json is a JSON array of job objects, or an object with a `.jobs`
#   array (the `gh api .../jobs` shape). Each job needs `runner_name`,
#   `started_at`, `completed_at` (ISO-8601 UTC `Z`); `name`, `conclusion`
#   and `labels` are carried for cohort notes only. --target defaults to the
#   first --cohort.
set -uo pipefail

JOBS=""; SLOTS=""; TARGET=""; MIN_HOURS=24; MIN_ATTEMPTS=10
COHORT_NAMES=(); COHORT_GLOBS=()
while (($# > 0)); do
  case "$1" in
    --jobs) JOBS="${2:-}"; shift 2 ;;
    --slots) SLOTS="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    --cohort)
      spec="${2:-}"; shift 2
      [[ "$spec" == *=* ]] || { echo "runner_capacity_headroom: refusing — --cohort wants NAME=GLOB (got '$spec')" >&2; exit 2; }
      COHORT_NAMES+=("${spec%%=*}"); COHORT_GLOBS+=("${spec#*=}") ;;
    --min-hours) MIN_HOURS="${2:-}"; shift 2 ;;
    --min-attempts) MIN_ATTEMPTS="${2:-}"; shift 2 ;;
    *) echo "runner_capacity_headroom: refusing — unknown argument '$1'" >&2; exit 2 ;;
  esac
done

refuse() { echo "runner_capacity_headroom: refusing — $1" >&2; exit 2; }

[[ -n "$JOBS" ]] || refuse "no --jobs file given"
[[ -f "$JOBS" ]] || refuse "jobs file '$JOBS' not readable"
[[ "${#COHORT_NAMES[@]}" -gt 0 ]] || refuse "no --cohort NAME=GLOB given"
[[ -n "$SLOTS" ]] || refuse "no --slots given"
[[ "$SLOTS" =~ ^[0-9]+$ ]] || refuse "slots must be a whole number (got '$SLOTS')"
[[ -n "$TARGET" ]] || TARGET="${COHORT_NAMES[0]}"
target_known=0
for n in "${COHORT_NAMES[@]}"; do [[ "$n" == "$TARGET" ]] && target_known=1; done
(( target_known == 1 )) || refuse "target '$TARGET' matches no --cohort name"
[[ "$MIN_HOURS" =~ ^[0-9]+$ && "$MIN_ATTEMPTS" =~ ^[0-9]+$ ]] \
  || refuse "adequacy bounds must be whole numbers"
command -v jq >/dev/null 2>&1 || refuse "jq required"
command -v python3 >/dev/null 2>&1 || refuse "python3 required"

TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
to_epoch() {
  [[ "$1" =~ $TS_RE ]] || return 1
  date -u -d "$1" +%s 2>/dev/null
}

# Normalize to flat unit-separator rows: name \037 runner \037 started \037
# completed. The separator is ASCII US (non-IFS-whitespace) deliberately: with
# a tab separator, `read` collapses the empty runner_name field and a
# queued-no-runner job shifts its timestamp into the runner slot, silently
# promoting a queue artifact into compute. The runner_name emptiness test is
# the queue-artifact boundary and lives here, not in a caller filter, so no
# caller can silently widen it.
SEP=$'\037'
ROWS="$(jq -r --arg sep "$SEP" '
  (if type == "object" and has("jobs") then .jobs else . end)
  | if type != "array" then error("not-array") else . end
  | .[] | [.name // "?", (.runner_name // ""), (.started_at // ""), (.completed_at // "")] | join($sep)' \
  "$JOBS" 2>/dev/null)" || refuse "jobs file is not a JSON array (or {jobs:[...]})"

[[ -n "$ROWS" ]] || refuse "jobs file holds zero jobs — nothing measured"

declare -A cohort_min=()
excl_no_runner=0; excl_clock=0; matched=0
min_s=""; max_e=""
intervals=""; target_intervals=""

classify() {  # <runner> -> cohort name or "other" (first glob wins)
  local runner="$1" i
  for i in "${!COHORT_NAMES[@]}"; do
    # shellcheck disable=SC2053
    [[ "$runner" == ${COHORT_GLOBS[$i]} ]] && { printf '%s' "${COHORT_NAMES[$i]}"; return 0; }
  done
  printf 'other'
}

while IFS="$SEP" read -r name runner started completed; do
  if [[ -z "$runner" ]]; then
    excl_no_runner=$((excl_no_runner + 1)); continue  # queue/cancel artifact, not compute
  fi
  s_epoch="$(to_epoch "$started" 2>/dev/null)" || s_epoch=""
  e_epoch="$(to_epoch "$completed" 2>/dev/null)" || e_epoch=""
  if [[ -z "$s_epoch" || -z "$e_epoch" ]] || (( e_epoch <= s_epoch )); then
    excl_clock=$((excl_clock + 1)); continue  # unparseable or skewed clocks are excluded, never zero-filled
  fi
  mins="$(python3 -c "print(f'{( $e_epoch - $s_epoch ) / 60:.2f}')" 2>/dev/null)" \
    || refuse "arithmetic failed for job '$name'"
  matched=$((matched + 1))
  total_min="$(python3 -c "print(f'{float(${total_min:-0}) + float($mins):.2f}')" )"
  cohort="$(classify "$runner")"
  cohort_min[$cohort]="$(python3 -c "print(f'{float(${cohort_min[$cohort]:-0}) + float($mins):.2f}')" )"
  if [[ "$cohort" == "$TARGET" ]]; then target_intervals+="$s_epoch $e_epoch"$'\n'; fi
  intervals+="$s_epoch $e_epoch"$'\n'
  { [[ -z "$min_s" ]] || (( s_epoch < min_s )); } && min_s="$s_epoch"
  { [[ -z "$max_e" ]] || (( e_epoch > max_e )); } && max_e="$e_epoch"
done <<<"$ROWS"

(( matched > 0 )) || refuse "zero runner-assigned jobs — sample is all queue/cancel artifacts"

peak_of() {
  # Sweep-line peak concurrency over "start end" lines. Empty input peaks 0.
  python3 -c "
import sys
events = []
for line in sys.stdin.read().splitlines():
    line = line.strip()
    if not line: continue
    s, e = line.split()
    events.append((int(s), 1)); events.append((int(e), -1))
events.sort(key=lambda t: (t[0], t[1]))
peak = cur = 0
for _, d in events:
    cur += d
    peak = max(peak, cur)
print(peak)"
}
peak_all="$(peak_of <<<"$intervals")"
peak_target="$(peak_of <<<"$target_intervals")"
span_h="$(python3 -c "print(f'{($max_e - $min_s) / 3600:.2f}')" )"

verdict=""; reason=""
if ! python3 -c "exit(0 if float($span_h) >= float($MIN_HOURS) else 1)"; then
  verdict="INCONCLUSIVE"; reason="span ${span_h}h below ${MIN_HOURS}h adequacy bound"
elif (( matched < 10#$MIN_ATTEMPTS )); then
  verdict="INCONCLUSIVE"; reason="matched ${matched} below ${MIN_ATTEMPTS} adequacy bound"
elif (( 10#$peak_target <= 10#$SLOTS )); then
  verdict="GO"; reason="target peak ${peak_target} fits ${SLOTS} slots (${TARGET})"
else
  verdict="NO-GO"; reason="target peak ${peak_target} exceeds ${SLOTS} slots (${TARGET})"
fi

fmt2() { python3 -c "print(f'{float($1):.2f}')"; }
cohort_report=""
for n in "${COHORT_NAMES[@]}"; do
  cohort_report+="$n=$(fmt2 "${cohort_min[$n]:-0}") "
done
cohort_report+="other=$(fmt2 "${cohort_min[other]:-0}")"
printf 'runner_capacity_headroom: runner_minutes_total=%s %sexcluded_no_runner=%d excluded_clock=%d span_h=%s matched=%d peak_all=%s target_peak=%s target=%s slots=%d verdict=%s reason=%s\n' \
  "$(fmt2 "$total_min")" "$cohort_report " \
  "$excl_no_runner" "$excl_clock" "$span_h" "$matched" \
  "$peak_all" "$peak_target" "$TARGET" "$SLOTS" "$verdict" "$reason"
