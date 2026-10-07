import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { PLUGIN_STATE_KEYS } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { SELECTION_CONFIG_SCHEMA } from "../src/config/schema.js";
import { isAgentExempt, resolveConfig, validateConfig } from "../src/config/resolve.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

const COMPANY = "co-1";
const AGENT = "agent-1";
// A designated agent: a real UUID, as the config schema requires.
const EXEMPT_AGENT = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function agentRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId: COMPANY,
    name: id === EXEMPT_AGENT ? "Designated Agent" : "Founding Engineer",
    urlKey: id === EXEMPT_AGENT ? "designated-agent" : "founding-engineer",
    role: "general",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: { model: "claude-haiku-4-5-20251001" },
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as never;
}

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    companyId: COMPANY,
    title: "A card",
    description: "A description with enough words for the classifier",
    status: "todo",
    assigneeAgentId: AGENT,
    assigneeAdapterOverrides: null,
    checkoutRunId: null,
    executionRunId: null,
    labels: [],
    labelIds: [],
    ...overrides,
  } as unknown as Issue;
}

function tierLabel(tier: "T1" | "T2" | "T3") {
  return { id: `lbl-${tier}`, companyId: COMPANY, name: `tier:${tier}`, color: "#000", createdAt: new Date(0), updatedAt: new Date(0) };
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true },
    models: MODELS,
    tierLabelIds: { T1: "lbl-T1", T2: "lbl-T2", T3: "lbl-T3" },
    classification: {
      enabled: true,
      baseUrl: "https://api.anthropic.example.com",
      modelId: "claude-sonnet-5",
    },
    ...overrides,
  };
}

function exemptConfig(overrides: Record<string, unknown> = {}) {
  const config = baseConfig(overrides);
  return {
    ...config,
    selection: { ...(config.selection as Record<string, unknown>), exemptAgentIds: [EXEMPT_AGENT] },
  };
}

async function boot(config: Record<string, unknown>, seedIssues: Issue[] = [], agents: unknown[] = [agentRow(AGENT), agentRow(EXEMPT_AGENT)]) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ issues: seedIssues, agents: agents as never, companies: [{ id: COMPANY, name: "Co" } as never] });
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

function stubClassifier(harness: Awaited<ReturnType<typeof boot>>, tier: "T1" | "T2" | "T3") {
  const calls: Array<{ url: string; body: string }> = [];
  harness.ctx.http.fetch = (async (url: string, init: { body?: string } | undefined) => {
    calls.push({ url, body: init?.body ?? "" });
    return {
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      redirected: false,
      text: async () =>
        JSON.stringify({
          content: [{ type: "text", text: `{"tier":"${tier}","confidence":0.9,"exclusion":false,"reason":"x"}` }],
        }),
    };
  }) as typeof harness.ctx.http.fetch;
  return calls;
}

function pinnedModel(of: Issue): string | null {
  const overrides = of.assigneeAdapterOverrides as { adapterConfig?: { model?: string } } | null;
  const model = overrides?.adapterConfig?.model;
  return typeof model === "string" ? model : null;
}

