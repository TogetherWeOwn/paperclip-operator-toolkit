import type { Tier } from "../constants.js";
import { laneVerdictFor, type LaneLedger } from "./pacing.js";
import type { Candidate, ModelEntry, ModelScore } from "./types.js";

export interface FreeEarnInPick {
  candidate: Candidate;
  laneId: string;
  /** Recorded (model, tier) run count behind the "until judged" bound. */
  observations: number;
}

function modelOf(models: readonly ModelEntry[], candidate: Candidate): ModelEntry | undefined {
  return models.find((model) => model.id === candidate.modelId);
}

/**
 * TOG-3406 rule (b), 2026-09-19 owner rule: a free subscription lane whose
 * credential is serviceable and under its per-account cap wins its tier over
 * a paid/earned model until it has enough observations to be judged —
 * otherwise a new subscription can never earn placement.
 *
 * Eligibility, all required:
 * - the lane's pace verdict is `free` with `serviceable === true`. The 5h and
 *   weekly meters behind a subscription are invisible here (CLIProxy exposes
 *   only cooldown/retry_at, no quota signal), so a serviceable reading IS the
 *   "unused budget" proxy — and the day the lane reports exhausted, the
 *   serviceability hard stop in `select.ts` excludes it before this runs. No
 *   throttling assumption is baked in anywhere.
 * - the (model, requiredTier) score is not yet `proven` (fewer than
 *   SCORE_PROVEN_N judged runs). Proven is the "enough observations" bound —
 *   the same bound `summarize()` uses, not a second number to drift.
 * - the tier verdict is not an explicit `capable === false`. Earn-in seeds
 *   evidence for the unjudged; it never re-admits the measured-failing (the
 *   `capability-score` gate already rejected those before this runs — this is
 *   belt and braces so a future caller can't promote one by mistake).
 *
 * Per-account-cap and 5h admission are NOT re-checked here: they already gate
 * NEW admission upstream (`lane-no-room` rejections in `select.ts`), so every
 * candidate reaching this function survived them. This is a pure reorder over
 * gate survivors, never an admission bypass.
 *
 * Never crosses tiers: `select.ts` calls this over the single-rung `candidates`
 * array the tier ladder already settled, so the worst this does is reorder
 * within one tier — the same confinement `orderCandidatesByPace` honors.
 */
export function freeEarnInCandidates(
  candidates: readonly Candidate[],
  models: readonly ModelEntry[],
  ledger: LaneLedger,
  modelScores: Readonly<Record<string, ModelScore>> | undefined,
  requiredTier: Tier,
): FreeEarnInPick[] {
  const picks: FreeEarnInPick[] = [];
  for (const candidate of candidates) {
    const model = modelOf(models, candidate);
    const laneId = model?.laneId ?? null;
    if (!laneId) continue;
    const verdict = laneVerdictFor(ledger, laneId);
    if (!verdict || verdict.state !== "free" || verdict.serviceable !== true) continue;
    const tierScore = modelScores?.[candidate.modelId]?.tiers[requiredTier];
    if (tierScore?.proven) continue;
    if (tierScore?.capable === false) continue;
    picks.push({ candidate, laneId, observations: tierScore?.n ?? 0 });
  }
  return picks;
}

/**
 * The single earn-in pick: cheapest expected cost first (a free lane costs
 * ~$0/run, so this is usually first-come), newest release then stable id
 * behind that — the same tiebreak ladder `select.ts` uses, so two unjudged
 * subscription lanes settle deterministically. Null when nobody qualifies.
 */
export function freeEarnInWinner(
  candidates: readonly Candidate[],
  models: readonly ModelEntry[],
  ledger: LaneLedger,
  modelScores: Readonly<Record<string, ModelScore>> | undefined,
  requiredTier: Tier,
): FreeEarnInPick | null {
  const picks = freeEarnInCandidates(candidates, models, ledger, modelScores, requiredTier);
  if (picks.length === 0) return null;
  const sorted = [...picks].sort((a, b) => {
    if (a.candidate.expectedCostUsd !== b.candidate.expectedCostUsd) {
      return a.candidate.expectedCostUsd - b.candidate.expectedCostUsd;
    }
    if (a.candidate.releasedAt !== b.candidate.releasedAt) {
      return a.candidate.releasedAt > b.candidate.releasedAt ? -1 : 1;
    }
    return a.candidate.modelId.localeCompare(b.candidate.modelId);
  });
  return sorted[0]!;
}
