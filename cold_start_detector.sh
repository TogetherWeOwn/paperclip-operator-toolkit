#!/usr/bin/env bash
# ===========================================================================
# cold_start_detector.sh — say out loud when the company is COLD and the
# quota it was waiting for came back. (TOG-487.)
# ---------------------------------------------------------------------------
# THE OUTAGE THIS EXISTS FOR.
# On 2026-08-25 an 89-minute quota drain became a 5.5-hour outage. The drain
# is TOG-477's subject. This file is about the other 3.5 hours — the ones
# after the quota was already back.
#
# Every row below was queried directly against `heartbeat_runs` /
# `issue_recovery_actions`, company-scoped, and re-confirmed while writing
# this file:
#
#   * 202 runs died `429 All 2 accounts exhausted` between 09:43:20Z and
#     13:41:17Z.
#   * ZERO of them scheduled a retry — `count(scheduled_retry_at) = 0`.
#   * All 202 carried `error_code='acpx_turn_failed'` and
#     `result_json->>'errorFamily' IS NULL`.
#   * Recovery opened 38 `stranded_assigned_issue` actions, each attempted
#     once, into the same 429, with `max_attempts IS NULL` and
#     `timeout_at IS NULL` — so nothing bounded them and nothing retried them.
#   * The five-hour window read 0 on one account from 15:15:12Z.
#   * The company then did no work at all until 17:07Z.
#
# ---------------------------------------------------------------------------
# WHY THIS IS A DETECTOR HERE AND NOT A FIX IN THE PLATFORM.
#
# The platform HAS the retry path and it HAS a classifier for this exact
# failure body. Neither fired, and the reason is a single function. Read in
# the running build's own source, not assumed:
#
#   `services/heartbeat.ts:548-566`  readHeartbeatRunErrorFamily() returns a
#       family only when `resultJson.errorFamily` is already set, or when
#       `errorCode` is literally one of `provider_quota`,
#       `codex_transient_upstream`, `claude_transient_upstream`,
#       `codex_harness_crash`. Our 202 runs are `acpx_turn_failed` with a null
#       errorFamily, so it returns null for every one of them.
#
#   `services/heartbeat.ts:11081-11083`  transientRecovery is that function's
#       result. Null.
#
#   `services/heartbeat.ts:11444-11470`  the retry wakeup builds
#       `providerQuotaRetryNotBefore` only when
#       `transientRecovery?.errorFamily === "provider_quota"`. Never true.
#
#   `services/heartbeat.ts:15832`  the ONLY place a run's
#       `resultJson.errorFamily` is stamped at failure time reads
#       `adapterResult.errorFamily ?? null` — and `grep -rn errorFamily
#       /app/server/src/adapters/` returns NOTHING. No adapter on the ACP lane
#       emits the field at all.
#
#   `services/recovery/teamclaude-quota-recovery.test.ts:31-45`  a test that
#       asserts this exact `acpx_turn_failed` + exhaustion body classifies as
#       `provider_quota`. It does — in `services/recovery/service.ts:3588` —
#       but that classification is READ for recovery bookkeeping and is never
#       written back onto the run, so the scheduler's family stays null.
#
# So the classification happens in the wrong layer to arm a retry, and both
# layers are `/app/server/src`, which is the Paperclip platform and not this
# repo. We cannot patch the scheduler. What we CAN do is notice, from outside,
# that the company is sitting still while the thing it was waiting for is
# already back — which is what nothing did for three hours and twenty minutes.
#
# ---------------------------------------------------------------------------
# FIVE RULES THIS FILE ENCODES, EACH BECAUSE THE OBVIOUS VERSION IS WRONG.
#
# 1. A NULL `five_hour` IS NOT HEADROOM. This is not hypothetical: the real
#    feed for the outage window contains
#
#        15:00:11Z  five_hour = [1,    null]
#        15:45:21Z  five_hour = [null, 0   ]
#
#    and bash scores an empty string as zero, so `[[ "$fh" -lt 1 ]]` on a
#    missing reading is TRUE. A detector that took the shortcut would have
#    fired at 15:00:11Z on an account whose window was never measured — 15
#    minutes early, off a hole in the data, which is exactly the kind of
#    early-and-wrong that gets a monitor muted. Headroom requires a reading
#    that is a NUMBER. `has_headroom` therefore returns three states, not two.
#
# 2. A STOPPED PACER IS NOT AN ABSENCE OF HEADROOM. The pacer writes every
#    ~15 minutes. If it dies during an outage, its last record still says
#    THROTTLE forever, and a detector keyed on "the newest record" would stay
#    quiet for as long as the feed stayed dead — silent precisely when the
#    company is darkest. So a stale feed is UNKNOWN (exit 5), never quiet.
#
# 3. HEADROOM MUST HAVE HELD, NOT JUST APPEARED. One sample of a five-hour
#    window at 0 can be a reporting blip between two throttled samples.
#    `headroom_minutes` is measured by walking BACK through consecutive
#    records, and a run of less than HEADROOM_MIN_MINUTES reports `warming`
#    rather than firing. On the recorded window this costs nothing: headroom
#    became continuously true at 15:15:12Z and never lapsed.
#
# 4. "NOTHING STALE" AND "COULD NOT COUNT" AND "STALE BUT SUPPRESSED" ARE
#    THREE DIFFERENT ANSWERS. An absence assertion needs three outcomes. If
#    the recovery source cannot be read, `stale_count` is the empty string,
#    `(( stale_count > 0 ))` is FALSE, and the detector reports a clean
#    company it never measured. Every count read here is validated as a
#    decimal integer before any comparison, and a count that is not one is
#    exit 5.
#
# 5. `runs_in_flight > 0` SUPPRESSES THE ALARM AND SAYS SO. This is the
#    contract TOG-487 asked for and it is implemented literally. It is also a
#    known false negative and this file will not pretend otherwise: during the
#    outage the ONLY runs were the watchdog's own review issues (TOG-485,
#    TOG-486), so a single watchdog run coinciding with a pacer sample would
#    have masked a company that was otherwise entirely stopped. When the
#    recovery half fires and this gate suppresses it, the suppression is
#    printed to stderr with its counts rather than collapsing into a bare
#    "quiet". Verdict `suppressed` exits 0; it is not an alarm, and it is not
#    silence either. Tightening it needs a measure of "work the company chose
#    to do" that can tell a watchdog from a workforce, and we do not have one.
#
# ---------------------------------------------------------------------------
# WHAT THIS DELIBERATELY DOES NOT DO: IT DOES NOT WAKE ANYBODY.
#
# `plan` prints the re-drive and writes nothing. Two reasons, both measured.
#
#   * The storm that drained the quota ran at ~0.30 wake/15min per account
#     with 28-47 runs in flight. Sustainable is ~0.05/15min. A detector that
#     fanned out on its own trigger is a louder version of the drain it is
#     detecting, and it would fire on a false positive at full power.
#   * An agent cannot wake a peer anyway: `POST /agents/:id/wakeup` is
#     self-only (`routes/agents.ts:3599-3605`). The working mechanism is a
#     mention comment, which is a write to somebody else's issue thread. That
#     belongs behind a human or an incident commander reading the plan, not
#     behind a cron.
#
# So `plan` emits capped, ordered, copy-pasteable commands and stops.
#
# ---------------------------------------------------------------------------
# EXIT CODES — distinct so a caller can tell them apart.
#   0  quiet / suppressed / warming — measured, and no alarm
#   2  refused (bad usage, bad input)
#   3  ALARM: cold with headroom — work is stranded and the quota is back
#   5  UNKNOWN: could not measure. NOT green.
# ===========================================================================
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# --- the seams --------------------------------------------------------------
#
# Same convention as LIVENESS_SOURCE_CMD in queue_liveness.sh and
# PACE_SOURCE_CMD in quota_brake.sh: the impure edges are injectable, which is
# what lets the suite run in CI with no database and no host files.
#
# NOTE THE NAME. quota_brake.sh's PACE_SOURCE_CMD emits ONE sample; this needs
# the WINDOW, because rule 3 measures how long headroom has held. Reusing that
# variable name for a different shape would be a trap for whoever wires both
# tools into the same harness, so it gets its own.
PACE_WINDOW_CMD="${PACE_WINDOW_CMD:-}"        # stdout: JSONL pace samples, oldest first
RECOVERY_SOURCE_CMD="${RECOVERY_SOURCE_CMD:-}" # stdout: active recovery actions, TSV

