# TOG-302 — a heartbeat timer wake starts a run scoped to nothing

**Status:** fixed. Patch written, mutation-gated, and root-caused at the source
line rather than inferred from the card. Not applied to `/app`, which we do not
own — see §6.

**The defect is real and latent, not live.** Zero agents on this instance are
armed for timer wakes right now (§4). Nothing is currently burning quota on it.
It bites the moment anybody sets `heartbeat.intervalSec`, which is exactly what
a future operator turning on heartbeats would do.

---

## 1. The defect

The scheduler tick wakes an agent *because* it has actionable work, then starts
the run with a `context_snapshot` that names no issue at all — only `source`,
`reason`, `now` and `timerClaimWasFirstHeartbeat`.

The cross-issue influence guard derives a run's **source** issue from that
snapshot and fails closed when there is none:

```js
// server/src/services/cross-issue-influence-limit.ts
const sourceIssueId = readRunSourceIssueId(run.contextSnapshot); // issueId ?? taskId
if (!sourceIssueId) throw crossIssueInfluenceRunContextError();  // 403
```

`assertCrossIssueInfluenceWithinRunCap` guards three call sites in
`routes/issues.ts` — issue `update`, issue `comment`, and the comment route —
so a timer run gets `403 cross_issue_influence_run_context_required` on **every
comment and every status update, including on the card it was woken for**.

The wake succeeds. The run starts. Nothing it does can be recorded. This is the
worst shape a failure can take: it looks like activity.

## 2. Confirmed against `/app/server/dist`, as the card required

The card warned that `/app/*/src` is contaminated by an agent patch, so the
read was confirmed against the built artifact first. Both agree.

| claim | dist | src |
|---|---|---|
| tick builds the wake with no `issueId`/`taskId` | `dist/services/heartbeat.js:14944-14956` | `src/services/heartbeat.ts:19052` |
| guard fails closed on a scopeless snapshot | `dist/services/cross-issue-influence-limit.js:69-71` | same |
| `issueId` is a real parameter on the timer path | `dist/services/heartbeat.js:13621` (`genericTimerWake`) | — |
| scoped timer wakes described as ordinary | `dist/services/heartbeat.js:2780-2787` | — |

`/app/server/dist/services/heartbeat.js` is unmodified (mtime `Aug 18 03:23`,
no `timerIssueId` symbol). The running server was never touched by this work.

## 3. Root cause, and why the card's one-line fix was not the right one

The card proposed reusing the `eligibleIssue` the tick already computes. That
query is the wrong one to promote, for two reasons that only show up on
reading it:

* It is **gated on `cutoff`** (`getWorktreeExecutionCutoff()`), an unrelated
  worktree-rollout setting. It is `null` on an ordinary instance — including
  this one — so on most ticks `eligibleIssue` is never computed at all.
* It filters `gte(issues.createdAt, cutoff)` and takes `limit(1)` with no
  `ORDER BY`. It selects on *recency of creation*, arbitrarily.

The right seam already exists. `hasActionableTimerWork()` is the predicate the
`skipTimerWhenNoActionableWork` policy uses to decide whether a timer wake
should fire at all, and it selects exactly the right population: assigned to
this agent, not assigned to a user, not hidden, status `todo`/`in_progress`.

So the fix promotes that predicate to `findActionableTimerIssue()`, returning
the issue instead of a boolean, and derives **both** the skip gate and the wake
scope from the one query. That coupling is the point: a gate and a scope that
disagree would reintroduce this bug in a subtler form — firing because work
exists, then scoping to something else.

Two further decisions, both load-bearing:

* **The id goes in `payload`, not straight into `contextSnapshot`.**
  `enrichWakeContextSnapshot` copies `payload.issueId` into *both*
  `contextSnapshot.issueId` and `contextSnapshot.taskId`, and builds the wake
  block in the agent's prompt. Writing `contextSnapshot.issueId` alone would
  satisfy the write guard while still handing the agent a wake with no card in
  it — half a fix that measures as a whole one. Mutation M2 exists to catch
  exactly this and does.
* **An agent with genuinely no actionable issue still gets an unscoped
  exploratory wake.** Timer wakes are legitimately issueless sometimes; the fix
  does not force a scope that does not exist.

## 4. Measured on the live control plane

All 4,932 runs on this instance (`tog302-measure.mjs`, read-only):

