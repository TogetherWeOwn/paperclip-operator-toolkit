# dispatch

Finds work that has an owner and no reason to wake anyone, and **reports** it.
Once an evidence gate passes, it also wakes it.

Implements the design in `docs/tog-706-dispatch-plugin-design.md`. Native
replacement for `dispatcher.py` / `paperclip-dispatcher.timer`: a host-side
script outside any repo, unreadable from any agent container, whose stdout went
nowhere durable.

---

## Status

| | |
|---|---|
| Code | complete — 4 modules, hand-written `dist/` |
| Tests | 43, `node --test`, no network and no host. Mutation-gated by `verification/tog-747-mutation-gate.sh`: 21 mutants, 21 killed, 0 survivors |
| Manifest | validated against the **host's own** validators — `pluginManifestV1Schema` PASS, `validateManifestCapabilities` → `{allowed:true, missing:[], pluginId:"dispatch"}` |
| Installed | **no** — install needs an operator (`/api/plugins` returns `403 Board access required` to an agent key) |
| Wake action | **off**, and stays off. Enabling it is a separate, evidence-gated step — see "The gate" |

---

## What it does, every 30 minutes

Per company (a job context carries no `companyId`, so the sweep enumerates):

1. read the board — `issues.list`
2. read blockers, runs and budget blocks per assigned issue — one
   `issues.summaries.getOrchestration` call answers all three
3. decide — `dist/selection.js`, pure functions, no host calls
4. wake, one issue at a time, **only if `wakeEnabled`** — `issues.requestWakeup`
5. report — metrics every firing, activity only on a state change

Steps 1–3 and 5 run identically whether the wake is on or off. That is what makes
the report-only week evidence *for the enabled behaviour* rather than evidence for
a different program.

## Selection policy

Mirrors the server's four `requestWakeup` rails **in the server's own order**, then
adds two of its own:

| # | Rail | Source |
|---|---|---|
| 1 | assignee present | `plugin-host-services.js:1873` |
| 2 | status not in `backlog\|done\|cancelled` | `:1876` |
| 3 | no unresolved blocker relation | `:1880` |
| 4 | no budget hard stop | `:1884` |
| 5 | not parked on a named owner (`unblock_descriptor`) | ADR `0003` |
| 6 | idle past the threshold, measured on runs | ADR `0003` |

Then: **at most one pick per assignee**, ordered longest-idle first.

Three things about this are deliberate and easy to "tidy" wrongly:

**The rails are a denylist, not an allowlist.** The server refuses exactly three
statuses; everything else is wakeable by default, *including statuses that do not
exist yet*. The first cut of the design-phase probe enumerated the statuses it believed
were runnable and undercounted the wakeable surface by 88%.

**Rail 4 is the server's own verdict, not a reimplementation of it.**
`budgets.getInvocationBlock` is not on the plugin surface, but `getOrchestration`
calls it with byte-identical arguments to the ones `requestWakeup` uses
(`:2043` vs `:1884`) and returns the answer as `invocationBlocks`. The residual
gap is *time*, not rule — a budget can trip between the read and the wake — which
is exactly what the per-issue try/catch catches and `dispatch.wake_failures`
counts.

**Idle is measured on runs, never on `updated_at`.** A comment refreshes
`updated_at` without a run having happened, so a card nobody has worked reads as
freshly active. The measurement is `heartbeat_runs.context_snapshot->>'issueId'`,
reached through `getIssueRunSummaries` (`:861`). An issue with no run ever anchors
on `createdAt` — a card created two days ago that has never once had a run is the
most stalled thing on the board.

## Reporting contract

Two channels, deliberately different:

- **`metrics.write` — every firing, unconditionally.** A gauge that stops being
  written is indistinguishable from a gauge reading zero, so silence is never used
  to mean "nothing happened". `check-escalation-timeouts` on this box had 463 runs
  and 6 successes when the fact base was written (`docs/dispatch-plugin-facts.md`
  §7, 2026-08-30); re-measured a day later it is **680 runs and still 6
  successes**. A job can fire reliably for months and do nothing, and the gap
  widens silently — which is the entire argument for a per-firing metric.
- **`activity.log` — only on a state change.** The board is a human surface. A line
  every 30 minutes saying "nothing changed" trains people to stop reading the line
  that says something did. Idle milliseconds are excluded from the comparison
  because they change every firing by construction.

