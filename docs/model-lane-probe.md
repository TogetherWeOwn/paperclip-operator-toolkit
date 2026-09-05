# The cheap/small-fast lane, and the probe that watches it

**Issue:** TOG-682. **Prior art:** TOG-679 (a 503 on the cheap lane, found by hand roughly a day
late — by the time anyone looked it had self-resolved) and TOG-680, which disagreed with TOG-679
because one config surface had been fixed and the other had not.
**Tool:** [`model_lane_probe.sh`](../model_lane_probe.sh) · suite `test_model_lane_probe.sh` ·
read seam [`pg_source.js model-surfaces`](../pg_source.js).

Every figure below was measured against the live database and the live gateway on 2026-08-30
while writing this. Where a re-measurement disagreed with the commissioning issue, the
disagreement is stated rather than smoothed over.

## Why this lane and not any other

The cheap/small-fast profile is also the **recovery** profile. A dead value here does not merely
make small calls fail — it blocks status-recovery itself, which is the mechanism that would
otherwise notice the failure. That is the loop TOG-679 sat inside for a day.

## HTTP 200 is not the question — the billing leg is

This is the part that makes the probe worth more than a curl in a loop.

| Model id | HTTP | Resolves onto | What it means |
|---|---|---|---|
| `cliproxy/claude-haiku-4-5-20251001` | **200** | pinned connection | pinned, direct id |
| `cliproxy/claude-sonnet-5` | **200** | pinned connection | pinned, `strategy=single` |
| `claude-sonnet-5` (bare) | **200** | pinned connection | pinned — a **one-leg combo**, `strategy=priority` |
| `hindsight/retain` (bare) | **200** | **`openrouter`** | genuinely off-subscription; measured cost `0.0000130000` |
| `cliproxy/claude-haiku-4-5` (undated) | 400 | — | `unknown provider for model claude-haiku-4-5` |
| `cliproxy/claude-haiku-4-5-20251001-low` | 400 | — | effort belongs in the `effort` field, not the id |

Two ids can both answer 200 and bill different accounts. A status-only monitor cannot tell them
apart, and the misrouted case is the harder of the two to notice — nothing breaks, the bill just
moves. So the probe measures **where the request went**, and `ALARM-unpinned` is not a lesser
finding than `ALARM-dead`.

### The `cliproxy/` prefix was the wrong test, and it cost a fleet-wide false alarm

Until 2026-09-05 the pin gate was a string test, `[[ $model == cliproxy/* ]]`, on the premise
that a bare id "fails open onto a PAYG leg". **That premise is false on this gateway**, and the
gate built on it fired TOG-985: an ALARM against all 24 agents, on the ids the *owner* had chosen
that same evening. A monitor that pages on a correct configuration destroys the signal exactly as
thoroughly as one that stays quiet on a broken one.

What is actually true here, re-measured independently on 2026-09-05:

```
GET /v1/combos
  claude-sonnet-5   strategy=priority, ONE leg  -> openai-compatible-chat-1628780c-…
  claude-opus-5     strategy=priority, ONE leg  -> openai-compatible-chat-1628780c-…
```

and per request, from the gateway's own response headers:

```
model=claude-sonnet-5           x-omniroute-decision: strategy=priority; provider=openai-compatible-chat-1628780c-…
model=cliproxy/claude-sonnet-5  x-omniroute-decision: strategy=single;   provider=openai-compatible-chat-1628780c-…
```

Same connection — `cliproxy-main`, the owner's subscription. The prefixed form resolves directly;
the bare form resolves through a one-leg combo. Neither touches OpenRouter. The prefix only ever
*correlated* with the property that mattered, on the day it was written.

