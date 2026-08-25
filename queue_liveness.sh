#!/usr/bin/env bash
# ===========================================================================
# queue_liveness.sh — refuse to route a decision at an agent that cannot
# receive it, and make a queue that has stopped deciding say so out loud.
# ---------------------------------------------------------------------------
# THE FAILURE THIS EXISTS FOR (TOG-390).
# `org_request_queue.sh submit` prints
#
#     responsible leader : P1_PRESIDENT_COO [T1_EXEC] — will be woken to decide.
#
# and nothing in the tool has ever checked whether that is true. On this
# company it frequently is not: 138 of 144 agents carry
# `runtime_config->'heartbeat'->>'wakeOnDemand' = false`, so the wake is
# refused and the request waits forever. Nothing errors. Nothing turns red.
#
# THE PLATFORM ALREADY DETECTS THIS AND NOBODY READS IT.
# `agent_wakeup_requests` holds 49,408 rows of
#
#     status=skipped  reason=heartbeat.wakeOnDemand.disabled
#     payload.mutation=assigned_todo_liveness_dispatch
#
# — the platform's own liveness dispatcher, firing ~3,300 times per stuck
# issue and being refused every time, silently. This tool does not add a new
# detector. It reads the refusals that are already being recorded.
#
# ---------------------------------------------------------------------------
# THREE RULES THIS FILE ENCODES, EACH BECAUSE THE OBVIOUS VERSION IS WRONG.
#
# 1. READ THE NESTED PATH, NEVER THE TOP LEVEL.
#    `runtime_config->>'wakeOnDemand'` is NULL for all 144 agents on this
#    company and reads as "unset, therefore wakeable". It would report the
#    entire dormant roster as healthy. The truth is one level down, under
#    'heartbeat'. `probe --explain` prints the path it used so a regression
#    to the lying path is visible in the output, not just in the diff.
#
# 2. "I COULD NOT TELL" IS A VERDICT, NOT A SYNONYM FOR "DISABLED".
#    A throttled agent and a switched-off agent are byte-identical in
#    `agent_wakeup_requests`: same reason, same status=skipped, same
#    trigger_detail=system, and no payload key distinguishes them (measured
#    across all 51,837 rows). So the cause is read from a throttle source or
#    reported `undetermined` — never guessed. Calling a throttled agent
#    "disabled" invites someone to reassign its work permanently because a
#    quota brake tripped for ten minutes.
#
#    TOG-401 CLOSED THE GAP BY MOVING THE BRAKE, NOT BY LOOSENING THIS RULE.
#    When this file shipped, the only discriminator was the host pacer's
#    `~/.paperclip/quota-pacer-throttled.json`, unreadable from a container, so
#    every dormant agent read `undetermined`. TOG-419 then replaced that pacer
#    with a brake that (a) may not disable an agent at all and (b) records its
#    throttle marker in the agent's own `runtime_config`. `quota_brake.sh
#    throttled` projects that set into the same JSON shape, and
#    `THROTTLE_SOURCE_CMD` reads it. Two consequences worth stating plainly:
#      * `disabled` is now a MEASURED cause. It fires only when a source
#        answered and did not name the agent — and since the brake is barred
#        from writing `wakeOnDemand=false`, that means a human turned it off.
#      * `throttled` now normally arrives on a REACHABLE agent, because
#        throttling lowers concurrency instead of refusing wakes. See the
#        `true` branch of probe.
#    `undetermined` did not go away and must not: both sources silent still
#    means we could not tell, and that is still not a synonym for "disabled".
#
# 3. A CHECK THAT MEASURED NOTHING MUST NOT EXIT GREEN.
#    If the liveness source cannot be reached, `alarm` exits 5 (UNKNOWN), not
#    0. Zero findings out of zero rows examined is "never ran", not "clean" —
#    and a monitor that reports clean while blind is the same silent failure
#    one level up, which is the whole bug this file is about.
#
# ---------------------------------------------------------------------------
# WHAT THIS DELIBERATELY DOES NOT KEY ON.
# The originating diagnosis held that these agents were unreachable because
# every issue assigned to them carried a pending interaction. Reconstructed
# point-in-time mid-outage, that is false: the President & COO was dark for
# 11 hours with 13 live assigned issues and ZERO pending interactions, and
# the CISO had 11 interaction-free live issues. Three different causes wore
# the same face — a disabled wake, an inference-capacity 529, and (for the
# Chief of Staff) no wake attempt generated at all in ten hours.
#
# A precondition keyed on interaction state would therefore have returned
# "reviewer looks fine" for the worst-affected agent. This one keys on
# REACHABILITY and DECISION LATENCY instead, so it catches all three observed
# causes and does not depend on which one is in play.
#
# ---------------------------------------------------------------------------
# EXIT CODES — distinct so a caller can tell the three apart.
#   0  quiet / reachable
#   2  refused (bad usage, bad input)
#   3  ALARM: something is stuck and needs a human
#   4  do-not-route: the named agent cannot receive a decision
#   5  UNKNOWN: could not measure. NOT green.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

