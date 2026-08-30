# TOG-699 — no reconciler clears `agents.status='running'` with zero live runs

**Status:** confirmed by direct measurement and reproduction. Patch written,
typechecked, and proven with a passing test suite plus a full-regression run.
Deploying it into the live control plane is out of scope for this card (per
operator instruction on the TOG-686 split) — this is the investigate/patch/doc
deliverable.

**Security read: the patch is safe to land.** Reasoning in §5.

---

## 1. The bug, and what was measured

Three agents were observed holding `agents.status = 'running'` on 2026-08-30
~05:26Z with no live run behind them (Growth & SEO Specialist stranded ~107h,
QA & Release Engineer, Test Automation Engineer). A `running` agent occupies
one of its `maxConcurrentRuns` slots; with zero live runs and nothing to flip
it back, the slot is gone forever and the agent is undispatchable.

The issue's own root-cause claim was verified by reading the deployed source
directly rather than trusting the issue text:

- `finalizeAgentStatus()` (`heartbeat.ts`) and
  `finalizeAgentAfterSourceResolvedRun()` (`recovery/service.ts`) both compute
  the correct next status (`runningCount > 0 ? "running" : ... "idle"`), but
  only run on a terminal-run-transition path. A crash, a killed process, or
  any path that skips the finalizer callback leaves the stale `"running"` row
  in place indefinitely.
- The existing periodic reconciler that runs beside this gap,
  `reapOrphanedRuns()`, **cannot see this class of orphan by construction**:
  it is rooted at

  ```ts
  const activeRuns = await db
    .select({ run: heartbeatRuns, ... })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(eq(heartbeatRuns.status, "running"));
  ```

  — a `heartbeat_runs`-rooted query. An agent with **zero** `heartbeat_runs`
  rows in the running state never appears in this result set, no matter how
  long it has been stuck. Reading the full function body (not just the
  `WHERE` clause) confirmed every downstream branch only ever calls
  `finalizeAgentStatus(run.agentId, ...)` for a `run` it is iterating —
  there's no code path in this function that reaches an agent with no run.
- Grepped every reconciler registered in the periodic heartbeat chain in
  `server/src/index.ts` (`reconcileHotRestartAdoption`, `reapOrphanedRuns`,
  `promoteDueScheduledRetries`, `resumeQueuedRuns`,
  `reconcileStrandedAssignedIssues`, `reconcileIssueGraphLiveness`,
  `reconcileTaskWatchdogs`, `scanSilentActiveRuns`, `sweepStaleIssueLocks`,
  `reconcileProductivityReviews`) — none of them select on
  `agents.status = 'running'` independent of a `heartbeat_runs` join.
- Checked later upstream tags (`v2026.824.0`, `v2026.824.1`) for a fix landing
  after the pinned `v2026.817.0` release — none found. This is not yet fixed
  upstream either.

**Why this needed reading the code, not just re-running the symptom query:**
re-running "3 agents stuck running" only reproduces the *count* at one point
in time; it says nothing about *why nothing self-heals it*. The absence of a
periodic sweep is what has to be shown, and that only comes from reading
every reconciler's `WHERE` clause and confirming none of them is
agent-rooted.

## 2. The fix

`patches/TOG-699-agent-status-reconciler.patch` — verified `git apply --check`
clean against the current `/app` sources (see §4). Two coordinated sites in
`server/src/services/heartbeat.ts` and `server/src/index.ts`:

**New function** `reconcileOrphanedAgentStatuses(opts?: { staleThresholdMs?:
number; companyId?: string })` in `heartbeat.ts`, placed beside
`reapOrphanedRuns`, exported from `heartbeatService()`'s returned object next
to it:

1. Select agents where `status = 'running'` (optionally scoped by
   `companyId` via the codebase's standard `cond ? eq(...) : undefined`
   optional-filter idiom).
