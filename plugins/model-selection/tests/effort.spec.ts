import { describe, expect, it } from "vitest";

import {
  EFFORT_LADDER,
  effortConfigKeyFor,
  effortVocabularyFor,
  inheritedEffortFrom,
  resolveEffortPin,
} from "../src/engine/effort.js";
import { modelOverrideForContext } from "../src/engine/context.js";

const opus = { id: "claude-opus-5", contextWindow: 1_000_000 };

describe("effort vocabulary", () => {
  it("maps each override-capable adapter to the config key it actually reads", () => {
    // claude-local/src/server/execute.ts:436, codex-local/src/server/codex-args.ts:44,
    // opencode-local/src/server/execute.ts:240.
    expect(effortConfigKeyFor("claude_local")).toBe("effort");
    expect(effortConfigKeyFor("codex_local")).toBe("modelReasoningEffort");
    expect(effortConfigKeyFor("opencode_local")).toBe("variant");
  });

  it("refuses to name a key for an adapter an issue override cannot reach", () => {
    // grok and hermes have real effort surfaces; ISSUE_OVERRIDE_ADAPTER_TYPES
    // just is not one of the three that honour an issue-level adapterConfig.
    for (const adapter of ["grok_local", "hermes_local", "pi_local", null, undefined]) {
      expect(effortConfigKeyFor(adapter)).toBeNull();
      expect(effortVocabularyFor(adapter, "claude-opus-5")).toBeNull();
    }
  });

  it("gives codex the astra vocabulary only for astra", () => {
    expect(effortVocabularyFor("codex_local", "gpt-6-astra")).toContain("ultra");
    expect(effortVocabularyFor("codex_local", "gpt-5.6-sol")).not.toContain("ultra");
    expect(effortVocabularyFor("codex_local", "gpt-5.6-sol")).toContain("minimal");
    // Trailing whitespace is the ONE thing the adapter normalizes away.
    expect(effortVocabularyFor("codex_local", "  gpt-6-astra  ")).toContain("ultra");
  });

  it("does not read a NAMESPACED astra id as astra, because the adapter does not", () => {
    // `normalizeModelId` is trim() only and the astra test is exact equality
    // (`codex-local/src/index.ts:24-26,65`), so `cliproxy/gpt-6-astra` is DEFAULT
    // to the CLI. Stripping the namespace here would authorize max/ultra on a
    // model that caps at xhigh — and the pin writes the id unchanged, so the
    // adapter would never agree with the vocabulary that allowed the value.
    // `GPT-6-Astra` is here for the same reason: the mirror does not lowercase
    // either, so a mis-cased id is DEFAULT to us exactly as it is to the CLI.
    for (const namespaced of [
      "cliproxy/gpt-6-astra",
      "devin/gpt-6-astra",
      "openai/GPT-6-Astra",
      "GPT-6-Astra",
    ]) {
      const vocabulary = effortVocabularyFor("codex_local", namespaced);
      expect(vocabulary).not.toContain("ultra");
      expect(vocabulary).not.toContain("max");
      expect(vocabulary).toContain("minimal");
    }
  });

  it("clamps a namespaced astra row to the vocabulary the CLI will actually honour", () => {
    const pin = resolveEffortPin({
      adapterType: "codex_local",
      modelId: "cliproxy/gpt-6-astra",
      rosterEffort: "ultra",
    });
    expect(pin.outcome).toBe("clamped");
    expect(pin.writes).toEqual({ modelReasoningEffort: "xhigh" });
  });

  it("keys on the adapter, not the model family", () => {
    // This fleet routes gpt-*/glm-* ids through claude_local via CLIProxy. The
    // CLI is still `claude`, so the cap is still high — reading the vocabulary
    // off the model id alone would authorize an illegal xhigh here.
    expect(effortVocabularyFor("claude_local", "gpt-6-astra")).toEqual(["low", "medium", "high"]);
  });

  it("orders the ladder so a clamp is monotone", () => {
    expect([...EFFORT_LADDER]).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });
});

