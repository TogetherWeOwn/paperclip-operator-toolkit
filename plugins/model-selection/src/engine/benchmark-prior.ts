/**
 *  §2 five-benchmark capability prior.
 *
 * Supersedes the  agentic sub-score blend that used to live in
 * `scores.ts` (`terminalbenchHard`/`tau2`/`ifbench`/`gpqa`/`hle` averaged at
 * `AGENTIC_PRIOR_BLEND = 0.3`). That blend averaged whatever aa.ai happened to
 * populate, which made a model's prior depend on aa.ai's column coverage rather
 * than on a fixed, weighted basket — two models with equal capability could get
 * different priors purely from which columns were filled in.
 *
 * ## Benchmark identity is load-bearing
 *
 * Each row below names a SPECIFIC published benchmark. Three of these have a
 * near-homonym on aa.ai's own leaderboard that is NOT the same measurement, and
 * silently substituting one for the other is precisely the relabelling the
 *  synthesis had to resolve a disagreement over:
 *
 *   - `A` is **Mercor APEX 1.1** pass@1 — NOT aa.ai's `apexAgents` column.
 *   - `U` is aa.ai AutomationBench's **guardrail-adjusted partial** score
 *     (`automationBenchPartialScore`) — NOT Zapier's `strictScore`.
 *   - `O` is the **signed** Omniscience index (correct − incorrect), which is
 *     legitimately negative for weaker models. `clip` floors the normalised
 *     ratio at 0; the raw negative is never coerced to zero at capture.
 *
 * ## Versioning
 *
 * `BENCHMARK_SPEC_VERSION` is stamped onto every `ModelScore` this prior feeds.
 * The spec (identities, anchors, weights) is frozen: change any of it and you
 * bump the version, so a tier written under v1 stays distinguishable from one
 * written under v2 and a re-tier can never silently rewrite history.
 */

/** Frozen spec identity. Bump on ANY change to identities, anchors, or weights. */
export const BENCHMARK_SPEC_VERSION = "benchmark-prior-v1";

/**
 * One benchmark in the basket. `anchor` is the normalisation denominator — the
 * score treated as "full marks" for this benchmark — and `weight` its share of
 * the basket. Weights sum to 1.0.
 */
export interface BenchmarkSpec {
  readonly key: keyof BenchmarkRow;
  readonly anchor: number;
  readonly weight: number;
}

/**
 * The five benchmarks, with the exact field names a `BenchmarkRow` must use.
 * Field names deliberately encode the publisher and version so a future
 * re-capture against a different revision cannot land in the same slot.
 */
export const BENCHMARKS: readonly BenchmarkSpec[] = [
  { key: "terminalBenchV4Pass1", anchor: 0.6, weight: 0.25 },
  { key: "mercorApex11Pass1", anchor: 0.7, weight: 0.2 },
  { key: "automationBenchAaGuardrailAdjusted", anchor: 0.7, weight: 0.2 },
  { key: "aaOmniscienceSignedIndex", anchor: 45, weight: 0.2 },
  { key: "deepSweV11Pass1", anchor: 0.75, weight: 0.15 },
];

/**
 * A model's benchmark vector. Every field is optional and nullable: a model
 * absent from a leaderboard has NO value for it, which is not the same as
 * scoring zero. A fabricated midpoint or zero would move the prior; an absent
 * field only shrinks the available weight.
 */
export interface BenchmarkRow {
  /** TerminalBench v4 pass@1, 0..1. */
  terminalBenchV4Pass1?: number | null;
  /** Mercor APEX 1.1 pass@1, 0..1. Never aa.ai's `apexAgents`. */
  mercorApex11Pass1?: number | null;
  /** aa.ai AutomationBench guardrail-adjusted partial score, 0..1. Never Zapier's `strictScore`. */
  automationBenchAaGuardrailAdjusted?: number | null;
  /** aa.ai Omniscience SIGNED index (correct − incorrect). Legitimately negative. */
  aaOmniscienceSignedIndex?: number | null;
  /** DeepSWE v1.1 pass@1, 0..1. */
  deepSweV11Pass1?: number | null;
}

/**
 * Coverage gate. Both conditions must hold or the basket is refused outright.
 * Two separate thresholds because they catch different failures: the count
 * stops a single benchmark from standing in for the basket, and the weight
 * stops three *light* benchmarks from doing the same.
 */
export const MIN_POPULATED_BENCHMARKS = 3;
export const MIN_AVAILABLE_WEIGHT = 0.75;

/** Share of the blended prior the benchmark basket carries; the index keeps the rest. */
export const BENCHMARK_BLEND = 0.3;

export function clip(value: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * `B` — the weighted, coverage-gated benchmark basket, 0..1.
 *
 * Returns null when coverage is insufficient, which is the signal to FAIL
 * CLOSED to the index-only prior. Null is never a midpoint and never a zero:
 * refusing to score is a distinct outcome from scoring badly, and collapsing
 * the two is what lets an unmeasured model drift into a tier it never earned.
 *
 * Re-normalises by `availableWeight`, not by the full 1.0, so a model measured
 * on four of five benchmarks is judged on the four it actually has rather than
 * being penalised for the publisher's gap.
 */
export function benchmarkPrior(row: BenchmarkRow | null | undefined): number | null {
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

/** How a blended prior was arrived at — recorded so a tier is always explainable. */
export type PriorBasis =
  /** Both halves available: 0.70 × index + 0.30 × benchmark basket. */
  | "blended"
  /** Benchmark coverage below the gate; index-only prior used (fail-closed). */
  | "index-only"
  /** No aa.ai composite index at all; there is nothing to tier from. */
  | "unscored";

export interface BlendedPrior {
  /** The prior, or null when the model is unscored. */
  value: number | null;
  basis: PriorBasis;
}

/**
 * The aa.ai composite-index prior, or null when the index is missing.
 *
 * Deliberately NOT `priorP` from `scores.ts`. `priorP(null)` returns 0.8, which
 * is a sensible *selection-time* default (assume a new model is roughly T2 until
 * measured) and a trap for *tiering*: 0.8 is exactly `SCORE_THRESHOLDS.T2`, so
 * reusing it here would silently promote every unscored model to T2. Tiering
 * needs "no answer" to stay representable, so this returns null instead.
 */
export function indexPriorOrNull(aaIndex: number | null | undefined): number | null {
  if (typeof aaIndex !== "number" || !Number.isFinite(aaIndex)) return null;
  return clip(0.55 + 0.45 * (aaIndex / 60), 0.55, 1);
}

/**
 * `prior` — index-only, or the 70/30 blend when the basket clears coverage.
 *
 * The basket is mapped onto the same 0.55..1.0 range the index prior uses
 * (`0.55 + 0.45 * B`) before blending, so the two halves are commensurable;
 * blending a raw 0..1 basket against a 0.55..1.0 index prior would drag every
 * blended model downward relative to an index-only one.
 */
export function blendedPrior(
  aaIndex: number | null | undefined,
  row: BenchmarkRow | null | undefined,
): BlendedPrior {
  const index = indexPriorOrNull(aaIndex);
  if (index === null) return { value: null, basis: "unscored" };
  const basket = benchmarkPrior(row);
  if (basket === null) return { value: index, basis: "index-only" };
  return {
    value: (1 - BENCHMARK_BLEND) * index + BENCHMARK_BLEND * (0.55 + 0.45 * basket),
    basis: "blended",
  };
}
