import type { Tier } from "../constants.js";
import type { AvailabilityTerm } from "./availability.js";

/**
 * A model this company is willing to run a harness on, with the three rates
 * that actually appear on the bill.
 *
 * Rates are `$/Mtok` recovered by solving `usage_json.costUsd` against the
 * token counts on our own runs — not a vendor list price (ADR-0001: we have no
 * trustworthy external price signal). `docs/adr/0011` records the derivation.
 */
export interface ModelEntry {
  id: string;
  tier: Tier;
  enabled: boolean;
  costPerMTokIn: number;
  costPerMTokOut: number;
  /**
   * Cache-read rate. Separate from `costPerMTokIn` because cache read is 44%
   * of the opus bill (ADR-0002) and folding it into input is exactly the
   * blindness the reference engine had.
   */
  costPerMTokCacheRead: number;
  /**
   * Capabilities this model is trusted for, as observed on our runs. A model
   * missing a capability is excluded, never merely down-ranked.
   */
  capabilities: readonly string[];
  contextWindow: number;
  /** Artificial Analysis intelligence-index prior, or null when unmatched. */
  aaIndex: number | null;
  /**
   * Explicit aa.ai leaderboard slug override, for a model whose normalized
   * id doesn't match aa.ai's slug automatically. Null/absent
   * falls back to normalized-id matching in `resolveAaSlug`.
   */
  aaSlug?: string | null;
  /** ISO date the roster's `aaIndex` was curated from. Informational only — never read by selection. */
  aaIndexUpdatedAt?: string | null;
  /**
   * Scope expansion: derived, read-only fields populated from the
   * matched aa.ai snapshot record at the point a roster view/drift-report is
   * assembled (worker.ts) — never operator-curated, never schema-validated
   * config, and never read by `select.ts`/`cost.ts`. Null wherever aa.ai's
   * own data is null for the matched slug; absent entirely when the model
   * has no resolved aa.ai slug at all. Surfacing only, same rule as
   * `aaIndex`: none of this may change `tier`/`enabled`.
   */
  aaCostPerTask?: number | null;
  aaPriceIn?: number | null;
  aaPriceOut?: number | null;
  aaTokensPerSec?: number | null;
  aaTtftSeconds?: number | null;
  aaContextWindow?: number | null;
  aaTerminalbenchHard?: number | null;
  aaTau2?: number | null;
  aaIfbench?: number | null;
  aaGpqa?: number | null;
  aaHle?: number | null;
  /** Effort-level suffix of the matched aa.ai slug (e.g. "low", "xhigh"), or null for the base/default row. */
  aaEffort?: string | null;
  /** ISO timestamp of the aa.ai snapshot fetch this row's derived fields came from. */
  aaSnapshotAt?: string | null;
  /** ISO date used only after an exact expected-cost tie. */
  releasedAt: string;
  /** Eligible only after all regular candidates at the judged tier fail. */
  fallbackOnly: boolean;
  /** Operator provenance and restrictions; never interpreted by selection. */
  note: string;
  /** Slice-4 policy payload. Stored now, inactive until the earn-in engine ships. */
  earnIn: Record<string, unknown> | null;
  /**
   * Which lane-capacity lane governs this model's pace. Optional —
   * a model with no lane simply never enters pace ordering (`paceStateOf`
   * degrades to "unknown", the same as an unpolled lane).
   */
  laneId?: string | null;
  /**
   * The reasoning effort to pin ALONGSIDE this model.
   *
   * Optional. When present, the pin writes the adapter's effort key in the same
   * update as `adapterConfig.model`, clamped to what this model actually offers
   * (`engine/effort.ts`). When absent, the pin still corrects an inherited
   * agent-level effort the chosen model cannot honour, but pins nothing new.
   *
   * Per ROW, not per tier: a roster row already carries exactly one `tier`, so
   * the same model at T1 and at T3 is already two rows and can already carry two
   * efforts. An `effortByTier` map would be a second, redundant way to say it.
   *
   * Distinct from `aaEffort`, which is descriptive — the effort suffix of the
   * aa.ai leaderboard slug this row's index was read from. This one is
   * prescriptive: what we will actually run.
   */
  effort?: string | null;
}

