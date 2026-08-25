# The quota brake: why it shapes concurrency instead of switching agents off

TOG-419. Written after the brake took the company off the air on 2026-08-25.

## The incident

The owner created TOG-418 and assigned it to the Chief of Staff at 08:43:44. Nine seconds
later, at 08:43:52, the pacer's throttle set jumped from 10 agents to 44 of 47, because burn
had spiked to ~10x sustainable after 25 dormant agents were enabled that morning. The
platform then tried to wake the Chief of Staff every 30 seconds and was refused every time.

The owner could not reach their own company. Nothing errored, nothing turned red, and every
refused wake returned **HTTP 202**.

The brake was not wrong about the burn rate. It was wrong about what to do with it.

## What was re-measured, and what turned out to be wrong

Everything below was re-derived from the running build's TypeScript at `/app/server/src` and
the live database. Line numbers are from the TS source.

| Claim as filed | What measuring found |
|---|---|
| Brake works via `wakeOnDemand:false` | Confirmed. **58,780** refusals in 3 days — 95% of every skipped wake on this database. |
| Refusal returns 202 `{"status":"skipped","reason":"wakeup_skipped"}` | Confirmed but **worse**: the modern route (`routes/agents.ts:3717`) returns a bare `{"status":"skipped"}` with **no reason at all**. The quoted shape is a legacy handler at `:876-924`. |
| 44 of 47 throttled at 08:43 | Confirmed exactly, from `quota-pacing.jsonl`. The CoS was refused **68 times in 17 minutes**, not the 22 originally reported. |
| `maxDailyRuns` is the fix | **Wrong.** See below. |
| Caps reset at the UTC day boundary | Confirmed — `currentUtcDayWindow()`, `services/heartbeat.ts:12151-12155`, pure clock arithmetic with nothing persisted. |
| Sustainable burn ≈ 0.09–0.13/day | **Wrong as a constant.** It is `(0.97 − weekly_used) / days_left`, exact to four decimals on three consecutive samples. Today's value is ~0.087 — *below* the quoted band, so a brake pinned to 0.09 runs permanently hot. |

## Why `maxDailyRuns` is not the fix

TOG-419 proposes the platform's native per-agent budget caps as the replacement, on the
grounds that the agent stays wakeable and the window self-resets. Both of those are true, and
the conclusion still does not follow.

At `services/heartbeat.ts:18111-18130`, hitting a daily cap writes:

```js
await tx.insert(agentWakeupRequests).values({ ..., reason: dailyCapBlock.reason, status: "skipped" })
```

That is the **same `status:"skipped"` drop** as `wakeOnDemand`. The agent's *field* stays
`true`, so the roster query TOG-419 proposes as its acceptance test reads green — while the
wake is discarded and `POST /wakeup` still returns a bare 202.

Had the Chief of Staff been on a daily cap instead of a disable, **the owner would have been
equally unable to reach it**, and the acceptance check would have said everything was fine.
That is a worse outcome than the original bug, not a better one: it passes the letter of "no
agent is left unwakeable" while failing its intent.

`quota_brake.sh` therefore refuses to write a daily cap at all, and the refusal is enforced by
`assert_policy_preserved()` rather than by convention.

## Why concurrency is different in kind

A wake **always** creates a `queued` run. `services/heartbeat.ts:18192` returns
`{ kind: "queued" }`, and the comment at `:18153` states it outright — *"enqueueWakeup queues
the run but doesn't start it"*. Draining is a separate step,
`startNextQueuedRunForAgent()` at `services/heartbeat.ts:13443-13446`:

```js
const runningCount   = await countRunningRunsForAgent(agentId);
const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
if (availableSlots <= 0) return [];
```

So lowering `maxConcurrentRuns` leaves the queued run **in the queue** and drains it when a
slot frees. The work is **delayed, never refused**. No `skipped` row, no 202, and the owner's
task is still there when the brake lifts.

Three mechanisms, one difference that matters:

| Mechanism | Agent stays wakeable | Wake survives | Self-restoring |
|---|---|---|---|
| `wakeOnDemand:false` | ✗ | ✗ | ✗ (needs a host state file) |
| `maxDailyRuns` | ✓ *(field only)* | ✗ | ✓ (UTC day) |
| **`maxConcurrentRuns`** | ✓ | **✓** | ✓ (recomputed each cycle) |

And the floor is the platform's, not ours — `services/heartbeat.ts:347`:

```js
const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1;
```

clamped into every read at `:2456`. **Concurrency cannot reach zero.** A brake built on it
cannot starve an agent even if a bug hands it `0` or `-5`; the platform refuses.
`wakeOnDemand` is a bare boolean with no floor, which is exactly why one bad sweep took the
company off the air.

## The ladder

`sustainable = (PACE_TARGET − weekly_used) / days_left`, `ratio = burn_per_day / sustainable`,
taken from the **worst** account rather than the average — an account with no traffic yet
(`burn_per_day: null`) must not dilute the one actually burning.

| ratio | verdict | brakeable agents keep |
|---|---|---|
| ≤ 1.0 | `RELEASE` | baseline (brake lifts itself) |
| ≤ 2.0 | `LEVEL1` | ½ of baseline, rounded up |
| ≤ 5.0 | `LEVEL2` | ¼ of baseline, rounded up |
| > 5.0 | `LEVEL3` | 1 — never 0 |