2. Anti-join against `heartbeat_runs` using the **broader** live-status set
   used elsewhere in this file for this purpose —
   `EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running",
   "scheduled_retry"]` — not the narrower single-status check
   `finalizeAgentStatus` uses. This matters: if the check only excluded
   `status = 'running'` runs, an agent whose only outstanding run is
   `queued` or `scheduled_retry` (mid-retry, about to execute) would be
   misclassified as orphaned and flipped to `idle` out from under a run
   that is about to start. The broader set is the same one
   `CANCELLABLE_HEARTBEAT_RUN_STATUSES` and `EXECUTION_PATH_HEARTBEAT_RUN_STATUSES`
   already use for "does this agent have anything live in flight".
3. Apply the same 5-minute staleness threshold convention `reapOrphanedRuns`
   uses on its periodic call (`staleThresholdMs: 5 * 60 * 1000`), keyed off
   `agent.lastHeartbeatAt`, falling back to `agent.updatedAt` for an agent
   with no heartbeat history at all. This avoids a race against an agent that
   just this instant transitioned into `running` before its first
   `heartbeat_runs` row is visible in the same transaction.
4. Compare-and-set: `UPDATE agents SET status='idle' WHERE id=? AND
   status='running'` — the same defensive re-check pattern
   `setRunStatusFromLive` uses elsewhere in this file, so a concurrent path
   that already moved the agent out of `running` loses the race harmlessly
   instead of being clobbered.
5. Publish `agent.status` on `publishLiveEvent`, matching the shape
   `finalizeAgentStatus` already emits, so the board/live UI picks up the
   change the same way it does for every other agent-status transition.

`paused` and `terminated` agents are never selected in the first place — the
`status = 'running'` predicate on the initial select is the exclusion, not a
separate `notInArray(...)` clause. This is simpler than the
`finalizeAgentAfterSourceResolvedRun` model (which explicitly excludes
`["paused", "terminated"]` on an update that starts from a different status),
because here the select already can't produce those statuses.

**Wiring** in `server/src/index.ts`: called once in the startup recovery
block (after `reconcileTaskWatchdogs`, before `scanSilentActiveRuns`) and
once in the periodic `.then()` chain in the same position — following this
file's existing pattern of registering every reconciler exactly twice, once
per invocation site, so a fresh boot and the steady-state tick both self-heal
the same way `reapOrphanedRuns` does today.

## 3. Why naive verification would have missed this

- **Reading `reapOrphanedRuns` and stopping at "it reconciles running
  agents"** would have wrongly concluded the gap doesn't exist — the
  function *does* set agents to a terminal-or-idle status, just never for an
  agent with no run to iterate. The distinguishing fact only appears by
  reading which table the `SELECT` is rooted on.
- **A test that only seeds the positive case** (running + zero live runs →
  idle) would pass on a reconciler that flips *every* running agent
  regardless of live runs — a strictly worse bug than the one being fixed,
  since it would forcibly idle an agent mid-execution. The suite below
  therefore asserts the negative case (running + a live run → untouched) as
  a first-class requirement, not an afterthought.
- **A test that doesn't check the staleness gate** would pass a reconciler
  that has no grace period at all, which would race an agent that is
  `running` for the single tick between its status write and its first
  `heartbeat_runs` insert. The suite asserts a not-yet-stale running agent
  with zero live runs is left alone.

## 4. Verification performed

