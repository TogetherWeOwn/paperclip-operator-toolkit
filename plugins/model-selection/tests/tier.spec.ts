import { describe, expect, it } from "vitest";

import { resolveTier, tierFromLabels, tierOfModel } from "../src/engine/tier.js";
import { MODELS } from "./fixtures.js";

describe("tier judgement is recorded, never inferred", () => {
  it("forces T1 on a capability exclusion, ahead of every other signal", () => {
    // The exclusion is checked FIRST and overrides a mechanical label and a
    // mechanical pin alike. ADR-0004: a mechanically trivial config edit is
    // excluded because the constraint is the safety property, not difficulty.
    const judgement = resolveTier(
      {
        issueId: "i1",
        exclusion: { excluded: true, reasons: ["touches fleet config"] },
        labelNames: ["tier:T3"],
        pinnedModelId: "cliproxy/claude-haiku-4-5-20251001",
        agentFloorModelId: "claude-sonnet-5",
      },
      MODELS,
      "T1",
    );
    expect(judgement.tier).toBe("T1");
    expect(judgement.source).toBe("capability-exclusion");
    expect(judgement.detail).toContain("fleet config");
  });

  it("prefers an explicit issue override over a label", () => {
    const judgement = resolveTier(
      { issueId: "i1", labelNames: ["tier:T1"], pinnedModelId: "claude-sonnet-5" },
      MODELS,
      "T1",
    );
    expect(judgement.tier).toBe("T2");
    expect(judgement.source).toBe("issue-override");
  });

  it("uses the tier label when there is no override", () => {
    const judgement = resolveTier({ issueId: "i1", labelNames: ["bug", "tier:T1"] }, MODELS, "T3");
    expect(judgement.tier).toBe("T1");
    expect(judgement.source).toBe("issue-label");
  });

  it("falls back to the agent floor — a missing label is not a missing decision", () => {
    const judgement = resolveTier(
      { issueId: "i1", labelNames: ["bug"], agentFloorModelId: "claude-sonnet-5" },
      MODELS,
      "T1",
    );
    expect(judgement.tier).toBe("T2");
    expect(judgement.source).toBe("agent-floor");
  });

  it("falls back to the config default when even the floor is unrecognised", () => {
    const judgement = resolveTier({ issueId: "i1", agentFloorModelId: "some-retired-model" }, MODELS, "T3");
    expect(judgement.tier).toBe("T3");
    expect(judgement.source).toBe("config-default");
  });

  it("takes the most capable tier when an issue carries conflicting labels", () => {
    // Two tier labels is a labelling error, not a judgement. Resolve it in the
    // conservative direction rather than arbitrarily.
    expect(tierFromLabels(["tier:T1", "tier:T3"])).toBe("T1");
  });

  it("ignores label names that are not a real tier", () => {
    expect(tierFromLabels(["tier:cheap", "tier:", "priority:T1"])).toBeNull();
  });

  it("does not resolve a tier from an unconfigured model id", () => {
    expect(tierOfModel("claude-sonnet-4-6", MODELS)).toBeNull();
  });
});
