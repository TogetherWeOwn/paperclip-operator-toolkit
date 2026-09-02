# Model Selection (Stage 3)

Chooses the cheapest fully-capable model for each harness run, keyed on a
**recorded tier judgement** and ordered by a **volume-aware cost term** measured
from this company's own runs.

Built per TOG-768 against the TOG-734 design, ADR-0002/0004/0005/0008/0010 and
the Round-4 record.

---

## What it is, in one paragraph

An issue carries a tier judgement that a human or an agent recorded at assignment
time. This plugin reads that judgement, works out which models are actually
capable of the work, prices each one against **our own measured token volume at
that tier**, and pins the cheapest survivor onto the issue via
`assigneeAdapterOverrides`. It writes nothing at all until an operator flips
`selection.mode` to `enforce`.

## What it deliberately is not

- **It does not classify.** The tier key is read, never inferred (ADR-0007 /
  ratified Q8-a). The only classifier here is the *absence* of a judgement, which
  falls back to a configured default tier.
- **It does not touch System 2.** ADR-0010 separates System 1 (host-owned agent
  model resolution) from System 2 (the router plugin's routed-invocation table).
  This plugin actuates System 1 through `issues.update` and takes no
  `agents.managed` capability. It never edits an agent row.
- **It does not price cache-read reduction.** Cache read is 44% of the opus bill
  and a larger lever than model choice — it is tracked on its own follow-up card
  (ADR-0002/Q10), not here. This plugin *measures* cache-read volume because
  ignoring it would order candidates wrongly; it does not try to reduce it.
- **It is not the invoke plugin.** `paperclip-model-router/src/engine/select.ts`
  was referenced for shape only. It is not used as an actuator.

---

## The volume-aware cost term, and why

The reference engine
(`paperclip-model-router/src/engine/select.ts:70-77`) costs a candidate from
`estimatedInputTokens` / `estimatedOutputTokens` with 8,000 / 2,000 defaults and
**no cache-read term at all**. That is a single-request model. A harness run is
multi-turn.

Measured on this company's own `heartbeat_runs`, 7d to 2026-08-31
(`npm run profiles:refresh`):

| model | runs | avg input | avg cache read | avg output | avg $/run |
|---|---|---|---|---|---|
| `claude-opus-5` | 214 | 510,327 | 6,081,872 (11.9× input) | 55,532 | $7.1576 |
| `claude-sonnet-5` | 103 | 320,286 | 4,336,432 (13.5× input) | 44,712 | $3.0940 |
| `cliproxy/claude-haiku-4-5-20251001` | 13 | 81,085 | 819,445 (10.1× input) | 5,112 | $0.1958 |

Cache-read volume is an order of magnitude larger than input volume at every
tier. So:

- the **price** term across our roster has a measured ~5.2× spread;
- the **volume** term has a measured ~6.1× spread.

An engine built on the reference cost term gets the smaller lever right and is
blind to the larger one. `src/engine/cost.ts` fixes exactly that: cost is three
measured token totals against three separate rates, and the totals come from
*our runs at that tier*, not from a per-request guess.

**Expected cost also prices being wrong.** ADR-0005's arithmetic is made
explicit rather than left as a threshold: an escalation means the cheap run
happened *and* the expensive run happened, so the penalty is a full run at the
tier above, weighted by the escalation rate measured on our own data. A silent
quality failure counts 10× an escalation, because it is invisible by
construction and therefore has to be priced rather than merely watched.

**When the profile cannot be trusted, the engine refuses.** Under 5 runs, older
than 14 days, or missing entirely → outcome `held-at-floor`, and the issue stays
on its agent's floor. Guessing the volume term is the specific failure this
plugin exists to avoid.

---

## Two safety properties worth naming

### A capability exclusion is a floor, not a ceiling

A judged tier is normally a cost **ceiling**: cheaper models are allowed, and the
cost sort picks among them. A capability exclusion is the opposite — it is a
**floor**, and it never yields.

This mattered concretely. `resolveTier` returns T3 for capability-excluded work.
Read as a ceiling, T3 admits *every* cheaper model and the cost sort then picks
the cheapest one — the exact inversion of what the exclusion is for. ADR-0004's
boundary is capability, not difficulty, so the floor now holds in three places
(`src/engine/select.ts`): the qualification loop, the sticky path, and a
dedicated `tier-floor` rejection stage. It does not yield to cost, to sticky, or
to a lifted ceiling.

The test suite caught this. It is covered by three tests in
`tests/select.spec.ts`.

### Never re-pin a live issue

A mid-flight model change fires `shouldResetTaskSessionForModelChange`
(`heartbeat.ts:5127-5133`), which discards the warm prompt cache — the single
largest cost line we have. So:

- an issue that already carries `assigneeAdapterOverrides` is never re-pinned;
- the model already running an issue is sticky, and wins over a cheaper one;
- but sticky **loses** to a capability floor. A cost preference never overrides
  a safety constraint.

If a tier turns out wrong, that is a finding for the *next* issue's labelling,
not a reason to re-pin this one.

Related: we pin `adapterConfig.model` directly and never use
`modelProfile: "cheap"`, which carries `effort: ""` and puts the adapter default
first in the merge (`heartbeat.ts:3523-3525`) — the known ACP `effort` outage
path.

---

## Rollout

**This plugin ships inert.** Defaults are `mode: "advise"`, `defaultTier: "T3"`,
`holdOnUntrustedProfile: true`. Installing it changes no live selection variable.

Per the TOG-768 constraint, enforcement must not be switched on until Stage 2
(`tier:T1/T2/T3` labels + narrow-slice rollout) is confirmed stable. **Never
change two live selection variables in one measurement window** — if
enforcement flips while the Stage 2 slice is still moving, neither result is
readable.

**Measured Stage 2 state as of 2026-08-31 (TOG-768 review):** the three company
labels `tier:T1` / `tier:T2` / `tier:T3` exist (created 07:38:46Z), but **0 of
300 issues carry any tier label** — every issue returns an empty `labels` and
`labelIds`. Stage 2 is *created*, not *rolled out*. Consequences, both by design:

- `resolveTier` never reaches step 3 (the label branch) on today's board. Every
  issue resolves at step 4 (`agent-floor`) or step 5 (`config-default` → `T3`).
- Of 7 issues carrying `assigneeAdapterOverrides`, 5 use the shape
  `{"modelProfile": "cheap"}` — which has **no** `adapterConfig.model`. That
  yields `pinnedModelId: null` (so step 2 does not fire) while still setting
  `hasOverride: true`, so `planApply` refuses to write. Conservative in both
  directions, and the intended behaviour, but worth knowing: on this board the
  tier key is currently the *agent floor*, not a recorded per-issue judgement.

So the Stage 2 gate below is not close to satisfied. There is no measurement
window to protect yet, because no tier label has ever been applied to anything.

Order of operations:

1. Install with `mode: "advise"`. Nothing is written.
2. Let the `refreshVolumeProfiles` job populate profiles (every 6h; needs ≥5 runs
   per tier).
3. Call `model_selection_advise` and read the decisions and traces. Every
   decision carries a full `trace` and a `rejections` list saying which model was
   dropped at which gate and why.
4. Confirm Stage 2 stable. **Concretely**: a non-zero, deliberately-labelled
   slice of issues carries `tier:*`, applied by a human or agent at assignment
   time, held across at least one measurement window without being re-labelled.
   The check is one query — count issues with a `tier:*` label; today it returns
   0, so this step currently fails outright rather than being a judgement call.
5. Only then set `mode: "enforce"`.

### Config

See `src/config/schema.ts`. Every number that decides anything lives in config,
so the same input gives the same output on every run.

`tierLabelIds` is worth a note: it maps each tier to a **company label id**, and
it is operator-supplied because the plugin genuinely cannot look one up. There is
no label surface anywhere in the plugin SDK, and `labels` is absent from
`PLUGIN_DATABASE_CORE_READ_TABLES`, so a name→id query is rejected outright by
`assertAllowedPublicRead` (`plugin-database.ts:157-168`). Leaving it unset is
supported — the override is still written, just without the label, which is
additive information rather than a gate (ADR-0008).

---

## Typed narrower than the host

Three places where the SDK's types are narrower than what the host actually
accepts, each deliberate and each verified against host source rather than
assumed:

1. **`assigneeAdapterOverrides` is missing from `PluginIssuesClient.update()`'s
   patch type**, but it is a real `issues` column
   (`assignee_adapter_overrides jsonb`, checked against the live DB) and the host
   bridge spreads the patch verbatim into `issues.update`
   (`plugin-host-services.ts:1901-1938` → `issues.ts:7440`). `IssueUpdatePatch`
   in `src/worker.ts` is intentionally wider than the SDK's type.

2. **`issues.update` REPLACES the label set.** `syncIssueLabels`
   (`issues.ts:4835-4852`) deletes every `issue_labels` row for the issue and
   re-inserts exactly the ids supplied. Sending `labelIds: [tierLabelId]` alone
   would silently strip every other label off the issue, so the patch unions with
   the existing ids — which `ctx.issues.get` already returns via `withIssueLabels`
   (`issues.ts:1826-1842`). Covered by a test.

3. **`ctx.db` is inert without a declared namespace.** `ensureNamespace` returns
   null unless `manifest.database` is present, and `getRuntimeNamespace` then
   throws (`plugin-database.ts:469-471`, `413-419`). Declaring the namespace is a
   precondition for reading `heartbeat_runs` at all, even though this plugin owns
   no tables — hence a migrations directory containing only a README (see
   `migrations/README.md`; an empty *directory* is fine, an empty `.sql` *file*
   throws). The host's zod validator also pairs `database.namespace.migrate` with
   `database.namespace.read` unconditionally, so the migrate capability is
   declared and never exercised.

`ctx.data` is **not** a data namespace — it is the UI getData registrar
(`PluginDataClient` is only `register()`). The real clients hang off the context
root: `ctx.issues`, `ctx.agents`, `ctx.companies`, `ctx.db`, `ctx.state`, ….

---

## Verification

```
npm run verify     # typecheck + tests + build
npm test           # 59 tests across 6 files
npm run build      # esbuild → dist/manifest.js, dist/worker.js
npm run profiles:refresh   # re-measure volume from heartbeat_runs (needs DATABASE_URL)
npm run gate:stage2        # Stage 2 gate as a count; exit 1 = do not enforce
```

`gate:stage2` is the shipping constraint expressed as code rather than as a
sentence somebody re-reads. It counts issues actually carrying a `tier:*` label
and exits non-zero when that count is below the threshold, so "is Stage 2
stable?" stops being a judgement call. Run it before any config change that sets
`mode: "enforce"`. As of 2026-08-31 it exits 1 (0 labelled issues of 300).

`tests/worker.spec.ts` boots the plugin through the SDK's in-memory harness and
executes the registered tools end to end, including a check that the built
manifest passes the **host's own** `pluginManifestV1Schema`. That check is not
decorative: it caught a camelCase `routeKey` and a missing
`database.namespace.migrate` capability, either of which would have failed the
install.

### What has NOT been verified

There is no live host to install against in this environment. Specifically:

- the plugin has never been installed, and the `assigneeAdapterOverrides` write
  path is proven by source-tracing plus a live column check — **not** by an
  executed write against a real issue;
- `coreReadTables` enforcement and namespace activation are traced through host
  source, not observed at runtime;
- the `refreshVolumeProfiles` job is exercised against the harness's in-memory
  db, not against real Postgres. The equivalent query *has* been run by hand via
  `scripts/refresh-volume-profiles.mjs`, which is where the table above comes
  from.
