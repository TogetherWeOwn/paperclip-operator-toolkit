#!/usr/bin/env bash
# ===========================================================================
# quota_brake.sh — hold weekly quota to pace by slowing work DOWN, never by
# switching an agent OFF. (TOG-419.)
# ---------------------------------------------------------------------------
# THE INCIDENT THIS REPLACES.
# On 2026-08-25 the owner created TOG-418, assigned it to the Chief of Staff,
# and could not reach their own company. Nine seconds after the task was
# created the pacer's throttle set went from 10 agents to 44 of 47, because
# burn had spiked to ~10x sustainable. The platform then tried to wake the CoS
# every 30 seconds and was refused every time:
#
#     status=skipped  reason=heartbeat.wakeOnDemand.disabled
#
# 68 refusals in 17 minutes for the CoS alone; 58,780 across the company in
# three days, which is 95% of every skipped wake on this database. Nothing
# errored. Nothing turned red. `POST /agents/:id/wakeup` returned **202**.
#
# The old brake was not wrong about the burn rate. It was wrong about three
# other things, and this file exists to be wrong about none of them.
#
# ---------------------------------------------------------------------------
# WHY THIS BRAKES CONCURRENCY AND NOT WAKEABILITY.
#
# Measured in the running build's own source, not assumed:
#
#   * A wake ALWAYS creates a `queued` run. `services/heartbeat.ts:18192`
#     returns `{ kind: "queued" }`, and the comment at :18153 says outright
#     "enqueueWakeup queues the run but doesn't start it".
#
#   * Draining is a SEPARATE step, `startNextQueuedRunForAgent()` at
#     `services/heartbeat.ts:13443-13446`:
#
#         const runningCount   = await countRunningRunsForAgent(agentId);
#         const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
#         if (availableSlots <= 0) return [];
#
# So lowering `maxConcurrentRuns` leaves the queued run SITTING IN THE QUEUE
# and drains it when a slot frees. The work is DELAYED, never REFUSED. No
# `skipped` row is written, no 202 is returned, and the owner's task is still
# there when the brake lifts. That is the whole difference.
#
# By contrast BOTH other candidates discard the wake:
#
#   * `heartbeat.wakeOnDemand:false` — `services/heartbeat.ts:17354-17356`
#     writes `skipped/heartbeat.wakeOnDemand.disabled` and returns null.
#   * `heartbeat.maxDailyRuns` / `maxDailyCostCents` — `:18111-18130` writes
#     `status:"skipped"` with reason `heartbeat.daily_run_limit`. The agent's
#     `wakeOnDemand` FIELD stays true, so a roster check reads green while the
#     wake is dropped exactly as before. TOG-419 proposes these as the fix;
#     they are a better-labelled version of the same failure and this tool
#     does not use them. See `docs/quota-brake.md`.
#
# AND THE FLOOR IS THE PLATFORM'S, NOT OURS. `services/heartbeat.ts:347`:
#
#     const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1;
#
# clamped into every read at :2456. Concurrency CANNOT reach zero. A brake
# built on it cannot starve an agent even if a bug in this file hands it 0 or
# a negative number — the platform refuses. `wakeOnDemand` is a bare boolean
# with no floor, which is why one bad sweep took the company off the air.
#
# ---------------------------------------------------------------------------
# FOUR RULES THIS FILE ENCODES, EACH BECAUSE THE OBVIOUS VERSION IS WRONG.
#
# 1. EVERY WRITE IS READ-MODIFY-WRITE, AND THE POLICY KEYS MUST COME BACK
#    UNCHANGED. `PATCH /api/agents/{id}` REPLACES `runtimeConfig` wholesale —
#    it does not merge. Measured, because the obvious assumption is the
#    opposite and it is wrong:
#
#      before: {"heartbeat":{"enabled":false,"wakeOnDemand":true,"maxConcurrentRuns":2}}
#      PATCH   {"runtimeConfig":{"heartbeat":{"maxConcurrentRuns":3}}}   -> 200
#      after:  {"heartbeat":{"maxConcurrentRuns":3}}
#
#    `enabled` and `wakeOnDemand` were DELETED. A brake that patched just the
#    one key it cares about would strip the wakeability flag off every agent it
#    braked — and `modelProfiles`, which some agents also carry under
#    `runtimeConfig`, taking model routing with it. Unset `wakeOnDemand`
#    happens to default true (`services/heartbeat.ts:12125`), so this would not
#    have shown up as an outage; it would have quietly reconfigured the roster
#    and left the next incident with no evidence of what changed.
#
#    So the tool reads each agent's whole `runtimeConfig`, edits two keys, and
#    sends the whole thing back. `assert_policy_preserved()` then diffs the
#    outgoing body against what was read and REFUSES (exit 2) unless every
#    wakeability key and every daily-cap key is byte-identical — and
#    unconditionally if `wakeOnDemand` would go out as false. The owner's
#    requirement is enforced at the point of the write, against the actual
#    bytes, rather than by the honesty of whoever edits this next.
#
# 2. THE BASELINE IS CAPTURED ONCE, AND IT LIVES IN THE AGENT'S OWN RECORD.
#    Under `heartbeat.quotaBrake.baseline`, written by the same PATCH that
#    applies the brake. Two consequences:
#      - RESTORATION IS STATE-FREE. The old brake kept the only record of who
#        to re-enable in `~/.paperclip/quota-pacer-throttled.json`; lose it or
#        crash between throttle and restore and agents stay dead with nothing
#        to say why. Here the restore target travels with the object it
#        describes, so `restore` works from a cold start with no memory of
#        having braked. Right now ten agent rows on this company still carry
#        `wakeOnDemand:false` from a sweep whose state file moved on.
#      - RE-CAPTURE IS REFUSED. If `baseline` is already present the tool will
#        NEVER overwrite it. Capturing a baseline from an already-braked agent
#        bakes the throttled value in as "normal", and each brake cycle then
#        ratchets the agent permanently downward. That bug is invisible in a
#        single run and fatal over a week.
#
# 3. EXEMPTIONS ARE AN INPUT, NOT A SUBTRACTION. `quota_brake_exempt.txt` is
#    read BEFORE the candidate set is built, so an exempt agent never enters
#    it and there is no brake level that can reach it. An exemption applied
#    afterwards is one refactor away from being dropped.
#
# 4. A BRAKE THAT MEASURED NOTHING MUST NOT REPORT SUCCESS. If the pace signal
#    or the roster cannot be read, every subcommand exits 5 (UNKNOWN) and
#    writes nothing. Zero agents braked out of zero agents examined is "never
#    ran", not "nothing needed braking" — and a brake that reads green while
#    blind is the same silent failure this file exists to end.
#
# ---------------------------------------------------------------------------
# SUSTAINABLE BURN IS COMPUTED, NEVER CONSTANT-FOLDED.
# TOG-419 quotes "~0.09-0.13 weekly-units/day". That is not a constant, it is
# a reading of a function taken on one day. Re-derived from quota-pacing.jsonl
# and exact to four decimals on three consecutive samples:
#
#     sustainable_per_day = (TARGET - weekly_used) / days_left      TARGET=0.97
#
#     (0.97-0.61)/4.04 = 0.08911   logged 0.0891
#     (0.97-0.61)/4.03 = 0.08933   logged 0.0893
#     (0.97-0.62)/4.02 = 0.08706   logged 0.0870
#
# Today's value is ~0.087 — BELOW the quoted band, so a brake pinned to 0.09
# would run persistently hot and never catch up. TARGET is 0.97 rather than
# 1.0 so the week lands just under the cap; unused weekly quota is destroyed
# at reset, so aiming at 1.0 and overshooting is the only truly expensive
# outcome and aiming low wastes the subscription.
# ===========================================================================
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# --- test seams -------------------------------------------------------------
# Same convention as LIVENESS_SOURCE_CMD in queue_liveness.sh and
# REQUEST_NOTIFY_CMD in the queue suites: the three things that need a
# database, a host file or a credential are injectable, which is what lets the
# suite run in CI with none of them.
PACE_SOURCE_CMD="${PACE_SOURCE_CMD:-}"      # stdout: one JSON pace sample
ROSTER_SOURCE_CMD="${ROSTER_SOURCE_CMD:-}"  # stdout: roster TSV (see read_roster)
AGENT_WRITE_CMD="${AGENT_WRITE_CMD:-}"      # argv: <agent_id> <json_body>
REFUSAL_SOURCE_CMD="${REFUSAL_SOURCE_CMD:-}" # stdout: refusal TSV

