import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { PLUGIN_STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

const COMPANY = "co-1";
const ISSUE = "issue-1";
const TIER_LABEL_ID = "lbl-t1";
const OTHER_LABEL_ID = "lbl-other";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: ISSUE,
    companyId: COMPANY,
    title: "Rename a constant",
    status: "in_progress",
    assigneeAgentId: null,
    assigneeAdapterOverrides: null,
    labels: [
      { id: TIER_LABEL_ID, companyId: COMPANY, name: "tier:T1" },
      { id: OTHER_LABEL_ID, companyId: COMPANY, name: "area:platform" },
    ],
    labelIds: [TIER_LABEL_ID, OTHER_LABEL_ID],
    ...overrides,
  } as unknown as Issue;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    selection: { enabled: true, mode: "advise", holdOnUntrustedProfile: true },
    models: MODELS,
    tierLabelIds: { T1: TIER_LABEL_ID },
    ...overrides,
  };
}

async function boot(config: Record<string, unknown>, seedIssue = issue()) {
  const harness = createTestHarness({ manifest, config });
  // The SDK harness otherwise forwards refresh tools to the real network.
  harness.ctx.http.fetch = vi.fn(async () => {
    throw new Error("offline");
  });
  harness.seed({ issues: [seedIssue] });
  const plugin = createPlugin();
  const setup = plugin.definition.setup;
  if (!setup) throw new Error("plugin definition has no setup handler");
  await setup(harness.ctx);
  const onConfigChanged = plugin.definition.onConfigChanged;
  if (!onConfigChanged) throw new Error("plugin definition has no onConfigChanged handler");
  await onConfigChanged(config, { companyId: COMPANY });
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: PROFILES, signals: NO_ESCALATION },
  );
  return harness;
}

