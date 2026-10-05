import { describe, expect, it } from "vitest";

import { SCORE_THRESHOLDS, TIERS, type Tier } from "../src/constants.js";
import {
  BENCHMARKS,
  BENCHMARK_BLEND,
  BENCHMARK_SPEC_VERSION,
  MIN_AVAILABLE_WEIGHT,
  MIN_POPULATED_BENCHMARKS,
  benchmarkPrior,
  blendedPrior,
  indexPriorOrNull,
  type BenchmarkRow,
} from "../src/engine/benchmark-prior.js";
import { FROZEN_BENCHMARK_ROWS } from "../src/engine/benchmark-data.js";
import {
  applyDerivedTiers,
  blendedPriorP,
  buildModelScore,
  deriveModelTier,
  emptyTierScoreStats,
  priorP,
  tierForPosterior,
} from "../src/engine/scores.js";
import type { ModelScore, TierScoreStats } from "../src/engine/types.js";

/** A four-benchmark row (weight 0.85) — the best coverage the v1 capture affords. */
const FULL_ROW: BenchmarkRow = {
  terminalBenchV4Pass1: 0.48989898989899,
  mercorApex11Pass1: 0.658,
  automationBenchAaGuardrailAdjusted: 0.565735557649325,
  aaOmniscienceSignedIndex: 37.0666666666667,
};

function statsWith(wOk: number, wBad: number): TierScoreStats {
  return { ...emptyTierScoreStats(), wOk, wBad };
}

describe("benchmark spec identity ( §2)", () => {
  // Benchmark identity is load-bearing: three of the five have a near-homonym on
  // aa.ai's leaderboard that is a DIFFERENT measurement. This test is the guard
  // against a silent relabelling — the exact failure the synthesis had to
  // resolve a disagreement over.
  it("names exactly the five specified benchmarks, with the specified anchors and weights", () => {
    expect(BENCHMARKS.map((b) => [b.key, b.anchor, b.weight])).toEqual([
      ["terminalBenchV4Pass1", 0.6, 0.25],
      ["mercorApex11Pass1", 0.7, 0.2],
      ["automationBenchAaGuardrailAdjusted", 0.7, 0.2],
      ["aaOmniscienceSignedIndex", 45, 0.2],
      ["deepSweV11Pass1", 0.75, 0.15],
    ]);
  });

  it("does not read aa.ai's apexAgents or Zapier's strictScore under any key", () => {
    const keys = BENCHMARKS.map((b) => String(b.key));
    expect(keys).not.toContain("apexAgents");
    expect(keys).not.toContain("strictScore");
    expect(keys).not.toContain("automationBenchStrictScore");
  });

  it("weights sum to 1.0", () => {
    expect(BENCHMARKS.reduce((sum, b) => sum + b.weight, 0)).toBeCloseTo(1, 10);
  });
});

