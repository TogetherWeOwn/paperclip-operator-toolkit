import { describe, expect, it } from "vitest";

import {
  ANCILLARY_MODEL_ENV_KEYS,
  CONTEXT_LIMIT_ENV_KEY,
  estimateIssueContext,
  modelOverrideForContext,
} from "../src/engine/context.js";

const narrowModel = { id: "glm-5.3", contextWindow: 200_000 };
const fleetModel = { id: "claude-opus-5", contextWindow: 1_000_000 };

/** The two sub-call surfaces every pin now carries, at the pinned model. */
const subCalls = (modelId: string) => ({
  ANTHROPIC_SMALL_FAST_MODEL: { type: "plain", value: modelId },
  ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: "plain", value: modelId },
});

describe("context fit", () => {
  it("sets a 75% compaction ceiling and preserves unrelated agent and issue env", () => {
    const patch = modelOverrideForContext({
      model: narrowModel,
      fleetCeilingTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        KEEP_AGENT: { type: "plain", value: "agent" },
        [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "1000000" },
      },
      existingOverrideEnv: { KEEP_ISSUE: { type: "plain", value: "issue" } },
    });

    expect(patch).toEqual({
      assigneeAdapterOverrides: {
        adapterConfig: {
          model: "glm-5.3",
          env: {
            KEEP_AGENT: { type: "plain", value: "agent" },
            KEEP_ISSUE: { type: "plain", value: "issue" },
            [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "150000" },
            ...subCalls("glm-5.3"),
          },
        },
      },
    });
  });

  it("drops the issue compaction ceiling when the new model reaches the fleet ceiling", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      fleetCeilingTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        KEEP_AGENT: { type: "plain", value: "agent" },
        [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "1000000" },
      },
      existingOverrideEnv: {
        KEEP_ISSUE: { type: "plain", value: "issue" },
        [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "150000" },
      },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      KEEP_AGENT: { type: "plain", value: "agent" },
      KEEP_ISSUE: { type: "plain", value: "issue" },
      ...subCalls("claude-opus-5"),
    });
  });

  it("writes the sub-call pins when clearing the sole inherited compaction ceiling", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      fleetCeilingTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "150000" },
      },
    });

    expect(patch).toEqual({
      assigneeAdapterOverrides: {
        adapterConfig: {
          model: "claude-opus-5",
          env: subCalls("claude-opus-5"),
        },
      },
    });
  });

  it("omits env entirely when the agent env is unknown and there is nothing to clear", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      fleetCeilingTokens: 1_000_000,
      compactionRatio: 0.75,
    });

    expect(patch).toEqual({
      assigneeAdapterOverrides: {
        adapterConfig: { model: "claude-opus-5" },
      },
    });
  });

  it("counts cached input from the latest issue run and caps cumulative observations", () => {
    expect(
      estimateIssueContext({
        lastRunInputTokens: 100_000,
        lastRunCachedInputTokens: 102_741,
        fleetCeilingTokens: 1_000_000,
      }),
    ).toEqual({ tokens: 202_741, source: "last-run-context" });

    expect(
      estimateIssueContext({
        lastRunInputTokens: 2_000_000,
        lastRunCachedInputTokens: 2_000_000,
        fleetCeilingTokens: 1_000_000,
      }),
    ).toEqual({ tokens: 1_000_000, source: "last-run-context" });
  });

  it("does not invent a request-sized estimate before the issue has run", () => {
    expect(
      estimateIssueContext({
        lastRunInputTokens: null,
        lastRunCachedInputTokens: null,
        fleetCeilingTokens: 1_000_000,
      }),
    ).toEqual({ tokens: null, source: "none" });
  });
});

/**
 * TOG-3045. The repin must evacuate the haiku-class sub-call surfaces along with
 * the main model, and it must do so WITHOUT dropping anything else off the
 * agent's env — the host replaces the whole env object, so a two-key write is a
 * fleet-wide secret wipe for the duration of the run.
 */
