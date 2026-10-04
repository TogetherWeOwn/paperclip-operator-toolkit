import { describe, expect, it } from "vitest";

import { applyPickOrdering } from "../src/engine/pick-order.js";
import { selectModel } from "../src/engine/select.js";
import type { LaneLedger } from "../src/engine/pacing.js";
import type { Candidate, ModelEntry, ModelScore } from "../src/engine/types.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };

function model(baseModel: ModelEntry, overrides: Partial<ModelEntry>): ModelEntry {
  return { ...baseModel, ...overrides };
}

function tierScore(overrides: Partial<ModelScore["tiers"]["T1"]> = {}): ModelScore["tiers"]["T1"] {
  return {
    n: 0,
    ok: 0,
    failInfra: 0,
    failModel: 0,
    tmo: 0,
    nEff: 0,
    pObs: null,
    p: 0.8,
    capable: null,
    proven: false,
    costPerSuccessUsd: null,
    medMin: null,
    rework: 0,
    ...overrides,
  };
}

function score(modelId: string, tiers: Partial<Record<"T1" | "T2" | "T3", Partial<ModelScore["tiers"]["T1"]>>>): ModelScore {
  return {
    modelId,
    aaIndex: null,
    priorP: 0.8,
    tiers: {
      T1: tierScore(tiers.T1),
      T2: tierScore(tiers.T2),
      T3: tierScore(tiers.T3),
    },
    overall: tierScore(),
  };
}

function candidate(modelId: string, expectedCostUsd: number): Candidate {
  return {
    modelId,
    tier: "T2",
    releasedAt: "2026-01-01",
    fallbackOnly: false,
    runCostUsd: expectedCostUsd,
    inputCostUsd: expectedCostUsd,
    cacheReadCostUsd: 0,
    outputCostUsd: 0,
    escalationRiskUsd: 0,
    expectedCostUsd,
    profileTier: "T2",
    profileTrusted: true,
  };
}

function laneLedgerWith(laneId: string, utilization: number): LaneLedger {
  const verdict: LanePaceVerdict = {
    laneId,
    observedAt: "2026-09-10T12:00:00.000Z",
    state: "on",
    serviceable: true,
    score: { utilization, elapsed: 0.5, deviation: 0 },
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 1,
    urgentResetAt: null,
    reason: "ok",
  };
  return { [laneId]: { laneId, fetchedAt: "t", error: null, observation: null, verdict } };
}

