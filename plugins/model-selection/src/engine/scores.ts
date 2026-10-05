import {
  CARD_CENSOR_DAYS,
  CARD_ZERO_ACCEPT_MIN_RESOLVED,
  CARD_ZERO_ACCEPT_WINDOW_DAYS,
  REWORK_WEIGHT_REJECTED,
  REWORK_WEIGHT_REOPEN,
  SCORE_PRIOR_K,
  SCORE_PROVEN_N,
  TIER_ORDER,
  type Tier,
} from "../constants.js";
import {
  BENCHMARK_SPEC_VERSION,
  blendedPrior,
  type BenchmarkRow,
  type PriorBasis,
} from "./benchmark-prior.js";
import { tierIndex } from "./cost.js";
import { LEGACY_TIER_POLICY, type CompiledTierPolicy } from "./tier-policy.js";
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
 * Blends the composite-index prior with the  five-benchmark basket
 *. Replaces the  agentic sub-score average, which keyed off
 * whatever aa.ai columns happened to be populated rather than a fixed basket.
 *
 * Falls back to the plain index prior when the basket misses its coverage gate,
 * so a caller that supplies no `benchmarkRow` sees byte-identical behavior to
 * before this blend existed.
 *
 * SELECTION-TIME contract, distinct from the tiering one: this always returns a
 * number, and an unscored model (`aaIndex === null`) gets `priorP(null)` — the
 * 0.8 "assume roughly T2 until measured" default. `deriveModelTier` deliberately
 * does NOT reuse that path; see its own note.
 */
export function blendedPriorP(aaIndex: number | null, benchmarkRow?: BenchmarkRow | null): number {
  const blended = blendedPrior(aaIndex, benchmarkRow);
  if (blended.value !== null) return blended.value;
  return priorP(aaIndex);
}

/** `TIER_ORDER` is ascending capability; tier cuts must test the hardest threshold first. */
const TIER_ORDER_BY_CAPABILITY_DESC: readonly Tier[] = [...TIER_ORDER].reverse();

/**
 * Tier from a posterior. T3 is the RESIDUAL bucket, not a fourth threshold.
 *
 * The cuts are the active tier policy's `scoreThresholds`, which
 * for `legacy-model-selection-v1` are still `SCORE_THRESHOLDS`. A model with
 * `p` under the T3 cut clears no tier at all. It is labelled
 * T3 and flagged `belowT3Floor` rather than dropped, because `tier` (the
 * roster's work-class bucket) and `capable` (the per-tier quality gate in
 * `select.ts`) are already separate concepts in this engine: flooring the LABEL
 * does not promote the model, since `summarize`'s `capable` still refuses to let
 * it win T3 work. Dropping it instead would contradict the owner's own live
 * placement of `claude-haiku-4-5` at T3 on an index of 15.41.
 */
export function tierForPosterior(
  p: number,
  thresholds: Partial<Record<Tier, number>> = LEGACY_TIER_POLICY.scoreThresholds,
): { tier: Tier; belowT3Floor: boolean } {
  // MOST CAPABLE FIRST. `TIER_ORDER` is ascending capability (`["T3","T2","T1"]`)
  // because `select.ts` compares tiers by index; walking it as-written would
  // match T3's 0.75 before T1's 0.85 and label every model T3.
  for (const tier of TIER_ORDER_BY_CAPABILITY_DESC) {
    const threshold = thresholds[tier];
    if (threshold !== undefined && p >= threshold) return { tier, belowT3Floor: false };
  }
  return { tier: "T3", belowT3Floor: true };
}

/** A model's derived tier and the evidence trail behind it. */
export interface DerivedTier {
  /** Null ONLY when unscored — the caller must then retain the existing tier. */
  tier: Tier | null;
  belowT3Floor: boolean;
  basis: PriorBasis;
  /** The blended prior, or null when unscored. */
  prior: number | null;
  /** The posterior the tier was cut from, or null when unscored. */
  p: number | null;
  specVersion: string;
}

/**
 * Derive one model's tier from its posterior.
 *
 * FAILS CLOSED on an unscored model. `aaIndex === null` means there is no
 * evidence to tier from, so this returns `tier: null` and the caller retains
 * whatever tier the model already had. It must never fall through to
 * `priorP(null) === 0.8`: that value is exactly `SCORE_THRESHOLDS.T2`, so a
 * naive reuse would promote every unscored model to T2 on no evidence at all.
 */
