import { describe, expect, it } from "vitest";

import { assembleAdditiveConfig } from "../scripts/assemble-additive-config.mjs";

const pacing = {
  mode: "shadow",
  lanes: [
    {
      laneId: "cliproxy-claude",
      statusUrl: "https://status.example/claude",
      apiKeySecretRef: { type: "secret_ref", secretId: "secret-claude" },
      windows: [{ name: "primary", role: "serviceability", utilizationFields: ["used"] }],
    },
    {
      laneId: "cliproxy-codex",
      statusUrl: "https://status.example/codex",
      apiKeySecretRef: { type: "secret_ref", secretId: "secret-codex" },
      windows: [{ name: "primary", role: "serviceability", utilizationFields: ["used"] }],
    },
    {
      laneId: "cliproxy-kimi",
      statusUrl: "https://status.example/kimi",
      apiKeySecretRef: { type: "secret_ref", secretId: "secret-kimi" },
      windows: [{ name: "primary", role: "serviceability", utilizationFields: ["used"] }],
    },
    {
      laneId: "cliproxy-opencode-go",
      statusUrl: "https://status.example/go",
      apiKeySecretRef: { type: "secret_ref", secretId: "secret-go" },
      windows: [{ name: "primary", role: "serviceability", utilizationFields: ["used"] }],
    },
  ],
};

function model(id: string, tier: "T1" | "T2" | "T3", enabled = true) {
  return { id, tier, enabled };
}

describe("additive model-selection config assembly", () => {
  it("canonicalises ids while preserving live lanes and the full pacing object", () => {
    const live = {
      selection: { mode: "shadow" },
      models: [
        { ...model("cliproxy/claude-opus-5", "T1"), laneId: "cliproxy-claude" },
        { ...model("cliproxy/gpt-5.6-sol", "T2"), laneId: "cliproxy-codex" },
      ],
      pacing,
    };
    const roster = {
      selection: { mode: "advise" },
      models: [
        model("claude-opus-5", "T1"),
        model("gpt-5.6-sol", "T2"),
        model("kimi-k3-go", "T2", false),
        model("deepseek-v4-pro", "T3"),
      ],
    };

    const result = assembleAdditiveConfig(roster, live, { minimumLaneBoundModels: 2 });

    expect(result.config.pacing).toEqual(pacing);
    expect(result.config.selection).toEqual({ mode: "advise" });
    expect(result.config.models).toEqual([
      { ...model("claude-opus-5", "T1"), laneId: "cliproxy-claude" },
      { ...model("gpt-5.6-sol", "T2"), laneId: "cliproxy-codex" },
      { ...model("kimi-k3-go", "T2", false), laneId: "cliproxy-kimi" },
      { ...model("deepseek-v4-pro", "T3"), laneId: "cliproxy-opencode-go" },
    ]);
    expect(result.counts).toMatchObject({
      preservedLaneBindings: 2,
      inferredLaneBindings: 2,
      enabledWithoutLane: [],
      artifactAfter: { models: 4, enabled: 3, withLaneId: 4, pacingLanes: 4 },
    });
  });

  it("retains live-only rows instead of replacing the live config", () => {
    const result = assembleAdditiveConfig(
      { models: [model("claude-opus-5", "T1")] },
      {
        models: [
          { ...model("cliproxy/claude-opus-5", "T1"), laneId: "cliproxy-claude" },
          { ...model("cliproxy/claude-opus-4-8", "T1", false), laneId: "cliproxy-claude" },
        ],
        pacing,
      },
      { minimumLaneBoundModels: 2 },
    );

    expect(result.config.models).toContainEqual({
      ...model("claude-opus-4-8", "T1", false),
      laneId: "cliproxy-claude",
    });
    expect(result.config.models.every((entry: { id: string }) => !entry.id.startsWith("cliproxy/"))).toBe(
      true,
    );
  });

  it("rejects enabled provider-qualified rows when no matching pacing lane exists", () => {
    expect(() =>
      assembleAdditiveConfig(
        { models: [model("zai/glm-5.3", "T2")] },
        { models: [], pacing },
        { minimumLaneBoundModels: 0 },
      ),
    ).toThrow("enabled models outside pacing lanes: zai/glm-5.3:T2");
  });

  it("allows an unlaned provider-qualified row only while disabled", () => {
    const result = assembleAdditiveConfig(
      { models: [model("zai/glm-5.3", "T2", false)] },
      { models: [], pacing },
      { minimumLaneBoundModels: 0 },
    );

    expect(result.config.models).toEqual([model("zai/glm-5.3", "T2", false)]);
    expect(result.counts.enabledWithoutLane).toEqual([]);
  });

  it("blocks a lane-count regression", () => {
    expect(() =>
      assembleAdditiveConfig(
        { models: [model("openrouter/auto", "T3", false)] },
        { models: [], pacing },
        { minimumLaneBoundModels: 25 },
      ),
    ).toThrow("lane-bound models; minimum is 25");
  });

  it("rejects canonical duplicates before writing an artifact", () => {
    expect(() =>
      assembleAdditiveConfig(
        {
          models: [model("glm-5.3", "T2"), model("cliproxy/glm-5.3", "T2")],
        },
        { models: [], pacing },
        { minimumLaneBoundModels: 0 },
      ),
    ).toThrow("duplicate canonical model+tier row: glm-5.3 T2");
  });
});