**Prefixing is not a fix and this probe must never recommend one.** `cliproxy/` is a provider
namespace, not a string decoration: prefixing an id from another namespace yields an id nothing
serves (`cliproxy/opencode-go/deepseek-v4-pro` → 400 `model_not_found`, measured 2026-09-03).
Whether the fleet should prefer the prefixed form is a real question — it fails *closed* if the
combo is ever deleted — but it is a question for the **owner**, who chooses the model ids, not a
defect for a monitor to page on.

### What replaced it: three gates, all measured

| Gate | What it reads | Catches |
|---|---|---|
| **A — the leg set** | `GET /v1/combos`; every leg of a named combo | a **dormant** off-connection failover leg. Bills correctly today, wrongly the first time the pinned leg errors. **No single request can reveal this.** |
| **B — the resolved provider** | `x-omniroute-provider` on the probe response | a live misroute: the gateway itself says where it dispatched |
| **C — liveness** | the HTTP status | a dead id, including the undated and `-low` traps |

Gate A is strictly stronger than the prefix test it replaced, and in both directions: it clears
`claude-sonnet-5` (bare, one pinned leg) and it catches `hindsight/retain` (bare, `openrouter`) —
whereas the prefix test got the first one wrong and the second one right for the wrong reason.

Gate B is why a 200 with **no** `x-omniroute-provider` header is `unmeasured`, not `ok`: the lane
is alive and the billing leg is unverified, which is the whole question. Likewise an unreadable
combo list is `unmeasured` even when the measured route was correct — a dormant leg cannot be
ruled out.

One correction to the commissioning issue's own trap list: it warns against re-citing
`gpt-5.4-mini`'s 2026-08-29 503 as current. Re-measured 2026-08-30, that id returns **200**. The
503 had self-resolved, exactly as TOG-679's did — which is the argument for a probe rather than a
hand-check.

## Both surfaces, because they drift independently

A cheap-lane id lives in two places that are written by different principals:

| Surface | Who can write it |
|---|---|
| `adapterConfig.env.ANTHROPIC_SMALL_FAST_MODEL` | **console only** — `adapterConfig` is 403 to every agent, structurally |
| `adapterConfig.env.ANTHROPIC_DEFAULT_HAIKU_MODEL` | console only |
| `runtimeConfig.modelProfiles.cheap` | **agent-writable** via `PATCH /api/agents/{id}` |

Fixing one leaves the other dead. That is precisely how TOG-679 and TOG-680 came to disagree, so
the seam emits **one row per (agent, surface)**, never one row per agent. A `coalesce(...)` chain
across the three would report whichever is listed first and hide the rest — which is the defect
itself, reimplemented as a monitor.

Measured 2026-08-30: **141 rows = 47 agents × 3 surfaces**, all carrying
`cliproxy/claude-haiku-4-5-20251001`.

Re-measured 2026-09-05: **72 rows = 24 agents × 3 surfaces**, carrying **two** ids — the two
`adapterConfig.env` surfaces still on `cliproxy/claude-haiku-4-5-20251001`, and
`runtimeConfig.modelProfiles.cheap` on `claude-sonnet-5`, set by the owner on 2026-09-04. Both
resolve onto the pinned connection, so the fleet disagrees across surfaces *by intent* and the
probe is green. Note that the surfaces no longer agree on a single id, which is a thing to know
before reading any older claim in this file that they do.

### Why the database and not the API

`GET /api/agents/{id}` returns `adapterConfig` and `runtimeConfig` for **yourself** and redacts
both for every other agent — measured 2026-08-30: my own row carried the env, three peers' rows
came back `{}` at HTTP 200, and the list route returns `{}` for all 47.

A probe built on that route would measure one agent's lane and score the other 46 as "no id
referenced" — **which reads green**. The database is the only vantage point that sees all 47, so
the seam is a read-only `pg` connection with a mandatory company filter (two companies share this
Postgres and agent names collide).

`adapter_config` env entries are *binding objects* (`{"type":"plain","value":"..."}`), not bare
strings. A `secret_ref` binding has no `value`, so `->>'value'` yields NULL — reported as
unreadable, never as absent.

