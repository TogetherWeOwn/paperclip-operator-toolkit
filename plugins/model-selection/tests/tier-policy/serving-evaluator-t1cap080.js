// Frozen PUBLIC DERIVATIVE of the captured tier/capability evaluator.
// Do not call this the byte-identical original or silently refresh its provenance.
//
// Original worker artifact SHA-256 (unchanged):
//   dde5fe180cc86856d2332a6ee56ff3ea62fedd349c91c1550de8bd8773b3c099
// Original captured slices SHA-256 (unchanged, one trailing newline):
//   34776313af7253982428382cc0d6ed8caefaf9800804f87920799b550eea2e65
// Original line ranges: 93,93, 281,285, 1464,1508, 1580,1701, 1896,1902
//
// Public normalization changes ONLY the benchmark-format identifier declaration;
// all algorithm/threshold lines inside the markers are otherwise unchanged.
// tier-policy-replay.spec.ts pins the distinct derivative hash. Its optional
// TIER_POLICY_SERVING_WORKER check first verifies the original worker/slice hashes,
// then applies that exact one-declaration normalization before comparison.
// BEGIN SERVING SLICES
var TIER_ORDER = ["T3", "T2", "T1"];
// operator 2026-10-01 (owner-approved): T1 capability bar 0.85 -> 0.80 (t1cap080 carry-forward)
var T1_CAPABILITY_THRESHOLD = 0.8;
var SCORE_THRESHOLDS = { T1: 0.85, T2: 0.8, T3: 0.75 };
var SCORE_PRIOR_K = 6;
var SCORE_PROVEN_N = 8;
// src/engine/benchmark-prior.ts
var BENCHMARK_SPEC_VERSION = "benchmark-prior-v1";
var BENCHMARKS = [
  { key: "terminalBenchV4Pass1", anchor: 0.6, weight: 0.25 },
  { key: "mercorApex11Pass1", anchor: 0.7, weight: 0.2 },
  { key: "automationBenchAaGuardrailAdjusted", anchor: 0.7, weight: 0.2 },
  { key: "aaOmniscienceSignedIndex", anchor: 45, weight: 0.2 },
  { key: "deepSweV11Pass1", anchor: 0.75, weight: 0.15 }
];
var MIN_POPULATED_BENCHMARKS = 3;
var MIN_AVAILABLE_WEIGHT = 0.75;
var BENCHMARK_BLEND = 0.3;
function clip(value, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, value));
}
function benchmarkPrior(row) {
  if (!row) return null;
  let weighted = 0;
  let availableWeight = 0;
  let populated = 0;
  for (const { key, anchor, weight } of BENCHMARKS) {
    const raw = row[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    weighted += weight * clip(raw / anchor);
    availableWeight += weight;
    populated += 1;
  }
  if (populated < MIN_POPULATED_BENCHMARKS) return null;
  if (availableWeight < MIN_AVAILABLE_WEIGHT) return null;
  return weighted / availableWeight;
}
function indexPriorOrNull(aaIndex) {
  if (typeof aaIndex !== "number" || !Number.isFinite(aaIndex)) return null;
  return clip(0.55 + 0.45 * (aaIndex / 60), 0.55, 1);
}
function blendedPrior(aaIndex, row) {
  const index = indexPriorOrNull(aaIndex);
  if (index === null) return { value: null, basis: "unscored" };
  const basket = benchmarkPrior(row);
  if (basket === null) return { value: index, basis: "index-only" };
  return {
    value: (1 - BENCHMARK_BLEND) * index + BENCHMARK_BLEND * (0.55 + 0.45 * basket),
    basis: "blended"
  };
}
// src/engine/scores.ts
function priorP(aaIndex) {
  if (aaIndex === null) return 0.8;
  return Math.max(0.55, Math.min(1, 0.55 + 0.45 * (aaIndex / 60)));
}
function blendedPriorP(aaIndex, benchmarkRow) {
  const blended = blendedPrior(aaIndex, benchmarkRow);
  if (blended.value !== null) return blended.value;
  return priorP(aaIndex);
}
var TIER_ORDER_BY_CAPABILITY_DESC = [...TIER_ORDER].reverse();
function tierForPosterior(p, thresholds = SCORE_THRESHOLDS) {
  for (const tier2 of TIER_ORDER_BY_CAPABILITY_DESC) {
    const threshold = thresholds[tier2];
    if (threshold !== void 0 && p >= threshold) return { tier: tier2, belowT3Floor: false };
  }
  return { tier: "T3", belowT3Floor: true };
}
function deriveModelTier(aaIndex, benchmarkRow, overallStats, priorK = SCORE_PRIOR_K, thresholds = SCORE_THRESHOLDS) {
  const { value: prior, basis } = blendedPrior(aaIndex, benchmarkRow);
  if (prior === null) {
    return { tier: null, belowT3Floor: false, basis, prior: null, p: null, specVersion: BENCHMARK_SPEC_VERSION };
  }
  const nEff = overallStats.wOk + overallStats.wBad;
  const p = (overallStats.wOk + priorK * prior) / (nEff + priorK);
  const { tier: tier2, belowT3Floor } = tierForPosterior(p, thresholds);
  return { tier: tier2, belowT3Floor, basis, prior: round(prior, 4), p: round(p, 4), specVersion: BENCHMARK_SPEC_VERSION };
}
function emptyTierScoreStats() {
  return { n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, wOk: 0, wBad: 0, rework: 0, okCost: [], okMins: [] };
}
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1];
    const hi = sorted[mid];
    return (lo + hi) / 2;
  }
  return sorted[mid];
}
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function summarize(stats, tier2, priorPValue, priorK = SCORE_PRIOR_K, provenN = SCORE_PROVEN_N, thresholds = SCORE_THRESHOLDS) {
  const nEff = stats.wOk + stats.wBad;
  const pObs = nEff > 0 ? stats.wOk / nEff : null;
  const p = (stats.wOk + priorK * priorPValue) / (nEff + priorK);
  const thr = tier2 === null ? void 0 : tier2 === "T1" ? T1_CAPABILITY_THRESHOLD : thresholds[tier2];
  const proven = stats.ok + stats.failModel + stats.tmo >= provenN;
  let capable = null;
  if (thr !== void 0) {
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
    costPerSuccessUsd: stats.okCost.length ? round(median(stats.okCost), 3) : null,
    medMin: stats.okMins.length ? round(median(stats.okMins), 1) : null,
    rework: stats.rework
  };
}
function buildModelScore(modelId, aaIndex, statsByTier, tiers, benchmarkRow) {
  const pp = blendedPriorP(aaIndex, benchmarkRow);
  const tierScores = {};
  for (const tier2 of tiers) {
    const stats = statsByTier[tier2];
    tierScores[tier2] = stats ? summarize(stats, tier2, pp) : {
      n: 0,
      ok: 0,
      failInfra: 0,
      failModel: 0,
      tmo: 0,
      nEff: 0,
      pObs: null,
      p: round(pp, 3),
      capable: pp >= (tier2 === "T1" ? T1_CAPABILITY_THRESHOLD : SCORE_THRESHOLDS[tier2]),
      proven: false,
      costPerSuccessUsd: null,
      medMin: null,
      rework: 0
    };
  }
  const agg = emptyTierScoreStats();
  for (const tier2 of tiers) {
    const stats = statsByTier[tier2];
    if (!stats) continue;
    agg.n += stats.n;
    agg.ok += stats.ok;
    agg.failInfra += stats.failInfra;
    agg.failModel += stats.failModel;
    agg.tmo += stats.tmo;
    agg.wOk += stats.wOk;
    agg.wBad += stats.wBad;
    agg.rework += stats.rework;
    agg.okCost.push(...stats.okCost);
    agg.okMins.push(...stats.okMins);
  }
  const derivedTier = deriveModelTier(aaIndex, benchmarkRow, agg);
  return {
    modelId,
    aaIndex,
    priorP: round(pp, 3),
    tiers: tierScores,
    overall: summarize(agg, null, pp),
    derivedTier: derivedTier.tier,
    belowT3Floor: derivedTier.belowT3Floor,
    priorBasis: derivedTier.basis,
    tierSpecVersion: derivedTier.specVersion
  };
}
function tierImpliedByIndex(index) {
  const p = priorP(index);
  for (const tier2 of [...TIER_ORDER].reverse()) {
    if (p >= SCORE_THRESHOLDS[tier2]) return tier2;
  }
  return null;
}
// END SERVING SLICES
export {
  T1_CAPABILITY_THRESHOLD,
  SCORE_THRESHOLDS,
  SCORE_PRIOR_K,
  SCORE_PROVEN_N,
  priorP,
  blendedPrior,
  blendedPriorP,
  tierForPosterior,
  deriveModelTier,
  summarize,
  buildModelScore,
  tierImpliedByIndex,
};
