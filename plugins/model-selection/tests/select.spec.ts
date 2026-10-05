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
    ledger[laneId] = { laneId, verdict: unserviceableVerdict(laneId), fetchedAt: NOW.toString(), error: null, observation: null };
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
    expect(decision.modelId).toBe("claude-haiku-4-5-20251001");
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
        stickyModelId: "claude-haiku-4-5-20251001",
      },
      config: config(),
    });
    expect(decision.modelId).toBe("claude-opus-5");
    expect(
      decision.rejections.some(
        (r) => r.stage === "tier-floor" && r.modelId === "claude-haiku-4-5-20251001",
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
    expect(floored).toContain("claude-haiku-4-5-20251001");
    expect(floored).toContain("claude-sonnet-5");
    expect(floored).not.toContain("claude-opus-5");
  });

  it("records the gate that actually rejected a candidate, not another one that also applies", () => {
    // acceptance: `flaky` is BOTH disabled in the roster AND sitting
    // on a lane the pace ledger reports unserviceable — either fact alone
    // would explain a rejection, and 's by-hand reconstruction from
    // roster shape (which cannot see the `continue` order below) could
    // plausibly have picked either. `select.ts` checks `!model.enabled`
    // first and `continue`s immediately, so `lane-unserviceable` is never
    // even evaluated for this model — the correct recorded gate is
    // `disabled`. A wrong-but-populated `lane-unserviceable` explanation
    // must fail this assertion.
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const flaky = model(t1, { id: "flaky", enabled: false, laneId: "dead-lane" });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({ models: [flaky, t1], laneLedger: ledgerWith("dead-lane"), pacingMode: "enforce" }),
    });
    const rejection = decision.rejections.find((r) => r.modelId === "flaky");
    expect(rejection).toEqual({
      modelId: "flaky",
      stage: "disabled",
      reason: "disabled in the roster",
      operand: { kind: "disabled" },
    });
  });

  it("skips a cheaper model whose context window is below the issue estimate", () => {
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const narrow = model(t1, {
      id: "narrow-cheap",
      contextWindow: 200_000,
      costPerMTokIn: 0.1,
      costPerMTokOut: 0.1,
      costPerMTokCacheRead: 0.1,
    });
    const wide = model(t1, { id: "wide", contextWindow: 1_000_000 });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], requiredContextTokens: 202_741 },
      config: config({ models: [narrow, wide] }),
    });

    expect(decision.modelId).toBe("wide");
    expect(decision.rejections).toContainEqual({
      modelId: "narrow-cheap",
      stage: "context-window",
      reason: "context window 200000 < required 202741",
      operand: { kind: "context-window", contextWindow: 200_000, requiredContextTokens: 202_741 },
    });
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

  it("declines a sticky model that no longer fits the issue context", () => {
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const narrow = model(t1, { id: "narrow-sticky", contextWindow: 200_000 });
    const wide = model(t1, { id: "wide-fallback", contextWindow: 1_000_000 });
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "i1",
        labelNames: ["tier:T1"],
        stickyModelId: narrow.id,
        requiredContextTokens: 202_741,
      },
      config: config({ models: [narrow, wide] }),
    });

    expect(decision.modelId).toBe(wide.id);
    expect(decision.rejections).toContainEqual({
      modelId: narrow.id,
      stage: "context-window",
      reason: "context window 200000 < required 202741",
      operand: { kind: "context-window", contextWindow: 200_000, requiredContextTokens: 202_741 },
    });
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

  it("keeps a legacy OmniRoute-wrapped sticky pin but returns the direct runtime id", () => {
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "i1",
        labelNames: ["tier:T3"],
        stickyModelId: "cliproxy/claude-opus-5",
      },
      config: config(),
    });
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.trace.some((line) => line.includes("sticky"))).toBe(true);
  });

  it("normalizes a legacy OmniRoute-wrapped operator override to a non-default direct runtime id", () => {
    const t1 = MODELS.find((entry) => entry.tier === "T1")!;
    const cheaper = model(t1, { id: "cheaper-default", costPerMTokIn: 1 });
    const overridden = model(t1, { id: "overridden-model", costPerMTokIn: 10 });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({
        models: [cheaper, overridden],
        enforcementEnabled: true,
        pacingMode: "enforce",
        operatorOverrideModelId: "cliproxy/overridden-model",
      }),
    });
    expect(decision.candidates[0]?.modelId).toBe("cheaper-default");
    expect(decision.modelId).toBe("overridden-model");
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

  it(": writes an explicit pin instead of holding at floor when the floor's own lane is dead", () => {
    const floor = model(MODELS.find((m) => m.tier === "T3")!, {
      id: "gpt-5.6-sol",
      laneId: "sol-lane",
    });
    const thin: VolumeProfile[] = PROFILES.map((p) => ({ ...p, sampleCount: 1 }));
    const decision = selectModel({
      ...base,
      profiles: thin,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], agentFloorModelId: "gpt-5.6-sol" },
      config: config({
        models: [...MODELS, floor],
        pacingMode: "enforce",
        laneLedger: ledgerWith("sol-lane"),
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.trace.some((line) => line.includes("held-at-floor declined"))).toBe(true);
  });

  it(": still holds at floor, unchanged, when the floor's lane is healthy", () => {
    const floor = model(MODELS.find((m) => m.tier === "T3")!, {
      id: "gpt-5.6-sol",
      laneId: "sol-lane",
    });
    const thin: VolumeProfile[] = PROFILES.map((p) => ({ ...p, sampleCount: 1 }));
    const decision = selectModel({
      ...base,
      profiles: thin,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], agentFloorModelId: "gpt-5.6-sol" },
      config: config({
        models: [...MODELS, floor],
        pacingMode: "enforce",
        laneLedger: {},
      }),
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

  it(": same-price-family rule prefers the newer release for a same-price sibling pair", () => {
    const t2 = MODELS.find((entry) => entry.tier === "T2")!;
    const older = model(t2, { id: "vendor-model-4-8", releasedAt: "2026-05-05" });
    const newer = model(t2, { id: "vendor-model-5", releasedAt: "2026-06-24" });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T2"] },
      config: config({ models: [older, newer] }),
    });
    expect(decision.modelId).toBe("vendor-model-5");
  });

  it(": a provenBetter earn-in verdict lets the older same-price-family model win", () => {
    const t2 = MODELS.find((entry) => entry.tier === "T2")!;
    const older = model(t2, {
      id: "vendor-model-4-8",
      releasedAt: "2026-05-05",
      earnIn: { verdict: "provenBetter" },
    });
    const newer = model(t2, { id: "vendor-model-5", releasedAt: "2026-06-24" });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T2"] },
      config: config({ models: [older, newer] }),
    });
    expect(decision.modelId).toBe("vendor-model-4-8");
  });

  describe(" Defect 2: tier-exhaustion escalation", () => {
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
          observation: null,
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

  describe(" Defect 6: a pin or sticky model cannot hard-bypass capacity routing", () => {
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

describe("pace-vs-objective composition", () => {
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
    "lane-ahead": { laneId: "lane-ahead", fetchedAt: "t", error: null, observation: null, verdict: paceVerdict({ laneId: "lane-ahead", state: "ahead" }) },
    "lane-on": { laneId: "lane-on", fetchedAt: "t", error: null, observation: null, verdict: paceVerdict({ laneId: "lane-on", state: "on" }) },
  };

  const cardLedger: Record<string, CardLedgerEntry> = {
    "cheap-ahead:T1": {
      modelId: "cheap-ahead",
      tier: "T1",
      cardsClosed: 40,
      cardsResolved: 40,
      cardsAccepted: 38,
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
      cardsResolved: 40,
      cardsAccepted: 38,
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

describe("lane avoid + lane outage gating", () => {
  const t1 = MODELS.find((entry) => entry.tier === "T1")!;
  const avoidedModel = model(t1, { id: "avoided-model", laneId: "codex" });
  const fallbackModel = model(t1, { id: "fallback-model", laneId: "lane-fresh" });

  function laneVerdict(overrides: Partial<LanePaceVerdict> = {}): LanePaceVerdict {
    return {
      laneId: "codex",
      observedAt: "2026-09-10T12:00:00.000Z",
      state: "on",
      serviceable: true,
      score: { utilization: 0.85, elapsed: 0.5, deviation: 0.35 },
      accounts: [],
      knownAccountCount: 1,
      knownWeight: 1,
      serviceableAccountCount: 1,
      urgentResetAt: null,
      reason: "ok",
      ...overrides,
    };
  }

  it("excludes a model whose lane is at or above its avoid threshold (default 0.8), even while serviceable", () => {
    const laneLedger: LaneLedger = {
      codex: { laneId: "codex", fetchedAt: "t", error: null, observation: null, verdict: laneVerdict() },
    };
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "lane-avoid-1", labelNames: ["tier:T1"] },
      config: config({
        models: [avoidedModel, fallbackModel],
        pacingMode: "enforce",
        laneLedger,
        laneAvoidConfig: { defaultThreshold: 0.8, perLane: {} },
      }),
    });
    expect(decision.modelId).toBe("fallback-model");
    expect(
      decision.rejections.some((r) => r.stage === "lane-avoid" && r.modelId === "avoided-model"),
    ).toBe(true);
  });

  it("admits a threshold-reaching lane behind pace near reset without bypassing tier floors", () => {
    const belowTier = model(MODELS.find((entry) => entry.tier === "T2")!, { id: "below-tier", laneId: "codex" });
    const laneLedger: LaneLedger = {
      codex: { laneId: "codex", fetchedAt: "t", error: null, observation: null, verdict: laneVerdict({ state: "behind", score: { utilization: 0.75, elapsed: 0.83, deviation: -0.08 } }) },
    };
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "lane-near-reset", labelNames: ["tier:T1"] },
      config: config({
        models: [belowTier, fallbackModel, avoidedModel],
        pacingMode: "enforce",
        laneLedger,
        laneAvoidConfig: { defaultThreshold: 0.75, perLane: {} },
      }),
    });
    expect(decision.modelId).toBe("avoided-model");
    expect(decision.rejections.some((r) => r.stage === "lane-avoid")).toBe(false);
    expect(decision.rejections.some((r) => r.stage === "tier-floor" && r.modelId === "below-tier")).toBe(true);
  });

  it("keeps exhaustion a hard stop even when the lane is not ahead of pace", () => {
    const laneLedger: LaneLedger = {
      codex: { laneId: "codex", fetchedAt: "t", error: null, observation: null, verdict: laneVerdict({ state: "exhausted", serviceable: false, score: { utilization: 1, elapsed: 1, deviation: 0 } }) },
    };
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "lane-exhausted-at-reset", labelNames: ["tier:T1"] },
      config: config({ models: [avoidedModel, fallbackModel], pacingMode: "enforce", laneLedger, laneAvoidConfig: { defaultThreshold: 0.75, perLane: {} } }),
    });
    expect(decision.modelId).toBe("fallback-model");
    expect(decision.rejections.some((r) => r.stage === "lane-unserviceable" && r.modelId === "avoided-model")).toBe(true);
  });

  it("2026-09-07 07:12Z owner rule: codex's own AVOID_LANE=0.99 keeps it admitted at 0.85 where the generic 0.8 threshold would have excluded it", () => {
    const laneLedger: LaneLedger = {
      codex: { laneId: "codex", fetchedAt: "t", error: null, observation: null, verdict: laneVerdict() },
    };
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "lane-avoid-2", labelNames: ["tier:T1"] },
      config: config({
        models: [avoidedModel, fallbackModel],
        pacingMode: "enforce",
        laneLedger,
        laneAvoidConfig: { defaultThreshold: 0.8, perLane: { codex: 0.99 } },
      }),
    });
    expect(decision.modelId).toBe("avoided-model");
    expect(decision.rejections.some((r) => r.stage === "lane-avoid")).toBe(false);
  });

  it("2026-09-07 06:40Z owner note: an operator-declared lane outage excludes a model even though telemetry reports it healthy", () => {
    const laneLedger: LaneLedger = {
      codex: { laneId: "codex", fetchedAt: "t", error: null, observation: null, verdict: laneVerdict({ score: { utilization: 0.1, elapsed: 0.1, deviation: 0 } }) },
    };
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "lane-outage-1", labelNames: ["tier:T1"] },
      config: config({
        models: [avoidedModel, fallbackModel],
        pacingMode: "enforce",
        laneLedger,
        laneOutageOverride: { lanes: ["codex"], models: [], until: "2026-09-11T00:00:00.000Z" },
      }),
    });
    expect(decision.modelId).toBe("fallback-model");
    expect(
      decision.rejections.some((r) => r.stage === "lane-outage" && r.modelId === "avoided-model"),
    ).toBe(true);
  });

  it("an expired lane outage override excludes nothing", () => {
    const laneLedger: LaneLedger = {
      codex: { laneId: "codex", fetchedAt: "t", error: null, observation: null, verdict: laneVerdict({ score: { utilization: 0.1, elapsed: 0.1, deviation: 0 } }) },
    };
    const decision = selectModel({
      ...base,
      now: Date.parse("2026-09-10T12:00:00.000Z"),
      descriptor: { issueId: "lane-outage-2", labelNames: ["tier:T1"] },
      config: config({
        models: [avoidedModel, fallbackModel],
        pacingMode: "enforce",
        laneLedger,
        laneOutageOverride: { lanes: ["codex"], models: [], until: "2026-09-09T00:00:00.000Z" },
      }),
    });
    expect(decision.rejections.some((r) => r.stage === "lane-outage")).toBe(false);
  });

  it("both gates are skipped entirely when pacing is off, matching the pre-2137/pre-2481 engine", () => {
    const laneLedger: LaneLedger = {
      codex: { laneId: "codex", fetchedAt: "t", error: null, observation: null, verdict: laneVerdict() },
    };
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "lane-avoid-off", labelNames: ["tier:T1"] },
      config: config({
        models: [avoidedModel, fallbackModel],
        pacingMode: "off",
        laneLedger,
        laneAvoidConfig: { defaultThreshold: 0.8, perLane: {} },
        laneOutageOverride: { lanes: ["codex"], models: [], until: "2026-09-11T00:00:00.000Z" },
      }),
    });
    expect(decision.rejections.some((r) => r.stage === "lane-avoid" || r.stage === "lane-outage")).toBe(false);
  });
});

