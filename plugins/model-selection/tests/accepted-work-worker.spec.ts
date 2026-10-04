import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { PLUGIN_STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { ACCEPTED_WORK_SPEC_VERSION } from "../src/accepted-work/posterior.js";
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
});

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: ISSUE,
    companyId: COMPANY,
    title: "Rename a constant",
    status: "done",
    assigneeAgentId: null,
    assigneeAdapterOverrides: { adapterConfig: { model: "claude-sonnet-5", variant: "high" } },
    labels: [
      { id: TIER_LABEL_ID, companyId: COMPANY, name: "tier:T2" },
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

function onConfig(overrides: Record<string, unknown> = {}) {
  return baseConfig({ acceptedWork: { enabled: true }, ...overrides });
}

async function boot(config: Record<string, unknown>, seedIssue = issue()) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ issues: [seedIssue], companies: [{ id: COMPANY, name: "Co" } as never] });
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

/**
 * refreshScores issues three DB reads (run rows, closing runs, card issues);
 * every `issues.get` inside the job resolves from the seeded issue above.
 * One mature closing run (finished 20 days ago) for the seeded card.
 */
function seedScoring(harness: Awaited<ReturnType<typeof boot>>, servedModel = "claude-sonnet-5") {
  let queryIndex = 0;
  harness.ctx.db.query = (async () => {
    queryIndex += 1;
    if (queryIndex === 1) return [] as never;
    if (queryIndex === 2) {
      return [{
        issue_id: ISSUE,
        model: servedModel,
        agent_id: "agent-1",
        cost_usd: "3",
        provider: "",
        finished_at_ms: String(NOW - 20 * 24 * 60 * 60 * 1000),
      }] as never;
    }
    if (queryIndex === 3) {
      return [{ id: ISSUE, closed_at_ms: String(NOW - 20 * 24 * 60 * 60 * 1000) }] as never;
    }
    return [] as never;
  }) as never;
}

async function readOverlay(harness: Awaited<ReturnType<typeof boot>>) {
  return (await harness.ctx.state.get({
    scopeKind: "company",
    scopeId: COMPANY,
    stateKey: PLUGIN_STATE_KEYS.acceptedWorkOverlay,
  })) as { specVersion?: unknown; cohorts?: Array<Record<string, unknown>> } | undefined;
}

describe("worker: accepted-work producer default-off and shadow-only", () => {
  it("builds nothing when disabled — the overlay key stays empty", async () => {
    const harness = await boot(baseConfig());
    seedScoring(harness);
    await harness.runJob("refreshScores");
    // The harness returns null for a missing key: absent, never an overlay.
    expect(await readOverlay(harness)).toBeNull();
  });

  it("builds a versioned overlay from the same rows when enabled", async () => {
    const harness = await boot(onConfig());
    seedScoring(harness);
    await harness.runJob("refreshScores");
    const overlay = await readOverlay(harness);
    expect(overlay?.specVersion).toBe(ACCEPTED_WORK_SPEC_VERSION);
    expect(overlay?.cohorts).toHaveLength(1);
    expect(overlay?.cohorts?.[0]).toMatchObject({
      servedModel: "claude-sonnet-5",
      servedEffort: "high",
      taskClass: "unknown",
      resolved: 1,
      accepted: 1,
      pending: 0,
      proven: false,
      held: null,
    });
  });

  it("leaves selection byte-for-byte identical with the producer on", async () => {
    const off = await boot(baseConfig());
    seedScoring(off);
    await off.runJob("refreshScores");
    const offScores = await off.ctx.state.get({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: PLUGIN_STATE_KEYS.modelScores,
    });

    const on = await boot(onConfig());
    seedScoring(on);
    await on.runJob("refreshScores");
    const onScores = await on.ctx.state.get({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: PLUGIN_STATE_KEYS.modelScores,
    });

    // The legacy artifact is untouched: same scores, same ledger. The overlay
    // lives under its own key (asserted above), never inside this shape.
    expect(onScores).toEqual(offScores);
  });

  it("attributes the served model, not the requested pin — and holds S-tier", async () => {
    // Pin says opus, but the closing run served sonnet: the cohort is
    // sonnet's and unheld. A second run proves the mirror: served opus on a
    // fallbackOnly row is held even with a clean accept.
    const harness = await boot(onConfig(), issue({
      assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5", variant: "high" } },
    }));
    seedScoring(harness, "claude-sonnet-5");
    await harness.runJob("refreshScores");
    const overlay = await readOverlay(harness);
    expect(overlay?.cohorts?.[0]).toMatchObject({ servedModel: "claude-sonnet-5", held: null });

    const sTierModels = MODELS.map((model) =>
      model.id === "claude-opus-5" ? { ...model, fallbackOnly: true } : model,
    );
    const held = await boot(onConfig({ models: sTierModels }));
    seedScoring(held, "claude-opus-5");
    await held.runJob("refreshScores");
    const heldOverlay = await readOverlay(held);
    expect(heldOverlay?.cohorts?.[0]).toMatchObject({ servedModel: "claude-opus-5", held: "fallback-only" });
  });

  it("leaves alias-ambiguous and unknown-effort runs in unknown cells", async () => {
    const harness = await boot(onConfig(), issue({
      // No effort key on the pin: served effort is unknown.
      assigneeAdapterOverrides: { adapterConfig: { model: "claude-sonnet-5" } },
    }));
    seedScoring(harness, "glm-5.3");
    await harness.runJob("refreshScores");
    const overlay = await readOverlay(harness);
    expect(overlay?.cohorts?.[0]).toMatchObject({ servedModel: "unknown", servedEffort: "unknown" });
  });
});

describe("acceptedWorkReport: read-only shadow report", () => {
  it("fails closed without company scope, like every other report tool", async () => {
    const harness = await boot(baseConfig());
    const result = (await harness.executeTool(TOOL_NAMES.acceptedWorkReport, {}, {
      ...runCtx,
      companyId: "" as never,
    })) as { content: unknown; data: unknown };
    expect(typeof result.content).toBe("string");
    expect(result.data).toMatchObject({ ok: false, error: "missing-company-scope" });
  });

  it("reports no-overlay-yet before the first enabled refresh", async () => {
    const harness = await boot(onConfig());
    const result = (await harness.executeTool(TOOL_NAMES.acceptedWorkReport, {}, runCtx)) as {
      content: unknown;
      data: unknown;
    };
    expect(result.data).toMatchObject({ ok: false, error: "no-report-yet" });
  });

  it("reports cohorts with posteriors after an enabled refresh", async () => {
    const harness = await boot(onConfig());
    seedScoring(harness);
    await harness.runJob("refreshScores");
    const result = (await harness.executeTool(TOOL_NAMES.acceptedWorkReport, {}, runCtx)) as {
      content: unknown;
      data: { cohorts: Array<Record<string, unknown>> };
    };
    expect(result.data.cohorts).toHaveLength(1);
    expect(result.data.cohorts[0]).toMatchObject({ servedModel: "claude-sonnet-5", accepted: 1, held: null });
    expect(typeof result.content).toBe("string");
  });

  it("normalizes corrupt stored state to no-report-yet instead of throwing", async () => {
    const harness = await boot(onConfig());
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.acceptedWorkOverlay },
      { specVersion: ACCEPTED_WORK_SPEC_VERSION, cohorts: [{ servedModel: "x" }], computedAt: NOW },
    );
    const result = (await harness.executeTool(TOOL_NAMES.acceptedWorkReport, {}, runCtx)) as {
      data: unknown;
    };
    expect(result.data).toMatchObject({ ok: false, error: "no-report-yet" });
  });
});