describe("inherited effort", () => {
  it("reads codex's legacy reasoningEffort key as live", () => {
    // codex-args.ts:44-47 falls back to it, so a value parked there is not inert.
    expect(inheritedEffortFrom("codex_local", { reasoningEffort: "ultra" })).toBe("ultra");
    expect(
      inheritedEffortFrom("codex_local", { modelReasoningEffort: "high", reasoningEffort: "ultra" }),
    ).toBe("high");
  });

  it("is null for an unreadable agent or an adapter with no reachable key", () => {
    expect(inheritedEffortFrom("claude_local", null)).toBeNull();
    expect(inheritedEffortFrom("grok_local", { effort: "high" })).toBeNull();
    expect(inheritedEffortFrom("claude_local", { effort: "   " })).toBeNull();
  });
});

describe("resolveEffortPin", () => {
  it("pins a roster effort the model offers, verbatim", () => {
    const pin = resolveEffortPin({
      adapterType: "codex_local",
      modelId: "gpt-6-astra",
      rosterEffort: "max",
    });
    expect(pin.outcome).toBe("pinned");
    expect(pin.writes).toEqual({ modelReasoningEffort: "max" });
  });

  it("clamps DOWN to the hottest level the model actually offers", () => {
    // The 2026-09-22 failure, inverted: `max` asked for on a claude_local row.
    const pin = resolveEffortPin({
      adapterType: "claude_local",
      modelId: "claude-opus-5",
      rosterEffort: "max",
    });
    expect(pin.outcome).toBe("clamped");
    expect(pin.writes).toEqual({ effort: "high" });
    expect(pin.reason).toContain("low|medium|high");
  });

  it("clamps UP when the request sits below the whole vocabulary", () => {
    const pin = resolveEffortPin({
      adapterType: "claude_local",
      modelId: "claude-opus-5",
      rosterEffort: "minimal",
    });
    expect(pin.outcome).toBe("clamped");
    expect(pin.writes).toEqual({ effort: "low" });
  });

  it("refuses a roster effort that is not a level at all rather than guessing one", () => {
    const pin = resolveEffortPin({
      adapterType: "claude_local",
      modelId: "claude-opus-5",
      rosterEffort: "turbo",
    });
    expect(pin).toMatchObject({ outcome: "rejected" });
    expect(pin.writes).toEqual({});
  });

  it("writes nothing when the adapter has no issue-reachable effort surface", () => {
    const pin = resolveEffortPin({
      adapterType: "grok_local",
      modelId: "grok-5",
      rosterEffort: "high",
    });
    expect(pin.writes).toEqual({});
    expect(pin.outcome).toBe("adapter-unsupported");
  });

  it("writes nothing when the assignee agent could not be read", () => {
    // UNKNOWN adapter type. Guessing `effort` here would be a coin flip between
    // three key names and three vocabularies.
    const pin = resolveEffortPin({
      adapterType: null,
      modelId: "claude-opus-5",
      rosterEffort: "high",
    });
    expect(pin.writes).toEqual({});
    expect(pin.outcome).toBe("adapter-unsupported");
  });

  describe("with no roster effort, the pin is still responsible for the pair", () => {
    it("leaves a legal inherited value alone", () => {
      const pin = resolveEffortPin({
        adapterType: "claude_local",
        modelId: "claude-opus-5",
        inheritedEffort: "high",
      });
      expect(pin.outcome).toBe("inherited-ok");
      expect(pin.writes).toEqual({});
    });

    it("clamps an inherited value the chosen model cannot honour", () => {
      // The demonstrated failure verbatim: a hand-set fleet-level `max` meets a
      // repin onto a claude_local model. Before this card the pin omitted the
      // key, the host's per-key merge preserved `max`, and the CLI got it.
      const pin = resolveEffortPin({
        adapterType: "claude_local",
        modelId: "claude-fable-5-1",
        inheritedEffort: "max",
      });
      expect(pin.outcome).toBe("neutralized-clamped");
      expect(pin.writes).toEqual({ effort: "high" });
    });

    it("clears an inherited value that is not a level at all", () => {
      // "" is inert on claude and opencode: each reads asString(config[key], "")
      // — fallback literally "" — then skips the flag. It is NOT modelProfile
      // "cheap". codex is the exception; see the next test.
      const pin = resolveEffortPin({
        adapterType: "opencode_local",
        modelId: "glm-5.3",
        inheritedEffort: "turbo",
      });
      expect(pin.outcome).toBe("neutralized-cleared");
      expect(pin.writes).toEqual({ variant: "" });
    });

    it("empties BOTH codex keys to clear, because one falls back to the other", () => {
      // asString returns its fallback for "" (`server-utils.ts:437`) and codex's
      // fallback is `reasoningEffort`, not "" (`codex-args.ts:44-47`). Writing
      // only modelReasoningEffort: "" would hand the decision straight back to
      // the legacy key and resurrect the value we are neutralizing.
      const pin = resolveEffortPin({
        adapterType: "codex_local",
        modelId: "gpt-5.6-sol",
        inheritedEffort: "maximum",
      });
      expect(pin.outcome).toBe("neutralized-cleared");
      expect(pin.writes).toEqual({ modelReasoningEffort: "", reasoningEffort: "" });
    });

    it("leaves the legacy key alone when it writes a real value, which already wins", () => {
      // The fallback is only consulted when the primary is empty, so a non-empty
      // modelReasoningEffort shadows reasoningEffort on its own. Emptying the
      // legacy key here would be a write we cannot justify.
      const pin = resolveEffortPin({
        adapterType: "codex_local",
        modelId: "gpt-5.6-sol",
        inheritedEffort: "ultra",
      });
      expect(pin.outcome).toBe("neutralized-clamped");
      expect(pin.writes).toEqual({ modelReasoningEffort: "xhigh" });
    });

    it("writes nothing when there is nothing inherited", () => {
      const pin = resolveEffortPin({ adapterType: "claude_local", modelId: "claude-opus-5" });
      expect(pin.outcome).toBe("none");
      expect(pin.writes).toEqual({});
    });
  });
});

