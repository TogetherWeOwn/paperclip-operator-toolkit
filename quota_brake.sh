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
# and exact to four decimals on three consecutive samples. The arithmetic below
# is shown at 0.97 because that is the PRODUCER's target, and those logged
# values were computed at it — ours is now 0.90 (see below), so the two
# deliberately differ and it is the IDENTITY being checked here, not the value:
#
#     sustainable_per_day = (TARGET - weekly_used) / days_left      TARGET=0.97
#
#     (0.97-0.61)/4.04 = 0.08911   logged 0.0891
#     (0.97-0.61)/4.03 = 0.08933   logged 0.0893
#     (0.97-0.62)/4.02 = 0.08706   logged 0.0870
#
# That day's value is ~0.087 — BELOW the quoted band, so a brake pinned to
# 0.09 would run persistently hot and never catch up.
#
# ---------------------------------------------------------------------------
# PACE_TARGET IS A RESERVE, NOT A TARGET.  (TOG-490, decided by the CFO.)
# `1 - PACE_TARGET` is the margin the brake defends. It is sized against the
# brake's own reaction lag, NOT against a view of how much of a paid-for
# subscription this company ought to consume. Two measured facts fix that
# framing, and both are the opposite of what this header used to say:
#
#  * THIS KNOB CANNOT RAISE CONSUMPTION, ONLY LOWER IT. cap_for() clamps every
#    rung to the captured baseline (`if (c > b) c = b`) and RELEASE restores it
#    exactly. No level runs faster than normal, so moving TARGET toward 1.0
#    buys zero extra utilisation — it only removes reserve. If this company is
#    ever UNDERrunning its quota, the fix is queue depth, never this number.
#
#  * A CAP-HIT WASTES NO QUOTA — IT IS 100% UTILISATION. Nothing is destroyed
#    at reset because nothing is left. Overshooting costs DELIVERY: a dark
#    window in which nothing runs, wakes destroyed rather than queued (a quota
#    429 is not retried, and quota returning does not restart the company), and
#    a restart somebody has to do by hand. Measured 2026-08-25T18:30Z: the pool
#    was at weekly=0.96 with 3.65d to reset — a 3.58d dark window, half a week.
#
# So the reserve covers the lag between "the brake decides" and "burn actually
# falls": one producer sample (~15 min) plus the drain of runs already in
# flight (23 at 17:45Z), which do NOT stop when maxConcurrentRuns drops. The
# largest 1h move in `weekly` across the 224-sample history is 0.140 / 0.150 by
# account. At that rate a 0.03 reserve is 13 MINUTES — inside one detection
# interval, i.e. thinner than the brake can see. 0.10 is ~43 min at the
# measured peak and ~4.3h at the sustained burn, which brackets the exposure
# across the rates this company actually produces.
#
# TARGET is therefore 0.90. Replayed over the history it is indistinguishable
# from 0.97 early in the week (24 RELEASE against 24 on 08-23) and bites only
# on a week already running at double pace. The per-day table, the cost
# asymmetry and the ONE measurement that would move this number again are in
# docs/quota-brake.md, "The line being defended".
# ===========================================================================
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# --- test seams -------------------------------------------------------------
# Same convention as LIVENESS_SOURCE_CMD in queue_liveness.sh and
# REQUEST_NOTIFY_CMD in the queue suites: the three things that need a
# database, a host file or a credential are injectable, which is what lets the
# suite run in CI with none of them.
PACE_SOURCE_CMD="${PACE_SOURCE_CMD:-}"      # stdout: pace samples, one JSON object per line
ROSTER_SOURCE_CMD="${ROSTER_SOURCE_CMD:-}"  # stdout: roster TSV (see read_roster)
AGENT_WRITE_CMD="${AGENT_WRITE_CMD:-}"      # argv: <agent_id> <json_body>
REFUSAL_SOURCE_CMD="${REFUSAL_SOURCE_CMD:-}" # stdout: refusal TSV

