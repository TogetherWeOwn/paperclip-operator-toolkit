# Model Selection (Stage 3)

Chooses the cheapest fully-capable model for each harness run, keyed on a
**recorded tier judgement** and ordered by a **volume-aware cost term** measured
from this company's own runs.

Built per the staged rollout plan against the tiered-selection design, ADR-0002/0004/0005/0008/0010 and
the Round-4 record.

---

## What it is, in one paragraph

An issue carries a tier judgement that a human or an agent recorded at assignment
time. This plugin reads that judgement, works out which models are actually
capable of the work, prices each one against **our own measured token volume at
that tier**, and pins the cheapest survivor onto the issue via
`assigneeAdapterOverrides`. It writes nothing at all until an operator flips
`selection.mode` to `enforce`.

For the disabled-by-default, report-only account budget evaluator and reservation
simulator, see [bounded admission shadow](docs/admission-shadow.md). It never
governs host starts, changes the selection or proves served-account routing.

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

## Pace-relative lane avoidance

New admission avoids a lane only when its governing-window utilization reaches
`pacing.avoid`'s default or per-lane threshold **and** utilization exceeds the
window's elapsed fraction by more than **0.1**. This reuses the pace engine's
default deadband and its normalized score deviation; equality is not avoided.
For example, 0.75 utilization at 0.83 elapsed remains eligible even with a 0.75
threshold, and existing within-tier ordering prefers its near-reset headroom.
The avoidance margin is the engine default, not a new live setting or a lane's
optional pace-classification override. Missing/nonfinite scores remain neutral;
positive exhaustion, outages, tier floors, and quality gates still apply.

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

### Effort travels with the model

A roster row may carry an optional `effort`. When it does, the pin writes it in
the **same** update as `adapterConfig.model`, under the key that adapter
actually reads — `effort` for `claude_local`, `modelReasoningEffort` for
`codex_local`, `variant` for `opencode_local` (`engine/effort.ts`). Those three
are the only adapters an issue-level override reaches at all.

Two rules make the pair trustworthy:

- **The value is validated against the chosen model, not against the schema
  alone.** The config enum catches a typo; it cannot know the assignee's
  adapter. `resolveEffortPin` clamps at write time to the hottest level that
  model genuinely offers — `max` on a `claude_local` row becomes `high` — and
  reports the clamp rather than performing it silently. A value that is not a
  reasoning level at all is refused, not guessed at.
- **Omitting the key is not neutral.** The host merges
  `issueOverrides.adapterConfig` over the agent's *per key*
  (`heartbeat.ts:20838-20841`), so an effort we do not write is an effort we
  have endorsed. When the agent row carries one the chosen model cannot honour,
  the pin overwrites it — clamped, or emptied when there is no clamp target. It
  is not the forbidden `modelProfile: "cheap"` mechanism above, which we still
  never touch.
- **Emptying `codex_local` takes two keys, not one.** `asString(value, fallback)`
  returns its fallback for an empty string (`adapter-utils/src/server-utils.ts:437`),
  and codex's fallback is not `""` but *another key*:
  `asString(modelReasoningEffort, asString(reasoningEffort, ""))`
  (`codex-local/src/server/codex-args.ts:44-47`). So `modelReasoningEffort: ""`
  alone clears nothing — it hands the decision to the legacy `reasoningEffort`
  and resurrects the inherited value it claimed to neutralize. The clear writes
  both. `claude_local` (`asString(config.effort, "")`) and `opencode_local`
  (`asString(config.variant, "")`) do bottom out at `""`, so one write suffices
  there. This is why `EffortPin` carries a `writes` **map** rather than one
  key/value pair.

`effort` is per roster **row**, not per tier: a row already carries exactly one
`tier`, so the same model at two tiers is already two rows.

Vocabularies, all measured in `/app` at v2026.916.0:

| adapter | model | legal values |
| --- | --- | --- |
| `claude_local` | any | `low` `medium` `high` |
| `codex_local` | `gpt-6-astra` | `low` `medium` `high` `xhigh` `max` `ultra` |
| `codex_local` | anything else | `minimal` `low` `medium` `high` `xhigh` |
| `opencode_local` | any | `minimal` `low` `medium` `high` `xhigh` `max` |