/**
 * Measured token shape of a run at a given tier, from this company's own
 * `heartbeat_runs`. This is the volume term. It is a *measured multi-turn
 * total*, not a single-request estimate — the distinction the Round-4 record
 * identified as the reference engine's structural blind spot.
 */
export interface VolumeProfile {
  tier: Tier;
  /** Runs the profile was computed from. Below `minSamples` it is not trusted. */
  sampleCount: number;
  /** ISO timestamp the profile was computed. Drives the staleness guard. */
  computedAt: string;
  avgInputTokens: number;
  avgCacheReadTokens: number;
  avgOutputTokens: number;
}

/**
 * Quality signals per tier, from `queries/06-escalation-rate.sql` and the
 * human reopen/reject tripwire. Feeds the escalation-risk term.
 */
export interface QualitySignal {
  tier: Tier;
  escalationRate: number;
  /** Human reopen/reject count in window. Weighted 10x (ADR-0005). */
  silentFailureCount: number;
  sampleCount: number;
  computedAt: string;
}

/**
 * The capability-exclusion answer for one issue. Recorded judgement, never
 * inferred from issue text (ADR-0004: the boundary is capability, not
 * difficulty — a trivial config edit is excluded).
 */
export interface CapabilityExclusion {
  excluded: boolean;
  reasons: readonly string[];
}

/**
 * Where a tier judgement came from. Ordered most to least authoritative.
 * `agent-floor` is the always-valid fallback: a missing label is not a missing
 * decision (ADR-0008).
 */
export type TierSource =
  | "capability-exclusion"
  | "issue-override"
  | "issue-label"
  | "agent-floor"
  | "config-default";

export interface TierJudgement {
  tier: Tier;
  source: TierSource;
  detail: string;
}

export interface IssueDescriptor {
  issueId: string;
  /** `tier:*` label names already on the issue. The durable record. */
  labelNames?: readonly string[];
  /** Existing `assigneeAdapterOverrides.adapterConfig.model`, if pinned. */
  pinnedModelId?: string | null;
  /** Recorded capability-exclusion answer. Supplied, never guessed. */
  exclusion?: CapabilityExclusion;
  /** Assignee agent's `adapterConfig.model` — the tier floor. */
  agentFloorModelId?: string | null;
  /**
   * Assignee agent's `adapterType` (e.g. `claude_local`), or
   * null/absent when UNKNOWN. Decides adapter-compatibility: `devin/*` models
   * are ineligible on `claude_local` (Devin's content filter rejects the
   * Claude Code / Agent SDK system banner — Cognition ticket 71806 — measured
   * 25 failed / 3 succeeded runs). Unknown never excludes.
   */
  agentAdapterType?: string | null;
  /**
   * Board priority (`critical`/`high`/...) as recorded. Gates the
   * free-lane earn-in reorder: protected priorities never take experimental
   * traffic. Null/absent = unknown, earn-in proceeds as before.
   */
  priority?: string | null;
  /**
   * Card title, raw and never inferred here. Gates the free-lane
   * earn-in reorder alongside `priority`: review/gate cards never take
   * experimental traffic (`free-lane-earn-in.ts` judges the text).
   */
  title?: string | null;
  /** Model already used on this issue, if any. Sticky driver. */
  stickyModelId?: string | null;
  requiredCapabilities?: readonly string[];
  requiredContextTokens?: number;
  /**
   * Assignee agent's display name (`agents.name`), e.g. "Founding Engineer".
   * Ported from `tier_dispatcher.py`'s `agent` parameter — every SQL caller
   * there sources it from `coalesce(a.name,'')`, so this is a name string,
   * never a role enum. Used only by `ZAI_LONG_RUN_AGENTS`.
   */
  agentName?: string | null;
  /**
   * `fleet-default` means this selection keys traffic for the
   * fleet rather than one card, so a lane standing on a single serviceable
   * account is ineligible at any quota level — 09-17 00:39Z was 0.46 weekly
   * utilization and still a refusal, because the limiter is
   * requests-per-window PER ACCOUNT. Defaults to `issue`.
   */
  trafficScale?: "issue" | "fleet-default";
  /**
   * `PAPERCLIP_WAKE_REASON` for the run this decision serves, e.g.
   * `monitor`/`continuation`. Caller-supplied — this plugin never infers it.
   * Absent/unrecognized behaves exactly as before this field existed: the
   * card's judged tier is the required tier, full stop. Feeds
   * `SelectionConfig.wakeScopedFloor` only; never read by `resolveTier`, so a
   * wake-scoped decision never touches the recorded `tier:*` label/pin.
   */
  wakeReason?: string | null;
}

