import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

import manifest from "../src/manifest.js";
import { PLUGIN_STATE_KEYS } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { buildCardLedger } from "../src/engine/scores.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

const COMPANY = "co-1";
const AGENT = "agent-1";

// Freeze the wall clock at the fixture NOW so the seeded PROFILES
// (computedAt = NOW - 1h) stay inside the production 14-day guard
// (src/engine/cost.ts). Date-only: async timers keep running. The quality
// test below builds its cards relative to `Date.now()`, so it stays
// consistent under the freeze.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

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

/**
 * Stub the classification HTTP call; record every invocation. `onCall` runs
 * inside the call, before it answers — the window in which the classifier is
 * in flight.
 */
function stubClassifier(
  harness: Awaited<ReturnType<typeof boot>>,
  tier: "T1" | "T2" | "T3" | null,
  onCall?: () => Promise<void> | void,
) {
  const calls: Array<{ url: string; body: string }> = [];
  harness.ctx.http.fetch = (async (url: string, init: { body?: string } | undefined) => {
    calls.push({ url, body: init?.body ?? "" });
    await onCall?.();
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
 * Exposure-window cut: an `issue.created` event on an
 * assigned, unlabelled, idle card must classify, label AND pin in the same
 * tick — not wait for the 10-minute pass that the card's own dispatch makes
 * missable (the passes' row queries exclude cards with running runs).
 */
describe("Creation-time pin", () => {
  it("classifies, labels and pins an assigned unlabelled idle card on issue.created", async () => {
    // The pin notice names the card actually pinned (seeded
    // identifier), never a hardcoded identifier baked into the code path.
    const card = issue("i1", { identifier: "EX-9999" } as Partial<Issue>);
    const harness = await boot(baseConfig(), [card]);
    const calls = stubClassifier(harness, "T2");

    await harness.emit("issue.created", { title: "A card" }, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    expect(calls).toHaveLength(1);
    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(after?.labelIds).toContain("lbl-T2");
    expect(pinnedModel(after as Issue)).toBe("claude-sonnet-5");
    const messages = harness.activity.map((entry) => entry.message);
    expect(messages.some((m) => m.includes("classified this issue as T2"))).toBe(true);
    expect(messages.some((m) => m.includes("EX-9999") && m.includes("claude-sonnet-5"))).toBe(true);
    expect(messages.some((m) => m.includes("EX-3111"))).toBe(false);
  });

  it("labels at the classifier's tier but never writes an override while a run holds the card", async () => {
    // The exact first-turn race: the card dispatched before the
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
    // `issue.created` carries no assignee; the assignment arm
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

  it("does not re-decide the model on an agent-to-agent reassignment", async () => {
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

  /**
   * The assignment wake queues (and often claims) the run
   * between this path's classify and advise steps, so a pin gated on strict
   * idleness aborts nearly every pin. A queued-but-unstarted run is still
   * safe: Paperclip reads the override at run START. The gate reads the
   * card's live `heartbeat_runs` rows; `executionRunId` is not consulted.
   */
  describe("Queued-but-unstarted run", () => {
    /** Route `ctx.db.query` to the card's live-run rows; everything else reads empty. */
    function stubRunRows(
      harness: Awaited<ReturnType<typeof boot>>,
      liveRows: unknown[] | ((call: number) => unknown[]),
    ) {
      let liveCalls = 0;
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("status in ('queued', 'running')")) {
          liveCalls += 1;
          return typeof liveRows === "function" ? liveRows(liveCalls) : liveRows;
        }
        return [];
      }) as typeof harness.ctx.db.query;
    }

    const QUEUED_UNSTARTED = [{ status: "queued", started_at: null }];
    const STARTED = [{ status: "running", started_at: "2026-09-10T12:00:01.000Z" }];
    const STARTED_LEAKED = [{ status: "queued", started_at: "2026-09-10T12:00:01.000Z" }];

    it("pins through the assignment wake's queued-but-unstarted run on issue.created", async () => {
      const card = issue("i1", {}); // fork leaves executionRunId null while queued
      const harness = await boot(baseConfig(), [card]);
      const calls = stubClassifier(harness, "T2");
      stubRunRows(harness, QUEUED_UNSTARTED);

      await harness.emit("issue.created", { title: "A card" }, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

      expect(calls).toHaveLength(1);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.labelIds).toContain("lbl-T2");
      expect(pinnedModel(after as Issue)).toBe("claude-sonnet-5");
      expect(harness.activity.some((entry) => entry.message.includes("at card creation"))).toBe(true);
    });

    it("pins through a queued run on the assignment arm without classifying", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
      });
      const harness = await boot(baseConfig(), [card]);
      const calls = stubClassifier(harness, "T2");
      stubRunRows(harness, QUEUED_UNSTARTED);

      await harness.emit(
        "issue.updated",
        { changes: { assigneeAgentId: { from: null, to: AGENT } } },
        { entityId: "i1", companyId: COMPANY, entityType: "issue" },
      );

      expect(calls).toHaveLength(0);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(pinnedModel(after as Issue)).toBe("claude-opus-5");
      expect(harness.activity.some((entry) => entry.message.includes("issue.updated:assignment"))).toBe(true);
    });

    it("does not pin when the run has started", async () => {
      const card = issue("i1", {
        executionRunId: "run-live-1",
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
      });
      const harness = await boot(baseConfig(), [card]);
      stubClassifier(harness, "T2");
      stubRunRows(harness, STARTED);

      await harness.emit(
        "issue.updated",
        { changes: { assigneeAgentId: { from: null, to: AGENT } } },
        { entityId: "i1", companyId: COMPANY, entityType: "issue" },
      );

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(pinnedModel(after as Issue)).toBeNull();
      expect(harness.activity.some((entry) => entry.message.includes("at card creation"))).toBe(false);
    });

    it("does not pin when the only live row is queued but already has started_at", async () => {
      // `creation-pin-drops-queued-check` mutant killer: the status is still
      // `queued`, so only the started_at half of the check refuses the pin.
      const card = issue("i1", {
        executionRunId: "run-started-1",
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
      });
      const harness = await boot(baseConfig(), [card]);
      stubClassifier(harness, "T2");
      stubRunRows(harness, STARTED_LEAKED);

      await harness.emit(
        "issue.updated",
        { changes: { assigneeAgentId: { from: null, to: AGENT } } },
        { entityId: "i1", companyId: COMPANY, entityType: "issue" },
      );

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(pinnedModel(after as Issue)).toBeNull();
      expect(harness.activity.some((entry) => entry.message.includes("at card creation"))).toBe(false);
    });

    it("does not pin when a started running row sits beside a queued one", async () => {
      // Every live row must be queued-unstarted: one queued row does not
      // excuse a second, already-running run on the same card.
      const card = issue("i1", {
        executionRunId: "run-queued-1",
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
      });
      const harness = await boot(baseConfig(), [card]);
      stubClassifier(harness, "T2");
      stubRunRows(harness, [...QUEUED_UNSTARTED, ...STARTED]);

      await harness.emit(
        "issue.updated",
        { changes: { assigneeAgentId: { from: null, to: AGENT } } },
        { entityId: "i1", companyId: COMPANY, entityType: "issue" },
      );

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(pinnedModel(after as Issue)).toBeNull();
      expect(harness.activity.some((entry) => entry.message.includes("at card creation"))).toBe(false);
    });

    it("does not pin when a running row has no started_at yet", async () => {
      // `creation-pin-ignores-running-status` mutant killer.
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig(), [card]);
      stubClassifier(harness, "T2");
      stubRunRows(harness, [{ status: "running", started_at: null }]);

      await harness.emit(
        "issue.updated",
        { changes: { assigneeAgentId: { from: null, to: AGENT } } },
        { entityId: "i1", companyId: COMPANY, entityType: "issue" },
      );

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(pinnedModel(after as Issue)).toBeNull();
    });

    it("does not pin when a checkout holds the card, even with a queued run behind it", async () => {
      const card = issue("i1", { checkoutRunId: "run-1", executionRunId: "run-queued-1" });
      const harness = await boot(baseConfig(), [card]);
      stubClassifier(harness, "T2");
      stubRunRows(harness, QUEUED_UNSTARTED);

      await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.labelIds).toContain("lbl-T2");
      expect(pinnedModel(after as Issue)).toBeNull();
    });

    it("logs 'landed after run start' when the run starts between the final gate and the write", async () => {
      const card = issue("i1", {
        executionRunId: "run-queued-1",
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
      });
      const harness = await boot(baseConfig(), [card]);
      stubClassifier(harness, "T2");
      // Gate-time reads see the queued run; the post-write re-read sees it started.
      stubRunRows(harness, (call) => (call <= 2 ? QUEUED_UNSTARTED : STARTED));
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
      }) as typeof harness.ctx.logger.info;

      await harness.emit(
        "issue.updated",
        { changes: { assigneeAgentId: { from: null, to: AGENT } } },
        { entityId: "i1", companyId: COMPANY, entityType: "issue" },
      );

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(pinnedModel(after as Issue)).toBe("claude-opus-5");
      expect(infoLogs.some((entry) => entry.message.includes("landed after run start"))).toBe(true);
    });

    it("keeps the live-runs lookup on the indexed context expressions with the coalesce guard", async () => {
      // Same shape as LAST_RUN_CONTEXT_USAGE_SQL: bare
      // indexed branches plus the `issueId is null` guard on the task branch.
      const { CREATION_PIN_LIVE_RUNS_SQL } = await import("../src/sql.js");
      expect(CREATION_PIN_LIVE_RUNS_SQL).toContain("context_snapshot->>'issueId' = $2");
      expect(CREATION_PIN_LIVE_RUNS_SQL).toContain("context_snapshot->>'taskId' = $2");
      expect(CREATION_PIN_LIVE_RUNS_SQL).toContain("context_snapshot->>'issueId' is null");
      expect(CREATION_PIN_LIVE_RUNS_SQL).not.toContain("coalesce(context_snapshot");
    });
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
 * The first pin is decided from data already
 * in hand — `resolveTier()`'s judgement — and written before the classifier
 * is called; the classifier only refines it, and only while the wake's run is
 * still unstarted. These cards have an assignee whose floor model is not on
 * the roster, so the heuristic tier is `selection.defaultTier` (T2) and its
 * pick (`claude-sonnet-5`) is not the floor: the first pin is a real write.
 */
describe("Event-time first pin", () => {
  const OFF_ROSTER_AGENT = agentRow({ adapterConfig: { model: "muse-spark-1.3" } });

  function firstPinConfig() {
    return baseConfig({
      selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true, defaultTier: "T2" },
    });
  }

  /** Every live-run read answers from `rows()`, evaluated at call time. */
  function stubLiveRuns(harness: Awaited<ReturnType<typeof boot>>, rows: () => unknown[]) {
    harness.ctx.db.query = (async (query: string) =>
      query.includes("status in ('queued', 'running')") ? rows() : []) as typeof harness.ctx.db.query;
  }

  const QUEUED_UNSTARTED = [{ status: "queued", started_at: null }];
  const STARTED = [{ status: "running", started_at: "2026-09-10T12:00:01.000Z" }];

  async function currentPin(harness: Awaited<ReturnType<typeof boot>>): Promise<string | null> {
    return pinnedModel((await harness.ctx.issues.get("i1", COMPANY)) as Issue);
  }

  it("writes the first pin before the classifier is called", async () => {
    const harness = await boot(firstPinConfig(), [issue("i1")], [OFF_ROSTER_AGENT]);
    stubLiveRuns(harness, () => QUEUED_UNSTARTED);
    const pinSeenByClassifier: Array<string | null> = [];
    const calls = stubClassifier(harness, "T2", async () => {
      pinSeenByClassifier.push(await currentPin(harness));
    });

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    expect(calls).toHaveLength(1);
    expect(pinSeenByClassifier).toEqual(["claude-sonnet-5"]);
    // Same tier from the classifier: one pin, no re-pin.
    expect(await currentPin(harness)).toBe("claude-sonnet-5");
    const pins = harness.activity.filter((entry) => entry.message.includes("at card creation") && entry.message.includes("pinned"));
    expect(pins).toHaveLength(1);
    expect(pins[0]?.metadata).toMatchObject({ phase: "first-pin", modelId: "claude-sonnet-5" });
    expect(typeof pins[0]?.metadata?.latencyMs).toBe("number");
    expect(harness.activity.some((entry) => entry.message.includes("re-pinned"))).toBe(false);
  });

  it("lands the first pin while the classifier is still in flight (never awaited first)", async () => {
    // The timing half of the AC: the classifier is held open indefinitely.
    // A path that awaits it before its first write cannot pin inside the
    // window, so this fails on exactly that mutant.
    const harness = await boot(firstPinConfig(), [issue("i1")], [OFF_ROSTER_AGENT]);
    stubLiveRuns(harness, () => QUEUED_UNSTARTED);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = stubClassifier(harness, "T1", () => held);

    const handled = harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });
    try {
      await vi.waitFor(
        async () => {
          expect(await currentPin(harness)).toBe("claude-sonnet-5");
        },
        { timeout: 1_000, interval: 5 },
      );
      expect(calls).toHaveLength(1); // the pin landed while the classifier was open
    } finally {
      release();
      await handled;
    }
  });

  it("re-pins to the classified tier while the run is still queued and unstarted", async () => {
    const harness = await boot(firstPinConfig(), [issue("i1", { identifier: "EX-9998" } as Partial<Issue>)], [OFF_ROSTER_AGENT]);
    stubLiveRuns(harness, () => QUEUED_UNSTARTED);
    stubClassifier(harness, "T1");

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(after?.labelIds).toContain("lbl-T1");
    expect(pinnedModel(after as Issue)).toBe("claude-opus-5");
    const repins = harness.activity.filter((entry) => entry.message.includes("re-pinned"));
    expect(repins).toHaveLength(1);
    expect(repins[0]?.message).toContain("claude-sonnet-5 -> claude-opus-5");
    expect(repins[0]?.message).toContain("EX-9998");
    expect(repins[0]?.metadata).toMatchObject({ phase: "classified-repin", from: "claude-sonnet-5" });
  });

  it("re-pins down to a lower classified tier too, past the first pin's stickiness", async () => {
    // Label-tier semantics both ways: the first pin is a placeholder, not a
    // judgement, so it must not hold a cheaper classified tier off the card.
    const harness = await boot(firstPinConfig(), [issue("i1")], [OFF_ROSTER_AGENT]);
    stubLiveRuns(harness, () => QUEUED_UNSTARTED);
    stubClassifier(harness, "T3");

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(after?.labelIds).toContain("lbl-T3");
    expect(pinnedModel(after as Issue)).toBe("claude-haiku-4-5-20251001");
  });

  it("keeps the first pin and only labels when the run starts during classification", async () => {
    const harness = await boot(firstPinConfig(), [issue("i1")], [OFF_ROSTER_AGENT]);
    let started = false;
    stubLiveRuns(harness, () => (started ? STARTED : QUEUED_UNSTARTED));
    stubClassifier(harness, "T1", () => {
      started = true;
    });
    const infoLogs: string[] = [];
    harness.ctx.logger.info = ((message: string) => {
      infoLogs.push(message);
    }) as typeof harness.ctx.logger.info;

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(after?.labelIds).toContain("lbl-T1");
    expect(pinnedModel(after as Issue)).toBe("claude-sonnet-5");
    expect(harness.activity.some((entry) => entry.message.includes("re-pinned"))).toBe(false);
    expect(infoLogs.some((message) => message.includes("applies from next boundary"))).toBe(true);
  });

  it("writes no first pin while a run is already running, and no re-pin after classification", async () => {
    const harness = await boot(firstPinConfig(), [issue("i1")], [OFF_ROSTER_AGENT]);
    stubLiveRuns(harness, () => STARTED);
    const calls = stubClassifier(harness, "T1");

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    expect(calls).toHaveLength(1); // the label is still refined
    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(after?.labelIds).toContain("lbl-T1");
    expect(pinnedModel(after as Issue)).toBeNull();
    expect(harness.activity.some((entry) => entry.message.includes("pinned"))).toBe(false);
  });

  it("never overwrites a different pin that lands during classification", async () => {
    // An operator or a scheduled pass pinned the card while the classifier
    // was out; the re-pin may only replace the pin this path itself wrote.
    const harness = await boot(firstPinConfig(), [issue("i1")], [OFF_ROSTER_AGENT]);
    stubLiveRuns(harness, () => QUEUED_UNSTARTED);
    stubClassifier(harness, "T1", async () => {
      await harness.ctx.issues.update(
        "i1",
        { assigneeAdapterOverrides: { adapterConfig: { model: "claude-haiku-4-5-20251001" } } } as never,
        COMPANY,
      );
    });

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    expect(await currentPin(harness)).toBe("claude-haiku-4-5-20251001");
    expect(harness.activity.some((entry) => entry.message.includes("re-pinned"))).toBe(false);
  });

  it("keeps the first pin when the classifier is unavailable", async () => {
    const harness = await boot(firstPinConfig(), [issue("i1")], [OFF_ROSTER_AGENT]);
    stubLiveRuns(harness, () => QUEUED_UNSTARTED);
    const calls = stubClassifier(harness, null);

    await harness.emit("issue.created", {}, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

    expect(calls).toHaveLength(1);
    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(after?.labelIds ?? []).toHaveLength(0);
    expect(pinnedModel(after as Issue)).toBe("claude-sonnet-5");
  });
});

/**
 * A card the router cannot pin must be VISIBLE — one activity
 * notice naming the outcome and the lane states — not a silent `continue`.
 */
describe("Unpinnable-card visibility", () => {
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

describe("Creation-time pin in advisory selection", () => {
  // Same gate as the scheduled passes, on the event path: the classifier
  // still runs and the tier label still lands (labels are not pins), but no
  // override is written.
  const ADVISORY_SELECTIONS: Array<{ name: string; selection: Record<string, unknown> }> = [
    { name: "advise", selection: { enabled: true, mode: "advise", holdOnUntrustedProfile: true } },
    // Disabled wins even when mode says enforce: both conjuncts are load-bearing.
    { name: "selection-disabled", selection: { enabled: false, mode: "enforce", holdOnUntrustedProfile: true } },
  ];

  for (const { name, selection } of ADVISORY_SELECTIONS) {
    it(`classifies and labels but never pins on issue.created in ${name} mode`, async () => {
      const card = issue("i1", { identifier: "EX-9999" } as Partial<Issue>);
      const harness = await boot(baseConfig({ selection }), [card]);
      const calls = stubClassifier(harness, "T2");
      const seen: Array<Record<string, unknown>> = [];
      const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
      harness.ctx.issues.update = (async (...args: Parameters<typeof originalUpdate>) => {
        seen.push(args[1] as unknown as Record<string, unknown>);
        return originalUpdate(...args);
      }) as typeof harness.ctx.issues.update;

      await harness.emit("issue.created", { title: "A card" }, { entityId: "i1", companyId: COMPANY, entityType: "issue" });

      // Classification still ran, and its label still landed.
      expect(calls).toHaveLength(1);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.labelIds).toContain("lbl-T2");
      // But no override was written — by any call, not just the final state.
      expect(seen.filter((patch) => "assigneeAdapterOverrides" in patch)).toHaveLength(0);
      expect(pinnedModel(after as Issue)).toBeNull();
      // The skipped pin is visible, marked advisory — alongside the label note.
      const messages = harness.activity.map((entry) => entry.message);
      expect(messages.some((m) => m.includes("classified this issue as T2"))).toBe(true);
      expect(messages.some((m) => m.includes("advisory, nothing written"))).toBe(true);
    });
  }
});