QUOTA_PACING_FILE="${QUOTA_PACING_FILE:-/paperclip/operator-handoff/quota-pacing.jsonl}"
EXEMPT_FILE="${EXEMPT_FILE:-$HERE/quota_brake_exempt.txt}"
PACE_TARGET="${PACE_TARGET:-0.97}"
REFUSAL_WINDOW_MIN="${REFUSAL_WINDOW_MIN:-15}"
REFUSAL_ALARM_THRESHOLD="${REFUSAL_ALARM_THRESHOLD:-10}"

die() { echo "ERROR: $*" >&2; exit 2; }
unknown() { echo "UNKNOWN: $*" >&2; exit 5; }

usage() {
  cat <<'EOF'
quota_brake.sh — hold weekly quota to pace without ever disabling an agent.

  plan      [--explain]        compute the concurrency plan   (0 ok, 5 unmeasured)
  apply     --yes [--explain]  apply it                       (0 ok, 2 refused, 5 unmeasured)
  restore   --yes              return every braked agent to baseline (state-free)
  verify                       assert no agent is unwakeable  (0 ok, 3 VIOLATION, 5 unmeasured)
  refusals  [--since-min N]    the loud metric                (0 quiet, 3 ALARM, 5 unmeasured)

`plan` is the default and NOTHING WRITES WITHOUT --yes.

Environment:
  PACE_SOURCE_CMD / ROSTER_SOURCE_CMD / AGENT_WRITE_CMD / REFUSAL_SOURCE_CMD
                            test seams; override the four impure edges
  QUOTA_PACING_FILE         pace samples (default /paperclip/operator-handoff/quota-pacing.jsonl)
  EXEMPT_FILE               agents never braked (default ./quota_brake_exempt.txt)
  PACE_TARGET               fraction of weekly quota to aim at (default 0.97)
  PAPERCLIP_API_URL / PAPERCLIP_ADMIN_TOKEN   default write path
  REFUSAL_WINDOW_MIN        refusal metric window in minutes (default 15)
  REFUSAL_ALARM_THRESHOLD   refusals in that window before ALARM (default 10)
EOF
}

