import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest, { buildManifest, RUN_MODEL_RESOLVE_CAPABILITY } from "../src/manifest.js";
import { JOB_KEYS, PLUGIN_STATE_KEYS } from "../src/constants.js";
import { RUN_RESOLVE_ENV_KEYS, type ResolveRunModelParams, type ResolveRunModelResult } from "../src/engine/run-resolve.js";
import { createPlugin } from "../src/worker.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";
import { stoppedLane } from "./run-resolve-helpers.js";

const COMPANY = "co-1";
const AGENT = "agent-1";
const ISSUE = "issue-1";

beforeEach(() => {
  // Date-only, as the sibling suites: seeded PROFILES must stay inside the 14-day guard.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const LANE: Record<string, string> = {
  "claude-haiku-4-5-20251001": "lane-haiku",
  "claude-sonnet-5": "lane-sonnet",
  "claude-opus-5": "lane-opus",
};

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
    adapterConfig: {
      model: "claude-haiku-4-5-20251001",
      env: {
        GH_TOKEN: { type: "secret_ref", secretId: "s-1", version: "latest" },
        KEEP: { type: "plain", value: "binding" },
      },
    },
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

function tierLabel(tier: "T1" | "T2" | "T3") {
  return { id: `lbl-${tier}`, companyId: COMPANY, name: `tier:${tier}`, color: "#000", createdAt: new Date(0), updatedAt: new Date(0) };
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
    labels: [tierLabel("T2")],
    labelIds: ["lbl-T2"],
    ...overrides,
  } as unknown as Issue;
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true },
    models: MODELS.map((model) => ({ ...model, laneId: LANE[model.id] })),
    tierLabelIds: { T1: "lbl-T1", T2: "lbl-T2", T3: "lbl-T3" },
    classification: { enabled: true, baseUrl: "https://api.anthropic.example.com", modelId: "claude-sonnet-5" },
    runResolve: { enabled: true },
    ...overrides,
  };
}

type Handler = (params: ResolveRunModelParams) => Promise<ResolveRunModelResult>;

async function boot(cfg: Record<string, unknown>, issues: Issue[] = [issue(ISSUE)]) {
  const harness = createTestHarness({ manifest, config: cfg });
  harness.seed({ issues, agents: [agentRow()], companies: [{ id: COMPANY, name: "Co" } as never] });
  const plugin = createPlugin();
  await plugin.definition.setup?.(harness.ctx);
  await plugin.definition.onConfigChanged?.(cfg, { companyId: COMPANY });
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: PROFILES, signals: NO_ESCALATION },
  );
  const resolve = (plugin.definition as unknown as { onResolveRunModel: Handler }).onResolveRunModel;
  return { harness, plugin, resolve };
}

function params(overrides: Partial<ResolveRunModelParams> = {}): ResolveRunModelParams {
  return {
    runId: "run-1",
    companyId: COMPANY,
    agentId: AGENT,
    issueId: ISSUE,
    adapterType: "claude_local",
    invocationSource: "assignment",
    wakeReason: "issue_assigned",
    agentDefaultModel: "claude-haiku-4-5-20251001",
    previous: null,
    issueOverrideModel: null,
    deadlineMs: 1500,
    ...overrides,
  };
}

function decide(result: ResolveRunModelResult) {
  if (result.kind !== "decide") throw new Error(`expected decide, got ${JSON.stringify(result)}`);
  return result;
}

/** Count every host round trip the decision path could make. */
function countHostCalls(harness: Awaited<ReturnType<typeof boot>>["harness"]) {
  const counts = { state: 0, issues: 0, agents: 0, db: 0, http: 0, config: 0 };
  const wrap = <T extends object, K extends keyof T>(target: T, key: K, name: keyof typeof counts) => {
    const original = target[key] as unknown as (...args: unknown[]) => unknown;
    (target as Record<K, unknown>)[key] = ((...args: unknown[]) => {
      counts[name] += 1;
      return original.apply(target, args);
    }) as never;
  };
  wrap(harness.ctx.state, "get", "state");
  wrap(harness.ctx.issues, "get", "issues");
  wrap(harness.ctx.agents, "get", "agents");
  wrap(harness.ctx.db, "query", "db");
  wrap(harness.ctx.http, "fetch", "http");
  wrap(harness.ctx.config, "get", "config");
  return counts;
}

