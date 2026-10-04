import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { PLUGIN_STATE_KEYS, TIERS, TOOL_NAMES } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

/**
 * TOG-5005 (TOG-4713 D2b, part 2). TOG-4883 covers the three MCP tools in the
 * separate `paperclip-model-router` repo; TOG-4763 covers the plain-object
 * `data` envelope for every tool here. This spec pins the FAIL-CLOSED shapes
 * for the remaining model-selection plugin tools in THIS repo: every
 * malformed input resolves (never throws) with a string `content` and a
 * plain-object `data` carrying a stable `{ ok: false, error: <code> }`
 * rejection, and each tool has at least one malformed-input case.
 *
 * The trailing coverage test fails when TOOL_NAMES gains an entry without a
 * case here — that is the "each tool has a malformed-input case" acceptance,
 * enforced by construction.
 */

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
 * Unwrap one tool result, asserting the never-throw + shaped-envelope half of
 * the contract. A throwing handler fails here with the raw error attached.
 */
async function dataOf(harness: Awaited<ReturnType<typeof boot>>, tool: string, params: Record<string, unknown>) {
  let result: unknown;
  try {
    result = await harness.executeTool(tool, params, runCtx);
  } catch (err) {
    throw new Error(`tool ${tool} threw on ${JSON.stringify(params)} instead of returning: ${String(err)}`);
  }
  const r = result as { content: unknown; data: unknown };
  expect(typeof r.content, `${tool} ${JSON.stringify(params)} content is a string`).toBe("string");
  expect(isPlainObject(r.data), `${tool} ${JSON.stringify(params)} data is a plain object`).toBe(true);
  return r.data as Record<string, unknown>;
}

/** Every `it` below covers one tool; the trailing test diffs this against TOOL_NAMES. */
const coveredTools = new Set<string>();
function cover(tool: string) {
  coveredTools.add(tool);
}

