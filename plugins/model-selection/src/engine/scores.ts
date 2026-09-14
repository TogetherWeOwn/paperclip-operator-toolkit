import {
  CARD_CENSOR_DAYS,
  REWORK_WEIGHT_REJECTED,
  REWORK_WEIGHT_REOPEN,
  SCORE_PRIOR_K,
  SCORE_PROVEN_N,
  SCORE_THRESHOLDS,
  type Tier,
} from "../constants.js";
import type { CardLedgerEntry, ModelScore, TierScore, TierScoreStats } from "./types.js";

/**
 * Ported from `model_scores.py` lines 43-48. `aaIndex` must already be resolved
 * (roster lookup / `ModelEntry.aaIndex`) — no hardcoded index table here.
 */
export function priorP(aaIndex: number | null): number {
  if (aaIndex === null) return 0.8;
  return Math.max(0.55, Math.min(1.0, 0.55 + 0.45 * (aaIndex / 60.0)));
}

/**
 * aa.ai agentic sub-benchmark scores (TOG-2438 scope expansion), each
 * already on a 0..1 scale. Optional/nullable per-field — mirrors
 * `AaModelRecord`'s own null gaps, never fabricated.
 */
export interface AgenticSubScores {
  terminalbenchHard?: number | null;
  tau2?: number | null;
  ifbench?: number | null;
  gpqa?: number | null;
  hle?: number | null;
}

/** Weight `priorP` gives the composite intelligence index when an agentic prior is also available. */
const AGENTIC_PRIOR_BLEND = 0.3;

/**
 * A secondary, agentic-benchmark-derived prior, same 0.55-1.0 shape as
 * `priorP`'s index mapping. Returns null when no sub-benchmark is available
 * at all — the caller then falls back to the index-only prior, never a
 * fabricated midpoint. Averages only the sub-benchmarks aa.ai actually
 * populated for this slug.
 */
export function agenticPriorP(scores: AgenticSubScores | null | undefined): number | null {
  if (!scores) return null;
  const values = [scores.terminalbenchHard, scores.tau2, scores.ifbench, scores.gpqa, scores.hle].filter(
    (v): v is number => typeof v === "number",
  );
  if (values.length === 0) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.max(0.55, Math.min(1.0, 0.55 + 0.45 * avg));
}

/**
 * Blends the composite-index prior with the agentic sub-score prior when
 * the latter is available (TOG-2438 scope expansion — "an additional prior
 * alongside the composite index"). Falls back to the plain index prior when
 * no agentic score is available, so a caller that never supplies
 * `agenticScores` sees byte-identical behavior to before this blend existed.
 */
export function blendedPriorP(aaIndex: number | null, agenticScores?: AgenticSubScores | null): number {
  const indexPrior = priorP(aaIndex);
  const agentic = agenticPriorP(agenticScores);
  if (agentic === null) return indexPrior;
  return (1 - AGENTIC_PRIOR_BLEND) * indexPrior + AGENTIC_PRIOR_BLEND * agentic;
}

export function emptyTierScoreStats(): TierScoreStats {
  return { n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, wOk: 0, wBad: 0, rework: 0, okCost: [], okMins: [] };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1] as number;
    const hi = sorted[mid] as number;
    return (lo + hi) / 2;
  }
  return sorted[mid] as number;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Ported from `model_scores.py` lines 133-146 (`summarize`). Pure: no I/O, no
 * global AA_INDEX/THRESH lookup — thresholds and prior are passed in.
 */