need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }

# ---------------------------------------------------------------------------
# RULE 1, enforced mechanically. Every mutation body goes through here.
#
# The owner's requirement — "the brake must never disable an agent" — is the
# one thing in this design that cannot be allowed to regress quietly. A future
# edit that reaches for `wakeOnDemand` because it is the shortest path to a
# hard stop trips this and the tool exits 2 rather than shipping the outage
# again. Checked on the SERIALISED BODY so it catches the key however it was
# constructed, including from a variable this function never sees.
# The keys that decide whether a wake SURVIVES. All four wakeability spellings
# are aliases coalesced by `parseHeartbeatPolicy` at services/heartbeat.ts:12125,
# so pinning only the canonical one would leave three unlocked doors. The
# daily-cap spellings are aliased the same way at :12133-12141 and are pinned
# for a different reason: a cap is not a wakeability flag, but it was measured
# to DROP the wake identically (status:"skipped" at :18111-18130) while leaving
# a `wakeOnDemand` roster check reading green. That makes it more dangerous
# than the mechanism it would replace, not less.
POLICY_KEYS='["wakeOnDemand","wakeOnAssignment","wakeOnOnDemand","wakeOnAutomation","maxDailyRuns","maxDailyCostCents","dailyRunLimit","dailyRunCap","maxRunsPerDay","dailyCostCentsLimit","dailySpendCentsLimit","dailyBudgetCents"]'