QUOTA_PACING_FILE="${QUOTA_PACING_FILE:-/paperclip/operator-handoff/quota-pacing.jsonl}"

# An account's five-hour window at or below this is headroom. TOG-487's number.
HEADROOM_FIVE_HOUR="${HEADROOM_FIVE_HOUR:-0.10}"

# How long headroom must have held before it counts. See rule 3.
HEADROOM_MIN_MINUTES="${HEADROOM_MIN_MINUTES:-20}"

# How old the newest pace sample may be before the FEED is the problem. The
# pacer writes every ~15 minutes, so 30 tolerates one missed tick. See rule 2.
PACER_MAX_AGE_MIN="${PACER_MAX_AGE_MIN:-30}"

# An active recovery action untouched for this long is stranded, not in
# progress. The 2026-08-25 set was untouched for 3h27m at the point the
# company came back by hand.
ACTION_STALE_MIN="${ACTION_STALE_MIN:-20}"

# Cap on concurrent restarts in `plan`. TOG-487's number, derived from the
# drain: the storm ran ~0.30/15min per account at 28-47 in flight against a
# sustainable ~0.05/15min. Twelve is deliberately below the observed floor of
# the storm, not a fraction of it.
MAX_RESTARTS="${MAX_RESTARTS:-12}"

# Optional priority list for `plan`: one agent id or exact agent name per
# line, most-preferred first. Absent, targets are ordered by how many stranded
# issues each owns (see cmd_plan). Comments and blanks ignored.
DISPATCH_OWNERS_FILE="${DISPATCH_OWNERS_FILE:-}"