export function summarize(
  stats: TierScoreStats,
  tier: Tier | null,
  priorPValue: number,
  priorK: number = SCORE_PRIOR_K,
  provenN: number = SCORE_PROVEN_N,
  thresholds: Partial<Record<Tier, number>> = SCORE_THRESHOLDS,
): TierScore {
  const nEff = stats.wOk + stats.wBad;
  const pObs = nEff > 0 ? stats.wOk / nEff : null;
  const p = (stats.wOk + priorK * priorPValue) / (nEff + priorK);
  const thr = tier === null ? undefined : thresholds[tier];
  const proven = stats.ok + stats.failModel + stats.tmo >= provenN;

  let capable: boolean | null = null;
  if (thr !== undefined) {
    capable = p >= thr;
    if (proven && pObs !== null && pObs < thr - 0.1) capable = false;
  }

  return {
    n: stats.n,
    ok: stats.ok,
    failInfra: stats.failInfra,
    failModel: round(stats.failModel, 1),
    tmo: stats.tmo,
    nEff: round(nEff, 1),
    pObs: pObs === null ? null : round(pObs, 3),
    p: round(p, 3),
    capable,
    proven,
    costPerSuccessUsd: stats.okCost.length ? round(median(stats.okCost) as number, 3) : null,
    medMin: stats.okMins.length ? round(median(stats.okMins) as number, 1) : null,
    rework: stats.rework,
  };
}

export function buildModelScore(
  modelId: string,
  aaIndex: number | null,
  statsByTier: Partial<Record<Tier, TierScoreStats>>,
  tiers: readonly Tier[],
  agenticScores?: AgenticSubScores | null,
): ModelScore {
  const pp = blendedPriorP(aaIndex, agenticScores);
  const tierScores = {} as Record<Tier, TierScore>;
  for (const tier of tiers) {
    const stats = statsByTier[tier];
    tierScores[tier] = stats
      ? summarize(stats, tier, pp)
      : {
          n: 0,
          ok: 0,
          failInfra: 0,
          failModel: 0,
          tmo: 0,
          nEff: 0,
          pObs: null,
          p: round(pp, 3),
          capable: pp >= SCORE_THRESHOLDS[tier],
          proven: false,
          costPerSuccessUsd: null,
          medMin: null,
          rework: 0,
        };
  }

  const agg = emptyTierScoreStats();
  for (const tier of tiers) {
    const stats = statsByTier[tier];
    if (!stats) continue;
    agg.n += stats.n;
    agg.ok += stats.ok;
    agg.failInfra += stats.failInfra;
    agg.failModel += stats.failModel;
    agg.tmo += stats.tmo;
    agg.wOk += stats.wOk;
    agg.wBad += stats.wBad;
    agg.rework += stats.rework;
    (agg.okCost as number[]).push(...stats.okCost);
    (agg.okMins as number[]).push(...stats.okMins);
  }

  return {
    modelId,
    aaIndex,
    priorP: round(pp, 3),
    tiers: tierScores,
    overall: summarize(agg, null, pp),
  };
}

// ---- rework-signal folding (model_scores.py lines 93-131) ------------------
//
// `activity_log` (reopen detection) is NOT allowlisted for this plugin; the
// worker captures reopens via `ctx.events.on("issue.updated", ...)` into
// plugin state instead of a live join, then this job-level code matches each
// captured signal against the run window it already has in hand — same
// semantics (72h/48h closing-run match), different data source.

const FREE_LANE_RE = /(-free$|^big-pickle$|-alpha$|-preview$)/;
const MODEL_FAIL_RE = /flagged for possible cybersecurity|exceeded the adapter execution timeout|timeoutSec|refus/i;
const INFRA_RE =
  /503|502|529|Overloaded|429|exhausted|All credentials|circuit breaker|Stream idle timeout|Stream ended|stalled mid-stream|stopped arriving|mid-response|disabled Claude subscription|ECONN|process_lost|all upstream accounts|not supported for format|issue with the selected model|budget_paused|Missing required permissions|recovery backstop|sandbox gone|401|404/i;

export function normModelId(modelId: string): string {
  return modelId.replace(/^(cliproxy\/|openrouter\/|opencode-go\/)/, "");
}