assert_policy_preserved() {
  local cur="$1" body="$2"
  local verdict
  verdict="$(jq -nr --argjson cur "$cur" --argjson body "$body" --argjson keys "$POLICY_KEYS" '
    ($cur.heartbeat // {})                          as $a
    | ($body.runtimeConfig.heartbeat // {})         as $b
    # `wakeOnDemand: false` is refused outright, whatever the previous value
    # was. Even "it was already false" is not a licence for this tool to write
    # it — the brake must not be the thing that persists an unwakeable agent.
    | if ($b.wakeOnDemand == false) then "DISABLES"
      # Absent-vs-present counts as a difference. Dropping the key is exactly
      # the wholesale-replace bug this guard exists for, and it is invisible if
      # you only compare values that are present on both sides.
      elif ([ $keys[] | select( ($a[.] // null) != ($b[.] // null) ) ] | length) > 0
        then "CHANGES:" + ([ $keys[] | select( ($a[.] // null) != ($b[.] // null) ) ] | join(","))
      else "OK" end')" || die "assert_policy_preserved: could not compare the bodies (malformed JSON). Refusing to write."

  case "$verdict" in
    OK) return 0 ;;
    DISABLES) die "REFUSED: mutation would set wakeOnDemand=false. The brake may not disable an agent (TOG-419)." ;;
    CHANGES:*) die "REFUSED: mutation alters wakeability/daily-cap keys [${verdict#CHANGES:}]. runtimeConfig is REPLACED, not merged, so this would silently drop them (TOG-419)." ;;
    *) die "REFUSED: unrecognised policy-comparison result '$verdict'." ;;
  esac
}

# ---------------------------------------------------------------------------
# The pace signal.
read_pace() {
  local out
  if [[ -n "$PACE_SOURCE_CMD" ]]; then
    out="$($PACE_SOURCE_CMD 2>/dev/null)" || return 1
  else
    [[ -r "$QUOTA_PACING_FILE" ]] || return 1
    out="$(grep -v '^[[:space:]]*$' "$QUOTA_PACING_FILE" 2>/dev/null | tail -1)" || return 1
  fi
  [[ -n "$out" ]] || return 1
  printf '%s' "$out" | jq -e . >/dev/null 2>&1 || return 1
  printf '%s' "$out"
}

# Ratio of actual burn to what the remaining week can afford.
#
# Taken across ACCOUNTS, worst-first: the pool is only as healthy as the
# account currently serving traffic, and an account with `burn_per_day: null`
# (no traffic yet) must not average the hot one back down to comfortable. Any
# account whose burn cannot be read is skipped, not treated as zero.
pace_ratio() {
  local sample="$1"
  jq -r --arg target "$PACE_TARGET" '
    [ .accounts[]?
      | select(.burn_per_day != null and .days_left != null and .weekly != null)
      | ($target|tonumber) as $t
      | (($t - .weekly) / (if .days_left <= 0 then 0.0001 else .days_left end)) as $need
      | { name: .name,
          burn: .burn_per_day,
          need: $need,
          ratio: (if $need <= 0 then 999 else (.burn_per_day / $need) end) }
    ] | if length == 0 then empty else (max_by(.ratio)) end
  ' <<<"$sample" 2>/dev/null
}

# The ladder. Each level names the fraction of baseline concurrency a
# brakeable agent keeps. Never a fraction of zero — see cap_for().
#
# RELEASE at ratio <= 1.0 is not "do nothing": it restores baselines, so the
# brake lifting is as automatic as it engaging. The old brake needed an
# operator (or a surviving state file) to lift it.
verdict_for() {
  local r="$1"
  awk -v r="$r" 'BEGIN{
    if (r <= 1.0)      print "RELEASE";
    else if (r <= 2.0) print "LEVEL1";
    else if (r <= 5.0) print "LEVEL2";
    else               print "LEVEL3";
  }'
}

# Desired concurrency for a brakeable agent at a level, given its baseline.
# The floor of 1 is asserted here as well as by the platform: this tool should
# never even PROPOSE a zero, so that a plan is readable as safe without the
# reader having to know the server clamps it.
cap_for() {
  local verdict="$1" baseline="$2"
  awk -v v="$verdict" -v b="$baseline" 'BEGIN{
    if (b < 1) b = 1;
    if (v == "RELEASE")      c = b;
    else if (v == "LEVEL1")  c = (b+1)/2;   # halve, rounding up
    else if (v == "LEVEL2")  c = (b+3)/4;   # quarter, rounding up
    else                     c = 1;         # LEVEL3: one run each, never zero
    c = int(c); if (c < 1) c = 1; if (c > b) c = b;
    print c;
  }'
}

# ---------------------------------------------------------------------------
# Exemptions. Rule 3: read first, and a malformed entry is fatal.
read_exempt() {
  [[ -r "$EXEMPT_FILE" ]] || die "cannot read EXEMPT_FILE=$EXEMPT_FILE"
  local line name reason n=0
  while IFS= read -r line; do
    [[ -z "${line// /}" ]] && continue
    case "$line" in \#*) continue ;; esac
    name="${line%%$'\t'*}"
    reason="${line#*$'\t'}"
    [[ "$reason" != "$line" && -n "${reason// /}" ]] \
      || die "REFUSED: exemption without a reason: '$name' in $EXEMPT_FILE (see the header there)"
    printf '%s\n' "$name"
    n=$((n+1))
  done < "$EXEMPT_FILE"
  (( n > 0 )) || die "REFUSED: $EXEMPT_FILE has no entries. The Chief of Staff must be exempt (TOG-419)."
}

# ---------------------------------------------------------------------------
# The roster.
# TSV: id \t name \t status \t wakeOnDemand \t maxConcurrentRuns \t baseline \t criticalOpenIssues \t runtimeConfig
#
# NOTE the nested path for wakeOnDemand. `runtime_config->>'wakeOnDemand'`
# reads NULL for every agent on this company and would report the entire
# roster healthy; the truth is one level down under 'heartbeat'. Same trap
# documented in queue_liveness.sh rule 1.
#
# The whole `runtime_config` rides along as the LAST column because every write
# is read-modify-write (rule 1) and this is the read half. Last, so that even
# if a value in it somehow carried a separator it could only corrupt itself
# rather than shifting the columns the safety checks depend on. In practice it
# cannot: PostgreSQL renders jsonb on one line and escapes control characters
# inside strings, so a tab in a value arrives as the two characters \t.
roster_sql() {
  cat <<'SQL'
select a.id,
       a.name,
       a.status,
       coalesce(a.runtime_config->'heartbeat'->>'wakeOnDemand', ''),
       coalesce(a.runtime_config->'heartbeat'->>'maxConcurrentRuns', ''),
       coalesce(a.runtime_config->'heartbeat'->'quotaBrake'->>'baseline', ''),
       (select count(*) from issues i
         where i.assignee_agent_id = a.id
           and i.priority = 'critical'
           and i.status in ('todo','in_progress')),
       coalesce(a.runtime_config::text, '{}')
  from agents a
 where a.status <> 'terminated'
 order by a.name;
SQL
}

read_roster() {
  if [[ -n "$ROSTER_SOURCE_CMD" ]]; then
    $ROSTER_SOURCE_CMD 2>/dev/null || return 1
    return 0
  fi
  # shellcheck source=lib/pcsql.sh
  . "$HERE/lib/pcsql.sh" 2>/dev/null || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; return 1; }
  roster_sql | pcsql_run -Atq -v ON_ERROR_STOP=1 -F$'\t' || return 1
}

# ---------------------------------------------------------------------------
# The write path.
apply_patch() {
  local agent_id="$1" cur="$2" body="$3"
  # Rule 1, on the real bytes, at the real edge — after every caller has
  # finished building the body and before anything leaves the process.
  assert_policy_preserved "$cur" "$body"
  if [[ -n "$AGENT_WRITE_CMD" ]]; then
    $AGENT_WRITE_CMD "$agent_id" "$body"
    return $?
  fi
  [[ -n "${PAPERCLIP_ADMIN_TOKEN:-}" ]] \
    || die "no write path: set PAPERCLIP_ADMIN_TOKEN (company-scope agents:configure) or AGENT_WRITE_CMD.
An agent run cannot do this: cross-agent PATCH /api/agents/{id} returns 403 deny_no_grant (measured, TOG-419)."
  local base="${PAPERCLIP_API_URL%/}"; base="${base%/api}"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
      -H "Authorization: Bearer $PAPERCLIP_ADMIN_TOKEN" \
      -H 'Content-Type: application/json' \
      -d "$body" "$base/api/agents/$agent_id")" || return 1
  [[ "$code" == "200" ]] || { echo "  PATCH $agent_id -> HTTP $code" >&2; return 1; }
}

# Build the mutation by editing the CURRENT config, never by composing a fresh
# one. `runtimeConfig` is replaced wholesale by the API, so anything omitted
# here is deleted from the agent — including `modelProfiles`, which several
# agents on this company carry alongside `heartbeat`. Two keys change; every
# other byte is carried through untouched.
brake_body() {
  local cur="$1" cap="$2" baseline="$3" verdict="$4"
  jq -nc --argjson cur "$cur" --argjson cap "$cap" --argjson baseline "$baseline" --arg v "$verdict" '
    { runtimeConfig: ( $cur
        | .heartbeat = ( (.heartbeat // {}) + {
            maxConcurrentRuns: $cap,
            quotaBrake: { baseline: $baseline, level: $v, tool: "quota_brake.sh" }
          } ) ) }'
}

restore_body() {
  local cur="$1" baseline="$2"
  # `del(.quotaBrake)` truly removes the marker rather than nulling it, so a
  # restored agent is byte-indistinguishable from one that was never braked
  # and the next `plan` captures a fresh baseline honestly. Leaving a null
  # behind would work today (the baseline reads empty either way) and would
  # quietly become a second, undocumented "was braked once" state.
  jq -nc --argjson cur "$cur" --argjson baseline "$baseline" '
    { runtimeConfig: ( $cur
        | .heartbeat = ( (.heartbeat // {})
            | .maxConcurrentRuns = $baseline
            | del(.quotaBrake) ) ) }'
}

# ---------------------------------------------------------------------------
# plan / apply share all of their logic; `apply` is `plan` with writes on.
do_plan() {
  local write="$1" explain="$2"
  need jq; need awk

  local sample worst ratio verdict
  sample="$(read_pace)" || unknown "cannot read the pace signal (PACE_SOURCE_CMD or $QUOTA_PACING_FILE). Nothing braked, nothing restored."
  worst="$(pace_ratio "$sample")"
  [[ -n "$worst" ]] || unknown "pace sample has no account with a readable burn_per_day. Refusing to guess."
  ratio="$(jq -r '.ratio' <<<"$worst")"
  verdict="$(verdict_for "$ratio")"

  local roster
  roster="$(read_roster)" || unknown "cannot read the roster. Nothing braked, nothing restored."
  [[ -n "$roster" ]] || unknown "roster came back empty. Zero agents examined is not zero agents needing a brake."

  if [[ "$explain" == yes ]]; then
    {
      echo "  pace account : $(jq -r '.name' <<<"$worst")"
      echo "  burn/day     : $(jq -r '.burn' <<<"$worst")"
      echo "  sustainable  : $(jq -r '.need' <<<"$worst")   [(${PACE_TARGET} - weekly) / days_left]"
      echo "  ratio        : $ratio"
      echo "  verdict      : $verdict"
      echo "  exempt file  : $EXEMPT_FILE"
    } >&2
  fi

  # NOT `mapfile -t exempt < <(read_exempt)`. Process substitution runs
  # read_exempt in a SUBSHELL, so its `die` on a malformed or empty exemption
  # file would exit that subshell only — the parent would sail on with an
  # empty array and brake the Chief of Staff. The refusal has to be able to
  # reach this process, so take it through a command substitution whose exit
  # status this shell actually sees.
  local exempt_raw; local -a exempt=()
  exempt_raw="$(read_exempt)" || exit 2
  mapfile -t exempt <<<"$exempt_raw"

  # An exemption that matches nothing is REPORTED. A typo in that file must
  # never read as a successful exemption — the two Chief-of-Staff names on
  # this company differ only in case and suffix.
  local e found
  for e in "${exempt[@]}"; do
    found=no
    while IFS= read -r rname; do [[ "$rname" == "$e" ]] && { found=yes; break; }; done \
      < <(printf '%s\n' "$roster" | cut -d$'\t' -f2)
    [[ "$found" == yes ]] || printf 'exempt-entry-unmatched\t\t%s\t\t\t\tno agent on the roster has this exact name\n' "$e"
  done

  local id name status wod mcr baseline crit cfg
  local rc=0 line
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    # NOT `IFS=$'\t' read`. Tab is IFS whitespace, so bash collapses runs of it
    # and an empty leading field shifts every column left — and `wakeOnDemand`
    # unset (empty) is the single most common case on this roster. Translate to
    # a non-whitespace separator first so empty fields survive. Same trap as
    # queue_liveness.sh.
    IFS=$'\x1f' read -r id name status wod mcr baseline crit cfg <<<"${line//$'\t'/$'\x1f'}"
    crit="${crit:-0}"
    [[ "$mcr" =~ ^[0-9]+$ ]] || mcr=2      # platform default when unset

    # --- rule 3: exempt agents never enter the candidate set ---------------
    local is_exempt=no
    for e in "${exempt[@]}"; do [[ "$name" == "$e" ]] && { is_exempt=yes; break; }; done
    if [[ "$is_exempt" == yes ]]; then
      printf 'exempt\t%s\t%s\t%s\t%s\t%s\tnamed in %s\n' "$id" "$name" "$mcr" "$mcr" "${baseline:--}" "$(basename "$EXEMPT_FILE")"
      continue
    fi
    # Priority-aware: an agent holding an open `critical` issue is exempt for
    # as long as it holds one. Braking the response to a critical is the same
    # category of mistake as braking the owner's channel, just less visible.
    if (( crit > 0 )); then
      printf 'exempt\t%s\t%s\t%s\t%s\t%s\tholds %s open critical issue(s)\n' "$id" "$name" "$mcr" "$mcr" "${baseline:--}" "$crit"
      continue
    fi
    # A paused/terminated agent runs nothing, so braking it saves nothing and
    # only leaves residue to clean up later — which is precisely the residue
    # still on this roster from the old brake.
    if [[ "$status" != "idle" && "$status" != "running" && "$status" != "error" ]]; then
      printf 'skip\t%s\t%s\t%s\t%s\t%s\tstatus=%s consumes no quota\n' "$id" "$name" "$mcr" "$mcr" "${baseline:--}" "$status"
      continue
    fi

    # Fail closed on an unreadable config, but only for agents that have
    # survived every exemption above and could therefore actually be written
    # to. Checking earlier would report an exempt agent as `skip/unreadable`,
    # which reads as "the brake could not evaluate the Chief of Staff" when the
    # truth is that it is exempt and was never a candidate — the one line in
    # this output nobody can afford to misread.
    if ! jq -e . >/dev/null 2>&1 <<<"${cfg:-}"; then
      printf 'skip\t%s\t%s\t%s\t%s\t%s\truntimeConfig unreadable; refusing to write a partial config\n' \
        "$id" "$name" "$mcr" "$mcr" "${baseline:--}"
      continue
    fi

    # --- rule 2: capture the baseline ONCE ---------------------------------
    local eff_baseline
    if [[ "$baseline" =~ ^[0-9]+$ ]]; then
      eff_baseline="$baseline"            # already braked: trust the record, never re-capture
    else
      eff_baseline="$mcr"                 # not braked: current value IS normal
    fi

    local want; want="$(cap_for "$verdict" "$eff_baseline")"

    if [[ "$verdict" == "RELEASE" ]]; then
      if [[ "$baseline" =~ ^[0-9]+$ ]]; then
        printf 'restore\t%s\t%s\t%s\t%s\t%s\tburn is at or under pace\n' "$id" "$name" "$mcr" "$eff_baseline" "$eff_baseline"
        if [[ "$write" == yes ]]; then
          apply_patch "$id" "$cfg" "$(restore_body "$cfg" "$eff_baseline")" || rc=1
        fi
      else
        printf 'nochange\t%s\t%s\t%s\t%s\t-\tnot braked, burn under pace\n' "$id" "$name" "$mcr" "$mcr"
      fi
      continue
    fi

    if [[ "$want" == "$mcr" && "$baseline" =~ ^[0-9]+$ ]]; then
      printf 'nochange\t%s\t%s\t%s\t%s\t%s\talready at the %s cap\n' "$id" "$name" "$mcr" "$want" "$eff_baseline" "$verdict"
      continue
    fi

    printf 'brake\t%s\t%s\t%s\t%s\t%s\t%s: %s of baseline\n' "$id" "$name" "$mcr" "$want" "$eff_baseline" "$verdict" "$want/$eff_baseline"
    if [[ "$write" == yes ]]; then
      apply_patch "$id" "$cfg" "$(brake_body "$cfg" "$want" "$eff_baseline" "$verdict")" || rc=1
    fi
  done < <(printf '%s\n' "$roster")

  return $rc
}

cmd_plan() {
  local explain=no
  while [[ $# -gt 0 ]]; do
    case "$1" in --explain) explain=yes; shift;; *) die "unknown argument: $1";; esac
  done
  do_plan no "$explain"
}

cmd_apply() {
  local yes=no explain=no
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes) yes=yes; shift;;
      --explain) explain=yes; shift;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ "$yes" == yes ]] || die "apply needs --yes. Run \`plan\` first and read it; this tool is dry-run by default."
  do_plan yes "$explain"
}

