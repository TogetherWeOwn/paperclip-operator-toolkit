# Bounded account admission shadow

This is the shadow-only implementation of admission contract v1. It does **not**
enforce admission, reserve production allowance, select an upstream account,
change an issue override or certify 98–100% end-of-week attainment.

## Inputs and compatibility

`admission-budget.ts` accepts an existing, already-eligible binding set. Keys are
opaque; there is no AA score, effort derivation, tier migration, fallback-only
promotion or roster lookup here. The caller must apply the existing capability,
context, tier, enabled/fallback-only and effort-transport gates first. Account,
provider and pool identities must be non-secret stable keys, not emails,
display names, credentials or `record-N` ordering.

Each account declares **all** governing window IDs and explicitly observed
compatibility. A shared pool/window is evaluated once. Values from distinct
units, windows or plans are never summed or averaged. `planWeight` is preserved
as explicit metadata, not inferred as a quota multiplier. Quota, consumption,
unit, clocks, revisions, headroom and finite positive `maxAgeMs` are explicit.
Unknown allowance is not free budget, even when a counts-only lane is serviceable.

The pure evaluator separates target deficit `D` from safe rate `S`, subtracts
only incremental unreflected holds and applies every governing limit. Runtime
burn estimates use allowance units per occupied millisecond, not model tokens.
Missing burn/allowance produces unknown capacity. Fractional concurrency may
produce a bounded advisory next-start time; all limits and freshness must be
re-evaluated then. Jobs crossing reset are explicitly unsupported.

## Reservation simulator

`AdmissionSimulator` is a synchronous, single-process fixture model, **not** a
durable atomic storage backend or reserve-before-start consumer. It checks all
pools in one simulated transition, enforces separate lane slots, returns the
same allocation on an identical idempotency-key replay and rejects key reuse
with changed parameters.

Only proven cancellation before start refunds a hold. Committed failures and
timeouts retain allowance, even after a confirmed end frees a slot. Attributed
monotone usage watermarks retire only the matching incremental hold. Unknown
attribution retains it conservatively; no TTL implies a refund. Reset closes
only that window's hold, not other pools, still-active shorter windows or slots.

## Bounded report

`reportAdmissionShadow` is pure and off unless `enabled: true` is explicitly
supplied. `enabled: false` is a true no-op. A report has a fixed named cohort and
one of `synthetic-replay`, `observed-replay` or `fresh-observations` as
caller-declared provenance. Limits: 64 accounts, 256 unique governing windows,
256 chronological samples, 256 bindings and 1,024 holds per sample. Replays may
not extend outside any declared governing window; fresh observations are
limited to 24 hours. Changing the cohort, omitting a governing constraint or
unknown replay clocks is rejected. The pure report writes nothing to storage. The opt-in worker integration retains
only its latest single-sample snapshot in the existing per-company plugin state;
there is no appended history, timer, provider probe or reservation ledger.

Output preserves raw observations and source/schema revisions, reports counts,
timestamps, per-account/window last-sample attainment or underuse, observed
exhaustion, projected utilization/risk and explicit infeasibility. There is no
fleet-average percentage. Shared windows are present once in each evaluation;
account rows reference them, not another copy of fleet capacity. Burn error and
reservation overlap remain unknown without a trustworthy attributed ledger.

Caller-declared observations are **not certified production evidence**.
`completeWindowValidation` and `freshObservationValidation` are `unproven`;
a last sample is not a certified provider closeout measurement. Deterministic
fixtures, including a synthetic replay, do not establish a complete observed
reset window, 24-hour fresh validation, deployed behavior or production atomicity.

### Worker report option (no live enablement performed here)

Both opt-ins are required: company configuration
`accountAdmissionShadow: { enabled: true }` **and** an explicit `admissionShadow`
argument on an existing advise/apply call. Omitted/disabled config or input adds
no report reads or writes. This PR adds no scheduled job and does not change
any installed configuration.

The argument is `DecisionAdmissionShadowInput`: `enabled`, `cohortId`, `accounts`,
`maxAgeMs`, `windows`, `holds`, and `bindings`. Each binding entry has an explicit
`modelId` and an opaque `EligibleBudgetBinding` as `binding`. Supply only non-secret
provider observations and account/pool compatibility, including **all** governing
windows. Do not pass a raw credential status document, email or display identity.
There is no automatic conversion from counts-only lane records into quota.

After the existing selector finishes, the worker intersects supplied bindings
with its already computed landing-tier candidates and each candidate's configured
lane. It never reconstructs tier, context, capability, effort or fallback-only
eligibility. A sticky incumbent may not enumerate candidates: missing mappings
report `no-observed-eligible-account-binding`, not proof of no capable demand or
a served account. The worker records one fresh snapshot at its captured selection
clock; historical replay uses the pure function with explicit bounded fixtures.
Input is capped at 128 Ki characters and output at 512 Ki characters. Account
and sample caps also apply. Malformed input and state failures log a generic
warning without caller values and cannot change the returned decision or apply
operation.

`model_selection_admission_shadow_report` reads only that company's last snapshot;
it does not invoke advice, alarms or actuation. Its `evaluatedAt`/observation
clocks matter: reading a prior snapshot does not refresh it or make a present-time
admission decision. Turning the option off stops updates but does not pretend the
last snapshot was live evidence. Pure report off returns `null`.

