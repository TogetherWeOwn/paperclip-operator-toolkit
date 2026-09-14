import type { Tier } from "../constants.js";

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
   * id doesn't match aa.ai's slug automatically (TOG-2438). Null/absent
   * falls back to normalized-id matching in `resolveAaSlug`.
   */
  aaSlug?: string | null;
  /** ISO date the roster's `aaIndex` was curated from (TOG-2438). Informational only — never read by selection. */
  aaIndexUpdatedAt?: string | null;
  /**
   * TOG-2438 scope expansion: derived, read-only fields populated from the
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
   * TOG-2137: which lane-capacity lane governs this model's pace. Optional —
   * a model with no lane simply never enters pace ordering (`paceStateOf`
   * degrades to "unknown", the same as an unpolled lane).
   */
  laneId?: string | null;
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
  /** Model already used on this issue, if any. Sticky driver. */
  stickyModelId?: string | null;
  requiredCapabilities?: readonly string[];
  requiredContextTokens?: number;
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
   * TOG-2137, Defect 2. Distinct from `no-eligible-model`: every tier from
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

export interface Rejection {
  modelId: string;
  /** `tier-floor` keeps work off lower-capability roster rows. */
  stage: "disabled" | "capability" | "context-window" | "tier-floor" | "no-profile" | "lane-unserviceable";
  reason: string;
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
   * TOG-2137. True only in `pacing.mode: enforce`, and only when pace
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
   * TOG-2137, Defect 2. The tier the ladder walk escalated AWAY FROM — set to
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
}

/**
 * Card-level acceptance ledger row (TOG-1917 §2.2), keyed by model+tier.
 * `pending` cards (closed <14d ago, no reopen/rejection observed yet) are
 * right-censored: never counted as accepted, never counted as rejected.
 */
export interface CardLedgerEntry {
  modelId: string;
  tier: Tier;
  cardsClosed: number;
  /** Fraction of closed, non-pending cards with no reopen/rejection signal. */
  acceptRate: number;
  costPerCard: number | null;
  runsPerCard: number | null;
  foreignRunShare: number | null;
  /** costPerCard / acceptRate. Null when costPerCard is unknown. */
  costPerAcceptedCard: number | null;
  /** True when acceptRate/costPerCard are unproven-model fallbacks (priorP / blended list price), not measured. */
  pending: boolean;
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