QUEUE="${QUEUE:-$HERE/provisioner-request-queue.jsonl}"

# Hours a queue may hold a pending request with no decision of any kind before
# that silence is itself reported as a failure. Not a TTL: expiry closes one
# request, this reports that the DECIDER has stopped deciding.
STALL_HOURS="${STALL_HOURS:-12}"

# How far back to read wake attempts when deciding whether an agent is
# currently being refused. Long enough to survive a quiet night, short enough
# that a fortnight-old refusal does not condemn a since-restored agent.
WAKE_LOOKBACK_HOURS="${WAKE_LOOKBACK_HOURS:-24}"

# --- the two seams ---------------------------------------------------------
#
# LIVENESS_SOURCE_CMD lets a test drive this without a database, the same way
# REQUEST_NOTIFY_CMD lets one drive notification without a network. It is
# called with the agent id on argv and must emit ONE tab-separated line:
#
#     <wakeOnDemand>\t<lastRunAt>\t<skippedWakes>\t<totalWakes>
#
# wakeOnDemand is the literal read from the NESTED path: `true`, `false`, or
# the empty string for unset. Unset from a real database is genuinely unknown
# rather than a default — see probe_verdict.
LIVENESS_SOURCE_CMD="${LIVENESS_SOURCE_CMD:-}"

# The throttled/disabled discriminator (TOG-401). Two sources, file first.
#
# The FILE is the original seam: the old host-side pacer's restore list at
# `~/.paperclip/quota-pacer-throttled.json`. It is kept, first, and unchanged —
# an operator who has such a file, or a monitor fed a snapshot of one, must
# keep working, and pointing this variable at any producer of the same JSON is
# still the whole integration.
#
# The COMMAND is the source that actually exists on this company now. That
# host-side pacer stopped disabling agents at 2026-08-25T09:27:55Z (measured:
# zero `heartbeat.wakeOnDemand.disabled` rows since, and zero non-terminated
# agents carrying `wakeOnDemand=false`); TOG-419 replaced it with a brake that
# writes its throttle marker into each agent's OWN record. `quota_brake.sh
# throttled` projects that into this file's shape.
#
# File first, deliberately: an explicitly configured discriminator outranks a
# derived one, and it keeps the seam the acceptance criterion names as the
# integration point. A source that is unreadable, unparseable, or absent still
# yields `undetermined` — see rule 2. Neither source is ever a licence to guess.
QUOTA_PACER_THROTTLE_FILE="${QUOTA_PACER_THROTTLE_FILE:-$HOME/.paperclip/quota-pacer-throttled.json}"
THROTTLE_SOURCE_CMD="${THROTTLE_SOURCE_CMD:-$HERE/quota_brake.sh throttled}"

command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

die() { echo "REFUSED: $*" >&2; exit 2; }

now_epoch() { date -u +%s; }
iso_to_epoch() { date -u -d "$1" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null; }

