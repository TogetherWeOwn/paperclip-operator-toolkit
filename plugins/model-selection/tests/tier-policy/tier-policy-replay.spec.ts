/**
 * TOG-11543 P1 zero-diff replay: the data-driven `legacy-model-selection-v1`
 * evaluator against a frozen, hashed copy of the SERVING evaluator
 * (`serving-evaluator-t1cap080.js`, main 5a9be61 + the operator's T1 capability
 * 0.8 carry-forward).
 *
 * Every production caller uses the default arguments (worker.ts:3236,
 * diff.ts:82-83, worker.ts:2168-2169), so the default-argument paths are what
 * must not move. The grid crosses every cut and bar (0.75/0.8/0.85, T1 at 0.8),
 * missing and non-finite indices, absent/sparse/full benchmark rows, and
 * absent/sparse/mature/vetoed stats. A positive control proves the grid would
 * see the old source's T1 0.85 bar, so a zero here is a finding, not a void.
 *
 * Recorded-decision parity is NOT claimed: the tog2138 decision stream records
 * each candidate's verdict but not the stats and priors that produced it.
 *
 * TOG-12768 is the one deliberate departure from the frozen evaluator:
 * capability is now monotone in tier order. The grid compares against the
 * serving output with `enforceMonotoneCapability` applied, and a positive
 * control proves the raw serving output differs ONLY in the verdicts that rule
 * caps.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { projectDecisionInput } from "../../src/aa-free/project.js";
import { tierImpliedByIndex } from "../../src/aa-index/match.js";
import { SCORE_PROVEN_N, TIER_ORDER, type Tier } from "../../src/constants.js";
import type { BenchmarkRow } from "../../src/engine/benchmark-prior.js";
import {
  blendedPriorP,
  buildModelScore,
  deriveModelTier,
  emptyTierScoreStats,
  enforceMonotoneCapability,
  priorP,
  summarize,
  tierForPosterior,
} from "../../src/engine/scores.js";
import { selectModel } from "../../src/engine/select.js";
import {
  CAPABILITY_PRIOR_BINDING,
  LEGACY_MODEL_SELECTION_V1,
  LEGACY_TIER_POLICY,
  compileTierPolicy,
  type TierDefinition,
  type TierPolicy,
} from "../../src/engine/tier-policy.js";
import type { ModelScore, TierScoreStats } from "../../src/engine/types.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "../fixtures.js";
import * as serving from "./serving-evaluator-t1cap080.js";

const FIXTURE_PATH = fileURLToPath(new URL("./serving-evaluator-t1cap080.js", import.meta.url));
const SERVING_WORKER = "/paperclip/plugin-packages-root/model-selection-0.4.0-main5a9be61-t1cap080/dist/worker.js";
const SERVING_WORKER_SHA256 = "dde5fe180cc86856d2332a6ee56ff3ea62fedd349c91c1550de8bd8773b3c099";
const SLICES_SHA256 = "34776313af7253982428382cc0d6ed8caefaf9800804f87920799b550eea2e65";
const SLICE_RANGES: ReadonlyArray<readonly [number, number]> = [[93, 93], [281, 285], [1464, 1508], [1580, 1701], [1896, 1902]];

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

function fixtureSlices(): string {
  const lines = readFileSync(FIXTURE_PATH, "utf8").split("\n");
  const begin = lines.indexOf("// BEGIN SERVING SLICES");
  const end = lines.indexOf("// END SERVING SLICES");
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return `${lines.slice(begin + 1, end).join("\n")}\n`;
}

describe("frozen serving evaluator", () => {
  it("is byte-identical to the captured slices", () => {
    expect(sha256(fixtureSlices())).toBe(SLICES_SHA256);
  });

  // The artifact only exists on the serving host; CI has no copy.
  it.skipIf(!existsSync(SERVING_WORKER))("re-extracts byte-for-byte from the serving worker.js", () => {
    const worker = readFileSync(SERVING_WORKER);
    expect(sha256(worker)).toBe(SERVING_WORKER_SHA256);
    const lines = worker.toString("utf8").split("\n");
    const slices = `${SLICE_RANGES.flatMap(([from, to]) => lines.slice(from - 1, to)).join("\n")}\n`;
    expect(slices).toBe(fixtureSlices());
  });

  it("records the serving build the policy is pinned to", () => {
    expect(LEGACY_MODEL_SELECTION_V1.legacyCompatibility.servingWorkerSha256).toBe(SERVING_WORKER_SHA256);
    expect(serving.T1_CAPABILITY_THRESHOLD).toBe(0.8);
    expect(serving.SCORE_THRESHOLDS).toEqual({ T1: 0.85, T2: 0.8, T3: 0.75 });
  });
});

// --- grid -------------------------------------------------------------------

/** Index at which `priorP` lands exactly on `p` (inverse of the 0.55 + 0.45·i/60 curve). */
const indexFor = (p: number) => ((p - 0.55) * 60) / 0.45;
const NEAR = [-1e-9, 0, 1e-9];
const BOUNDARY_INDICES = [0.75, 0.8, 0.85].flatMap((p) => NEAR.map((d) => indexFor(p) + d));