describe("lane-has-room gating)", () => {
  const t1 = MODELS.find((entry) => entry.tier === "T1")!;
  const goModel = model(t1, { id: "go-model", laneId: "opencode-go", costPerMTokIn: 0.5, costPerMTokOut: 0.5 });

  function laneRoom(overrides: Partial<NonNullable<Parameters<typeof config>[0]>["laneRoom"]> = {}) {
    return {
      capPerAccount: { "opencode-go": 2 },
      activePinsWeightByLane: {},
      fiveHourWindowName: "five_hour",
      zaiLaneId: "zai",
      zaiWeeklyWindowName: "weekly",
      zaiWeeklyDefaultMargin: 0.15,
      zaiPaceOverrideMargin: null,
      now: NOW,
      ...overrides,
    };
  }

  it("2026-09-06 17:1xZ / 2026-09-06 23:5xZ owner rule: excludes a model whose lane is at its per-account active-card cap", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "lane-room-1", labelNames: ["tier:T1"] },
      config: config({
        models: [goModel, t1],
        pacingMode: "enforce",
        laneRoom: laneRoom({ activePinsWeightByLane: { "opencode-go": 2 } }),
      }),
    });
    expect(decision.modelId).toBe(t1.id);
    expect(
      decision.rejections.some((r) => r.stage === "lane-no-room" && r.modelId === goModel.id),
    ).toBe(true);
  });

  it("admits a model whose lane is still under its per-account cap", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "lane-room-2", labelNames: ["tier:T1"] },
      config: config({
        models: [goModel, t1],
        pacingMode: "enforce",
        laneRoom: laneRoom({ activePinsWeightByLane: { "opencode-go": 1 } }),
      }),
    });
    expect(decision.modelId).toBe(goModel.id);
    expect(decision.rejections.some((r) => r.stage === "lane-no-room")).toBe(false);
  });

  it("is skipped entirely when laneRoom is not configured (fail-open)", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "lane-room-3", labelNames: ["tier:T1"] },
      config: config({ models: [goModel, t1], pacingMode: "enforce" }),
    });
    expect(decision.rejections.some((r) => r.stage === "lane-no-room")).toBe(false);
  });
});

