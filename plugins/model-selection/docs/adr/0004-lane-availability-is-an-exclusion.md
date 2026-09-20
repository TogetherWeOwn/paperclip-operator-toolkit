# ADR-0004 (plugin): Lane availability is an exclusion, not a preference

- **Status:** accepted
- **Date:** 2026-09-17
- **Card:** TOG-3132
- **Parent:** TOG-3108
- **Related:** TOG-3107 (pacer serviceability), TOG-3133 (the collector), TOG-811
  (producer-side cooldown contract), TOG-2137 (`tier-exhausted`)

## Context

`selectModel` chose between rostered rows on capability, cost, and pace. It had
no term for whether the lane behind a row could serve a request at all.

That is not the same as saying the plugin was blind to quota. Main already
carries a pace engine: `LaneLedger`, `laneVerdictFor`, `hardStopExcluded`,
`orderCandidatesByPace`. The gap is narrower and sharper than "no lane input":

1. The pace hard stop only runs when `pacingMode` is `shadow` or `enforce`. Off
   the mode, the ledger is not consulted and nothing is excluded.
2. `laneVerdictFor` is documented fail-neutral for a lane nobody polled
   (`pacing.ts:275`). An unpolled lane is silently indistinguishable from a
   healthy one. That silence is precisely the case AC-4 forbids.
3. The verdict has no field for cooldown, and no field for how many accounts
   are actually serving the lane. Both were measured causes of the outage this
   card descends from.

Two other facts made a preference-shaped fix inadequate. `health: "cooldown"`
reaches the router's *degraded* bucket, becomes an `avoid` posture, and stays
selectable (TOG-811). And a pure cooldown record carries no utilization field,
so the consumer collects zero evidence rows and fails open (TOG-1040). A lane
that is refusing every request was therefore both selectable and invisible.

## Decision

`SelectInput` gains an optional `availability: AvailabilitySnapshot`. A model
whose lane fails it is **excluded** — removed from the candidate set and
recorded as a `lane-availability` rejection — never merely down-ranked. This is
the discipline already stated for capability exclusions in ADR-0002 and encoded
at `types.ts:23-27`.

Four sources, each its own named term, so a trace can answer *which* one fired:

| term | source | rule |
| --- | --- | --- |
| `health` | the record's `health` | anything other than `healthy` excludes |
| `cooldown` | the record's `cooldown`, read independently of windows | excludes |
| `quota` | window utilization ≥ 1.0, or binding allowance ≤ 0 | excludes |
| `accounts` | serviceable account count | see below |
| `staleness` | `observed_at` age, `stale_after_seconds` | UNKNOWN, never a pass |
| `unmapped` | the row declares no `laneId` | UNKNOWN, never a pass |

Cooldown is read off the record, not off the windows, because the producer's
cooldown record is exactly the one that carries no windows.

Binding allowance mirrors the controller (`cliproxy_quota_controller.py:140-145`):
lowest `clear_rate` among `allowance`-role windows.

**A lane with one serviceable account is ineligible for fleet-default-scale
traffic at any quota level.** Remaining allowance does not make a single
account a fleet. `IssueDescriptor.trafficScale` distinguishes the two; it
defaults to `"issue"`, so the rule fires only where the card scoped it.

**Staleness is tri-state.** The cutoff is 120 minutes, the same number as
`pacing_verdict.py:75`, tightened per-record by `stale_after_seconds`. Past it
the lane is UNKNOWN, not unavailable and not available. An UNKNOWN is always
recorded on the decision and always said in the trace. By default it proceeds —
a blind instrument is not evidence of an outage — and `holdOnUnknownAvailability`
inverts that for an operator who prefers to stop.

An all-UNKNOWN tier returns **`held-at-floor`**, not `tier-exhausted`. The two
have different owners: `tier-exhausted` sends someone to the quota dashboards,
and a telemetry outage is not found there.

