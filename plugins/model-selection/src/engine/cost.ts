import { TIER_ORDER, type Tier } from "../constants.js";
import type {
  CostBreakdown,
  ModelEntry,
  QualitySignal,
  VolumeProfile,
} from "./types.js";

/**
 * The volume-aware cost term.
 *
 * The reference engine (`paperclip-model-router/src/engine/select.ts:70-77`)
 * computes cost from `estimatedInputTokens`/`estimatedOutputTokens` with
 * 8,000/2,000 defaults and no cache-read term at all. That is a single-request
 * model. A harness run is multi-turn: on this company's own 7d data, an opus
 * run averages 510k input, 6.08M cache-read and 55.5k output tokens. Cache read
 * alone is ~12x the input volume and 44% of the bill (ADR-0002).
 *
 * So an engine built on the reference cost term orders candidates on the price
 * term (measured 5.2x spread) while being blind to the volume term (measured
 * 6.1x spread) — it gets the smaller lever right and the larger one wrong.
 *
 * This module fixes exactly that: cost is three measured token totals times
 * three separate rates, and the token totals come from *our runs at that tier*,
 * not from a per-request guess.
 */

/** Below this many runs a profile is not trusted to order anything. */
export const MIN_PROFILE_SAMPLES = 5;

/** A profile older than this is stale; the caller is told, and holds. */
export const PROFILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function tierIndex(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

/** The tier one step more capable, or null at the top. */
export function tierAbove(tier: Tier): Tier | null {
  return TIER_ORDER[tierIndex(tier) + 1] ?? null;
}

export interface ProfileVerdict {
  profile: VolumeProfile | null;
  trusted: boolean;
  reason: string;
}

/**
 * Pick the profile to cost a candidate with, and say plainly whether it can be
 * trusted. An untrusted profile is never silently used as if it were good —
 * the selection engine holds at the agent floor instead, because guessing the
 * volume term is the specific failure this plugin exists to avoid.
 */
export function resolveProfile(
  tier: Tier,
  profiles: readonly VolumeProfile[],
  now: number,
): ProfileVerdict {
  const profile = profiles.find((entry) => entry.tier === tier) ?? null;
  if (!profile) {
    return { profile: null, trusted: false, reason: `no volume profile recorded for ${tier}` };
  }
  if (profile.sampleCount < MIN_PROFILE_SAMPLES) {
    return {
      profile,
      trusted: false,
      reason: `${tier} profile has ${profile.sampleCount} runs, below the ${MIN_PROFILE_SAMPLES}-run minimum`,
    };
  }
  const age = now - Date.parse(profile.computedAt);
  if (!Number.isFinite(age)) {
    return { profile, trusted: false, reason: `${tier} profile has an unparseable computedAt` };
  }
  if (age > PROFILE_MAX_AGE_MS) {
    const days = Math.round(age / (24 * 60 * 60 * 1000));
    return { profile, trusted: false, reason: `${tier} profile is ${days} days old` };
  }
  return { profile, trusted: true, reason: `${tier} profile: ${profile.sampleCount} runs` };
}

/** Direct cost of one run of `model` at the token volume in `profile`. */
export function runCost(
  model: ModelEntry,
  profile: VolumeProfile,
): Pick<CostBreakdown, "runCostUsd" | "inputCostUsd" | "cacheReadCostUsd" | "outputCostUsd"> {
  const inputCostUsd = (profile.avgInputTokens / 1_000_000) * model.costPerMTokIn;
  const cacheReadCostUsd = (profile.avgCacheReadTokens / 1_000_000) * model.costPerMTokCacheRead;
  const outputCostUsd = (profile.avgOutputTokens / 1_000_000) * model.costPerMTokOut;
  return {
    inputCostUsd,
    cacheReadCostUsd,
    outputCostUsd,
    runCostUsd: inputCostUsd + cacheReadCostUsd + outputCostUsd,
  };
}

/**
 * Expected extra cost of choosing this tier and being wrong.
 *
 * ADR-0005's arithmetic, made explicit rather than left as a threshold: an
 * escalation means the cheap run happened AND the expensive run happened, so
 * the penalty is the full cost of a run at the tier above, weighted by how
 * often that tier actually escalates on our own data.
 *
 * A silent quality failure counts 10x an escalation (ADR-0005) — it is
 * invisible by construction, which is exactly why it must be priced rather
 * than merely watched. `silentFailureCount` enters as an effective-rate bump
 * over the same sample.
 */
export function escalationRisk(
  tier: Tier,
  models: readonly ModelEntry[],
  profiles: readonly VolumeProfile[],
  signals: readonly QualitySignal[],
  now: number,
): number {
  const above = tierAbove(tier);
  if (!above) return 0;

  const signal = signals.find((entry) => entry.tier === tier);
  if (!signal || signal.sampleCount <= 0) return 0;

  const silentRate = (signal.silentFailureCount * 10) / signal.sampleCount;
  const effectiveRate = Math.min(1, Math.max(0, signal.escalationRate) + silentRate);
  if (effectiveRate <= 0) return 0;

  const verdict = resolveProfile(above, profiles, now);
  if (!verdict.profile) return 0;

  // Cheapest regular enabled model at the tier above is what an escalation
  // would land on. Fallback-only rows never define the normal redo cost.
  const redo = models
    .filter((model) => model.enabled && !model.fallbackOnly && model.tier === above)
    .map((model) => runCost(model, verdict.profile!).runCostUsd)
    .sort((left, right) => left - right)[0];

  return redo === undefined ? 0 : redo * effectiveRate;
}

/** Full breakdown for one candidate. `expectedCostUsd` is what we order on. */
export function costOf(
  model: ModelEntry,
  profileTier: Tier,
  profiles: readonly VolumeProfile[],
  models: readonly ModelEntry[],
  signals: readonly QualitySignal[],
  now: number,
): CostBreakdown | null {
  const verdict = resolveProfile(profileTier, profiles, now);
  if (!verdict.profile) return null;

  const direct = runCost(model, verdict.profile);
  const escalationRiskUsd = escalationRisk(model.tier, models, profiles, signals, now);

  return {
    modelId: model.id,
    ...direct,
    escalationRiskUsd,
    expectedCostUsd: direct.runCostUsd + escalationRiskUsd,
    profileTier,
    profileTrusted: verdict.trusted,
  };
}
