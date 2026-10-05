import { describe, expect, it } from "vitest";

import { planApply } from "../src/actuate/apply.js";
import { BENCHMARK_SPEC_VERSION } from "../src/engine/benchmark-prior.js";
import { freeEarnInCandidates } from "../src/engine/free-lane-earn-in.js";
import { applyPickOrdering } from "../src/engine/pick-order.js";
import { applyDerivedTiers, tierForPosterior } from "../src/engine/scores.js";
import { selectModel } from "../src/engine/select.js";
import {
  admittedTierCeiling,
  resolveTier,
  routerMayWriteTierLabel,
  tierWithFallback,
} from "../src/engine/tier.js";
import type { LaneLedger } from "../src/engine/pacing.js";
import type { Candidate, ModelEntry, ModelScore } from "../src/engine/types.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";
import { FRESH, MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };

/**
 * A measured T0 volume profile. `buildVolumeProfiles` attributes runs to the
 * roster row's CURRENT tier, so once the three rows move to T0 their own
 * history builds this profile; the fixture roster has no such history.
 */
const T0_PROFILE = {
  tier: "T0" as const,
  sampleCount: 40,
  computedAt: FRESH,
  avgInputTokens: 510_327,
  avgCacheReadTokens: 6_081_872,
  avgOutputTokens: 55_532,
};
const withT0Profile = { ...base, profiles: [...PROFILES, T0_PROFILE] };

function model(baseModel: ModelEntry, overrides: Partial<ModelEntry>): ModelEntry {
  return { ...baseModel, ...overrides };
}

function unserviceableVerdict(laneId: string): LanePaceVerdict {
  return {
    laneId,
    observedAt: "2026-09-10T11:00:00.000Z",
    state: "exhausted",
    serviceable: false,
    score: null,
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 0,
    urgentResetAt: null,
    reason: "all-accounts-unserviceable",
  };
}

function ledgerWith(...laneIds: string[]): LaneLedger {
  const ledger: LaneLedger = {};
  for (const laneId of laneIds) {
    ledger[laneId] = { laneId, verdict: unserviceableVerdict(laneId), fetchedAt: NOW.toString(), error: null, observation: null };
  }
  return ledger;
}

