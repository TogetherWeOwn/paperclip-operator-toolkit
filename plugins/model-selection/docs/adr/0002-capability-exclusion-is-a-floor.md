# ADR-0002 (plugin): Capability exclusions use the T1 floor

- **Status:** accepted, corrected 2026-09-10
- **Original date:** 2026-08-31
- **Original card:** TOG-768
- **Correction:** TOG-2134

## Context

The original plugin encoded `T1 < T2 < T3`, while the reviewed company roster
and task labels use `T3 < T2 < T1`: T1 is the most capable tier. That inversion
made the old special-case exclusion floor internally coherent but externally
unsafe. The plugin's live-config reproduction routed credential-excluded work
to Luna because `resolveTier` returned T3 and the selector treated T3 as the top.

## Decision

All recorded tiers are minimum capability requirements. The canonical order is:

```text
T3 mechanical < T2 ordinary engineering < T1 judgement / sensitive work
```

A capability or credential exclusion resolves to T1 before selection. The normal
tier floor then rejects every T2/T3 row. The same floor also applies to sticky
models: a warm lower-tier session cannot override a stronger recorded judgement.

Disabled rows are filtered before both ordinary and fallback-only selection.

## Consequences

- A `tier:T1` card and an exclusion-sourced card have the same admission floor.
- A `tier:T2` card may use T2 or T1, never T3.
- `tier-floor` remains a distinct rejection stage in the audit trail.
- The selector no longer has a separate cost-ceiling path to reinterpret tiers.
- The reviewed live-config fixture and the named inverted-order mutant guard the
  corrected semantics.

## Exclusion input

The exclusion answer is supplied, never inferred from issue text. It records a
capability boundary such as credentials, permissions, spend, or irreversible
work; the selector only enforces that recorded decision.