describe("T1 stays off opencode-go unless codex is at/over its avoid threshold (2026-09-07 03:15Z owner rule)", () => {
  const t1 = MODELS.find((entry) => entry.tier === "T1")!;
  const t2 = MODELS.find((entry) => entry.tier === "T2")!;
  const goModel = model(t1, { id: "go-model-t1", laneId: "opencode-go", costPerMTokIn: 0.5, costPerMTokOut: 0.5 });
  const codexModel = model(t1, { id: "codex-model", laneId: "codex", costPerMTokIn: 10, costPerMTokOut: 10 });

  function codexLedger(utilization: number): LaneLedger {
    return {
      codex: {
        laneId: "codex",
        fetchedAt: "t",
        error: null,
        observation: null,
        verdict: {
          laneId: "codex",
          observedAt: "2026-09-07T03:15:00.000Z",
          state: "on",
          serviceable: true,
          score: { utilization, elapsed: 0.5, deviation: utilization - 0.5 },
          accounts: [],
          knownAccountCount: 1,
          knownWeight: 1,
          serviceableAccountCount: 1,
          urgentResetAt: null,
          reason: "ok",
        },
      },
    };
  }

  it("excludes T1 from opencode-go while codex still has room below the avoid threshold", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "go-fallback-1", labelNames: ["tier:T1"] },
      config: config({
        models: [goModel, codexModel],
        pacingMode: "enforce",
        laneLedger: codexLedger(0.5),
        laneAvoidConfig: { defaultThreshold: 0.8, perLane: {} },
        codexLaneId: "codex",
        opencodeGoLaneId: "opencode-go",
      }),
    });
    expect(decision.modelId).toBe(codexModel.id);
    const rejection = decision.rejections.find((r) => r.modelId === goModel.id && r.stage === "lane-avoid");
    expect(rejection?.reason).toContain("Go fallback only");
  });

  it("admits T1 onto opencode-go once codex is at/over its own avoid threshold", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "go-fallback-2", labelNames: ["tier:T1"] },
      config: config({
        models: [goModel, codexModel],
        pacingMode: "enforce",
        laneLedger: codexLedger(0.85),
        laneAvoidConfig: { defaultThreshold: 0.8, perLane: {} },
        codexLaneId: "codex",
        opencodeGoLaneId: "opencode-go",
      }),
    });
    expect(decision.modelId).toBe(goModel.id);
    expect(
      decision.rejections.some((r) => r.modelId === goModel.id && r.reason.includes("Go fallback only")),
    ).toBe(false);
    // Codex is above threshold AND ahead of its governing window's midpoint.
    expect(decision.rejections.some((r) => r.modelId === codexModel.id && r.stage === "lane-avoid")).toBe(true);
  });

  it("does not apply the T1-only rule to T2, which keeps using Go under the cap/5h rule alone", () => {
    const sonnetGo = model(t2, { id: "sonnet-go", laneId: "opencode-go" });
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "go-fallback-3", labelNames: ["tier:T2"] },
      config: config({
        models: [sonnetGo],
        pacingMode: "enforce",
        laneLedger: codexLedger(0.5),
        laneAvoidConfig: { defaultThreshold: 0.8, perLane: {} },
      }),
    });
    expect(decision.modelId).toBe(sonnetGo.id);
    expect(decision.rejections.some((r) => r.reason.includes("Go fallback only"))).toBe(false);
  });
});