const INDICES: ReadonlyArray<number | null> = [
  null,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -10,
  ...Array.from({ length: 141 }, (_, i) => i / 2), // 0 .. 70 step 0.5
  ...BOUNDARY_INDICES,
];

const BENCHMARK_ROWS: ReadonlyArray<BenchmarkRow | null | undefined> = [
  undefined,
  null,
  {},
  // Sparse: below the 3-benchmark coverage gate, so index-only.
  { terminalBenchV4Pass1: 0.5, deepSweV11Pass1: 0.6 },
  // Three light benchmarks: count passes, weight (0.6) fails the 0.75 gate.
  { mercorApex11Pass1: 0.6, automationBenchAaGuardrailAdjusted: 0.6, deepSweV11Pass1: 0.6 },
  { terminalBenchV4Pass1: 0.55, mercorApex11Pass1: 0.65, automationBenchAaGuardrailAdjusted: 0.6, aaOmniscienceSignedIndex: 30, deepSweV11Pass1: 0.7 },
  { terminalBenchV4Pass1: 0.1, mercorApex11Pass1: 0.1, automationBenchAaGuardrailAdjusted: 0.1, aaOmniscienceSignedIndex: -20, deepSweV11Pass1: 0.05 },
  { terminalBenchV4Pass1: Number.NaN, mercorApex11Pass1: 0.7, automationBenchAaGuardrailAdjusted: null, aaOmniscienceSignedIndex: 45, deepSweV11Pass1: 0.75 },
];

function stats(partial: Partial<TierScoreStats>): TierScoreStats {
  return { ...emptyTierScoreStats(), ...partial };
}

const STATS: Readonly<Record<string, TierScoreStats>> = {
  empty: emptyTierScoreStats(),
  sparse: stats({ n: 2, ok: 2, wOk: 1.6, okCost: [0.12], okMins: [4] }),
  mature: stats({ n: 30, ok: 26, failInfra: 2, failModel: 2, wOk: 18.5, wBad: 1.4, okCost: [0.1, 0.3, 0.2], okMins: [3, 9] }),
  // Proven (ok+failModel+tmo >= 8) with pObs far under every bar: the veto path.
  vetoed: stats({ n: 20, ok: 2, failModel: 18, wOk: 2, wBad: 18, rework: 3 }),
  // Proven with pObs just under T1/T2 minus the margin, above T3 minus it.
  marginal: stats({ n: 10, ok: 7, failModel: 2, tmo: 1, wOk: 6.9, wBad: 3.1, rework: 1 }),
  timeouts: stats({ n: 9, ok: 0, tmo: 9, wBad: 9 }),
};

const STATS_BY_TIER: ReadonlyArray<Partial<Record<Tier, TierScoreStats>>> = [
  {},
  { T1: STATS.mature },
  { T1: STATS.vetoed, T3: STATS.sparse },
  { T2: STATS.marginal, T3: STATS.mature },
  { T1: STATS.marginal, T2: STATS.timeouts, T3: STATS.vetoed },
  { T1: STATS.sparse, T2: STATS.sparse, T3: STATS.sparse },
];

const TIER_SETS: ReadonlyArray<readonly Tier[]> = [TIER_ORDER, ["T1"], []];