`PACE_TARGET` is 0.97, not 1.0, so the week lands just under the cap. Unused weekly quota is
destroyed at reset, so *underrunning is the expensive failure mode* and aiming low wastes the
subscription; overshooting is the only outcome worth a safety margin.

## Exemptions are an input, not a subtraction

`quota_brake_exempt.txt` is read **before** the candidate set is built, so an exempt agent
never enters it and no brake level can reach it. An exemption applied afterwards is one
refactor away from being dropped.

Currently exempt by name: the **Chief of Staff to Owner** (the owner's only interface, and the
agent whose unreachability caused this issue), the **CTO & Chief AI Officer** (102 refusals in
the incident window; sole escalation path for every engineering agent), and the **President &
Chief COO** (root of the reporting chain, so a deadlock there cannot be cleared from below).

Exempt by condition: any agent holding an open `critical` issue, for as long as it holds one.

Two traps the file's header documents at length:

- **Matching is exact.** This company has both `Chief of Staff to Owner` (running, the owner's
  channel) and `Chief of staff` (paused, a different agent). Substring matching would cover
  both and hide the ambiguity.
- **An unmatched entry is reported**, not ignored. A typo must not read as a successful
  exemption.

## State-free restoration

The old brake kept the only record of who to re-enable in
`~/.paperclip/quota-pacer-throttled.json`. Lose it, or crash between throttle and restore, and
agents stay dead with nothing to indicate why. That is not hypothetical: **ten agent rows on
this company still carry `wakeOnDemand:false`** from a sweep whose state file moved on.

Here the baseline lives in the agent's own record, under `heartbeat.quotaBrake.baseline`,
written by the same PATCH that applies the brake. `restore` works from a cold start with no
memory of having braked, because the restore target travels with the object it describes.

**The baseline is captured once and never re-captured.** Capturing it from an already-braked
agent bakes the throttled value in as "normal", and each cycle then ratchets the agent
permanently downward — invisible in a single run and fatal over a week.

## `runtimeConfig` is REPLACED, not merged

Measured during development, because the obvious assumption is the opposite:

```
before: {"heartbeat":{"enabled":false,"wakeOnDemand":true,"maxConcurrentRuns":2}}
PATCH   {"runtimeConfig":{"heartbeat":{"maxConcurrentRuns":3}}}   -> 200
after:  {"heartbeat":{"maxConcurrentRuns":3}}
```

`enabled` and `wakeOnDemand` were **deleted**. A brake that patched only the key it cares
about would strip wakeability off every agent it braked — and `modelProfiles`, which several
agents carry alongside `heartbeat`, taking model routing with it. Because unset `wakeOnDemand`
defaults to `true` (`services/heartbeat.ts:12125`), this would *not* have shown up as an
outage; it would have quietly reconfigured the roster.

Every write is therefore read-modify-write over the agent's whole `runtimeConfig`, and
`assert_policy_preserved()` diffs the outgoing body against what was read, refusing unless
every wakeability and daily-cap key is byte-identical. Absent counts as different — dropping a
key is precisely the bug, and it is invisible if you only compare values present on both sides.

## Loudness

The platform already records every dropped wake and nobody reads it. `quota_brake.sh refusals`
does not add a detector; it turns rows that already exist into a **number and a non-zero exit**,
which is the difference between a log line and a metric.

Run live on 2026-08-25 it returned **51 refused wakes in 15 minutes** and exited 3 — while this
issue was being worked. Over 24h: Web Engineer 13,427; Founding Engineer 6,560; Chief of Staff
to Owner 656.

`verify` is the companion check and the acceptance query TOG-419 asks for: it exits **3** if any
non-terminated agent carries `wakeOnDemand:false`. Note it reads the **nested** path —
`runtime_config->>'wakeOnDemand'` is NULL for every agent on this company and would report the
entire roster healthy.

## Exit codes

| code | meaning |
|---|---|
| 0 | done, or quiet |
| 2 | refused — a guard fired, or a required argument is missing |
| 3 | `verify`: an agent is unwakeable. `refusals`: over threshold |
| 5 | **could not measure.** Not clean. Nothing was written |

Exit 5 is load-bearing. Zero agents braked out of zero examined is "never ran", not "nothing
needed braking", and a brake that reads green while blind is the same silent failure this whole
file is about.

## What is NOT built here, and why

**This tool cannot be run by an agent.** Cross-agent `PATCH /api/agents/{id}` is refused:

```
403 {"error":"Missing permission: agents:configure or agents:suggest-changes.",
     "details":{"reason":"deny_no_grant"}}
```

Self-config is open (200), but an agent that is being braked is precisely the one that cannot
be relied on to brake itself. So the brake is operator-side and needs a company-scope
`agents:configure` token in `PAPERCLIP_ADMIN_TOKEN`; `apply` refuses with an explanatory error
rather than a stack trace when it is absent.

**Dispatch-level throttling is not implemented here.** TOG-419 lists it as worth evaluating and
it is the right *next* lever — `dispatcher.py` already refuses on `HOLD_5H`, and lowering the
dispatch cap slows new work without touching any agent record at all, which is strictly less
invasive than concurrency shaping. It lives in the operator's dispatcher, outside this repo and
outside what an agent can read. It should be layered *above* this brake, not instead of it:
dispatch throttling shapes work that has not been created yet, while concurrency shaping is what
holds the line for work already queued.