/** Ported from `model_scores.py`'s `classify()` (lines 50-55). */
export function classifyRunFailure(
  errorText: string | null,
  errorCode: string | null,
  modelId: string,
): { kind: "infra" | "model"; weight: number } {
  if (FREE_LANE_RE.test(normModelId(modelId))) return { kind: "model", weight: 1.0 };
  if (errorCode === "timeout" || MODEL_FAIL_RE.test(errorText ?? "")) return { kind: "model", weight: 1.0 };
  if (INFRA_RE.test(errorText ?? "")) return { kind: "infra", weight: 0.0 };
  if (/400 status code \(no body\)/.test(errorText ?? "")) return { kind: "model", weight: 0.5 };
  return { kind: "model", weight: 0.5 };
}

export interface RunOutcomeRow {
  modelId: string;
  /** Tier of the ISSUE this run worked, not the model's roster tier. Null when unattributable. */
  tier: Tier | null;
  status: "succeeded" | "failed" | "timed_out";
  errorCode: string | null;
  error: string | null;
  costUsd: number | null;
  mins: number | null;
  /** Age of the run in days, for the recency weight (model_scores.py: `exp(-age/10)`). */
  ageDays: number;
}

/**
 * Main accumulation loop, ported from `model_scores.py` lines 64-91. Rows with
 * no tier attribution (issue carries no `tier:*` label) are dropped — a
 * deliberate, documented deviation from the original's `tier:none` bucket,
 * which only ever fed a lesser cross-tier `overall` figure the acceptance
 * criteria's replay test does not examine.
 */
export function accumulateRunStats(
  rows: readonly RunOutcomeRow[],
): Record<string, Partial<Record<Tier, TierScoreStats>>> {
  const out: Record<string, Partial<Record<Tier, TierScoreStats>>> = {};
  for (const row of rows) {
    if (row.tier === null) continue;
    const modelBucket = out[row.modelId] ?? {};
    const stats = modelBucket[row.tier] ?? emptyTierScoreStats();
    const w = Math.exp(-row.ageDays / 10.0);
    const next: TierScoreStats = {
      ...stats,
      n: stats.n + 1,
      okCost: [...stats.okCost],
      okMins: [...stats.okMins],
    };
    if (row.status === "succeeded") {
      next.ok += 1;
      next.wOk += w;
      if (row.costUsd !== null) (next.okCost as number[]).push(row.costUsd);
      if (row.mins !== null) (next.okMins as number[]).push(row.mins);
    } else if (row.status === "timed_out") {
      next.tmo += 1;
      next.wBad += w;
    } else {
      const { kind, weight } = classifyRunFailure(row.error, row.errorCode, row.modelId);
      if (kind === "infra") next.failInfra += 1;
      else {
        next.failModel += weight;
        next.wBad += w * weight;
      }
    }
    modelBucket[row.tier] = next;
    out[row.modelId] = modelBucket;
  }
  return out;
}

export interface ReworkClosingRun {
  modelId: string;
  tier: Tier;
  kind: "reopen" | "rejected";
}

/**
 * Folds captured reopen/rejection signals into the same stats shape
 * `accumulateRunStats` produces. Ported from `model_scores.py` lines 127-131 —
 * note the weight is NOT recency-decayed here, unlike the main loop.
 */
export function foldReworkIntoStats(
  stats: Record<string, Partial<Record<Tier, TierScoreStats>>>,
  reworkEvents: readonly ReworkClosingRun[],
): Record<string, Partial<Record<Tier, TierScoreStats>>> {
  const out: Record<string, Partial<Record<Tier, TierScoreStats>>> = {};
  for (const [modelId, byTier] of Object.entries(stats)) {
    out[modelId] = { ...byTier };
  }
  for (const event of reworkEvents) {
    const weight = event.kind === "reopen" ? REWORK_WEIGHT_REOPEN : REWORK_WEIGHT_REJECTED;
    const modelBucket = out[event.modelId] ?? {};
    const tierStats = modelBucket[event.tier] ?? emptyTierScoreStats();
    modelBucket[event.tier] = {
      ...tierStats,
      failModel: tierStats.failModel + weight,
      wBad: tierStats.wBad + weight,
      rework: tierStats.rework + 1,
    };
    out[event.modelId] = modelBucket;
  }
  return out;
}