# ---------------------------------------------------------------------------
# restore — rule 2's payoff. Reads the baseline out of each agent's OWN record,
# so it works from a cold start with no memory of having braked. This is the
# subcommand the old design could not have: its restore list lived in a file
# on the operator's host and a crash between throttle and restore stranded
# every agent in it.
cmd_restore() {
  local yes=no
  while [[ $# -gt 0 ]]; do
    case "$1" in --yes) yes=yes; shift;; *) die "unknown argument: $1";; esac
  done
  need jq
  local roster; roster="$(read_roster)" || unknown "cannot read the roster; restored nothing."
  [[ -n "$roster" ]] || unknown "roster empty; restored nothing."

  local id name status wod mcr baseline crit cfg rc=0 line n=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    IFS=$'\x1f' read -r id name status wod mcr baseline crit cfg <<<"${line//$'\t'/$'\x1f'}"
    [[ "$baseline" =~ ^[0-9]+$ ]] || continue
    jq -e . >/dev/null 2>&1 <<<"${cfg:-}" || { echo "  SKIP $name: runtimeConfig unreadable" >&2; rc=1; continue; }
    n=$((n+1))
    printf 'restore\t%s\t%s\t%s\t%s\n' "$id" "$name" "$mcr" "$baseline"
    if [[ "$yes" == yes ]]; then
      apply_patch "$id" "$cfg" "$(restore_body "$cfg" "$baseline")" || rc=1
    fi
  done < <(printf '%s\n' "$roster")
  echo "restorable: $n" >&2
  [[ "$yes" == yes ]] || echo "(dry run — pass --yes to write)" >&2
  return $rc
}

