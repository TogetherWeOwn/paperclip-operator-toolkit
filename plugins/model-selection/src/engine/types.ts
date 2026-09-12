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
  | "held-at-floor";

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
   * before treating the decision as pace-influenced.
   */
  pacingApplied: boolean;
}