describe("applyPickOrdering (tier_dispatcher.py pick())", () => {
  it("is a no-op when every candidate is proven and priced above the free-must-be-proven floor", () => {
    const models: ModelEntry[] = [
      model(MODELS[0]!, { id: "a", laneId: "lane-a" }),
      model(MODELS[0]!, { id: "b", laneId: "lane-b" }),
    ];
    const candidates = [candidate("a", 1), candidate("b", 1.05)];
    const scores = {
      a: score("a", { T2: { proven: true, capable: true } }),
      b: score("b", { T2: { proven: true, capable: true } }),
    };
    const result = applyPickOrdering(candidates, models, {}, scores, "T2", "issue-1");
    expect(result.explored).toBe(false);
    expect(result.ordered.map((c) => c.modelId)).toEqual(["a", "b"]);
  });

  it("2026-09-06 16:2xZ owner rule: an unproven free/stealth candidate is pushed out of the main pool until proven", () => {
    const models: ModelEntry[] = [
      model(MODELS[0]!, { id: "free-unproven", laneId: "lane-a", costPerMTokIn: 0, costPerMTokOut: 0, costPerMTokCacheRead: 0 }),
      model(MODELS[0]!, { id: "paid-proven", laneId: "lane-b", costPerMTokIn: 1, costPerMTokOut: 1, costPerMTokCacheRead: 1 }),
    ];
    const candidates = [candidate("free-unproven", 0.5), candidate("paid-proven", 2)];
    const scores = {
      "free-unproven": score("free-unproven", { T2: { proven: false, capable: true } }),
      "paid-proven": score("paid-proven", { T2: { proven: true, capable: true } }),
    };
    // Force explore roll off so the free-must-be-proven / cost-band ordering is what's under test.
    const result = applyPickOrdering(candidates, models, {}, scores, "T1", "issue-force-no-explore");
    expect(result.ordered[0]!.modelId).toBe("paid-proven");
  });

  it("falls back to every candidate when the free-must-be-proven filter would empty the pool", () => {
    const models: ModelEntry[] = [
      model(MODELS[0]!, { id: "only-free-unproven", laneId: "lane-a", costPerMTokIn: 0, costPerMTokOut: 0, costPerMTokCacheRead: 0 }),
    ];
    const candidates = [candidate("only-free-unproven", 0.1)];
    const scores = {
      "only-free-unproven": score("only-free-unproven", { T1: { proven: false, capable: true } }),
    };
    const result = applyPickOrdering(candidates, models, {}, scores, "T1", "issue-2");
    expect(result.ordered.map((c) => c.modelId)).toEqual(["only-free-unproven"]);
  });

  it("2026-09-05 spread rule: within a 20% cost band, prefers the least-utilized lane over the raw cost order", () => {
    const models: ModelEntry[] = [
      model(MODELS[0]!, { id: "cheapest-busy", laneId: "lane-busy" }),
      model(MODELS[0]!, { id: "slightly-pricier-idle", laneId: "lane-idle" }),
    ];
    // slightly-pricier-idle is 15% more expensive than cheapest-busy, still inside the 20% band.
    const candidates = [candidate("cheapest-busy", 1.0), candidate("slightly-pricier-idle", 1.15)];
    const scores = {
      "cheapest-busy": score("cheapest-busy", { T2: { proven: true, capable: true } }),
      "slightly-pricier-idle": score("slightly-pricier-idle", { T2: { proven: true, capable: true } }),
    };
    const ledger: LaneLedger = { ...laneLedgerWith("lane-busy", 0.9), ...laneLedgerWith("lane-idle", 0.1) };
    const result = applyPickOrdering(candidates, models, ledger, scores, "T2", "issue-3");
    expect(result.ordered[0]!.modelId).toBe("slightly-pricier-idle");
  });

  it("does not apply the least-utilized-lane tiebreak once a candidate is outside the 20% cost band", () => {
    const models: ModelEntry[] = [
      model(MODELS[0]!, { id: "cheapest-busy", laneId: "lane-busy" }),
      model(MODELS[0]!, { id: "much-pricier-idle", laneId: "lane-idle" }),
    ];
    // much-pricier-idle is 50% more expensive — outside the 20% band.
    const candidates = [candidate("cheapest-busy", 1.0), candidate("much-pricier-idle", 1.5)];
    const scores = {
      "cheapest-busy": score("cheapest-busy", { T2: { proven: true, capable: true } }),
      "much-pricier-idle": score("much-pricier-idle", { T2: { proven: true, capable: true } }),
    };
    const ledger: LaneLedger = { ...laneLedgerWith("lane-busy", 0.9), ...laneLedgerWith("lane-idle", 0.1) };
    const result = applyPickOrdering(candidates, models, ledger, scores, "T2", "issue-4");
    expect(result.ordered[0]!.modelId).toBe("cheapest-busy");
  });

  it("2026-09-06 14:2xZ owner rule: never fires the explore roll for T1 — an unproven candidate never earns judgement work", () => {
    const models: ModelEntry[] = [model(MODELS[2]!, { id: "unproven-t1", laneId: "lane-a" })];
    const candidates = [candidate("unproven-t1", 1)];
    const scores = { "unproven-t1": score("unproven-t1", { T1: { proven: false, capable: true } }) };
    for (const issueId of ["seed-1", "seed-2", "seed-3", "seed-4", "seed-5"]) {
      const result = applyPickOrdering(candidates, models, {}, scores, "T1", issueId);
      expect(result.explored).toBe(false);
    }
  });

  it("2026-09-06 14:2xZ owner rule: the explore roll actually FIRES for T2 and picks the cheapest unproven candidate — deterministic, not compared against pick_reference.py (its explore branch is permanently `and False` in that harness; see pick_reference.py:205)", () => {
    // Named mutant: "explore never fires". `explore-t2-200` is a fixed
    // issueId chosen (by brute-force search over `hashUnitInterval`, the
    // same deterministic hash applyPickOrdering itself uses) so that
    // `hashUnitInterval("explore:T2:explore-t2-200") ≈ 0.0945 < EXPLORE_FRACTION
    // (0.1)`. If the `< EXPLORE_FRACTION` roll were deleted, inverted, or the
    // T1 guard accidentally widened to also block T2, `explored` would read
    // `false` here and this test goes red — the pool would fall through to
    // the free-must-be-proven / cost-band path and pick "cheap-proven"
    // instead of the unproven "cheap-unproven" candidate this test expects.
    const models: ModelEntry[] = [
      model(MODELS[0]!, { id: "cheap-unproven", laneId: "lane-a" }),
      model(MODELS[0]!, { id: "pricier-proven", laneId: "lane-b" }),
    ];
    const candidates = [candidate("cheap-unproven", 1), candidate("pricier-proven", 3)];
    const scores = {
      "cheap-unproven": score("cheap-unproven", { T2: { proven: false, capable: true } }),
      "pricier-proven": score("pricier-proven", { T2: { proven: true, capable: true } }),
    };
    const result = applyPickOrdering(candidates, models, {}, scores, "T2", "explore-t2-200");
    expect(result.explored).toBe(true);
    expect(result.exploreModelId).toBe("cheap-unproven");
    expect(result.ordered[0]!.modelId).toBe("cheap-unproven");
  });

  it("gives the same explore/no-explore answer across repeated calls for the same issue+tier (advise then apply)", () => {
    const models: ModelEntry[] = [
      model(MODELS[0]!, { id: "cand-a", laneId: "lane-a" }),
      model(MODELS[0]!, { id: "cand-b", laneId: "lane-b" }),
    ];
    const candidates = [candidate("cand-a", 1), candidate("cand-b", 3)];
    const scores = {
      "cand-a": score("cand-a", { T2: { proven: false, capable: true } }),
      "cand-b": score("cand-b", { T2: { proven: false, capable: true } }),
    };
    const first = applyPickOrdering(candidates, models, {}, scores, "T2", "repeat-issue");
    const second = applyPickOrdering(candidates, models, {}, scores, "T2", "repeat-issue");
    expect(second.explored).toBe(first.explored);
    expect(second.exploreModelId).toBe(first.exploreModelId);
    expect(second.ordered.map((c) => c.modelId)).toEqual(first.ordered.map((c) => c.modelId));
  });

  it("returns an empty ordering for an empty candidate list", () => {
    const result = applyPickOrdering([], [], {}, {}, "T2", "issue-empty");
    expect(result).toEqual({ ordered: [], explored: false, exploreModelId: null });
  });
});

