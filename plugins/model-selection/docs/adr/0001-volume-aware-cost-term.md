# ADR-0001 (plugin): Order candidates on a measured volume-aware cost term

- **Status:** accepted
- **Date:** 2026-08-31
- **Upstream:** ADR-0002 (cost structure), ADR-0004 (tiers), ADR-0005 (quality floor)

## Context

The card asks for a "volume-aware cost term". The obvious implementation is the
one the reference engine already has —
`paperclip-model-router/src/engine/select.ts:70-77` costs a candidate as

```
cost = estimatedInputTokens * rateIn + estimatedOutputTokens * rateOut
```

with 8,000 / 2,000 token defaults and **no cache-read term at all**.

That is a correct model of a single API request. It is not a model of a harness
run, which is multi-turn and re-reads a growing prompt cache on every turn.

Measured against this company's own `heartbeat_runs`, 7 days to 2026-08-31
(reproduce with `npm run profiles:refresh`):

| model | runs | avg input | avg cache read | avg output | avg $/run |
|---|---|---|---|---|---|
| `claude-opus-5` | 214 | 510,327 | 6,081,872 | 55,532 | $7.1576 |
| `claude-sonnet-5` | 103 | 320,286 | 4,336,432 | 44,712 | $3.0940 |
| `claude-haiku-4-5-20251001` | 13 | 81,085 | 819,445 | 5,112 | $0.1958 |

Cache-read volume is 10–13× input volume at every tier, and cache read is 44% of
the opus bill (ADR-0002).

Two spreads matter for ordering:

- **price** spread across the roster: ~5.2×
- **volume** spread across the roster: ~6.1×

An engine using the reference cost term orders on the price term while being
blind to the volume term. It gets the smaller lever right and the larger one
wrong.

## Decision

Cost a candidate as **three measured token totals against three separate rates**:

```
runCost = avgInput     * rateIn
        + avgCacheRead * rateCacheRead
        + avgOutput    * rateOut
```

where the three token totals come from a `VolumeProfile` computed from *our own
runs at that tier*, refreshed on a schedule, not from a per-request estimate.

Three consequences follow, and all three are load-bearing:

1. **Cache read is a first-class term.** It is not folded into input, and a
   config with `costPerMTokCacheRead: 0` raises a validation warning, because a
   zero rate makes the largest cost line free and orders candidates on the wrong
   term entirely.

2. **Expected cost prices being wrong.** ADR-0005's break-even arithmetic is made
   explicit rather than left as a threshold: an escalation means the cheap run
   happened *and* the expensive run happened, so the penalty is a full run at the
   tier above, weighted by the escalation rate measured on our own data. A silent
   quality failure counts 10× an escalation — it is invisible by construction,
   which is precisely why it must be priced rather than merely watched.

3. **An untrusted profile stops the engine.** Fewer than 5 runs, older than 14
   days, or absent → outcome `held-at-floor`; the issue stays on its agent's
   floor and nothing is written. Guessing the volume term is the specific failure
   this plugin exists to avoid, so the engine refuses rather than improvises.

## Scope boundary

This ADR is about **ordering candidates correctly**, not about reducing the
cache-read bill. Cache read is 44% of opus spend and a larger lever than model
choice, but per ADR-0002/Q10 it is a separate follow-up card. This plugin
*measures* cache-read volume because ignoring it would order candidates wrongly.
It does not attempt to reduce it.

## Consequences

- The engine cannot run at all on a fresh install until profiles exist. This is
  intended, and it is why `holdOnUntrustedProfile` defaults to `true`.
- The numbers are a **rolling 7d window**. `tests/fixtures.ts` is a snapshot,
  re-derived 2026-08-31; re-running the measurement later will not reproduce the
  digits. The ratios are the durable part.
- Every rate in config is `$/Mtok` recovered from our own `heartbeat_runs` by
  solving `usage_json.costUsd` against token counts — not a vendor list price.
- The volume term is per **tier**, not per model. A model is priced at the volume
  its tier actually consumes, which is what makes cross-tier comparison honest.

## Alternatives considered

- **Use the reference cost term as-is.** Rejected: blind to the larger of the two
  levers, as measured above.
- **Add cache read as a multiplier on input.** Rejected: the ratio is not stable
  across tiers (10.1× to 13.5× here, and 42.9× on one non-roster model), so a
  single multiplier would be a guess wearing a measurement's clothes.
- **Estimate volume per issue instead of per tier.** Rejected for this stage:
  there is no per-issue signal on the board that predicts token volume, so this
  would reintroduce exactly the inference the design forbids. Per-tier averages
  over ≥5 runs are defensible; a per-issue guess is not.