# ---------------------------------------------------------------------------
# The default liveness source: Postgres, via the repo's one SQL seam.
#
# Note what is and is not counted. `skipped_wakes` counts only rows whose
# reason IS the wakeOnDemand refusal — not every skipped row — because a wake
# skipped for coalescing is not evidence of dormancy. Getting this wrong makes
# a busy healthy agent look dead.
liveness_from_sql() {
  local aid="$1"
  # shellcheck source=lib/pcsql.sh
  . "$HERE/lib/pcsql.sh" 2>/dev/null || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; return 1; }
  PGV_AGENT_ID="$aid" pcsql_run -Atq -v ON_ERROR_STOP=1 -F$'\t' <<SQL
select
  coalesce(a.runtime_config->'heartbeat'->>'wakeOnDemand', '') as wake_on_demand,
  coalesce((select max(h.created_at)::text from heartbeat_runs h where h.agent_id = a.id), '') as last_run_at,
  (select count(*) from agent_wakeup_requests w
     where w.agent_id = a.id
       and w.reason = 'heartbeat.wakeOnDemand.disabled'
       and w.created_at > now() - interval '${WAKE_LOOKBACK_HOURS} hours') as skipped_wakes,
  (select count(*) from agent_wakeup_requests w
     where w.agent_id = a.id
       and w.created_at > now() - interval '${WAKE_LOOKBACK_HOURS} hours') as total_wakes
from agents a
where a.id = :'agent_id'
SQL
}

read_liveness() {
  local aid="$1" out=""
  if [[ -n "$LIVENESS_SOURCE_CMD" ]]; then
    out="$($LIVENESS_SOURCE_CMD "$aid" 2>/dev/null)" || return 1
  else
    out="$(liveness_from_sql "$aid" 2>/dev/null)" || return 1
  fi
  out="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | head -1)"
  [[ -n "$out" ]] || return 1
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# The throttle document, from the file if there is one, otherwise from the
# command. Fails (non-zero, no output) when neither can produce anything.
#
# MEMOISED ON DISK, not in a variable. `throttle_state` is called from inside
# `$( )` in the probe, and the probe itself runs once per agent under `alarm`
# and `precondition` — a shell variable set in a subshell is discarded, so a
# 47-agent alarm would shell out to the brake (and through it to Postgres) 47
# times. The cache is keyed on `$$`, which bash keeps pointing at the top-level
# process even inside command substitution, so every subshell of one invocation
# shares one read. An empty cache file is a NEGATIVE result cached: both
# sources already failed once and re-asking cannot change that within a run.
THROTTLE_CACHE="${TMPDIR:-/tmp}/.queue_liveness_throttle.$$"
trap 'rm -f "$THROTTLE_CACHE"' EXIT

throttle_json() {
  if [[ ! -e "$THROTTLE_CACHE" ]]; then
    if [[ -n "$QUOTA_PACER_THROTTLE_FILE" && -r "$QUOTA_PACER_THROTTLE_FILE" ]]; then
      cat "$QUOTA_PACER_THROTTLE_FILE" > "$THROTTLE_CACHE" 2>/dev/null || : > "$THROTTLE_CACHE"
    elif [[ -n "$THROTTLE_SOURCE_CMD" ]]; then
      # stderr is dropped: the brake reports its own counts there, and a
      # discriminator lookup must not narrate over the probe's output.
      $THROTTLE_SOURCE_CMD 2>/dev/null > "$THROTTLE_CACHE" || : > "$THROTTLE_CACHE"
    else
      : > "$THROTTLE_CACHE"
    fi
  fi
  [[ -s "$THROTTLE_CACHE" ]] || return 1
  cat "$THROTTLE_CACHE"
}

# Is this agent one the brake throttled — i.e. expected back — or is it off?
#
# Returns: throttled | not_throttled | undetermined
# `undetermined` is load-bearing. See rule 2.
throttle_state() {
  local aid="$1" doc
  doc="$(throttle_json)" || { echo undetermined; return 0; }
  # Accept either a bare array of ids or an object keyed by id. The array
  # shape was the old host pacer's; `quota_brake.sh throttled` emits the
  # object. A document we cannot parse is undetermined, NOT not_throttled — an
  # unreadable discriminator must not silently harden into "definitely
  # disabled".
  local hit
  hit="$(jq -r --arg a "$aid" '
      if type=="array" then (map(select(. == $a or (type=="object" and .agentId == $a))) | length)
      elif type=="object" then (if has($a) then 1 else 0 end)
      else "x" end' <<<"$doc" 2>/dev/null)"
  case "$hit" in
    0) echo not_throttled ;;
    ''|x|null) echo undetermined ;;
    *) if [[ "$hit" =~ ^[0-9]+$ ]] && (( hit > 0 )); then echo throttled; else echo undetermined; fi ;;
  esac
}

