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
| Sustainable burn ≈ 0.09–0.13/day | **Wrong as a constant.** It is `(PACE_TARGET − weekly_used) / days_left`, exact to four decimals on three consecutive samples at the producer's own 0.97. That day's value is ~0.087 — *below* the quoted band, so a brake pinned to 0.09 runs permanently hot. Our `PACE_TARGET` is now 0.90; see [the line being defended](#the-line-being-defended-pace_target-tog-490). |

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

## Burn is derived, not read (TOG-440)

The brake originally keyed on `burn_per_day`, a producer-side field in `quota-pacing.jsonl`. It
does not survive contact with its own history. Measured over a 219-sample snapshot,
`2026-08-23T18:51:04Z → 2026-08-25T17:18:13Z`:

| symptom | measurement |
|---|---|
| **absent** | `null` on **203 of 438** account-samples (46%). On **75 of 219 rows** *no* account had a value, so `pace_ratio` returned empty and the brake exited `5 UNKNOWN` — **a third of the time it was not braking, it was blind** |
| **not a rate** | `11:59Z→14:30Z`: `weekly` flat at 0.86 (zero consumption) while the field decayed `0.9568 → 0.1595`. A fixed numerator over a growing elapsed time — cumulative-since-an-anchor. All ten idle samples selected `LEVEL2`/`LEVEL3` |
| **unstable** | `0.6381` at `09:29Z`, `3.8355` at `09:44Z` — 6× on a `weekly` delta of `+0.04` |
| **wrong rung** | agrees with the measured level on **73 of 235** comparable samples (31%). On the second account it never once selected `LEVEL1` or `LEVEL2`: bimodal `RELEASE` (64) or `LEVEL3` (28), so half the ladder was unreachable through it |

`weekly` is what the **account** reports and what the cap is enforced against, so the difference
of two `weekly` readings over a known interval *is* the burn, with no producer logic in between:

```
burn = Δweekly / Δt        over a 24h trailing window
```

Derived that way the series integrates back to `weekly` exactly — `sum(rate·dt)` against the
observed `Δweekly`, error `0.000000` over 46.5h on both accounts (`quota_burn_derive.py
--series`). A rate that cannot be reconciled against the thing it was derived from is not a
measurement of it, which is the check the old field would have failed.

**The window is 24h for an arithmetic reason.** `weekly` is emitted rounded to `0.01`, so a rate
over `dt` days cannot resolve finer than `0.01/dt` per day:

| window | resolution | × sustainable (0.0270/day) | level flips over the history |
|---|---|---|---|
| 2h | 0.1195/day | 4.42× — coarser than the whole ladder | 26 |
| 6h | 0.0399/day | 1.48× — wider than the whole `LEVEL1` band | 15 |
| 12h | 0.0199/day | 0.74× | 17 |
| **24h** | **0.0100/day** | **0.37× — first window that resolves rung 1** | **13** |
| 48h | 0.0052/day | 0.19× | 13 |

The ladder's tightest decision is `RELEASE|LEVEL1` at ratio 1.0. Below 24h the quantization
error alone can carry a sample across it, so a shorter window does not measure faster — it
measures noise faster, and every level flip is a `PATCH` against every brakeable agent.
`quota_burn_derive.py --sweep` reprints this table against current data.

Two edges the naive version gets wrong, both pinned by `test_quota_brake.sh` §9f/§9g:

- **Week resets truncate the window.** `weekly` returns to ~0 at reset; a window spanning one
  yields a large negative delta that clamps to zero and would *lift* the brake at the exact
  moment a fresh week's quota is all in front of you. Any drop over `PACE_RESET_DROP` (0.2)
  cuts the window there.
- **Rounding jitter clamps to zero, not negative.** A flat account steps `−0.01` — it does, at
  `10:44:23Z`. Negative burn is not a thing, and a negative rate would also beat every positive
  account in `max_by`, reporting the pool as healthier than its worst member.

### A fallback is never silent

When the window is too short to derive from, the brake falls back to `burn_per_day` — and says
so on **every** run, not only under `--explain`:

```
$ ./quota_brake.sh pace
{"name":"…","burn":0.4974,"ratio":20.45,"source":"derived","reason":"24.13h, 219 samples", …}
```

`source` is `derived` (a measurement) or `reported` (an estimate), with a `reason` naming which
of the three fallback conditions fired. `pace` exits `0` on derived and `4` on a fallback, so a
monitor can branch on it without parsing stderr. `--require-derived` /
`PACE_REQUIRE_DERIVED=1` turns a fallback into exit `5` and writes nothing. An estimate that
reads as a measurement is worse than a loud estimate — that is what the field is for.

## The ladder

`sustainable = (PACE_TARGET − weekly_used) / days_left`, `ratio = burn / sustainable`, taken
from the **worst** account rather than the average — an idle account must not dilute the one
actually burning.

| ratio | verdict | brakeable agents keep |
|---|---|---|
| ≤ 1.0 | `RELEASE` | baseline (brake lifts itself) |
| ≤ 2.0 | `LEVEL1` | ½ of baseline, rounded up |
| ≤ 5.0 | `LEVEL2` | ¼ of baseline, rounded up |
| > 5.0 | `LEVEL3` | 1 — never 0 |

**These thresholds were unmeasured when they shipped, and TOG-440 asked whether they still are.
They are not — and they also did not need to change.** Replayed over the 219-sample history at a
24h window, the derived input reaches all four rungs on both accounts:

| account | RELEASE | LEVEL1 | LEVEL2 | LEVEL3 |
|---|---|---|---|---|
| `1856877+Rick7C2@users.noreply.github.com` | 17 | 45 | 124 | 32 |
| `pisnrzrs@two.gg` | 33 | 13 | 71 | 101 |

That spread is the property you want from a ladder, and it is exactly what the *reported* input
could not produce (`LEVEL1=0, LEVEL2=0` on the second account). The defect was in the input, and
fixing the input fixed the ladder's behaviour without moving a threshold. Re-derive this table
with `quota_burn_derive.py --series` before changing a number here.

The thresholds shape the *response curve*. `PACE_TARGET` sets the **line being defended**, and
that is a separate decision with a separate owner — settled below.

## The line being defended: `PACE_TARGET` (TOG-490)

`PACE_TARGET` is the one number in the brake with a financial rather than a technical owner.
It was `0.97` because an engineer sizing a safety margin picked "just under the cap".
**It is now `0.90`, decided by the CFO on 2026-08-25**, and the reasoning inverted the framing
the question had been asked in.

### It is a reserve, not a target

The brake cannot make this company consume *more*. `cap_for()` clamps every rung to the
captured baseline, and `RELEASE` restores it exactly:

```awk
if (v == "RELEASE")      c = b;                       # RELEASE restores baseline
c = int(c); if (c < 1) c = 1; if (c > b) c = b;       # and nothing ever exceeds it
```

No level runs faster than normal, so **moving the target toward 1.0 buys zero extra
utilisation — it only removes margin.** If this company is ever *under*running its quota, the
fix is queue depth, never this number. That is written down here because raising this knob is
the obvious "fix" for an underrun, and it would achieve nothing but a thinner reserve.

And a cap-hit wastes no quota: it is 100% utilisation, with nothing left to be destroyed at
reset. What overshooting costs is **delivery** — a dark window in which nothing runs, wakes
destroyed rather than queued (a quota `429` is not retried, and quota returning does not
restart the company), and a restart somebody has to perform by hand.

So `1 − PACE_TARGET` is a **reserve**, and the only question is how big it has to be.

### 0.10, because 0.03 was thinner than the brake can see

The brake cannot react faster than one producer sample (~15 min), and lowering
`maxConcurrentRuns` does not stop runs already in flight (23 of them at 2026-08-25T17:45Z) —
those drain on their own clock. Measured over the 227-sample history
(2026-08-23T18:51:04Z → 2026-08-25T19:16:05Z):

| measurement | `1856877+Rick7C2@users.noreply.github.com` | `pisnrzrs@two.gg` |
|---|---|---|
| max Δ`weekly` over any ≤1h window | **0.140** | **0.150** |
| max Δ`weekly` over any ≤5h window | 0.290 | 0.150 |
| producer sample cadence | ~15 min | ~15 min |

At that peak hour, **0.03 of reserve is 13 minutes** — less than one detection interval, i.e.
the line was thinner than the brake's ability to see it. 0.10 is ~43 min at the measured peak
and ~4.3h at the sustained burn (0.558/day), which brackets the exposure across the rates this
company actually produces.

### What it costs early in the week: nothing

Ladder replay over the same snapshot (`quota_burn_derive.py --series --target N`), counted per
calendar day across both accounts:

| day | T=0.90 | T=0.97 | T=1.00 |
|---|---|---|---|
| 08-23 (early week) | **RELEASE 24** / L1 11 / L2 2 / L3 21 | **RELEASE 24** / L1 12 / L2 2 / L3 20 | RELEASE 26 / L1 10 / L2 2 / L3 20 |
| 08-24 | L1 17 / L2 115 / L3 100 | L1 33 / L2 147 / L3 52 | L1 46 / L2 142 / L3 44 |
| 08-25 | L1 26 / L2 58 / L3 78 | RELEASE 26 / L1 13 / L2 46 / L3 77 | RELEASE 26 / L1 17 / L2 44 / L3 75 |

Early in the week the three targets are **indistinguishable**, and that is arithmetic rather
than luck: with `weekly` small and `days_left` large, `(T − weekly) / days_left` is dominated
by `days_left`. The entire difference lands on 08-24/08-25 — the reserve is bought out of a
burst, on a week already running at double the linear pace. Per account, same snapshot:

| account | target | RELEASE | LEVEL1 | LEVEL2 | LEVEL3 | …of which target already passed |
|---|---|---|---|---|---|---|
| `1856877+Rick7C2@users.noreply.github.com` | 0.97 | 17 | 45 | 124 | 40 | 3 |
| `1856877+Rick7C2@users.noreply.github.com` | **0.90** | 17 | 28 | 140 | 41 | 8 |
| `pisnrzrs@two.gg` | 0.97 | 33 | 13 | 71 | 109 | 0 |
| `pisnrzrs@two.gg` | **0.90** | 7 | 26 | 35 | 158 | 36 |

### The cost asymmetry, on this week's own numbers

At 2026-08-25T18:30Z the pool was at `weekly=0.96` with 3.65d to reset and a derived burn of
0.578/day — a **3.58-day dark window**, half the week. Against that, the worst case of a 0.10
reserve is 0.10 destroyed, and only if the queue empties before reset, because the brake
*delays* work rather than refusing it. **10% at risk against 50% realised.**

### A passed target is LEVEL3, never a release

Once `weekly` passes `PACE_TARGET`, `sustainable` goes negative. That is guarded, not a bug:
`pace_ratio` pins `ratio` to `999` when `need <= 0`, which lands on LEVEL3 and stays there
until reset. It is worth being explicit, because a *negative* ratio falling through the
ladder's `ratio ≤ 1.0` rung into `RELEASE` is the one failure mode that would make a low
target dangerous. `test_quota_brake.sh` §10c/§10c2 pin it, and the CI mutation
`passed-target-releases` deletes the pin and requires the suite to notice.

At 0.90 this is a routine late-week reading rather than a corner case — 44 of 454
account-samples in the snapshot above. `quota_burn_derive.py --series` used to `continue` past
those rows *while still printing a level tally*, which is exactly the "a check that measured
nothing must not read green" failure rule 4 names. It now replays them under the same 999 pin
and reports the count, alongside the count it genuinely could not replay.

### When to re-derive this number

Not on a hunch, and not after one quiet week. **Re-derive if two consecutive weeks end below
0.88 with an empty queue while the brake was actually applying.** That is the only evidence
that 0.90 is too conservative, and it is a measurement rather than a judgement call. Absent
it, 0.90 stands.

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

## The throttle export: telling "throttled" from "disabled" (TOG-401)

TOG-401 was filed against the *old* brake and asked for the throttled set to be published
somewhere an agent could read, because a throttled agent and a switched-off one were
byte-identical in `agent_wakeup_requests` — same `reason`, same `status=skipped`, same
`trigger_detail`, across all 51,837 rows. The only discriminator was the host pacer's state
file above, unreadable from a container, so `queue_liveness.sh` reported `undetermined` for
every dormant agent on the board.

The issue offered two fixes and preferred the second — *"the pacer recording the cause on the
record that already exists rather than in a second source that has to be joined."* State-free
restoration had already done exactly that, for an unrelated reason. So the throttled set is
**already** durable, per-agent, and readable by anything that can read an agent; `throttled`
does not create a new source of truth, it projects the existing one into the shape
`queue_liveness.sh` already parses:

```console
$ quota_brake.sh throttled
{"a1":{"agentId":"a1","name":"Bulk Worker","status":"idle",
       "level":"LEVEL3","cap":1,"baseline":20,"tool":"quota_brake.sh"}}
```

`--out FILE` writes it atomically (temp + rename) for a consumer that polls a path.

**`quotaBrake.baseline` is the marker — not the level, and not a low cap.** It is written by the
same PATCH that lowers concurrency and *deleted* by `restore`, so its presence means "braked and
not yet restored" with no clock and nothing to expire. Keying on a low `maxConcurrentRuns`
instead would read an agent legitimately configured at 1 as throttled forever.

**An empty export is a positive claim, so it may only come from a source that answered.** `{}`
tells the consumer "nobody is braked", which licenses it to report a dormant agent as
deliberately `disabled`. An unreadable or empty roster therefore exits 5 and writes *nothing* —
never `{}`, and never over a previous export. Pinned by §9i–9l of the suite.

### What changed for the consumer

`queue_liveness.sh` tries `QUOTA_PACER_THROTTLE_FILE` first — unchanged, so an operator holding
a real pacer file keeps working — and falls back to `THROTTLE_SOURCE_CMD`, default
`quota_brake.sh throttled`. Three consequences:

- **`disabled` became a measured cause.** It fires only when a source answered and did not name
  the agent. Since `assert_policy_preserved` bars the brake from writing `wakeOnDemand=false`,
  that now means a human switched it off and it will not lift on its own.
- **`throttled` normally arrives on a `reachable` agent.** Throttling lowers concurrency instead
  of refusing wakes, so a braked agent's wakes are queued and drained. The verdict stays
  `reachable` — calling it `dormant` would make `alarm` scream every time the brake did its job
  — while the cause says `throttled`, i.e. *expect latency, not silence*.
- **`undetermined` did not go away.** Both sources silent still means we could not tell, and
  that is still not a synonym for `disabled`.

Recorded refusals continue to outrank a throttle marker: an agent the brake claims it is merely
pacing, whose wakes the platform is in fact discarding, is reported `dormant`.

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
| 4 | `pace`: the reading is a `reported` fallback, not a derivation.<br>`plan`/`apply`: **INSUFFICIENT** — the plan is valid and was applied, and still cannot reach the concurrency the 5-hour bucket affords |
| 5 | **could not measure.** Not clean. Nothing was written |

Exit 5 is load-bearing. Zero agents braked out of zero examined is "never ran", not "nothing
needed braking", and a brake that reads green while blind is the same silent failure this whole
file is about.

## The five-hour bucket (TOG-477)

The weekly term is not the only ceiling, and on 2026-08-25 it was not the binding one. The
company ran 47-wide and both accounts hard-429'd — `All 2 accounts exhausted` — while
`unused_weekly_remaining` was still **0.31**. What ran out was the rolling **5-hour** bucket.

That inverts the brake's own logic, which is why it needed a second term rather than a tuning
change. Weekly burn can sit *at or under* pace — ratio ≤ 1.0, which is `RELEASE`, which
**restores every baseline** — while a 5-hour bucket empties underneath it. Replayed from the
pacer feed, the pooled bucket (the sum of each account's `five_hour`, against a capacity equal
to the account count) went:

```
  08:58Z 0.34   09:29Z 0.42   09:44Z 0.71   09:59Z 0.97
  10:14Z 1.29   10:29Z 1.67   10:44Z 1.98   <- of 2.00, then 429 at 10:48:50Z
```

Three things the derivation gets right on purpose:

* **Pooled, not per-account.** Rotation moves traffic between accounts, so a per-account series
  reads as "stopped burning" the instant the pacer rotates away from it. The pooled sum is
  monotone under load.
* **Only positive deltas are burn.** A negative step is the rolling window *expiring*, not quota
  being returned by work that did not happen — measured at 15:00Z (1.99 → 1.00) and 15:45Z
  (1.00 → 0.00) with **zero** runs in flight. Counting those would make the pool read healthiest
  immediately after it had been drained.
* **A short window, for the opposite reason `weekly` needs a long one.** `weekly` needs 24h
  because 0.01 rounding cannot resolve the ladder over less. `five_hour` carries the same
  rounding against a bucket that must be spent in 300 minutes, so the signal is ~20× denser per
  unit time — and a 24h window would average an exhaustion event into the idle hours either side
  of it and read comfortable.

The two terms are combined **worst-of**, never averaged. They are independent ceilings and the
pool dies at whichever it reaches first; averaging lets a comfortable weekly figure pull a
saturated bucket back under the `RELEASE` rung and hand full concurrency into a hard 429.

When the term cannot be derived it reports `unavailable` with a reason and the weekly term
governs alone. It never contributes a fabricated `0` — rule 4 applies to it exactly as it applies
to the roster.

## The per-agent ceiling

**The brake cannot reach the concurrency this incident required, and it now says so instead of
printing a page of `brake` lines and exiting 0.**

`maxConcurrentRuns` is enforced **per agent**. `startNextQueuedRunForAgent()` compares it against
`countRunningRunsForAgent(agentId)` (`services/heartbeat.ts:13444-13446`), and there is no
company-level equivalent anywhere in the run engine — the only company-wide lever,
`resolveHeartbeatSchedulingSuppression()` at `:6552`, is driven by host process env
(`PAPERCLIP_IN_WORKTREE`, `PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS`), is not reachable from an
agent or an API call, and is all-or-nothing.

So the concurrency a plan actually produces is the **sum of the caps it leaves on the roster**,
and because `HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1` (`:347`, clamped at `:2456`) the hardest
possible brake still leaves one run per brakeable agent. Measured on this company:

One reading, taken from an agent container at 2026-08-25T18:05Z. The exact floor moves as
agents enter and leave the exempt set, and the affordable figure moves with the measured per-run
burn; the gap between them does not.

| | |
|---|---|
| roster (non-terminated) | 47 |
| brakeable (idle/running/error, not exempt) | 42 |
| floor at LEVEL3, the hardest rung | **45** (42 brakeable + 3 on exempt agents) |
| what the 5-hour bucket affords | **~14** |
| observed in flight during the incident | 47 |

The strongest brake this tool can apply removes roughly two runs from a load that is four times
too heavy. `plan` and `apply` therefore compute the floor, compare it against the affordable
figure derived from the 5-hour term's per-run coefficient, and exit **4 INSUFFICIENT** when even
one run per brakeable agent does not fit.

The distinction the check draws matters: a floor the *ladder* has not reached yet resolves
itself as burn stays high, and is reported without the alarm. Only a floor that no rung can
clear — because it is made of the platform minimum plus agents the brake may not touch — is
INSUFFICIENT. A ceiling check that fires on every plan is noise, and noise is how the real one
gets ignored.

**What this does not do is fix it.** Reducing the roster's concurrent footprint is the remaining
lever and this tool does not hold it. Exit 4 is the honest report of a gap, not a repair.

## Running it from an agent container (TOG-477)

`lib/pcsql.sh` offers two backends, `podman` and `psql`, and an agent container has neither:

```
$ ./quota_brake.sh plan --explain
lib/pcsql.sh: line 150: podman: command not found
UNKNOWN: cannot read the roster. Nothing braked, nothing restored.
$ echo $?
5
```

Exit 5 was correct — it measured nothing — but it meant the brake built to shape a 47-wide surge
was operator-only, and during the ramp from 3 to 47 in flight nothing capped concurrency and
nothing could have. `pg_source.js` fills the seams the tool already publishes:

```bash
export ROSTER_SOURCE_CMD="$PWD/pg_source.js roster"
export REFUSAL_SOURCE_CMD="$PWD/pg_source.js refusals --since-min 15"
./quota_brake.sh plan --explain
```

It reads `DATABASE_URL` and the `pg` module inside the Paperclip server's own `node_modules`,
and sets `default_transaction_read_only = on` before every query — the write path is unchanged
and still goes through the API with `assert_policy_preserved` on the bytes.

**The company filter is mandatory.** The operator's `roster_sql()` has no company predicate
because `podman exec` reaches a database it assumes is this company's. That assumption does not
hold here: two companies share this Postgres and agent names collide across them, so an
unfiltered roster read would hand the brake another company's agents and the write path would
accept them. A missing company id is a refusal, not a default.

## What is NOT built here, and why

**An agent can now PLAN but still cannot APPLY.** The read half is solved — see "Running it from
an agent container" above — so an agent can measure burn, read the roster, and produce the plan
and its ceiling verdict. The *write* half is unchanged, because cross-agent
`PATCH /api/agents/{id}` is refused:

```
403 {"error":"Missing permission: agents:configure or agents:suggest-changes.",
     "details":{"reason":"deny_no_grant"}}
```

Self-config is open (200), but an agent that is being braked is precisely the one that cannot
be relied on to brake itself. So applying still needs a company-scope `agents:configure` token in
`PAPERCLIP_ADMIN_TOKEN`; `apply` refuses with an explanatory error rather than a stack trace when
it is absent.

This split is worth stating plainly rather than reading as a half-finished job: the diagnosis is
the part that was missing during the incident. Nobody could see that the 5-hour bucket was four
minutes from exhaustion, or that the strongest available brake would not have helped. An agent
can now produce both findings on demand and escalate them. Handing an agent the write path would
not have changed the outcome of 2026-08-25 — per the ceiling section, the brake had no rung that
would have bound.

**Dispatch-level throttling is not implemented here.** TOG-419 lists it as worth evaluating and
it is the right *next* lever — `dispatcher.py` already refuses on `HOLD_5H`, and lowering the
dispatch cap slows new work without touching any agent record at all, which is strictly less
invasive than concurrency shaping. It lives in the operator's dispatcher, outside this repo and
outside what an agent can read. It should be layered *above* this brake, not instead of it:
dispatch throttling shapes work that has not been created yet, while concurrency shaping is what
holds the line for work already queued.
