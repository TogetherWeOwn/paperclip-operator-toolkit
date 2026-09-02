import { describe, expect, it } from "vitest";

import { selectModel } from "../src/engine/select.js";
import type { VolumeProfile } from "../src/engine/types.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };

describe("selection", () => {
  it("picks the cheapest model that clears the gates at the judged tier", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config(),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("cliproxy/claude-haiku-4-5-20251001");
    expect(decision.effectiveTier).toBe("T1");
  });

  it("never selects below the tier a capability exclusion forces", () => {
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "i1",
        labelNames: ["tier:T1"],
        exclusion: { excluded: true, reasons: ["rotates a credential"] },
      },
      config: config(),
    });
    expect(decision.judgement.source).toBe("capability-exclusion");
    expect(decision.modelId).toBe("claude-opus-5");
  });

  it("declines the sticky model when it sits below a capability floor", () => {
    // Sticky is a cost preference: it protects the warm prompt cache. A
    // capability exclusion is a safety constraint. When they conflict the
    // constraint wins, even though yielding would have been cheaper.
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "i1",
        labelNames: ["tier:T1"],
        stickyModelId: "cliproxy/claude-haiku-4-5-20251001",
        exclusion: { excluded: true, reasons: ["writes fleet config"] },
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

  it("emits a tier-floor rejection for every model below an exclusion floor", () => {
    const decision = selectModel({
      ...base,
      descriptor: {
        issueId: "i1",
        labelNames: ["tier:T1"],
        exclusion: { excluded: true, reasons: ["spends money"] },
      },
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

  it("lifts the ceiling when nothing at or below the judged tier is capable", () => {
    // A cost preference must never silently drop a hard capability requirement.
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], requiredCapabilities: ["vision"] },
      config: config(),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.trace.some((line) => line.includes("lifted"))).toBe(true);
  });

  it("keeps the model already running the issue rather than resetting its cache", () => {
    // A mid-issue switch fires shouldResetTaskSessionForModelChange and throws
    // away the warm prompt cache — the largest cost line we have.
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], stickyModelId: "claude-opus-5" },
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

  it("skips a disabled model and falls to the next cheapest", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T2"] },
      config: config({
        models: MODELS.map((m) => (m.tier === "T1" ? { ...m, enabled: false } : m)),
      }),
    });
    expect(decision.modelId).toBe("claude-sonnet-5");
    expect(decision.rejections.some((r) => r.stage === "disabled")).toBe(true);
  });

  it("records a trace line for every decision it makes", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config(),
    });
    expect(decision.trace.length).toBeGreaterThanOrEqual(3);
    expect(decision.trace[0]).toContain("tier T1 via issue-label");
    // Assert the cost basis is recorded SOMEWHERE in the trace, not at a fixed
    // index. Advisory mode appends its own note last, so pinning this to
    // `.at(-1)` tests the line order rather than the thing we care about.
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

  it("prefers the more capable tier when expected costs tie", () => {
    const twins = [
      { ...MODELS[0]!, id: "twin-cheap-t1", tier: "T1" as const },
      { ...MODELS[0]!, id: "twin-cheap-t2", tier: "T2" as const },
    ];
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T2"] },
      config: config({ models: twins }),
    });
    expect(decision.modelId).toBe("twin-cheap-t2");
  });
});
