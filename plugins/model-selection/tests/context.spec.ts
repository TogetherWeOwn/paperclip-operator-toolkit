import { describe, expect, it } from "vitest";

import {
  CONTEXT_LIMIT_ENV_KEY,
  estimateIssueContext,
  modelOverrideForContext,
} from "../src/engine/context.js";

const narrowModel = { id: "glm-5.3", contextWindow: 200_000 };
const fleetModel = { id: "claude-opus-5", contextWindow: 1_000_000 };

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
    });
  });

  it("writes an empty env map when clearing the sole inherited compaction ceiling", () => {
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
          env: {},
        },
      },
    });
  });

  it("omits env when there is nothing to merge or clear", () => {
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
