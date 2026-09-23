import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";

import manifest from "../src/manifest.js";
import { PLUGIN_STATE_KEYS } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { buildCardLedger } from "../src/engine/scores.js";
import { MODELS, NO_ESCALATION, PROFILES } from "./fixtures.js";

const COMPANY = "co-1";
const AGENT = "agent-1";

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    companyId: COMPANY,
    name: "Founding Engineer",
    urlKey: "founding-engineer",
    role: "general",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    // The floor is the T3 model: any pin this suite asserts on must be a
    // DIFFERENT model, or the floor-equal skip fires and nothing is written.
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

function operatorPinLabel() {
  return { id: "lbl-op", companyId: COMPANY, name: "pin:operator", color: "#000", createdAt: new Date(0), updatedAt: new Date(0) };
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

async function boot(config: Record<string, unknown>, seedIssues: Issue[] = [], agents: unknown[] = [agentRow()]) {
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

/** Stub the classification HTTP call; record every invocation. */
function stubClassifier(harness: Awaited<ReturnType<typeof boot>>, tier: "T2" | null) {
  const calls: Array<{ url: string; body: string }> = [];
  harness.ctx.http.fetch = (async (url: string, init: { body?: string } | undefined) => {
    calls.push({ url, body: init?.body ?? "" });
    if (tier === null) {
      return {
        status: 503,
        headers: { get: () => "application/json" },
        redirected: false,
        text: async () => JSON.stringify({ error: "unavailable" }),
      };
    }
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

/**
 * TOG-3111 AC2 + the exposure-window cut: an `issue.created` event on an
 * assigned, unlabelled, idle card must classify, label AND pin in the same
 * tick — not wait for the 10-minute pass that the card's own dispatch makes
 * missable (the passes' row queries exclude cards with running runs).
 */
describe("TOG-3111 creation-time pin", () => {
  it("classifies, labels and pins an assigned unlabelled idle card on issue.created", async () => {
    const card = issue("i1");
    const harness = await boot(baseConfig(), [card]);
    const calls = stubClassifier(harness, "T2");

    await harness.emit("issue.created", { title: "A card" }, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    expect(calls).toHaveLength(1);
    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(after?.labelIds).toContain("lbl-T2");
    expect(pinnedModel(after as Issue)).toBe("claude-sonnet-5");
    const messages = harness.activity.map((entry) => entry.message);
    expect(messages.some((m) => m.includes("classified this issue as T2"))).toBe(true);
    expect(messages.some((m) => m.includes("TOG-3111") && m.includes("claude-sonnet-5"))).toBe(true);
  });

  it("labels at the classifier's tier but never writes an override while a run holds the card", async () => {
    // The exact first-turn race (TOG-3008): the card dispatched before the
    // event landed. A label is safe — it resets nothing — but an override on
    // a live card would reset a warm session.
    const card = issue("i1", { checkoutRunId: "run-1" });
    const harness = await boot(baseConfig(), [card]);
    stubClassifier(harness, "T2");

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(after?.labelIds).toContain("lbl-T2");
    expect(pinnedModel(after as Issue)).toBeNull();
  });

  it("leaves a card untouched when the classifier is unavailable (no label, no pin, no crash)", async () => {
    const card = issue("i1");
    const harness = await boot(baseConfig(), [card]);
    const calls = stubClassifier(harness, null);

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    expect(calls).toHaveLength(1);
    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(after?.labelIds ?? []).toHaveLength(0);
    expect(pinnedModel(after as Issue)).toBeNull();
  });

  it("does nothing on issue.created for a card that has no assignee yet", async () => {
    // `issue.created` carries no assignee (TOG-3008 §3); the assignment arm
    // below owns that card. The classifier must not even be called.
    const card = issue("i1", { assigneeAgentId: null });
    const harness = await boot(baseConfig(), [card]);
    const calls = stubClassifier(harness, "T2");

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    expect(calls).toHaveLength(0);
    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(pinnedModel(after as Issue)).toBeNull();
  });

  it("pins from the existing tier label on a fresh assignment, without classifying", async () => {
    // Cards are frequently created unassigned and assigned by a later PATCH:
    // `issue.created` fired too early to see the assignee, so the
    // `issue.updated` assignment arm (assigneeAgentId null -> agent) is the
    // other creation moment.
    const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
    const harness = await boot(baseConfig(), [card]);
    const calls = stubClassifier(harness, "T2");

    await harness.emit(
      "issue.updated",
      { changes: { assigneeAgentId: { from: null, to: AGENT } } },
      { entityId: "i1", companyId: COMPANY, entityType: "issue" },
    );

    expect(calls).toHaveLength(0); // label already present: no classification
    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(pinnedModel(after as Issue)).toBe("claude-opus-5");
    expect(harness.activity.some((entry) => entry.message.includes("issue.updated:assignment"))).toBe(true);
  });

  it("ignores an agent-to-agent reassignment (repinPass territory)", async () => {
    const card = issue("i1");
    const harness = await boot(baseConfig(), [card]);
    const calls = stubClassifier(harness, "T2");

    await harness.emit(
      "issue.updated",
      { changes: { assigneeAgentId: { from: "agent-0", to: AGENT } } },
      { entityId: "i1", companyId: COMPANY, entityType: "issue" },
    );

    expect(calls).toHaveLength(0);
    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(pinnedModel(after as Issue)).toBeNull();
  });

  it("never writes on a card that already carries a pin or pin:operator", async () => {
    const pinned = issue("i1", {
      assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
    });
    const operatorPinned = issue("i2", { labels: [operatorPinLabel()], labelIds: ["lbl-op"] });
    const harness = await boot(baseConfig(), [pinned, operatorPinned]);
    const calls = stubClassifier(harness, "T2");

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });
    await harness.emit("issue.created", {}, { entityId: "i2", companyId: COMPANY, entityType: "issue" });

    expect(calls).toHaveLength(0);
    expect(pinnedModel((await harness.ctx.issues.get("i1", COMPANY)) as Issue)).toBe("claude-opus-5");
    expect(pinnedModel((await harness.ctx.issues.get("i2", COMPANY)) as Issue)).toBeNull();
  });

  it("does nothing when classification.enabled is false (kill switch)", async () => {
    const card = issue("i1");
    const harness = await boot(baseConfig({ classification: { enabled: false } }), [card]);
    const calls = stubClassifier(harness, "T2");

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    expect(calls).toHaveLength(0);
    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(pinnedModel(after as Issue)).toBeNull();
  });

  it("writes no override when the label-tier pick equals the agent floor", async () => {
    // Same convention as labelOnlyPass/balancePass: the card already runs
    // exactly that model; a redundant override would only add churn.
    const card = issue("i1", { labels: [tierLabel("T3")], labelIds: ["lbl-T3"] });
    const harness = await boot(baseConfig(), [card]);
    const calls = stubClassifier(harness, "T2");

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    expect(calls).toHaveLength(0); // labelled already: classification skipped
    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(pinnedModel(after as Issue)).toBeNull();
  });
});

/**
 * TOG-3111 AC3: a card the router cannot pin must be VISIBLE — one activity
 * notice naming the outcome and the lane states — not a silent `continue`.
 */
describe("TOG-3111 unpinnable-card visibility", () => {
  function exhaustedLedger(laneId: string) {
    return {
      [laneId]: {
        laneId,
        fetchedAt: "2026-09-13T00:00:00.000Z",
        observation: null,
        error: null,
        verdict: {
          laneId,
          observedAt: "2026-09-13T00:00:00.000Z",
          state: "exhausted",
          serviceable: false,
          score: null,
          accounts: [],
          knownAccountCount: 1,
          knownWeight: 1,
          serviceableAccountCount: 0,
          urgentResetAt: null,
          reason: "exhausted",
        },
      },
    };
  }

  async function bootAllLanesDead() {
    const models = MODELS.map((m) => ({ ...m, laneId: "lane-all" }));
    const card = issue("i1", { labels: [tierLabel("T2")], labelIds: ["lbl-T2"] });
    const harness = await boot(baseConfig({ models, pacing: { mode: "enforce" } }), [card]);
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
      exhaustedLedger("lane-all") as never,
    );
    harness.ctx.db.query = (async (query: string) => {
      if (query.includes("from issues i")) return [{ id: "i1", identifier: "i1", status: "todo" }];
      return [];
    }) as typeof harness.ctx.db.query;
    return harness;
  }

  it("labelOnlyPass surfaces a no-pick card with lane states in one activity notice", async () => {
    const harness = await bootAllLanesDead();

    await harness.runJob("labelOnlyPass");

    const notices = harness.activity.filter((entry) => entry.message.includes("cannot pin this card"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain("lane-all");
    expect(notices[0]?.message).toMatch(/no-eligible-model|tier-exhausted/);
    expect(notices[0]?.entityId).toBe("i1");
  });

  it("reports quality exclusions and expiry instead of asking for lane recovery", async () => {
    const models = MODELS.filter((m) => m.tier === "T1");
    expect(models.length).toBeGreaterThan(0);
    const card = issue("quality", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
    const harness = await boot(baseConfig({ models }), [card]);
    const now = Date.now();
    const cardLedger = buildCardLedger(models.flatMap((model) => Array.from({ length: 8 }, () => ({
      modelId: model.id, tier: "T1" as const, closedAtMs: now - 15 * 24 * 60 * 60 * 1000,
      rejected: true, costUsd: 1, runCount: 1, foreignRun: false,
    }))), now, {}, {});
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.modelScores },
      { cardLedger, modelScores: [], computedAt: new Date(now).toISOString() },
    );
    harness.ctx.db.query = (async (query: string) => query.includes("from issues i")
      ? [{ id: "quality", identifier: "quality", status: "todo" }] : []) as typeof harness.ctx.db.query;
    await harness.runJob("labelOnlyPass");
    const notices = harness.activity.filter((entry) => entry.message.includes("cannot pin this card"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain("no-eligible-model");
    expect(notices[0]?.message).toContain("[card-accept-rate]");
    expect(notices[0]?.message).toContain("0 of 8 mature T1 cards");
    expect(notices[0]?.message).toContain("evidence expires");
    expect(notices[0]?.message).toContain("eligibility evidence changes or expires");
    expect(notices[0]?.message).not.toContain("until a lane recovers");
    expect(notices[0]?.metadata?.rejections).toHaveLength(models.length);
  });

  it("throttles the repeat notice within NO_ELIGIBLE_NOTICE_THROTTLE_MS", async () => {
    const harness = await bootAllLanesDead();

    await harness.runJob("labelOnlyPass");
    await harness.runJob("labelOnlyPass");

    const notices = harness.activity.filter((entry) => entry.message.includes("cannot pin this card"));
    expect(notices).toHaveLength(1);
    // The throttle state itself is recorded per issue.
    const state = await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: PLUGIN_STATE_KEYS.noEligibleNotices,
    });
    expect(state).toHaveProperty("i1");
  });

  it("balancePass's unpinned branch surfaces the same notice", async () => {
    const models = MODELS.map((m) => ({ ...m, laneId: "lane-all" }));
    const card = issue("i1", { labels: [tierLabel("T3")], labelIds: ["lbl-T3"] });
    const harness = await boot(baseConfig({ models, pacing: { mode: "enforce" } }), [card]);
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
      exhaustedLedger("lane-all") as never,
    );
    harness.ctx.db.query = (async (query: string) => {
      if (query.includes("from issues i")) return [{ id: "i1", identifier: "i1", status: "todo" }];
      return [];
    }) as typeof harness.ctx.db.query;

    await harness.runJob("balancePass");

    const notices = harness.activity.filter((entry) => entry.message.includes("cannot pin this card"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain("lane-all");
  });
});
