# TOG-706 — dispatch plugin design and `paperclip-dispatcher.timer` retirement plan

Status: **design agreed**. Grill closed 2026-08-30T22:51:41Z — operator (President &
COO, on the owner's behalf) accepted all five round-2 recommendations as-is on
interaction `73a91515-7287-4c25-847f-c6480b29431d`. Facts: `docs/dispatch-plugin-facts.md`.
ADRs: `docs/adr/0001`–`0004`. Glossary: `CONTEXT.md`. Implementation is a separate
card, opened after this one, per the card's own instruction.

## What is being replaced

`dispatcher.py`, run by `paperclip-dispatcher.timer` every 30 min as `--apply --max 2`
on the host, outside any repo and unreadable from any agent container
(`docs/adr/0001` §Q5 in the round-1 comment; confirmed again in round 2 via
`operator-handoff/TOG-419-quota-brake-runbook.md:160`). It exists for the TOG-180 gap:
work with an owner but no state change never wakes anyone, and bare heartbeat timers
cannot fix this because a timer-woken run carries no `contextSnapshot.issueId` and
every issue write is refused (`cross_issue_influence_run_context_required`).

Its output, pasted into TOG-686, is the only surviving specification of its contract:

```
scope: FOCUS ONLY (Model Router Plugin + Ops Tooling)
candidates ready: 0   runnable queue: 0   deadlocked agents: 0
⚠️  NO RUNNABLE FOCUS-PROJECT WORK.
```

## Decisions (operator-confirmed, round 2)

| # | Decision | Recommendation adopted |
|---|---|---|
| Q1 | Rollout | **Report-only for one week**, running the real selection policy and logging what it would have woken, before any wake fires. Enable the waker only on that evidence. |
| Q2 | Scope | **Wake-only + report**, not auto-assign. The plugin reports the routing gap (38 unassigned, refused outright — ADR `0003`) and wakes a principal holding `tasks:assign`. Assignment stays a human/principal decision. |
| Q3 | Substrate | **`jobs.schedule`** cron sweep every 30 min, silent when nothing needs action; escalates to a managed routine + board-visible issue only when a human must act (routing gap, stale blocker, a stall that survived a wake). |
| Q4 | Location | **`plugins/dispatch/`** in this repo (`paperclip-ops-tooling`), matching the `omniroute-broker` precedent: `package.json` with `paperclipPlugin: {manifest, worker}`, `dist/` committed, `node --test`. Not a new project — `docs/adr/0002` establishes no location survives a company export, so portability comes from a one-command documented install, not repo choice. |
| Q5 | Reporting contract | **Five selection counters** (`refused_backlog`, `refused_unassigned`, `refused_blocked`, `parked_on_named_owner`, `woken`) **plus the three legacy script counters** (`candidates_ready`, `runnable_queue`, `deadlocked_agents`) on every firing. `deadlocked_agents` has **no native equivalent** — recorded as a known, accepted loss (see below), not solved by this design. |

## Selection policy (from ADR `0003`, now locked in by Q1/Q2)

1. Apply the server's four `requestWakeup` rails first (assignee present, status
   not `backlog|done|cancelled`, no unresolved blocker relation, no budget hard
   stop) — anything outside this is not the plugin's decision to make.
2. Exclude any issue carrying an `unblock_descriptor` (parked on a named
   principal — a wake would be noise; count and report it as
   `parked_on_named_owner` instead).
3. Idle threshold measured against `heartbeat_runs.context_snapshot->>'issueId'`
   for that issue, not `updated_at` (a comment refreshes `updated_at` without a run).
4. Spread picks across distinct assignees within a firing — coalescing
   (ADR `0001`) is per-agent, so two picks for the same agent collapse into one
   run and waste a selection slot.
5. Call `requestWakeup` once per selected issue, each in its own try/catch
   (ADR `0004`) — never `requestWakeups`, which throws on the first refusal after
   already waking every prior issue in the batch, discarding the result set.

## Retirement plan for `paperclip-dispatcher.timer`

1. **Build** `plugins/dispatch/` per Q3/Q4, report-only, wake action gated behind
   a per-company config flag (`instanceConfigSchema`) defaulting to **off**.
   Implementation card opens after this design card closes.
2. **Run both systems in parallel for one week.** The host timer keeps running
   unmodified; the plugin's `jobs.schedule` sweep runs alongside it, silent,
   writing its five-plus-three counters to `metrics.write` every firing and to
   `activity.log` only on a state change (Q5).
3. **Evidence gate, end of week 1:** compare the plugin's report-only output
   against what the timer actually did over the same window (visible via
   TOG-686-style pasted output, since the script itself stays unreadable). If the
   plugin's selection would have covered the timer's real wakes, flip the
   per-company config flag to enable the wake action. If not, the gap is a
   finding to fix in the plugin before enabling, not a reason to keep the timer
   indefinitely.
4. **Disable, do not delete, the timer** once the plugin has run with wakes
   enabled for a second week with no regressions the plugin's own reporting
   would have caught (a stall the plugin failed to wake). This order means the
   fallback exists until the replacement has evidence twice over.
5. **Remove `paperclip-dispatcher.timer` and `dispatcher.py`** as a host-side
   cleanup once step 4 is evidenced. This is a host action outside any agent
   container's reach today (ADR `0001`/round-1 §Q5) — it requires the operator or
   whoever holds host access, named explicitly when the implementation card
   reaches this step. Tracked, not executed, by this design.

## Known, accepted gap

`deadlocked_agents` — a counter the retired script printed with no `requestWakeup`
equivalent in the plugin capability surface available to this design. Per Q5, this
is recorded as a knowing loss rather than a fabricated substitute. If it turns out
to matter operationally during the report-only week, that is new evidence and
reopens Q5, not a silent omission.

## Coverage evidence this design replaces, not merely duplicates, the script

- Same trigger cadence (`jobs.schedule` every 30 min vs. the timer's 30 min).
- Same refusal semantics, now *measured* rather than assumed: the script's
  `HOLD_5H` maps to `budgets.getInvocationBlock`, which `requestWakeup` already
  calls (round-2 comment, Q5 note).
- Same three legacy counters preserved in the reporting contract, so a firing's
  output is diffable against TOG-686-style script output during the parallel week.
- Superset of the script's visibility: the script's stdout went nowhere durable;
  this design writes to `metrics.write`/`activity.log` every firing.
- Net new: routing-gap reporting (Q2), which the script never did — it was
  wake-only against a `--max 2` cap it applied without measurement (ADR `0003`
  found the actionable set is naturally ~3, so the cap was incidentally close to
  correct, not deliberately tuned).