| Metric | Note |
|---|---|
| `dispatch.refused_backlog` / `refused_unassigned` / `refused_blocked` / `parked_on_named_owner` / `woken` | the five counters |
| `dispatch.candidates_ready` / `runnable_queue` | two of the three legacy script counters, so a firing is diffable against pasted script output during the parallel week |
| `dispatch.deadlocked_agents` | **not written at all** — see below |
| `dispatch.routing_gap` | net new; the script never reported it |
| `dispatch.wake_failures` | the number the gate turns on — it measures the mirror |

Every metric carries `wakeEnabled` as a tag, not just the wake ones: `woken = 0` is
otherwise ambiguous between "nothing needed waking" and "the waker is switched
off", and the gate is precisely a comparison across that boundary.

`deadlocked_agents` has **no native equivalent** (Q5). `metrics.write` takes a
number, so there is no way to write "unknown" — and writing `0` would assert a
measurement nobody made. An absent series reads as absent on a dashboard; a zero
series reads as a healthy zero. Only one of those is honest, so the series is not
written.

## Known gap: the plugin cannot wake a routing owner

Says the plugin "reports the routing gap and wakes a principal holding
`tasks:assign`". **It reports. It cannot wake them**, and this is a host fact, not
an omission:

- `issues.requestWakeup` is the **only** wake operation in the deployed
  `OPERATION_CAPABILITIES` map. `agents.invoke` is typed by the SDK but has no
  entry, and `checkOperation` rejects an unknown operation by default. Verified:
  `agents.invoke` → denied.
- Waking a principal therefore requires an issue **assigned to them** to wake —
  i.e. creating a board issue. That is a write this card does not take.
- The `tasks:assign` holders cannot even be fully enumerated. The server derives it
  from four branches (`routes/agents.js:506-546`); two of them need
  `access.listPrincipalGrants` / `access.getMembership`, and the deployed map has
  **zero** `authorization.*` and **zero** `access.*` operations out of 94.

What ships instead: the gap is counted (`dispatch.routing_gap`), the owners who
*can* be identified from `agents.read` are named — `role === "ceo"` and
`permissions.canCreateAgents` — and the return value carries `complete: false`
alongside them, because a list of names with no completeness flag reads as
exhaustive. The activity line says `no wake path, needs a human`.

Closing this properly needs either an `access.*` read capability on the plugin
surface or an issue-creation step. Both are decisions for the evidence-gate
review, not for this card.

## Configuration

Per-company, via `instanceConfigSchema` (ADR `0002` — plugins are instance-scoped
and **not** carried by a company export).

| Key | Default | Meaning |
|---|---|---|
| `wakeEnabled` | **`false`** | Off until the gate passes. While off, the real policy runs and reports what it *would* have woken, and `requestWakeup` is called zero times. |
| `idleMinutes` | `120` | Minutes since the last run scoped to that issue. |
| `maxWakesPerFiring` | `3` | The retired script used 2; ADR `0003` measured the genuinely actionable set at 3. |
| `focusProjectIds` | `[]` | Optional. Empty means the whole company, which is **wider** than the script's `scope: FOCUS ONLY`. |

The focus filter runs **after** the counters, so the five numbers always describe
the whole company and only the selection narrows. The script filtered before it
counted, which is how its output could read `candidates ready: 0` while the board
held stalls.

## Why `wakeEnabled` defaults to false, and why `issues.wakeup` is declared anyway

The design (Q1) buys the wake action with a week of evidence, not with an argument.
A default of `true` would make *installing* the plugin the thing that enables it —
exactly the step the retirement plan puts behind the gate.

But the capability is still declared, because **capabilities are static**. Adding
one later puts the plugin into `upgrade_pending` (PLUGIN_SPEC.md §15.3), so the
report-only week has to run with the eventual capability set already installed, or
it is evidence for a different program than the one that ships.

## Why there is no `database` capability

ADR `0003` requires idle measured against `heartbeat_runs`. The obvious route is
`ctx.db.query` against the whitelisted core table — but declaring `manifest.database`
requires `database.namespace.migrate` (`plugin-capability-validator.js`,
`FEATURE_CAPABILITIES`). A read-only reporter would have to hold a DDL capability
to do a `SELECT`. `getOrchestration` reaches the same rows through the same JSON
filter with a read-only capability, at the cost of one host call per assigned
issue. That is the better trade and the test suite asserts it stays that way.

## Install

Needs an operator; every step needs `uid 0`. The plugin is installed from a local
path, which per ADR `0002` no company export carries — so portability comes from
this being one reproducible command, not from where the code lives.