describe("sub-call surface pins", () => {
  const exhaustedLane = { type: "plain", value: "cliproxy/gpt-5.6-luna" };

  it("repoints both sub-call surfaces off an exhausted lane onto the pinned model", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      fleetCeilingTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        ANTHROPIC_SMALL_FAST_MODEL: exhaustedLane,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: exhaustedLane,
      },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig).toEqual({
      model: "claude-opus-5",
      env: subCalls("claude-opus-5"),
    });
  });

  it("keeps every other agent env binding, including secrets, across the write", () => {
    const patch = modelOverrideForContext({
      model: narrowModel,
      fleetCeilingTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        GH_APP_PRIVATE_KEY: { type: "secret_ref", key: "gh_app_private_key" },
        GH_APP_REPOS: { type: "plain", value: "paperclip-ops-tooling" },
        PAPERCLIP_API_KEY: { type: "user_secret_ref", key: "paperclip_api_key" },
        SOME_BARE_STRING: "kept-verbatim",
        ANTHROPIC_SMALL_FAST_MODEL: exhaustedLane,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: exhaustedLane,
      },
      existingOverrideEnv: { ISSUE_SCOPED: { type: "plain", value: "issue" } },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      GH_APP_PRIVATE_KEY: { type: "secret_ref", key: "gh_app_private_key" },
      GH_APP_REPOS: { type: "plain", value: "paperclip-ops-tooling" },
      PAPERCLIP_API_KEY: { type: "user_secret_ref", key: "paperclip_api_key" },
      SOME_BARE_STRING: "kept-verbatim",
      ISSUE_SCOPED: { type: "plain", value: "issue" },
      [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "150000" },
      ...subCalls("glm-5.3"),
    });
  });

  it("adds both surfaces to an agent that carried neither", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      fleetCeilingTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: { UNRELATED: { type: "plain", value: "x" } },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      UNRELATED: { type: "plain", value: "x" },
      ...subCalls("claude-opus-5"),
    });
  });

  it("writes the surfaces for a known-but-empty agent env", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      fleetCeilingTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {},
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual(subCalls("claude-opus-5"));
  });

  // The guard that makes this safe on an unreadable agent row. `null` is
  // "unknown", and an env map built from an unknown base would REPLACE the
  // agent's real bindings with just these two keys for the whole run.
  it("writes no env at all when the agent env is unknown", () => {
    for (const agentEnv of [null, undefined]) {
      const patch = modelOverrideForContext({
        model: fleetModel,
        fleetCeilingTokens: 1_000_000,
        compactionRatio: 0.75,
        agentEnv,
      });
      expect(patch.assigneeAdapterOverrides.adapterConfig).toEqual({ model: "claude-opus-5" });
    }
  });

  it("still preserves an existing issue-level env when the agent env is unknown", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      fleetCeilingTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: null,
      existingOverrideEnv: { ISSUE_SCOPED: { type: "plain", value: "issue" } },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      ISSUE_SCOPED: { type: "plain", value: "issue" },
    });
    for (const key of ANCILLARY_MODEL_ENV_KEYS) {
      expect(patch.assigneeAdapterOverrides.adapterConfig.env).not.toHaveProperty(key);
    }
  });

  it("never overwrites a secret-bound sub-call surface", () => {
    const secretBound = { type: "secret_ref", key: "small_fast_model" };
    const patch = modelOverrideForContext({
      model: fleetModel,
      fleetCeilingTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        ANTHROPIC_SMALL_FAST_MODEL: secretBound,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: exhaustedLane,
      },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      ANTHROPIC_SMALL_FAST_MODEL: secretBound,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: "plain", value: "claude-opus-5" },
    });
  });

  it("lets an explicit issue-level sub-call pin be repointed, not frozen", () => {
    // `existingOverrideEnv` is this plugin's OWN prior write, so a stale value
    // there must follow the new pin — otherwise the first repin freezes the
    // sub-calls on whatever lane the first pin chose.
    const patch = modelOverrideForContext({
      model: narrowModel,
      fleetCeilingTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {},
      existingOverrideEnv: { ANTHROPIC_SMALL_FAST_MODEL: { type: "plain", value: "claude-opus-5" } },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "150000" },
      ...subCalls("glm-5.3"),
    });
  });
});