/** Priors placed exactly on, and one ulp-ish either side of, every cut and bar. */
const PRIORS = [Number.NaN, 0.5, 0.55, 0.7, ...[0.75, 0.8, 0.85].flatMap((p) => NEAR.map((d) => p + d)), 0.9, 1];

interface Diff {
  fn: string;
  input: unknown;
  serving: unknown;
  next: unknown;
}

function compare(diffs: Diff[], fn: string, input: unknown, servingOut: unknown, nextOut: unknown): void {
  // SameValue semantics: NaN equals NaN, -0 differs from +0.
  if (!isDeepStrictEqual(servingOut, nextOut)) diffs.push({ fn, input, serving: servingOut, next: nextOut });
}

type BuildFn = (
  modelId: string,
  aaIndex: number | null,
  statsByTier: Partial<Record<Tier, TierScoreStats>>,
  tiers: readonly Tier[],
  benchmarkRow?: BenchmarkRow | null,
) => ModelScore;

/** The frozen serving evaluator held to the TOG-12768 monotone-capability rule. */
const servingMonotone: BuildFn = (id, idx, by, tiers, row) => {
  const score = serving.buildModelScore(id, idx, by, tiers, row) as ModelScore;
  return { ...score, tiers: enforceMonotoneCapability(score.tiers) };
};

function replayBuildModelScore(
  next: BuildFn,
  reference: BuildFn = servingMonotone,
): { diffs: Diff[]; cases: number; scores: ModelScore[] } {
  const diffs: Diff[] = [];
  const scores: ModelScore[] = [];
  let cases = 0;
  for (const aaIndex of INDICES) {
    for (const row of BENCHMARK_ROWS) {
      for (const byTier of STATS_BY_TIER) {
        for (const tiers of TIER_SETS) {
          const s = reference("m", aaIndex, byTier, tiers, row);
          const n = next("m", aaIndex, byTier, tiers, row);
          compare(diffs, "buildModelScore", { aaIndex, row, byTier: Object.keys(byTier), tiers }, s, n);
          scores.push(n);
          cases += 1;
        }
      }
    }
  }
  return { diffs, cases, scores };
}