```
wakeSource    runs   with issueId   %      comments/run
automation    3055           3054   100.0          1.27
assignment    1701           1701   100.0          1.39
on_demand      121             31    25.6          0.20
timer           55              1     1.8          0.02
```

A timer run records **~1/65th** the output of any other wake source. The card
said 1/70th across 1,304 runs; re-measured across 4,932 it still holds.

All 55 timer runs are Octavo Foundry's, 2026-08-20 → 08-22. TogetherWeOwn has
never run one. 50 of the 55 exited `succeeded` — they burned a model call and
recorded nothing, and the run status cannot tell you that.

**The arming count is zero, and this corrects the card's framing.** The real
condition in `tickTimers` is `policy.enabled && policy.intervalSec > 0`:

| company | live agents | `enabled` | `intervalSec > 0` | **armed** |
|---|---:|---:|---:|---:|
| TogetherWeOwn | 23 | 20 | 0 | **0** |
| Octavo Foundry | 9 | 0 | 7 | **0** |
| TWO Gaming | 14 | 0 | 1 | **0** |
| Untended | 5 | 0 | 0 | **0** |

Note the trap: 20 TogetherWeOwn agents have `heartbeat.enabled: true` and would
look armed to a query that checks only that flag. None has an interval, so none
fires. The two halves of the condition are set in different places, and
`enabled: true` alone is not the arming switch.

## 5. What to do until it is fixed — do NOT enable heartbeats

Enabling `heartbeat.intervalSec` on the unpatched host produces runs that burn
quota and cannot write. **That is worse than idle, because it looks like
activity.**

The card names `dispatcher.py` as the working substitute. **That is now stale:**
`dispatcher.py` no longer exists anywhere on this host. It was retired under the
owner's 2026-08-30 no-host-side-automation directive (TOG-706 / TOG-707) and
replaced by the **`dispatch` plugin** (`paperclip-plugin-dispatch` 0.1.0,
status `ready`).

The plugin is the right substitute for the same structural reason: it wakes
through `issues.requestWakeup`, which is issue-bound by construction
(`plugin-host-services.ts:1892-1913` sets `payload.issueId`,
`contextSnapshot.issueId` *and* `contextSnapshot.taskId`, on the `assignment`
source). That path measures 1701/1701 scoped.

Its wake is currently **off** by config — it runs the real selection policy and
reports what it *would* have woken, calling `requestWakeup` zero times, pending
the evidence gate in `docs/tog-706-dispatch-plugin-design.md`. Zero runs carry
`pluginKey=dispatch` so far. Turning that gate on is TOG-706's business, not
this card's.

Meanwhile the board is not starving: 475 runs fired in the last 24h, all via
the `automation` and `assignment` paths, both 100% issue-scoped.

## 6. Landing it

Not applied to `/app`. The image is pinned and we do not own it; the same
patch-plus-doc handoff as TOG-699/702/750/914.

* `patches/TOG-302-timer-wake-issue-scope.patch` — verified to `git apply
  --check` clean against pristine source and to reproduce both files
  byte-identically.
* `verification/tog-302-mutation-gate.sh` — re-runs the proof.

Upstream reporting is **owner-reserved** (public commitment to a third party)
and blocked on the same empty `external_disclosure_authorizers.json` registry
that holds the other nine reports in `docs/upstream/`. This one differs from
those: they are defects we *cannot* fix, and this has a working patch — so it
belongs with the patch queue, not in `docs/upstream/`. TOG-721 is the owner
decision that clears the send path.

This card asked for pairing with TOG-182 as an upstream report. TOG-182 is
`cancelled`, and it was against **teamclaude**, a different vendor. The live
pairing is **TOG-914**, the sibling defect on the `on_demand` path, fixed the
same way the night before.

## 7. Reproduce

```sh
# the measurement
node tog302-measure.mjs

# the fix, from pristine source
git apply patches/TOG-302-timer-wake-issue-scope.patch
cd server && vitest run src/__tests__/heartbeat-timer-wake-issue-scope.test.ts

# proof the tests can fail
bash verification/tog-302-mutation-gate.sh
```

Results at fix time: 3/3 new tests green; 61/61 across the six timer-adjacent
suites; `tsc --noEmit` rc=0; mutation gate 6/6 — four mutants killed
(no scope / snapshot-only scope / no status filter / no assignee filter), decoy
green.