# The human-readable half of the same lookup, for --explain only. Empty when
# there is nothing to say; never affects a verdict.
throttle_detail() {
  local aid="$1" doc
  doc="$(throttle_json)" || return 0
  jq -r --arg a "$aid" '
      if type=="object" and (has($a)) and ((.[$a]|type) == "object") then
        (.[$a] | "level=\(.level // "?") cap=\(.cap // "?") baseline=\(.baseline // "?")")
      else "" end' <<<"$doc" 2>/dev/null || return 0
}

# ---------------------------------------------------------------------------
# probe — the precondition. "Can this agent receive a decision right now?"
#
# Emits TSV: <verdict>\t<cause>\t<wakeOnDemand>\t<lastRunAt>\t<skipped>/<total>
cmd_probe() {
  local agent="" explain=no
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --agent) agent="$2"; shift 2;;
      --explain) explain=yes; shift;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$agent" ]] || die "usage: probe --agent <AGENT_ID> [--explain]"

  local live
  if ! live="$(read_liveness "$agent")"; then
    # Could not measure. This is exit 5, never exit 0 — see rule 3.
    printf 'unknown\tliveness_source_unreachable\t\t\t\n'
    [[ "$explain" == yes ]] && {
      echo "  could not read liveness for $agent." >&2
      echo "  source: ${LIVENESS_SOURCE_CMD:-lib/pcsql.sh (PAPERCLIP_SQL_BACKEND=${PAPERCLIP_SQL_BACKEND:-podman})}" >&2
      echo "  this is NOT a clean result. Do not read it as reachable." >&2
    }
    return 5
  fi

  local wod last skipped total
  # NOT `IFS=$'\t' read`. Tab is an IFS *whitespace* character, so bash strips
  # leading runs of it — an unset wakeOnDemand (the empty first field, which is
  # precisely the case this tool exists to handle) silently shifts every column
  # one to the left, and the probe then parses a timestamp as the flag. It
  # fails as `unparseable` rather than reading as reachable, so it is not a
  # security hole, but it turns the single most important input into a
  # permanent UNKNOWN. Translating to a non-whitespace separator first makes
  # empty fields survive.
  IFS=$'\x1f' read -r wod last skipped total <<<"${live//$'\t'/$'\x1f'}"
  skipped="${skipped:-0}"; total="${total:-0}"

  local verdict cause
  case "$wod" in
    true)
      verdict=reachable; cause=wake_on_demand_enabled
      # TOG-401. A throttled agent arrives HERE now, not in the `false` branch.
      # The brake that disabled agents is gone; TOG-419's replacement lowers
      # `maxConcurrentRuns` and is mechanically forbidden from touching
      # wakeability (`assert_policy_preserved`, quota_brake.sh). So throttling
      # no longer looks like dormancy at all.
      #
      # The verdict stays `reachable`, and that is not a downgrade of the
      # finding — it is the finding. A concurrency-throttled agent's wakes are
      # QUEUED, not refused (`enqueueWakeup` returns `{kind:"queued"}`), and
      # they drain when a slot frees. Routing a decision at it works. Calling
      # that `dormant` would be the same false alarm as calling a throttled
      # agent `disabled`, pointed the other way, and it would make `alarm`
      # scream every time the brake did its job.
      #
      # The CAUSE still changes to `throttled`, because "reachable, but its
      # work is being paced — expect latency, not silence" is a different
      # operational fact from "reachable and running free", and it is the one
      # TOG-401 exists to surface.
      [[ "$(throttle_state "$agent")" == throttled ]] && cause=throttled
      ;;
    false)
      verdict=dormant
      case "$(throttle_state "$agent")" in
        throttled)     cause=throttled ;;
        not_throttled) cause=disabled ;;
        *)             cause=undetermined ;;
      esac
      ;;
    '')
      # Unset. NOT assumed true: on this company the top-level path reads
      # unset for every agent including the 138 that are switched off, so
      # "unset means on" is exactly the inference that hides the fault. If the
      # platform is refusing wakes we can see that directly, and that evidence
      # outranks a missing field.
      if (( skipped > 0 )); then
        verdict=dormant; cause=refused_wakes_observed
      else
        verdict=unknown; cause=wake_on_demand_unset
      fi
      ;;
    *) verdict=unknown; cause="wake_on_demand_unparseable:$wod" ;;
  esac

  # Corroboration, and it can only make the verdict WORSE, never better. An
  # agent whose config says wakeable while the platform records a wall of
  # refusals is not wakeable; the refusals are the attempt and the field is
  # only the intent. This is the house rule — read the failure, not the flag.
  if [[ "$verdict" == reachable ]] && (( skipped > 0 )); then
    verdict=dormant; cause=refused_despite_enabled_flag
  fi

  printf '%s\t%s\t%s\t%s\t%s/%s\n' "$verdict" "$cause" "${wod:-unset}" "${last:-never}" "$skipped" "$total"

  if [[ "$explain" == yes ]]; then
    {
      echo "  agent            : $agent"
      echo "  read from        : runtime_config->'heartbeat'->>'wakeOnDemand'  (NESTED — the top-level path reads NULL for every agent)"
      echo "  wakeOnDemand     : ${wod:-unset}"
      echo "  last heartbeat   : ${last:-never}"
      echo "  refused wakes    : $skipped of $total in the last ${WAKE_LOOKBACK_HOURS}h (reason=heartbeat.wakeOnDemand.disabled)"
      echo "  verdict          : $verdict ($cause)"
      case "$cause" in
        undetermined)
          echo "  NOTE: cannot tell throttled from disabled. Neither discriminator answered —"
          echo "        file  : $QUOTA_PACER_THROTTLE_FILE (absent or unparseable)"
          echo "        source: ${THROTTLE_SOURCE_CMD:-<unset>} (produced nothing)"
          echo "        Reporting 'undetermined' rather than guessing 'disabled'." ;;
        disabled)
          echo "  NOTE: the throttle source answered, and this agent is NOT in it. The brake is"
          echo "        mechanically barred from writing wakeOnDemand=false, so this was set"
          echo "        deliberately — it will not lift on its own. 'disabled' here is measured,"
          echo "        not assumed: an unreadable source would have said 'undetermined'." ;;
        throttled)
          local td; td="$(throttle_detail "$agent")"
          echo "  NOTE: the quota brake throttled this agent and intends to restore it.${td:+  [$td]}"
          echo "        Do NOT reassign its work permanently on the strength of this."
          if [[ "$verdict" == reachable ]]; then
            echo "        It is still REACHABLE: throttling now lowers maxConcurrentRuns, so wakes"
            echo "        are queued and drained, never refused. Expect latency, not silence."
          fi ;;
      esac
    } >&2
  fi

  case "$verdict" in
    reachable) return 0 ;;
    dormant)   return 4 ;;
    *)         return 5 ;;
  esac
}