Golden fixtures compare the complete serialized legacy advice/apply outputs,
issue overrides/labels and activity with the config omitted, off and on. They
cover normal advice/enforcement, sticky incumbents, untrusted-profile holds,
tier exhaustion, hard-stop repin and computation/storage failure isolation.

## Lane quota observation adapter

`admission-observation.ts` turns a per-lane quota snapshot (the lane-document
record shape: `lane`, `*_utilization`, `*_resets_at`, `observationQuality`
`live|cached`, `health`, snapshot `observedAt`) into the `accounts`/`windows`
the report needs. It is pure and read-only: no storage, provider probe, timer,
scheduled job, live config, pin/override/model change or served-account claim.

**Identity.** `accountId`/`poolId`/`providerId` and the governing window set come
only from the committed table in `admission-lane-bindings.ts`, validated on every
call (no `record-N`, email or display name; one account per lane; lanes sharing a
pool must agree on provider and window kinds). A snapshot lane absent from the
table is listed as `unmappedLanes` and excluded; a lane that is not a stable id
is only counted (`unstableLaneCount`), never echoed. A table lane missing from
the snapshot yields `unknown` windows. Only whitelisted record fields are read;
nothing else is copied or persisted. **Only lanes with in-repo evidence are
committed** (Claude 1-2 with 5h + 7d, Codex 1-3 weekly, Z.ai 1 with 5h + weekly).
Meta lane ids have no in-repo evidence yet: add them from the live Meta lane
document (provider `meta`, 5h + weekly) before a Meta cohort can be reported.

**Windows.** Every account declares ALL its governing windows. The start is the
reset minus the fixed window length (5h, 7d). Resets are snapped to the nearest
minute for the window id because reported instants jitter by up to about a
second around a whole-minute boundary; the exact instant stays on the row as
`reportedResetAt`. Eight Meta lanes with one shared reset stay eight
per-account windows (distinct pools); nothing is averaged. Lanes that share a pool
are counted once; disagreeing observations of one pool/window are `invalid`.

**Unit.** Utilization is observed as a fraction, so each window is
`unit: 'utilization-fraction'` (`quota: 1`, `consumed: fraction`, no headroom, no
plan weight). That is advisory attainment only: the evaluator reports
`utilization` and `elapsedFraction` but no safe budget, rate or start; a binding
governed by it stays `unknown` with `allowance-unknown`, even when a caller
supplies a fraction-unit burn estimate. Unknown quota units are not free budget.

**States** (worst wins: invalid, unknown, stale, known):

| state | when |
| --- | --- |
| `invalid` | missing or unparseable reset (`missing-reset`, `reset-unparseable`); reset not after the observation or more than one window ahead; observation in the future or without a clock; utilization not a number or outside 0..1; duplicate lane record; disagreeing shared-pool observations |
| `unknown` | lane absent from the snapshot; missing utilization; `counts-only` or unlabelled/unrecognised `observationQuality` |
| `stale` | `observationQuality: cached`, or older than the explicit `maxAgeMs` (inclusive bound) |
| `known` | live, within `maxAgeMs`, reset and utilization valid |

Zero is never substituted: missing utilization stays `consumed: null`. A stale or
invalid window reports no attainment.

**Caller path.** `admissionShadow` may carry `laneQuotaSnapshot` instead of
`accounts`/`windows` (supplying both is rejected), still requiring
`accountAdmissionShadow.enabled` **and** `maxAgeMs`. The report records
`observationAdapter` (per account/window rows with state, reasons, freshness,
observation quality, utilization, exact and snapped reset, plus unmapped,
unstable and missing lanes). The evidence kind is `fresh-observations` as
caller-declared; complete-window and 24-hour fresh validation remain `unproven`.
Optional `bindings` use the table account ids (use `windowIds: null` unless the
caller holds the derived window ids); they never admit from utilization alone.

The fixture `tests/fixtures/lane-quota-snapshot.synthetic-2026-10-03T0201Z.json`
is **synthetic**: reconstructed from the card text in the real record shape, not a
byte copy of the 2026-10-03T02:01Z snapshot.

## Coverage, release and rollback

Covered production start/retry/wake paths: **none**. There is no supported
account-bound host consumer or durable reservation store in this slice. Existing
selection and application-time gates are unchanged. Account compatibility in
report input does not prove which upstream account served a job.

The pure shadow PR can merge after deterministic fixtures, exact-head green CI,
independent review and reviewer squash-merge. No accessible complete-window or
fresh observation evidence has been supplied, so those acceptance steps remain
unproven and enforcement cannot advance. Deployment/live enablement is a
separate recorded operator action, not performed here. No host timer or installed
artifact changes are authorized.

Rollback: omit/disable the report option. Existing selection, override and
admission/repin behavior remains unchanged. There is no live-config rollback or
production reservation state to remove.

## Local verification

```sh
npm --prefix plugins/model-selection test -- tests/admission-budget.spec.ts tests/admission-simulator.spec.ts tests/admission-shadow.spec.ts tests/admission-observation.spec.ts
npm --prefix plugins/model-selection run typecheck
npm --prefix plugins/model-selection run build
```

Use the existing compatibility fixtures for selected binding, issue overrides
and application-time actuation. CI owns the repo's mutation gate; its guard
intentionally refuses non-CI runs.