- `tsc --noEmit -p tsconfig.json` clean in a scratch copy built from the
  **current `/app` source tree** (not the older pinned release tag
  `v2026.817.0` — mixing that tag's source with `/app`'s newer
  `@paperclipai/db` schema produces a spurious `TS2353` on an unrelated
  field, `logLocalScope`, that both source trees don't actually share; using
  `/app`'s own self-consistent tree avoids that false signal entirely).
- New test file `server/src/__tests__/heartbeat-orphaned-agent-status.test.ts`,
  modeled on the `seedRunFixture`/`describeEmbeddedPostgres` pattern already
  used by `heartbeat-process-recovery.test.ts`, run against a real embedded
  Postgres instance (not mocked). Five cases, all passing:

  | Case | Setup | Asserted outcome |
  |---|---|---|
  | Orphaned + stale | `status='running'`, zero live runs, `lastHeartbeatAt` past the threshold | flips to `idle` |
  | Live run present | `status='running'`, one live `heartbeat_runs` row | **untouched**, stays `running` |
  | Not yet stale | `status='running'`, zero live runs, `lastHeartbeatAt` inside the threshold | **untouched**, stays `running` |
  | Paused | `status='paused'`, zero live runs, stale | **untouched**, stays `paused` |
  | Terminated | `status='terminated'`, zero live runs, stale | **untouched**, stays `terminated` |

  ```
  Test Files  1 passed (1)
       Tests  5 passed (5)
  ```

- **Full pre-existing regression suite**, `heartbeat-process-recovery.test.ts`
  (100 tests covering orphaned-process reaping, hot-restart adoption, retry
  scheduling, and more), re-run against the patched tree:

  ```
  Test Files  1 passed (1)
       Tests  100 passed (100)
  ```

  No pre-existing test needed modification; the new reconciler is additive
  and does not change any existing function's behavior.

- `git apply --check -p1` of `patches/TOG-699-agent-status-reconciler.patch`
  against a fresh copy of `/app/server/src` — clean, confirming the patch
  applies to the currently deployed tree as-is.
- `/app` was never mutated. All edits were made in a scratch copy
  (`$PAPERCLIP_SCRATCH_DIR/tog699-app`) built by `tar`-copying `/app`
  excluding `node_modules`/`.git` and re-symlinking the 34 top-level
  `node_modules` directories back to `/app`'s own, so the scratch tree's
  source and its dependency resolution are both self-consistent with the
  real deployed tree.

## 5. The security question: does this widen anything?

**No.** This reconciler only ever moves an agent from `running` to `idle`,
and only when:

1. It has zero rows in `heartbeat_runs` with status in `{queued, running,
   scheduled_retry}` — i.e., there is genuinely nothing in flight for it.
2. It has been stale for at least 5 minutes by the same clock and threshold
   convention `reapOrphanedRuns` already uses in production.
3. The compare-and-set only fires if the agent is *still* `status='running'`
   at write time, so it cannot race ahead of a concurrent legitimate
   transition.

It grants no new capability, reads no caller-supplied input, and touches no
table other than `agents` (plus the same `publishLiveEvent` side channel
every other status transition already uses). The only behavior change is
that an agent which was previously stuck forever now recovers its dispatch
slot — strictly reducing the blast radius of the existing bug, not adding
one.

**The one interaction worth stating explicitly:** the reconciler and
`reapOrphanedRuns` both run in the same periodic tick, one after the other,
against overlapping predicates. It's `reapOrphanedRuns` that flips
`heartbeat_runs.status` from `running` to a terminal value and then calls
`finalizeAgentStatus` on the agent as part of that same pass. The new
reconciler is invoked afterward, so by the time it runs, an agent
`reapOrphanedRuns` just fixed is already correct and simply won't match this
reconciler's `status='running' AND no live run` predicate. Order was
preserved deliberately (`reconcileOrphanedAgentStatuses` was inserted after
`reconcileTaskWatchdogs` and before `scanSilentActiveRuns`, downstream of
`reapOrphanedRuns` in both the startup block and the periodic chain).

## 6. Files

| Path | What |
|---|---|
| `patches/TOG-699-agent-status-reconciler.patch` | the fix: `reconcileOrphanedAgentStatuses` + wiring in `index.ts` |
| this doc | what was measured, the fix, and why it's safe |

Reproduce:

```sh
git apply --check -p1 patches/TOG-699-agent-status-reconciler.patch   # against a copy of /app/server/src
# then, inside the patched server/ package:
vitest run src/__tests__/heartbeat-orphaned-agent-status.test.ts      # 5 passed
vitest run src/__tests__/heartbeat-process-recovery.test.ts           # 100 passed, no regressions
```

## 7. What this does not do

Deploy the fix into the running control plane. Per the operator's TOG-686
split instruction, this card's scope is confirming the defect against the
pinned/deployed source and delivering a verified patch + doc, not mutating
`/app` (shared read-only ground truth other agents depend on) or restarting
the live server. Landing the patch is a separate decision outside this
card's authority.