describe("benchmarkPrior coverage gate", () => {
  it("accepts four populated benchmarks (weight 0.85)", () => {
    expect(benchmarkPrior(FULL_ROW)).toBeCloseTo(0.8452988830850235, 10);
  });

  // The count gate and the weight gate catch different failures, so each needs
  // its own case. This row clears the COUNT (3 populated) and fails the WEIGHT
  // (0.20+0.20+0.20 = 0.60 < 0.75) — it must still fail closed.
  it("fails closed when three populated benchmarks carry too little weight", () => {
    const row: BenchmarkRow = {
      mercorApex11Pass1: 0.5,
      automationBenchAaGuardrailAdjusted: 0.5,
      aaOmniscienceSignedIndex: 20,
    };
    const populated = BENCHMARKS.filter((b) => typeof row[b.key] === "number");
    expect(populated).toHaveLength(MIN_POPULATED_BENCHMARKS);
    expect(populated.reduce((sum, b) => sum + b.weight, 0)).toBeLessThan(MIN_AVAILABLE_WEIGHT);
    expect(benchmarkPrior(row)).toBeNull();
  });

  it("fails closed below three populated benchmarks", () => {
    expect(benchmarkPrior({ terminalBenchV4Pass1: 0.6, mercorApex11Pass1: 0.7 })).toBeNull();
  });

  // Honest note on gate independence: under the v1 weights the count gate is
  // currently UNREACHABLE on its own — the two heaviest benchmarks sum to 0.45,
  // so nothing can clear 0.75 weight with fewer than three populated fields.
  // No input can therefore distinguish "count gate removed" from the code as
  // written, and the mutation gate carries no mutant for it. It is kept as
  // defence-in-depth: it becomes load-bearing the moment a re-weighting gives
  // any two benchmarks 0.75 between them. This test pins the assumption so
  // that re-weighting fails here rather than silently widening the gate.
  it("cannot reach the weight gate with two benchmarks under the v1 weights", () => {
    const heaviestTwo = [...BENCHMARKS]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MIN_POPULATED_BENCHMARKS - 1)
      .reduce((sum, b) => sum + b.weight, 0);
    expect(heaviestTwo).toBeLessThan(MIN_AVAILABLE_WEIGHT);
  });

  it("fails closed on an empty or absent row rather than returning a midpoint", () => {
    expect(benchmarkPrior({})).toBeNull();
    expect(benchmarkPrior(null)).toBeNull();
    expect(benchmarkPrior(undefined)).toBeNull();
  });

  it("re-normalises by available weight, not by the full 1.0", () => {
    // Every populated field at exactly its anchor => basket 1.0 despite the
    // absent fifth benchmark. Dividing by 1.0 instead would yield 0.80.
    expect(
      benchmarkPrior({
        terminalBenchV4Pass1: 0.6,
        mercorApex11Pass1: 0.7,
        automationBenchAaGuardrailAdjusted: 0.7,
        deepSweV11Pass1: 0.75,
      }),
    ).toBeCloseTo(1, 10);
  });
});

describe("missing is absent, never zero", () => {
  const base: BenchmarkRow = {
    terminalBenchV4Pass1: 0.6,
    mercorApex11Pass1: 0.7,
    automationBenchAaGuardrailAdjusted: 0.7,
    deepSweV11Pass1: 0.75,
  };

  it("omitting a benchmark differs from scoring zero on it", () => {
    const absent = benchmarkPrior(base);
    const zero = benchmarkPrior({ ...base, aaOmniscienceSignedIndex: 0 });
    expect(absent).toBeCloseTo(1, 10);
    expect(zero).toBeCloseTo(0.8, 10);
    expect(absent).not.toBeCloseTo(zero as number, 10);
  });

  it("treats null and non-finite the same as absent", () => {
    expect(benchmarkPrior({ ...base, aaOmniscienceSignedIndex: null })).toBeCloseTo(1, 10);
    expect(benchmarkPrior({ ...base, aaOmniscienceSignedIndex: Number.NaN })).toBeCloseTo(1, 10);
  });
});

describe("signed Omniscience index", () => {
  const base: BenchmarkRow = {
    terminalBenchV4Pass1: 0.6,
    mercorApex11Pass1: 0.7,
    automationBenchAaGuardrailAdjusted: 0.7,
    deepSweV11Pass1: 0.75,
  };

  // O is correct-minus-incorrect and is legitimately negative for weaker models.
  // A negative value is REAL EVIDENCE: it counts toward available weight and
  // contributes 0 to the numerator. Dropping it instead would let a model dodge
  // its own worst result and score as if unmeasured.
  it("counts a negative index as populated, contributing zero", () => {
    const negative = benchmarkPrior({ ...base, aaOmniscienceSignedIndex: -10 });
    const zero = benchmarkPrior({ ...base, aaOmniscienceSignedIndex: 0 });
    expect(negative).toBeCloseTo(zero as number, 10);
    expect(negative).toBeCloseTo(0.8, 10);
  });

  it("is carried negative in the frozen capture, not coerced at rest", () => {
    expect(FROZEN_BENCHMARK_ROWS["claude-haiku-4-5-20251001"]?.aaOmniscienceSignedIndex).toBeLessThan(0);
  });
});

