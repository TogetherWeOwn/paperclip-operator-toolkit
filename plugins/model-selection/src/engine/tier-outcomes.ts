import { TIERS, type Tier } from "../constants.js";
import type { ModelEntry } from "./types.js";

/**
 * TOG-4959. Per-tier lane-poll outcome counters — read-only telemetry.
 *
 * WHY THIS EXISTS. Tier rosters are audited by lane MEANS (utilization
 * averages per lane), not by OUTCOMES (did the tier's lanes actually serve).
 * These counters answer the outcome question per roster tier: every
 * `pollLaneCapacity` firing maps each lane result onto the tiers that lane
 * serves (via the roster's `laneId`) and increments that tier's
 * polls/succeeded/failed. `model_selection_tier_outcomes` reads them back.
 *
 * WHAT THIS IS NOT. It never touches selection: `select.ts` does not import
 * this module, and the poll job writes these counters alongside the ledger
 * without reading them into any decision. A tier with no lane-backed rows
 * (all models lanless, or all rows disabled) stays at zero — honest "no
 * evidence", never a guess.
 *
 * COUNTING RULE. Per lane result, per mapped tier:
 * - `polls` always increments (the poll happened);
 * - `succeeded` increments only on a clean poll whose verdict says
 *   `serviceable === true`;
 * - `failed` increments on a poll error OR a verdict of
 *   `serviceable === false`;
 * - a clean poll with `serviceable === null` (indeterminate/unknown)
 *   increments `polls` only — absence of evidence is not evidence either way,
 *   the same tri-state discipline `lane-evidence.ts` follows.
 */

export interface TierPollCounters {
  polls: number;
  succeeded: number;
  failed: number;
  /** ISO timestamp of the last poll that mapped to this tier, or null when never. */
  lastAt: string | null;
}

export interface TierPollOutcomes {
  tiers: Record<Tier, TierPollCounters>;
  /** ISO timestamp of the last poll that mapped to ANY tier, or null when never. */
  updatedAt: string | null;
}

/** One lane's poll outcome, reduced to what the counters need. */
export interface TierPollResultInput {
  laneId: string;
  /** Null on a clean poll; the poll error string otherwise. */
  error: string | null;
  /** The poll verdict's `serviceable` (`verdict?.serviceable ?? null`). */
  serviceable: boolean | null;
}

export function emptyTierPollOutcomes(): TierPollOutcomes {
  const tiers = {} as Record<Tier, TierPollCounters>;
  for (const tier of TIERS) tiers[tier] = { polls: 0, succeeded: 0, failed: 0, lastAt: null };
  return { tiers, updatedAt: null };
}

/**
 * Which roster tiers a lane serves. Enabled rows only — a disabled row is not
 * selectable, so its tier must not earn poll evidence from this lane (same
 * rule `scores.ts`'s top-rung computation follows). Deduped: one lane
 * increments each tier once per firing, however many rows share it.
 */
export function tiersForLane(models: readonly ModelEntry[], laneId: string): Tier[] {
  const tiers = new Set<Tier>();
  for (const model of models) {
    if (model.enabled === false) continue;
    if ((model.laneId ?? null) !== laneId) continue;
    tiers.add(model.tier);
  }
  return [...tiers];
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Normalize untyped plugin-state input. Stored state is unversioned JSON a
 * previous build (or a hand edit) may have shaped differently; a malformed
 * value fails OPEN to empty counters rather than crashing the poll job or
 * the read tool. Legacy rows with extra keys are ignored, not rejected.
 */
export function normalizeTierPollOutcomes(stored: unknown): TierPollOutcomes {
  const empty = emptyTierPollOutcomes();
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return empty;
  const record = stored as Record<string, unknown>;
  const tiersRecord =
    record.tiers && typeof record.tiers === "object" && !Array.isArray(record.tiers)
      ? (record.tiers as Record<string, unknown>)
      : null;
  if (!tiersRecord) return empty;
  for (const tier of TIERS) {
    const entry = tiersRecord[tier];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const base = empty.tiers[tier];
    empty.tiers[tier] = {
      polls: isSafeCount(row.polls) ? row.polls : base.polls,
      succeeded: isSafeCount(row.succeeded) ? row.succeeded : base.succeeded,
      failed: isSafeCount(row.failed) ? row.failed : base.failed,
      lastAt: typeof row.lastAt === "string" ? row.lastAt : base.lastAt,
    };
  }
  return {
    tiers: empty.tiers,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

/**
 * Fold one poll firing's results into a copy of `prev`. Pure: never mutates
 * its inputs, so a caller can hold the previous snapshot for comparison.
 * Tiers no lane maps to are returned untouched (still zero when never polled).
 */
export function accumulateTierPollOutcomes(
  prev: TierPollOutcomes,
  results: readonly TierPollResultInput[],
  models: readonly ModelEntry[],
  nowIso: string,
): TierPollOutcomes {
  const tiers = {} as Record<Tier, TierPollCounters>;
  for (const tier of TIERS) tiers[tier] = { ...prev.tiers[tier] };
  let touched = false;
  for (const result of results) {
    for (const tier of tiersForLane(models, result.laneId)) {
      const counter = tiers[tier];
      counter.polls += 1;
      if (result.error === null && result.serviceable === true) counter.succeeded += 1;
      else if (result.error !== null || result.serviceable === false) counter.failed += 1;
      counter.lastAt = nowIso;
      touched = true;
    }
  }
  return { tiers, updatedAt: touched ? nowIso : prev.updatedAt };
}