export function deriveModelTier(
  aaIndex: number | null,
  benchmarkRow: BenchmarkRow | null | undefined,
  overallStats: TierScoreStats,
  priorK: number = SCORE_PRIOR_K,
  thresholds: Partial<Record<Tier, number>> = LEGACY_TIER_POLICY.scoreThresholds,
): DerivedTier {
  const { value: prior, basis } = blendedPrior(aaIndex, benchmarkRow);
  if (prior === null) {
    return { tier: null, belowT3Floor: false, basis, prior: null, p: null, specVersion: BENCHMARK_SPEC_VERSION };
  }
  const nEff = overallStats.wOk + overallStats.wBad;
  const p = (overallStats.wOk + priorK * prior) / (nEff + priorK);
  const { tier, belowT3Floor } = tierForPosterior(p, thresholds);
  return { tier, belowT3Floor, basis, prior: round(prior, 4), p: round(p, 4), specVersion: BENCHMARK_SPEC_VERSION };
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
 *
 * `thresholds` are CAPABILITY bars, not tier cuts. They default to the active
 * tier policy's `capabilityThresholds`, which differ from `SCORE_THRESHOLDS` at
 * T1 (0.8, the serving `t1cap080` bar, vs a 0.85 cut).
 */
export function summarize(
  stats: TierScoreStats,
  tier: Tier | null,
  priorPValue: number,
  priorK: number = SCORE_PRIOR_K,
  provenN: number = SCORE_PROVEN_N,
  thresholds: Partial<Record<Tier, number>> = LEGACY_TIER_POLICY.capabilityThresholds,
  vetoMargin: number = LEGACY_TIER_POLICY.capability.vetoMargin,
): TierScore {
  const nEff = stats.wOk + stats.wBad;
  const pObs = nEff > 0 ? stats.wOk / nEff : null;
  const p = (stats.wOk + priorK * priorPValue) / (nEff + priorK);
  const thr = tier === null ? undefined : thresholds[tier];
  const proven = stats.ok + stats.failModel + stats.tmo >= provenN;

  let capable: boolean | null = null;
  if (thr !== undefined) {
    capable = p >= thr;
    if (proven && pObs !== null && pObs < thr - vetoMargin) capable = false;
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
  benchmarkRow?: BenchmarkRow | null,
  policy: CompiledTierPolicy = LEGACY_TIER_POLICY,
): ModelScore {
  const pp = blendedPriorP(aaIndex, benchmarkRow);
  const { capabilityThresholds, scoreThresholds, capability } = policy;
  const tierScores = {} as Record<Tier, TierScore>;
  for (const tier of tiers) {
    const stats = statsByTier[tier];
    tierScores[tier] = stats
      ? summarize(stats, tier, pp, capability.priorK, capability.provenN, capabilityThresholds, capability.vetoMargin)
      : {
          n: 0,
          ok: 0,
          failInfra: 0,
          failModel: 0,
          tmo: 0,
          nEff: 0,
          pObs: null,
          p: round(pp, 3),
          capable: pp >= capabilityThresholds[tier],
          proven: false,
          costPerSuccessUsd: null,
          medMin: null,
          rework: 0,
        };
  }

  const monotoneTierScores = enforceMonotoneCapability(tierScores);

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

  // the tier is cut from the OVERALL posterior — one number per model,
  // across all tiers — not from any per-tier `capable` gate. Conflating the two
  // is what produced equal-index models landing in different tiers.
  const derivedTier = deriveModelTier(aaIndex, benchmarkRow, agg, capability.priorK, scoreThresholds);

  return {
    modelId,
    aaIndex,
    priorP: round(pp, 3),
    tiers: monotoneTierScores,
    overall: summarize(agg, null, pp, capability.priorK, capability.provenN, capabilityThresholds, capability.vetoMargin),
    derivedTier: derivedTier.tier,
    belowT3Floor: derivedTier.belowT3Floor,
    priorBasis: derivedTier.basis,
    tierSpecVersion: derivedTier.specVersion,
  };
}

/**
 * Capability is monotone in tier order: a tier with no PROVEN
 * evidence of its own is no more capable than any easier tier.
 *
 * Each tier's `capable` is otherwise judged in isolation, and a tier with no
 * stats falls back to `prior >= threshold`. That let `glm-5.3` — measured
 * failing T2 (p=0.585, proven) — pass at the harder T1 on its prior alone,
 * and be the T1 pick on ~38% of T1 decisions (2026-10-02 decisions window).
 *
 * Walks easy to hard. Once a tier fails on its OWN verdict, every harder tier
 * without proven evidence of its own is forced `capable: false` and records
 * that tier in `cappedBy`. A harder tier with proven evidence keeps its own
 * verdict either way. A tier whose `capable` is already false keeps it. Pure
 * and idempotent: a capped tier is never treated as an own-verdict failure,
 * so re-applying it to stored scores (selection does, at read time) changes
 * nothing.
 */
export function enforceMonotoneCapability(tiers: Readonly<Record<Tier, TierScore>>): Record<Tier, TierScore> {
  const out = { ...tiers };
  let adverse: Tier | null = null;
  for (const tier of TIER_ORDER) {
    const score = tiers[tier];
    if (!score) continue;
    if (adverse !== null && !score.proven && score.capable !== false) {
      out[tier] = { ...score, capable: false, cappedBy: adverse };
      continue;
    }
    if (score.capable === false && score.cappedBy === undefined) adverse = tier;
  }
  return out;
}

/**
 * The capability verdict every consumer reads for (model, tier): the stored
 * tier score with `enforceMonotoneCapability` applied. Applied at READ time as
 * well as in `buildModelScore`, so scores persisted before  are held
 * to the rule from the first selection after deploy, not from the next
 * `refreshScores`.
 */
export function tierScoreFor(score: ModelScore | undefined, tier: Tier): TierScore | undefined {
  if (!score?.tiers) return undefined;
  return enforceMonotoneCapability(score.tiers)[tier];
}

/**
 * The highest tier a promotion may reach: the hardest tier whose
 * monotone capability verdict is not false. Undefined when the score carries
 * no tier verdicts at all.
 *
 * Reads the monotone verdict, prior-only verdicts included, rather than
 * requiring evidence AT the target tier. The rung walk only ever runs a model
 * at its own rostered tier, so a T2 row never gathers T1 evidence; demanding
 * it would freeze every T1 promotion and undo . What it does
 * forbid is the defect: a model with an adverse verdict at or below the
 * target being promoted past it.
 */
function promotionCeiling(score: ModelScore): Tier | undefined {
  if (!score.tiers) return undefined;
  const tiers = enforceMonotoneCapability(score.tiers);
  let ceiling: Tier | undefined;
  for (const tier of TIER_ORDER) {
    const verdict = tiers[tier];
    if (verdict && verdict.capable !== false) ceiling = tier;
  }
  return ceiling;
}

/**
 * Overlay each model's derived tier onto the roster the engine selects from.
 *
 * This is how `refreshScores`'s tier write reaches selection. The plugin's
 * `ctx.config` is READ-ONLY (`get()` only — there is no config write in the
 * host SDK), so the derived tier cannot be persisted back into the operator's
 * roster document from inside the plugin. It is persisted in plugin state on
 * the `ModelScore` and applied here, at the one seam every selection passes
 * through, which gives the same live effect: the router alone decides the tier.
 *
 * Retains the configured tier for any model whose score is missing, unscored,
 * or written under a different spec version than the one now running. That last
 * case matters: after a version bump the stored tiers describe a spec this build
 * no longer implements, and honouring them would apply a rule nobody can read
 * off the current source. Stale tiers are ignored until `refreshScores` rewrites
 * them, never silently reinterpreted.
 *
 * Operates on ROWS, not model ids. The roster lists some models more than once
 * — a model id can hold two rows at different tiers and lanes — so a rewrite
 * keyed on the id alone rewrites placements nobody derived. Demotions apply to
 * every row; promotions are refused on an index-only basis and confined to the
 * model's top enabled rung, and capped at the model's capability ceiling (see
 * the three notes inline).
 */
export function applyDerivedTiers<T extends RosterRow>(
  models: readonly T[],
  scoresByModelId: Readonly<Record<string, ModelScore>>,
  specVersion: string = BENCHMARK_SPEC_VERSION,
): T[] {
  const topRung = topConfiguredRungs(models);
  return models.map((model) => {
    const score = scoresByModelId[model.id];
    if (!score || !score.derivedTier) return model;
    if (score.tierSpecVersion !== specVersion) return model;
    const derived = score.derivedTier;
    if (derived === model.tier) return model;

    if (tierIndex(derived) > tierIndex(model.tier)) {
      // PROMOTION. Two refusals, both fail-closed; neither applies to a
      // demotion, which is always safe to act on and always applies per row.
      //
      // 1. An `index-only` basis means the five-benchmark basket missed its
      //    coverage gate, so there is no admissible agentic evidence for this
      //    model at all — only the aa.ai composite. That is enough to keep a
      //    model where it is, or to move it down, but not to hand it harder
      //    work: the two models this fires hardest on measure worst of the
      //    whole capture on the agentic benchmarks we DO have. Retain, and let a populated basket do the promoting.
      if (score.priorBasis === "index-only") return model;
      // 2. A model listed at more than one rung is placed there deliberately
      //    (`gpt-5.6-sol` carries both T1 and T2 on the codex lane). The
      //    derived tier is one verdict per MODEL — the best rung its quality
      //    justifies — while a roster entry is one PLACEMENT, and a model that
      //    qualifies for T1 still qualifies for the T2 row it was explicitly
      //    given. Only the model's top rung moves up, so a promotion can never
      //    vacate a lower rung the operator listed it at.
      if (model.tier !== topRung(model.id)) return model;
      // 3. : never past the hardest tier the model is still capable
      //    at. The derived tier pools every tier's runs, so easy wins can
      //    out-vote a proven failure at the tier just above them (`glm-5.3`:
      //    89/89 at T3 lifting it to T1 while it measures p=0.585 at T2).
      //    Promote only as far as the ceiling; a ceiling at or below the
      //    configured tier retains it — this rule never demotes.
      const ceiling = promotionCeiling(score);
      if (ceiling === undefined || tierIndex(ceiling) <= tierIndex(model.tier)) return model;
      if (tierIndex(derived) > tierIndex(ceiling)) return { ...model, tier: ceiling };
    }

    return { ...model, tier: derived };
  });
}

interface RosterRow {
  id: string;
  tier: Tier;
  /** Absent in callers that carry no enablement (tests, ad-hoc rosters). */
  enabled?: boolean;
}

/**
 * The most capable rung each model id is configured at.
 *
 * Counts enabled rows only — a disabled row is not a rung the fleet can select
 * from, and letting one define the top rung would suppress a live promotion
 * (`glm-5.3` carries a disabled T1 OpenCode-Go row beside its enabled T2 Z.ai
 * one). Falls back to all rows for a model with nothing enabled, so every id
 * still has a defined answer.
 */
function topConfiguredRungs(models: readonly RosterRow[]): (modelId: string) => Tier | undefined {
  const enabledTop = new Map<string, Tier>();
  const anyTop = new Map<string, Tier>();
  const raise = (into: Map<string, Tier>, id: string, tier: Tier): void => {
    const current = into.get(id);
    if (current === undefined || tierIndex(tier) > tierIndex(current)) into.set(id, tier);
  };
  for (const model of models) {
    raise(anyTop, model.id, model.tier);
    if (model.enabled !== false) raise(enabledTop, model.id, model.tier);
  }
  return (modelId) => enabledTop.get(modelId) ?? anyTop.get(modelId);
}

// ---- rework-signal folding (model_scores.py lines 93-131) ------------------
//
// `activity_log` (reopen detection) is NOT allowlisted for this plugin; the
// worker captures reopens via `ctx.events.on("issue.updated", ...)` into
// plugin state instead of a live join, then this job-level code matches each
// captured signal against the run window it already has in hand — same
// semantics (72h/48h closing-run match), different data source.

// ---- quality (p) vs availability split —  ---------------------
//
// p is a PURE QUALITY posterior: wOk / nEff where nEff = wOk + wBad.
// INFRA_RE failures are excused (weight 0, failInfra++ only, no wBad) so
// they never enter nEff or p. This is deliberate: on the frozen
// HOST_EVIDENCE_ROWS fixture 285/376.5 = 75.7% of all failures are infra;
// counting them in p would collapse e.g. claude-opus-5 T1 (90.8% infra
// share but p=0.965) and glm-5.3 T1 (93.8% infra, p=0.885) to ~0.5 and make
// p a mixed availability signal. Availability owns infra instead:
// select.ts excludes via availability.ts (quota/cooldown/accounts) and
// lane-evidence.ts (Wilson proven-dead + zero-success). p stays quality;
// availability stays serviceability. Do not give INFRA_RE a non-zero
// weight without also removing that second term — otherwise infra is
// double-counted or silently excused in both places. The failInfra counter
// is retained separately for observability, never for p.

const FREE_LANE_RE = /(-free$|^big-pickle$|-alpha$|-preview$)/;
const MODEL_FAIL_RE = /flagged for possible cybersecurity|exceeded the adapter execution timeout|timeoutSec|refus/i;
const INFRA_RE =
  /503|502|529|Overloaded|429|exhausted|All credentials|circuit breaker|Stream idle timeout|Stream ended|stalled mid-stream|stopped arriving|mid-response|disabled Claude subscription|ECONN|process_lost|all upstream accounts|not supported for format|issue with the selected model|budget_paused|Missing required permissions|recovery backstop|sandbox gone|401|404|subscription( is)? required/i;

export function normModelId(modelId: string): string {
  return modelId.replace(/^(cliproxy\/|openrouter\/|opencode-go\/)/, "");
}

/**
 * Ported from `model_scores.py`'s `classify()` (lines 50-55).
 *
 * INFRA_RE -> {kind:"infra", weight:0.0} is intentional: infra
 * is excluded from the quality posterior p and counted only as failInfra.
 * See the header above and scores.spec.ts's rawReplayCases / HOST_EVIDENCE
 * 75.7% regression for the invariant this preserves.
 */
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
 * Hard exclusions require outcome-independent observation: rejects
 * and accepts must both age 14 days. The reporting metric resolves rejects
 * early and is therefore insufficient, even when its denominator reaches 8.
 *
 * Only a recent mature cohort can exclude. Its oldest card expires seven days
 * after maturity; recheck at selection time so a stale cache cannot prolong a
 * ban. Refresh may replace the cohort, but never restarts a card's clock.
 * Untyped plugin_state (legacy, malformed, contradictory, pending) fails open.
 */
export function zeroAcceptEvidence(
  modelId: string,
  tier: Tier,
  ledger: Readonly<Record<string, CardLedgerEntry>>,
  nowMs: number,
): { cardsResolved: number; cardsAccepted: number; expiresAtMs: number } | null {
  const entry = ledger[`${modelId}:${tier}`];
  if (!entry) return null;
  if (entry.modelId !== modelId || entry.tier !== tier) return null;
  if (entry.pending !== false) return null;
  if (![entry.cardsClosed, entry.cardsResolved, entry.cardsAccepted].every(validCount)) return null;
  if (entry.cardsResolved > entry.cardsClosed || entry.cardsAccepted > entry.cardsResolved) return null;
  if (entry.cardsAccepted !== 0 || entry.acceptRate !== 0) return null;

  const cohort = entry.qualityCohort;
  if (!cohort) return null;
  if (![cohort.cardsResolved, cohort.cardsAccepted].every(validCount)) return null;
  if (cohort.cardsResolved > entry.cardsResolved || cohort.cardsAccepted > cohort.cardsResolved) return null;
  if (cohort.cardsResolved < CARD_ZERO_ACCEPT_MIN_RESOLVED) return null;
  if (cohort.cardsAccepted !== 0) return null;
  if (![nowMs, cohort.observedAtMs, cohort.oldestClosedAtMs, cohort.newestClosedAtMs].every(validCount)) return null;
  const censorMs = CARD_CENSOR_DAYS * 24 * 60 * 60 * 1000;
  const windowMs = CARD_ZERO_ACCEPT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (cohort.observedAtMs > nowMs || cohort.oldestClosedAtMs > cohort.newestClosedAtMs) return null;
  if (cohort.newestClosedAtMs > cohort.observedAtMs - censorMs) return null;
  const expiresAtMs = cohort.oldestClosedAtMs + censorMs + windowMs;
  if (nowMs >= expiresAtMs) return null;
  return { cardsResolved: cohort.cardsResolved, cardsAccepted: cohort.cardsAccepted, expiresAtMs };
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * §2.2 card-level acceptance ledger. A card closed less than
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
    const qualityWindowMs = CARD_ZERO_ACCEPT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const mature = rows.filter((r) => {
      const age = nowMs - r.closedAtMs;
      return age >= censorMs && age < censorMs + qualityWindowMs;
    });
    const qualityCohort: CardLedgerEntry["qualityCohort"] = mature.length ? {
      cardsResolved: mature.length,
      cardsAccepted: mature.filter((r) => !r.rejected).length,
      oldestClosedAtMs: mature.reduce((oldest, r) => Math.min(oldest, r.closedAtMs), Infinity),
      newestClosedAtMs: mature.reduce((newest, r) => Math.max(newest, r.closedAtMs), -Infinity),
      observedAtMs: nowMs,
    } : undefined;

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
      // Published so a consumer can tell "never accepted" from
      // "not resolved yet". `cardsClosed` alone cannot: it counts the
      // censored rows, so a brand-new entrant reads as a long losing streak.
      cardsResolved: resolved.length,
      cardsAccepted: accepted.length,
      acceptRate,
      costPerCard,
      runsPerCard: runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : null,
      foreignRunShare: resolved.length ? foreignCount / resolved.length : null,
      costPerAcceptedCard: costPerCard !== null && acceptRate > 0 ? costPerCard / acceptRate : null,
      pending: !measured,
      qualityCohort,
    };
  }
  return out;
}
