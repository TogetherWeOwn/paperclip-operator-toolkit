# ADR-0003 (plugin): `config/reviewed-roster.json` supersedes `tier_roster.json`

- **Status:** accepted
- **Date:** 2026-09-14

## Context

Before this plugin existed, model routing read from three independent
sources: `tier_dispatcher.py`'s own logic, the standalone `dispatch` plugin,
and a hand-edited roster file on the host, `tier_roster.json`
(33 canonical models, each carrying dated owner-rule notes — the durable
record of decisions like "GLM only via Z.ai, never OpenCode Go" or lane
credit caps). `tier_dispatcher.py` and `model_scores.py` both load this file
directly from that host file.

The consolidation's acceptance criterion 3 requires that no file under the
company's host-side operations directory participate in routing once the plugin
is live. A plugin that ported the dispatch logic but kept reading the host
roster file would fail that criterion by construction — it would just move
where the *code* lives while the *data* dependency stayed put.

## Decision

`config/reviewed-roster.json`, checked into this repo, is the single
catalogue the plugin's selection engine reads (`src/config/resolve.js`,
`tests/live-config.spec.ts`). It was built by auditing every row of
`tier_roster.json` (the "Audit" pass, 2026-09-13) and is a strict
superset: 84 entries against the legacy file's 35, including every canonical
model id and every dated owner-rule note the legacy file carried, preserved
as a verbatim substring. The bare `glm-5.3` T2 and `glm-5.3-flash` T3 rows
remain enabled because they are the canonical Z.ai subscription-pool routes.
Their reviewed notes explicitly forbid OpenCode Go; additive assembly binds
new bare GLM rows to `cliproxy-zai` and fails closed when that lane is absent.

The reviewed catalogue carries no `laneId` — lane binding is a live-merge-time
concern, handled additively by `scripts/assemble-additive-config.mjs` against
whatever is deployed in a given company (see README "Config"), never baked
into the checked-in catalogue.

`tests/roster-consolidation.spec.ts` is the permanent proof of this
supersession, run against a frozen snapshot of the legacy file
(`tests/fixtures/tier_roster.snapshot.json`, taken 2026-09-14) rather than a
live read of the host path — the plugin's test suite must not depend on
host-side company files any more than its runtime does. The test
asserts: every legacy canonical id is present, every legacy dated note is
preserved verbatim, no `enabled`-state divergence exists beyond the two
documented corrections, no `cliproxy/` wrapper id leaks into the checked-in
catalogue, and no row carries a premature `laneId`.

## Consequences

- The plugin's selection decisions no longer depend on the host's
  `tier_roster.json` at all — satisfies acceptance criterion 3 for the roster
  data source specifically.
- `tier_roster.json` itself, and the host processes that still read it
  (`tier_dispatcher.py`, `model_scores.py`), remain on disk and running until
  the operator retires them; this ADR documents that the
  plugin-side elimination is complete and does not itself stop the host
  script.
- A future edit to `reviewed-roster.json` that silently drops a canonical
  model or an owner's dated rule fails `tests/roster-consolidation.spec.ts`,
  not just a future manual diff.
- If `tier_roster.json` is edited on the host after 2026-09-14, the frozen
  snapshot will not reflect that change; this ADR's guarantee is "audited and
  superseded as of the audit pass," not "continuously synced." Any future
  host-side roster edit should be re-audited into `reviewed-roster.json`
  directly, since the host file is being retired, not kept as a parallel
  source of truth.
