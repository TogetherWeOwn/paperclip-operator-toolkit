import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveConfig, validateConfig } from "../src/config/resolve.js";
import { SELECTION_CONFIG_SCHEMA } from "../src/config/schema.js";
import { PLUGIN_STATE_KEYS } from "../src/constants.js";
import { resolveRunDecision, type ResolveRunModelParams, type ResolveRunModelResult, type RunResolveInput, type RunResolveSnapshot } from "../src/engine/run-resolve.js";
import { isExemptAgent, selectModel } from "../src/engine/select.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config as selectionConfig } from "./fixtures.js";

/**
 * `selection.exemptAgentIds`: the router makes no first pin and no repin for a
 * card or run whose assignee is on the list. Every writer is covered by its own
 * test, and each exempt case has a control that is NOT exempt and does write,
 * so "no pin" can never be a vacuous pass on a harness that never reached the
 * write.
 */

const COMPANY = "co-1";
const REVIEWER = "11111111-2222-4333-8444-555555555555";
const ENGINEER = "agent-1";

beforeEach(() => {
  // Date-only, as the sibling suites: seeded PROFILES must stay inside the 14-day guard.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("selection.exemptAgentIds: config", () => {
  it("defaults to an empty list, so an unconfigured install exempts nobody", () => {
    expect(resolveConfig({}).selection.exemptAgentIds).toEqual([]);
    expect(resolveConfig({ selection: {} }).selection.exemptAgentIds).toEqual([]);
  });

  it("keeps trimmed, de-duplicated, non-empty string ids in first-seen order", () => {
    const resolved = resolveConfig({
      selection: { exemptAgentIds: [` ${REVIEWER} `, REVIEWER, "", "   ", 7, null, "agent-b"] },
    });
    expect(resolved.selection.exemptAgentIds).toEqual([REVIEWER, "agent-b"]);
  });

  it("lowercases entries at read, so an uppercase paste still exempts the agent", () => {
    // REVIEWER is digits-only, so it cannot exercise case; this id has hex letters.
    const lower = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const resolved = resolveConfig({ selection: { exemptAgentIds: [lower.toUpperCase()] } });
    expect(resolved.selection.exemptAgentIds).toEqual([lower]);
    expect(isExemptAgent(resolved.selection.exemptAgentIds, lower)).toBe(true);
    const validated = validateConfig(resolveConfig({ models: MODELS, selection: { exemptAgentIds: [lower.toUpperCase()] } }));
    expect(validated.errors).toEqual([]);
    expect(validated.warnings.some((warning) => warning.includes("exemptAgentIds"))).toBe(false);
  });

  it("de-duplicates entries that differ only by case, keeping the first", () => {
    const lower = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const resolved = resolveConfig({ selection: { exemptAgentIds: [lower.toUpperCase(), lower] } });
    expect(resolved.selection.exemptAgentIds).toEqual([lower]);
  });

  it("treats a non-array value as no exemption rather than throwing", () => {
    expect(resolveConfig({ selection: { exemptAgentIds: REVIEWER } }).selection.exemptAgentIds).toEqual([]);
  });

  it("is declared in the config schema as a unique string array defaulting to empty", () => {
    const property = (SELECTION_CONFIG_SCHEMA.properties.selection.properties as Record<string, unknown>).exemptAgentIds;
    expect(property).toMatchObject({
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
      default: [],
    });
  });

  it("is a manifest-declared config key, so the host does not reject a config that sets it", () => {
    const selection = (manifest.instanceConfigSchema as { properties: { selection: { properties: Record<string, unknown> } } })
      .properties.selection.properties;
    expect(selection).toHaveProperty("exemptAgentIds");
  });

  it("warns, without failing, on an entry that is not a full agent UUID", () => {
    const truncated = validateConfig(resolveConfig({ models: MODELS, selection: { exemptAgentIds: ["11111111"] } }));
    expect(truncated.errors).toEqual([]);
    expect(truncated.warnings.some((warning) => warning.includes("exemptAgentIds") && warning.includes("11111111"))).toBe(true);

    const full = validateConfig(resolveConfig({ models: MODELS, selection: { exemptAgentIds: [REVIEWER] } }));
    expect(full.warnings.some((warning) => warning.includes("exemptAgentIds"))).toBe(false);
  });
});