# Deterministic clock for the suite. Absent, real time.
COLD_START_NOW="${COLD_START_NOW:-}"

command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

die()     { echo "REFUSED: $*" >&2; exit 2; }
unknown() { echo "UNKNOWN: $*" >&2; exit 5; }

now_epoch() {
  if [[ -n "$COLD_START_NOW" ]]; then iso_to_epoch "$COLD_START_NOW"; else date -u +%s; fi
}
iso_to_epoch() { date -u -d "$1" +%s 2>/dev/null; }

# Rule 4, in one place. A count that is not a decimal integer is not a count,
# and must never reach a numeric comparison — `(( "" > 0 ))` is false and
# `[[ "" -eq 0 ]]` is true, so an unread source otherwise reports "clean".
is_int() { [[ "${1:-}" =~ ^-?[0-9]+$ ]]; }

# ---------------------------------------------------------------------------
# The pace window. Oldest first, newest last, blank and unparseable lines
# dropped — but a file whose lines are ALL unparseable is not an empty window,
# it is an unreadable one, and read_pace_window fails rather than returning
# nothing for the caller to misread as "no headroom".
read_pace_window() {
  local out kept
  if [[ -n "$PACE_WINDOW_CMD" ]]; then
    out="$($PACE_WINDOW_CMD 2>/dev/null)" || return 1
  else
    [[ -r "$QUOTA_PACING_FILE" ]] || return 1
    out="$(cat "$QUOTA_PACING_FILE" 2>/dev/null)" || return 1
  fi
  # Skip a torn append and sort by timestamp. The production path then validates
  # this same immutable snapshot, so an append between guard and analysis cannot
  # make the detector evaluate a record the guard never saw.
  kept="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | jq -cs '
    map(select(type == "object")
        | . as $row
        | if (($row.ts | type) == "string" and ($row.ts | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
          then try (($row.ts | fromdateiso8601) as $epoch | {epoch:$epoch,row:$row}) catch empty
          else empty
          end)
    | sort_by(.epoch) | .[].row' 2>/dev/null)" || return 1
  [[ -n "$kept" ]] || return 1

  if [[ -z "$PACE_WINDOW_CMD" ]]; then
    local guard_file guard rc
    local -a now_arg=()
    guard_file="$(mktemp "${TMPDIR:-/tmp}/cold-start-guard.XXXXXX")" || return 1
    printf '%s\n' "$kept" >"$guard_file" || { rm -f "$guard_file"; return 1; }
    [[ -n "$COLD_START_NOW" ]] && now_arg=(--now "$COLD_START_NOW")
    if guard="$(python3 "$HERE/pacing_verdict.py" --file "$guard_file" --max-age-minutes 120 "${now_arg[@]}" 2>&1)"; then
      rc=0
    else
      rc=$?
    fi
    rm -f "$guard_file"
    if (( rc != 0 )); then
      echo "UNKNOWN: $guard" >&2
      return 3
    fi
  fi
  printf '%s' "$kept"
}

# has_headroom <record-json> -> prints yes|no|unmeasured
#
# RULE 1 LIVES HERE. `five_hour` must be a JSON number. jq's `type=="number"`
# is the check, done inside jq so a null, a missing key, or a string can never
# become a bash empty string that compares as zero.
has_headroom() {
  local rec="$1"
  jq -r --argjson lim "$HEADROOM_FIVE_HOUR" '
    if (.pool_verdict // "") == "BEHIND" then "no"
    else
      ([.accounts // [] | .[] | .five_hour] ) as $f
      | if ($f | map(select(type=="number")) | length) == 0 then "unmeasured"
        elif ($f | map(select(type=="number" and . <= $lim)) | length) > 0 then "yes"
        else "no" end
    end' <<<"$rec" 2>/dev/null || echo unmeasured
}

# ---------------------------------------------------------------------------
# The active recovery actions. TSV, one row per action, NOT pre-filtered by
# age: the staleness threshold is applied here so that it is one testable
# rule rather than a string interpolated into SQL that no suite can reach.
#
#   <action_id>\t<source_issue_id>\t<owner_agent_id>\t<owner_name>\t<updated_at>\t<attempt_count>
read_recovery_actions() {
  if [[ -n "$RECOVERY_SOURCE_CMD" ]]; then
    $RECOVERY_SOURCE_CMD 2>/dev/null || return 1
    return 0
  fi
  # shellcheck source=lib/pcsql.sh
  . "$HERE/lib/pcsql.sh" 2>/dev/null || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; return 1; }
  PGV_COMPANY_ID="${COMPANY_ID:-${PAPERCLIP_COMPANY_ID:-}}" pcsql_run -Atq -v ON_ERROR_STOP=1 -F$'\t' <<'SQL'
select r.id, coalesce(r.source_issue_id::text,''), coalesce(r.owner_agent_id::text,''),
       coalesce(a.name,''), r.updated_at::text, coalesce(r.attempt_count,0)
from issue_recovery_actions r
left join agents a on a.id = r.owner_agent_id
where r.company_id = :'company_id' and r.status = 'active'
SQL
}

# Split a TSV line without losing empty leading fields. `IFS=$'\t' read` will
# not do: tab is an IFS *whitespace* character, so bash collapses runs of it
# and an empty first field shifts every column one to the left. Translating to
# a non-whitespace separator first is the fix used in queue_liveness.sh.
tsv_read() { local l="$1"; shift; IFS=$'\x1f' read -r "$@" <<<"${l//$'\t'/$'\x1f'}"; }

# ---------------------------------------------------------------------------
# Everything detect and plan both need. Sets the globals below or exits 5.
#
#   PACE_TS PACE_INFLIGHT PACE_VERDICT HEADROOM_STATE HEADROOM_MIN_HELD
#   STALE_ROWS STALE_COUNT ACTIVE_COUNT
gather() {
  local window
  local pace_rc=0
  window="$(read_pace_window)" || pace_rc=$?
  if (( pace_rc == 3 )); then
    unknown "pacing verdict is UNKNOWN — nothing was examined."
  fi
  (( pace_rc == 0 )) \
    || unknown "cannot read the pace window (PACE_WINDOW_CMD or $QUOTA_PACING_FILE) — nothing was examined."

  local newest; newest="$(printf '%s\n' "$window" | tail -1)"
  PACE_TS="$(jq -r '.ts // ""' <<<"$newest")"
  PACE_VERDICT="$(jq -r '.pool_verdict // ""' <<<"$newest")"

  # RULE 4 again: runs_in_flight must be a NUMBER. Absent, it is unknown, and
  # unknown is not zero — reading a missing field as "nothing running" is
  # exactly how this alarm would fire into a busy company.
  PACE_INFLIGHT="$(jq -r 'if (.runs_in_flight | type) == "number" then (.runs_in_flight|floor) else "" end' <<<"$newest")"
  is_int "$PACE_INFLIGHT" || unknown "the newest pace sample (${PACE_TS:-no timestamp}) has no numeric runs_in_flight — cannot tell a stopped company from a busy one."

  # RULE 2: is the FEED alive?
  local now ts_epoch age_min
  now="$(now_epoch)"; is_int "$now" || unknown "cannot establish the current time (COLD_START_NOW='${COLD_START_NOW}')."
  ts_epoch="$(iso_to_epoch "$PACE_TS")"
  is_int "$ts_epoch" || unknown "the newest pace sample has no parseable timestamp ('${PACE_TS}') — the feed cannot be aged."
  age_min=$(( (now - ts_epoch) / 60 ))
  if (( age_min > PACER_MAX_AGE_MIN )); then
    unknown "the newest pace sample is ${age_min}m old (limit ${PACER_MAX_AGE_MIN}m) — the pacer has stopped, so headroom cannot be read. This is NOT 'no headroom'."
  fi

  # RULE 3: how long has headroom held, walking back through consecutive
  # records? Measured from the OLDEST record of the unbroken run, so the
  # answer is a duration and not a sample count — the pacer's interval has
  # changed before and would silently rescale a count.
  HEADROOM_STATE="$(has_headroom "$newest")"
  HEADROOM_MIN_HELD=0
  if [[ "$HEADROOM_STATE" == yes ]]; then
    local oldest_ts="$PACE_TS" rec state e
    while IFS= read -r rec; do
      [[ -n "$rec" ]] || continue
      state="$(has_headroom "$rec")"
      [[ "$state" == yes ]] || break
      e="$(jq -r '.ts // ""' <<<"$rec")"
      [[ -n "$e" ]] && oldest_ts="$e"
    done < <(printf '%s\n' "$window" | tac)
    local o; o="$(iso_to_epoch "$oldest_ts")"
    if is_int "$o"; then HEADROOM_MIN_HELD=$(( (ts_epoch - o) / 60 )); else HEADROOM_MIN_HELD=0; fi
  fi

  local rows
  rows="$(read_recovery_actions)" \
    || unknown "cannot read the recovery actions (RECOVERY_SOURCE_CMD or lib/pcsql.sh) — nothing was examined."

  ACTIVE_COUNT=0; STALE_COUNT=0; STALE_ROWS=""
  local line id iid oid oname upd att u cutoff
  cutoff=$(( now - ACTION_STALE_MIN * 60 ))
  while IFS= read -r line; do
    [[ -n "${line//[[:space:]]/}" ]] || continue
    tsv_read "$line" id iid oid oname upd att
    ACTIVE_COUNT=$((ACTIVE_COUNT + 1))
    u="$(iso_to_epoch "${upd:-}")"
    # An action whose timestamp will not parse cannot be aged. It is not
    # fresh; refusing to guess is the whole house rule, so the whole read is
    # unknown rather than silently one row lighter.
    is_int "$u" || unknown "recovery action ${id:-<no id>} has an unparseable updated_at ('${upd}') — it cannot be aged, so the count would be wrong."
    if (( u < cutoff )); then
      STALE_COUNT=$((STALE_COUNT + 1))
      STALE_ROWS+="${id}"$'\t'"${iid}"$'\t'"${oid}"$'\t'"${oname}"$'\t'"${upd}"$'\t'"${att}"$'\n'
    fi
  done <<<"$rows"

  is_int "$STALE_COUNT" && is_int "$ACTIVE_COUNT" || unknown "recovery action counts did not resolve to integers."
}

# ---------------------------------------------------------------------------
# detect — the whole point.
cmd_detect() {
  local explain=no
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --explain) explain=yes; shift;;
      *) die "unknown argument: $1";;
    esac
  done

  gather

  local verdict reason
  if [[ "$HEADROOM_STATE" == unmeasured ]]; then
    # Not an alarm and NOT a clean bill of health: the input the alarm turns
    # on was never measured. See rule 1.
    verdict=unknown; reason=five_hour_unmeasured
  elif [[ "$HEADROOM_STATE" == no ]]; then
    verdict=quiet; reason=no_headroom
  elif (( HEADROOM_MIN_HELD < HEADROOM_MIN_MINUTES )); then
    verdict=warming; reason=headroom_too_new
  elif (( PACE_INFLIGHT > 0 )); then
    verdict=suppressed; reason=runs_in_flight
  elif (( STALE_COUNT > 0 )); then
    verdict=cold_with_headroom; reason=stranded_work_and_headroom
  else
    verdict=quiet; reason=nothing_stranded
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s/%s\n' \
    "$verdict" "$reason" "$PACE_TS" "${HEADROOM_MIN_HELD}m" "$PACE_INFLIGHT" "$STALE_COUNT" "$ACTIVE_COUNT"

  # RULE 5. A suppressed alarm is not silence. Say what was found and what
  # swallowed it, on stderr, with the counts.
  if [[ "$verdict" == suppressed && "$STALE_COUNT" -gt 0 ]]; then
    {
      echo "SUPPRESSED: $STALE_COUNT of $ACTIVE_COUNT active recovery actions have been untouched for >${ACTION_STALE_MIN}m"
      echo "            and the five-hour window has had headroom for ${HEADROOM_MIN_HELD}m — but runs_in_flight=$PACE_INFLIGHT,"
      echo "            so this is not called a cold start. NOTE: one watchdog run satisfies this gate. During the"
      echo "            2026-08-25 outage the only runs were the watchdog's own review issues."
    } >&2
  fi
  if [[ "$verdict" == warming && "$STALE_COUNT" -gt 0 ]]; then
    echo "WARMING: $STALE_COUNT stranded action(s), but headroom has held only ${HEADROOM_MIN_HELD}m of the ${HEADROOM_MIN_MINUTES}m required." >&2
  fi

  if [[ "$explain" == yes ]]; then
    {
      echo "  pace sample      : ${PACE_TS} (pool_verdict=${PACE_VERDICT:-none}, runs_in_flight=${PACE_INFLIGHT})"
      echo "  headroom         : ${HEADROOM_STATE} (five_hour <= ${HEADROOM_FIVE_HOUR} on a NUMERIC account reading, pool_verdict != BEHIND)"
      echo "  held for         : ${HEADROOM_MIN_HELD}m of the ${HEADROOM_MIN_MINUTES}m required"
      echo "  recovery actions : ${STALE_COUNT} stranded of ${ACTIVE_COUNT} active (stale = untouched > ${ACTION_STALE_MIN}m)"
      echo "  verdict          : ${verdict} (${reason})"
      case "$reason" in
        five_hour_unmeasured)
          echo "  NOTE: no account in the newest sample reported a NUMERIC five_hour. A null reading is"
          echo "        not zero. The real feed for 2026-08-25 contains two such samples, and reading"
          echo "        them as headroom would have fired this alarm 15 minutes early on missing data." ;;
        stranded_work_and_headroom)
          echo "  NEXT: ./cold_start_detector.sh plan   — a capped, ordered re-drive. It writes nothing." ;;
      esac
    } >&2
  fi

  case "$verdict" in
    cold_with_headroom) return 3 ;;
    unknown)            return 5 ;;
    *)                  return 0 ;;
  esac
}

