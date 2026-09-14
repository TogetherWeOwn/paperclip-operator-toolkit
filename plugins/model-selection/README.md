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
| `claude-haiku-4-5-20251001` | 13 | 81,085 | 819,445 (10.1× input) | 5,112 | $0.1958 |

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

### T1 is the most capable tier

The tier order is `T3 < T2 < T1`. A recorded tier is a minimum capability
requirement: a T2 card may use a T2 or T1 roster row, but never T3. A capability
exclusion resolves to T1 before selection, so sensitive work uses the same
all-path floor as an explicit `tier:T1` label.

The floor holds in the qualification loop and the sticky path. It does not yield
to price or to a warm session. Disabled rows are removed before normal and
fallback selection.

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

**This plugin ships inert.** Defaults are `mode: "advise"`, `defaultTier: "T1"`,
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
  issue resolves at step 4 (`agent-floor`) or step 5 (`config-default` → `T1`).
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

### Paired host/plugin decision evidence

`shadowEmit.enabled` is off by default. When enabled, every authoritative
`advise()` decision appends two `tog2138-decision-v1` records to
`shadow-decisions/decisions.jsonl`: one tagged `writer: "host"` and one tagged
`writer: "plugin-shadow"`. Both projections come from the same decision object,
timestamp, lane ledger, candidate roster, and state fingerprint. This supplies
the comparison stream without restoring the host `tier_dispatcher.py` retired
by TOG-2481 or adding a second actuator.

A bounded interval can be split by writer without copying or changing records:

```bash
jq -c 'select(.writer == "host")' decisions.jsonl > host.jsonl
jq -c 'select(.writer == "plugin-shadow")' decisions.jsonl > shadow.jsonl
python3 "$COMPANY_ROOT/ops/tog-2138/gate_harness.py" agreement \
  --host host.jsonl --shadow shadow.jsonl --out agreement.json
```

The agreement command deliberately remains nonzero until the separate
48-hour/200-decision clean-window gate is satisfied. For a reproducible bounded
comparison (maximum 24 hours), use the repository-pinned consumer through:

```bash
npm run decisions:summary -- \
  --input decisions.jsonl \
  --start 2026-09-14T00:00:00Z \
  --end 2026-09-15T00:00:00Z \
  --out summary-24h.json
```

That command exits nonzero on empty, missing-writer, malformed, or unpaired
data. It reports the earliest actual correlated pair as `observationStart` and
sets `cleanWindowGateEvaluated: false`; never substitute plugin-config apply
time or report the clean-window gate as passed from this bounded summary.

Deployment is limited to enabling the existing `shadowEmit.enabled` flag and
configuring its existing `shadow-decisions` local folder. Preserve the complete
live config with a parsed read-merge-write and readback; do not use a textual
`replaceAll` mutation or alter `selection.mode`, `pacing.mode`, lane definitions,
or secret references. TOG-2500 remains a prerequisite for any live config
write. Roll back by changing only `shadowEmit.enabled` to `false`; leave the
JSONL file as historical evidence. No host service or timer is started or
stopped by this feature.

### Config

See `src/config/schema.ts`. Every number that decides anything lives in config,
so the same input gives the same output on every run.

`config/reviewed-roster.json` is the reviewed roster-shaped plugin config. Its
`models` array is the single checked-in catalogue and carries `aaIndex`,
`releasedAt`, `fallbackOnly`, `note`, and `earnIn` on every row. Model ids use the
**direct CLIProxy namespace**: bare ids for its main catalogue (`claude-opus-5`)
and only the provider prefixes CLIProxy itself requires (`zai/glm-5.3`,
`openrouter/...`). The old OmniRoute `cliproxy/` wrapper is accepted only while
reading legacy pins and `heartbeat_runs` rows; it is rejected in new roster
config and never written by the dispatcher. `earnIn` remains inert in this
slice. Exact cost ties prefer the newest `releasedAt`, then stable model id. A
runtime model may have one row per admitted tier; exact duplicate model+tier
rows are rejected.

The checked-in catalogue is intentionally not a deployable replacement for live
configuration. Build an additive artifact with `npm run config:assemble --
--roster config/reviewed-roster.json --live <config-BEFORE.json> --out
<config-AFTER.json> --counts <COUNTS.json>`. The assembler canonicalises one
legacy `cliproxy/` wrapper, preserves every live model+tier row and lane binding,
preserves the complete live `pacing` object (including secret references), and
adds a provider lane to new rows only when the mapping is unambiguous. It refuses
to write when fewer than 25 models are lane-bound, a live binding or pacing field
changes, canonical rows collide, or an enabled model is outside pacing. The last
guard deliberately blocks enabled Z.ai rows until TOG-2424 supplies a real Z.ai
lane; assigning them to OpenCode Go would make capacity attribution false.