describe("long-turn engineering agents stay off zai while codex has room (2026-09-08 22:15Z owner rule)", () => {
  const t1 = MODELS.find((entry) => entry.tier === "T1")!;
  const zaiModel = model(t1, { id: "zai-model", laneId: "zai", costPerMTokIn: 0.5, costPerMTokOut: 0.5 });
  const codexModel = model(t1, { id: "codex-model-2", laneId: "codex", costPerMTokIn: 10, costPerMTokOut: 10 });

  function codexLedger(utilization: number): LaneLedger {
    // Both lanes get an explicit `"on"` verdict so pace ordering (which sorts
    // by pace-state rank before cost) ties between them and cost decides —
    // isolating what this test actually checks (the ZAI_LONG_RUN_AGENTS
    // exclusion rule) from an unrelated "zai never polled -> unknown -> sorts
    // after codex" pace-ordering artifact.
    return {
      codex: {
        laneId: "codex",
        fetchedAt: "t",
        error: null,
        observation: null,
        verdict: {
          laneId: "codex",
          observedAt: "2026-09-08T22:15:00.000Z",
          state: "on",
          serviceable: true,
          score: { utilization, elapsed: 0.5, deviation: 0 },
          accounts: [],
          knownAccountCount: 1,
          knownWeight: 1,
          serviceableAccountCount: 1,
          urgentResetAt: null,
          reason: "ok",
        },
      },
      zai: {
        laneId: "zai",
        fetchedAt: "t",
        error: null,
        observation: null,
        verdict: {
          laneId: "zai",
          observedAt: "2026-09-08T22:15:00.000Z",
          state: "on",
          serviceable: true,
          score: { utilization: 0.3, elapsed: 0.5, deviation: 0 },
          accounts: [],
          knownAccountCount: 1,
          knownWeight: 1,
          serviceableAccountCount: 1,
          urgentResetAt: null,
          reason: "ok",
        },
      },
    };
  }

  it("routes a named long-turn agent off zai onto codex when codex has room", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "zai-long-run-1", labelNames: ["tier:T1"], agentName: "Founding Engineer" },
      config: config({
        models: [zaiModel, codexModel],
        pacingMode: "enforce",
        laneLedger: codexLedger(0.3),
        laneAvoidConfig: { defaultThreshold: 0.8, perLane: {} },
        codexLaneId: "codex",
        zaiLaneId: "zai",
      }),
    });
    expect(decision.modelId).toBe(codexModel.id);
    const rejection = decision.rejections.find((r) => r.modelId === zaiModel.id && r.stage === "lane-avoid");
    expect(rejection?.reason).toContain("Founding Engineer");
    expect(rejection?.reason).toContain("1214");
  });

  it("leaves zai available for an agent name outside ZAI_LONG_RUN_AGENTS", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "zai-long-run-2", labelNames: ["tier:T1"], agentName: "QA Reviewer" },
      config: config({
        models: [zaiModel, codexModel],
        pacingMode: "enforce",
        laneLedger: codexLedger(0.3),
        laneAvoidConfig: { defaultThreshold: 0.8, perLane: {} },
      }),
    });
    expect(decision.modelId).toBe(zaiModel.id);
  });

  it("leaves zai available for a named agent when no codex lane is enabled to take the work", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "zai-long-run-3", labelNames: ["tier:T1"], agentName: "Founding Engineer" },
      config: config({
        models: [zaiModel],
        pacingMode: "enforce",
        laneLedger: codexLedger(0.3),
        laneAvoidConfig: { defaultThreshold: 0.8, perLane: {} },
      }),
    });
    expect(decision.modelId).toBe(zaiModel.id);
  });

  it("leaves zai available for a named agent once codex is at/over its own avoid threshold (no room to redirect to)", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "zai-long-run-4", labelNames: ["tier:T1"], agentName: "Founding Engineer" },
      config: config({
        models: [zaiModel, codexModel],
        pacingMode: "enforce",
        laneLedger: codexLedger(0.85),
        laneAvoidConfig: { defaultThreshold: 0.8, perLane: {} },
      }),
    });
    expect(decision.modelId).toBe(zaiModel.id);
    expect(
      decision.rejections.some((r) => r.modelId === zaiModel.id && r.reason.includes("1214")),
    ).toBe(false);
  });
});