`lane-availability` is deliberately a *separate* stage from `lane-unserviceable`.
The latter is the pace engine's verdict; this one reads the quota-contract
document directly, is independent of `pacingMode`, and carries the three things
the verdict has no field for. Both are capacity, so both are in `CAPACITY_STAGES`
and both produce `tier-exhausted` when they empty a tier — without that widening,
a wholly availability-excluded tier would have degraded to `no-eligible-model`,
reporting a capacity outage as a config gap.

## Consequences

- The term is inert until a snapshot is supplied. With no
  `PLUGIN_STATE_KEYS.laneAvailability` document the report says
  `configured: false` and the trace says so. Absence is stated, not assumed.
- **The writer is `lane-capacity/availability-source.ts`, published from the
  five-minute lane poll** (`worker.ts`, `JOB_KEYS.pollLanes`). An earlier draft
  of this ADR deferred it to a follow-up card; no such card was ever cut, and
  the term would have shipped with a `state.get` and no `state.set` behind it —
  a gate present in every trace and enforcing on nothing. AC-2 is met by this
  writer, not by a successor.
  - It is built from `LanePaceObservation`, not the raw document, so the lane's
    own field mapping is applied once and both consumers read the same
    normalization. A lane the poll could not read contributes no record, which
    `select.ts` reports as `unmapped` → UNKNOWN.
  - The contract carries one `observedAt` for the whole document while lanes go
    stale independently, so each record's `stale_after_seconds` is reduced by
    that lane's own lag behind the poll and a lane already past its cutoff is
    dropped. Stamping the poll time alone would have handed a dead publisher
    the poll's freshness — the fail-open AC-4 exists to remove.
  - `health` is passed through verbatim when published, because
    `normalizeHealth` folds `cooldown` into `degraded`; both exclude, but only
    the raw spelling keeps AC-6's term attribution. An unreadable health is
    omitted rather than published as `"unknown"`, which the reader would treat
    as a hard exclusion instead of an UNKNOWN.
  - Cooldown is the one term no lane document publishes yet — the
    `subscription-pool` plugin is not in this repo and its state is not
    reachable from here. It is passed through from the published record when
    present, so the term goes live the moment a publisher emits it. Until then
    the cooldown shape is covered only where a lane reports `health: cooldown`.
    That gap is real and is not closed by this card.
- `decisions.jsonl` answers "why did this card not get opus" after the fact:
  every exclusion carries `modelId`, `laneId`, `term`, and a reason string, and
  `selectedOnUnknownLane` marks a winner chosen on an unreadable lane.
- `model_selection.lane_excluded.{term}` and `model_selection.lane_unknown_selected`
  make both visible without reading the stream.
- Out of scope, per the card: retry or fallback after a refusal, and *moving*
  the floor or changing `agents.adapterConfig.model`.
- **The floor decision itself is in scope, and is covered (AC-3).** TOG-3037
  landed on `main` while this branch was open and added a second exit that hands
  an untrusted-profile run back to the agent floor, testing that floor's lane
  against the pace predicates — all of which are gated on `paceActive`. The
  availability term is not gated on `pacingMode`, so it is evaluated there
  separately: a floor whose lane a published contract calls **unavailable** is
  declined in favour of an explicit pin to a winner that already cleared every
  gate. UNKNOWN does *not* decline the hold, matching `isLaneUnserviceable` —
  a blind instrument is not grounds to discard a recorded human judgement. This
  changes which model the floor exit yields; it never writes the floor.
- The floor never enters the candidate loop, so its exclusion is pushed onto the
  decision's live `availability.excluded` array explicitly — otherwise AC-6
  could not answer "why did this card not get opus" for the one path where the
  answer is "its own floor was dead".
- Sixteen named mutants in `scripts/mutation-gate.mjs` hold the discipline: the
  down-rank regression, the windows-gated cooldown read, the off-by-one account
  rule, the relaxed cutoff, the silent UNKNOWN, and the pace-only floor exit
  each have a mutant that the suite must kill — and five more cover the writer,
  including `availability-writer-emits-nothing`, which is the defect that made
  every one of the other eleven green against a key nothing wrote.