# ---------------------------------------------------------------------------
# alarm — "a queue with pending items and no decisions inside N hours is a
# failure that must surface, not a quiet state."
#
# Two independent triggers, because they catch different shapes of the same
# silence:
#   (a) a pending request whose responsible leader cannot receive it — caught
#       at any age, because waiting for a dormant agent is not a delay, it is
#       a dead end; and
#   (b) a queue holding pending work with no decision of ANY kind inside
#       STALL_HOURS — which catches a decider that went quiet for a reason we
#       have not thought of, including the two this company has already seen
#       that had nothing to do with wakeOnDemand.
cmd_alarm() {
  local stall="$STALL_HOURS" quiet=no
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --stall-hours) stall="$2"; shift 2;;
      --quiet) quiet=yes; shift;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ "$stall" =~ ^[0-9]+$ ]] || die "--stall-hours must be a whole number of hours"

  if [[ ! -f "$QUEUE" ]]; then
    # No queue file is not "no problem" — it is nothing measured.
    echo "UNKNOWN: no queue at $QUEUE — nothing was examined." >&2
    return 5
  fi

  local STATUS_EVENTS='{"request.submitted":true,"request.reviewed":true,"request.expired":true}'
  local pending last_decision_at
  pending="$(jq -s -r --argjson ev "$STATUS_EVENTS" '
      map(select($ev[.event] // false))
      | group_by(.requestId)
      | map({rid: .[0].requestId,
             last: .[-1].status,
             leader: (.[0].responsibleLeaderAgentId // ""),
             leaderRole: (.[0].responsibleLeader // ""),
             at: (.[0].submittedAt // .[0].at // "")})
      | map(select(.last == "pending"))
      | .[] | "\(.rid)\t\(.leader)\t\(.leaderRole)\t\(.at)"' "$QUEUE" 2>/dev/null)"

  # The most recent time ANY request reached a decision. This is the "is the
  # decider still deciding" clock, and it is deliberately queue-wide rather
  # than per-request: one request sitting 20 hours while others are being
  # decided is a slow request, whereas nothing at all being decided for 20
  # hours is a broken gate.
  last_decision_at="$(jq -s -r '
      map(select(.event == "request.reviewed" or .event == "request.expired"))
      | map(.at // empty) | sort | last // ""' "$QUEUE" 2>/dev/null)"

  local findings=0 unknowns=0 pending_count=0
  local rid leader leaderRole at

  if [[ -n "$pending" ]]; then
    while IFS=$'\t' read -r rid leader leaderRole at; do
      [[ -n "$rid" ]] || continue
      pending_count=$((pending_count + 1))
      [[ -n "$leader" ]] || continue
      local out rc
      out="$(cmd_probe --agent "$leader" 2>/dev/null)"; rc=$?
      local verdict cause; IFS=$'\t' read -r verdict cause _ _ _ <<<"$out"
      case "$rc" in
        4) findings=$((findings + 1))
           echo "ALARM: $rid is routed at ${leaderRole:-$leader}, which is $verdict ($cause) — it cannot receive this decision."
           [[ "$cause" == undetermined ]] && \
             echo "       cause not established (throttled vs disabled indistinguishable from here); treat as unreachable, not as dead."
           ;;
        5) unknowns=$((unknowns + 1))
           echo "UNKNOWN: $rid is routed at ${leaderRole:-$leader} and its reachability could not be measured ($cause)."
           ;;
      esac
    done <<<"$pending"
  fi

  # Trigger (b). Only meaningful when something is actually waiting: a queue
  # with nothing pending has not stalled, it is simply idle, and reporting
  # that as a failure trains people to ignore this tool.
  if (( pending_count > 0 )); then
    local ref_epoch now age_h
    now="$(now_epoch)"
    if [[ -n "$last_decision_at" ]]; then
      ref_epoch="$(iso_to_epoch "$last_decision_at")"
    else
      # Nothing has EVER been decided. Age the queue from its oldest pending
      # submission instead, so a gate that has never once produced a decision
      # is caught rather than exempted by the absence of the very evidence it
      # is failing to create.
      local oldest
      oldest="$(printf '%s\n' "$pending" | cut -f4 | grep -v '^$' | sort | head -1)"
      [[ -n "$oldest" ]] && ref_epoch="$(iso_to_epoch "$oldest")"
    fi
    if [[ -n "${ref_epoch:-}" ]] && [[ "$ref_epoch" =~ ^[0-9]+$ ]]; then
      age_h=$(( (now - ref_epoch) / 3600 ))
      if (( age_h >= stall )); then
        findings=$((findings + 1))
        if [[ -n "$last_decision_at" ]]; then
          echo "ALARM: $pending_count request(s) pending and nothing has been decided for ${age_h}h (threshold ${stall}h; last decision $last_decision_at)."
        else
          echo "ALARM: $pending_count request(s) pending and NO request has ever been decided; oldest has waited ${age_h}h (threshold ${stall}h)."
        fi
      fi
    else
      unknowns=$((unknowns + 1))
      echo "UNKNOWN: could not establish a decision clock for $pending_count pending request(s)."
    fi
  fi

  if (( findings > 0 )); then
    echo "" ; echo "$findings alarm(s), $pending_count pending request(s) examined."
    return 3
  fi
  if (( unknowns > 0 )); then
    echo "$unknowns item(s) could not be measured; $pending_count pending request(s) examined. NOT a clean result."
    return 5
  fi
  [[ "$quiet" == yes ]] || echo "quiet: $pending_count pending request(s), all routed at reachable agents, decisions current."
  return 0
}

# ---------------------------------------------------------------------------
# precondition — the one-line gate a router calls before enqueuing.
# Exit 0 route it, 4 do not, 5 could not tell (which is also do not).
cmd_precondition() {
  local agent="" role=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --agent) agent="$2"; shift 2;;
      --role)  role="$2";  shift 2;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ -n "$agent" ]] || die "usage: precondition --agent <AGENT_ID> [--role <ROLE>]"
  local out rc; out="$(cmd_probe --agent "$agent")"; rc=$?
  local verdict cause; IFS=$'\t' read -r verdict cause _ _ _ <<<"$out"
  case "$rc" in
    0) echo "ok: ${role:-$agent} can receive a decision."; return 0 ;;
    4) echo "DO NOT ROUTE: ${role:-$agent} is $verdict ($cause). Routing here enqueues into silence — escalate or hold." >&2; return 4 ;;
    *) echo "DO NOT ROUTE: reachability of ${role:-$agent} could not be measured ($cause). Unmeasured is not reachable." >&2; return 5 ;;
  esac
}