/** A T0 row with the live migration shape: regular, lane-bound, capable. */
function t0Row(id = "t0-astra"): ModelEntry {
  const t1 = MODELS.find((entry) => entry.tier === "T1")!;
  return model(t1, { id, tier: "T0", laneId: "lane-t0", costPerMTokIn: 1, costPerMTokOut: 5 });
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

function scoreOf(modelId: string, overrides: Partial<ModelScore> = {}): ModelScore {
  return {
    modelId,
    aaIndex: null,
    priorP: 0.8,
    tiers: {
      T0: tierScore({ capable: true, proven: true }),
      T1: tierScore({ capable: true, proven: true }),
      T2: tierScore({ capable: true, proven: true }),
      T3: tierScore({ capable: true, proven: true }),
    },
    overall: tierScore(),
    ...overrides,
  };
}

/** A score carrying an admissible derivation, mirroring the benchmark-prior spec's basket shape. */
function derivedScore(modelId: string, derivedTier: ModelScore["derivedTier"]): ModelScore {
  return scoreOf(modelId, {
    derivedTier,
    priorBasis: "blended",
    tierSpecVersion: BENCHMARK_SPEC_VERSION,
  });
}

describe("T0 admission — resolveTier", () => {
  it("caps an ordinary card at T1: the ceiling is the implicit one", () => {
    const judgement = resolveTier({ issueId: "i1", labelNames: ["tier:T1"] }, MODELS, "T1");
    expect(judgement.tier).toBe("T1");
    expect(admittedTierCeiling(judgement)).toBe("T1");
  });

  it("admits T0 on an explicit tier:T0 label", () => {
    const judgement = resolveTier(
      { issueId: "i1", labelNames: ["tier:T0"] },
      [...MODELS, t0Row()],
      "T1",
    );
    expect(judgement.tier).toBe("T0");
    expect(judgement.source).toBe("issue-label");
    expect(admittedTierCeiling(judgement)).toBe("T0");
  });

  it("admits T0 on an explicit-provenance pin to a T0 row", () => {
    const t0 = t0Row();
    const judgement = resolveTier(
      { issueId: "i1", pinnedModelId: t0.id, pinProvenance: "explicit" },
      [...MODELS, t0],
      "T1",
    );
    expect(judgement.tier).toBe("T0");
    expect(judgement.source).toBe("issue-override");
    expect(admittedTierCeiling(judgement)).toBe("T0");
  });

  it("does NOT admit T0 on a pin of unknown provenance — clamps to T1 and says why", () => {
    const t0 = t0Row();
    const judgement = resolveTier({ issueId: "i1", pinnedModelId: t0.id }, [...MODELS, t0], "T1");
    expect(judgement.tier).toBe("T1");
    expect(admittedTierCeiling(judgement)).toBe("T1");
    expect(judgement.detail).toContain("not admitted implicitly");
  });

  it("does NOT admit T0 on a router-written pin — history is not an opt-in", () => {
    const t0 = t0Row();
    const judgement = resolveTier(
      { issueId: "i1", pinnedModelId: t0.id, pinProvenance: "router" },
      [...MODELS, t0],
      "T1",
    );
    expect(judgement.tier).toBe("T1");
    expect(admittedTierCeiling(judgement)).toBe("T1");
  });

  it("does NOT admit T0 on an inherited floor — floors never manufacture opt-in", () => {
    const t0 = t0Row();
    const judgement = resolveTier(
      { issueId: "i1", agentFloorModelId: t0.id },
      [...MODELS, t0],
      "T1",
    );
    expect(judgement.tier).toBe("T1");
    expect(admittedTierCeiling(judgement)).toBe("T1");
  });

  it("keeps capability exclusion forcing T1 even under a tier:T0 label", () => {
    const judgement = resolveTier(
      {
        issueId: "i1",
        labelNames: ["tier:T0"],
        exclusion: { excluded: true, reasons: ["rotates a credential"] },
      },
      [...MODELS, t0Row()],
      "T1",
    );
    expect(judgement.tier).toBe("T1");
    expect(judgement.source).toBe("capability-exclusion");
    expect(admittedTierCeiling(judgement)).toBe("T1");
  });

  it("defaults a pre-T0 judgement (no ceiling recorded) to the implicit ceiling", () => {
    expect(admittedTierCeiling({} as never)).toBe("T1");
  });

  it("never lets the router mint a tier:T0 label", () => {
    expect(routerMayWriteTierLabel("T3")).toBe(true);
    expect(routerMayWriteTierLabel("T2")).toBe(true);
    expect(routerMayWriteTierLabel("T1")).toBe(true);
    expect(routerMayWriteTierLabel("T0")).toBe(false);
  });
});

describe("T0 admission — selectModel", () => {
  it("never selects a T0 row for an ordinary T1 card, however cheap it is", () => {
    const t0 = t0Row();
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({ models: [...MODELS, model(t0, { costPerMTokIn: 0, costPerMTokOut: 0, costPerMTokCacheRead: 0 })] }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).not.toBe(t0.id);
    expect(decision.trace.some((line) => line.includes("tier ceiling T1"))).toBe(true);
  });

  it("selects the T0 row for an explicit tier:T0 card (positive control)", () => {
    const t0 = t0Row();
    const decision = selectModel({
      ...withT0Profile,
      descriptor: { issueId: "i1", labelNames: ["tier:T0"] },
      config: config({
        models: [...MODELS, t0],
        modelScores: { [t0.id]: scoreOf(t0.id) },
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe(t0.id);
    expect(decision.effectiveTier).toBe("T0");
  });

  it("refuses to guess the volume term for a T0 card until a T0 profile exists", () => {
    // The cold-start edge: an explicit T0 card before any T0 volume has been
    // measured must not be costed off another tier's numbers.
    const t0 = t0Row();
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T0"] },
      config: config({ models: [...MODELS, t0], modelScores: { [t0.id]: scoreOf(t0.id) } }),
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
  });

  it("does not escalate an exhausted T1 card onto a healthy T0 row — tier-exhausted at the T1 ceiling", () => {
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const t0 = t0Row();
    const laned = [model(t1, { laneId: "lane-t1" }), model(t0, { laneId: "lane-t0" })];
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({ models: laned, laneLedger: ledgerWith("lane-t1") }),
    });
    // The T1 lane is exhausted and the only healthy row is barred T0:
    // nowhere left to escalate *to*, so this is exhaustion, not a silent gap.
    expect(decision.outcome).toBe("tier-exhausted");
    expect(decision.modelId).toBeNull();
    expect(decision.effectiveTier).toBe("T1");
  });

  it("declines a sticky T0 incumbent on an ordinary card — sticky history is not an opt-in", () => {
    const t0 = t0Row();
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], stickyModelId: t0.id },
      config: config({ models: [...MODELS, t0] }),
    });
    expect(decision.modelId).not.toBe(t0.id);
    expect(decision.trace.some((line) => line.includes("sticky") && line.includes("not a T0 opt-in"))).toBe(true);
  });

  it("holds at the floor — selecting nothing — when the agent floor is a T0 row and the profile is untrusted", () => {
    // The wake-time path that never reaches a pick: the agent's own floor is the
    // T0 row, the card is ordinary, and the volume term is untrusted. The
    // decision names no model, so no write can carry the card onto T0.
    const t0 = t0Row();
    const untrusted = PROFILES.map((profile) => (profile.tier === "T1" ? { ...profile, sampleCount: 2 } : profile));
    const decision = selectModel({
      ...base,
      profiles: untrusted,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], agentFloorModelId: t0.id },
      config: config({ models: [...MODELS, t0], enforcementEnabled: true }),
    });
    expect(decision.outcome).toBe("held-at-floor");
    expect(decision.modelId).toBeNull();
    expect(decision.judgement.tier).toBe("T1");
  });

  it("keeps the per-rung fallback-only hatch at T1 beside a barred T0 row", () => {
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const regular = model(t1, { id: "regular", enabled: false });
    const fallback = model(t1, { id: "fallback", costPerMTokIn: 0, fallbackOnly: true });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({ models: [fallback, regular, t0Row()] }),
    });
    expect(decision.modelId).toBe("fallback");
    expect(decision.trace.some((line) => line.includes("fallback-only"))).toBe(true);
  });
});

