import { describe, expect, it } from "vitest";

import { freeEarnInCandidates, freeEarnInWinner } from "../src/engine/free-lane-earn-in.js";
import type { LaneLedger } from "../src/engine/pacing.js";
import { selectModel } from "../src/engine/select.js";
import type { Candidate, ModelEntry, ModelScore } from "../src/engine/types.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };
const t1 = MODELS.find((entry) => entry.tier === "T1")!;

function model(baseModel: ModelEntry, overrides: Partial<ModelEntry>): ModelEntry {
  return { ...baseModel, ...overrides };
}

type TierKey = "T1" | "T2" | "T3";

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

function score(
  modelId: string,
  tiers: Partial<Record<TierKey, Partial<ModelScore["tiers"]["T1"]>>>,
): ModelScore {
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

function candidate(modelId: string, expectedCostUsd: number, releasedAt = "2026-01-01"): Candidate {
  return {
    modelId,
    tier: "T1",
    releasedAt,
    fallbackOnly: false,
    runCostUsd: expectedCostUsd,
    inputCostUsd: expectedCostUsd,
    cacheReadCostUsd: 0,
    outputCostUsd: 0,
    escalationRiskUsd: 0,
    expectedCostUsd,
    profileTier: "T1",
    profileTrusted: true,
  };
}

/** A $0/MTok T1 row on the subscription lane, unjudged by default. */
function freeModel(id: string): ModelEntry {
  return model(t1, {
    id,
    laneId: "lane-free",
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    costPerMTokCacheRead: 0,
    releasedAt: "2026-09-01",
  });
}

function paidModel(id: string, laneId = "lane-paid"): ModelEntry {
  return model(t1, { id, laneId, releasedAt: "2026-01-01" });
}

function freeVerdict(laneId: string): LanePaceVerdict {
  return {
    laneId,
    observedAt: "2026-09-10T11:00:00.000Z",
    state: "free",
    serviceable: true,
    score: null,
    accounts: [],
    knownAccountCount: 0,
    knownWeight: 0,
    serviceableAccountCount: 0,
    urgentResetAt: null,
    reason: "free-lane",
  };
}

function onVerdict(laneId: string): LanePaceVerdict {
  return {
    laneId,
    observedAt: "2026-09-10T11:00:00.000Z",
    state: "on",
    serviceable: true,
    score: { utilization: 0.1, elapsed: 0.5, deviation: 0 },
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 1,
    urgentResetAt: null,
    reason: "ok",
  };
}

function exhaustedVerdict(laneId: string): LanePaceVerdict {
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

function ledgerWith(verdicts: LanePaceVerdict[]): LaneLedger {
  const ledger: LaneLedger = {};
  for (const verdict of verdicts) {
    ledger[verdict.laneId] = {
      laneId: verdict.laneId,
      verdict,
      fetchedAt: NOW.toString(),
      error: null,
      observation: null,
    };
  }
  return ledger;
}

function earnInTrace(decision: { trace: readonly string[] }): boolean {
  return decision.trace.some((line) => line.includes("free-lane earn-in"));
}

describe("free-lane earn-in helpers", () => {
  const models: ModelEntry[] = [freeModel("meta-free"), paidModel("opus-paid")];
  const candidates = [candidate("opus-paid", 2), candidate("meta-free", 0)];

  function scoresFor(freeTier: Partial<ModelScore["tiers"]["T1"]>): Record<string, ModelScore> {
    return {
      "meta-free": score("meta-free", { T1: freeTier }),
      "opus-paid": score("opus-paid", { T1: { proven: true, capable: true, n: 416 } }),
    };
  }

  it("picks the unproven free-lane candidate and reports its observation count", () => {
    const ledger = ledgerWith([freeVerdict("lane-free")]);
    const picks = freeEarnInCandidates(candidates, models, ledger, scoresFor({ n: 2 }), "T1");
    expect(picks.map((p) => p.candidate.modelId)).toEqual(["meta-free"]);
    expect(picks[0]!.observations).toBe(2);
    expect(picks[0]!.laneId).toBe("lane-free");
  });

  it("skips a free lane that is already proven — earn-in stands down once judged", () => {
    const ledger = ledgerWith([freeVerdict("lane-free")]);
    const picks = freeEarnInCandidates(
      candidates,
      models,
      ledger,
      scoresFor({ proven: true, capable: true, n: 20 }),
      "T1",
    );
    expect(picks).toEqual([]);
    expect(freeEarnInWinner(candidates, models, ledger, scoresFor({ proven: true, capable: true, n: 20 }), "T1")).toBeNull();
  });

  it("never re-admits a measured-failing free lane (capable === false)", () => {
    const ledger = ledgerWith([freeVerdict("lane-free")]);
    const picks = freeEarnInCandidates(
      candidates,
      models,
      ledger,
      scoresFor({ proven: false, capable: false, n: 20 }),
      "T1",
    );
    expect(picks).toEqual([]);
  });

  it("skips a free lane that is not serviceable, and a lane that is not free at all", () => {
    const dead = ledgerWith([{ ...freeVerdict("lane-free"), serviceable: false }]);
    expect(
      freeEarnInCandidates(candidates, models, dead, scoresFor({ n: 1 }), "T1"),
    ).toEqual([]);
    const on = ledgerWith([onVerdict("lane-free")]);
    expect(
      freeEarnInCandidates(candidates, models, on, scoresFor({ n: 1 }), "T1"),
    ).toEqual([]);
  });

  it("skips models with no lane, and works with no score history at all", () => {
    const laneless = [model(t1, { id: "laneless", laneId: null }), paidModel("opus-paid")];
    const ledger = ledgerWith([freeVerdict("lane-free")]);
    expect(
      freeEarnInCandidates(
        [candidate("laneless", 0), candidate("opus-paid", 2)],
        laneless,
        ledger,
        undefined,
        "T1",
      ),
    ).toEqual([]);
    // No scores: the free-lane model is unjudged (n 0), so it still qualifies.
    expect(
      freeEarnInWinner(candidates, models, ledger, undefined, "T1")?.candidate.modelId,
    ).toBe("meta-free");
  });

  it("breaks ties cheapest first, then newest release, then stable id", () => {
    const tied: ModelEntry[] = [
      model(t1, { id: "meta-old", laneId: "lane-a", costPerMTokIn: 0, costPerMTokOut: 0, costPerMTokCacheRead: 0 }),
      model(t1, { id: "meta-new", laneId: "lane-b", costPerMTokIn: 0, costPerMTokOut: 0, costPerMTokCacheRead: 0 }),
    ];
    const tiedCandidates = [candidate("meta-old", 0, "2026-01-01"), candidate("meta-new", 0, "2026-09-01")];
    const ledger = ledgerWith([freeVerdict("lane-a"), freeVerdict("lane-b")]);
    expect(freeEarnInWinner(tiedCandidates, tied, ledger, undefined, "T1")?.candidate.modelId).toBe(
      "meta-new",
    );
    const sameDate = [candidate("meta-b", 0, "2026-09-01"), candidate("meta-a", 0, "2026-09-01")];
    const sameModels: ModelEntry[] = [
      model(t1, { id: "meta-b", laneId: "lane-a", costPerMTokIn: 0, costPerMTokOut: 0, costPerMTokCacheRead: 0 }),
      model(t1, { id: "meta-a", laneId: "lane-b", costPerMTokIn: 0, costPerMTokOut: 0, costPerMTokCacheRead: 0 }),
    ];
    expect(freeEarnInWinner(sameDate, sameModels, ledger, undefined, "T1")?.candidate.modelId).toBe(
      "meta-a",
    );
  });
});

describe("free-lane earn-in through selectModel", () => {
  it("2026-09-19 owner rule: an unproven model on a serviceable free lane wins its tier over a proven paid model", () => {
    // This is the 21:12Z experiment inverted: without earn-in,
    // `applyPickOrdering`'s free-must-be-proven filter demotes meta-free to
    // the tail and the earned opus score wins. Earn-in promotes it back.
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "earn-in-win", labelNames: ["tier:T1"] },
      config: config({
        models: [freeModel("meta-free"), paidModel("opus-paid")],
        laneLedger: ledgerWith([freeVerdict("lane-free")]),
        modelScores: {
          "meta-free": score("meta-free", { T1: { proven: false, capable: null, n: 2 } }),
          "opus-paid": score("opus-paid", { T1: { proven: true, capable: true, n: 416, p: 0.965 } }),
        },
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("meta-free");
    expect(earnInTrace(decision)).toBe(true);
  });

  it("holds the win in enforce mode without tainting pacingApplied: pace still reports its own reorder", () => {
    // No scores, so cost order puts the $0 free lane first and pace (on=2
    // outranks free=4) visibly reorders paid ahead of it — pacingApplied
    // stays a pure pace-vs-cost signal even though earn-in wins the run.
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "earn-in-enforce", labelNames: ["tier:T1"] },
      config: config({
        models: [freeModel("meta-free"), paidModel("opus-paid")],
        pacingMode: "enforce",
        laneLedger: ledgerWith([freeVerdict("lane-free"), onVerdict("lane-paid")]),
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("meta-free");
    expect(decision.pacingApplied).toBe(true);
    expect(earnInTrace(decision)).toBe(true);
  });

  it("stands down once judged: a proven free lane keeps winning on cost, but without the earn-in trace", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "earn-in-proven", labelNames: ["tier:T1"] },
      config: config({
        models: [freeModel("meta-free"), paidModel("opus-paid")],
        laneLedger: ledgerWith([freeVerdict("lane-free")]),
        modelScores: {
          "meta-free": score("meta-free", { T1: { proven: true, capable: true, n: 20, p: 0.9 } }),
          "opus-paid": score("opus-paid", { T1: { proven: true, capable: true, n: 416, p: 0.965 } }),
        },
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("meta-free");
    expect(earnInTrace(decision)).toBe(false);
  });

  it("loses when the free lane has no room for a new card: the cap gate rejects before earn-in runs", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "earn-in-noroom", labelNames: ["tier:T1"] },
      config: config({
        models: [freeModel("meta-free"), paidModel("opus-paid")],
        laneLedger: ledgerWith([freeVerdict("lane-free")]),
        laneRoom: {
          capPerAccount: { "lane-free": 1 },
          activePinsWeightByLane: { "lane-free": 1 },
          fiveHourWindowName: "5h",
          zaiLaneId: "lane-zai",
          zaiWeeklyWindowName: "weekly",
          zaiWeeklyDefaultMargin: 0.1,
          zaiPaceOverrideMargin: null,
          now: NOW,
        },
        modelScores: {
          "meta-free": score("meta-free", { T1: { proven: false, capable: null, n: 2 } }),
          "opus-paid": score("opus-paid", { T1: { proven: true, capable: true, n: 416 } }),
        },
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("opus-paid");
    expect(
      decision.rejections.some((r) => r.stage === "lane-no-room" && r.modelId === "meta-free"),
    ).toBe(true);
    expect(earnInTrace(decision)).toBe(false);
  });

  it("loses when the free lane reports exhausted: the hard stop excludes it before earn-in runs", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "earn-in-exhausted", labelNames: ["tier:T1"] },
      config: config({
        models: [freeModel("meta-free"), paidModel("opus-paid")],
        laneLedger: ledgerWith([exhaustedVerdict("lane-free")]),
        modelScores: {
          "meta-free": score("meta-free", { T1: { proven: false, capable: null, n: 2 } }),
          "opus-paid": score("opus-paid", { T1: { proven: true, capable: true, n: 416 } }),
        },
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("opus-paid");
    expect(
      decision.rejections.some((r) => r.stage === "lane-unserviceable" && r.modelId === "meta-free"),
    ).toBe(true);
    expect(earnInTrace(decision)).toBe(false);
  });

  it("yields to an operator override: the pinned model wins and earn-in stays silent", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "earn-in-override", labelNames: ["tier:T1"] },
      config: config({
        models: [freeModel("meta-free"), paidModel("opus-paid")],
        laneLedger: ledgerWith([freeVerdict("lane-free")]),
        operatorOverrideModelId: "opus-paid",
        modelScores: {
          "meta-free": score("meta-free", { T1: { proven: false, capable: null, n: 2 } }),
          "opus-paid": score("opus-paid", { T1: { proven: true, capable: true, n: 416 } }),
        },
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("opus-paid");
    expect(earnInTrace(decision)).toBe(false);
  });

  it("rule (a) still decides once earn-in stands down: same price and family, the newer release wins", () => {
    const older = model(t1, { id: "claude-opus-4-8", laneId: "lane-a", releasedAt: "2026-01-05" });
    const newer = model(t1, { id: "claude-opus-5", laneId: "lane-b", releasedAt: "2026-06-24" });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "earn-in-rule-a", labelNames: ["tier:T1"] },
      config: config({
        models: [older, newer, freeModel("meta-free")],
        laneLedger: ledgerWith([exhaustedVerdict("lane-free")]),
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-opus-5");
    expect(earnInTrace(decision)).toBe(false);
  });
});