describe("selection.exemptAgentIds: isExemptAgent", () => {
  it("is true only for an exact listed id", () => {
    expect(isExemptAgent([REVIEWER], REVIEWER)).toBe(true);
    expect(isExemptAgent([REVIEWER], ENGINEER)).toBe(false);
    expect(isExemptAgent([REVIEWER], `${REVIEWER}x`)).toBe(false);
  });

  it("exempts nobody when the list is absent or empty, or when there is no assignee", () => {
    expect(isExemptAgent(undefined, REVIEWER)).toBe(false);
    expect(isExemptAgent([], REVIEWER)).toBe(false);
    expect(isExemptAgent([REVIEWER], null)).toBe(false);
    expect(isExemptAgent([REVIEWER], undefined)).toBe(false);
    expect(isExemptAgent([""], "")).toBe(false);
  });
});

describe("selection.exemptAgentIds: selectModel", () => {
  const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };
  const card = { issueId: "i1", labelNames: ["tier:T2"] as string[] };

  it("holds an exempt assignee at its own model: no model, no write-eligible outcome", () => {
    const decision = selectModel({
      ...base,
      descriptor: { ...card, assigneeAgentId: REVIEWER },
      config: selectionConfig({ enforcementEnabled: true, exemptAgentIds: [REVIEWER] }),
    });
    expect(decision.outcome).toBe("held-at-floor");
    expect(decision.modelId).toBeNull();
    expect(decision.heldReason).toContain("exemptAgentIds");
    expect(decision.trace.some((line) => line.includes("exemptAgentIds"))).toBe(true);
  });

  it("holds an exempt assignee ahead of the sticky and operator-override branches, both of which can end in a pin", () => {
    const decision = selectModel({
      ...base,
      descriptor: { ...card, assigneeAgentId: REVIEWER, stickyModelId: "claude-opus-5" },
      config: selectionConfig({
        enforcementEnabled: true,
        exemptAgentIds: [REVIEWER],
        operatorOverrideModelId: "claude-sonnet-5",
      }),
    });
    expect(decision.outcome).toBe("held-at-floor");
    expect(decision.modelId).toBeNull();
  });

  it("leaves a non-exempt assignee exactly as it was: same decision as with no list at all", () => {
    const descriptor = { ...card, assigneeAgentId: ENGINEER };
    const without = selectModel({ ...base, descriptor, config: selectionConfig({ enforcementEnabled: true }) });
    const withOthers = selectModel({
      ...base,
      descriptor,
      config: selectionConfig({ enforcementEnabled: true, exemptAgentIds: [REVIEWER] }),
    });
    expect(without.outcome).toBe("selected");
    expect(withOthers).toEqual(without);
  });

  it("leaves a decision with the list absent or empty exactly as it was, exempt id or not", () => {
    const descriptor = { ...card, assigneeAgentId: REVIEWER };
    const absent = selectModel({ ...base, descriptor, config: selectionConfig({ enforcementEnabled: true }) });
    const empty = selectModel({
      ...base,
      descriptor,
      config: selectionConfig({ enforcementEnabled: true, exemptAgentIds: [] }),
    });
    expect(absent.outcome).toBe("selected");
    expect(empty).toEqual(absent);
  });

  it("never exempts an unassigned card", () => {
    const decision = selectModel({
      ...base,
      descriptor: { ...card, assigneeAgentId: null },
      config: selectionConfig({ enforcementEnabled: true, exemptAgentIds: [REVIEWER] }),
    });
    expect(decision.outcome).toBe("selected");
  });
});

describe("selection.exemptAgentIds: run-scoped decision", () => {
  function snapshot(selection: Record<string, unknown>): RunResolveSnapshot {
    return {
      config: resolveConfig({
        selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true, ...selection },
        models: MODELS,
        runResolve: { enabled: true },
      }),
      profiles: PROFILES,
      signals: NO_ESCALATION,
      laneLedger: {},
      operatorOverrides: {},
      cardLedger: {},
      modelScores: {},
      laneOutageOverride: null,
      zaiPaceOverride: null,
      pinsWeightByLane: {},
      availabilityRaw: null,
      laneEvidence: { lanes: [], windowHours: 24, unreadableReason: null },
      loadedAtMs: NOW,
    };
  }

  function input(agentId: string, selection: Record<string, unknown>): RunResolveInput {
    return {
      params: {
        runId: "run-1",
        companyId: COMPANY,
        agentId,
        issueId: "issue-1",
        adapterType: "claude_local",
        invocationSource: "assignment",
        wakeReason: null,
        agentDefaultModel: "claude-opus-5",
        previous: null,
        issueOverrideModel: null,
        deadlineMs: 1500,
      },
      issue: { labelNames: ["tier:T2"], priority: null, title: "Review a PR", status: "todo" },
      agent: { name: "Reviewer", adapterConfig: {} },
      snapshot: snapshot(selection),
      prior: null,
      classifiedTier: null,
      lastRunPeakTokens: null,
      now: NOW,
      newDecisionId: () => "decision-fixed",
    };
  }

  it("keeps an exempt agent's own model: the hook never switches it", () => {
    const resolution = resolveRunDecision(input(REVIEWER, { exemptAgentIds: [REVIEWER] }));
    expect(resolution).toMatchObject({ kind: "keep" });
    expect(resolution.kind === "keep" && resolution.reason).toContain("exemptAgentIds");
  });

  it("still decides for a non-exempt agent, and with the list absent", () => {
    expect(resolveRunDecision(input(ENGINEER, { exemptAgentIds: [REVIEWER] })).kind).toBe("decide");
    expect(resolveRunDecision(input(REVIEWER, {})).kind).toBe("decide");
  });
});