describe("zero-diff replay: legacy-model-selection-v1 vs serving t1cap080", () => {
  it("buildModelScore: every grid cell identical, and the grid crosses the T1 cut/bar split", () => {
    const { diffs, cases, scores } = replayBuildModelScore(buildModelScore);
    expect(diffs.slice(0, 3)).toEqual([]);
    expect(cases).toBe(INDICES.length * BENCHMARK_ROWS.length * STATS_BY_TIER.length * TIER_SETS.length);

    // Anti-vacuity: the grid must exercise both verdicts at every tier and the
    // cell the t1cap080 patch exists for (capable at T1, derived tier below T1).
    for (const tier of TIER_ORDER) {
      const verdicts = new Set(scores.map((s) => s.tiers[tier]?.capable).filter((v) => v !== undefined));
      expect(verdicts).toEqual(new Set([true, false]));
    }
    expect(scores.some((s) => s.tiers.T1?.capable === true && s.derivedTier === "T2")).toBe(true);
    expect(scores.some((s) => s.tiers.T1?.capable === false && s.tiers.T1.proven)).toBe(true);
    expect(scores.some((s) => s.derivedTier === null)).toBe(true);
    expect(scores.some((s) => s.belowT3Floor)).toBe(true);
    expect(new Set(scores.map((s) => s.priorBasis))).toEqual(new Set(["blended", "index-only", "unscored"]));
  });

  it("TOG-12768 positive control: the raw serving output differs only in the verdicts the monotone rule caps", () => {
    const { diffs } = replayBuildModelScore(buildModelScore, serving.buildModelScore as BuildFn);
    expect(diffs.length).toBeGreaterThan(0);
    let capped = 0;
    for (const d of diffs) {
      const s = d.serving as ModelScore;
      const n = d.next as ModelScore;
      const uncapped = { ...n.tiers };
      for (const tier of TIER_ORDER) {
        const t = n.tiers[tier];
        if (t?.cappedBy === undefined) continue;
        // A capped tier: unproven, an own-false easier tier, and it would have passed.
        expect(t.proven).toBe(false);
        expect(t.capable).toBe(false);
        expect(n.tiers[t.cappedBy]?.capable).toBe(false);
        expect(n.tiers[t.cappedBy]?.cappedBy).toBeUndefined();
        expect(TIER_ORDER.indexOf(t.cappedBy)).toBeLessThan(TIER_ORDER.indexOf(tier));
        expect(s.tiers[tier]?.capable).not.toBe(false);
        const { cappedBy: _cappedBy, ...rest } = t;
        uncapped[tier] = { ...rest, capable: s.tiers[tier]!.capable };
        capped += 1;
      }
      expect({ ...n, tiers: uncapped }).toEqual(s);
    }
    expect(capped).toBeGreaterThan(0);
  });

  it("positive control: the old source T1 bar (0.85) is visible to the same grid", () => {
    const t1At085: TierPolicy = {
      ...LEGACY_MODEL_SELECTION_V1,
      revision: 2,
      tiers: LEGACY_MODEL_SELECTION_V1.tiers.map((t): TierDefinition =>
        t.id === "T1" ? { ...t, legacy: { ...t.legacy, capabilityThreshold: 0.85 } } : t,
      ),
    };
    const old = compileTierPolicy(t1At085);
    const { diffs } = replayBuildModelScore((id, idx, by, tiers, row) => buildModelScore(id, idx, by, tiers, row, old));
    expect(diffs.length).toBeGreaterThan(0);
    // Only the T1 capability verdict may move; the cut, the prior and p never do.
    // TOG-12768: a T1 already capped by an easier tier stays false under the
    // 0.85 bar, and only its provenance moves — capped becomes its own verdict.
    let flipped = 0;
    for (const d of diffs) {
      const s = d.serving as ModelScore;
      const n = d.next as ModelScore;
      const { cappedBy: _cappedBy, ...nT1 } = n.tiers.T1;
      const sT1 = s.tiers.T1;
      const t1 = sT1.cappedBy === undefined ? { ...nT1, capable: sT1.capable } : { ...nT1, capable: sT1.capable, cappedBy: sT1.cappedBy };
      expect({ ...n, tiers: { ...n.tiers, T1: t1 } }).toEqual(s);
      expect(n.tiers.T1?.capable).toBe(false);
      expect(n.tiers.T1?.cappedBy).toBeUndefined();
      if (s.tiers.T1?.capable === true) flipped += 1;
      else expect(s.tiers.T1?.cappedBy).toBeDefined();
    }
    expect(flipped).toBeGreaterThan(0);
  });

  it("summarize with production defaults: every stats × tier × prior identical", () => {
    const diffs: Diff[] = [];
    let cases = 0;
    for (const [name, s] of Object.entries(STATS)) {
      for (const tier of [...TIER_ORDER, null] as const) {
        for (const pp of PRIORS) {
          compare(diffs, "summarize", { name, tier, pp }, serving.summarize(s, tier, pp), summarize(s, tier, pp));
          // priorK/provenN passed explicitly, thresholds left to the default.
          compare(diffs, "summarize/k", { name, tier, pp }, serving.summarize(s, tier, pp, 6, SCORE_PROVEN_N), summarize(s, tier, pp, 6, SCORE_PROVEN_N));
          cases += 2;
        }
      }
    }
    expect(diffs.slice(0, 3)).toEqual([]);
    expect(cases).toBe(Object.keys(STATS).length * 4 * PRIORS.length * 2);
    // Exact-boundary spot checks with empty stats (p == prior): bars are >=.
    const empty = emptyTierScoreStats();
    expect(summarize(empty, "T1", 0.8).capable).toBe(true);
    expect(summarize(empty, "T1", 0.8 - 1e-9).capable).toBe(false);
    expect(summarize(empty, "T2", 0.8).capable).toBe(true);
    expect(summarize(empty, "T3", 0.75).capable).toBe(true);
    expect(summarize(empty, "T3", 0.75 - 1e-9).capable).toBe(false);
    expect(summarize(empty, null, 0.99).capable).toBeNull();
    expect(summarize(empty, "T1", Number.NaN).capable).toBe(false);
  });

  it("tier cuts: tierForPosterior, deriveModelTier, tierImpliedByIndex and the priors are unchanged", () => {
    const diffs: Diff[] = [];
    for (const p of [...PRIORS, -1, 0, 0.6, Number.POSITIVE_INFINITY]) {
      compare(diffs, "tierForPosterior", p, serving.tierForPosterior(p), tierForPosterior(p));
    }
    for (const aaIndex of INDICES) {
      compare(diffs, "priorP", aaIndex, serving.priorP(aaIndex), priorP(aaIndex));
      if (aaIndex !== null) compare(diffs, "tierImpliedByIndex", aaIndex, serving.tierImpliedByIndex(aaIndex), tierImpliedByIndex(aaIndex));
      for (const row of BENCHMARK_ROWS) {
        compare(diffs, "blendedPriorP", { aaIndex, row }, serving.blendedPriorP(aaIndex, row), blendedPriorP(aaIndex, row));
        for (const s of Object.values(STATS)) {
          compare(diffs, "deriveModelTier", { aaIndex, row }, serving.deriveModelTier(aaIndex, row, s), deriveModelTier(aaIndex, row, s));
        }
      }
    }
    expect(diffs.slice(0, 3)).toEqual([]);
    // The cut stays 0.85 at T1 even though the bar is 0.8.
    expect(tierForPosterior(0.84).tier).toBe("T2");
    expect(tierForPosterior(0.85).tier).toBe("T1");
    expect(tierImpliedByIndex(indexFor(0.85) - 1e-9)).toBe("T2");
    expect(LEGACY_TIER_POLICY.scoreThresholds).toEqual({ T1: 0.85, T2: 0.8, T3: 0.75 });
    expect(LEGACY_TIER_POLICY.capabilityThresholds).toEqual({ T1: 0.8, T2: 0.8, T3: 0.75 });
  });
});

