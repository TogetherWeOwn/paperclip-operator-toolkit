#!/usr/bin/env bash
# ===========================================================================
# audit_stale_instances.sh — read-only GARM orphan/stale instance audit
# ---------------------------------------------------------------------------
# Ephemeral GARM registration/cleanup with size caps. Lists GARM instances past TTL or
# stuck in provisioning/draining states, and PROPOSES reaping. It never
# deletes anything: the only GARM invocations in this file are
# `pool show --format json` reads. There is no --apply, no --delete, no
# --force, and no host command (lxc/ssh/systemctl) anywhere below.
# Deletion happens only through an explicit operator flow, executed by a
# human operator after approval — never by this script.
#
# READS ONLY:
#   garm-cli pool show <pool-id> --format json   (live mode)
#   --pool-json <file>                           (fixture/offline mode)
#
# Buckets (InstanceStatus vocabulary per cloudbase/garm-provider-common,
# same exclusions as the pool-push helper):
#   warm-spare    running+idle within the pool's min_idle_runners
#                 reservation — exempt from TTL, never a candidate
#   idle-excess   running+idle BEYOND min_idle (the `excess` oldest idle
#                 instances) — candidate past TTL, breach past orphan age
#   busy          running, runner_status neither idle nor failed — candidate
#                 past TTL, breach past orphan age
#   provisioning  pending_create/creating, or runner_status installing —
#                 info while young, breach past GARM_PROV_STUCK_MIN in state
#   draining      pending_delete/pending_force_delete/deleting — info while
#                 young, breach past GARM_DRAIN_STUCK_MIN in state (a stuck
#                 drain is the cleanup failure this audit exists to surface)
#   prov-fail     status error, or runner_status failed — info while young,
#                 breach past GARM_DRAIN_STUCK_MIN in state
# Stuck-state timers run on updated_at (time in state), falling back to
# created_at when updated_at is absent or older than creation: a runner
# whose job ran long must not breach the moment teardown begins.
#   stale         anything else (stopped/unknown) — candidate past TTL,
#                 breach past orphan age
#   unknown-age   created_at unreadable or absent — BREACH, always. A silent
#                 pass on absent evidence is a defect, not a clean bill.
#
# Verdicts: OK (nothing actionable) | PROPOSE (candidates only, exit 0) |
# BREACH (orphan, stuck, unknown-age, over-max, or unreadable pool, exit 1).
# PROPOSE is still healthy signal: a proposal is not a breach, so nothing
# pages on it. Refusals (bad env/args, missing CLI in live mode)
# exit 2 with no verdict — the heartbeat miss pages, never a silent green.
#
# USAGE
#   GARM_POOLS="<pool-uuid> ..." ./audit_stale_instances.sh [--json]
#   ./audit_stale_instances.sh --pool-json pool-a.json [--pool-json pool-b.json]
#                              [--now 2026-10-03T14:00:00Z] [--json]
#
# ENV (all optional except GARM_POOLS in live mode):
#   GARM_BIN (default garm-cli), GARM_INSTANCE_TTL_MIN (default 240),
#   GARM_ORPHAN_MULT (default 2), GARM_PROV_STUCK_MIN (default 30),
#   GARM_DRAIN_STUCK_MIN (default 60).
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_NAME="audit_stale_instances"

GARM_BIN="${GARM_BIN:-garm-cli}"
TTL_MIN="${GARM_INSTANCE_TTL_MIN:-240}"
ORPHAN_MULT="${GARM_ORPHAN_MULT:-2}"
PROV_MIN="${GARM_PROV_STUCK_MIN:-30}"
DRAIN_MIN="${GARM_DRAIN_STUCK_MIN:-60}"

die() { echo "$TOOL_NAME: refusing — $*" >&2; exit 2; }
say() { printf '%s\n' "$*"; }

[[ "$TTL_MIN" =~ ^[1-9][0-9]*$ ]] \
  || die "GARM_INSTANCE_TTL_MIN must be a positive integer (got '$TTL_MIN')"
[[ "$ORPHAN_MULT" =~ ^[1-9][0-9]*$ ]] \
  || die "GARM_ORPHAN_MULT must be a positive integer (got '$ORPHAN_MULT')"
[[ "$PROV_MIN" =~ ^[1-9][0-9]*$ ]] \
  || die "GARM_PROV_STUCK_MIN must be a positive integer (got '$PROV_MIN')"