describe("the pin carries model and effort in one patch", () => {
  it("writes the adapter's own key alongside the model", () => {
    const patch = modelOverrideForContext({
      model: { ...opus, effort: "high" },
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentAdapterType: "claude_local",
      agentAdapterConfig: { model: "glm-5.3" },
      agentEnv: {},
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig).toMatchObject({
      model: "claude-opus-5",
      effort: "high",
    });
  });

  it("never emits a model paired with an effort that model does not offer", () => {
    const patch = modelOverrideForContext({
      model: { ...opus, effort: "max" },
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentAdapterType: "claude_local",
      agentAdapterConfig: {},
      agentEnv: {},
    });
    const config = patch.assigneeAdapterOverrides.adapterConfig;
    expect(config.effort).toBe("high");
    expect(effortVocabularyFor("claude_local", config.model)).toContain(config.effort);
  });

  it("overrides an inherited illegal effort even with no roster effort", () => {
    const patch = modelOverrideForContext({
      model: opus,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentAdapterType: "claude_local",
      agentAdapterConfig: { effort: "max" },
      agentEnv: {},
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig.effort).toBe("high");
  });

  it("carries BOTH codex keys into the patch when it is clearing", () => {
    const patch = modelOverrideForContext({
      model: { id: "gpt-5.6-sol", contextWindow: 400_000 },
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentAdapterType: "codex_local",
      agentAdapterConfig: { reasoningEffort: "maximum" },
      agentEnv: {},
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig).toMatchObject({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "",
      reasoningEffort: "",
    });
  });

  it("leaves adapterConfig effort-free when the agent row is unreadable", () => {
    const patch = modelOverrideForContext({
      model: { ...opus, effort: "high" },
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: null,
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig).not.toHaveProperty("effort");
  });

  it("never reaches for modelProfile", () => {
    const patch = modelOverrideForContext({
      model: { ...opus, effort: "high" },
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentAdapterType: "claude_local",
      agentAdapterConfig: {},
      agentEnv: {},
    });
    expect(patch.assigneeAdapterOverrides).not.toHaveProperty("modelProfile");
    expect(patch.assigneeAdapterOverrides.adapterConfig).not.toHaveProperty("modelProfile");
  });
});