```bash
# 1. From a fresh clone of paperclip-ops-tooling:
cd plugins/dispatch
npm ci --include=dev        # --include=dev is REQUIRED: npm is configured
                            # omit=dev on this box (NODE_ENV=production), so a
                            # bare `npm ci` silently installs no SDK.
npm test                    # 43 tests, no network

# 2. Install via the board (agent keys get 403 Board access required):
#    point the plugin install at this directory. dist/ is hand-written source,
#    not build output — there is no build step.

# 3. Verify it reached `ready`, then LEAVE wakeEnabled UNSET.
#    Report-only is the whole point of the first week.
```

Before any activation of a deployed copy, run the authority gate from the repo
root — activation adopts the manifest from the package directory with no
capability-escalation check:

```bash
./plugin_manifest_gate.sh compare --deployed <deployed-path> \
  --reference-path plugins/dispatch/dist/manifest.js
```

**`--reference-path` is required, not optional.** It defaults to
`plugins/gh-token-broker/dist/manifest.js`, so the bare command compares dispatch
against a *different plugin* and reports 17 authority escalations that are just
the two manifests being two manifests. A red that means nothing is worse than no
check, because the next person learns to wave it through.

One thing to expect: this plugin is the first to declare `jobs[]`, and the gate's
authority allowlist does not classify that path — so a changed `schedule` or
`jobKey` scores as `ESCALATION: unclassified field`. That is the gate failing
**closed**, and it is the behaviour you want here: the firing cadence is the
plugin's blast radius, and `*/30` quietly becoming `*/1` is exactly the change
that should stop an activation.

## The gate

Do **not** flip `wakeEnabled` as part of installing this. Per the retirement plan
(`docs/tog-706-dispatch-plugin-design.md`, steps 2–3):

1. Run both systems in parallel for a week. The host timer keeps running unmodified.
2. Compare the plugin's report-only output against what the timer actually did.
3. If the plugin's selection would have covered the timer's real wakes, flip the
   flag. If not, the gap is a finding to fix **in the plugin** before enabling —
   not a reason to keep the timer indefinitely.
4. The timer is disabled, not deleted, and only after a second clean week.

`dispatch.wake_failures` is the number to watch: non-zero means the mirror of the
server's rails and the server's actual rails disagreed.

## Tests

```bash
node --test test/dispatch.test.mjs
```

Pass the **file**, not the directory — on Node 24 `node --test test/` resolves
`test` as a module specifier and dies before running anything.

The suite is in two layers, and the split is forced rather than chosen. The SDK's
`createTestHarness` returns a hard-coded `runs: []` and `invocationBlocks: []` from
`getOrchestration`, so **the idle rail and the budget rail cannot be reached
through `runJob` at all**. A suite that only drove the harness would report green
while never once executing the two rails this plugin adds. So the policy is tested
directly against hand-built populations, and the harness covers the wiring:
capability enforcement, company enumeration, the metric contract, the activity
threshold, the state round-trip and the wake gate.

Sensitivity is checked by mutation rather than asserted, and the check is a
committed script rather than a run someone did once:

```bash
verification/tog-747-mutation-gate.sh     # from the repo root
```

It breaks one load-bearing behaviour at a time and requires the suite to go red
for each: idle anchored on `updatedAt` or counting another issue's runs, rails 1
and 2 swapped, a `done` blocker still refusing, the park rail dropped, two picks
for one agent, `wakeEnabled` defaulted true, absent config reading as enabled,
`deadlocked_agents` fabricated as `0` or written as a metric, metrics suppressed,
activity logged unconditionally, idle ms folded into the state comparison, the
wake loop aborting on the first refusal, report-only waking, and one company's
failure aborting the sweep.

**21 mutants, 21 killed, 0 survivors** against the merged tree.

The gate guards itself, because a mutation harness that fails open is worse than
none: it aborts unless the baseline is green, reports a pattern that matched
nothing as a `BROKEN GATE` instead of a pass, and runs `node --check` on every
mutant so a syntax error is never miscounted as a caught mutation.

## Constraints this build holds to

- **No modification to PaperclipAI** — no patch, no file copied into `/app`, no
  host module.
- **No host-side cron, systemd unit, or script.**
- **Per-company config only** via `plugin_config` / `instanceConfigSchema`
  (ADR `0002`).

## Files

| Path | |
|---|---|
| `dist/manifest.js` | capabilities, the 30-minute job, `instanceConfigSchema` |
| `dist/selection.js` | the policy — pure, no host calls |
| `dist/reporting.js` | the two-channel reporting contract |
| `dist/worker.js` | the sweep: gather → decide → wake → report |
| `test/dispatch.test.mjs` | 43 tests |