[[ "$DRAIN_MIN" =~ ^[1-9][0-9]*$ ]] \
  || die "GARM_DRAIN_STUCK_MIN must be a positive integer (got '$DRAIN_MIN')"
ORPHAN_MIN=$(( 10#$TTL_MIN * 10#$ORPHAN_MULT ))

JSON_OUT=0
NOW_ISO=""
declare -a POOL_JSONS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_OUT=1; shift ;;
    --now) [[ $# -ge 2 ]] || die "--now needs an ISO-8601 value"; NOW_ISO="$2"; shift 2 ;;
    --pool-json) [[ $# -ge 2 ]] || die "--pool-json needs a file"; POOL_JSONS+=("$2"); shift 2 ;;
    -h|--help)
      sed -n '2,/^# USAGE/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      echo "reads only: garm-cli pool show --format json (no writes of any kind)"
      exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v jq >/dev/null 2>&1 || die "jq required"

if [[ -n "$NOW_ISO" ]]; then
  now_s="$(date -u -d "$NOW_ISO" +%s 2>/dev/null)" \
    || die "--now value is not parseable (want ISO-8601 UTC, e.g. 2026-10-03T14:00:00Z)"
  now_iso="$NOW_ISO"
else
  now_s="$(date -u +%s)"
  now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

# --- collect pool-show JSON documents (reads only) ---------------------------
declare -a POOL_DOCS=()
declare -a POOL_TAGS=()
if (( ${#POOL_JSONS[@]} > 0 )); then
  for f in "${POOL_JSONS[@]}"; do
    [[ -r "$f" ]] || die "--pool-json file not readable: $f"
    doc="$(cat "$f")" || die "cannot read --pool-json file: $f"
    jq -e . >/dev/null 2>&1 <<<"$doc" || die "--pool-json file is not JSON: $f"
    POOL_DOCS+=("$doc")
    POOL_TAGS+=("$f")
  done
else
  read -r -a POOLS <<<"${GARM_POOLS:-}"
  (( ${#POOLS[@]} > 0 )) \
    || die "GARM_POOLS (space-separated pool IDs) must be set in live mode, or pass --pool-json"
  for pool in "${POOLS[@]}"; do
    [[ "$pool" =~ ^[A-Za-z0-9_.-]+$ ]] || die "bad pool ID '$pool'"
  done
  command -v "$GARM_BIN" >/dev/null 2>&1 \
    || die "no '$GARM_BIN' on PATH (operator install?)"
  for pool in "${POOLS[@]}"; do
    # READ-ONLY: pool show is a GET. This script contains no delete/destroy/
    # remove/stop/kill invocation by construction (pinned by suite §2).
    if ! doc="$("$GARM_BIN" pool show "$pool" --format json 2>/dev/null)"; then
      POOL_DOCS+=("__READ_FAILED__")
      POOL_TAGS+=("$pool")
      continue
    fi
    jq -e . >/dev/null 2>&1 <<<"$doc" || doc="__UNPARSEABLE__"
    POOL_DOCS+=("$doc")
    POOL_TAGS+=("$pool")
  done
fi

# --- per-instance classification ---------------------------------------------
verdict="OK"
declare -a CAND_JSON=()
declare -a BREACH_REASONS=()
declare -a ERROR_LIST=()
declare -a HUMAN_ROWS=()
declare -a POOL_SUMMARIES=()
n_candidates=0

add_candidate() { # pool_short name status runner_status age_min bucket created_at
  local pool_short="$1" nm="$2" st="$3" rs="$4" age="$5" bucket="$6" created="$7"
  CAND_JSON+=("$(jq -cn --arg p "$pool_short" --arg n "$nm" --arg s "$st" \
    --arg r "$rs" --argjson a "$age" --arg b "$bucket" --arg c "$created" \
    '{pool:$p,name:$n,status:$s,runnerStatus:$r,ageMin:$a,bucket:$b,createdAt:$c}')")
  HUMAN_ROWS+=("$pool_short $nm age=${age}m status=${st}/${rs} -> ${bucket}")
  n_candidates=$((n_candidates + 1))
}
breach() { # reason
  BREACH_REASONS+=("$1")
  verdict="BREACH"
}
propose() { [[ "$verdict" == "OK" ]] && verdict="PROPOSE"; }

for pi in "${!POOL_DOCS[@]}"; do
  doc="${POOL_DOCS[$pi]}"
  tag="${POOL_TAGS[$pi]}"
  if [[ "$doc" == "__READ_FAILED__" ]]; then
    ERROR_LIST+=("$(jq -cn --arg p "$tag" '{pool:$p,error:"pool-show failed"}')")
    breach "pool $tag: pool-show read failed"
    continue
  fi
  if [[ "$doc" == "__UNPARSEABLE__" ]]; then
    ERROR_LIST+=("$(jq -cn --arg p "$tag" '{pool:$p,error:"pool-show unparseable"}')")
    breach "pool $tag: pool-show output unparseable"
    continue
  fi
  enabled="$(jq -r '.enabled | tostring' <<<"$doc" 2>/dev/null)" || enabled="?"
  min_idle="$(jq -r 'if has("min_idle_runners") then .min_idle_runners | tostring else "ABSENT" end' <<<"$doc" 2>/dev/null)" || min_idle="?"
  max_run="$(jq -r '.max_runners // empty' <<<"$doc" 2>/dev/null)" || max_run=""
  pool_id="$(jq -r '.id // .pool_id // empty' <<<"$doc" 2>/dev/null)" || pool_id=""
  [[ -n "$pool_id" ]] || pool_id="$tag"
  short="${pool_id:0:8}"
  # Live GARM v0.2.1 omits min_idle_runners when zero (params.Pool omitempty;
  # measured on installed pools — see push-garm-pool.sh). Absent means 0.
  [[ "$min_idle" == "ABSENT" ]] && min_idle="0"
  if [[ "$enabled" != "true" && "$enabled" != "false" ]] \
    || [[ ! "$min_idle" =~ ^[0-9]+$ || ! "$max_run" =~ ^[0-9]+$ ]]; then
    ERROR_LIST+=("$(jq -cn --arg p "$short" '{pool:$p,error:"pool shape unreadable"}')")
    breach "pool $short: enabled/min/max shape unreadable"
    continue
  fi
  # Fields are joined on U+001F (unit separator), a non-whitespace byte, so
  # empty fields survive the read below. TSV would collapse here: tab is IFS
  # whitespace, so a null created_at would shift updated_at into its column
  # and defeat the unknown-age fail-closed rule.
  inst_rows="$(jq -r '.instances[]? | [(.status // "?"), (.runner_status // "?"), (.name // "?"), ((.created_at // .createdAt // "") | tostring), ((.updated_at // .updatedAt // "") | tostring)] | map(tostring | gsub("\u001f"; "?")) | join("\u001f")' <<<"$doc" 2>/dev/null)" \
    || { ERROR_LIST+=("$(jq -cn --arg p "$short" '{pool:$p,error:"instances unreadable"}')"); breach "pool $short: instances unreadable"; continue; }

  # Materialise instance rows for two-pass idle-excess ranking.
  declare -a I_ST=() I_RS=() I_NM=() I_CR=() I_UP=()
  while IFS=$'\x1f' read -r st rs nm cr up; do
    [[ -n "$st" ]] || continue
    # VM names are operator-controlled; anything outside the safe alphabet is
    # addressed by index so a hostile name never reaches a proposal verbatim.
    [[ "$nm" =~ ^[A-Za-z0-9_.-]+$ ]] || nm="inst-${#I_ST[@]}"
    I_ST+=("$st"); I_RS+=("$rs"); I_NM+=("$nm"); I_CR+=("$cr"); I_UP+=("$up")
  done <<<"$inst_rows"
  actual="${#I_ST[@]}"
  (( actual <= 10#$max_run )) \
    || breach "pool $short holds $actual instances over max $max_run (size-cap violation)"

  # Pass 1: count idle (running + runner idle) for the warm-spare reservation.
  idle_total=0
  for i in "${!I_ST[@]}"; do
    [[ "${I_ST[$i]}" == "running" && "${I_RS[$i]}" == "idle" ]] && idle_total=$((idle_total + 1))
  done
  excess=$((idle_total - 10#$min_idle))
  (( excess < 0 )) && excess=0

  pool_cand_before=$n_candidates
  for i in "${!I_ST[@]}"; do
    st="${I_ST[$i]}"; rs="${I_RS[$i]}"; nm="${I_NM[$i]}"; cr="${I_CR[$i]}"; up="${I_UP[$i]}"
    created_s=""
    if [[ -n "$cr" ]]; then
      created_s="$(date -u -d "$cr" +%s 2>/dev/null)" || created_s=""
    fi
    if [[ -z "$created_s" ]]; then
      # Unknown age fails closed: counted as a breach candidate, never a pass.
      add_candidate "$short" "$nm" "$st" "$rs" -1 "unknown-age" "${cr:-absent}"
      breach "pool $short/$nm: age unreadable (status $st/$rs)"
      continue
    fi
    age_min=$(( (now_s - created_s) / 60 ))
    (( age_min < 0 )) && age_min=0   # future clock skew reads as newborn, never as orphan
    # Stuck-state timers measure time IN STATE (updated_at), not instance age:
    # a runner whose job ran 120m breaches the moment GARM starts deleting it
    # otherwise. updated_at older than created_at (skew) or absent falls back
    # to created_at, preserving the previous behaviour in those cases.
    state_s="$created_s"
    if [[ -n "$up" ]]; then
      up_s="$(date -u -d "$up" +%s 2>/dev/null)" || up_s=""
      [[ -n "$up_s" ]] && (( up_s >= created_s )) && state_s="$up_s"
    fi
    state_min=$(( (now_s - state_s) / 60 ))
    (( state_min < 0 )) && state_min=0
    past_ttl=0; past_orphan=0
    (( age_min > 10#$TTL_MIN )) && past_ttl=1
    (( age_min > ORPHAN_MIN )) && past_orphan=1

    if [[ "$st" == "error" || "$rs" == "failed" ]]; then
      if (( state_min > 10#$DRAIN_MIN )); then
        add_candidate "$short" "$nm" "$st" "$rs" "$state_min" "prov-fail" "$cr"
        breach "pool $short/$nm: prov-fail stuck ${state_min}m in state"
      else
        HUMAN_ROWS+=("$short $nm age=${age_min}m status=${st}/${rs} -> prov-fail (young, info only)")
      fi
    elif [[ "$st" == "pending_delete" || "$st" == "pending_force_delete" || "$st" == "deleting" ]]; then
      if (( state_min > 10#$DRAIN_MIN )); then
        add_candidate "$short" "$nm" "$st" "$rs" "$state_min" "draining" "$cr"
        breach "pool $short/$nm: drain stuck ${state_min}m in state"
      else
        HUMAN_ROWS+=("$short $nm age=${age_min}m status=${st}/${rs} -> draining (young, info only)")
      fi
    elif [[ "$st" == "pending_create" || "$st" == "creating" || "$rs" == "installing" ]]; then
      if (( state_min > 10#$PROV_MIN )); then
        add_candidate "$short" "$nm" "$st" "$rs" "$state_min" "provisioning" "$cr"
        breach "pool $short/$nm: provisioning stuck ${state_min}m in state"
      else
        HUMAN_ROWS+=("$short $nm age=${age_min}m status=${st}/${rs} -> provisioning (young, info only)")
      fi
    elif [[ "$st" == "running" && "$rs" == "idle" ]]; then
      # Rank among idle by age: the `excess` OLDEST idle instances sit outside
      # the min_idle reservation and are reaping candidates past TTL. The
      # newest `min_idle` are warm spares and stay exempt whatever their age.
      older=0
      for j in "${!I_ST[@]}"; do
        [[ "${I_ST[$j]}" == "running" && "${I_RS[$j]}" == "idle" ]] || continue
        [[ "$j" == "$i" ]] && continue
        cjs=""
        [[ -n "${I_CR[$j]}" ]] && cjs="$(date -u -d "${I_CR[$j]}" +%s 2>/dev/null)" || cjs=""
        if [[ -n "$cjs" ]] && { (( cjs < created_s )) || { (( cjs == created_s )) && (( j < i )); }; }; then
          older=$((older + 1))
        fi
      done
      if (( older < excess )); then
        if (( past_orphan )); then
          add_candidate "$short" "$nm" "$st" "$rs" "$age_min" "idle-excess" "$cr"
          breach "pool $short/$nm: idle-excess orphan ${age_min}m"
        elif (( past_ttl )); then
          add_candidate "$short" "$nm" "$st" "$rs" "$age_min" "idle-excess" "$cr"
          propose
        else
          HUMAN_ROWS+=("$short $nm age=${age_min}m status=${st}/${rs} -> idle-excess (young, info only)")
        fi
      else
        HUMAN_ROWS+=("$short $nm age=${age_min}m status=${st}/${rs} -> warm-spare (exempt, info only)")
      fi
    elif [[ "$st" == "running" ]]; then
      if (( past_orphan )); then
        add_candidate "$short" "$nm" "$st" "$rs" "$age_min" "busy" "$cr"
        breach "pool $short/$nm: busy orphan ${age_min}m"
      elif (( past_ttl )); then
        add_candidate "$short" "$nm" "$st" "$rs" "$age_min" "busy" "$cr"
        propose
      else
        HUMAN_ROWS+=("$short $nm age=${age_min}m status=${st}/${rs} -> busy (young, info only)")
      fi
    else
      if (( past_orphan )); then
        add_candidate "$short" "$nm" "$st" "$rs" "$age_min" "stale" "$cr"
        breach "pool $short/$nm: stale orphan ${age_min}m"
      elif (( past_ttl )); then
        add_candidate "$short" "$nm" "$st" "$rs" "$age_min" "stale" "$cr"
        propose
      else
        HUMAN_ROWS+=("$short $nm age=${age_min}m status=${st}/${rs} -> stale (young, info only)")
      fi
    fi
  done
  pool_cand=$((n_candidates - pool_cand_before))
  POOL_SUMMARIES+=("$(jq -cn --arg p "$short" --argjson en "$enabled" \
    --argjson mi "$min_idle" --argjson mx "$max_run" --argjson act "$actual" \
    --argjson idle "$idle_total" --argjson c "$pool_cand" \
    '{pool:$p,enabled:$en,minIdle:$mi,maxRunners:$mx,actual:$act,idle:$idle,candidates:$c}')")
  [[ "$enabled" == "true" ]] \
    || HUMAN_ROWS+=("$short pool DISABLED with $actual instance(s) — ages audited anyway; disablement alone is not a breach")
done

# --- verdict output -----------------------------------------------------------
if (( JSON_OUT )); then
  cands_json="$(printf '%s\n' "${CAND_JSON[@]:-}" | jq -cs '. | map(select(. != null))' 2>/dev/null)"
  [[ -n "$cands_json" ]] || cands_json="[]"
  pools_json="$(printf '%s\n' "${POOL_SUMMARIES[@]:-}" | jq -cs '. | map(select(. != null))' 2>/dev/null)"
  [[ -n "$pools_json" ]] || pools_json="[]"
  errs_json="$(printf '%s\n' "${ERROR_LIST[@]:-}" | jq -cs '. | map(select(. != null))' 2>/dev/null)"
  [[ -n "$errs_json" ]] || errs_json="[]"
  reasons_json="$(printf '%s\n' "${BREACH_REASONS[@]:-}" | jq -Rcs 'split("\n") | map(select(length > 0))' 2>/dev/null)"
  [[ -n "$reasons_json" ]] || reasons_json="[]"
  jq -cn --arg v "$verdict" --arg now "$now_iso" \
    --argjson ttl "$TTL_MIN" --argjson om "$ORPHAN_MIN" \
    --argjson cands "$cands_json" --argjson pools "$pools_json" \
    --argjson errs "$errs_json" --argjson reasons "$reasons_json" \
    '{tool:"audit_stale_instances",now:$now,ttlMin:$ttl,orphanMin:$om,
      verdict:$v,candidates:$cands,pools:$pools,errors:$errs,breachReasons:$reasons}'
else
  say "$TOOL_NAME — $now_iso — TTL ${TTL_MIN}m / orphan ${ORPHAN_MIN}m (PROPOSE-ONLY: no deletes performed)"
  for row in ${HUMAN_ROWS[@]+"${HUMAN_ROWS[@]}"}; do say "  $row"; done
  say "verdict=$verdict candidates=$n_candidates"
  if (( n_candidates > 0 )); then
    say ""
    say "PROPOSAL (hand to an operator review — proposals delete nothing):"
    for c in ${CAND_JSON[@]+"${CAND_JSON[@]}"}; do
      say "  $(jq -r '"\(.pool)/\(.name) \(.bucket) age=\(.ageMin)m \(.status)/\(.runnerStatus)"' <<<"$c")"
    done
  fi
fi

[[ "$verdict" == "BREACH" ]] && exit 1
exit 0