The table keys on the **adapter** first. This fleet routes `gpt-*` and `glm-*`
ids through `claude_local` proxy lanes, so a `gpt-6-astra` pin on a
`claude_local` agent is still driven by `claude --effort` and still caps at
`high`. Reading the vocabulary off the model id alone would authorize an
illegal `xhigh` there.

The `gpt-6-astra` row matches **exactly what the adapter matches, and nothing
more**. codex's `normalizeModelId` is `trim()` — no lowercase, no namespace
strip (`codex-local/src/index.ts:24-26`) — then one alias map, and the astra
test is a string equality on that result (`:58-65`). `engine/effort.ts` mirrors
that function verbatim, so `cliproxy/gpt-6-astra`, `devin/gpt-6-astra` and
`GPT-6-Astra` all fall in the **anything else** row and cap at `xhigh`, exactly
as the CLI treats them. Normalizing more eagerly here is a bug, not a kindness:
the pin writes `adapterConfig.model` verbatim, so a stripped namespace would
authorize `max`/`ultra` on an id the adapter will still cap — the vocabulary
that allowed the value and the vocabulary that has to honour it would disagree,
which is the failure this file exists to prevent.

An unreadable assignee means UNKNOWN, not "no effort": the pin writes no effort
key at all, the same discipline `agentEnv` follows for the ancillary writes.

### Context fit and compaction ceiling

Every model pin is paired with a context-safe runtime envelope:

- an explicit caller requirement wins; otherwise the plugin uses the maximum
  single-request prompt in the latest finalized issue run's verified local log;
- neither run `usage_json` nor tier volume profiles are request-sized: both are
  cumulative billing usage. They are never summed, averaged, divided by turns,
  or ceiling-clamped into a supposed observed peak;
- peak retrieval requires optional `selection.contextRunLogRoot`, the absolute
  **operator-verified** host run-log root (no default or environment guessing).
  Unconfigured, inaccessible, malformed, truncated, unsupported, or oversized
  evidence uses `selection.fleetContextCeilingTokens` with source
  `fleet-ceiling-fallback`. A verified issue with no finalized history has source
  `none`. Explicit requirements and genuine observed peaks remain uncapped;
- decision-tool traces report source, tokens, run ID and evidence/fallback reason.
  No log text, filesystem path, or credentials are returned. See
  [the source contract and fixture tests](docs/context-evidence.md);
- candidates whose roster `contextWindow` is below a real issue estimate are
  rejected at the hard `context-window` gate, including a sticky incumbent;
- the admission gate (`estimateIssueContext`) caps observed run context at
  `selection.fleetContextCeilingTokens` (default 1,000,000; held at 200,000
  for glm-5.3);
- a model narrower than the AGENT-level `selection.agentEnvContextTokens`
  (default 1,000,000; unset resolves to the fleet ceiling) gets
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS=max(floor(contextWindow * compactionRatio),
  min(contextWindow, 250000))` in the issue override (ratio default 0.75;
  the 250k floor is the 2026-09-19/20 thrash fix);
- a model at or above the agent-env cap gets no issue-level compaction
  binding and inherits the agent env instead.

The host shallow-spreads issue `adapterConfig` over the agent config, so an issue
`env` object replaces the agent's `env` object rather than deep-merging it. The
write helper copies the agent env and any existing issue env before it changes
only `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. Unrelated bindings therefore survive both
initial pins and idle repins.

---

## Rollout

**This plugin ships inert.** Defaults are `mode: "advise"`, `defaultTier: "T1"`,
`holdOnUntrustedProfile: true`. Installing it changes no live selection variable.

Per the single-variable rollout constraint, enforcement must not be switched on until Stage 2
(`tier:T1/T2/T3` labels + narrow-slice rollout) is confirmed stable. **Never
change two live selection variables in one measurement window** — if
enforcement flips while the Stage 2 slice is still moving, neither result is
readable.

**Measured Stage 2 state as of 2026-08-31:** the three company
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
`advise()` decision appends two `paired-decision-v1` records to the current
UTC-hour shard in `shadow-decisions/` (`decisions-YYYY-MM-DD-HHZ.jsonl`): one
tagged `writer: "host"` and one tagged
`writer: "plugin-shadow"`. Both projections come from the same decision object,
timestamp, lane ledger, candidate roster, and state fingerprint. This supplies
the comparison stream without restoring the host `tier_dispatcher.py` retired
by the host dispatcher removal or adding a second actuator.