describe("indexPriorOrNull vs priorP — the 0.8 trap", () => {
  // priorP(null) === 0.8 is a sensible SELECTION default and a tiering trap:
  // 0.8 is exactly SCORE_THRESHOLDS.T2, so reusing it would promote every
  // unscored model to T2 on no evidence. The two must stay distinct.
  it("priorP still returns the 0.8 selection-time default", () => {
    expect(priorP(null)).toBe(0.8);
    expect(priorP(null)).toBe(SCORE_THRESHOLDS.T2);
  });

  it("indexPriorOrNull returns null instead, so tiering can fail closed", () => {
    expect(indexPriorOrNull(null)).toBeNull();
    expect(indexPriorOrNull(undefined)).toBeNull();
    expect(indexPriorOrNull(Number.NaN)).toBeNull();
  });

  it("agrees with priorP wherever an index exists", () => {
    for (const index of [0, 10, 22, 48, 51, 1000]) {
      expect(indexPriorOrNull(index)).toBeCloseTo(priorP(index), 12);
    }
  });
});

describe("blendedPrior", () => {
  it("blends 0.70 index + 0.30 (0.55 + 0.45 B) when coverage clears", () => {
    const result = blendedPrior(48, FULL_ROW);
    expect(result.basis).toBe("blended");
    expect(result.value).toBeCloseTo(0.9161153492164782, 10);
    // Stated independently of the implementation's arithmetic.
    const expected = (1 - BENCHMARK_BLEND) * 0.91 + BENCHMARK_BLEND * (0.55 + 0.45 * 0.8452988830850235);
    expect(result.value).toBeCloseTo(expected, 10);
  });

  it("falls back to the index-only prior when the basket misses coverage", () => {
    const result = blendedPrior(48, { aaOmniscienceSignedIndex: 37 });
    expect(result.basis).toBe("index-only");
    expect(result.value).toBeCloseTo(0.91, 10);
  });

  it("reports unscored when there is no composite index", () => {
    expect(blendedPrior(null, FULL_ROW)).toEqual({ value: null, basis: "unscored" });
  });

  it("blendedPriorP keeps the selection contract: always a number, 0.8 when unscored", () => {
    expect(blendedPriorP(null, FULL_ROW)).toBe(0.8);
    expect(blendedPriorP(48, FULL_ROW)).toBeCloseTo(0.9161153492164782, 10);
    expect(blendedPriorP(48, null)).toBeCloseTo(0.91, 10);
  });
});

describe("tierForPosterior", () => {
  // TIER_ORDER is ASCENDING capability (["T3","T2","T1","T0"]). Walking it
  // as-written matches T3's 0.75 before T0's 0.90 and labels every model T3.
  // This is the regression guard for that.
  it("returns the MOST capable tier the posterior clears", () => {
    expect(tierForPosterior(0.95).tier).toBe("T0");
    expect(tierForPosterior(0.89).tier).toBe("T1");
    expect(tierForPosterior(0.86).tier).toBe("T1");
    expect(tierForPosterior(0.82).tier).toBe("T2");
    expect(tierForPosterior(0.76).tier).toBe("T3");
  });

  it("treats each threshold as inclusive at its exact boundary", () => {
    expect(tierForPosterior(SCORE_THRESHOLDS.T0).tier).toBe("T0");
    expect(tierForPosterior(SCORE_THRESHOLDS.T1).tier).toBe("T1");
    expect(tierForPosterior(SCORE_THRESHOLDS.T2).tier).toBe("T2");
    expect(tierForPosterior(SCORE_THRESHOLDS.T3).tier).toBe("T3");
  });

  it("labels a sub-floor posterior T3 with a flag rather than dropping it", () => {
    const result = tierForPosterior(0.625);
    expect(result.tier).toBe("T3");
    expect(result.belowT3Floor).toBe(true);
    expect(TIERS).toContain(result.tier);
  });

  it("does not flag a model that genuinely cleared T3", () => {
    expect(tierForPosterior(0.76).belowT3Floor).toBe(false);
  });
});

