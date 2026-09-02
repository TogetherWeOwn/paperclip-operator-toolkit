# ADR-0002 (plugin): A capability exclusion is a tier floor, not a ceiling

- **Status:** accepted
- **Date:** 2026-08-31
- **Card:** TOG-768
- **Upstream:** ADR-0004 (three-tier taxonomy; T1 is bounded by capability, not difficulty)

## Context

The selection engine treats a judged tier as a **cost ceiling**: the judgement
says "T2 is enough for this", cheaper models are therefore permissible, and the
cost sort picks the cheapest one that clears the capability and context gates.
That is the right reading for an ordinary judgement — it is what makes the plugin
save money at all.

A capability exclusion is a different kind of statement. Per ADR-0004, T1 is
bounded by **capability, not difficulty**: it excludes anything touching money,
credentials, fleet config, or an irreversible action, however mechanically simple
that work looks. `resolveTier` expresses an exclusion by returning T3.

Read as a ceiling, T3 means "T3 or below is fine" — which admits *every* model on
the roster, and the cost sort then picks the cheapest one. The exclusion, whose
entire purpose is keeping that work off a cheap model, ends up guaranteeing the
cheapest model gets it.

This was not hypothetical. The test
`"never selects below the tier a capability exclusion forces"` failed with:

```
expected 'cliproxy/claude-haiku-4-5-20251001' to be 'claude-opus-5'
```

Credential-rotating work had been routed to haiku by the cost sort.

## Decision

An exclusion-sourced judgement sets a **floor**, not a ceiling, and the floor
never yields.

```ts
const floor: Tier | null =
  judgement.source === "capability-exclusion" ? judgement.tier : null;
```

Enforced in three places in `src/engine/select.ts`:

1. **The qualification loop** — any model below the floor is rejected before the
   context-window check.
2. **The sticky path** — an incumbent model below the floor is declined, even
   though switching costs a session reset and a discarded prompt cache. Sticky is
   a cost preference; the floor is a safety constraint, and the constraint wins.
3. **The rejection taxonomy** — a distinct `tier-floor` stage, so a floor
   rejection is never confused in the audit trail with a `tier-ceiling` cost
   preference.

`planApply` re-checks the exclusion independently at the last point before a
write, so a bug upstream of the engine still cannot pin excluded work to a cheap
model.

## The general rule

> A ceiling is a preference and yields to a hard requirement.
> A floor is a constraint and yields to nothing — not to cost, not to sticky,
> not to a lifted ceiling.

The engine already lifts the ceiling when nothing at or below the judged tier is
capable (a cost preference must never silently drop a capability requirement).
The floor is the mirror image, and the asymmetry is the point: lifting is safe in
one direction only.

## Consequences

- Capability-excluded work is more expensive by construction. That is the trade
  the exclusion is buying.
- `tier-floor` rejections appear in the decision record, so an operator can see
  exactly which models were withheld and why.
- Covered by three tests in `tests/select.spec.ts`: the original selection case,
  sticky declining below the floor, and the full set of `tier-floor` rejections.

## Note on the exclusion input

The exclusion answer is **supplied**, never inferred. No text classifier can read
"does this touch money, credentials, fleet config, or an irreversible action" off
an issue title, and a classifier that got it wrong would fail in the one
direction that matters. The manifest's tool schema takes `exclusion` as an
explicit caller-provided object; absent it, no floor is set and the ordinary
ceiling logic applies.
