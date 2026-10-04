import { COST_BAND_MULTIPLIER, EXPLORE_FRACTION, FREE_MUST_BE_PROVEN_USD, type Tier } from "../constants.js";
import { blendedListPrice, hashUnitInterval, laneEffectiveUtilization, type LaneLedger } from "./pacing.js";
import type { Candidate, ModelEntry, ModelScore } from "./types.js";

export interface PickOrderResult {
  /** `candidates`, reordered. Same elements, same length, never re-costed. */
  ordered: Candidate[];
  /** True when the explore roll fired and picked an unproven candidate outright. */
  explored: boolean;
  exploreModelId: string | null;
}

function provenFor(
  modelScores: Readonly<Record<string, ModelScore>>,
  modelId: string,
  tier: Tier,
): boolean {
  return modelScores[modelId]?.tiers[tier]?.proven ?? false;
}

/**
 * Port of `tier_dispatcher.py` `pick()`'s post-capability-gate
 * ordering: the 2026-09-06 14:2xZ "cheapest capable model" rule, its
 * 2026-09-06 16:2xZ free/stealth-must-be-proven carve-out, its 2026-09-05
 * least-utilized-lane spread tiebreak within a 20% cost band, and its 10%
 * T2/T3 explore fraction. `candidates` must already be cost-sorted (as
 * `select.ts` always costs them) — this only ever reorders, never re-costs.
 *
 * Scored against `requiredTier` (the WORK's tier), not each candidate's own
 * roster tier: `ModelScore.tiers[tier]` already means "how has this model
 * done on tier-X work", matching `tier_dispatcher.py`'s `capable(model_id,
 * tier)` where `tier` is the issue's classified/dispatch tier, never the
 * model's own roster row.
 *
 * A no-op (`ordered === candidates` order preserved) whenever every
 * candidate is simultaneously proven and priced >= the free-must-be-proven
 * floor — i.e. this never surprises a company with no scored history yet.
 */
export function applyPickOrdering(
  candidates: readonly Candidate[],
  models: readonly ModelEntry[],
  ledger: LaneLedger,
  modelScores: Readonly<Record<string, ModelScore>>,
  requiredTier: Tier,
  issueId: string,
  /**
   * Port of `tier_dispatcher.py` `pick(..., explore=False)`:
   * `label_only_pass`/`repin_pass`/`balance_pass`'s pinned-branch call sites
   * all suppress the explore roll (they are re-affirming or replacing an
   * already-chosen pin, not seeding new evidence). Defaults to `true` so
   * `advise`/`apply`'s existing behavior is unchanged.
   */
  allowExplore = true,
): PickOrderResult {
  if (candidates.length === 0) {
    return { ordered: [], explored: false, exploreModelId: null };
  }

  const modelOf = (candidate: Candidate): ModelEntry | undefined =>
    models.find((model) => model.id === candidate.modelId);
  const utilizationOf = (candidate: Candidate): number => {
    const model = modelOf(candidate);
    return model?.laneId ? laneEffectiveUtilization(ledger, model.laneId) : 0.5;
  };
  const listPriceOf = (candidate: Candidate): number => {
    const model = modelOf(candidate);
    return model ? blendedListPrice(model) : candidate.expectedCostUsd;
  };
  const provenOf = (candidate: Candidate): boolean => provenFor(modelScores, candidate.modelId, requiredTier);

  // 2026-09-06 14:2xZ owner rule: 10% of T2/T3 picks go to the cheapest
  // unproven candidate so real work can confirm or demote its score. Never
  // T1 — an unproven candidate never earns judgement work. Deterministic per
  // issue+tier, not `Math.random()`: a repeated advise()/apply() pair on the
  // same issue must not flip which candidate "won" the explore roll.
  const unproven = candidates.filter((candidate) => !provenOf(candidate));
  if (
    allowExplore &&
    requiredTier !== "T1" &&
    unproven.length > 0 &&
    hashUnitInterval(`explore:${requiredTier}:${issueId}`) < EXPLORE_FRACTION
  ) {
    const explored = [...unproven].sort((a, b) => a.expectedCostUsd - b.expectedCostUsd)[0]!;
    return {
      ordered: [explored, ...candidates.filter((candidate) => candidate.modelId !== explored.modelId)],
      explored: true,
      exploreModelId: explored.modelId,
    };
  }

  // 2026-09-06 16:2xZ owner rule: a free/stealth candidate (blended LIST
  // price under $0.10/Mtok) must be proven before it enters the normal pick
  // pool — a free tier is exactly where a silent capability regression is
  // cheapest to hide. Falls back to every candidate if the filter would
  // otherwise empty the pool (mirrors `main=[...] or eligible` in Python).
  const main = candidates.filter((candidate) => provenOf(candidate) || listPriceOf(candidate) >= FREE_MUST_BE_PROVEN_USD);
  const pool = main.length > 0 ? main : candidates;

  // 2026-09-05 spread rule: within a 20% band of the cheapest survivor,
  // prefer the least-utilized lane over raw cost order — proven candidates
  // break a true tie ahead of unproven ones, and a deterministic per-issue
  // hash (never `Math.random()`) breaks whatever tie remains.
  const cheapest = Math.min(...pool.map((candidate) => candidate.expectedCostUsd));
  const band = pool.filter((candidate) => candidate.expectedCostUsd <= cheapest * COST_BAND_MULTIPLIER);
  const rest = candidates.filter((candidate) => !band.some((banded) => banded.modelId === candidate.modelId));

  const bandOrdered = [...band].sort((a, b) => {
    const utilizationDelta = utilizationOf(a) - utilizationOf(b);
    if (utilizationDelta !== 0) return utilizationDelta;
    if (a.expectedCostUsd !== b.expectedCostUsd) return a.expectedCostUsd - b.expectedCostUsd;
    const provenDelta = (provenOf(a) ? 0 : 1) - (provenOf(b) ? 0 : 1);
    if (provenDelta !== 0) return provenDelta;
    const tieA = hashUnitInterval(`${issueId}:${a.modelId}`);
    const tieB = hashUnitInterval(`${issueId}:${b.modelId}`);
    if (tieA !== tieB) return tieA - tieB;
    return a.modelId.localeCompare(b.modelId);
  });

  return { ordered: [...bandOrdered, ...rest], explored: false, exploreModelId: null };
}