# ---------------------------------------------------------------------------
# plan — who to wake, in what order, capped. WRITES NOTHING.
#
# Ordering, and it is deterministic because a re-drive that picks a different
# twelve on every invocation is not reproducible and cannot be reviewed:
#
#   1. an explicit DISPATCH_OWNERS_FILE, in file order, if one is given;
#   2. then by number of stranded issues owned, descending — an agent holding
#      nine stranded issues IS the dispatch owner for this purpose, whatever
#      the org chart says, and waking it moves nine issues for one wake;
#   3. then oldest stranded action first;
#   4. then agent id, so ties never reorder between runs.
cmd_plan() {
  local cap="$MAX_RESTARTS"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --max) cap="$2"; shift 2;;
      *) die "unknown argument: $1";;
    esac
  done
  is_int "$cap" && (( cap > 0 )) || die "--max must be a positive whole number"

  gather

  if (( STALE_COUNT == 0 )); then
    echo "nothing to re-drive: 0 stranded of $ACTIVE_COUNT active recovery action(s)."
    return 0
  fi

  local priority=""
  if [[ -n "$DISPATCH_OWNERS_FILE" ]]; then
    [[ -r "$DISPATCH_OWNERS_FILE" ]] || die "DISPATCH_OWNERS_FILE '$DISPATCH_OWNERS_FILE' is not readable"
    priority="$(grep -v '^[[:space:]]*\(#\|$\)' "$DISPATCH_OWNERS_FILE" 2>/dev/null)"
  fi

  # Group by owner. An action with no owner still needs saying — it is work
  # nobody holds — so it is reported, never dropped.
  local -a owners=() ; local line id iid oid oname upd att
  declare -A cnt=() firstiss=() firstupd=() nm=()
  local orphans=0
  while IFS= read -r line; do
    [[ -n "${line//[[:space:]]/}" ]] || continue
    tsv_read "$line" id iid oid oname upd att
    if [[ -z "$oid" ]]; then orphans=$((orphans + 1)); continue; fi
    if [[ -z "${cnt[$oid]:-}" ]]; then
      owners+=("$oid"); cnt[$oid]=0; firstiss[$oid]="$iid"; firstupd[$oid]="$upd"; nm[$oid]="$oname"
    fi
    cnt[$oid]=$(( cnt[$oid] + 1 ))
    if [[ "$upd" < "${firstupd[$oid]}" ]]; then firstupd[$oid]="$upd"; firstiss[$oid]="$iid"; fi
  done <<<"$STALE_ROWS"

  if (( ${#owners[@]} == 0 )); then
    echo "# ${STALE_COUNT} stranded action(s), none with an owner_agent_id — nothing can be woken by mention."
    return 0
  fi

  # Sort key, widest-first: rank, then inverted count, then oldest timestamp,
  # then id. Every numeric part is zero-padded to a FIXED width because the
  # sort is lexical — an unpadded rank of 1000000 sorts before 999999 and the
  # pinned owners quietly stop being first.
  local sortable="" rank i=0 pl oid
  for oid in "${owners[@]}"; do
    rank=9999999
    if [[ -n "$priority" ]]; then
      i=0
      while IFS= read -r pl; do
        [[ -n "$pl" ]] || continue
        if [[ "$pl" == "$oid" || "$pl" == "${nm[$oid]}" ]]; then rank="$i"; break; fi
        i=$((i + 1))
      done <<<"$priority"
    fi
    sortable+="$(printf '%07d\t%09d\t%s\t%s\t%s\t%s\t%s' \
        "$rank" "$(( 999999999 - cnt[$oid] ))" "${firstupd[$oid]}" "$oid" "${nm[$oid]}" "${cnt[$oid]}" "${firstiss[$oid]}")"$'\n'
  done

  echo "# cold-start re-drive plan — ${PACE_TS}"
  echo "# ${STALE_COUNT} stranded action(s) across ${#owners[@]} owner(s); headroom held ${HEADROOM_MIN_HELD}m; runs_in_flight=${PACE_INFLIGHT}"
  echo "# cap ${cap} concurrent restarts. Sustainable is ~0.05 wake/15min per account; the 2026-08-25"
  echo "# storm ran ~0.30/15min at 28-47 in flight. DO NOT raise the cap to clear the backlog faster."
  echo "# THIS WRITES NOTHING. Each line below is a mention comment you run yourself."
  echo ""

  local n=0 shown
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    n=$((n + 1))
    (( n > cap )) && break
    local _r _c oldest oid2 name c2 iss
    tsv_read "$line" _r _c oldest oid2 name c2 iss
    printf '# %2d. %s — %s stranded, oldest %s\n' "$n" "${name:-<unnamed>}" "$c2" "$oldest"
    if [[ -n "$iss" ]]; then
      printf 'curl -sS -X POST "$PAPERCLIP_API_BASE/api/issues/%s/comments" \\\n' "$iss"
      printf '  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \\\n'
      # The mention is the wake. `POST /agents/:id/wakeup` is self-only
      # (routes/agents.ts:3599-3605), so a peer cannot be woken directly; a
      # `[Name](agent://uuid)` mention in an issue comment is the mechanism
      # that was observed working during the 2026-08-25 recovery.
      #
      # SINGLE-QUOTED, with embedded quotes escaped. These lines exist to be
      # pasted into a shell; emitting bare JSON would have the shell eat the
      # braces and POST an empty body, which returns 200 and wakes nobody.
      local body
      body="$(jq -cn --arg n "${name:-agent}" --arg a "$oid2" --arg ts "$PACE_TS" \
          '{body: ("[" + $n + "](agent://" + $a + ") — quota recovered as of " + $ts
                   + "; this issue has been stranded since the 429 storm. Re-driving it. See TOG-487.")}')"
      printf "  -d '%s'\n\n" "${body//\'/\'\\\'\'}"
    else
      printf '# (no source issue recorded for this action — wake by hand)\n\n'
    fi
  done < <(printf '%s' "$sortable" | LC_ALL=C sort)

  shown=$(( n > cap ? cap : n ))
  echo "# ${shown} of ${#owners[@]} owner(s) shown."
  # NO SILENT CAPS. A plan that quietly truncates reads as complete coverage.
  if (( ${#owners[@]} > cap )); then
    echo "# WITHHELD: $(( ${#owners[@]} - cap )) further owner(s) are NOT in this plan. Re-run after these land."
  fi
  if (( orphans > 0 )); then
    echo "# WARNING: ${orphans} stranded action(s) have no owner_agent_id and appear in no line above."
  fi
  return 0
}

usage() {
  cat <<'EOF'
cold_start_detector.sh — is the company stopped while the quota it was waiting for is back?

  detect [--explain]   0 quiet/suppressed/warming · 3 ALARM cold-with-headroom · 5 UNKNOWN
  plan   [--max N]     capped, ordered re-drive. PRINTS ONLY — writes nothing.

Verdicts from `detect` (field 1 of the TSV):
  cold_with_headroom  stranded work, quota back, nothing running          -> exit 3
  suppressed          stranded work and headroom, but runs_in_flight > 0  -> exit 0, loud on stderr
  warming             headroom has not held long enough yet               -> exit 0
  quiet               no headroom, or nothing stranded                    -> exit 0
  unknown             a required input was missing or unparseable         -> exit 5

Environment:
  PACE_WINDOW_CMD       test seam; stdout is JSONL pace samples, oldest first
  RECOVERY_SOURCE_CMD   test seam; stdout is active recovery actions as TSV:
                        id \t source_issue_id \t owner_agent_id \t owner_name \t updated_at \t attempt_count
  QUOTA_PACING_FILE     pace samples (default /paperclip/operator-handoff/quota-pacing.jsonl)
  HEADROOM_FIVE_HOUR    five-hour window at/below which an account has headroom (default 0.10)
  HEADROOM_MIN_MINUTES  how long headroom must hold before firing (default 20)
  PACER_MAX_AGE_MIN     newest sample older than this => UNKNOWN, never quiet (default 30)
  ACTION_STALE_MIN      an active action untouched this long is stranded (default 20)
  MAX_RESTARTS          cap on concurrent restarts in `plan` (default 12)
  DISPATCH_OWNERS_FILE  optional priority list, one agent id or name per line
  COLD_START_NOW        deterministic clock for the suite
  COMPANY_ID            company scope for the default SQL source
EOF
}

case "${1:-}" in
  detect) shift; cmd_detect "$@";;
  plan)   shift; cmd_plan "$@";;
  -h|--help|help|'') usage;;
  *) echo "REFUSED: unknown subcommand '$1'" >&2; usage >&2; exit 2;;
esac
