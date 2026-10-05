# Lane withdrawal ceiling (`pacing.lanes[].withdrawAtUtilization`)

Refs: , finding from [](/TOG/issues/#document-shadow-agreement-v2).

## What it does

A lane with `withdrawAtUtilization` set is withdrawn from **new** dispatch once its
combined utilization is at or above that fraction. Its models are excluded through the
same path as an unserviceable lane (rejection stage `lane-withdrawn`, one trace line per
lane, never waived by an operator override, counted as capacity when it empties a tier,
which reports `tier-exhausted`). Off by default: a lane without the key is never withdrawn
and every existing config resolves exactly as before.

```jsonc
"pacing": { "lanes": [ { "laneId": "cliproxy-meta", "withdrawAtUtilization": 0.98, ... } ] }
```

The value is a fraction in (0, 1]. `validateConfig` rejects `0` (it would withdraw the lane
on every reading) and anything above 1 (it could never fire). The ceiling is config, never
a constant: the host moved the same rule from 0.95 to 0.98 inside a day.

## Why

The shadow comparison ( v2) found selector-vs-bridge T1 agreement at 100% while
the bridge picks MUSE and 0% whenever it withdraws MUSE. The selector keeps a lane open
while one account can serve (`hardStopExcluded`), throttles only an `ahead` lane
(`slotFactorFor`), and prefers a lane trailing pace near its reset
(`orderCandidatesByPace`). With 7 of 8 Meta accounts exhausted and one at 0.85 it still
sent every new T1 to Meta. No rule withdrew a lane that was nearly spent.

## Where it applies

- `selectModel`: the candidate loop (after the serviceability hard stop) and the agent-floor
  check.
- The sub-call surfaces that already ask "may new work go to this lane": the cheapest-healthy
  pick and the frozen-env evacuation in `context.ts`.
- The worker's `isUsableAndCapable`, the usability gate the label-only, repin and balance
  passes share. A pin on a withdrawn lane stops reading usable, so the **repin pass moves an
  idle card's pin off the lane** (a card with a running or queued run is outside that pass's
  candidate query), as it does for an unserviceable lane.

It does **not** evict work in flight: an issue already sticky to the lane keeps it in
`selectModel`, the same as for `lane-avoid`, and a card with a live run is never repinned.
It is evaluated only when pacing is not `off`.

## "Combined" utilization

The capacity-weighted mean of the lane's accounts' governing-window utilization, where an
account the pace engine calls **unserviceable counts as fully spent (1.0)**.

- Weights are the reported account weights when every contributing account has one, equal
  otherwise (mixing reported and defaulted weights would skew the mean).
- An account with no governing-window reading is left out (no evidence either way).
- Null, so no withdrawal, when no account contributes (free lane, unreadable lane).

### Why unserviceable accounts count as spent

`pace.ts` trips an account at `1 - margin`, so an exhausted account reads 0.99. The 21:48Z
Meta lane is seven exhausted accounts at 0.99 and one at 0.85. Its plain mean is 0.9725, under
a 0.98 ceiling, while one account with 15% left carries the whole lane. Counting the exhausted
accounts as spent gives 0.98125. Measured against the recorded T1 stream (2026-10-04, 579
`plugin-shadow` decisions joined to the bridge log, Meta-lane accounts present in all but the
oldest regime), with the ceiling the bridge was using in each regime:

| Bridge regime | Bridge picks | Its ceiling | Plain mean | Unserviceable = spent | Withdraws? |
|---|---|---|---|---|---|
| `muse_headroom_expires_first` | MUSE | 0.95 | 0.8762 - 0.9012 | 0.9163 - 0.9413 | no, both |
| `muse_collective_95` | gpt-6.1-sol | 0.95 | 0.9537 - 0.9550 | 0.9612 - 0.9625 | yes, both |
| `meta_weekly_below_98` | MUSE | 0.98 | 0.9575 - 0.9688 | 0.9650 - 0.9775 | no, both |
| `claude_5h_below_98` | claude-sonnet-5-5 | 0.98 | 0.9725 | **0.9812** | **plain: no. spent: yes** |

Only the "spent" reading reproduces the bridge's regime boundaries with the bridge's own
numbers. The bridge log's `meta_combined` agrees at the tail (0.981 at 22:01Z against 0.9812).

### What is not known

The live bridge script has not been mirrored (`/paperclip/shared/host-bridge/fleet_quota_balancer.py`
is dated 2026-10-03 18:12Z; the live reasons and `meta_combined` field are not in it). This
definition is the best-supported reading of the evidence, not a port, and the margins are
narrow: 0.0025 below the ceiling in the MUSE regime, 0.0012 above it in the withdrawal regime.
Earlier in the weekly regime the bridge's `meta_combined` tracked the plain mean (0.958 against
0.9575), so its own source is finer than the CLIProxy lane document, not identical to either
reading. When the Operator refreshes the mirror, confirm the definition against the script
before the ceiling is set live.

## Persistence

The reading is stored on the lane ledger (`combinedUtilization`) from a verdict a poll actually
returned, and carried across failed polls and verdicts with nothing to read. A flapping poll
must not move a withdrawn lane back to admissible (the  failure shape). It stops
counting when the earliest contributing account's window resets, because the rollover, not the
clock, is what makes it wrong.

## Replay

`tests/withdrawal-replay.spec.ts` replays 23 T1 decisions cut from the recorded
population (`tests/fixtures/withdrawal-replay/t1-records.json`, spread over the four regimes
above). Each record carries the Meta lane's recorded accounts and the selector's usable
candidates; the replay rebuilds the lane verdict with the real pace engine, merges it as the
poller does, and runs the real `selectModel` with the ceiling the bridge was using then.

- Baseline, no ceiling: the replay picks exactly what the recorded stream picked (MUSE, 23/23).
- Withdrawal regimes: the lane is withdrawn on every record, zero MUSE picks.
- MUSE regimes: every pick unchanged.
- One ceiling does not fit both regimes: 0.95 would withdraw MUSE during the 0.98 regime.

### Residual, not fixed here

Removing MUSE does not by itself give agreement in the `claude_5h_below_98` regime. The replay
picks gpt-6.1-sol there (cost order, $1.90 against $2.41), the bridge sets claude-sonnet-5-5.
In `muse_collective_95` the replay and the bridge both pick gpt-6.1-sol. The bridge prefers
PRIMARY while a Claude account is under its 5h hold; the selector has no such preference. That
is a separate rule and a separate card; the "T1 agreement >= 95% in both regimes" bar from the
report is not met by this change alone.

## Applying it live (not done here)

This change writes no live config. To turn it on, the flip vehicle ( pattern: board
config POST, second snapshot deep-equal, restore the `laneId` bindings the POST deletes,
re-poll lanes, readback) adds `"withdrawAtUtilization": 0.98` to the `cliproxy-meta`
`pacing.lanes` entry. Roll back by removing the key.

## Tooling

`scripts/bridge-agreement.mjs` is the  agreement script, productized: read-only, joins
`plugin-shadow` decisions to `fleet-quota-balancer.log` (last bridge line at or before each
`ts`), prints agreement by bridge regime, tier and hour, and the expressible count that
separates a roster gap from a policy gap.

```
node scripts/bridge-agreement.mjs [--shadow-dir DIR] [--bridge-log FILE] [--tier T1|T2|T3|all]
                                  [--include-legacy] [--since ISO] [--until ISO] [--json]
```

Differences from the paste-in: tier defaults to T1 (the python printed all tiers together),
torn JSON lines are counted instead of crashing the run, and an unreadable or empty input exits
2 instead of printing a clean-looking zero.