describe("exemptAgentIds config", () => {
  it("defaults to empty (no exemptions)", () => {
    expect(resolveConfig(undefined).selection.exemptAgentIds).toEqual([]);
  });

  it("resolves a configured UUID list", () => {
    const config = resolveConfig({ selection: { exemptAgentIds: [EXEMPT_AGENT] } });
    expect(config.selection.exemptAgentIds).toEqual([EXEMPT_AGENT]);
    expect(validateConfig(config).errors).toEqual([]);
  });

  it("normalizes UUID letter case on both config and assignee lookup", () => {
    const id = "11111111-2222-3333-4444-aaaaaaaaaaaa";
    const config = resolveConfig({ selection: { exemptAgentIds: [id.toUpperCase()] } });
    expect(validateConfig(config).errors).toEqual([]);
    expect(config.selection.exemptAgentIds).toEqual([id]);
    expect(isAgentExempt(id, config)).toBe(true);
    expect(isAgentExempt(id.toUpperCase(), config)).toBe(true);
    expect(isAgentExempt("11111111-2222-3333-4444-bbbbbbbbbbbb", config)).toBe(false);
  });

  it("rejects non-UUID items", () => {
    const config = resolveConfig({ selection: { exemptAgentIds: ["agent-1", "not-a-uuid"] } });
    const { errors } = validateConfig(config);
    expect(errors.some((e) => e.includes("selection.exemptAgentIds[0]") && e.includes("UUID"))).toBe(true);
    expect(errors.some((e) => e.includes("selection.exemptAgentIds[1]") && e.includes("UUID"))).toBe(true);
  });

  it("declares the key in the JSON schema with a UUID items format and an empty default, keeping unknown keys rejected", () => {
    const selection = SELECTION_CONFIG_SCHEMA.properties.selection as unknown as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    // Unknown keys are still rejected: the host drops a config that smuggles
    // an undeclared selection key instead of silently ignoring it.
    expect(selection.additionalProperties).toBe(false);
    const exempt = selection.properties.exemptAgentIds as unknown as {
      type: string;
      items: { type: string; format: string };
      default: unknown;
    };
    expect(exempt.type).toBe("array");
    expect(exempt.items).toMatchObject({ type: "string", format: "uuid" });
    expect(exempt.default).toEqual([]);
  });

  it("isAgentExempt matches only listed assignees", () => {
    const config = resolveConfig({ selection: { exemptAgentIds: [EXEMPT_AGENT] } });
    expect(isAgentExempt(EXEMPT_AGENT, config)).toBe(true);
    expect(isAgentExempt(AGENT, config)).toBe(false);
    expect(isAgentExempt(null, config)).toBe(false);
    expect(isAgentExempt(undefined, config)).toBe(false);
    expect(isAgentExempt(EXEMPT_AGENT, resolveConfig(undefined))).toBe(false);
  });
});

describe("creation-time pin with an exempt assignee", () => {
  it("skips the first pin for an exempt agent but pins a non-exempt card", async () => {
    const exemptCard = issue("exempt-1", { assigneeAgentId: EXEMPT_AGENT });
    const normalCard = issue("normal-1", { assigneeAgentId: AGENT });
    const harness = await boot(exemptConfig(), [exemptCard, normalCard]);
    stubClassifier(harness, "T2");
    const infoLogs: string[] = [];
    const info = harness.ctx.logger.info;
    harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
      infoLogs.push(message);
      return info(message, metadata);
    }) as typeof harness.ctx.logger.info;

    await harness.emit("issue.created", { title: "A card" }, { entityId: "exempt-1", companyId: COMPANY, entityType: "issue" });
    await harness.emit("issue.created", { title: "A card" }, { entityId: "normal-1", companyId: COMPANY, entityType: "issue" });

    // The exempt card is still classified and labelled — only the pin is skipped.
    const afterExempt = (await harness.ctx.issues.get("exempt-1", COMPANY)) as Issue;
    expect(afterExempt?.labelIds).toContain("lbl-T2");
    expect(pinnedModel(afterExempt)).toBeNull();
    expect(infoLogs.some((m) => m.includes("creation-time pin skipped: agent exempt"))).toBe(true);
    const exemptEntries = harness.activity.filter((entry) => entry.entityId === "exempt-1");
    expect(exemptEntries.some((entry) => entry.message.includes("agent exempt"))).toBe(true);
    // The exemption is recorded in the decision trace, so the skip is never silent.
    const exemptTrace = exemptEntries.flatMap((entry) => ((entry.metadata as { trace?: string[] } | null)?.trace ?? []));
    expect(exemptTrace.some((line) => line.includes("exempt"))).toBe(true);

    // The non-exempt control pins exactly as before.
    const afterNormal = (await harness.ctx.issues.get("normal-1", COMPANY)) as Issue;
    expect(pinnedModel(afterNormal)).toBe("claude-sonnet-5");
  });
});