describe("zero-diff replay through selectModel (sticky and gated paths)", () => {
  // Scores for the three fixture models, from each evaluator, over the stats
  // shapes that move `capable`. Selection consumes only `capable`/`p`, so equal
  // scores must give equal decisions; this checks it end to end.
  function scoresFrom(build: BuildFn, byTier: Partial<Record<Tier, TierScoreStats>>, aaShift: number) {
    return Object.fromEntries(
      MODELS.map((m) => [m.id, build(m.id, m.aaIndex === null ? null : m.aaIndex + aaShift, byTier, TIER_ORDER, null)]),
    );
  }

  it("identical decisions for every tier label, sticky incumbent and score shape", () => {
    let sticky = 0;
    let gated = 0;
    const diffs: Diff[] = [];
    for (const byTier of STATS_BY_TIER) {
      for (const aaShift of [-20, -10, 0, 10]) {
        const servingScores = scoresFrom(serving.buildModelScore, byTier, aaShift);
        const nextScores = scoresFrom(buildModelScore, byTier, aaShift);
        for (const tier of TIER_ORDER) {
          for (const stickyModelId of [undefined, ...MODELS.map((m) => m.id)]) {
            const input = {
              profiles: PROFILES,
              signals: NO_ESCALATION,
              now: NOW,
              descriptor: { issueId: "i1", labelNames: [`tier:${tier}`], stickyModelId },
            };
            const s = selectModel({ ...input, config: config({ modelScores: servingScores }) });
            const n = selectModel({ ...input, config: config({ modelScores: nextScores }) });
            compare(diffs, "selectModel", { tier, stickyModelId, aaShift, byTier: Object.keys(byTier) }, s, n);
            if (n.trace.some((line) => line.startsWith("sticky: "))) sticky += 1;
            if (n.rejections.some((r) => r.stage === "capability-score")) gated += 1;
          }
        }
      }
    }
    expect(diffs.slice(0, 3)).toEqual([]);
    // Both the sticky early return and the capability-score gate were reached.
    expect(sticky).toBeGreaterThan(0);
    expect(gated).toBeGreaterThan(0);
  });
});