export interface ClosingRunCandidate {
  issueId: string;
  modelId: string;
  tier: Tier | null;
  finishedAtMs: number;
  agentId: string | null;
}

/**
 * Finds the closing run a captured reopen/rejection signal attributes to —
 * the latest successful run for that issue, within `windowMs` before the
 * signal, excluding `excludeAgentId` (the rejection path requires the
 * rejecting comment's author to differ from the closing run's agent;
 * reopen detection passes no exclusion).
 */
export function findClosingRun(
  issueId: string,
  atMs: number,
  windowMs: number,
  closingRuns: readonly ClosingRunCandidate[],
  excludeAgentId?: string | null,
): ClosingRunCandidate | null {
  let best: ClosingRunCandidate | null = null;
  for (const run of closingRuns) {
    if (run.issueId !== issueId || run.tier === null) continue;
    if (excludeAgentId != null && run.agentId === excludeAgentId) continue;
    const delta = atMs - run.finishedAtMs;
    if (delta < 0 || delta > windowMs) continue;
    if (!best || run.finishedAtMs > best.finishedAtMs) best = run;
  }
  return best;
}

/** A single closed card, as observed from allowlisted tables + captured events. */
export interface CardRow {
  modelId: string;
  tier: Tier;
  /** ms epoch the card was closed (moved to `done`). */
  closedAtMs: number;
  /** True if a reopen (<=72h) or rejection comment (<=48h) was observed for this card. */
  rejected: boolean;
  costUsd: number | null;
  runCount: number;
  /** True when the accepted/closing run's model differs from `modelId` (foreign run). */
  foreignRun: boolean;
}

/**
 * TOG-1917 §2.2 card-level acceptance ledger. A card closed less than
 * `CARD_CENSOR_DAYS` ago and not yet rejected is `pending` — right-censored,
 * excluded from both the accepted and rejected counts (never assumed 1.0).
 */
export function buildCardLedger(
  cards: readonly CardRow[],
  nowMs: number,
  priorPByModel: Record<string, number>,
  blendedListPriceByModel: Record<string, number | null>,
): Record<string, CardLedgerEntry> {
  const byKey = new Map<string, CardRow[]>();
  for (const card of cards) {
    const key = `${card.modelId}\0${card.tier}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(card);
    else byKey.set(key, [card]);
  }

  const out: Record<string, CardLedgerEntry> = {};
  for (const [key, rows] of byKey) {
    const [modelId, tier] = key.split("\0") as [string, Tier];
    const censorMs = CARD_CENSOR_DAYS * 24 * 60 * 60 * 1000;
    const resolved = rows.filter((r) => r.rejected || nowMs - r.closedAtMs >= censorMs);
    const accepted = resolved.filter((r) => !r.rejected);

    const costs = resolved.map((r) => r.costUsd).filter((c): c is number => c !== null);
    const runs = resolved.map((r) => r.runCount);
    const foreignCount = resolved.filter((r) => r.foreignRun).length;

    const measured = resolved.length > 0;
    const acceptRate = measured ? accepted.length / resolved.length : priorPByModel[modelId] ?? 0.8;
    const costPerCard = costs.length
      ? costs.reduce((a, b) => a + b, 0) / costs.length
      : blendedListPriceByModel[modelId] ?? null;

    out[key.replace("\0", ":")] = {
      modelId,
      tier,
      cardsClosed: rows.length,
      acceptRate,
      costPerCard,
      runsPerCard: runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : null,
      foreignRunShare: resolved.length ? foreignCount / resolved.length : null,
      costPerAcceptedCard: costPerCard !== null && acceptRate > 0 ? costPerCard / acceptRate : null,
      pending: !measured,
    };
  }
  return out;
}
