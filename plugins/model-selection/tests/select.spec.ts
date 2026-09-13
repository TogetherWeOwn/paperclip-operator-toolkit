import { describe, expect, it } from "vitest";

import { selectModel } from "../src/engine/select.js";
import type { LaneLedger } from "../src/engine/pacing.js";
import type { CardLedgerEntry, ModelEntry, VolumeProfile } from "../src/engine/types.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };

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
    ledger[laneId] = { laneId, verdict: unserviceableVerdict(laneId), fetchedAt: NOW.toString(), error: null };
  }
  return ledger;
}

describe("selection", () => {
  it("picks the cheapest model that clears the judged tier floor", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config(),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("cliproxy/claude-haiku-4-5-20251001");
    expect(decision.effectiveTier).toBe("T3");
  });

  it("never selects below a T1 capability exclusion", () => {
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "i1",
        labelNames: ["tier:T3"],
        exclusion: { excluded: true, reasons: ["rotates a credential"] },
      },
      config: config(),
    });
    expect(decision.judgement.source).toBe("capability-exclusion");
    expect(decision.judgement.tier).toBe("T1");
    expect(decision.modelId).toBe("claude-opus-5");
  });

  it("declines the sticky model when it sits below the required tier", () => {
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "i1",
        labelNames: ["tier:T1"],
        stickyModelId: "cliproxy/claude-haiku-4-5-20251001",
      },
      config: config(),
    });
    expect(decision.modelId).toBe("claude-opus-5");
    expect(
      decision.rejections.some(
        (r) => r.stage === "tier-floor" && r.modelId === "cliproxy/claude-haiku-4-5-20251001",
      ),
    ).toBe(true);
  });

  it("emits a tier-floor rejection for every model below T1", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config(),
    });
    const floored = decision.rejections.filter((r) => r.stage === "tier-floor").map((r) => r.modelId);
    expect(floored).toContain("cliproxy/claude-haiku-4-5-20251001");
    expect(floored).toContain("claude-sonnet-5");
    expect(floored).not.toContain("claude-opus-5");
  });

  it("excludes a model missing a required capability, however cheap it is", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"], requiredCapabilities: ["vision"] },
      config: config(),
    });
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.rejections.some((r) => r.stage === "capability" && r.modelId.includes("haiku"))).toBe(true);
  });

  it("keeps the model already running when it still clears the tier floor", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"], stickyModelId: "claude-opus-5" },
      config: config(),
    });
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.trace.some((line) => line.includes("sticky"))).toBe(true);
  });

  it("holds at the agent floor rather than act on an untrusted volume profile", () => {
    const thin: VolumeProfile[] = PROFILES.map((p) => ({ ...p, sampleCount: 1 }));
    const decision = selectModel({
      ...base,
      profiles: thin,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config(),
    });
    expect(decision.outcome).toBe("held-at-floor");
    expect(decision.heldReason).toContain("not trusted");
  });

  it("refuses to choose at all when no candidate can be costed", () => {
    const decision = selectModel({
      ...base,
      profiles: [],
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config(),
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.trace.some((line) => line.includes("guessed volume term"))).toBe(true);
  });

  it("is advisory unless enforcement is explicitly enabled", () => {
    const advisory = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config(),
    });
    expect(advisory.advisory).toBe(true);

    const enforcing = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({ enforcementEnabled: true }),
    });
    expect(enforcing.advisory).toBe(false);
  });

  it("reports disabled when no models are configured", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1" },
      config: config({ models: [] }),
    });
    expect(decision.outcome).toBe("disabled");
  });

  it("preserves disabled rows and never returns them", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T2"] },
      config: config({
        models: MODELS.map((entry) =>
          entry.tier === "T2" ? { ...entry, enabled: false } : entry,
        ),
      }),
    });
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.rejections.some((r) => r.stage === "disabled" && r.modelId === "claude-sonnet-5")).toBe(true);
  });

  it("uses fallback-only rows only after regular rows are exhausted", () => {
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const regular = model(t1, { id: "regular", costPerMTokIn: 5 });
    const fallback = model(t1, { id: "fallback", costPerMTokIn: 0, fallbackOnly: true });
    const withRegular = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({ models: [fallback, regular] }),
    });
    expect(withRegular.modelId).toBe("regular");

    const fallbackOnly = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({ models: [fallback, { ...regular, enabled: false }] }),
    });
    expect(fallbackOnly.modelId).toBe("fallback");
    expect(fallbackOnly.trace.some((line) => line.includes("fallback-only"))).toBe(true);
  });

  it("never revives a disabled fallback-only row", () => {
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const disabledFallback = model(t1, {
      id: "disabled-fallback",
      enabled: false,
      fallbackOnly: true,
    });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({ models: [disabledFallback] }),
    });
    expect(decision.modelId).toBeNull();
    expect(decision.rejections.some((r) => r.stage === "disabled")).toBe(true);
  });

  it("records a trace line for every decision it makes", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config(),
    });
    expect(decision.trace.length).toBeGreaterThanOrEqual(4);
    expect(decision.trace[0]).toContain("tier T1 via issue-label");
    expect(decision.trace.some((line) => line.includes("cache-read"))).toBe(true);
    expect(decision.trace.at(-1)).toContain("advisory mode");
  });

  it("orders candidates on expected cost including escalation risk", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config(),
    });
    const costs = decision.candidates.map((c) => c.expectedCostUsd);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
  });

  it("prefers the newest release when expected costs tie exactly", () => {
    const t2 = MODELS.find((entry) => entry.tier === "T2")!;
    const older = model(t2, { id: "alpha-older", releasedAt: "2026-01-01" });
    const newer = model(t2, { id: "zeta-newer", releasedAt: "2026-09-01" });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T2"] },
      config: config({ models: [older, newer] }),
    });
    expect(decision.modelId).toBe("zeta-newer");
  });

  it("uses stable model id order after an exact price and release tie", () => {
    const t2 = MODELS.find((entry) => entry.tier === "T2")!;
    const zeta = model(t2, { id: "zeta", releasedAt: "2026-09-01" });
    const alpha = model(t2, { id: "alpha", releasedAt: "2026-09-01" });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T2"] },
      config: config({ models: [zeta, alpha] }),
    });
    expect(decision.modelId).toBe("alpha");
  });

  describe("TOG-2137 Defect 2: tier-exhaustion escalation", () => {
    const t3 = MODELS.find((entry) => entry.tier === "T3")!;
    const t2 = MODELS.find((entry) => entry.tier === "T2")!;
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const laned = [
      model(t3, { laneId: "lane-t3" }),
      model(t2, { laneId: "lane-t2" }),
      model(t1, { laneId: "lane-t1" }),
    ];

    it("escalates exactly one tier up when the required tier is pace-exhausted", () => {
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
        config: config({ models: laned, laneLedger: ledgerWith("lane-t3") }),
      });
      expect(decision.outcome).toBe("selected");
      expect(decision.modelId).toBe(t2.id);
      expect(decision.effectiveTier).toBe("T2");
      expect(decision.escalatedFromTier).toBe("T3");
      expect(decision.trace.some((line) => line.includes("escalated from T3 to T2"))).toBe(true);
    });

    it("climbs a second rung, never skipping the middle tier, when two tiers in a row are pace-exhausted", () => {
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
        config: config({ models: laned, laneLedger: ledgerWith("lane-t3", "lane-t2") }),
      });
      expect(decision.outcome).toBe("selected");
      expect(decision.modelId).toBe(t1.id);
      expect(decision.effectiveTier).toBe("T1");
      expect(decision.escalatedFromTier).toBe("T3");
    });

    it("never sets escalatedFromTier on an ordinary same-tier pick", () => {
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
        config: config({ models: laned, laneLedger: {} }),
      });
      expect(decision.modelId).toBe(t3.id);
      expect(decision.escalatedFromTier).toBeNull();
    });

    it("reports tier-exhausted, not no-eligible-model, when T1 itself has no usable lane and there is nowhere left to escalate", () => {
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
        config: config({ models: laned, laneLedger: ledgerWith("lane-t1") }),
      });
      expect(decision.outcome).toBe("tier-exhausted");
      expect(decision.modelId).toBeNull();
      expect(decision.effectiveTier).toBe("T1");
      expect(decision.trace.some((line) => line.includes("tier exhausted"))).toBe(true);
    });

    it("reports tier-exhausted when every tier from the required floor through T1 is pace-exhausted", () => {
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
        config: config({ models: laned, laneLedger: ledgerWith("lane-t3", "lane-t2", "lane-t1") }),
      });
      expect(decision.outcome).toBe("tier-exhausted");
      expect(decision.modelId).toBeNull();
    });

    it("stays no-eligible-model, not tier-exhausted, when a config/capability gap is mixed in alongside pace exhaustion", () => {
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "i1", labelNames: ["tier:T1"], requiredCapabilities: ["computer-use"] },
        config: config({ models: laned, laneLedger: ledgerWith("lane-t1") }),
      });
      expect(decision.outcome).toBe("no-eligible-model");
    });

    it("does not treat a merely-behind (still serviceable) lane as an escalation trigger", () => {
      const behindLedger: LaneLedger = {
        "lane-t3": {
          laneId: "lane-t3",
          verdict: { ...unserviceableVerdict("lane-t3"), state: "behind", serviceable: true },
          fetchedAt: NOW.toString(),
          error: null,
        },
      };
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
        config: config({ models: laned, laneLedger: behindLedger }),
      });
      expect(decision.modelId).toBe(t3.id);
      expect(decision.escalatedFromTier).toBeNull();
    });
  });

  describe("TOG-2137 Defect 6: a pin or sticky model cannot hard-bypass capacity routing", () => {
    const t3 = MODELS.find((entry) => entry.tier === "T3")!;
    const t2 = MODELS.find((entry) => entry.tier === "T2")!;
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const laned = [
      model(t3, { laneId: "lane-t3" }),
      model(t2, { laneId: "lane-t2" }),
      model(t1, { laneId: "lane-t1" }),
    ];

    it("re-derives the tier from the label instead of an issue-override pin whose lane is unserviceable", () => {
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "i1", labelNames: ["tier:T2"], pinnedModelId: t1.id },
        config: config({ models: laned, laneLedger: ledgerWith("lane-t1") }),
      });
      expect(decision.judgement.source).toBe("issue-label");
      expect(decision.judgement.tier).toBe("T2");
      // The pinned T1 model must not silently win either — it is excluded by
      // the ordinary serviceability hard stop below, same as any other
      // candidate on a dead lane.
      expect(decision.modelId).not.toBe(t1.id);
    });

    it("still honors a serviceable pin outright — this only strips a pin that is universally dead", () => {
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "i1", labelNames: ["tier:T2"], pinnedModelId: t1.id },
        config: config({ models: laned, laneLedger: {} }),
      });
      expect(decision.judgement.source).toBe("issue-override");
      expect(decision.judgement.tier).toBe("T1");
      expect(decision.modelId).toBe(t1.id);
    });

    it("declines a sticky model whose lane has gone unserviceable instead of wedging the issue there", () => {
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "i1", labelNames: ["tier:T1"], stickyModelId: t1.id },
        config: config({ models: laned, laneLedger: ledgerWith("lane-t1") }),
      });
      expect(decision.outcome).toBe("tier-exhausted");
      expect(
        decision.rejections.some((r) => r.stage === "lane-unserviceable" && r.modelId === t1.id),
      ).toBe(true);
      expect(decision.trace.some((line) => line.includes("sticky") && line.includes("not serviceable"))).toBe(true);
    });

    it("keeps the sticky model when its lane is still serviceable, unchanged from before Defect 6", () => {
      const decision = selectModel({
        ...base,
        descriptor: { issueId: "i1", labelNames: ["tier:T1"], stickyModelId: t1.id },
        config: config({ models: laned, laneLedger: {} }),
      });
      expect(decision.modelId).toBe(t1.id);
      expect(decision.trace.some((line) => line.includes("already running this issue"))).toBe(true);
    });
  });
});