usage() {
  cat <<'EOF'
queue_liveness.sh — is the agent we are about to route a decision at able to receive it?

  probe        --agent <ID> [--explain]     verdict for one agent  (0 reachable, 4 dormant, 5 unknown)
  precondition --agent <ID> [--role <ROLE>] gate before routing    (0 route, 4/5 do not)
  alarm        [--stall-hours N] [--quiet]  scan the queue          (0 quiet, 3 ALARM, 5 unmeasured)

Environment:
  LIVENESS_SOURCE_CMD        override the liveness reader (test seam; agent id on argv, TSV out)
  QUOTA_PACER_THROTTLE_FILE  throttled-vs-disabled discriminator, tried FIRST
  THROTTLE_SOURCE_CMD        fallback discriminator when that file is absent
                             (default: ./quota_brake.sh throttled). Both silent
                             => cause 'undetermined'; neither is ever guessed at
  STALL_HOURS                default stall threshold (12)
  WAKE_LOOKBACK_HOURS        window for counting refused wakes (24)
  QUEUE                      request queue jsonl
EOF
}

case "${1:-}" in
  probe)        shift; cmd_probe "$@";;
  precondition) shift; cmd_precondition "$@";;
  alarm)        shift; cmd_alarm "$@";;
  -h|--help|help|'') usage;;
  *) echo "REFUSED: unknown subcommand '$1'" >&2; usage >&2; exit 2;;
esac