describe("T0 never enters through derivation, explore or earn-in", () => {
  it("applyDerivedTiers clamps an auto-promotion at T1, never T0", () => {
    // A posterior at 0.95 derives T0 — but derivation must not place the row
    // in the explicit-only rung. Both rows stop at the ceiling.
    expect(tierForPosterior(0.95).tier).toBe("T0");
    const roster = [
      { id: "a", tier: "T1" as const },
      { id: "b", tier: "T2" as const },
    ];
    const scored: Record<string, ModelScore> = {
      a: derivedScore("a", "T0"),
      b: derivedScore("b", "T0"),
    };
    const out = applyDerivedTiers(roster, scored);
    expect(out.find((m) => m.id === "a")?.tier).toBe("T1");
    expect(out.find((m) => m.id === "b")?.tier).toBe("T1");
  });

  it("applyDerivedTiers leaves a T0 row at T0 even when it derives a lower tier — no silent drop into implicit T1", () => {
    // A demotion here would make an S-tier row an ordinary regular T1 row that
    // implicit dispatch may pick. T0 placement is operator-recorded; the
    // capability gate, not the overlay, decides whether the row can do T0 work.
    for (const derived of ["T1", "T2", "T3"] as const) {
      const roster = [{ id: "a", tier: "T0" as const }];
      const scored: Record<string, ModelScore> = { a: derivedScore("a", derived) };
      expect(applyDerivedTiers(roster, scored).find((m) => m.id === "a")?.tier).toBe("T0");
    }
  });

  it("applyDerivedTiers still demotes a T1 row that stops deriving T1 (positive control: derivation is live below the ceiling)", () => {
    const roster = [{ id: "a", tier: "T1" as const }];
    const scored: Record<string, ModelScore> = { a: derivedScore("a", "T2") };
    expect(applyDerivedTiers(roster, scored).find((m) => m.id === "a")?.tier).toBe("T2");
  });

  // `t0-explore-3200` is a fixed issue id found by brute-force search over
  // `hashUnitInterval`, the hash `applyPickOrdering` itself rolls: its T0, T1
  // and T2 explore rolls all fall under EXPLORE_FRACTION (0.1), so the roll
  // WOULD fire at every tier and only a guard can stop it. (The older T1 test
  // seeds never roll under 0.1, so it cannot tell a live T1 guard from none.)
  const ROLLS = "t0-explore-3200";

  function exploreCandidate(modelId: string, tier: Candidate["tier"], cost: number): Candidate {
    return {
      modelId,
      tier,
      releasedAt: "2026-01-01",
      fallbackOnly: false,
      runCostUsd: cost,
      inputCostUsd: cost,
      cacheReadCostUsd: 0,
      outputCostUsd: 0,
      escalationRiskUsd: 0,
      expectedCostUsd: cost,
      profileTier: tier,
      profileTrusted: true,
    };
  }

  /** Unproven at every tier: the exact shape explore exists to roll on. */
  function unprovenScore(modelId: string): ModelScore {
    return scoreOf(modelId, {
      tiers: {
        T0: tierScore({ capable: true, proven: false }),
        T1: tierScore({ capable: true, proven: false }),
        T2: tierScore({ capable: true, proven: false }),
        T3: tierScore({ capable: true, proven: false }),
      },
    });
  }

  it("explore fires at T2 for an unproven candidate on the same roll (positive control)", () => {
    const t2 = model(MODELS.find((entry) => entry.tier === "T2")!, { id: "t2-unproven", laneId: "lane-t2" });
    const result = applyPickOrdering(
      [exploreCandidate(t2.id, "T2", 1)],
      [t2],
      {},
      { [t2.id]: unprovenScore(t2.id) },
      "T2",
      ROLLS,
      true,
    );
    expect(result.explored).toBe(true);
    expect(result.exploreModelId).toBe(t2.id);
  });

  it("explore never fires for a T1 card on a roll that would otherwise fire", () => {
    const t1 = model(MODELS.find((entry) => entry.tier === "T1")!, { id: "t1-unproven", laneId: "lane-t1" });
    const result = applyPickOrdering(
      [exploreCandidate(t1.id, "T1", 1)],
      [t1],
      {},
      { [t1.id]: unprovenScore(t1.id) },
      "T1",
      ROLLS,
      true,
    );
    expect(result.explored).toBe(false);
  });

  it("explore never fires for a T0 card on a roll that would otherwise fire", () => {
    const t0 = t0Row();
    const result = applyPickOrdering(
      [exploreCandidate(t0.id, "T0", 1)],
      [t0],
      {},
      { [t0.id]: unprovenScore(t0.id) },
      "T0",
      ROLLS,
      true,
    );
    expect(result.explored).toBe(false);
    expect(result.exploreModelId).toBeNull();
  });

  it("explore never hands an unproven T0 row the roll even when a lower required tier walked up to it", () => {
    // A wake-floored decision starts below T1 and the ladder can reach a T0
    // rung: the T0 candidate is cheaper, unproven and rolling — still barred.
    const t2 = model(MODELS.find((entry) => entry.tier === "T2")!, { id: "t2-unproven", laneId: "lane-t2" });
    const t0 = t0Row();
    const result = applyPickOrdering(
      [exploreCandidate(t0.id, "T0", 0.5), exploreCandidate(t2.id, "T2", 1)],
      [t0, t2],
      {},
      { [t0.id]: unprovenScore(t0.id), [t2.id]: unprovenScore(t2.id) },
      "T2",
      ROLLS,
      true,
    );
    expect(result.explored).toBe(true);
    expect(result.exploreModelId).toBe(t2.id);
  });
});

