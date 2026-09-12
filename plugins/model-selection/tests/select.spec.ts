import { describe, expect, it } from "vitest";

import { selectModel } from "../src/engine/select.js";
import type { ModelEntry, VolumeProfile } from "../src/engine/types.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };

function model(baseModel: ModelEntry, overrides: Partial<ModelEntry>): ModelEntry {
  return { ...baseModel, ...overrides };
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
});