export interface CostBreakdown {
  modelId: string;
  /** Direct cost of one run at this model, from the volume profile. */
  runCostUsd: number;
  inputCostUsd: number;
  cacheReadCostUsd: number;
  outputCostUsd: number;
  /** Expected extra cost from escalating to the tier above, if it happens. */
  escalationRiskUsd: number;
  /** runCostUsd + escalationRiskUsd. The number selection actually orders on. */
  expectedCostUsd: number;
  /** Which profile was used, and whether it was trusted. */
  profileTier: Tier;
  profileTrusted: boolean;
}

export type Outcome =
  | "selected"
  | "no-eligible-model"
  | "disabled"
  | "held-at-floor"
  /**
   * Distinct from `no-eligible-model`: every tier from
   * the required tier up to and including T1 had a candidate that would
   * otherwise qualify, but every one of them was excluded specifically by
   * the pace serviceability hard stop (`lane-unserviceable`) — a capacity
   * failure, not a config/capability gap. There is nowhere left to escalate
   * to. This must reach an operator, not fail silently the way the reference
   * dispatcher's `pick()` does.
   */
  | "tier-exhausted";

export interface Candidate extends CostBreakdown {
  tier: Tier;
  releasedAt: string;
  fallbackOnly: boolean;
}

/**
 * The machine-readable operand behind a `Rejection.reason` string —
 * the exact tier compared, lane and its verdict, or disabled flag, keyed by
 * `stage` so a consumer never has to parse `reason` prose to tell two
 * plausible gates apart on the same candidate.
 */
export type RejectionOperand =
  | { kind: "disabled" }
  | { kind: "capability"; missing: string[] }
  /** Adapter-compatibility: model id prefix + assignee adapter. */
  | { kind: "adapter"; modelId: string; adapterType: string }
  | { kind: "capability-score"; tier: Tier; p: number | null; cappedBy?: Tier }
  | { kind: "card-accept-rate"; tier: Tier; cardsResolved: number; cardsAccepted: number }
  | { kind: "context-window"; contextWindow: number; requiredContextTokens: number }
  | { kind: "tier-floor"; tier: Tier; requiredTier: Tier }
  | { kind: "no-profile"; tier: Tier }
  | { kind: "lane-unserviceable"; laneId: string | null; verdict: string | null }
  | { kind: "lane-avoid"; laneId: string | null }
  | { kind: "lane-outage"; laneId: string | null }
  | { kind: "lane-no-room"; laneId: string }
  | { kind: "lane-availability"; laneId: string | null; term: string; state: "unavailable" | "unknown" }
  | { kind: "lane-evidence"; laneId: string | null; state: string; rule: string | null };

export interface Rejection {
  modelId: string;
  /**
   * `tier-floor` keeps work off lower-capability roster rows. `capability-score`
   * is the Bayesian-measured counterpart, ported from
   * `tier_dispatcher.py`'s `capable(model_id, tier)`: a model can clear the
   * static `tier-floor` and still fail here once its own run history shows it
   * is not actually succeeding at that tier. `lane-avoid` and `lane-outage`
   * are ports of `tier_dispatcher.py`'s `AVOID`/ `AVOID_LANE`
   * threshold and `lane_outage.json` operator override, respectively — both
   * distinct from `lane-unserviceable` (the pace engine's own
   * exhausted/unavailable health check).
   *
   * `lane-availability` is a fourth, independent capacity stage.
   * It is NOT a duplicate of `lane-unserviceable`: that one is the pace
   * engine's verdict, reached only when a lane is polled AND the poll
   * produced an account identity it could key on, and it is deliberately
   * fail-neutral otherwise (`pacing.ts:275`). This stage reads the published
   * quota-contract document directly and carries the three terms the pace
   * verdict has no field for — the `subscription-pool` cooldown, the
   * serviceable account COUNT, and an explicit staleness UNKNOWN. Both are
   * capacity, so both count toward `tier-exhausted`.
   *
   * `card-accept-rate` is a QUALITY stage, a sibling of
   * `capability-score` rather than of the lane stages: it fires when a
   * (model, tier) has had zero cards ACCEPTED across
   * `CARD_ZERO_ACCEPT_MIN_RESOLVED` mature, unexpired ones. It must stay out of
   * `CAPACITY_STAGES` — a tier where every row is excluded for quality is
   * `no-eligible-model`, not `tier-exhausted`; calling it exhausted would tell
   * the operator to buy capacity that already exists.
   */
  stage:
    | "disabled"
    | "capability"
    | "adapter"
    | "capability-score"
    | "card-accept-rate"
    | "context-window"
    | "tier-floor"
    | "no-profile"
    | "lane-unserviceable"
    | "lane-avoid"
    | "lane-outage"
    | "lane-no-room"
    | "lane-availability"
    /** Run-outcome evidence — `proven-dead`, or the cost-down guard. */
    | "lane-evidence";
  reason: string;
  /** Structured counterpart to `reason` — see `RejectionOperand`. */
  operand: RejectionOperand;
}

