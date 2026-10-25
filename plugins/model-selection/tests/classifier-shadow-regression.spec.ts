import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { SELECTION_CONFIG_SCHEMA } from "../src/config/schema.js";
import { PLUGIN_STATE_KEYS } from "../src/constants.js";
import { driftActive, parseShadowWindow } from "../src/engine/classifier-shadow.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

const COMPANY = "co-1";
const AGENT = "agent-1";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("classifier shadow drift configuration", () => {
  it.each([51, 100, Number.MAX_SAFE_INTEGER, 0, -1, 1.5, NaN, Infinity])(
    "falls back to a reachable drift threshold for driftMinN=%s",
    (driftMinN) => {
      const classification = resolveConfig({ classification: { driftMinN } }).classification;
      expect(classification.driftMinN).toBe(50);
      const window = parseShadowWindow({
        outcomes: Array.from({ length: 50 }, () => ({ t: "T1", b: null, a: null })),
      });
      expect(driftActive(window, classification.driftMinN, classification.driftT1Share)).toBe(true);
    },
  );

  it.each([1, 20, 50])("preserves a reachable driftMinN=%s", (driftMinN) => {
    expect(resolveConfig({ classification: { driftMinN } }).classification.driftMinN).toBe(driftMinN);
  });

  it("constrains the public configuration to a reachable drift threshold", () => {
    expect(SELECTION_CONFIG_SCHEMA.properties.classification.properties.driftMinN).toMatchObject({
      type: "integer", minimum: 1, maximum: 50, default: 50,
    });
  });
});

function issue(id: string): Issue {
  return {
    id,
    identifier: id,
    companyId: COMPANY,
    title: "Review PR #1234 against the written criteria",
    description: "Review the implementation against the criteria.",
    status: "todo",
    assigneeAgentId: AGENT,
    assigneeAdapterOverrides: null,
    checkoutRunId: null,
    executionRunId: null,
    labels: [],
    labelIds: [],
  } as unknown as Issue;
}

async function boot(cards: Issue[]) {
  const config = {
    selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true },
    models: MODELS,
    tierLabelIds: { T1: "lbl-T1", T2: "lbl-T2", T3: "lbl-T3" },
    classification: { enabled: true, baseUrl: "https://classifier.example.com", modelId: "classifier" },
  };
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    issues: cards,
    companies: [{ id: COMPANY, name: "Co" } as never],
    agents: [{
      id: AGENT,
      companyId: COMPANY,
      name: "Builder",
      urlKey: "builder",
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
    } as never],
  });
  const plugin = createPlugin();
  await plugin.definition.setup!(harness.ctx);
  await plugin.definition.onConfigChanged!(config, { companyId: COMPANY });
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: PROFILES, signals: NO_ESCALATION },
  );
  harness.ctx.http.fetch = async () => new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ tier: "T2", confidence: 0.9, exclusion: false, reason: "criteria" }) }],
  }), { headers: { "content-type": "application/json" } });
  return harness;
}

function rejectShadowState(harness: Awaited<ReturnType<typeof boot>>, operation: "get" | "set") {
  if (operation === "get") {
    const get = harness.ctx.state.get.bind(harness.ctx.state);
    harness.ctx.state.get = async (key) => {
      if (key.stateKey === PLUGIN_STATE_KEYS.classifierShadow) throw new Error("shadow read unavailable");
      return get(key);
    };
  } else {
    const set = harness.ctx.state.set.bind(harness.ctx.state);
    harness.ctx.state.set = async (key, value) => {
      if (key.stateKey === PLUGIN_STATE_KEYS.classifierShadow) throw new Error("shadow write unavailable");
      return set(key, value);
    };
  }
}

describe("classifier shadow state failures are telemetry-only", () => {
  it.each(["get", "set"] as const)("continues scheduled rows when shadow state.%s rejects", async (operation) => {
    const cards = [issue("i1"), issue("i2")];
    const harness = await boot(cards);
    harness.ctx.db.query = async () => cards.map((card) => ({
      id: card.id, identifier: card.identifier, status: card.status,
      title: card.title, description: card.description, agent_name: "Builder",
    })) as never;
    rejectShadowState(harness, operation);

    await harness.runJob("classifyIssues");

    for (const card of cards) {
      expect((await harness.ctx.issues.get(card.id, COMPANY))?.labelIds).toEqual(["lbl-T2"]);
      const notice = harness.activity.find((entry) => entry.entityId === card.id && entry.message.includes("classified this issue"));
      expect(notice?.metadata).toMatchObject({ tier: "T2", confidence: 0.9, reason: "criteria" });
      for (const key of ["baseline", "baselineRule", "baselineAgrees", "classifierDrift"]) {
        expect(notice?.metadata).not.toHaveProperty(key);
      }
    }
    expect(await harness.ctx.state.get({
      scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.classifierLabeledIssues,
    })).toEqual({ i1: "T2", i2: "T2" });
  });

  it.each(["get", "set"] as const)("keeps creation-time classification and pinning when shadow state.%s rejects", async (operation) => {
    const card = issue("i1");
    const harness = await boot([card]);
    rejectShadowState(harness, operation);

    await harness.emit("issue.created", { title: card.title }, { entityId: card.id, companyId: COMPANY, entityType: "issue" });

    const after = await harness.ctx.issues.get(card.id, COMPANY);
    expect(after?.labelIds).toEqual(["lbl-T2"]);
    expect(after?.assigneeAdapterOverrides).toMatchObject({ adapterConfig: { model: "claude-sonnet-5" } });
    const notice = harness.activity.find((entry) => entry.entityId === card.id && entry.message.includes("at card creation"));
    expect(notice?.metadata).toMatchObject({ tier: "T2", confidence: 0.9, reason: "criteria" });
    for (const key of ["baseline", "baselineRule", "baselineAgrees", "classifierDrift"]) {
      expect(notice?.metadata).not.toHaveProperty(key);
    }
  });
});