Shards stay small on purpose: each hourly shard is rewritten whole on every
append and capped at `shadowEmit.shardMaxRecords` (default 200, pair-aligned
so a host/shadow pair is never split). Whole shards older than the newest
`shadowEmit.retentionShards` (default 48) are deleted; the legacy single-file
`decisions.jsonl`, if present, is left untouched as historical evidence. The
one unbounded free-text field, `pickWhy`, is clamped to 8000 characters with
an explicit `...[truncated N chars]` marker so a single record can never trip
the host oversized-line drop; structured fields are never truncated.

A bounded interval can be split by writer without copying or changing records:

```bash
cat shadow-decisions/decisions-*.jsonl > interval.jsonl
jq -c 'select(.writer == "host")' interval.jsonl > host.jsonl
jq -c 'select(.writer == "plugin-shadow")' interval.jsonl > shadow.jsonl
python3 "$COMPANY_ROOT/ops/gate_harness.py" agreement \
  --host host.jsonl --shadow shadow.jsonl --out agreement.json
```

The agreement command deliberately remains nonzero until the separate
48-hour/200-decision clean-window gate is satisfied. For a reproducible bounded
comparison (maximum 24 hours), use the repository-pinned consumer through:

```bash
npm run decisions:summary -- \
  --input shadow-decisions \
  --start 2026-09-14T00:00:00Z \
  --end 2026-09-15T00:00:00Z \
  --out summary-24h.json
```

`--input` accepts a single JSONL file (legacy `decisions.jsonl`) or a
directory of UTC-hour shards; a directory reads every matching shard in
lexical (= chronological) order and ignores non-shard files.

That command exits nonzero on empty, missing-writer, malformed, or unpaired
data. It reports the earliest actual correlated pair as `observationStart` and
sets `cleanWindowGateEvaluated: false`; never substitute plugin-config apply
time or report the clean-window gate as passed from this bounded summary.

Deployment is limited to enabling the existing `shadowEmit.enabled` flag and
configuring its existing `shadow-decisions` local folder. Preserve the complete
live config with a parsed read-merge-write and readback; do not use a textual
`replaceAll` mutation or alter `selection.mode`, `pacing.mode`, lane definitions,
or secret references. Operator review remains a prerequisite for any live config
write. Roll back by changing only `shadowEmit.enabled` to `false`; leave the
shard files as historical evidence. No host service or timer is started or
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
guard deliberately blocks enabled Z.ai rows until operations supplies a real Z.ai
lane; assigning them to OpenCode Go would make capacity attribution false.

`tierLabelIds` is worth a note: it maps each tier to a **company label id**, and
it is operator-supplied because the plugin genuinely cannot look one up. There is
no label surface anywhere in the plugin SDK, and `labels` is absent from
`PLUGIN_DATABASE_CORE_READ_TABLES`, so a name→id query is rejected outright by
`assertAllowedPublicRead` (`plugin-database.ts:157-168`). Leaving it unset is
supported — the override is still written, just without the label, which is
additive information rather than a gate (ADR-0008).

---

## Slices 2–4: scores, cost shadowing, bounded T1 earn-in

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

Alongside `modelScores`, the same job builds the §2.2 card-level
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

### Scheduled-pass pre-write quarantine check

When selection writes are allowed and pacing is not `off`, the label-only,
repin, pinned-balance and unpinned-balance paths re-read the company's lane-outage
snapshot before writing a model pin. A selected model newly excluded by that
snapshot is skipped without counting a pin/repin/balance. The unwritten row stays
unsettled: label-only and repin retain their incremental watermark before it.
Balance keeps its bounded ID cycle but carries `retryPending` across pages and
wraps, bypassing the quiet-board gate until a full clean retry cycle completes;
`unsettledInCycle` records skips on earlier pages of the current cycle. Clearing
quarantine therefore retries even a card whose `updated_at` never changed.
Advisory selection adds no pre-write outage read because it writes no pin.