/**
 * One model's availability verdict, carried structurally so `decisions.jsonl`
 * can answer "why did this card not get opus" by the TERM rather than by
 * grepping prose out of the trace.
 */
export interface AvailabilityNote {
  modelId: string;
  laneId: string | null;
  term: AvailabilityTerm;
  reason: string;
}

/** What the availability gate saw, and did, on this decision. */
export interface AvailabilityReport {
  /** False when no availability input was supplied at all. */
  configured: boolean;
  /** Set when the whole snapshot was unreadable. Every lane is then UNKNOWN. */
  unreadableReason: string | null;
  /** Models excluded, with the term that excluded each. */
  excluded: readonly AvailabilityNote[];
  /**
   * Models whose lane state could not be read. Present in the record because
   * an UNKNOWN that is not said has become a quiet pass — the one thing
   * `pacing_verdict.py` forbids.
   */
  unknown: readonly AvailabilityNote[];
  /** True when the selected model's own lane state was UNKNOWN. */
  selectedOnUnknownLane: boolean;
  /**
   * Second failure shape: models excluded by the RUN-OUTCOME term
   * rather than the published contract — a lane that is `proven-dead`, or an
   * `unproven` one that would have taken a cost-down move off a proven-good
   * lane. Kept separate from `excluded` because the two answer different
   * operator questions: `excluded` means "the lane said it would not serve",
   * this means "the lane said nothing and did not serve".
   */
  evidenceExcluded: readonly AvailabilityNote[];
  /** Evidence state of the lane the incumbent (sticky) model sits on. */
  incumbentEvidence: "proven-good" | "proven-dead" | "unproven";
}

/**
 * Slice 3 shadow comparison: what `cost-per-accepted-card` would have picked
 * vs. the actual (list-price, unless objective is explicitly switched)
 * winner. Never affects `modelId`.
 */
export interface ShadowDiffRecord {
  issueId: string;
  tier: Tier;
  listPriceWinner: string | null;
  costPerAcceptedCardWinner: string | null;
  agree: boolean;
}

/**
 * Shadow-only v2 evidence for the selected model, resolved
 * AFTER selection from the last-good free-list snapshot. Never an input to
 * selection — `select.ts` never sets this; only the worker's `advise()`
 * attaches it, and only when `aaFreeSync` is enabled with curated bindings
 * and a fresh snapshot. Absent (not null) on every legacy-path decision, so
 * disabling v2 restores the decision shape byte-for-byte.
 */
export interface AaEffortEvidence {
  status: "matched" | "ineligible";
  /** The curated candidate, carried through recovery so it can never be re-derived into a different one. Null unless matched. */
  candidateId: string | null;
  reason:
    | "effort-unknown"
    | "no-binding"
    | "observational-only"
    | "slug-absent-from-snapshot"
    | "slug-ambiguous"
    | "snapshot-stale"
    | null;
  /** What the roster asked for (the selected row's curated effort, if any). */
  requestedEffort: string;
  /** What the invocation will actually run (deployed resolver output). */
  effectiveEffort: string;
  /** Always null at advise time: served effort is post-hoc only, never an input. */
  observedServedEffort: null;
  /** The candidate's free-list index. Null unless matched. */
  aaIndex: number | null;
  /** Content address of the snapshot this evidence came from. */
  snapshotDigest: string;
  /** True when the snapshot exceeded its freshness bound — evidence is then always ineligible. */
  stale: boolean;
  /** S-tier (`fallbackOnly`) picks stay held even as evidence: sync never lifts them. */
  held: "fallback-only" | null;
}