describe("scheduled passes skip exempt cards", () => {
  it("labelOnlyPass pins a labelled non-exempt card but leaves an exempt one unpinned", async () => {
    const exemptCard = issue("exempt-1", {
      assigneeAgentId: EXEMPT_AGENT,
      labels: [tierLabel("T1")],
      labelIds: ["lbl-T1"],
    });
    const normalCard = issue("normal-1", {
      assigneeAgentId: AGENT,
      labels: [tierLabel("T1")],
      labelIds: ["lbl-T1"],
    });
    const harness = await boot(exemptConfig(), [exemptCard, normalCard]);
    harness.ctx.db.query = (async (query: string) => {
      if (query.includes("from issues i")) {
        return [
          { id: "exempt-1", identifier: "exempt-1", status: "todo" },
          { id: "normal-1", identifier: "normal-1", status: "todo" },
        ];
      }
      return [];
    }) as typeof harness.ctx.db.query;

    await harness.runJob("labelOnlyPass");

    expect(pinnedModel((await harness.ctx.issues.get("exempt-1", COMPANY)) as Issue)).toBeNull();
    expect(pinnedModel((await harness.ctx.issues.get("normal-1", COMPANY)) as Issue)).toBe("claude-opus-5");
  });

  it("repinPass leaves a demoted exempt pin alone but repins the non-exempt control", async () => {
    const opus = MODELS.find((m) => m.id === "claude-opus-5")!;
    const models = [...MODELS, { ...opus, id: "claude-opus-5-alt" }];
    const mkCard = (id: string, assignee: string) =>
      issue(id, {
        assigneeAgentId: assignee,
        status: "in_progress",
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
    const harness = await boot(exemptConfig({ models }), [mkCard("exempt-1", EXEMPT_AGENT), mkCard("normal-1", AGENT)]);
    // Demote the pinned model with lane healthy: a routine (non-hard-stop)
    // repin. The exempt card must keep it; the control must move.
    const demoted = { n: 20, ok: 5, failInfra: 0, failModel: 15, tmo: 0, nEff: 20, pObs: 0.25, p: 0.25, capable: false, proven: true, costPerSuccessUsd: null, medMin: null, rework: 10 };
    const unproven = { n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.8, capable: null, proven: false, costPerSuccessUsd: null, medMin: null, rework: 0 };
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.modelScores },
      {
        modelScores: [{
          modelId: "claude-opus-5",
          aaIndex: 51,
          priorP: 0.9,
          tiers: { T1: demoted, T2: unproven, T3: unproven },
          overall: demoted,
        }],
        cardLedger: {},
      },
    );
    harness.ctx.db.query = (async (query: string) => {
      if (query.includes("from issues i")) {
        return [
          { id: "exempt-1", identifier: "exempt-1", status: "in_progress", updated_at: new Date(NOW).toISOString() },
          { id: "normal-1", identifier: "normal-1", status: "in_progress", updated_at: new Date(NOW).toISOString() },
        ];
      }
      return [];
    }) as typeof harness.ctx.db.query;

    await harness.runJob("repinPass");

    expect(pinnedModel((await harness.ctx.issues.get("exempt-1", COMPANY)) as Issue)).toBe("claude-opus-5");
    expect(pinnedModel((await harness.ctx.issues.get("normal-1", COMPANY)) as Issue)).toBe("claude-opus-5-alt");
  });

  it("balancePass leaves a demoted exempt pin alone but balances the non-exempt control", async () => {
    const opus = MODELS.find((m) => m.id === "claude-opus-5")!;
    const models = [...MODELS, { ...opus, id: "claude-opus-5-alt" }];
    const mkCard = (id: string, assignee: string) =>
      issue(id, {
        assigneeAgentId: assignee,
        status: "in_progress",
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
    const harness = await boot(exemptConfig({ models }), [mkCard("exempt-1", EXEMPT_AGENT), mkCard("normal-1", AGENT)]);
    const demoted = { n: 20, ok: 5, failInfra: 0, failModel: 15, tmo: 0, nEff: 20, pObs: 0.25, p: 0.25, capable: false, proven: true, costPerSuccessUsd: null, medMin: null, rework: 10 };
    const unproven = { n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.8, capable: null, proven: false, costPerSuccessUsd: null, medMin: null, rework: 0 };
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.modelScores },
      {
        modelScores: [{
          modelId: "claude-opus-5",
          aaIndex: 51,
          priorP: 0.9,
          tiers: { T1: demoted, T2: unproven, T3: unproven },
          overall: demoted,
        }],
        cardLedger: {},
      },
    );
    harness.ctx.db.query = (async (query: string) => {
      if (query.includes("max(updated_at)")) return [{ max_updated: new Date(NOW).toISOString() }];
      if (query.includes("from issues i")) {
        return [
          { id: "exempt-1", identifier: "exempt-1" },
          { id: "normal-1", identifier: "normal-1" },
        ];
      }
      return [];
    }) as typeof harness.ctx.db.query;

    await harness.runJob("balancePass");

    expect(pinnedModel((await harness.ctx.issues.get("exempt-1", COMPANY)) as Issue)).toBe("claude-opus-5");
    expect(pinnedModel((await harness.ctx.issues.get("normal-1", COMPANY)) as Issue)).toBe("claude-opus-5-alt");
  });

  it("repinPass still repins an exempt card on a serviceability hard stop", async () => {
    const base = MODELS.find((m) => m.id === "claude-opus-5")!;
    const models = [
      { ...base, laneId: "lane-dead", contextWindow: 200_000 },
      { ...base, id: "claude-opus-5-alt", tier: "T1" as const, laneId: "lane-live", contextWindow: 200_000 },
      ...MODELS.filter((m) => m.id !== "claude-opus-5"),
    ];
    const mkCard = (id: string, assignee: string) =>
      issue(id, {
        assigneeAgentId: assignee,
        status: "in_progress",
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
    const harness = await boot(
      exemptConfig({ models, pacing: { mode: "enforce" } }),
      [mkCard("exempt-1", EXEMPT_AGENT), mkCard("normal-1", AGENT)],
    );
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
      {
        "lane-dead": {
          laneId: "lane-dead",
          verdict: {
            laneId: "lane-dead",
            state: "exhausted",
            serviceable: false,
            serviceableAccountCount: 0,
            accounts: [],
            knownAccountCount: 1,
            knownWeight: 1,
          },
        },
      } as never,
    );
    harness.ctx.db.query = (async (query: string) => {
      if (query.includes("from issues i")) {
        return [
          { id: "exempt-1", identifier: "exempt-1", status: "in_progress", updated_at: new Date(NOW).toISOString() },
          { id: "normal-1", identifier: "normal-1", status: "in_progress", updated_at: new Date(NOW).toISOString() },
        ];
      }
      return [];
    }) as typeof harness.ctx.db.query;

    await harness.runJob("repinPass");

    // The hard-stop exception moves even the exempt card off the dead lane.
    expect(pinnedModel((await harness.ctx.issues.get("exempt-1", COMPANY)) as Issue)).toBe("claude-opus-5-alt");
    expect(pinnedModel((await harness.ctx.issues.get("normal-1", COMPANY)) as Issue)).toBe("claude-opus-5-alt");
  });

  it("balancePass leaves an exempt unpinned labelled card on the agent model but pins the control", async () => {
    const exemptCard = issue("exempt-1", {
      assigneeAgentId: EXEMPT_AGENT,
      status: "in_progress",
      labels: [tierLabel("T3")],
      labelIds: ["lbl-T3"],
      assigneeAdapterOverrides: null,
    });
    const normalCard = issue("normal-1", {
      assigneeAgentId: AGENT,
      status: "in_progress",
      labels: [tierLabel("T3")],
      labelIds: ["lbl-T3"],
      assigneeAdapterOverrides: null,
    });
    const harness = await boot(exemptConfig(), [exemptCard, normalCard]);
    harness.ctx.db.query = (async (query: string) => {
      if (query.includes("max(updated_at)")) return [{ max_updated: new Date(NOW).toISOString() }];
      if (query.includes("from issues i")) {
        return [
          { id: "exempt-1", identifier: "exempt-1" },
          { id: "normal-1", identifier: "normal-1" },
        ];
      }
      return [];
    }) as typeof harness.ctx.db.query;

    await harness.runJob("balancePass");

    expect(pinnedModel((await harness.ctx.issues.get("exempt-1", COMPANY)) as Issue)).toBeNull();
    // Unpinned + labelled controls get the balanced T1-class pin.
    expect(pinnedModel((await harness.ctx.issues.get("normal-1", COMPANY)) as Issue)).toBe("claude-opus-5");
  });
});