describe("pace-vs-objective composition (TOG-2136 + TOG-2137)", () => {
  // Two T1 candidates: `cheap-ahead` is the list-price winner AND has the best
  // (lowest) cost-per-accepted-card, but its lane is running `ahead` of pace.
  // `pricier-on-pace` costs 2x as much but its lane is `on` pace. This is
  // engineered so `objective: "cost-per-accepted-card"` would rank
  // `cheap-ahead` first no matter what order it's handed — the only thing
  // that can stop it winning is the ahead-of-line slot throttle being
  // re-applied AFTER objective reordering, exactly as documented in
  // select.ts's `pickWinnerIndex` comment.
  function paceVerdict(overrides: Partial<LanePaceVerdict> = {}): LanePaceVerdict {
    return {
      laneId: "lane-ahead",
      observedAt: "2026-09-10T12:00:00.000Z",
      state: "ahead",
      serviceable: true,
      score: { utilization: 0.9, elapsed: 0.5, deviation: 0 },
      accounts: [],
      knownAccountCount: 1,
      knownWeight: 1,
      serviceableAccountCount: 1,
      urgentResetAt: null,
      reason: "ok",
      ...overrides,
    };
  }

  const t1 = MODELS.find((entry) => entry.tier === "T1")!;
  const cheapAhead = model(t1, { id: "cheap-ahead", laneId: "lane-ahead" });
  const pricierOnPace = model(t1, {
    id: "pricier-on-pace",
    laneId: "lane-on",
    costPerMTokIn: t1.costPerMTokIn * 2,
    costPerMTokOut: t1.costPerMTokOut * 2,
    costPerMTokCacheRead: t1.costPerMTokCacheRead * 2,
  });

  const laneLedger: LaneLedger = {
    "lane-ahead": { laneId: "lane-ahead", fetchedAt: "t", error: null, verdict: paceVerdict({ laneId: "lane-ahead", state: "ahead" }) },
    "lane-on": { laneId: "lane-on", fetchedAt: "t", error: null, verdict: paceVerdict({ laneId: "lane-on", state: "on" }) },
  };

  const cardLedger: Record<string, CardLedgerEntry> = {
    "cheap-ahead:T1": {
      modelId: "cheap-ahead",
      tier: "T1",
      cardsClosed: 40,
      acceptRate: 0.95,
      costPerCard: 1,
      runsPerCard: 1,
      foreignRunShare: 0,
      costPerAcceptedCard: 1,
      pending: false,
    },
    "pricier-on-pace:T1": {
      modelId: "pricier-on-pace",
      tier: "T1",
      cardsClosed: 40,
      acceptRate: 0.95,
      costPerCard: 5,
      runsPerCard: 1,
      foreignRunShare: 0,
      costPerAcceptedCard: 5,
      pending: false,
    },
  };

  function composedDecision() {
    return selectModel({
      ...base,
      descriptor: { issueId: "pace-objective-composition-1", labelNames: ["tier:T1"] },
      config: config({
        models: [cheapAhead, pricierOnPace],
        enforcementEnabled: true,
        pacingMode: "enforce",
        laneLedger,
        slotFloorFraction: 0,
        objective: "cost-per-accepted-card",
      }),
      cardLedger,
    });
  }

  it("re-applies the ahead-of-line slot throttle over the objective-reordered array, so a throttled-ahead lane cannot win by objective alone", () => {
    const decision = composedDecision();
    expect(decision.candidates.map((c) => c.modelId)).toEqual(["cheap-ahead", "pricier-on-pace"]);
    expect(decision.modelId).toBe("pricier-on-pace");
  });

  it("computes pacingApplied against the pace-only winner, independent of the objective's effect", () => {
    const decision = composedDecision();
    expect(decision.pacingApplied).toBe(true);
  });

  it("keeps shadowDiff comparing against the true list-price winner, unaffected by pacing or objective", () => {
    const decision = composedDecision();
    expect(decision.shadowDiff).not.toBeNull();
    expect(decision.shadowDiff?.listPriceWinner).toBe("cheap-ahead");
    expect(decision.shadowDiff?.costPerAcceptedCardWinner).toBe("cheap-ahead");
    expect(decision.shadowDiff?.agree).toBe(true);
  });
});
