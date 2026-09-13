import { describe, expect, it } from "vitest";

import { ancillaryDriftForAgent, readAncillarySurfaces, recommendAncillaryModel } from "../src/engine/ancillary.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

const baseConfig = {
  models: MODELS,
  holdOnUntrustedProfile: true,
};

describe("recommendAncillaryModel", () => {
  it("recommends the cheapest T3 model through the same tier ladder as main dispatch", () => {
    const decision = recommendAncillaryModel({
      config: baseConfig,
      profiles: PROFILES,
      signals: NO_ESCALATION,
      now: NOW,
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("cliproxy/claude-haiku-4-5-20251001");
    expect(decision.effectiveTier).toBe("T3");
  });

  it("is always advisory regardless of what the caller passes", () => {
    const decision = recommendAncillaryModel({
      config: baseConfig,
      profiles: PROFILES,
      signals: NO_ESCALATION,
      now: NOW,
    });
    expect(decision.advisory).toBe(true);
  });

  it("holds rather than guesses when the T3 profile is untrusted", () => {
    const decision = recommendAncillaryModel({
      config: baseConfig,
      profiles: [],
      signals: NO_ESCALATION,
      now: NOW,
    });
    expect(decision.outcome).not.toBe("selected");
  });
});

describe("readAncillarySurfaces", () => {
  it("reads a plain string env binding", () => {
    const readings = readAncillarySurfaces({
      id: "a1",
      name: "Agent",
      adapterConfig: { env: { ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5-20251001" } },
      runtimeConfig: null,
    });
    expect(readings).toEqual([
      { surface: "ANTHROPIC_SMALL_FAST_MODEL", currentModelId: "claude-haiku-4-5-20251001", unresolvable: false },
    ]);
  });

  it("reads an explicit plain-type env binding", () => {
    const readings = readAncillarySurfaces({
      id: "a1",
      name: "Agent",
      adapterConfig: { env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: "plain", value: "claude-haiku-4-5-20251001" } } },
      runtimeConfig: null,
    });
    expect(readings).toEqual([
      { surface: "ANTHROPIC_DEFAULT_HAIKU_MODEL", currentModelId: "claude-haiku-4-5-20251001", unresolvable: false },
    ]);
  });

  it("marks a secret-bound env binding unresolvable rather than guessing its value", () => {
    const readings = readAncillarySurfaces({
      id: "a1",
      name: "Agent",
      adapterConfig: { env: { CLAUDE_CODE_SUBAGENT_MODEL: { type: "secret_ref", secretId: "sec-1" } } },
      runtimeConfig: null,
    });
    expect(readings).toEqual([{ surface: "CLAUDE_CODE_SUBAGENT_MODEL", currentModelId: null, unresolvable: true }]);
  });

  it("reads runtimeConfig.modelProfiles.cheap.adapterConfig.model", () => {
    const readings = readAncillarySurfaces({
      id: "a1",
      name: "Agent",
      adapterConfig: null,
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: "claude-sonnet-5" } } } },
    });
    expect(readings).toEqual([
      { surface: "runtimeConfig.modelProfiles.cheap", currentModelId: "claude-sonnet-5", unresolvable: false },
    ]);
  });

  it("reports nothing for an agent with no ancillary surfaces configured", () => {
    expect(readAncillarySurfaces({ id: "a1", name: "Agent", adapterConfig: null, runtimeConfig: null })).toEqual([]);
  });

  it("reads every ANTHROPIC_DEFAULT_* key as its own surface, not just ANTHROPIC_DEFAULT_HAIKU_MODEL", () => {
    const readings = readAncillarySurfaces({
      id: "a1",
      name: "Agent",
      adapterConfig: {
        env: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "model-b",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "model-e",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "model-f",
        },
      },
      runtimeConfig: null,
    });
    expect(readings.map((r) => r.surface).sort()).toEqual(
      ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"].sort(),
    );
  });

  it("reads all fixed and family surfaces independently on one agent", () => {
    const readings = readAncillarySurfaces({
      id: "a1",
      name: "Agent",
      adapterConfig: {
        env: {
          ANTHROPIC_SMALL_FAST_MODEL: "model-a",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "model-b",
          CLAUDE_CODE_SUBAGENT_MODEL: "model-c",
          UNRELATED_VAR: "not-ancillary",
        },
      },
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: "model-d" } } } },
    });
    expect(readings.map((r) => r.surface).sort()).toEqual(
      [
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "runtimeConfig.modelProfiles.cheap",
      ].sort(),
    );
  });
});

describe("ancillaryDriftForAgent", () => {
  const agent = {
    id: "a1",
    name: "Mechanical worker",
    adapterConfig: { env: { ANTHROPIC_SMALL_FAST_MODEL: "old-haiku" } },
    runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: "cliproxy/claude-haiku-4-5-20251001" } } } },
  };

  it("reports only the surface that disagrees with the recommendation", () => {
    const drift = ancillaryDriftForAgent(agent, "cliproxy/claude-haiku-4-5-20251001");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      surface: "ANTHROPIC_SMALL_FAST_MODEL",
      currentModelId: "old-haiku",
      recommendedModelId: "cliproxy/claude-haiku-4-5-20251001",
      agentId: "a1",
      agentName: "Mechanical worker",
    });
    expect(drift[0]?.remediation).toContain("console only");
  });

  it("reports nothing when every readable surface already matches", () => {
    const drift = ancillaryDriftForAgent(
      {
        id: "a1",
        name: "Agent",
        adapterConfig: { env: { ANTHROPIC_SMALL_FAST_MODEL: "cliproxy/claude-haiku-4-5-20251001" } },
        runtimeConfig: null,
      },
      "cliproxy/claude-haiku-4-5-20251001",
    );
    expect(drift).toEqual([]);
  });

  it("never reports a secret-bound surface as drifted, even when a value is recommended", () => {
    const drift = ancillaryDriftForAgent(
      {
        id: "a1",
        name: "Agent",
        adapterConfig: { env: { ANTHROPIC_SMALL_FAST_MODEL: { type: "secret_ref", secretId: "sec-1" } } },
        runtimeConfig: null,
      },
      "cliproxy/claude-haiku-4-5-20251001",
    );
    expect(drift).toEqual([]);
  });

  it("reports nothing when there is no recommendation to compare against", () => {
    expect(ancillaryDriftForAgent(agent, null)).toEqual([]);
  });

  it("gives the runtimeConfig.modelProfiles.cheap surface a distinct remediation naming the operator PATCH path", () => {
    const drift = ancillaryDriftForAgent(
      {
        id: "a1",
        name: "Agent",
        adapterConfig: null,
        runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: "stale-model" } } } },
      },
      "cliproxy/claude-haiku-4-5-20251001",
    );
    expect(drift).toHaveLength(1);
    expect(drift[0]?.remediation).toContain("PATCH /api/agents/{id}");
  });
});