describe("onResolveRunModel on the worker", () => {
  describe("posture", () => {
    it("answers keep when the flag is off, and routes nothing", async () => {
      const { resolve, harness } = await boot(config({ runResolve: { enabled: false } }));
      expect(await resolve(params())).toEqual({ kind: "keep" });
      expect(harness.dbQueries).toHaveLength(0);
    });

    it("answers keep on an advisory install even with the flag on", async () => {
      const { resolve } = await boot(config({ selection: { enabled: true, mode: "advise" } }));
      expect(await resolve(params())).toEqual({ kind: "keep" });
    });

    it("answers keep for an issue that already carries an override model", async () => {
      const { resolve } = await boot(config());
      expect(await resolve(params({ issueOverrideModel: "claude-opus-5" }))).toEqual({ kind: "keep" });
    });

    it("answers keep for a run with no issue", async () => {
      const { resolve } = await boot(config());
      expect(await resolve(params({ issueId: null }))).toEqual({ kind: "keep" });
    });
  });

  describe("decision", () => {
    it("decides a first run from the tier label, with plain plugin-owned env only", async () => {
      const { resolve } = await boot(config());
      const result = decide(await resolve(params()));
      expect(result.model).toBe("claude-sonnet-5");
      expect(result.tier).toBe("T2");
      expect(result.source).toBe("model-selection:label");
      for (const [key, value] of Object.entries(result.env ?? {})) {
        expect(RUN_RESOLVE_ENV_KEYS).toContain(key);
        expect(typeof value).toBe("string");
      }
      // Never the agent's own env: no secret ref, no plain binding.
      expect(result.env).not.toHaveProperty("GH_TOKEN");
      expect(result.env).not.toHaveProperty("KEEP");
    });

    it("picks exactly what `advise` picks on the same state (parity)", async () => {
      const { resolve, harness } = await boot(config());
      const advised = (await harness.executeTool("model_selection_advise", { issueId: ISSUE }, {
        companyId: COMPANY,
        agentId: AGENT,
        runId: "run-x",
      })) as { data: { modelId: string } };
      const result = decide(await resolve(params()));
      expect(result.model).toBe(advised.data.modelId);
    });

    it("writes the switch reason to the issue's activity feed, once, on the first decision", async () => {
      const { resolve, harness } = await boot(config());
      await resolve(params());
      await vi.waitFor(() => expect(harness.activity.length).toBeGreaterThan(0));
      const entry = harness.activity.find((item) => item.metadata?.reason === "first-decision");
      expect(entry?.entityId).toBe(ISSUE);
      expect(entry?.metadata?.to).toBe("claude-sonnet-5");
    });
  });

  describe("hot caches only", () => {
    it("serves a warm run with zero host reads: no state, issue, agent, db, http or config call", async () => {
      const { resolve, harness } = await boot(config());
      const first = decide(await resolve(params()));
      // The second run is the first with history: it starts ONE background read
      // of the previous run's context peak (off the path, never awaited).
      const second = decide(
        await resolve(
          params({ runId: "run-2", previous: { runId: "run-1", model: first.model, decisionId: first.decisionId } }),
        ),
      );
      await new Promise((done) => setTimeout(done, 20));
      const counts = countHostCalls(harness);
      const third = decide(
        await resolve(
          params({ runId: "run-3", previous: { runId: "run-2", model: second.model, decisionId: second.decisionId } }),
        ),
      );
      expect(third.model).toBe(first.model);
      expect(third.decisionId).not.toBe(first.decisionId);
      expect(counts).toEqual({ state: 0, issues: 0, agents: 0, db: 0, http: 0, config: 0 });
    });

    it("never starts a classification: an unlabelled card with none in flight is decided on the heuristic", async () => {
      const { resolve, harness } = await boot(config(), [issue(ISSUE, { labels: [], labelIds: [] })]);
      const counts = countHostCalls(harness);
      const result = decide(await resolve(params()));
      expect(counts.http).toBe(0);
      expect(result.source).toBe("model-selection:heuristic");
      // The agent floor is the T3 model, so the heuristic judges T3.
      expect(result.tier).toBe("T3");
    });

    it("refreshes the snapshot on the minute job without a decision", async () => {
      const { harness } = await boot(config());
      await harness.runJob(JOB_KEYS.refreshRunResolve);
      expect(harness.logs.filter((entry) => entry.level === "error")).toHaveLength(0);
    });

    it("serves a stale snapshot when its refresh fails", async () => {
      const { resolve, harness } = await boot(config({ runResolve: { enabled: true, snapshotTtlMs: 5000 } }));
      decide(await resolve(params()));
      vi.setSystemTime(NOW + 60_000);
      harness.ctx.state.get = (async () => {
        throw new Error("state backend down");
      }) as typeof harness.ctx.state.get;
      harness.ctx.config.get = (async () => {
        throw new Error("config backend down");
      }) as typeof harness.ctx.config.get;
      const result = decide(await resolve(params({ runId: "run-3" })));
      expect(result.model).toBe("claude-sonnet-5");
      await vi.waitFor(() => expect(harness.logs.some((entry) => entry.message.includes("serving stale"))).toBe(true));
    });
  });

  describe("sticky rule on the worker", () => {
    it("falls back to one primary-key read on a decision-cache miss, and uses what it finds", async () => {
      const { resolve, harness } = await boot(config());
      harness.ctx.db.query = (async (sql: string) => {
        if (sql.includes("model_decision")) {
          return [
            { model_decision: { decisionId: "d-old", model: "claude-opus-5", tier: "T2", fallback: true } },
          ];
        }
        return [];
      }) as typeof harness.ctx.db.query;
      const result = decide(
        await resolve(
          params({ previous: { runId: "11111111-1111-4111-8111-111111111111", model: "claude-opus-5", decisionId: "d-old" } }),
        ),
      );
      // The recorded fallback's primary (sonnet) is serviceable: switch back.
      expect(result.model).toBe("claude-sonnet-5");
      expect(result.reason).toContain("primary-recovered");
    });

    it("degrades to the previous run's model when the decision read fails, and stays sticky", async () => {
      const { resolve, harness } = await boot(config());
      harness.ctx.db.query = (async (sql: string) => {
        if (sql.includes("model_decision")) throw new Error("db unavailable");
        return [];
      }) as typeof harness.ctx.db.query;
      const result = decide(
        await resolve(
          params({ previous: { runId: "11111111-1111-4111-8111-111111111111", model: "claude-opus-5", decisionId: "d-old" } }),
        ),
      );
      expect(result.model).toBe("claude-opus-5");
    });

    it("switches off a model whose lane stopped, and records why", async () => {
      const { resolve, harness } = await boot(config());
      const first = decide(await resolve(params()));
      expect(first.model).toBe("claude-sonnet-5");
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        { "lane-sonnet": stoppedLane("lane-sonnet") },
      );
      // The refresh job is what makes new lane state visible to the hot path.
      await harness.runJob(JOB_KEYS.refreshRunResolve);
      const second = decide(
        await resolve(
          params({ runId: "run-2", previous: { runId: "run-1", model: first.model, decisionId: first.decisionId } }),
        ),
      );
      expect(second.model).toBe("claude-opus-5");
      expect(second.reason).toContain("unserviceable");
      expect(second.fallback).toBe(true);
    });
  });

  describe("classification in flight", () => {
    function slowClassifier(harness: Awaited<ReturnType<typeof boot>>["harness"], tier: "T1" | "T2" | "T3") {
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      let calls = 0;
      harness.ctx.http.fetch = (async () => {
        calls += 1;
        await gate;
        return {
          status: 200,
          headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
          redirected: false,
          text: async () =>
            JSON.stringify({
              content: [{ type: "text", text: `{"tier":"${tier}","confidence":0.9,"exclusion":false,"reason":"x"}` }],
            }),
        };
      }) as unknown as typeof harness.ctx.http.fetch;
      return { release, calls: () => calls };
    }

    it("waits for a classification already in flight and uses its tier", async () => {
      const { resolve, harness } = await boot(config(), [issue(ISSUE, { labels: [], labelIds: [] })]);
      const classifier = slowClassifier(harness, "T1");
      const event = harness.emit("issue.created", {}, { entityId: ISSUE, companyId: COMPANY, entityType: "issue" });
      await vi.waitFor(() => expect(classifier.calls()).toBe(1));
      const pending = resolve(params());
      setTimeout(() => classifier.release(), 30);
      const result = decide(await pending);
      await event;
      expect(result.tier).toBe("T1");
      expect(result.source).toBe("model-selection:classifier");
      expect(result.model).toBe("claude-opus-5");
      // The hook waited on the event path's call; it started none of its own.
      expect(classifier.calls()).toBe(1);
    });

    it("gives up after the cap and decides on the heuristic, never holding the run", async () => {
      const { resolve, harness } = await boot(
        config({ runResolve: { enabled: true, classifierWaitMs: 60 } }),
        [issue(ISSUE, { labels: [], labelIds: [] })],
      );
      const classifier = slowClassifier(harness, "T1");
      const event = harness.emit("issue.created", {}, { entityId: ISSUE, companyId: COMPANY, entityType: "issue" });
      await vi.waitFor(() => expect(classifier.calls()).toBe(1));
      const startedAt = performance.now();
      const result = decide(await resolve(params()));
      const waitedMs = performance.now() - startedAt;
      expect(result.source).toBe("model-selection:heuristic");
      expect(waitedMs).toBeGreaterThanOrEqual(50);
      expect(waitedMs).toBeLessThan(500);
      classifier.release();
      await event;
    });
  });

  describe("never a silent default", () => {
    it("defers when the cold snapshot cannot load inside the budget", async () => {
      const { resolve, harness } = await boot(config());
      harness.ctx.config.get = (() => new Promise(() => {})) as typeof harness.ctx.config.get;
      const startedAt = performance.now();
      const result = await resolve(params({ deadlineMs: 250 }));
      expect(performance.now() - startedAt).toBeLessThan(400);
      expect(result.kind).toBe("defer");
      if (result.kind === "defer") {
        expect(result.retryAfterMs).toBeGreaterThan(0);
        expect(result.reason).toContain("hot cache");
      }
    });

    it("defers when every lane that could serve the tier has stopped", async () => {
      const { resolve, harness } = await boot(config());
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        { "lane-sonnet": stoppedLane("lane-sonnet"), "lane-opus": stoppedLane("lane-opus") },
      );
      const result = await resolve(params());
      expect(result.kind).toBe("defer");
    });

    it("defers rather than guessing when the assignee agent cannot be read", async () => {
      const { resolve, harness } = await boot(config());
      harness.ctx.agents.get = (async () => {
        throw new Error("agents unavailable");
      }) as typeof harness.ctx.agents.get;
      const result = await resolve(params());
      expect(result.kind).toBe("defer");
    });

    it("defers before setup has run", async () => {
      const plugin = createPlugin();
      const handler = (plugin.definition as unknown as { onResolveRunModel: Handler }).onResolveRunModel;
      expect((await handler(params())).kind).toBe("defer");
    });
  });

  describe("latency", () => {
    it("holds p99 well under budget on warm caches across a mixed sticky/switch workload", async () => {
      const { resolve, harness } = await boot(config());
      const first = decide(await resolve(params()));
      await new Promise((done) => setTimeout(done, 20));
      expect(harness.dbQueries.length).toBeGreaterThanOrEqual(0);

      const samples: number[] = [];
      let previous = { runId: "run-1", model: first.model, decisionId: first.decisionId };
      const runs = 600;
      for (let index = 0; index < runs; index += 1) {
        const startedAt = performance.now();
        const result = decide(await resolve(params({ runId: `run-${index + 2}`, previous })));
        samples.push(performance.now() - startedAt);
        previous = { runId: `run-${index + 2}`, model: result.model, decisionId: result.decisionId };
      }
      samples.sort((left, right) => left - right);
      const percentile = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] as number;
      const p50 = percentile(0.5);
      const p99 = percentile(0.99);
      // Recorded in the run log so a regression names its number.
      console.info(`run-resolve latency over ${runs} warm decisions: p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms`);
      expect(p99).toBeLessThanOrEqual(250);
      // The budget in §6 is for the whole path; the engine part should be a small
      // fraction of it. A p50 above 25 ms means something blocking crept in.
      expect(p50).toBeLessThanOrEqual(25);
    });

    it("holds the same budget on a production-sized roster (45 models over 9 lanes)", async () => {
      const tiers = ["T1", "T2", "T3"] as const;
      const roster = Array.from({ length: 45 }, (_, index) => {
        const base = MODELS[index % MODELS.length] as (typeof MODELS)[number];
        return {
          ...base,
          id: `${base.id}-v${index}`,
          tier: tiers[index % 3],
          laneId: `lane-${index % 9}`,
          costPerMTokIn: base.costPerMTokIn + (index % 7) * 0.1,
          releasedAt: `2026-0${1 + (index % 8)}-0${1 + (index % 9)}`,
        };
      });
      const { resolve } = await boot(config({ models: roster }));
      const first = decide(await resolve(params()));
      await new Promise((done) => setTimeout(done, 20));
      const samples: number[] = [];
      let previous = { runId: "run-1", model: first.model, decisionId: first.decisionId };
      for (let index = 0; index < 400; index += 1) {
        const startedAt = performance.now();
        const result = decide(await resolve(params({ runId: `run-${index + 2}`, previous })));
        samples.push(performance.now() - startedAt);
        previous = { runId: `run-${index + 2}`, model: result.model, decisionId: result.decisionId };
      }
      samples.sort((left, right) => left - right);
      const p50 = samples[Math.floor(samples.length * 0.5)] as number;
      const p99 = samples[Math.floor(samples.length * 0.99)] as number;
      console.info(`run-resolve latency, 45-model roster, 400 warm decisions: p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms`);
      expect(p99).toBeLessThanOrEqual(250);
    });
  });
});