## Using it

```bash
export MODEL_SURFACE_SOURCE_CMD="$PWD/pg_source.js model-surfaces"   # optional; this is also the default
./model_lane_probe.sh surfaces          # inventory; --long for per-agent rows
./model_lane_probe.sh check             # 0 ok · 3 ALARM · 5 could not measure
```

| Exit | Meaning |
|---|---|
| `0` | every referenced id **resolves onto the pinned connection** and answers 200 |
| `2` | REFUSED — bad invocation |
| `3` | **ALARM** — an id is dead (non-200) or unpinned (routes, or can fail over, off the pinned connection) |
| `5` | **UNKNOWN** — could not measure. Not green. |

Options: `--surface SUBSTR`, `--json`, `--long`. Env: `PINNED_CONNECTION_ID` (default is the
`cliproxy-main` connection id), `COMBO_SOURCE_CMD`, `MIN_SURFACES_EXPECTED`, `PROBE_MAX_TIME`,
`PROBE_MAX_TOKENS`, `ALARM_NAME_CAP`.

`PINNED_CONNECTION_ID` is deliberately an exact id and **not** a pattern like
`openai-compatible*`: any future OpenAI-compatible connection — including a pay-as-you-go one —
would match such a pattern, and the monitor would clear the very leg it exists to catch.

### The verdict ladder, and why its order is load-bearing

```
combo has an off-connection leg   →  ALARM-unpinned    ranked ABOVE both network gates
unmeasured (curl 000 / non-integer)  →  unmeasured
non-200                           →  ALARM-dead
200 but no provider header        →  unmeasured        alive ≠ pinned
resolved provider ≠ pinned        →  ALARM-unpinned
combo list unreadable             →  unmeasured        dormant leg not ruled out
else                              →  ok
```

Gate A is hoisted above both network gates because **the leg set is a property of the
configuration**, fully measurable even when the gateway will not serve — and a dormant failover
leg is exactly the fail-open case that no single request can surface.

`000` is curl's "no response completed": the request never reached the gateway. But `is_int 000`
is true and `000 != 200` is true, so the naive ordering pages the model owner for what may be a
local network fault. Hence the separate `measured` flag, and `unmeasured` is its own verdict that
never scores as green.

### One request, not 141

The probe deduplicates to **distinct ids** before probing: 141 rows, 1 request. This is a gateway
whose quota this company has already drained once (TOG-477), and a monitor that costs 141 calls
per tick is a small version of that drain.

### Seven lines, not 141

The first live `check` printed one line per agent per surface. A monitor whose quiet output is
141 lines is one nobody reads, and an alarm buried in it is invisible. The healthy path collapses
to per-surface counts; the fix list prints **only on an alarm**, capped at `ALARM_NAME_CAP` (12)
with a `WITHHELD` notice when truncated. Two tests assert the collapsed report still carries the
real 47-per-surface and 141-total counts, so the collapse cannot hide the fleet.

## Refusals that are load-bearing

**Zero surface rows is exit 5, never 0.** `[[ "" -eq 0 ]]` is TRUE and `(( "" > 0 ))` is FALSE in
bash, so an unread count silently scores as "clean". Every count is validated by `is_int` before
any comparison. A source that did not answer has not reported a healthy fleet.

**Both seams default to `false`** in the suite, so a test that fell through to the real database
or the real gateway *fails* rather than passing quietly.

**The token never touches argv.** `/proc` exposes every process's cmdline on this host, so the
token is written to a `0600` curl `--config` file inside a per-run `mktemp -d`, trapped clean.
The per-run scratch also avoids the TOG-485 stale-shared-file trap.

## Verification

- **Suite:** 56 assertions, 8 sections, **56 passed / 0 failed** (2026-09-05). Every assertion
  pins the *reason string* as well as the exit code — a refusal from the wrong branch must fail.