describe("deriveModelTier", () => {
  it("fails closed on an unscored model instead of reaching priorP(null)", () => {
    const derived = deriveModelTier(null, FULL_ROW, emptyTierScoreStats());
    expect(derived.tier).toBeNull();
    expect(derived.basis).toBe("unscored");
    expect(derived.p).toBeNull();
    // The specific failure this guards: 0.8 would have cut a T2.
    expect(tierForPosterior(priorP(null)).tier).toBe("T2");
  });

  it("cuts the tier from the posterior, not the bare prior", () => {
    // Local evidence must move the answer: 6 weighted failures against a 0.91
    // prior drag the posterior below every cut.
    const noEvidence = deriveModelTier(48, FULL_ROW, emptyTierScoreStats());
    const withFailures = deriveModelTier(48, FULL_ROW, statsWith(0, 6));
    expect(noEvidence.tier).toBe("T0");
    expect(noEvidence.p).toBe(0.9161);
    expect(withFailures.p).toBe(0.4581);
    expect(withFailures.tier).toBe("T3");
    expect(withFailures.belowT3Floor).toBe(true);
  });

  it("stamps the spec version on every scored result", () => {
    expect(deriveModelTier(48, FULL_ROW, emptyTierScoreStats()).specVersion).toBe(BENCHMARK_SPEC_VERSION);
    expect(deriveModelTier(null, null, emptyTierScoreStats()).specVersion).toBe(BENCHMARK_SPEC_VERSION);
  });

  it("records index-only basis when the basket is refused", () => {
    expect(deriveModelTier(48, null, emptyTierScoreStats()).basis).toBe("index-only");
  });
});

describe("buildModelScore tier derivation", () => {
  it("attaches the derived tier, flag, basis and version", () => {
    const score = buildModelScore("m", 48, {}, TIERS, FULL_ROW);
    expect(score.derivedTier).toBe("T0");
    expect(score.belowT3Floor).toBe(false);
    expect(score.priorBasis).toBe("blended");
    expect(score.tierSpecVersion).toBe(BENCHMARK_SPEC_VERSION);
  });

  it("leaves derivedTier null for an unscored model", () => {
    const score = buildModelScore("m", null, {}, TIERS, null);
    expect(score.derivedTier).toBeNull();
    expect(score.priorBasis).toBe("unscored");
  });

  // tier and capable are separate concepts: a model can be labelled T3 by the
  // residual rule and still be refused T3 work by the capability gate.
  it("keeps tier and per-tier capable independent", () => {
    const score = buildModelScore("m", 10, {}, TIERS, null);
    expect(score.derivedTier).toBe("T3");
    expect(score.belowT3Floor).toBe(true);
    expect(score.tiers.T3.capable).toBe(false);
  });
});