describe("retiring the legacy pin writers once the flag is on", () => {
  const idleRow = (id: string) => ({ id, identifier: id, status: "in_progress" });
  const agentFloorRow = () => agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } });

  async function bootPins(cfg: Record<string, unknown>, cards: Issue[]) {
    const harness = createTestHarness({ manifest, config: cfg });
    harness.seed({ issues: cards, agents: [agentFloorRow()], companies: [{ id: COMPANY, name: "Co" } as never] });
    const plugin = createPlugin();
    await plugin.definition.setup?.(harness.ctx);
    await plugin.definition.onConfigChanged?.(cfg, { companyId: COMPANY });
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
      { profiles: PROFILES, signals: NO_ESCALATION },
    );
    return harness;
  }

  const overrideOf = async (harness: Awaited<ReturnType<typeof bootPins>>, id: string) =>
    (await harness.ctx.issues.get(id, COMPANY))?.assigneeAdapterOverrides ?? null;

  const labelled = (id: string, tier: "T1" | "T3" = "T1") =>
    issue(id, { status: "in_progress", labels: [tierLabel(tier)], labelIds: [`lbl-${tier}`] });

  it("labelOnlyPass pins with the flag off and writes nothing with it on", async () => {
    const off = await bootPins(config({ runResolve: { enabled: false } }), [labelled("i1")]);
    off.ctx.db.query = (async () => [idleRow("i1")]) as typeof off.ctx.db.query;
    await off.runJob("labelOnlyPass");
    expect(await overrideOf(off, "i1")).not.toBeNull();

    const on = await bootPins(config(), [labelled("i1")]);
    on.ctx.db.query = (async () => [idleRow("i1")]) as typeof on.ctx.db.query;
    await on.runJob("labelOnlyPass");
    expect(await overrideOf(on, "i1")).toBeNull();
  });

  it("balancePass pins with the flag off and writes nothing with it on", async () => {
    const off = await bootPins(config({ runResolve: { enabled: false } }), [labelled("i1", "T3")]);
    off.ctx.db.query = (async () => [idleRow("i1")]) as typeof off.ctx.db.query;
    await off.runJob("balancePass");
    expect(await overrideOf(off, "i1")).not.toBeNull();

    const on = await bootPins(config(), [labelled("i1", "T3")]);
    on.ctx.db.query = (async () => [idleRow("i1")]) as typeof on.ctx.db.query;
    await on.runJob("balancePass");
    expect(await overrideOf(on, "i1")).toBeNull();
  });

  it("the repin pass and the agent.run.failed re-pin never even scan for pinned cards", async () => {
    const pinnedScan = (sql: string) => sql.includes("assignee_adapter_overrides->'adapterConfig'->>'model' is not null");
    for (const [enabled, expectedScans] of [[false, true], [true, false]] as const) {
      const harness = await bootPins(config({ runResolve: { enabled } }), [labelled("i1")]);
      const seen: string[] = [];
      harness.ctx.db.query = (async (sql: string) => {
        seen.push(sql);
        return [];
      }) as typeof harness.ctx.db.query;
      await harness.runJob("repinPass");
      await harness.emit("agent.run.failed", { issueId: "i1", errorCode: "usage_limit_reached" }, { companyId: COMPANY });
      expect(seen.some(pinnedScan)).toBe(expectedScans);
    }
  });

  it("the assignment-time pin writes with the flag off and nothing with it on", async () => {
    // A labelled card is assigned: the heuristic tier is its label (T1), the pick
    // (opus) differs from the agent floor (haiku), so the control genuinely pins.
    const assign = (harness: Awaited<ReturnType<typeof bootPins>>) =>
      harness.emit(
        "issue.updated",
        { changes: { assigneeAgentId: { from: null, to: AGENT } } },
        { entityId: "i1", companyId: COMPANY, entityType: "issue" },
      );
    const off = await bootPins(config({ runResolve: { enabled: false } }), [labelled("i1")]);
    await assign(off);
    expect(await overrideOf(off, "i1")).not.toBeNull();

    const on = await bootPins(config(), [labelled("i1")]);
    await assign(on);
    expect(await overrideOf(on, "i1")).toBeNull();
  });

  it("issue.created still classifies and labels, but pins nothing", async () => {
    const harness = await bootPins(config(), [issue("i1", { labels: [], labelIds: [], status: "todo" })]);
    harness.ctx.http.fetch = (async () => ({
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      redirected: false,
      text: async () =>
        JSON.stringify({ content: [{ type: "text", text: '{"tier":"T1","confidence":0.9,"exclusion":false,"reason":"x"}' }] }),
    })) as unknown as typeof harness.ctx.http.fetch;
    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });
    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(after?.labelIds).toContain("lbl-T1");
    expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
  });

  it("an advisory install keeps the legacy paths: the flag alone retires nothing", async () => {
    const harness = await bootPins(
      config({ selection: { enabled: true, mode: "advise" }, runResolve: { enabled: true } }),
      [labelled("i1")],
    );
    harness.ctx.db.query = (async () => [idleRow("i1")]) as typeof harness.ctx.db.query;
    await harness.runJob("labelOnlyPass");
    // Advisory: it still walked and logged the decision (it writes no override either way).
    expect(harness.activity.some((entry) => entry.message.includes("label-only"))).toBe(true);
  });
});

describe("manifest declaration", () => {
  it("the default artifact declares neither the capability nor modelRouting, so it installs on a host without the hook", () => {
    expect(manifest.capabilities).not.toContain(RUN_MODEL_RESOLVE_CAPABILITY);
    expect(manifest).not.toHaveProperty("modelRouting");
  });

  it("the fork build declares the capability and exactly the env keys the handler may return", () => {
    const forked = buildManifest(true) as unknown as { capabilities: string[]; modelRouting: { envKeys: string[] } };
    expect(forked.capabilities).toContain(RUN_MODEL_RESOLVE_CAPABILITY);
    expect(forked.modelRouting.envKeys).toEqual([...RUN_RESOLVE_ENV_KEYS]);
    // The host's own schema bounds envKeys at 32 names of the shape [A-Za-z_][A-Za-z0-9_]*.
    expect(forked.modelRouting.envKeys.length).toBeLessThanOrEqual(32);
    for (const key of forked.modelRouting.envKeys) expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it("declares the warm-up job on a minute schedule", () => {
    const job = manifest.jobs?.find((entry) => entry.jobKey === JOB_KEYS.refreshRunResolve);
    expect(job?.schedule).toBe("* * * * *");
  });
});