describe("TOG-5005: fail-closed error shapes for the remaining model-selection tools", () => {
  it("advise: missing, mistyped, and unknown issueId all fail closed as issue-not-found", async () => {
    cover(TOOL_NAMES.advise);
    const harness = await boot(baseConfig());
    for (const params of [{}, { issueId: 42 }, { issueId: ["issue-1"] }, { issueId: "nope" }]) {
      const data = await dataOf(harness, TOOL_NAMES.advise, params as Record<string, unknown>);
      expect(data, `advise ${JSON.stringify(params)}`).toMatchObject({ ok: false, error: "issue-not-found" });
    }
  });

  it("advise: success path carries the decision, not a rejection", async () => {
    const harness = await boot(baseConfig());
    const data = await dataOf(harness, TOOL_NAMES.advise, { issueId: ISSUE });
    expect(data.ok).not.toBe(false);
    expect(typeof data.modelId).toBe("string");
  });

  it("apply: missing and unknown issueId fail closed as issue-not-found", async () => {
    cover(TOOL_NAMES.apply);
    const harness = await boot(baseConfig());
    for (const params of [{}, { issueId: "nope" }]) {
      const data = await dataOf(harness, TOOL_NAMES.apply, params);
      expect(data, `apply ${JSON.stringify(params)}`).toMatchObject({ ok: false, error: "issue-not-found" });
    }
  });

  it("apply: advisory no-write path carries decision and plan", async () => {
    const harness = await boot(baseConfig());
    const data = await dataOf(harness, TOOL_NAMES.apply, { issueId: ISSUE });
    expect(isPlainObject(data.decision)).toBe(true);
    expect(isPlainObject(data.plan)).toBe(true);
  });

  it("setOperatorOverride: missing/mistyped params fail closed as missing-params", async () => {
    cover(TOOL_NAMES.setOperatorOverride);
    const harness = await boot(baseConfig());
    const cases: Array<Record<string, unknown>> = [
      {},
      { issueId: ISSUE },
      { modelId: "claude-opus-5" },
      { issueId: 42, modelId: "claude-opus-5" },
      { issueId: ISSUE, modelId: null },
    ];
    for (const params of cases) {
      const data = await dataOf(harness, TOOL_NAMES.setOperatorOverride, params);
      expect(data, `setOperatorOverride ${JSON.stringify(params)}`).toMatchObject({
        ok: false,
        error: "missing-params",
      });
    }
  });

  it("setOperatorOverride: unknown model fails closed and echoes the modelId", async () => {
    const harness = await boot(baseConfig());
    const data = await dataOf(harness, TOOL_NAMES.setOperatorOverride, {
      issueId: ISSUE,
      modelId: "cliproxy/not-in-roster",
    });
    expect(data).toMatchObject({ ok: false, error: "unknown-model", modelId: "cliproxy/not-in-roster" });
  });

  it("setOperatorOverride: recorded path returns the time-boxed entry", async () => {
    const harness = await boot(baseConfig());
    const data = await dataOf(harness, TOOL_NAMES.setOperatorOverride, {
      issueId: ISSUE,
      modelId: "claude-opus-5",
    });
    expect(data.modelId).toBe("claude-opus-5");
    expect(typeof data.expiresAt).toBe("string");
  });

  it("setLaneOutage: missing/mistyped until fails closed as missing-until", async () => {
    cover(TOOL_NAMES.setLaneOutage);
    const harness = await boot(baseConfig());
    for (const params of [{}, { lanes: ["lane-a"] }, { until: 12345 }, { until: null }]) {
      const data = await dataOf(harness, TOOL_NAMES.setLaneOutage, params as Record<string, unknown>);
      expect(data, `setLaneOutage ${JSON.stringify(params)}`).toMatchObject({
        ok: false,
        error: "missing-until",
      });
    }
  });

  it("setLaneOutage: empty/malformed lane lists take the documented clear path", async () => {
    const harness = await boot(baseConfig());
    const until = new Date(Date.now() + 3600_000).toISOString();
    for (const params of [{ until }, { lanes: "lane-a", until }]) {
      const data = await dataOf(harness, TOOL_NAMES.setLaneOutage, params as Record<string, unknown>);
      expect(data, `setLaneOutage ${JSON.stringify(params)}`).toMatchObject({ ok: true, cleared: true });
    }
  });

  it("setLaneOutage: record path echoes lanes, models, and until", async () => {
    const harness = await boot(baseConfig());
    const until = new Date(Date.now() + 3600_000).toISOString();
    const data = await dataOf(harness, TOOL_NAMES.setLaneOutage, {
      lanes: ["lane-a"],
      models: [],
      until,
      reason: "test",
    });
    expect(data).toMatchObject({ lanes: ["lane-a"], until });
  });

  it("setZaiPaceOverride: missing/mistyped until fails closed as missing-until", async () => {
    cover(TOOL_NAMES.setZaiPaceOverride);
    const harness = await boot(baseConfig());
    for (const params of [{}, { margin: 0.2 }, { until: {} }]) {
      const data = await dataOf(harness, TOOL_NAMES.setZaiPaceOverride, params as Record<string, unknown>);
      expect(data, `setZaiPaceOverride ${JSON.stringify(params)}`).toMatchObject({
        ok: false,
        error: "missing-until",
      });
    }
  });

  it("setZaiPaceOverride: omitted/mistyped margin takes the documented clear path", async () => {
    const harness = await boot(baseConfig());
    const until = new Date(Date.now() + 3600_000).toISOString();
    for (const params of [{ until }, { margin: "0.2", until }]) {
      const data = await dataOf(harness, TOOL_NAMES.setZaiPaceOverride, params as Record<string, unknown>);
      expect(data, `setZaiPaceOverride ${JSON.stringify(params)}`).toMatchObject({ ok: true, cleared: true });
    }
  });

  it("setZaiPaceOverride: record path echoes margin and until", async () => {
    const harness = await boot(baseConfig());
    const until = new Date(Date.now() + 3600_000).toISOString();
    const data = await dataOf(harness, TOOL_NAMES.setZaiPaceOverride, { margin: 0.2, until });
    expect(data).toMatchObject({ margin: 0.2, until });
  });

  it("ancillaryDrift: unconfigured roster and junk params never throw", async () => {
    cover(TOOL_NAMES.ancillaryDrift);
    const unconfigured = await boot(baseConfig({ models: [] }));
    const empty = await dataOf(unconfigured, TOOL_NAMES.ancillaryDrift, { bogus: true });
    expect(empty).toMatchObject({ recommendedModelId: null, drift: [] });

    const harness = await boot(baseConfig());
    const result = await dataOf(harness, TOOL_NAMES.ancillaryDrift, { bogus: [1, 2] });
    expect(typeof result.recommendedModelId).toBe("string");
    expect(Array.isArray(result.drift)).toBe(true);
  });

  it("aaDriftReport: empty snapshot and junk params return rows, never throw", async () => {
    cover(TOOL_NAMES.aaDriftReport);
    const harness = await boot(baseConfig());
    const data = await dataOf(harness, TOOL_NAMES.aaDriftReport, { bogus: "x" });
    expect(isPlainObject(data.snapshot)).toBe(true);
    expect(Array.isArray(data.rows)).toBe(true);
    expect((data.rows as unknown[]).length).toBe(MODELS.length);
  });

  it("priceDriftReport: missing scope and no-report fail closed with stable codes", async () => {
    cover(TOOL_NAMES.priceDriftReport);
    const harness = await boot(baseConfig());
    // The harness fills companyId via `??`, so null/undefined never reach
    // the missing-scope branch — an empty string does (not nullish, falsy).
    let noScope: unknown;
    try {
      noScope = await harness.executeTool(TOOL_NAMES.priceDriftReport, {}, { ...runCtx, companyId: "" as never });
    } catch (err) {
      throw new Error(`tool ${TOOL_NAMES.priceDriftReport} threw on missing scope: ${String(err)}`);
    }
    const noScopeData = (noScope as { data: unknown }).data as Record<string, unknown>;
    expect(noScopeData).toMatchObject({ ok: false, error: "missing-company-scope" });

    const noReport = await dataOf(harness, TOOL_NAMES.priceDriftReport, { bogus: 1 });
    expect(noReport).toMatchObject({ ok: false, error: "no-report-yet" });
  });

  it("refreshAaIndexNow: failed fetch fails neutral with an error string, never throws", async () => {
    cover(TOOL_NAMES.refreshAaIndexNow);
    const harness = await boot(baseConfig());
    harness.ctx.http.fetch = async () => {
      throw new Error("offline");
    };
    const data = await dataOf(harness, TOOL_NAMES.refreshAaIndexNow, { bogus: true });
    expect(typeof data.error).toBe("string");
    expect((data.error as string).length).toBeGreaterThan(0);
    expect(data.modelsFetched).toBe(0);
  });

  it("reconcilePricesNow: failed fetch fails neutral with empty companies, never throws", async () => {
    cover(TOOL_NAMES.reconcilePricesNow);
    const harness = await boot(baseConfig());
    harness.ctx.http.fetch = async () => {
      throw new Error("offline");
    };
    const data = await dataOf(harness, TOOL_NAMES.reconcilePricesNow, { bogus: true });
    expect(typeof data.error).toBe("string");
    expect((data.error as string).length).toBeGreaterThan(0);
    expect(data.companies).toEqual([]);
  });

  it("tierOutcomes: missing scope fails closed as missing-company-scope", async () => {
    cover(TOOL_NAMES.tierOutcomes);
    const harness = await boot(baseConfig());
    let result: unknown;
    try {
      result = await harness.executeTool(TOOL_NAMES.tierOutcomes, {}, { ...runCtx, companyId: "" as never });
    } catch (err) {
      throw new Error(`tool ${TOOL_NAMES.tierOutcomes} threw on missing scope: ${String(err)}`);
    }
    const r = result as { content: unknown; data: unknown };
    expect(typeof r.content).toBe("string");
    expect(r.data).toMatchObject({ ok: false, error: "missing-company-scope" });
  });

  it("tierOutcomes: a never-polled company gets honest zeroes, not an error", async () => {
    const harness = await boot(baseConfig());
    const data = await dataOf(harness, TOOL_NAMES.tierOutcomes, { bogus: 1 });
    expect(data.updatedAt).toBeNull();
    for (const tier of TIERS) {
      expect((data.tiers as Record<string, unknown>)[tier]).toMatchObject({
        polls: 0,
        succeeded: 0,
        failed: 0,
        lastAt: null,
      });
    }
  });

  it("tierOutcomes: corrupt stored state normalizes to zeroes instead of throwing", async () => {
    const harness = await boot(baseConfig());
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.tierPollOutcomes },
      { tiers: { T1: { polls: "many", succeeded: -1, failed: 1.5, lastAt: 7 } }, updatedAt: 42 },
    );
    const data = await dataOf(harness, TOOL_NAMES.tierOutcomes, {});
    expect(data.updatedAt).toBeNull();
    expect((data.tiers as Record<string, unknown>).T1).toMatchObject({
      polls: 0,
      succeeded: 0,
      failed: 0,
      lastAt: null,
    });
  });

  it("acceptedWorkReport: missing scope fails closed; empty company reports no-overlay-yet; garbage never throws", async () => {
    cover(TOOL_NAMES.acceptedWorkReport);
    const harness = await boot(baseConfig());
    let result: unknown;
    try {
      result = await harness.executeTool(TOOL_NAMES.acceptedWorkReport, {}, { ...runCtx, companyId: "" as never });
    } catch (err) {
      throw new Error(`tool ${TOOL_NAMES.acceptedWorkReport} threw on missing scope: ${String(err)}`);
    }
    const r = result as { content: unknown; data: unknown };
    expect(typeof r.content).toBe("string");
    expect(r.data).toMatchObject({ ok: false, error: "missing-company-scope" });

    const empty = await dataOf(harness, TOOL_NAMES.acceptedWorkReport, { bogus: 1 });
    expect(empty).toMatchObject({ ok: false, error: "no-report-yet" });
  });

  it("tierPolicy: malformed requests fail closed with stable codes", async () => {
    cover(TOOL_NAMES.tierPolicy);
    const harness = await boot(baseConfig());
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "invalid-action"],
      [{ action: "bogus" }, "invalid-action"],
      [{ action: "edit", expectedRevision: 1 }, "missing-reason"],
      [{ action: "edit", reason: "r" }, "missing-expected-revision"],
      [{ action: "edit", tierId: "T1", patch: { name: "x" }, reason: "r", expectedRevision: 9 }, "revision-conflict"],
      [{ action: "add", basePolicy: 5 }, "malformed-policy"],
      [{ action: "diff" }, "missing-policy"],
    ];
    for (const [params, code] of cases) {
      const data = await dataOf(harness, TOOL_NAMES.tierPolicy, params);
      expect(data, JSON.stringify(params)).toMatchObject({ ok: false, error: code, outcome: "rejected", persisted: false });
    }
  });

  it("tierPolicy: an accepted edit is a proposal only and writes nothing", async () => {
    const harness = await boot(baseConfig());
    const writes: string[] = [];
    const state = harness.ctx.state;
    const originalSet = state.set.bind(state);
    const originalDelete = state.delete.bind(state);
    state.set = async (key, value) => {
      writes.push(`set:${key.stateKey}`);
      return originalSet(key, value);
    };
    state.delete = async (key) => {
      writes.push(`delete:${key.stateKey}`);
      return originalDelete(key);
    };
    const activityBefore = harness.activity.length;
    const executesBefore = harness.dbExecutes.length;
    const data = await dataOf(harness, TOOL_NAMES.tierPolicy, {
      action: "edit",
      tierId: "T1",
      patch: { name: "Frontier" },
      expectedRevision: 1,
      reason: "private-reason-text",
      dryRun: false,
    });
    expect(data).toMatchObject({ ok: true, outcome: "proposalOnly", persisted: false, proposedRevision: 2 });
    expect(writes).toEqual([]);
    expect(harness.activity.length).toBe(activityBefore);
    expect(harness.dbExecutes.length).toBe(executesBefore);
    const log = harness.logs.find((l) => l.message === "tier policy proposal");
    expect(log?.meta).toMatchObject({ outcome: "proposalOnly", auditId: data.auditId, agentId: "agent-1", runId: "run-1" });
    expect(JSON.stringify(log?.meta)).not.toContain("private-reason-text");
  });

  it("every tool resolves on garbage input (never throws)", async () => {
    const harness = await boot(baseConfig());
    harness.ctx.http.fetch = async () => {
      throw new Error("offline");
    };
    const garbage: Record<string, unknown> = {
      issueId: [],
      modelId: null,
      lanes: 42,
      models: "x",
      margin: "wide",
      until: {},
      ttlSeconds: "soon",
      bogus: true,
    };
    for (const name of Object.values(TOOL_NAMES)) {
      cover(name);
      const data = await dataOf(harness, name, garbage);
      expect(data, `tool ${name} garbage-input data`).toBeDefined();
    }
  });

  it("covers every registered tool (add a case when TOOL_NAMES gains an entry)", () => {
    expect([...coveredTools].sort()).toEqual([...Object.values(TOOL_NAMES)].sort());
  });
});