describe("Pro-neutrality: optional rich data has zero decision weight", () => {
  it("absent, null, stale or conflicting optionalRich gives an identical ModelScore", () => {
    const base = { aaIndex: 41 as number | null };
    const variants = [
      { ...base },
      { ...base, optionalRich: null },
      { ...base, optionalRich: {} },
      { ...base, optionalRich: { aaIndex: 99, intelligenceIndex: 99, retrievedAt: "2020-01-01T00:00:00Z" } },
      { ...base, optionalRich: { aaIndex: 1, cost_per_task: "bogus", nested: { x: Number.NaN } } },
    ];
    const decide = (row: { aaIndex: number | null }) =>
      buildModelScore("m", projectDecisionInput(row).aaIndex, { T1: STATS.marginal }, TIER_ORDER, null);
    const reference = decide(base);
    for (const v of variants) expect(decide(v)).toEqual(reference);
    expect(LEGACY_MODEL_SELECTION_V1.optionalRichDecisionWeight).toBe(0);
  });

  it("a rule naming a paid source compiles to the capability fallback and changes nothing", () => {
    const pro = withT1Rules([
      {
        kind: "capability-predicate",
        decisionBinding: CAPABILITY_PRIOR_BINDING,
        policyRevision: "legacy-model-selection-v1",
      },
      {
        kind: "numeric-metric",
        metric: "artificial_analysis_intelligence_index",
        source: "artificialanalysis.ai/api/v2/pro",
        version: "v4.0",
        operator: "gte",
        value: 60,
        unit: "index-points",
        decisionBinding: "aa-pro/intelligence-index-v4",
        optionalSourceRule: { source: "artificialanalysis.ai/api/v2/pro", metric: "artificial_analysis_intelligence_index", version: "v4.0" },
        onMissing: "legacy",
      },
    ]);
    const compiled = compileTierPolicy(pro);
    expect(compiled.rules.find((r) => r.tierId === "T1" && r.ruleIndex === 1)).toEqual({
      tierId: "T1",
      ruleIndex: 1,
      status: "not-enforced-in-aa-free-v1",
      replacement: CAPABILITY_PRIOR_BINDING,
    });
    expect(compiled.scoreThresholds).toEqual(LEGACY_TIER_POLICY.scoreThresholds);
    expect(compiled.capabilityThresholds).toEqual(LEGACY_TIER_POLICY.capabilityThresholds);
    const { diffs } = replayBuildModelScore((id, idx, by, tiers, row) => buildModelScore(id, idx, by, tiers, row, compiled));
    expect(diffs.slice(0, 3)).toEqual([]);
  });
});

describe("version-unknown: a free-list index rule is never a raw index cut", () => {
  it("compiles to the capability fallback, reports version-unknown, and replays with zero diffs", () => {
    const policy = withT1Rules([
      {
        kind: "capability-predicate",
        decisionBinding: CAPABILITY_PRIOR_BINDING,
        policyRevision: "legacy-model-selection-v1",
      },
      {
        kind: "numeric-metric",
        metric: "artificial_analysis_intelligence_index",
        source: "artificialanalysis.ai/api/v2/data/llms/models",
        version: "v4.0",
        operator: "gte",
        value: 85,
        unit: "index-points",
        decisionBinding: "aa-free-v1/intelligence-index",
        onMissing: "legacy",
      },
    ]);
    const compiled = compileTierPolicy(policy);
    expect(compiled.rules.filter((r) => r.tierId === "T1")).toEqual([
      { tierId: "T1", ruleIndex: 0, status: "enforced", replacement: null },
      { tierId: "T1", ruleIndex: 1, status: "not-enforced-version-unknown", replacement: CAPABILITY_PRIOR_BINDING },
    ]);
    expect(compiled.scoreThresholds).toEqual(LEGACY_TIER_POLICY.scoreThresholds);
    expect(compiled.capabilityThresholds).toEqual(LEGACY_TIER_POLICY.capabilityThresholds);
    // Index 85 would exclude every fixture model if it were enforced as a cut.
    const { diffs } = replayBuildModelScore((id, idx, by, tiers, row) => buildModelScore(id, idx, by, tiers, row, compiled));
    expect(diffs.slice(0, 3)).toEqual([]);
  });

  it("the seed enforces only the capability predicate", () => {
    expect(LEGACY_TIER_POLICY.rules.map((r) => r.status)).toEqual(["enforced", "enforced", "enforced"]);
  });
});

function withT1Rules(rules: TierDefinition["entryRules"]["all"]): TierPolicy {
  return {
    ...LEGACY_MODEL_SELECTION_V1,
    revision: 2,
    tiers: LEGACY_MODEL_SELECTION_V1.tiers.map((t): TierDefinition => (t.id === "T1" ? { ...t, entryRules: { all: rules } } : t)),
  };
}