describe("wake-scoped floor", () => {
  it("lowers the required tier for a matching wake reason without touching the judged tier", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], wakeReason: "monitor" },
      config: config({
        wakeScopedFloor: { enabled: true, wakeReasons: ["monitor"], floorTier: "T3" },
      }),
    });
    expect(decision.modelId).toBe("claude-haiku-4-5-20251001");
    expect(decision.effectiveTier).toBe("T3");
    expect(decision.wakeScopedTier).toBe("T3");
    // The card's own judgement is completely untouched — this is what a
    // caller would write to the tier:* label/pin, and it never moves.
    expect(decision.judgement.tier).toBe("T1");
  });

  it("forces advisory even when enforcement is on, so a wake-scoped decision can never be written", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], wakeReason: "monitor" },
      config: config({
        enforcementEnabled: true,
        wakeScopedFloor: { enabled: true, wakeReasons: ["monitor"], floorTier: "T3" },
      }),
    });
    expect(decision.advisory).toBe(true);
  });

  it("does not lower the floor when the wake reason is not on the configured allowlist", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], wakeReason: "substantive_review" },
      config: config({
        enforcementEnabled: true,
        wakeScopedFloor: { enabled: true, wakeReasons: ["monitor"], floorTier: "T3" },
      }),
    });
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.wakeScopedTier).toBeNull();
    expect(decision.advisory).toBe(false);
  });

  it("does not lower the floor when descriptor.wakeReason is absent, even if configured", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({
        enforcementEnabled: true,
        wakeScopedFloor: { enabled: true, wakeReasons: ["monitor"], floorTier: "T3" },
      }),
    });
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.wakeScopedTier).toBeNull();
    expect(decision.advisory).toBe(false);
  });

  it("one-key rollback: wakeScopedFloor.enabled false restores byte-identical pre- behavior", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], wakeReason: "monitor" },
      config: config({
        enforcementEnabled: true,
        wakeScopedFloor: { enabled: false, wakeReasons: ["monitor"], floorTier: "T3" },
      }),
    });
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.wakeScopedTier).toBeNull();
    expect(decision.advisory).toBe(false);
  });

  it("never raises the floor: a floorTier at/above the judged tier is a no-op", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"], wakeReason: "monitor" },
      config: config({
        wakeScopedFloor: { enabled: true, wakeReasons: ["monitor"], floorTier: "T1" },
      }),
    });
    // Judged tier is already T3, the configured floor (T1) is more capable,
    // not less — must not upgrade the requirement either.
    expect(decision.modelId).toBe("claude-haiku-4-5-20251001");
    expect(decision.effectiveTier).toBe("T3");
    expect(decision.wakeScopedTier).toBeNull();
  });

  it("still escalates up the ladder from the lowered floor when nothing is costable there", () => {
    const t3Model = MODELS.find((entry) => entry.tier === "T3")!;
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], wakeReason: "monitor" },
      config: config({
        // No T3 roster row at all — the wake-scoped floor has nothing to land
        // on and must climb the ladder exactly like an ordinary decision.
        models: MODELS.filter((entry) => entry.id !== t3Model.id),
        wakeScopedFloor: { enabled: true, wakeReasons: ["monitor"], floorTier: "T3" },
      }),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.effectiveTier).toBe("T2");
    expect(decision.escalatedFromTier).toBe("T3");
  });

  it("sticky within issue is gated against the lowered wake-scoped floor, not the judged tier", () => {
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "i1",
        labelNames: ["tier:T1"],
        stickyModelId: "claude-haiku-4-5-20251001",
        wakeReason: "monitor",
      },
      config: config({
        stickyWithinIssue: true,
        wakeScopedFloor: { enabled: true, wakeReasons: ["monitor"], floorTier: "T3" },
      }),
    });
    // Without the wake-scoped floor, sticky would be declined for sitting
    // below the T1 required tier. With it lowered to T3, the T3 incumbent
    // now qualifies and sticky wins outright.
    expect(decision.modelId).toBe("claude-haiku-4-5-20251001");
    expect(decision.judgement.tier).toBe("T1");
  });
});