describe("T0 never enters through the router's own writes or scheduled passes", () => {
  it("planApply pins a T0 decision but never writes a tier:T0 label", () => {
    const t0 = t0Row();
    const decision = selectModel({
      ...withT0Profile,
      descriptor: { issueId: "i1", labelNames: ["tier:T0"] },
      config: config({
        models: [...MODELS, t0],
        modelScores: { [t0.id]: scoreOf(t0.id) },
        enforcementEnabled: true,
      }),
    });
    expect(decision.modelId).toBe(t0.id);
    const plan = planApply(
      decision,
      { hasExistingOverride: false, hasExistingTierLabel: false, status: "in_progress" },
      "i1",
    );
    expect(plan.write).toBe(true);
    expect(plan.modelId).toBe(t0.id);
    expect(plan.labelName).toBeNull();
  });

  it("planApply still writes a tier:T1 label for a T1 decision (positive control)", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({ enforcementEnabled: true }),
    });
    const plan = planApply(
      decision,
      { hasExistingOverride: false, hasExistingTierLabel: false, status: "in_progress" },
      "i1",
    );
    expect(plan.labelName).toBe("tier:T1");
  });

  it("tierWithFallback never lifts a card to T0 from a pin, a floor or a default", () => {
    const t0 = t0Row();
    const models = [...MODELS, t0];
    expect(tierWithFallback({ issueId: "i1", pinnedModelId: t0.id }, models, "T1")).toBe("T1");
    expect(tierWithFallback({ issueId: "i1", pinnedModelId: t0.id, pinProvenance: "router" }, models, "T1")).toBe("T1");
    expect(tierWithFallback({ issueId: "i1", agentFloorModelId: t0.id }, models, "T1")).toBe("T1");
    expect(tierWithFallback({ issueId: "i1" }, models, "T1")).toBe("T1");
  });

  it("tierWithFallback honours an explicit tier:T0 label over a weaker pin, and exclusion over the label", () => {
    const t0 = t0Row();
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const models = [...MODELS, t0];
    expect(tierWithFallback({ issueId: "i1", labelNames: ["tier:T0"], pinnedModelId: t1.id }, models, "T1")).toBe("T0");
    expect(
      tierWithFallback(
        { issueId: "i1", labelNames: ["tier:T0"], exclusion: { excluded: true, reasons: ["spends money"] } },
        models,
        "T1",
      ),
    ).toBe("T1");
  });

  it("free-lane earn-in skips an unproven free T0 candidate but not an unproven free T1 one", () => {
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const freeT1 = model(t1, { id: "free-t1", laneId: "lane-free", costPerMTokIn: 0, costPerMTokOut: 0, costPerMTokCacheRead: 0 });
    const freeT0 = model(t0Row("free-t0"), { laneId: "lane-free", costPerMTokIn: 0, costPerMTokOut: 0, costPerMTokCacheRead: 0 });
    const freeLedger: LaneLedger = {
      "lane-free": {
        laneId: "lane-free",
        verdict: { ...unserviceableVerdict("lane-free"), state: "free", serviceable: true, reason: "free-lane", knownAccountCount: 0, knownWeight: 0 },
        fetchedAt: NOW.toString(),
        error: null,
        observation: null,
      },
    };
    const mk = (modelId: string, tier: Candidate["tier"]): Candidate => ({
      modelId,
      tier,
      releasedAt: "2026-01-01",
      fallbackOnly: false,
      runCostUsd: 0,
      inputCostUsd: 0,
      cacheReadCostUsd: 0,
      outputCostUsd: 0,
      escalationRiskUsd: 0,
      expectedCostUsd: 0,
      profileTier: tier,
      profileTrusted: true,
    });
    const unproven = (id: string) =>
      scoreOf(id, {
        tiers: {
          T0: tierScore({ capable: true, proven: false, n: 1 }),
          T1: tierScore({ capable: true, proven: false, n: 1 }),
          T2: tierScore({ capable: true, proven: false, n: 1 }),
          T3: tierScore({ capable: true, proven: false, n: 1 }),
        },
      });
    const scores = { "free-t1": unproven("free-t1"), "free-t0": unproven("free-t0") };

    const picks = freeEarnInCandidates(
      [mk("free-t0", "T0"), mk("free-t1", "T1")],
      [freeT0, freeT1],
      freeLedger,
      scores,
      "T0",
    );
    expect(picks.map((pick) => pick.candidate.modelId)).toEqual(["free-t1"]);
  });
});