describe("capability-score gate (tier_dispatcher.py model_scores.py capable())", () => {
  it("excludes a model whose measured tier success rate is capable: false, even though it clears the static tier-floor", () => {
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const weakT1 = model(t1, { id: "weak-t1" });
    const strongT1 = model(t1, { id: "strong-t1" });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "cap-score-1", labelNames: ["tier:T1"] },
      config: config({
        models: [weakT1, strongT1],
        modelScores: {
          "weak-t1": score("weak-t1", { T1: { capable: false, proven: true, p: 0.5 } }),
          "strong-t1": score("strong-t1", { T1: { capable: true, proven: true, p: 0.95 } }),
        },
      }),
    });
    expect(decision.modelId).toBe("strong-t1");
    expect(
      decision.rejections.some((r) => r.stage === "capability-score" && r.modelId === "weak-t1"),
    ).toBe(true);
  });

  it("fails open when a model has no recorded score at all", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "cap-score-2", labelNames: ["tier:T3"] },
      config: config({ modelScores: {} }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.rejections.some((r) => r.stage === "capability-score")).toBe(false);
  });

  it("fails open when config.modelScores is not supplied at all", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "cap-score-3", labelNames: ["tier:T3"] },
      config: config(),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.rejections.some((r) => r.stage === "capability-score")).toBe(false);
  });

  it("does not exclude on a null (not-enough-evidence) capable verdict", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "cap-score-4", labelNames: ["tier:T3"] },
      config: config({
        modelScores: {
          "claude-haiku-4-5-20251001": score("claude-haiku-4-5-20251001", { T3: { capable: null, proven: false } }),
        },
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-haiku-4-5-20251001");
  });

  // The glm-5.3 shape. Its T3 runs pass, its T2 runs measure a
  // failing p=0.585, and it has no T1 runs, so the T1 verdict is the prior
  // alone (capable: true). A model that fails T2 must not be fit for T1.
  describe("monotone across tiers", () => {
    const glmShaped = (modelId: string) =>
      score(modelId, {
        T3: { n: 89, ok: 89, capable: true, proven: true, p: 0.97 },
        T2: { n: 44, ok: 22, failModel: 18, capable: false, proven: true, p: 0.585 },
        T1: { capable: true, proven: false, p: 0.877 },
      });

    it("excludes it at T1, naming the easier tier it fails", () => {
      const t1 = MODELS.find((entry) => entry.tier === "T1")!;
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "cap-score-mono-1", labelNames: ["tier:T1"] },
        config: config({
          models: [model(t1, { id: "glm-shaped" }), model(t1, { id: "strong-t1" })],
          modelScores: {
            "glm-shaped": glmShaped("glm-shaped"),
            "strong-t1": score("strong-t1", { T1: { capable: true, proven: true, p: 0.95 } }),
          },
        }),
      });
      expect(decision.modelId).toBe("strong-t1");
      const rejection = decision.rejections.find((r) => r.modelId === "glm-shaped");
      expect(rejection?.stage).toBe("capability-score");
      expect(rejection?.operand).toEqual({ kind: "capability-score", tier: "T1", p: 0.877, cappedBy: "T2" });
      expect(rejection?.reason).toContain("fails the easier T2 tier (p=0.585)");
    });

    it("excludes it at T2 on its own measured verdict", () => {
      const t2 = MODELS.find((entry) => entry.tier === "T2")!;
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "cap-score-mono-2", labelNames: ["tier:T2"] },
        config: config({
          models: [model(t2, { id: "glm-shaped" }), model(t2, { id: "strong-t2" })],
          modelScores: { "glm-shaped": glmShaped("glm-shaped") },
        }),
      });
      expect(decision.modelId).toBe("strong-t2");
      const rejection = decision.rejections.find((r) => r.modelId === "glm-shaped");
      expect(rejection?.stage).toBe("capability-score");
      expect(rejection?.operand).toEqual({ kind: "capability-score", tier: "T2", p: 0.585 });
      expect(rejection?.reason).toContain("measured T2 success rate (p=0.585)");
    });

    it("keeps a model with an empty T2 and a passing prior eligible at T1", () => {
      const t1 = MODELS.find((entry) => entry.tier === "T1")!;
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "cap-score-mono-3", labelNames: ["tier:T1"] },
        config: config({
          models: [model(t1, { id: "prior-only" })],
          modelScores: {
            "prior-only": score("prior-only", {
              T3: { n: 89, ok: 89, capable: true, proven: true, p: 0.97 },
              T2: { capable: true, proven: false, p: 0.9 },
              T1: { capable: true, proven: false, p: 0.877 },
            }),
          },
        }),
      });
      expect(decision.modelId).toBe("prior-only");
      expect(decision.rejections.some((r) => r.stage === "capability-score")).toBe(false);
    });

    it("lets a model's own proven T1 evidence override a failing T2", () => {
      const t1 = MODELS.find((entry) => entry.tier === "T1")!;
      const glm = glmShaped("proven-t1");
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "cap-score-mono-4", labelNames: ["tier:T1"] },
        config: config({
          models: [model(t1, { id: "proven-t1" })],
          modelScores: {
            "proven-t1": { ...glm, tiers: { ...glm.tiers, T1: tierScore({ n: 23, ok: 20, capable: true, proven: true, p: 0.885 }) } },
          },
        }),
      });
      expect(decision.modelId).toBe("proven-t1");
      expect(decision.rejections.some((r) => r.stage === "capability-score")).toBe(false);
    });
  });
});