// --- worker: every writer -----------------------------------------------------

function agentRow(id: string, name: string) {
  return {
    id,
    companyId: COMPANY,
    name,
    urlKey: name.toLowerCase(),
    role: "general",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    // The floor is the T3 model: a pin this suite asserts on must be a DIFFERENT
    // model, or the floor-equal skip fires and nothing is written.
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
  } as never;
}

function tierLabel(tier: "T1" | "T2" | "T3") {
  return { id: `lbl-${tier}`, companyId: COMPANY, name: `tier:${tier}`, color: "#000", createdAt: new Date(0), updatedAt: new Date(0) };
}

function card(id: string, assignee: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    companyId: COMPANY,
    title: "A card",
    description: "A description with enough words for the classifier",
    status: "todo",
    assigneeAgentId: assignee,
    assigneeAdapterOverrides: null,
    checkoutRunId: null,
    executionRunId: null,
    labels: [],
    labelIds: [],
    ...overrides,
  } as unknown as Issue;
}

function workerConfig(selection: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true, ...selection },
    models: MODELS,
    tierLabelIds: { T1: "lbl-T1", T2: "lbl-T2", T3: "lbl-T3" },
    classification: { enabled: true, baseUrl: "https://api.anthropic.example.com", modelId: "claude-sonnet-5" },
    ...extra,
  };
}

async function boot(cfg: Record<string, unknown>, issues: Issue[]) {
  const harness = createTestHarness({ manifest, config: cfg });
  harness.seed({
    issues,
    agents: [agentRow(ENGINEER, "Founding Engineer"), agentRow(REVIEWER, "Reviewer")],
    companies: [{ id: COMPANY, name: "Co" } as never],
  });
  const plugin = createPlugin();
  await plugin.definition.setup?.(harness.ctx);
  await plugin.definition.onConfigChanged?.(cfg, { companyId: COMPANY });
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: PROFILES, signals: NO_ESCALATION },
  );
  return { harness, plugin };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** Stub the classification HTTP call and record every invocation. */