QUOTA_PACING_FILE="${QUOTA_PACING_FILE:-/paperclip/operator-handoff/quota-pacing.jsonl}"
EXEMPT_FILE="${EXEMPT_FILE:-$HERE/quota_brake_exempt.txt}"
PACE_TARGET="${PACE_TARGET:-0.90}"   # a RESERVE of 0.10; see the header (TOG-490)
REFUSAL_WINDOW_MIN="${REFUSAL_WINDOW_MIN:-15}"
REFUSAL_ALARM_THRESHOLD="${REFUSAL_ALARM_THRESHOLD:-10}"

# --- the derivation window (TOG-440) ----------------------------------------
# 24h, not 12h, and the reason is arithmetic rather than taste. `weekly` is
# emitted rounded to 0.01, so a rate derived over dt days cannot resolve finer
# than 0.01/dt per day. Against today's sustainable burn (0.0270/day) that is:
#
#      2h  0.1195/day = 4.42x sustainable   <- coarser than the entire ladder
#      6h  0.0399/day = 1.48x               <- wider than the whole LEVEL1 band
#     12h  0.0199/day = 0.74x
#     24h  0.0100/day = 0.37x               <- first window that resolves rung 1
#     48h  0.0052/day = 0.19x
#
# The ladder's tightest decision is RELEASE|LEVEL1 at ratio 1.0. Below 24h the
# quantization error alone can carry a sample across it, so a shorter window
# does not measure faster, it measures noise faster. Measured level FLIPS over
# the 218-sample history agree: 26 flips at 2h against 13 at 24h for the busy
# account — and every flip is a PATCH against every brakeable agent.
# `quota_burn_derive.py --sweep` reprints this table against current data.
PACE_WINDOW_HOURS="${PACE_WINDOW_HOURS:-24}"

# Below this span the window is declared too short to derive from and the
# reported field is used instead — LABELLED, never silently. 2h is one
# quantum-step's worth of signal; anything shorter is pure rounding.
PACE_MIN_WINDOW_HOURS="${PACE_MIN_WINDOW_HOURS:-2}"

# `weekly` returns to ~0 at the weekly reset. A window spanning one yields a
# large NEGATIVE delta, which would read as "burning nothing" at exactly the
# moment a fresh week starts. Any drop bigger than this truncates the window at
# the reset. 0.2 is far above the 0.01 rounding jitter that shows up as a real
# -0.01 step in the history (2026-08-25T10:44:23Z) and far below a reset, which
# drops the full week's usage at once.
PACE_RESET_DROP="${PACE_RESET_DROP:-0.2}"

# Bound the read so a year-old pacing file cannot turn `plan` into a full-file
# parse. 2000 samples at the producer's 15-minute cadence is ~20 days, which is
# three weekly resets — comfortably more than any window can use.
PACE_MAX_LINES="${PACE_MAX_LINES:-2000}"

# When set, a plan that could not DERIVE its burn exits 5 UNKNOWN instead of
# falling back to the reported field. Off by default so a freshly-rotated
# pacing file still brakes; on for the monitor path, where "I braked on the
# field TOG-440 measured as wrong" must not read as a measurement.
PACE_REQUIRE_DERIVED="${PACE_REQUIRE_DERIVED:-}"

die() { echo "ERROR: $*" >&2; exit 2; }
unknown() { echo "UNKNOWN: $*" >&2; exit 5; }