const runCtx = { companyId: COMPANY, agentId: "agent-1", runId: "run-1" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * . The Paperclip tool gateway maps a plugin result to
 * `structuredContent: result?.data ?? null`, and the Claude client rejects a
 * null `structuredContent` — every tool call that returned only `{content}`
 * (or an explicit `data: null`) failed schema validation in Claude Code.
 * Every registered tool must therefore return a plain-object `data` on EVERY
 * path, including validation rejections and fail-neutral network paths.
 */
describe(": every tool result carries a plain-object data", () => {
  it("registers exactly the TOOL_NAMES registry (this test covers every tool by construction)", async () => {
    const liveFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected live fetch");
    });
    const harness = await boot(baseConfig());
    for (const name of Object.values(TOOL_NAMES)) {
      await expect(
        harness.executeTool(name, {}, runCtx).catch((err: unknown) => {
          throw new Error(`tool ${name} threw instead of returning: ${String(err)}`);
        }),
        `tool ${name} is registered`,
      ).resolves.toBeDefined();
    }
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("advise: success and not-found paths both carry plain-object data", async () => {
    const harness = await boot(baseConfig());
    for (const params of [{ issueId: ISSUE }, { issueId: "nope" }, {}]) {
      const result = (await harness.executeTool(TOOL_NAMES.advise, params, runCtx)) as {
        content: unknown;
        data: unknown;
      };
      expect(typeof result.content, `advise ${JSON.stringify(params)} content`).toBe("string");
      expect(isPlainObject(result.data), `advise ${JSON.stringify(params)} data`).toBe(true);
    }
  });

  it("apply: success and not-found paths both carry plain-object data", async () => {
    const harness = await boot(baseConfig());
    for (const params of [{ issueId: ISSUE }, { issueId: "nope" }]) {
      const result = (await harness.executeTool(TOOL_NAMES.apply, params, runCtx)) as {
        content: unknown;
        data: unknown;
      };
      expect(typeof result.content, `apply ${JSON.stringify(params)} content`).toBe("string");
      expect(isPlainObject(result.data), `apply ${JSON.stringify(params)} data`).toBe(true);
    }
  });

  it("setOperatorOverride: missing params, unknown model, and recorded paths", async () => {
    const harness = await boot(baseConfig());
    const cases: Array<Record<string, unknown>> = [
      {},
      { issueId: ISSUE },
      { issueId: ISSUE, modelId: "cliproxy/not-in-roster" },
      { issueId: ISSUE, modelId: "claude-opus-5" },
    ];
    for (const params of cases) {
      const result = (await harness.executeTool(TOOL_NAMES.setOperatorOverride, params, runCtx)) as {
        content: unknown;
        data: unknown;
      };
      expect(typeof result.content, `setOperatorOverride ${JSON.stringify(params)} content`).toBe("string");
      expect(isPlainObject(result.data), `setOperatorOverride ${JSON.stringify(params)} data`).toBe(true);
    }
  });

  it("setLaneOutage: missing until, clear, and recorded paths", async () => {
    const harness = await boot(baseConfig());
    const cases: Array<Record<string, unknown>> = [
      {},
      { until: new Date(Date.now() + 3600_000).toISOString() },
      {
        lanes: ["lane-a"],
        models: [],
        until: new Date(Date.now() + 3600_000).toISOString(),
        reason: "test",
      },
    ];
    for (const params of cases) {
      const result = (await harness.executeTool(TOOL_NAMES.setLaneOutage, params, runCtx)) as {
        content: unknown;
        data: unknown;
      };
      expect(typeof result.content, `setLaneOutage ${JSON.stringify(params)} content`).toBe("string");
      expect(isPlainObject(result.data), `setLaneOutage ${JSON.stringify(params)} data`).toBe(true);
    }
  });

  it("setZaiPaceOverride: missing until, clear, and recorded paths", async () => {
    const harness = await boot(baseConfig());
    const cases: Array<Record<string, unknown>> = [
      {},
      { until: new Date(Date.now() + 3600_000).toISOString() },
      { margin: 0.2, until: new Date(Date.now() + 3600_000).toISOString() },
    ];
    for (const params of cases) {
      const result = (await harness.executeTool(TOOL_NAMES.setZaiPaceOverride, params, runCtx)) as {
        content: unknown;
        data: unknown;
      };
      expect(typeof result.content, `setZaiPaceOverride ${JSON.stringify(params)} content`).toBe("string");
      expect(isPlainObject(result.data), `setZaiPaceOverride ${JSON.stringify(params)} data`).toBe(true);
    }
  });

  it("ancillaryDrift: unconfigured and configured paths", async () => {
    const unconfigured = await boot(baseConfig({ models: [] }));
    const emptyResult = (await unconfigured.executeTool(TOOL_NAMES.ancillaryDrift, {}, runCtx)) as {
      content: unknown;
      data: unknown;
    };
    expect(typeof emptyResult.content).toBe("string");
    expect(isPlainObject(emptyResult.data)).toBe(true);

    const harness = await boot(baseConfig());
    const result = (await harness.executeTool(TOOL_NAMES.ancillaryDrift, {}, runCtx)) as {
      content: unknown;
      data: unknown;
    };
    expect(typeof result.content).toBe("string");
    expect(isPlainObject(result.data)).toBe(true);
  });

  it("aaDriftReport: state read with no snapshot still carries data", async () => {
    const harness = await boot(baseConfig());
    const result = (await harness.executeTool(TOOL_NAMES.aaDriftReport, {}, runCtx)) as {
      content: unknown;
      data: unknown;
    };
    expect(typeof result.content).toBe("string");
    expect(isPlainObject(result.data)).toBe(true);
  });

  it("priceDriftReport: no-scope and no-report paths carry data", async () => {
    const harness = await boot(baseConfig());
    // The harness defaults companyId to "company-test" when omitted, so reach
    // the real missing-scope branch by passing an explicit null.
    const noScope = (await harness.executeTool(
      TOOL_NAMES.priceDriftReport,
      {},
      { ...runCtx, companyId: null as never },
    )) as { content: unknown; data: unknown };
    expect(typeof noScope.content).toBe("string");
    expect(isPlainObject(noScope.data)).toBe(true);

    const noReport = (await harness.executeTool(TOOL_NAMES.priceDriftReport, {}, runCtx)) as {
      content: unknown;
      data: unknown;
    };
    expect(typeof noReport.content).toBe("string");
    expect(isPlainObject(noReport.data)).toBe(true);
  });

  it("tierOutcomes: empty and missing-scope paths carry data", async () => {
    const harness = await boot(baseConfig());
    const empty = (await harness.executeTool(TOOL_NAMES.tierOutcomes, {}, runCtx)) as {
      content: unknown;
      data: unknown;
    };
    expect(typeof empty.content).toBe("string");
    expect(isPlainObject(empty.data)).toBe(true);

    const noScope = (await harness.executeTool(
      TOOL_NAMES.tierOutcomes,
      {},
      { ...runCtx, companyId: null as never },
    )) as { content: unknown; data: unknown };
    expect(typeof noScope.content).toBe("string");
    expect(isPlainObject(noScope.data)).toBe(true);
  });

  it("refreshAaIndexNow and reconcilePricesNow: fail-neutral network paths carry data", async () => {
    const harness = await boot(baseConfig());
    // Fail the network, not the handler: both fetch helpers are fail-neutral
    // (never throw), so a refused fetch still reaches a shaped return.
    harness.ctx.http.fetch = async () => {
      throw new Error("offline");
    };
    for (const name of [TOOL_NAMES.refreshAaIndexNow, TOOL_NAMES.reconcilePricesNow]) {
      const result = (await harness.executeTool(name, {}, runCtx)) as {
        content: unknown;
        data: unknown;
      };
      expect(typeof result.content, `${name} content`).toBe("string");
      expect(isPlainObject(result.data), `${name} data`).toBe(true);
    }
  });
});

/**
 *  ( D1c, audit priority 1): verification for the upstream
 * gateway fix prepared in .
 *
 * The gateway maps a plugin result to `structuredContent: result?.data ??
 * null`, and the Claude client rejects a null `structuredContent` — so any
 * tool path that returns a nullish `data` is a schema-validation failure in
 * Claude Code, one hop downstream of us.  fixed the producer side
 * (every handler returns a plain-object `data`); this block pins the
 * CONSUMER-side contract the gateway fix must satisfy, by running the exact
 * mapping the gateway applies over representative results from every tool and
 * asserting it never yields null.
 *
 * Fail-without-the-fix direction: revert any handler to `return { content }`
 * (or `data: null`) and the shim below produces `structuredContent: null`
 * for that path — the shape the Claude client rejects. This suite goes red
 * on exactly the defect the upstream fix removes.
 */
describe(": the gateway structuredContent mapping never yields null", () => {
  // The mapping the Paperclip tool gateway applies to a plugin result
  // (worker.ts  header). Kept as a named function so the assertion
  // reads as the contract, not as an inline reimplementation that could
  // drift from it.
  function gatewayStructuredContent(result: { data: unknown }): unknown {
    return result?.data ?? null;
  }

  it("every tool result on every exercised path survives the gateway mapping", async () => {
    const harness = await boot(baseConfig());
    const cases: Array<{ tool: string; params: Record<string, unknown> }> = [
      { tool: TOOL_NAMES.advise, params: { issueId: ISSUE } },
      { tool: TOOL_NAMES.advise, params: { issueId: "nope" } },
      { tool: TOOL_NAMES.advise, params: {} },
      { tool: TOOL_NAMES.apply, params: { issueId: ISSUE } },
      { tool: TOOL_NAMES.apply, params: { issueId: "nope" } },
      { tool: TOOL_NAMES.setOperatorOverride, params: {} },
      { tool: TOOL_NAMES.setOperatorOverride, params: { issueId: ISSUE } },
      { tool: TOOL_NAMES.setOperatorOverride, params: { issueId: ISSUE, modelId: "cliproxy/not-in-roster" } },
      { tool: TOOL_NAMES.setOperatorOverride, params: { issueId: ISSUE, modelId: "claude-opus-5" } },
      { tool: TOOL_NAMES.setLaneOutage, params: {} },
      {
        tool: TOOL_NAMES.setLaneOutage,
        params: {
          lanes: ["lane-a"],
          models: [],
          until: new Date(Date.now() + 3600_000).toISOString(),
          reason: "test",
        },
      },
      { tool: TOOL_NAMES.setZaiPaceOverride, params: {} },
      {
        tool: TOOL_NAMES.setZaiPaceOverride,
        params: { margin: 0.2, until: new Date(Date.now() + 3600_000).toISOString() },
      },
      { tool: TOOL_NAMES.ancillaryDrift, params: {} },
      { tool: TOOL_NAMES.aaDriftReport, params: {} },
      { tool: TOOL_NAMES.priceDriftReport, params: {} },
    ];
    for (const { tool, params } of cases) {
      const result = (await harness.executeTool(tool, params, runCtx)) as {
        content: unknown;
        data: unknown;
      };
      const structuredContent = gatewayStructuredContent(result);
      expect(
        isPlainObject(structuredContent),
        `${tool} ${JSON.stringify(params)}: gateway structuredContent must be a plain object, got ${JSON.stringify(structuredContent)?.slice(0, 120)}`,
      ).toBe(true);
    }
  });

  it("a null data would yield a null structuredContent — the defect this pins against", () => {
    // The negative control. This is not testing our code; it proves the shim
    // above can actually see the defect — without it, the suite above would
    // pass even if the mapping were `() => ({})`, which proves nothing.
    expect(gatewayStructuredContent({ data: null })).toBeNull();
    expect(gatewayStructuredContent({ data: undefined })).toBeNull();
    expect(gatewayStructuredContent({ data: { ok: false, error: "x" } })).toEqual({
      ok: false,
      error: "x",
    });
  });
});