- **Hermetic:** green under `env -u DATABASE_URL -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN
  -u ANTHROPIC_API_KEY -u PAPERCLIP_COMPANY_ID`.
- **End-to-end against the real gateway**, not just fixtures (re-run 2026-09-05):

  | Injected | Real result | Verdict | Exit |
  |---|---|---|---|
  | `cliproxy/claude-haiku-4-5-20251001-low` | HTTP 400 `model_not_found` | `ALARM-dead` | 3 |
  | `hindsight/retain` — bare, real off-leg | HTTP **200**, `provider=openrouter` | `ALARM-unpinned` | 3 |
  | the real fleet (72 rows, 2 ids) | HTTP 200, both on the pinned connection | `ok` | **0** |

  The last row is the TOG-985 regression: the same fleet that the prefix gate paged on is green
  under the routing gates, and the two alarm rows show detection was not weakened to get there.

The fixture allocator uses `mktemp` rather than a counter, because every caller invokes the
helpers as `SRC="$(surfaces ...)"` — a command-substitution **subshell** — so shell state is
discarded the instant the helper returns. Uniqueness has to live on disk. The first version named
fixtures with `$$` (constant across the suite), so each overwrote the last and three tests failed
on a fixture nobody had edited.

## This one *is* scheduled

Unlike `cold_start_detector.sh`, `tool_drift.sh` and `channel_drift.sh` — all of which ship with
"a green CI badge means the detector works, not that anyone is watching" — this probe has a real
timer.

| | |
|---|---|
| Routine | `19c186f8-6cdc-4410-88ab-f597ad52e740` — "Probe the cheap/small-fast model lane (TOG-682)" |
| Trigger | `6516c379-bb75-4cc8-83e1-a0ffa823cef5`, `schedule`, **enabled** |
| Cron | `17 */6 * * *` UTC — 6-hourly, off the `:00` mark so it does not pile onto every other timer |
| Assignee | the DevOps & Reliability Engineer (self-assigned) |

`crontab` is absent from the agent container, but Paperclip's own `routine_triggers` table is
cron-backed and `assertCanManageCompanyRoutine` (`services/routines.js`) lets an agent create a
routine **assigned to itself**. That is the mechanism used here.

### The scheduler was verified alive, against a misleading first reading

A first pass showed **1 of 13 triggers had ever fired**, and that one was 8 days overdue — which
looks exactly like a stopped scheduler. It is not. Read against the running build:

- `tickScheduledTriggers` (`services/routines.js:2474`) is called from the live heartbeat
  scheduler at `index.js:948`.
- Its sweep requires `routines.status = 'active'`. The 8-day-overdue trigger belongs to a
  **paused** routine ("Company-idle watchdog"), which the sweep skips deliberately. 8 of the 13
  triggers are `enabled = false`.
- `getAutomaticRoutineDispatchEligibility` returns `{eligible: true}` outright unless
  `PAPERCLIP_IN_WORKTREE` is truthy; it is unset on the server process.
- The activity gate is consulted only when `activityGatePolicy = 'require_external_activity'`.
  This routine is `always`.
- No `projectId`, so the project-paused suppression can never apply.

Every gate clears. **Do not read "few triggers have fired" as a dead scheduler** — check the
routine's `status` first.

## Deliberately out of scope

The model id is duplicated across all 47 configs, and that duplication is *not* filed as work.
Deduplicating it needs a console path — `adapterConfig` is 403 to every agent, structurally — so
filing it would create work no agent can start. It is recorded here instead, which is where
someone with console access will find it.

The same boundary applies at alarm time: on `ALARM-*`, the `runtimeConfig.modelProfiles.cheap`
half is agent-fixable (`PATCH /api/agents/{id}` — note that `PATCH runtimeConfig` **replaces**
rather than merges, so send the whole object), while the two `adapterConfig.env.*` surfaces need
an operator. The report names every affected surface so that split is visible without a second
investigation.