# ---------------------------------------------------------------------------
# verify — the acceptance check the issue asks for: "query wakeOnDemand across
# the roster while the brake is engaged".
#
# Exit 3 if ANY non-terminated agent is unwakeable. This is the invariant the
# owner stated as hard, so it gets its own subcommand that can be run
# independently of the brake and wired into a monitor.
cmd_verify() {
  local roster; roster="$(read_roster)" || unknown "cannot read the roster. This is NOT a pass."
  [[ -n "$roster" ]] || unknown "roster empty. Zero unwakeable out of zero examined is 'never ran', not 'clean'."

  local id name status wod mcr baseline crit cfg line total=0 bad=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    IFS=$'\x1f' read -r id name status wod mcr baseline crit cfg <<<"${line//$'\t'/$'\x1f'}"
    total=$((total+1))
    # Only `false` is a violation. Unset means the platform default applies,
    # and that default is TRUE — `asBoolean(heartbeat.wakeOnDemand ?? ..., true)`
    # at services/heartbeat.ts:12125. Verified in source rather than assumed,
    # because the top-level path reads unset for this whole company.
    if [[ "$wod" == "false" ]]; then
      bad=$((bad+1))
      printf 'UNWAKEABLE\t%s\t%s\tstatus=%s\n' "$id" "$name" "$status"
    fi
  done < <(printf '%s\n' "$roster")

  echo "examined: $total   unwakeable: $bad" >&2
  if (( bad > 0 )); then
    echo "VIOLATION: the brake must never leave an agent unwakeable (TOG-419)." >&2
    return 3
  fi
  echo "OK: every non-terminated agent is wakeable." >&2
  return 0
}