export interface SelectionDecision {
  outcome: Outcome;
  modelId: string | null;
  /** The tier judgement that keyed this decision, and where it came from. */
  judgement: TierJudgement;
  /** Tier actually selected from, after any floor-lift. */
  effectiveTier: Tier | null;
  candidates: Candidate[];
  rejections: Rejection[];
  /** Human-readable decision path. Every branch appends one line. */
  trace: string[];
  /** True when the decision is advice only and no write should follow. */
  advisory: boolean;
  /** Set when we deliberately declined to move off the agent floor. */
  heldReason: string | null;
  /**
   * True only in `pacing.mode: enforce`, and only when pace
   * ordering or the slot throttle actually changed the outcome versus a
   * pace-less selection. False in `off`/`shadow` (and in `enforce` when
   * pace agreed with cost ordering already) — this is what a caller checks
   * before treating the decision as pace-influenced. Computed against the
   * pre-`objective` candidate order (`candidates[0]`), so an `objective`
   * switch never taints this flag's meaning.
   */
  pacingApplied: boolean;
  /** Null when there was nothing to compare. Never affects `modelId`. */
  shadowDiff: ShadowDiffRecord | null;
  /**
   * The tier the ladder walk escalated AWAY FROM — set to
   * `judgement.tier` when `effectiveTier` ends up on a different (higher)
   * tier, null on an ordinary same-tier selection. The ladder walk climbs
   * exactly one tier at a time and never skips a tier, so this plus
   * `effectiveTier` fully describes the escalation: "judged X, nothing
   * gate-eligible survived there, landed on `effectiveTier` instead". This is
   * what the 48h comparison stream and the `tier-exhausted` alarm both key on
   * to tell an escalation apart from a routine pick — the reference
   * dispatcher has no equivalent signal at all.
   */
  escalatedFromTier: Tier | null;
  /** What the lane-availability gate saw. Never null: an absent input is said. */
  availability: AvailabilityReport;
  /**
   * Set only when `SelectionConfig.wakeScopedFloor` actually lowered
   * the required tier below `judgement.tier` for this decision — the tier the
   * gate/ladder walk started from instead of the card's judged tier. Null on
   * every ordinary decision. `judgement.tier` (and hence the durable label/
   * pin) is never altered by this — see `advisory`, which this field's
   * presence always forces `true` so the lowered tier can never be written.
   */
  wakeScopedTier: Tier | null;
  /**
   * Shadow-only v2 evidence, attached by the worker's `advise()`
   * AFTER selection — never an input to it. Optional so the legacy path keeps
   * the decision shape byte-for-byte (key absent, not null) when v2 is off.
   */
  aaEffortEvidence?: AaEffortEvidence | null;
}

/**
 * Accumulator for one (model, tier) window, mirroring `model_scores.py`'s
 * `stats` dict shape. `wOk`/`wBad` are recency-weighted (`exp(-age/10)`);
 * `n`/`ok`/`failInfra`/`tmo` are raw counts, `failModel` is weighted.
 */
export interface TierScoreStats {
  n: number;
  ok: number;
  failInfra: number;
  failModel: number;
  tmo: number;
  wOk: number;
  wBad: number;
  rework: number;
  okCost: readonly number[];
  okMins: readonly number[];
}

/** Output of `summarize()` — the Bayesian-smoothed success verdict for one (model, tier). */
export interface TierScore {
  n: number;
  ok: number;
  failInfra: number;
  failModel: number;
  tmo: number;
  nEff: number;
  pObs: number | null;
  p: number;
  capable: boolean | null;
  proven: boolean;
  /**
   * Set when `capable` was forced false by monotonicity — this tier
   * has no proven evidence of its own and an easier tier (the one named) failed
   * on its own verdict. Absent when `capable` is this tier's own verdict.
   */
  cappedBy?: Tier;
  costPerSuccessUsd: number | null;
  medMin: number | null;
  rework: number;
}