Every write path rechecks the job deadline and row slice after the awaited outage
read. An expired row writes no pin or activity and consumes no write counter,
even when its abandoned callback later finishes.

The check narrows the stale-snapshot window; the state read and issue write are
not atomic. It neither enables enforcement nor adds per-model cooldown support.
`tests/scheduled-quarantine.spec.ts` covers late reads, exhausted row slices,
two-firing retries, multi-page balance retries and healthy/advisory controls.
The original four write-path tests and healthy-lane repin control remain in
`tests/scheduled-passes.spec.ts`; `pre-write-quarantine-check-inverted` makes
them fail.

### Bounded T1 earn-in (`src/actuate/earnIn.ts`)

`planEarnIn` / `recordEarnInOutcome` are pure decision functions — §3
/ decision B — covered by `tests/earnIn.spec.ts` but **not called
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

## the pin moves to card creation

Owner directive (2026-09-16): *"a task should not start until the model router
has set its model."* The scheduled passes (`*/10`) cannot honor that — their row
queries **exclude cards with a running run**, and a dispatched card is running
within ~0.2–0.3 s of creation (see the routing feasibility note),
so a card's whole first turn happens before any pass can even see it. It lands
on the agent floor, which is exactly what the directive forbids.

The plugin half (`src/worker.ts`, `tests/creation-pin.spec.ts`) adds two event
handlers that see the card from the stream the moment it exists:

- **`issue.created`** — if the card already carries an assignee: classify (if
  unlabelled), write the `tier:*` label (union, never replace — the host
  replaces the label set on a `labelIds` write), then pin. This also fixes the
  classify-skip: `classifyIssues` never saw running cards, so they never got a
  tier label at all.
- **`issue.updated` assignment arm** — cards are frequently created unassigned
  and assigned by a later PATCH, after `issue.created` already fired and found
  no assignee (the event payload carries none). `assigneeAgentId` null → agent
  is the other "creation moment". Agent-to-agent reassignment is deliberately
  ignored: that card already had its creation moment, and moving it is
  `repinPass` territory.

