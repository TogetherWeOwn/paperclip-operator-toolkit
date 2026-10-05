# ADR-0006 (plugin): The dead-lane veto is poll-based and fails open on a fleet-wide outage

- **Status:** accepted
- **Date:** 2026-10-04
- **Card:** 
- **Spec:**  (D1e); follow-up of 
- **Related:**  (pacer serviceability),  / ADR-0004 (lane
  availability),  (the poller-side API slowness this ADR defends
  against)

## Context

A lane that never serves a request kept taking cards. Two instruments could
condemn it and neither covered the gap:

1. The pace hard stop (`hardStopExcluded`) reads the lane's verdict. A lane
   whose polls all fail has no fresh verdict to read, so it is not excluded.
2. The Wilson-bound evidence term (`lane-evidence`) reads heartbeat *runs*. A
   lane that takes no runs produces no evidence, so it is never condemned.

The lane-capacity poll already records every poll outcome. Nothing consumed
the run of failures.

## Decision

`LaneLedger` entries carry `consecutiveNonSuccess`. A poll **succeeds** only
when `error === null` and `verdict.serviceable === true`. Any other poll
(error, `serviceable === false`, null verdict, `lane-secret-unavailable`)
increments the streak; any success resets it to zero. A ledger written before
this field existed reads as zero, so no migration and no mass veto on upgrade.

`lane-dead-veto` is a new stage. A lane whose streak reaches
`DEAD_LANE_VETO_NON_SUCCESS_POLLS` (5) is **excluded** at the same gate
position as `lane-unserviceable`, never down-ranked. Five matches
`EVIDENCE_ZERO_SUCCESS_SAMPLES`: the same evidence weight that condemns a lane
on run outcomes condemns it on poll outcomes. The two constants are separate so
they can be retuned apart.

The stage joins `CAPACITY_STAGES`. A tier emptied by the veto is
`tier-exhausted`, which raises the operator card, and not
`no-eligible-model`, which would report a capacity outage as a config gap.

The veto is **inert or fail-open** wherever evidence is missing:

| condition | result |
| --- | --- |
| `pacing.mode` is `off` | veto does not run |
| no ledger, or no entry for the lane | not vetoed (never polled is not dead) |
| model has no `laneId` | not vetoed |
| configured lane set absent (`configuredLaneIds`) | not vetoed |
| lane not in the configured set | not vetoed |

### Fail open when every configured lane is dead at once

A poller-side fault hits every lane in the same window: the  API
slowness, or `lane-secret-unavailable`. Read as per-lane death it would veto
the whole fleet and stop dispatch through `tier-exhausted`. When **every**
configured lane meets the dead condition in the same window,
`allLanesDeadVetoed` is true and selection admits as today.
`decision.deadVeto.bypassedAllDead` says so on the decision and in the trace,
and the worker raises one `Operator: lane poller suspect` card for the issue.
That card has its own state key (`deadVetoPollerAlarms`) and its own one-card
per streak dedup, separate from `tierExhaustedAlarms`: a bypass streak and an
exhaustion streak answer different owner questions, and sharing a key would
suppress one while the other ran. A configured lane that was never polled has
no streak, so it blocks the bypass: dispatch still has somewhere to go.

## Consequences

- A dead lane stops taking cards after five polls. It returns on the first clean
  success, with no operator action.
- **Nothing here writes a pin, a floor or `agents.adapterConfig.model`.** A pin
  or sticky incumbent whose lane is dead-vetoed falls through at read time, the
  same Defect-6 discipline as `lane-unserviceable`. The all-dead bypass does not
  apply to a pin read: a pin that cannot serve is not saved by the poller being
  suspect.
- `decisions.jsonl` carries `deadVeto.bypassedAllDead` on every decision, so a
  silent gate is distinguishable from a broken one. Metrics:
  `model_selection.lane_excluded.dead-veto` and
  `model_selection.dead_veto_bypassed_all_dead`.
- Evidence strength: the gap is read in code (OBS). No measured misroute has
  been attributed to a never-verdict lane (HYP). The post-deploy live probe is
  recorded on .
- Seven named mutants in `scripts/mutation-gate.mjs` hold the discipline, each
  breaking one half of a behavioural pair. They include
  `dead-veto-error-with-stale-verdict-resets`: a poll that errors while a stale
  `serviceable` verdict is still on the entry must count as a non-success, and
  the first draft of the suite did not pin it.