`tierLabelIds` is worth a note: it maps each tier to a **company label id**, and
it is operator-supplied because the plugin genuinely cannot look one up. There is
no label surface anywhere in the plugin SDK, and `labels` is absent from
`PLUGIN_DATABASE_CORE_READ_TABLES`, so a name→id query is rejected outright by
`assertAllowedPublicRead` (`plugin-database.ts:157-168`). Leaving it unset is
supported — the override is still written, just without the label, which is
additive information rather than a gate (ADR-0008).

---

## Slices 2–4 (TOG-2136): scores, cost shadowing, bounded T1 earn-in

Approved decisions A and B, implemented **without changing production
selection** — objective stays `list-price` and earn-in stays disabled until
their own gates pass. Nothing in this section is wired into `planApply`'s
enforcement path.

### Model scores + card-level acceptance ledger (`src/engine/scores.ts`)

`refreshScores` is a scheduled job (same cadence family as
`refreshVolumeProfiles`) that ports `model_scores.py`'s Bayesian
smoothed-success scoring: `priorP(aaIndex)` seeds a per-model prior, run
outcomes from `heartbeat_runs` are recency-weighted (`exp(-ageDays/10)`) and
blended toward it, and a model is `proven` once it has ≥8 weighted-relevant
outcomes at a tier and `capable` once its blended `p` clears that tier's
threshold (with a hard-evidence override: enough real evidence at a
materially lower observed rate forces `capable=false` even if the prior alone
would have cleared the bar).

One structural deviation from the Python original: `model_scores.py`
attributes tier via a live SQL join against `issue_labels`/`labels`
(lines 56–63). Both tables are absent from `PLUGIN_DATABASE_CORE_READ_TABLES`,
so this plugin cannot do that join. Tier is instead read per distinct issue id
through `ctx.issues.get()`, which the host already enriches with `.labels` —
the same mechanism `describeIssue()` uses elsewhere in this plugin. Reopen and
rejection ("rework") signals are folded in as soft evidence (`failModel`/
`wBad`, weighted 1.0 within 72h of a reopen or 0.5 within 48h of a rejection)
via captured `ctx.events` state, never a live `activity_log` read — that table
is also outside the allowlist.

Alongside `modelScores`, the same job builds the TOG-1917 §2.2 card-level
acceptance ledger (`buildCardLedger`): each closed card is `pending` (excluded
from both accepted/rejected) until 14 days past close (`CARD_CENSOR_DAYS`)
unless it was rejected first, in which case it counts immediately. Both are
written to `ctx.state` under `PLUGIN_STATE_KEYS.modelScores` as
`{ modelScores, cardLedger }`.

### `selection.objective` and the 7-day shadow diff (`src/engine/objective.ts`)

`selection.objective` is `"list-price" | "cost-per-accepted-card"`, defaulting
to `list-price`. Regardless of which objective is configured, `list-price`
selection is what production actually runs; `cost-per-accepted-card` is
shadow-only — it is scored against the card ledger and diffed against what
`list-price` would have picked, never used to make a real selection. That
diff is what should be reviewed for 7 days before anyone proposes flipping the
default.

### Bounded T1 earn-in (`src/actuate/earnIn.ts`)

`planEarnIn` / `recordEarnInOutcome` are pure decision functions — TOG-1917 §3
/ TOG-2048 decision B — covered by `tests/earnIn.spec.ts` but **not called
from any job or tool**. Earn-in ships fully inert; `worker.ts` never invokes
these functions, and the shipped config keeps `earnIn.enabled: false`
regardless. Gates implemented, in order: enabled check → sticky stop state →
T1-only → work-class allowlist (`research`/`review`) → todo status → excludes
(running run, operator pin, capability exclusion, credentials,
permissions/approvals) → model must be unproven-but-capable at T1 → idempotency
key → rolling 7-day per-model dispatch cap (`ROLLING_WEEK_MS`, recomputed from
an explicit `nowMs` on every call, never trusting a caller to have pruned
stale entries) → per-model active cap → per-lane active cap → **per-tier**
lane posture (`LanePostureByTier` — a T1 card is gated on the T1 lane's own
posture, never a collapsed global flag or another tier's lane) → Claude-only
pace gate (`pacePosture === "behind"` required, ignored for non-Claude models)
→ deterministic modulus-12 counter (`SELECTION_COUNTER_MODULUS`, never
`Math.random()`). `recordEarnInOutcome` stops a model (sticky) on 2 material
first-submission failures within its first 8 outcomes, or immediately on any
safety/authority violation.

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
npm run verify     # typecheck + tests + named mutants + build
npm test           # unit + reviewed live-config fixture
npm run test:mutants  # 12 named mutants: tier order, fallback revival, releasedAt
                       # removal, rework-as-n, 14-day censor, missing-acceptance
                       # default, cohort randomization, run/card conflation,
                       # rolling-clock injection, lane-posture bypass, per-tier
                       # lane collapse, disallowed activity_log read
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