# ---------------------------------------------------------------------------
# refusals — RULE 4 and the issue's "any refusal is loud" requirement.
#
# The platform already records every dropped wake and nobody reads it: 58,780
# rows of reason=heartbeat.wakeOnDemand.disabled in three days, and the
# owner's own task refused 68 times in 17 minutes with nothing turning red.
# This does not add a detector. It turns the rows that already exist into a
# NUMBER and a non-zero exit, which is the difference between a log line and a
# metric.
refusal_sql() {
  cat <<SQL
select w.reason,
       coalesce(a.name,'(unknown)'),
       count(*)
  from agent_wakeup_requests w
  left join agents a on a.id = w.agent_id
 where w.status = 'skipped'
   and w.created_at > now() - interval '$REFUSAL_WINDOW_MIN minutes'
   and w.reason in ('heartbeat.wakeOnDemand.disabled',
                    'heartbeat.daily_run_limit',
                    'heartbeat.daily_cost_limit')
 group by 1,2
 order by 3 desc;
SQL
}

read_refusals() {
  if [[ -n "$REFUSAL_SOURCE_CMD" ]]; then
    $REFUSAL_SOURCE_CMD 2>/dev/null || return 1
    return 0
  fi
  # shellcheck source=lib/pcsql.sh
  . "$HERE/lib/pcsql.sh" 2>/dev/null || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; return 1; }
  refusal_sql | pcsql_run -Atq -v ON_ERROR_STOP=1 -F$'\t' || return 1
}

