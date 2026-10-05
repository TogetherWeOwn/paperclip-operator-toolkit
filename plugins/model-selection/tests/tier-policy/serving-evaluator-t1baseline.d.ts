// Types for the frozen serving evaluator (see the .js header). The shapes are
// the repo's own, so a drift between the two shows up as a replay diff.
import type { Tier } from "../../src/constants.js";
import type { BenchmarkRow, BlendedPrior } from "../../src/engine/benchmark-prior.js";
import type { DerivedTier } from "../../src/engine/scores.js";
import type { ModelScore, TierScore, TierScoreStats } from "../../src/engine/types.js";

export declare const T1_CAPABILITY_THRESHOLD: number;
export declare const SCORE_THRESHOLDS: Record<Tier, number>;
export declare const SCORE_PRIOR_K: number;
export declare const SCORE_PROVEN_N: number;
export declare function priorP(aaIndex: number | null): number;
export declare function blendedPrior(aaIndex: number | null | undefined, row: BenchmarkRow | null | undefined): BlendedPrior;
export declare function blendedPriorP(aaIndex: number | null, benchmarkRow?: BenchmarkRow | null): number;
export declare function tierForPosterior(
  p: number,
  thresholds?: Partial<Record<Tier, number>>,
): { tier: Tier; belowT3Floor: boolean };
export declare function deriveModelTier(
  aaIndex: number | null,
  benchmarkRow: BenchmarkRow | null | undefined,
  overallStats: TierScoreStats,
  priorK?: number,
  thresholds?: Partial<Record<Tier, number>>,
): DerivedTier;
export declare function summarize(
  stats: TierScoreStats,
  tier: Tier | null,
  priorPValue: number,
  priorK?: number,
  provenN?: number,
  thresholds?: Partial<Record<Tier, number>>,
): TierScore;
export declare function buildModelScore(
  modelId: string,
  aaIndex: number | null,
  statsByTier: Partial<Record<Tier, TierScoreStats>>,
  tiers: readonly Tier[],
  benchmarkRow?: BenchmarkRow | null,
): ModelScore;
export declare function tierImpliedByIndex(index: number): Tier | null;