describe("applyDerivedTiers", () => {
  const roster = [
    { id: "a", tier: "T3" as Tier },
    { id: "b", tier: "T2" as Tier },
    { id: "c", tier: "T1" as Tier },
  ];

  // 4 populated, 0.85 available weight — clears the coverage gate, so the score
  // carries a `blended` basis and is allowed to promote.
  const BASKET = {
    terminalBenchV4Pass1: 0.5,
    mercorApex11Pass1: 0.6,
    automationBenchAaGuardrailAdjusted: 0.6,
    aaOmniscienceSignedIndex: 30,
  };

  function score(modelId: string, derivedTier: Tier | null, specVersion = BENCHMARK_SPEC_VERSION): ModelScore {
    return { ...buildModelScore(modelId, 48, {}, TIERS, BASKET), derivedTier, tierSpecVersion: specVersion };
  }

  /** Same tier verdict, but with no admissible basket behind it. */
  function indexOnlyScore(modelId: string, derivedTier: Tier | null): ModelScore {
    const out = { ...buildModelScore(modelId, 48, {}, TIERS, null), derivedTier };
    expect(out.priorBasis).toBe("index-only");
    return out;
  }

  it("overlays the derived tier onto the roster", () => {
    const out = applyDerivedTiers(roster, { a: score("a", "T1") });
    expect(out.find((m) => m.id === "a")?.tier).toBe("T1");
  });

  it("retains the configured tier when the model is unscored", () => {
    const out = applyDerivedTiers(roster, { b: score("b", null) });
    expect(out.find((m) => m.id === "b")?.tier).toBe("T2");
  });

  it("retains the configured tier when no score exists at all", () => {
    expect(applyDerivedTiers(roster, {})).toEqual(roster);
  });

  // A tier written under a superseded spec describes a rule this build no longer
  // implements. Ignore it until refreshScores rewrites it; never reinterpret it.
  it("ignores a tier written under a different spec version", () => {
    const out = applyDerivedTiers(roster, { c: score("c", "T3", "benchmark-prior-v0") });
    expect(out.find((m) => m.id === "c")?.tier).toBe("T1");
  });

  it("does not mutate the input roster", () => {
    const before = JSON.parse(JSON.stringify(roster));
    applyDerivedTiers(roster, { a: score("a", "T1") });
    expect(roster).toEqual(before);
  });

  // An index-only basis means the basket missed the coverage gate: there is no
  // admissible agentic evidence, only the aa.ai composite. That may hold a model
  // where it is or move it down, never hand it harder work.
  describe("index-only basis", () => {
    it("refuses a promotion", () => {
      const out = applyDerivedTiers(roster, { a: indexOnlyScore("a", "T1") });
      expect(out.find((m) => m.id === "a")?.tier).toBe("T3");
    });

    it("still applies a demotion", () => {
      const out = applyDerivedTiers(roster, { c: indexOnlyScore("c", "T3") });
      expect(out.find((m) => m.id === "c")?.tier).toBe("T3");
    });
  });

  // The roster lists some model ids twice, at different tiers and lanes
  // (`gpt-5.6-sol` holds T1 and T2 on the codex lane). A rewrite keyed on the id
  // alone collapses both rows onto one verdict and silently vacates a rung.
  describe("a model configured at more than one rung", () => {
    const dual = [
      { id: "sol", tier: "T1" as Tier, enabled: true },
      { id: "sol", tier: "T2" as Tier, enabled: true },
      { id: "other", tier: "T2" as Tier, enabled: true },
    ];

    it("keeps the lower rung when the derived tier matches the upper one", () => {
      const out = applyDerivedTiers(dual, { sol: score("sol", "T1") });
      expect(out.filter((m) => m.id === "sol").map((m) => m.tier)).toEqual(["T1", "T2"]);
    });

    it("demotes every row above the derived tier", () => {
      const out = applyDerivedTiers(dual, { sol: score("sol", "T3") });
      expect(out.filter((m) => m.id === "sol").map((m) => m.tier)).toEqual(["T3", "T3"]);
    });

    // `glm-5.3` carries a DISABLED T1 row beside its enabled T2 one. Counting the
    // disabled row as the top rung would suppress a live promotion.
    it("ignores a disabled row when choosing the rung that moves up", () => {
      const withDisabled = [
        { id: "glm", tier: "T2" as Tier, enabled: true },
        { id: "glm", tier: "T1" as Tier, enabled: false },
      ];
      const out = applyDerivedTiers(withDisabled, { glm: score("glm", "T1") });
      expect(out.map((m) => m.tier)).toEqual(["T1", "T1"]);
    });
  });

  // . The derived tier pools every tier's runs, so easy T3 wins
  // out-voted glm-5.3's proven T2 failure and promoted it to T1. A promotion
  // now stops at the hardest tier the model is still capable at.
  describe("capability ceiling", () => {
    const stats = (partial: Partial<TierScoreStats>): TierScoreStats => ({ ...emptyTierScoreStats(), ...partial });
    const PROVEN_PASS = stats({ n: 89, ok: 89, wOk: 89 });
    const PROVEN_FAIL = stats({ n: 44, ok: 22, failInfra: 4, failModel: 18, wOk: 21.6, wBad: 18.4 });

    function scored(
      modelId: string,
      byTier: Partial<Record<Tier, TierScoreStats>>,
      derivedTier: Tier,
    ): ModelScore {
      const out = { ...buildModelScore(modelId, 48, byTier, TIERS, BASKET), derivedTier };
      expect(out.priorBasis).toBe("blended");
      return out;
    }

    it("refuses the glm-5.3 promotion past the T2 tier it measures failing", () => {
      const glm = scored("glm", { T3: PROVEN_PASS, T2: PROVEN_FAIL }, "T1");
      expect(glm.tiers.T1).toMatchObject({ capable: false, cappedBy: "T2" });
      const withDisabled = [
        { id: "glm", tier: "T2" as Tier, enabled: true },
        { id: "glm", tier: "T1" as Tier, enabled: false },
      ];
      expect(applyDerivedTiers(withDisabled, { glm }).map((m) => m.tier)).toEqual(["T2", "T1"]);
    });

    it("promotes only as far as the ceiling", () => {
      const a = scored("a", { T3: PROVEN_PASS, T1: PROVEN_FAIL }, "T1");
      expect(a.tiers.T2.capable).toBe(true);
      expect(applyDerivedTiers(roster, { a }).find((m) => m.id === "a")?.tier).toBe("T2");
    });

    it("retains the configured tier when nothing above it is capable", () => {
      const a = scored("a", { T3: PROVEN_FAIL }, "T1");
      expect(applyDerivedTiers(roster, { a }).find((m) => m.id === "a")?.tier).toBe("T3");
    });

    it("still applies a demotion, whatever the ceiling", () => {
      const c = scored("c", { T3: PROVEN_PASS, T2: PROVEN_FAIL }, "T3");
      expect(applyDerivedTiers(roster, { c }).find((m) => m.id === "c")?.tier).toBe("T3");
    });

    it("keeps today's promotion for a model with no adverse verdict", () => {
      const a = scored("a", { T3: PROVEN_PASS }, "T1");
      expect(applyDerivedTiers(roster, { a }).find((m) => m.id === "a")?.tier).toBe("T1");
    });

    it("refuses a promotion when the score carries no tier verdicts at all", () => {
      const a = { ...score("a", "T1"), tiers: {} as ModelScore["tiers"] };
      expect(applyDerivedTiers(roster, { a }).find((m) => m.id === "a")?.tier).toBe("T3");
    });
  });
});

describe("frozen benchmark-prior-v1 capture", () => {
  it("carries no fabricated DeepSWE values", () => {
    // DeepSWE v1.1 published no overlapping rows at capture time. If a future
    // capture adds them this assertion should be updated deliberately, with a
    // spec-version bump — not quietly relaxed.
    const withDeepSwe = Object.values(FROZEN_BENCHMARK_ROWS).filter(
      (row) => typeof row.deepSweV11Pass1 === "number",
    );
    expect(withDeepSwe).toHaveLength(0);
  });

  it("only the fully-joined rows clear the coverage gate", () => {
    const cleared = Object.values(FROZEN_BENCHMARK_ROWS).filter((row) => benchmarkPrior(row) !== null);
    // 11 of 35 — the rest fail closed to index-only, by design.
    expect(cleared).toHaveLength(11);
    expect(Object.keys(FROZEN_BENCHMARK_ROWS)).toHaveLength(35);
  });
});