usage() {
  cat <<'EOF'
quota_brake.sh — hold weekly quota to pace without ever disabling an agent.

  plan      [--explain] [--require-derived]   the concurrency plan (0 ok, 5 unmeasured)
  apply     --yes [--explain] [--require-derived]   apply it   (0 ok, 2 refused, 5 unmeasured)
  restore   --yes              return every braked agent to baseline (state-free)
  verify                       assert no agent is unwakeable  (0 ok, 3 VIOLATION, 5 unmeasured)
  refusals  [--since-min N]    the loud metric                (0 quiet, 3 ALARM, 5 unmeasured)
  throttled [--out FILE]       export the braked set as JSON  (0 ok, 5 unmeasured)
  pace                         the burn reading as JSON, and where it came from

`plan` is the default and NOTHING WRITES WITHOUT --yes. `throttled` is a read;
`--out` writes only the export file it is given, never an agent.

Burn is DERIVED from the trailing `weekly` series, not read from the producer's
`burn_per_day` field — see the TOG-440 block above read_pace_window(). Every
reading carries a `source`: `derived` (measured) or `reported` (fallback).
`--require-derived` turns a fallback into exit 5 instead of a brake.

Environment:
  PACE_SOURCE_CMD / ROSTER_SOURCE_CMD / AGENT_WRITE_CMD / REFUSAL_SOURCE_CMD
                            test seams; override the four impure edges
  QUOTA_PACING_FILE         pace samples (default /paperclip/operator-handoff/quota-pacing.jsonl)
  EXEMPT_FILE               agents never braked (default ./quota_brake_exempt.txt)
  PACE_TARGET               weekly-quota line the brake defends (default 0.90;
                            1-PACE_TARGET is a reserve, not a shortfall)
  PACE_WINDOW_HOURS         trailing window the burn is derived over (default 24)
  PACE_MIN_WINDOW_HOURS     below this, fall back to the reported field (default 2)
  PACE_RESET_DROP           `weekly` drop that counts as a week reset (default 0.2)
  PACE_MAX_LINES            most pacing lines read (default 2000, ~20 days)
  PACE_REQUIRE_DERIVED      set to refuse a reported-field fallback
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
# THE PACE SIGNAL — A WINDOW, NOT A LINE. (TOG-440.)
#
# This used to be `tail -1`, and the brake keyed on the producer's
# `burn_per_day` field in that one line. That field is not a rate over a
# window. Measured across a 219-sample snapshot of the real pacing file,
# 2026-08-23T18:51:04Z -> 2026-08-25T17:18:13Z:
#
#  * IT REPORTS BURN ON AN ACCOUNT THAT IS BURNING NOTHING. 2026-08-25 11:59Z
#    to 14:30Z, `weekly` is FLAT at 0.86 — zero consumption for two and a half
#    hours — while `burn_per_day` decays 0.9568, 0.6383, 0.4788, 0.3827,
#    0.3190, 0.2733, 0.2392, 0.2126, 0.1914, 0.1741, 0.1595. A fixed numerator
#    over a growing elapsed time: cumulative-since-an-anchor, not a rate. Every
#    one of those ten idle samples selected LEVEL2 or LEVEL3.
#  * IT IS UNSTABLE BETWEEN ADJACENT SAMPLES. 0.6381 at 09:29Z and 3.8355 at
#    09:44Z, a 6x jump on a `weekly` delta of +0.04.
#  * AND IT IS OFTEN ABSENT: null on 203 of 438 account-samples (46%), and on
#    75 of the 219 rows (34%) NO account had a readable value at all — the
#    whole tail from 14:45Z to 17:00Z, among others. `pace_ratio` returned
#    empty on every one of those, so the brake exited 5 UNKNOWN and did
#    nothing. A third of the time the brake was not braking, it was blind.
#    THIS, not the 7.4x overstatement in TOG-440, is the field's worst defect:
#    an overstatement still brakes, an absence does not.
#
# Replayed over the same snapshot (`quota_burn_derive.py --series`), the level
# the reported field selects agrees with the derived level on 73 of 235
# comparable account-samples — 31%. And on the second account the reported
# field never once selected LEVEL1 or LEVEL2: its distribution is bimodal,
# RELEASE (64) or LEVEL3 (28), so half the ladder was unreachable through it.
# That is the exposure TOG-440 describes — moderate burn cannot be answered
# with a moderate brake if the input never reports moderate burn.
#
# `weekly` is what the ACCOUNT reports and what the cap is enforced against, so
# the difference of two `weekly` readings over a known interval IS the burn,
# with no producer logic in between. Derived that way the series integrates
# back to `weekly` exactly (err 0.000000 over 46.4h, both accounts).
read_pace_window() {
  local out
  if [[ -n "$PACE_SOURCE_CMD" ]]; then
    # The seam may emit one object or many lines; both are a window.
    out="$($PACE_SOURCE_CMD 2>/dev/null)" || return 1
  else
    [[ -r "$QUOTA_PACING_FILE" ]] || return 1
    out="$(grep -v '^[[:space:]]*$' "$QUOTA_PACING_FILE" 2>/dev/null | tail -n "$PACE_MAX_LINES")" || return 1
  fi
  [[ -n "$out" ]] || return 1
  # A partially-flushed tail line is normal on a file the producer appends to,
  # so drop unparseable lines rather than failing the whole read — but the
  # window is only usable if SOMETHING parsed.
  out="$(jq -c . <<<"$out" 2>/dev/null)" || true
  [[ -n "$out" ]] || return 1
  printf '%s' "$out"
}

# The latest snapshot out of a window. Kept as its own function because
# "current weekly / days_left / account list" and "burn over time" are two
# different questions and only the second one needs history.
read_pace() {
  local w; w="$(read_pace_window)" || return 1
  printf '%s' "$w" | tail -1
}

# Ratio of actual burn to what the remaining week can afford.
#
# Taken across ACCOUNTS, worst-first: the pool is only as healthy as the
# account currently serving traffic, and an idle account must not average the
# hot one back down to comfortable. An account whose burn can be neither
# derived nor read is SKIPPED, never treated as zero.
#
# Emits one object with an explicit `source`:
#   derived   — burn = Δweekly / Δt over the trailing window. A measurement.
#   reported  — burn = the producer's `burn_per_day`. A fallback, used only
#               when the window is too short to derive from, and labelled here
#               so that do_plan can warn on it and --require-derived can refuse
#               it. A silent fallback is indistinguishable from a measurement,
#               which is the whole reason this field exists.
# `reason` says which of the three fallback conditions fired, so "why did it
# not derive" is answerable from the output rather than by re-deriving by hand.
pace_ratio() {
  local window="$1"
  jq -s -r \
    --arg target "$PACE_TARGET" \
    --arg win "$PACE_WINDOW_HOURS" \
    --arg minwin "$PACE_MIN_WINDOW_HOURS" \
    --arg drop "$PACE_RESET_DROP" '
    ($target|tonumber) as $t
    | ($win|tonumber)    as $w
    | ($minwin|tonumber) as $mw
    | ($drop|tonumber)   as $rd
    | (map(select(type == "object")) | sort_by(.ts // "")) as $rows
    | ($rows | last)     as $now
    | if ($now | type) != "object" then empty else
      [ $now.accounts[]?
        | select(.days_left != null and .weekly != null)
        | . as $acc
        # The per-account weekly series, oldest first, restricted to rows that
        # actually carry a parseable ts. A fixture with no ts (the pre-TOG-440
        # single-sample shape) yields a one-element series and therefore the
        # labelled `reported` fallback — old inputs keep working, and they say
        # out loud that they were not measured.
        | [ $rows[]
            | select(.ts != null)
            | { ts: (try (.ts | fromdateiso8601) catch null),
                weekly: ( [ .accounts[]? | select(.name == $acc.name) | .weekly ][0] ) }
            | select(.ts != null and .weekly != null) ] as $series
        # RESET TRUNCATION. Walk back from the newest sample and stop at the
        # first step where `weekly` DROPS by more than $rd — that is the week
        # rolling over, and pairing across it reads a fresh week as an idle
        # one. Small negative steps are rounding and must not truncate.
        | ( [ range(1; ($series|length))
              | select($series[.].weekly < ($series[. - 1].weekly - $rd)) ] | last // 0 ) as $floor
        | $series[$floor:] as $week
        # `// 0` on every timestamp read below, not for tidiness: jq binds an
        # `as` expression EAGERLY, so on a ts-less fixture (the pre-TOG-440
        # single-sample shape, still used by callers and by the suite) an
        # unguarded `$end.ts - ...` raises "null and number cannot be
        # subtracted" and takes the whole reading down before the
        # `($week|length) < 2` branch below ever gets to choose the fallback.
        | ($week | last) as $end
        | ( [ $week[] | select(.ts <= (($end.ts // 0) - ($w * 3600))) ] | last ) as $cut
        # No sample old enough for the full window? Use the oldest sample still
        # in this week — a partial window is still a measurement, it is just a
        # shorter one, and $mw below decides whether it is long enough.
        | ( if $cut != null then $cut else ($week | first) end ) as $start
        | ((($end.ts // 0) - ($start.ts // 0)) / 86400.0) as $dt_days
        | (($t - $acc.weekly) / (if $acc.days_left <= 0 then 0.0001 else $acc.days_left end)) as $need
        | ( if ($week | length) < 2 then
              { source: "reported", reason: "only one sample in this week; nothing to difference against" }
            elif $dt_days <= 0 then
              { source: "reported", reason: "window has no elapsed time" }
            elif (($dt_days * 24) < $mw) then
              { source: "reported",
                reason: "window spans \(($dt_days * 24 * 100 | round) / 100)h, under the \($mw)h minimum" }
            else
              # NEGATIVE CLAMP. `weekly` is rounded to 0.01, so a flat account
              # can step -0.01 and derive a negative rate. Negative burn is not
              # a thing; report 0 and keep the raw delta visible so the clamp
              # is inspectable rather than silent.
              { source: "derived",
                reason: "\(($dt_days * 24 * 100 | round) / 100)h, \($week|length) samples",
                burn: ( [ 0, (($end.weekly - $start.weekly) / $dt_days) ] | max ),
                dweekly: ($end.weekly - $start.weekly),
                window_h: (($dt_days * 24 * 100 | round) / 100),
                resolution: ((0.01 / $dt_days * 10000 | round) / 10000) }
            end ) as $d
        | ( if $d.source == "derived" then $d.burn else $acc.burn_per_day end ) as $burn
        | select($burn != null)
        | { name: $acc.name,
            burn: $burn,
            need: $need,
            ratio: (if $need <= 0 then 999 else ($burn / $need) end),
            source: $d.source,
            reason: $d.reason,
            weekly: $acc.weekly,
            dweekly: ($d.dweekly // null),
            window_h: ($d.window_h // null),
            resolution: ($d.resolution // null) }
      ] | if length == 0 then empty else (max_by(.ratio)) end
      end
  ' <<<"$window" 2>/dev/null
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
  local write="$1" explain="$2" require_derived="${3:-no}"
  need jq; need awk

  local window worst ratio verdict source
  window="$(read_pace_window)" || unknown "cannot read the pace signal (PACE_SOURCE_CMD or $QUOTA_PACING_FILE). Nothing braked, nothing restored."
  worst="$(pace_ratio "$window")"
  [[ -n "$worst" ]] || unknown "no account in the pace window has a burn that can be derived from \`weekly\` or read from \`burn_per_day\`. Refusing to guess."
  ratio="$(jq -r '.ratio' <<<"$worst")"
  source="$(jq -r '.source' <<<"$worst")"
  verdict="$(verdict_for "$ratio")"

  # RULE 5 (TOG-440): A FALLBACK IS NOT A MEASUREMENT, AND MUST NOT LOOK LIKE
  # ONE. `burn_per_day` was measured to disagree with the derived level on 162
  # of 235 comparable samples (69%) and to sit at null on 46% of them. When the
  # brake has had to fall back to it, that is stated on every run — not only
  # under --explain, because the operator who most needs to know is the one who
  # did not ask for detail. --require-derived turns it into exit 5.
  if [[ "$source" != "derived" ]]; then
    if [[ -n "$PACE_REQUIRE_DERIVED" || "$require_derived" == yes ]]; then
      unknown "burn could not be DERIVED ($(jq -r '.reason' <<<"$worst")) and --require-derived is set. Nothing braked, nothing restored."
    fi
    echo "WARNING: burn was NOT derived — falling back to the reported burn_per_day field." >&2
    echo "         reason: $(jq -r '.reason' <<<"$worst")" >&2
    echo "         That field overstated burn and disagreed with the measured level on 69% of" >&2
    echo "         historical samples (TOG-440). Treat this plan as an estimate." >&2
  fi

  local roster
  roster="$(read_roster)" || unknown "cannot read the roster. Nothing braked, nothing restored."
  [[ -n "$roster" ]] || unknown "roster came back empty. Zero agents examined is not zero agents needing a brake."

  if [[ "$explain" == yes ]]; then
    {
      echo "  pace account : $(jq -r '.name' <<<"$worst")"
      echo "  burn/day     : $(jq -r '.burn' <<<"$worst")"
      echo "  burn source  : $source   ($(jq -r '.reason' <<<"$worst"))"
      if [[ "$source" == "derived" ]]; then
        echo "  dweekly      : $(jq -r '.dweekly' <<<"$worst") over $(jq -r '.window_h' <<<"$worst")h"
        # The resolution is printed next to the ratio on purpose: a ratio of
        # 1.1 means something different when the reading is +/-0.4 wide than
        # when it is +/-0.05, and the RELEASE|LEVEL1 rung sits at 1.0.
        echo "  resolution   : +/-$(jq -r '.resolution' <<<"$worst")/day (weekly is rounded to 0.01)"
      fi
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
  local explain=no derived=no
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --explain) explain=yes; shift;;
      --require-derived) derived=yes; shift;;
      *) die "unknown argument: $1";;
    esac
  done
  do_plan no "$explain" "$derived"
}

cmd_apply() {
  local yes=no explain=no derived=no
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes) yes=yes; shift;;
      --explain) explain=yes; shift;;
      --require-derived) derived=yes; shift;;
      *) die "unknown argument: $1";;
    esac
  done
  [[ "$yes" == yes ]] || die "apply needs --yes. Run \`plan\` first and read it; this tool is dry-run by default."
  do_plan yes "$explain" "$derived"
}

# ---------------------------------------------------------------------------
# pace — the burn reading on its own, as JSON, on STDOUT.
#
# Two jobs. First, a monitor needs the `source` field on a machine-readable
# surface: the warning in do_plan goes to stderr, which is exactly where an
# automated caller drops it. Second, this is the shape
# `test_quota_burn_derive.sh` diffs against `quota_burn_derive.py --json`, so
# the shell derivation and the Python one cannot drift apart without a red
# test — two implementations of one formula is the price of the production
# path needing only bash+jq while the analysis path needs to replay history.
cmd_pace() {
  need jq
  local window worst
  window="$(read_pace_window)" || unknown "cannot read the pace signal (PACE_SOURCE_CMD or $QUOTA_PACING_FILE)."
  worst="$(pace_ratio "$window")"
  [[ -n "$worst" ]] || unknown "no account in the pace window has a derivable or readable burn."
  jq -c --arg v "$(verdict_for "$(jq -r '.ratio' <<<"$worst")")" '. + {verdict: $v}' <<<"$worst"
  [[ "$(jq -r '.source' <<<"$worst")" == "derived" ]] || return 4
  return 0
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
# throttled — the export TOG-401 asked for, from the source TOG-419 created.
#
# TOG-401 was filed against the OLD brake, which disabled agents and kept its
# restore list in `~/.paperclip/quota-pacer-throttled.json` on the operator's
# host. Nothing in an agent container could read that file, so `throttled` and
# `disabled` were indistinguishable and `queue_liveness.sh` had to report
# `undetermined` for every dormant agent on the board.
#
# The issue offered two fixes and preferred the second: "the pacer recording
# the CAUSE on the record that already exists rather than in a second source
# that has to be joined." Rule 2 of this tool did exactly that for a different
# reason — the baseline had to survive a crash, so it went into the agent's own
# `runtime_config.heartbeat.quotaBrake`. That makes the throttled set already
# durable, already per-agent, and already readable by anything that can read an
# agent. This subcommand does not create a new source of truth; it PROJECTS the
# existing one into the shape the consumer already parses.
#
# `quotaBrake.baseline` is the marker, not `level` and not the cap:
#   * it is written by the same PATCH that lowers `maxConcurrentRuns`, and
#   * it is DELETED by `restore_body()` the moment the agent is put back.
# So its presence means "braked and not yet restored" with no clock, no TTL and
# nothing to expire. A cap that merely happens to equal a low number is not
# evidence of anything — an agent legitimately configured at 1 would read as
# throttled forever.
#
# THE FAILURE MODE THIS GUARDS. An empty export is a LOAD-BEARING claim: it
# tells the consumer "nobody is throttled", which licenses it to report a
# dormant agent as deliberately `disabled`. So an unreadable roster must exit 5
# and write NOTHING — never `{}`. Emitting an empty object on a failed read
# would harden every dormant agent into "someone switched this off", which is
# the precise mislabelling TOG-390 refused to make in the first place.
cmd_throttled() {
  local out=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out) out="${2:-}"; [[ -n "$out" ]] || die "--out needs a path"; shift 2;;
      *) die "unknown argument: $1";;
    esac
  done
  need jq
  local roster
  roster="$(read_roster)" || unknown "cannot read the roster; exported nothing. An absent export is 'unknown'; an EMPTY one would be read as 'nobody is throttled'."
  [[ -n "$roster" ]] || unknown "roster empty; exported nothing. Zero throttled out of zero examined is 'never ran', not 'nobody is braked'."

  local body n
  body="$(throttled_json "$roster")" || unknown "could not render the throttled set; exported nothing."
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$body" \
    || unknown "rendered export is not a JSON object; exported nothing."
  n="$(jq -r 'length' <<<"$body")"

  if [[ -n "$out" ]]; then
    # Atomic: a consumer polling this path sees the old set or the new one,
    # never a half-written file that jq would reject as `undetermined`. Same
    # directory, so the rename cannot cross a filesystem boundary.
    local tmp="$out.tmp.$$"
    printf '%s\n' "$body" > "$tmp" || die "cannot write $tmp"
    mv -f "$tmp" "$out" || die "cannot install $out"
    echo "wrote $out" >&2
  else
    printf '%s\n' "$body"
  fi
  echo "throttled: $n" >&2
  return 0
}

# Pure function over the roster TSV, so the suite can test the projection
# without a roster source at all. Emits an object keyed by agent id — the
# `type=="object"` shape `queue_liveness.sh` already accepts.
throttled_json() {
  local roster="$1"
  local id name status wod mcr baseline crit cfg line level
  {
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      IFS=$'\x1f' read -r id name status wod mcr baseline crit cfg <<<"${line//$'\t'/$'\x1f'}"
      # Not braked, or a baseline this tool did not write. Either way it is not
      # in the set, and a non-numeric baseline is skipped rather than guessed.
      [[ "$baseline" =~ ^[0-9]+$ ]] || continue
      level="$(jq -r '.heartbeat.quotaBrake.level // ""' <<<"${cfg:-\{\}}" 2>/dev/null)" || level=""
      jq -nc --arg id "$id" --arg name "$name" --arg level "$level" \
             --arg cap "$mcr" --arg baseline "$baseline" --arg status "$status" '
        { ($id): { agentId: $id,
                   name: $name,
                   status: $status,
                   level: $level,
                   cap: ($cap | if . == "" then null else (tonumber? // null) end),
                   baseline: ($baseline | tonumber),
                   tool: "quota_brake.sh" } }' || return 1
    done < <(printf '%s\n' "$roster")
  } | jq -s 'add // {}'
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
  throttled) shift; cmd_throttled "$@";;
  pace)     shift || true; cmd_pace "$@";;
  -h|--help|help) usage;;
  *) usage; exit 2;;
esac