Semantics are **label-tier, not balance-tier**: the event pin is
`advise(…, forceTier = the card's own tier label)` — the same decision
`labelOnlyPass` would produce, just earlier in time. An event path that changed
routing policy (e.g. adopted `balancePass`'s forced T1) would be a silent policy
change. The tier is passed explicitly to `advise` rather than re-read from the
issue after the label write, so correctness never depends on the host's
label-enriched read-back landing within the same tick.

Guards, in order: `classification.enabled` kill switch → assignee present →
open status → no `pin:operator` → no existing pin → (classify+label if needed)
→ advise outcome `selected` → idle + open + unpinned re-read from the advise
result → **floor-equal skip** → `balanceWriteStillSafe` fresh re-read → write.
Never re-pins a live card (an override landing on a running card resets a warm
session); never throws out of an event handler (one card's pin failure must not
break the loop for the next handler).

**Honest limit:** this cannot own the first turn either. The event bus is
fire-and-forget and loses the same measured dispatch race — the handler runs at
~0.26 s against a ~0.2–0.3 s dispatch window. What it does guarantee: every card
the passes were structurally missing gets labelled and pinned the moment it is
idle (between turns), which shrinks the unpinned window from "the whole first
turn" to "one turn at most" — and is the release mechanism the core-side
dispatch gate needs once it lands.

**Floor-equal residual class:** when the router's pick *is* the floor model,
the event path (matching pass convention) writes no override — the card already
runs exactly that model, and a redundant override only adds churn. This is the
one class where "the router has set the model" is true in the decision stream
but no pin exists on the card; only the core gate (which can check either)
closes it by construction.

### Unpinnable cards must be visible (AC3)

`maybeLogUnpinnableCard`: when `advise` returns `no-eligible-model` or
`tier-exhausted` — from the event path, `labelOnlyPass`, or `balancePass`'s
unpinned branch, all of which used to `continue` silently — one activity notice
per hour (`NO_ELIGIBLE_NOTICE_THROTTLE_MS`) lands **on that card**, naming the
outcome and every lane's state (`lane=verdict@util%`), so a sustained outage
reads as "cannot pin, here is why" instead of "no news". The throttle state
(`noEligibleNotices`) prunes entries older than 7 days on write. The notice also
includes up to eight named rejection reasons (all are stored in metadata).
Quality exclusions explain their evidence expiry, not a request for more lane
capacity or an operator hand-pin.

### Zero-accept evidence and re-entry

`card-accept-rate` is a quality exclusion, not a cost penalty or capacity outage.
It needs **eight mature cards with zero accepts**, at the same model and tier,
and a consistent reporting row with zero accepted cards. `cardsClosed` includes
censored cards and is never its denominator. The reporting `acceptRate` still
resolves rejections early for visibility; that biased sample does not by itself
justify exclusion.

`buildCardLedger` publishes `qualityCohort` from closures aged **[14, 21) days**:
accepts and rejects both wait 14 days, then provide exclusion evidence for seven.
N=8 matches the existing proven-evidence floor; independence-based probabilities
are illustrative, not protection against correlated failures. The observation
window and short evidence lifetime are the actual safeguards.

The selector validates JSON identity, explicit `pending: false`, safe integer
counts, subset relationships, zero rates and cohort timestamps. Missing legacy
fields or contradictory evidence fail open. A 0/8 reporting row with 100 young
censored successes cannot exclude: at day 3 it has no mature cohort; at day 14
it has 100/108 accepts. A genuine eight-rejection cohort excludes at day 14.

**Bounded recovery without a probe scheduler:** selection checks expiry at the
oldest cohort closure + 21 days, even if the cache never refreshes. Refresh can
replace the cohort but cannot restart old failures' clocks. With no new closures,
quality eligibility returns no later than 21 days after the final closure (at
most seven days after that closure matures). This restores ordinary eligibility,
not guaranteed traffic: capability, lane and other safety gates still apply.
The policy does not override pins, force probes, or enable the dormant earn-in
scheduler. A mature accepted card also lifts the zero-accept exclusion.

---

## the model is decided when the run starts

Pins race the run they are meant to steer. With the fork's run-model
hook installed, `onResolveRunModel` decides each issue run's model at its start, from
hot caches only, under a sticky rule, and returns plain plugin-owned env. It is off
by default (`runResolve.enabled`), needs `selection.mode: "enforce"`, and, once on,
retires the creation/assignment pin, `labelOnlyPass`, `balancePass`, `repinPass` and the
`agent.run.failed` re-pin. Tier labels stay. The fork build declares the capability
only when built with `MODEL_SELECTION_RUN_RESOLVE=1`, so the default artifact still
installs on a host without the hook. Operator guide, sticky matrix, rollback and known
limits: [docs/run-scoped-decision.md](docs/run-scoped-decision.md).

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
npm test -- tests/<changed>.spec.ts --pool=forks --maxWorkers=2  # local review: one spec only
npm run verify        # CI/private runner only: typecheck + tests + named mutants + build
npm test              # unit + reviewed live-config fixture
npm run test:mutants  # CI/private runner only: 115 named mutants, one per acceptance-criterion trap, including:
                       # tier order, fallback revival, releasedAt removal,
                       # rework-as-n, 14-day censor, missing-acceptance default,
                       # cohort randomization, run/card conflation, rolling-clock
                       # injection, lane-posture bypass, per-tier lane collapse,
                       # disallowed activity_log read, shadow-pair wiring, earn-in
                       # guards,  creation-pin wiring/guards/notice throttle
npm run build         # esbuild → dist/manifest.js, dist/worker.js
npm run profiles:refresh   # re-measure volume from heartbeat_runs (needs DATABASE_URL)
npm run gate:stage2        # Stage 2 gate as a count; exit 1 = do not enforce
```

`verify` and `test:mutants` refuse outside `CI=true` unless
`MUTATION_GATE_LOCAL=1` is deliberately set. Reviewers run only the changed spec
locally; mutation evidence links the PR's **model-selection suite** job, step
**Kill named selection mutants** — and only that. Do **not** cite **Offline
suites**: it runs the repo-level `verification/*-mutation-gate.sh` set and never
invokes this plugin's gate, so it cannot carry this evidence whichever way it
lands. The local override runs with Vitest forks and threads defaulting to 2. See
[`docs/model-selection-review-runbook.md`](../../docs/model-selection-review-runbook.md).

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