function stubClassifier(harness: Booted["harness"], tier: "T1" | "T2" | "T3") {
  const calls: string[] = [];
  harness.ctx.http.fetch = (async (url: string) => {
    calls.push(url);
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

/** Record every `issues.update` patch, so "no pin" means no write by ANY call, not just the final state. */
function recordUpdates(harness: Booted["harness"]) {
  const patches: Array<{ issueId: string; patch: Record<string, unknown> }> = [];
  const original = harness.ctx.issues.update.bind(harness.ctx.issues);
  harness.ctx.issues.update = (async (...args: Parameters<typeof original>) => {
    patches.push({ issueId: args[0], patch: args[1] as unknown as Record<string, unknown> });
    return original(...args);
  }) as typeof harness.ctx.issues.update;
  return {
    patches,
    overrideWrites: () => patches.filter((entry) => "assigneeAdapterOverrides" in entry.patch),
  };
}

function pinnedModel(of: Issue | null | undefined): string | null {
  const overrides = of?.assigneeAdapterOverrides as { adapterConfig?: { model?: string } } | null | undefined;
  const model = overrides?.adapterConfig?.model;
  return typeof model === "string" ? model : null;
}

const EVENT = { entityId: "i1", companyId: COMPANY, entityType: "issue" } as const;

describe("selection.exemptAgentIds: creation-time pin", () => {
  it("makes no first pin on issue.created for an exempt assignee, and spends no classifier call", async () => {
    const { harness } = await boot(workerConfig({ exemptAgentIds: [REVIEWER] }), [card("i1", REVIEWER)]);
    const calls = stubClassifier(harness, "T2");
    const updates = recordUpdates(harness);

    await harness.emit("issue.created", { title: "A card" }, EVENT);

    expect(calls).toHaveLength(0);
    expect(updates.patches).toHaveLength(0);
    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBeNull();
  });

  it("makes no first pin when an exempt agent is assigned to an existing card", async () => {
    const labelled = card("i1", REVIEWER, { labels: [tierLabel("T2")], labelIds: ["lbl-T2"] } as Partial<Issue>);
    const { harness } = await boot(workerConfig({ exemptAgentIds: [REVIEWER] }), [labelled]);
    const updates = recordUpdates(harness);

    await harness.emit("issue.updated", { changes: { assigneeAgentId: { from: null, to: REVIEWER } } }, EVENT);

    expect(updates.overrideWrites()).toHaveLength(0);
    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBeNull();
  });

  it("still pins a non-exempt assignee on the same event (control)", async () => {
    const { harness } = await boot(workerConfig({ exemptAgentIds: [REVIEWER] }), [card("i1", ENGINEER)]);
    const calls = stubClassifier(harness, "T2");

    await harness.emit("issue.created", { title: "A card" }, EVENT);

    expect(calls).toHaveLength(1);
    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBe("claude-sonnet-5");
  });

  it("still pins an assignee that would be exempt when the list is absent (control)", async () => {
    const { harness } = await boot(workerConfig({}), [card("i1", REVIEWER)]);
    const calls = stubClassifier(harness, "T2");

    await harness.emit("issue.created", { title: "A card" }, EVENT);

    expect(calls).toHaveLength(1);
    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBe("claude-sonnet-5");
  });

  it("still pins an assignee that would be exempt when the list is empty (control)", async () => {
    const { harness } = await boot(workerConfig({ exemptAgentIds: [] }), [card("i1", REVIEWER)]);
    stubClassifier(harness, "T2");

    await harness.emit("issue.created", { title: "A card" }, EVENT);

    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBe("claude-sonnet-5");
  });
});

describe("selection.exemptAgentIds: scheduled passes", () => {
  /** The passes' row query: hand back the card the test seeded, whatever the SQL. */
  function rowsFor(harness: Booted["harness"], rows: Array<Record<string, unknown>>) {
    harness.ctx.db.query = (async (query: string) => {
      if (query.includes("from issues i") || (query.includes("join agents a") && query.includes("adapterConfig'->>'model' is not null"))) {
        return rows;
      }
      return [];
    }) as typeof harness.ctx.db.query;
  }

  const ROW = { id: "i1", identifier: "i1", status: "todo" };

  it("labelOnlyPass writes no pin for an exempt assignee", async () => {
    const labelled = card("i1", REVIEWER, { labels: [tierLabel("T2")], labelIds: ["lbl-T2"] } as Partial<Issue>);
    const { harness } = await boot(workerConfig({ exemptAgentIds: [REVIEWER] }), [labelled]);
    rowsFor(harness, [ROW]);
    const updates = recordUpdates(harness);

    await harness.runJob("labelOnlyPass");

    expect(updates.overrideWrites()).toHaveLength(0);
    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBeNull();
  });

  it("labelOnlyPass pins the same card for a non-exempt assignee (control)", async () => {
    const labelled = card("i1", ENGINEER, { labels: [tierLabel("T2")], labelIds: ["lbl-T2"] } as Partial<Issue>);
    const { harness } = await boot(workerConfig({ exemptAgentIds: [REVIEWER] }), [labelled]);
    rowsFor(harness, [ROW]);

    await harness.runJob("labelOnlyPass");

    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBe("claude-sonnet-5");
  });

  it("balancePass writes no pin for an exempt assignee", async () => {
    const labelled = card("i1", REVIEWER, { labels: [tierLabel("T3")], labelIds: ["lbl-T3"] } as Partial<Issue>);
    const { harness } = await boot(workerConfig({ exemptAgentIds: [REVIEWER] }), [labelled]);
    rowsFor(harness, [ROW]);
    const updates = recordUpdates(harness);

    await harness.runJob("balancePass");

    expect(updates.overrideWrites()).toHaveLength(0);
    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBeNull();
  });

  it("balancePass pins the same card for a non-exempt assignee (control)", async () => {
    const labelled = card("i1", ENGINEER, { labels: [tierLabel("T3")], labelIds: ["lbl-T3"] } as Partial<Issue>);
    const { harness } = await boot(workerConfig({ exemptAgentIds: [REVIEWER] }), [labelled]);
    rowsFor(harness, [ROW]);

    await harness.runJob("balancePass");

    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).not.toBeNull();
  });

  const STALE_PIN = { adapterConfig: { model: "claude-opus-5" } };

  it("repinPass neither repins nor clears the pin on an exempt agent's blocked card", async () => {
    const blocked = card("i1", REVIEWER, { status: "blocked", assigneeAdapterOverrides: STALE_PIN } as Partial<Issue>);
    const { harness } = await boot(workerConfig({ exemptAgentIds: [REVIEWER] }), [blocked]);
    rowsFor(harness, [{ ...ROW, status: "blocked" }]);
    const updates = recordUpdates(harness);

    await harness.runJob("repinPass");

    expect(updates.patches).toHaveLength(0);
    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBe("claude-opus-5");
  });

  it("repinPass clears the pin on a non-exempt agent's blocked card (control)", async () => {
    const blocked = card("i1", ENGINEER, { status: "blocked", assigneeAdapterOverrides: STALE_PIN } as Partial<Issue>);
    const { harness } = await boot(workerConfig({ exemptAgentIds: [REVIEWER] }), [blocked]);
    rowsFor(harness, [{ ...ROW, status: "blocked" }]);

    await harness.runJob("repinPass");

    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBeNull();
  });
});

describe("selection.exemptAgentIds: the apply tool", () => {
  const runCtx = { companyId: COMPANY, agentId: ENGINEER, runId: "run-1" };
  const labelled = (assignee: string) =>
    card("i1", assignee, { labels: [tierLabel("T2")], labelIds: ["lbl-T2"] } as Partial<Issue>);

  it("writes nothing for an exempt assignee and reports held-at-floor", async () => {
    const { harness } = await boot(workerConfig({ exemptAgentIds: [REVIEWER] }), [labelled(REVIEWER)]);
    const updates = recordUpdates(harness);

    const applied = (await harness.executeTool("model_selection_apply", { issueId: "i1" }, runCtx)) as {
      content: string;
      data: { decision: { outcome: string; modelId: string | null } };
    };

    expect(applied.data.decision).toMatchObject({ outcome: "held-at-floor", modelId: null });
    expect(updates.patches).toHaveLength(0);
    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBeNull();
  });

  it("writes the pin for a non-exempt assignee on the same tool call (control)", async () => {
    const { harness } = await boot(workerConfig({ exemptAgentIds: [REVIEWER] }), [labelled(ENGINEER)]);

    await harness.executeTool("model_selection_apply", { issueId: "i1" }, runCtx);

    expect(pinnedModel(await harness.ctx.issues.get("i1", COMPANY))).toBe("claude-sonnet-5");
  });
});

describe("selection.exemptAgentIds: run-scoped hook through the worker", () => {
  type Handler = (params: ResolveRunModelParams) => Promise<ResolveRunModelResult>;

  async function bootHook(selection: Record<string, unknown>) {
    const labelled = card("issue-1", REVIEWER, { labels: [tierLabel("T2")], labelIds: ["lbl-T2"] } as Partial<Issue>);
    const booted = await boot(workerConfig(selection, { runResolve: { enabled: true } }), [labelled]);
    const resolve = (booted.plugin.definition as unknown as { onResolveRunModel: Handler }).onResolveRunModel;
    return { ...booted, resolve };
  }

  function params(agentId: string): ResolveRunModelParams {
    return {
      runId: "run-1",
      companyId: COMPANY,
      agentId,
      issueId: "issue-1",
      adapterType: "claude_local",
      invocationSource: "assignment",
      wakeReason: "issue_assigned",
      agentDefaultModel: "claude-opus-5",
      previous: null,
      issueOverrideModel: null,
      deadlineMs: 1500,
    };
  }

  it("answers keep for an exempt agent's run", async () => {
    const { resolve } = await bootHook({ exemptAgentIds: [REVIEWER] });
    expect((await resolve(params(REVIEWER))).kind).toBe("keep");
  });

  it("still decides for the same run when the list is absent (control)", async () => {
    const { resolve } = await bootHook({});
    expect((await resolve(params(REVIEWER))).kind).toBe("decide");
  });
});