cmd_refusals() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since-min) REFUSAL_WINDOW_MIN="$2"; shift 2;;
      --threshold) REFUSAL_ALARM_THRESHOLD="$2"; shift 2;;
      *) die "unknown argument: $1";;
    esac
  done
  local rows
  # An unreachable source is exit 5, never exit 0. A refusal monitor that
  # reads quiet while blind is the exact failure it exists to catch.
  rows="$(read_refusals)" || unknown "cannot read agent_wakeup_requests. This is NOT 'no refusals'."

  local reason name n line total=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    IFS=$'\x1f' read -r reason name n <<<"${line//$'\t'/$'\x1f'}"
    [[ "$n" =~ ^[0-9]+$ ]] || continue
    printf '%s\t%s\t%s\n' "$reason" "$name" "$n"
    total=$((total+n))
  done < <(printf '%s\n' "$rows")

  echo "refused wakes in the last ${REFUSAL_WINDOW_MIN}m: $total (threshold $REFUSAL_ALARM_THRESHOLD)" >&2
  if (( total >= REFUSAL_ALARM_THRESHOLD )); then
    echo "ALARM: wakes are being discarded. Every one of these is a task nobody is working on." >&2
    return 3
  fi
  return 0
}

# Sourcing seam for the suite. The safety guards here are pure functions over
# JSON, and they are the part that must never regress — so the suite tests them
# DIRECTLY with hand-built bodies rather than only through whatever bodies the
# planner happens to produce today. A guard exercised solely via its caller is
# only ever tested against inputs the caller already gets right, which is the
# opposite of what a guard is for.
if [[ -n "${QUOTA_BRAKE_LIB_ONLY:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi

case "${1:-plan}" in
  plan)     shift || true; cmd_plan "$@";;
  apply)    shift; cmd_apply "$@";;
  restore)  shift; cmd_restore "$@";;
  verify)   shift || true; cmd_verify "$@";;
  refusals) shift; cmd_refusals "$@";;
  -h|--help|help) usage;;
  *) usage; exit 2;;
esac