export interface ModelScore {
  modelId: string;
  aaIndex: number | null;
  priorP: number;
  tiers: Record<Tier, TierScore>;
  overall: TierScore;
  /**
   * The tier this model's OVERALL posterior earns, or null when the
   * model is unscored (no aa.ai composite index) and its configured tier must be
   * retained. Distinct from `tiers[T].capable`, which is a per-tier quality gate
   * — a model can be tiered T1 here and still fail `capable` for T1 work.
   */
  derivedTier?: Tier | null;
  /** Posterior fell below the T3 threshold: labelled T3, but earned no tier. */
  belowT3Floor?: boolean;
  /** How the prior behind `derivedTier` was reached. */
  priorBasis?: "blended" | "index-only" | "unscored";
  /**
   * Benchmark spec version the tier was cut under (e.g. `tog2636-v1`). A tier
   * written under one version stays distinguishable from one written under the
   * next, so a re-tier can never silently rewrite history.
   */
  tierSpecVersion?: string;
}

/**
 * Card-level acceptance ledger row, keyed by model+tier.
 * `pending` cards (closed <14d ago, no reopen/rejection observed yet) are
 * right-censored: never counted as accepted, never counted as rejected.
 */
export interface CardLedgerEntry {
  modelId: string;
  tier: Tier;
  /**
   * EVERY closed card attributed to this (model, tier) inside
   * `CARD_LEDGER_WINDOW_DAYS` — right-censored ones included. This is NOT the
   * denominator of `acceptRate`; `cardsResolved` is. Reading it as
   * one is how `gpt-6-astra:T1` looked like "25 cards closed, none accepted"
   * on 2026-09-22 when the truth was 0-of-ONE resolved card and 24 still
   * inside the censor window.
   */
  cardsClosed: number;
  /**
   * Closed cards that are no longer right-censored — rejected, or aged past
   * `CARD_CENSOR_DAYS`. The reporting `acceptRate` denominator. Hard quality
   * exclusions use the symmetric, expiring `qualityCohort` instead.
   */
  cardsResolved: number;
  /** Resolved cards carrying no reopen/rejection signal. The `acceptRate` numerator. */
  cardsAccepted: number;
  /** `cardsAccepted / cardsResolved`; the model's prior when `cardsResolved` is 0 (`pending`). */
  acceptRate: number;
  costPerCard: number | null;
  runsPerCard: number | null;
  foreignRunShare: number | null;
  /** costPerCard / acceptRate. Null when costPerCard is unknown. */
  costPerAcceptedCard: number | null;
  /** True when acceptRate/costPerCard are unproven-model fallbacks (priorP / blended list price), not measured. */
  pending: boolean;
  /**
   * Closures aged [14, 21) days at observedAtMs, independent of outcome.
   * Missing on legacy rows or when there is no mature cohort: never excludes.
   * The oldest closure bounds cache validity; selection rechecks the clock.
   */
  qualityCohort?: {
    cardsResolved: number;
    cardsAccepted: number;
    oldestClosedAtMs: number;
    newestClosedAtMs: number;
    observedAtMs: number;
  };
}

/** Per-model bookkeeping for the Slice-4 bounded T1 earn-in policy (default off). */
export interface EarnInState {
  /** Deterministic per-model dispatch counter. Never `Math.random()`. */
  counter: Record<string, number>;
  /** Dispatch timestamps (ms) in the current rolling 7-day window, per model. */
  dispatchedThisWeek: Record<string, number[]>;
  /** Count of currently-active (dispatched, not yet resolved) earn-in cards, per model. */
  activePerModel: Record<string, number>;
  /** Count of currently-active earn-in cards, per lane. */
  activePerLane: Record<string, string[]>;
  /** Outcomes of the first 8 dispatched-with-outcome cards per model, oldest first. */
  firstEightOutcomes: Record<string, ReadonlyArray<"ok" | "material-failure">>;
  /** Set once a model hits 2 material failures in its first 8, or any safety/authority violation. Sticky. */
  stopped: Record<string, boolean>;
  /** Idempotency keys already dispatched (`${issueId}:${modelId}:earnin`). */
  dispatchedKeys: readonly string[];
}
