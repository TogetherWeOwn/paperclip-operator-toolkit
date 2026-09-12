import type { Tier } from "../constants.js";
import type { ModelEntry, QualitySignal, VolumeProfile } from "./types.js";

/**
 * Building volume profiles from raw run rows.
 *
 * Kept pure and separate from the job that queries the database so the
 * arithmetic is testable without a host — the same reason the queries live in
 * SQL files rather than being re-improvised per run.
 */

export interface RunRow {
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

/**
 * `usage_json.model` can be the literal string `unknown` — a closed population
 * (ADR-0006), not a model. Rows we cannot attribute to a configured model are
 * dropped rather than averaged into a tier they may not belong to.
 */
export function buildVolumeProfiles(
  rows: readonly RunRow[],
  models: readonly ModelEntry[],
  computedAt: string,
): VolumeProfile[] {
  const tiersOf = new Map<string, Tier[]>();
  for (const model of models) {
    if (!model.enabled) continue;
    const tiers = tiersOf.get(model.id) ?? [];
    if (!tiers.includes(model.tier)) tiers.push(model.tier);
    tiersOf.set(model.id, tiers);
  }
  const buckets = new Map<Tier, { n: number; input: number; cache: number; output: number }>();

  for (const row of rows) {
    const tiers = row.model ? tiersOf.get(row.model) : undefined;
    // A runtime model admitted at more than one tier cannot be attributed to a
    // tier from `usage_json.model` alone. Drop it rather than silently assigning
    // its volume to whichever roster row happened to appear last.
    if (!tiers || tiers.length !== 1) continue;
    const tier = tiers[0]!;
    const input = row.inputTokens ?? 0;
    const cache = row.cachedInputTokens ?? 0;
    const output = row.outputTokens ?? 0;
    // A row with no token counts at all carries no volume information; counting
    // it would drag the average toward zero and make a tier look cheaper than
    // it is — the exact direction of error we cannot afford.
    if (input === 0 && cache === 0 && output === 0) continue;
    const bucket = buckets.get(tier) ?? { n: 0, input: 0, cache: 0, output: 0 };
    bucket.n += 1;
    bucket.input += input;
    bucket.cache += cache;
    bucket.output += output;
    buckets.set(tier, bucket);
  }

  return [...buckets.entries()].map(([tier, bucket]) => ({
    tier,
    sampleCount: bucket.n,
    computedAt,
    avgInputTokens: bucket.input / bucket.n,
    avgCacheReadTokens: bucket.cache / bucket.n,
    avgOutputTokens: bucket.output / bucket.n,
  }));
}

export interface EscalationRow {
  tier: Tier;
  escalations: number;
  silentFailures: number;
  issues: number;
}

export function buildQualitySignals(
  rows: readonly EscalationRow[],
  computedAt: string,
): QualitySignal[] {
  return rows.map((row) => ({
    tier: row.tier,
    escalationRate: row.issues > 0 ? row.escalations / row.issues : 0,
    silentFailureCount: row.silentFailures,
    sampleCount: row.issues,
    computedAt,
  }));
}

/**
 * ADR-0005's thresholds, applied. Returns the tiers whose expansion must stop.
 *
 * A T1 breach is a TIER-BOUNDARY diagnosis (move the task type up), a T2 breach
 * is a model-fit diagnosis. One silent quality failure stops expansion on its
 * own, where ten escalations do not — because it is invisible by construction
 * and is precisely what the quality floor exists to prevent.
 */
export function tiersBreachingQualityFloor(
  signals: readonly QualitySignal[],
  ceilings: { T1: number; T2: number },
): Array<{ tier: Tier; reason: string }> {
  const breaches: Array<{ tier: Tier; reason: string }> = [];
  for (const signal of signals) {
    if (signal.silentFailureCount > 0) {
      breaches.push({
        tier: signal.tier,
        reason: `${signal.silentFailureCount} silent quality failure(s) — one stops expansion on its own`,
      });
      continue;
    }
    if (signal.tier === "T1" && signal.escalationRate > ceilings.T1) {
      breaches.push({
        tier: "T1",
        reason: `escalation ${(signal.escalationRate * 100).toFixed(1)}% > ${(ceilings.T1 * 100).toFixed(0)}% — the tier BOUNDARY is wrong, not the model; move the task type up`,
      });
    }
    if (signal.tier === "T2" && signal.escalationRate > ceilings.T2) {
      breaches.push({
        tier: "T2",
        reason: `escalation ${(signal.escalationRate * 100).toFixed(1)}% > ${(ceilings.T2 * 100).toFixed(0)}% — model-fit diagnosis`,
      });
    }
  }
  return breaches;
}
