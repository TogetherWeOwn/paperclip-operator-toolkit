import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { PLUGIN_STATE_KEYS } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { LAST_RUN_CONTEXT_USAGE_SQL } from "../src/sql.js";
import type { EarnInState, ModelEntry, ModelScore } from "../src/engine/types.js";
import { account, laneDoc, MODELS, NO_ESCALATION, NOW, PROFILES, subCallPins } from "./fixtures.js";

const COMPANY = "co-1";
const AGENT = "agent-1";

/**
 * Earn-in worker hookup: `planEarnIn`/`recordEarnInOutcome` wired
 * into `worker.ts` — the `earnInState` seam, the balancePass unpinned-branch
 * admission, completion/cancellation and adverse resolution folds, cadence
 * replay, pin rollback, survivor guards and concurrent-event serialization.
 *
 * Roster shape: MODELS has exactly one T1 row (`claude-opus-5`, proven at T1
 * in MODEL_SCORES terms — but the tests below seed their own scores). The
 * rival is a local second T1 row, mirroring `withOpusAlt` in
 * scheduled-passes.spec.ts. The rival is unproven-but-capable at T1, on its
 * own lane, so `planEarnIn` can admit it.
 */

const RIVAL = "earn-in-rival-1";
const RIVAL_LANE = "lane-rival";

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

function classLabel(cls: string) {
  return { id: `lbl-class-${cls}`, companyId: COMPANY, name: `class:${cls}`, color: "#000", createdAt: new Date(0), updatedAt: new Date(0) };
}

function roster(): ModelEntry[] {
  // The rival is a second T1 row on its OWN lane: opus serves `lane-opus`
  // and the rival serves `lane-rival`. Sharing one lane would make per-tier
  // posture unable to starve the rival without also starving the balanced
  // pick's lane — the exact shape the starved-posture test must distinguish
  // (named mutant: global-lane-check-passes-while-target-tier-starved).
  // NOTE: both T1 rows share one lane ONLY in the sense that posture is
  // per-tier — the test starves BOTH T1 lanes (rival exhausted + opus
  // lane left without availability evidence is NOT enough; see the starved
  // test, which marks both T1 lanes exhausted).
  const opus = MODELS.find((m) => m.id === "claude-opus-5")!;
  return [
    ...MODELS.map((m) => (m.id === "claude-opus-5" ? { ...m, laneId: "lane-opus" } : m)),
    { ...opus, id: RIVAL, laneId: RIVAL_LANE },
  ];
}

function tierVerdict(proven: boolean, capable: boolean | null) {
  return {
    n: proven ? 20 : 3, ok: proven ? 18 : 3, failInfra: 0, failModel: 0, tmo: 0,
    nEff: 2, pObs: 0.9, p: 0.9, capable, proven,
    costPerSuccessUsd: null, medMin: null, rework: 0,
  };
}

function scoreFor(modelId: string, t1Proven: boolean, t1Capable: boolean | null): ModelScore {
  // monotone cap walks easy→hard: a T3 score of `capable: false`
  // would cap the harder T1 at `capable: false` too. The rival's easier tiers
  // carry measured-capable verdicts so T1 keeps its own unproven-capable
  // verdict — the shape earn-in exists to admit.
  const easy = tierVerdict(true, true);
  return {
    modelId, aaIndex: null, priorP: 0.8,
    // : `Tier` now includes T0 (explicit-only, never earn-in
    // admitted) — the fixture carries it as unproven/unknown.
    tiers: { T0: tierVerdict(false, null), T1: tierVerdict(t1Proven, t1Capable), T2: { ...easy }, T3: { ...easy } },
    overall: { ...easy },
  };
}

/** Rival unproven-but-capable at T1; opus proven at T1 (not an earn-in candidate). */
async function seedScores(harness: Awaited<ReturnType<typeof boot>>) {
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.modelScores },
    {
      modelScores: [scoreFor(RIVAL, false, true), scoreFor("claude-opus-5", true, true)],
      cardLedger: {},
    },
  );
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true },
    models: roster(),
    tierLabelIds: { T1: "lbl-T1", T2: "lbl-T2", T3: "lbl-T3" },
    classification: { enabled: true },
    earnIn: { enabled: true },
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
  // Earn-in admission reads the pace ledger AND the availability document the
  // same way selection does — a lane no instrument can see is "saturated"
  // for experimental traffic (slice-1 tightening). Seed both candidate lanes
  // `on` with a fresh availability document; the starved test below flips
  // the rival lane to `exhausted`.
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneAvailability },
    laneDoc(
      [
        { ...account("lane-opus", "opus-a"), provider: "lane-opus" },
        { ...account("lane-opus", "opus-b"), provider: "lane-opus" },
        { ...account("lane-rival", "rival-a"), provider: "lane-rival" },
        { ...account("lane-rival", "rival-b"), provider: "lane-rival" },
      ],
      new Date(NOW).toISOString(),
    ),
  );
  const at = new Date(NOW).toISOString();
  const onVerdict = (laneId: string) => ({
    laneId,
    observedAt: at,
    state: "on",
    serviceable: true,
    score: { utilization: 0.5, elapsed: 0.5, deviation: 0 },
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 1,
    urgentResetAt: null,
    reason: "test",
  });
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
    {
      "lane-opus": { laneId: "lane-opus", fetchedAt: at, error: null, observation: null, verdict: onVerdict("lane-opus") },
      [RIVAL_LANE]: { laneId: RIVAL_LANE, fetchedAt: at, error: null, observation: null, verdict: onVerdict(RIVAL_LANE) },
    },
  );
  return harness;
}

async function readEarnInState(harness: Awaited<ReturnType<typeof boot>>): Promise<EarnInState> {
  const stored = await harness.ctx.state.get({
    scopeKind: "company",
    scopeId: COMPANY,
    stateKey: PLUGIN_STATE_KEYS.earnInState,
  });
  return stored as unknown as EarnInState;
}

function pinnedModel(harness: Awaited<ReturnType<typeof boot>>, id: string) {
  return harness.ctx.issues.get(id, COMPANY).then(
    (entry) =>
      (entry?.assigneeAdapterOverrides as { adapterConfig?: { model?: string } } | null)?.adapterConfig?.model ??
      null,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("earn-in worker hookup", () => {
  /**
   * The balancePass row query is `from issues i`; the live-run guards read
   * `heartbeat_runs` (`status in ('running','queued')` /
   * `status in ('queued', 'running')`). Default every other query to empty so
   * the card reads idle with no live runs — the same shape `stubRunRows` in
   * creation-pin.spec.ts gives the creation path.
   */
  function stubBoard(harness: Awaited<ReturnType<typeof boot>>, issueId = "i1") {
    harness.ctx.db.query = (async (query: string) => {
      // Fresh aggregate (firing start reads newer than the epoch mark) so
      // the incremental gate runs the cycle instead of skipping it.
      if (query.includes("max(updated_at)")) return [{ max_updated: new Date(NOW).toISOString() }];
      if (query.includes("from issues i")) return [{ id: issueId, identifier: issueId }];
      return [];
    }) as typeof harness.ctx.db.query;
  }

  it("stays inert while earnIn.enabled is false: balanced pick stands, no state written", async () => {
    const card = issue("i1", {
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
    });
    const harness = await boot(baseConfig({ earnIn: { enabled: false } }), [card], [agentRow()]);
    await seedScores(harness);
    stubBoard(harness);

    await harness.runJob("balancePass");

    // The balanced T1 pick (opus) stands — no earn-in rival took the card.
    expect(await pinnedModel(harness, "i1")).toBe("claude-opus-5");
    // No earn-in state was written at all.
    expect(await readEarnInState(harness)).toBeNull();
    expect(
      harness.activity.some((entry) => String(entry?.message).includes("earn-in admitted")),
    ).toBe(false);
  });

  it("admits the unproven rival on the balancePass unpinned branch and records dispatch state", async () => {
    const card = issue("i1", {
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
    });
    const harness = await boot(baseConfig(), [card], [agentRow()]);
    await seedScores(harness);
    stubBoard(harness);

    await harness.runJob("balancePass");

    // The rival won the card instead of the balanced opus pick.
    expect(await pinnedModel(harness, "i1")).toBe(RIVAL);
    const state = await readEarnInState(harness);
    expect(state.counter[RIVAL]).toBe(1);
    expect(state.dispatchedKeys).toEqual([`i1:${RIVAL}:earnin`]);
    expect(state.activePerModel[RIVAL]).toBe(1);
    expect(state.activePerLane[RIVAL_LANE]).toEqual(["i1"]);
    expect(
      harness.activity.some((entry) => String(entry?.message).includes("earn-in admitted")),
    ).toBe(true);
  });

  it("chooses the highest prior deterministically and breaks ties by roster order", async () => {
    const second = `${RIVAL}-second`;
    for (const priorP of [0.95, 0.8]) {
      const models = [...roster(), { ...roster().find((model) => model.id === RIVAL)!, id: second }];
      const harness = await boot(baseConfig({ models }),
        [issue("i1", { labels: [tierLabel("T1"), classLabel("research")] })]);
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.modelScores },
        { modelScores: [scoreFor(RIVAL, false, true), { ...scoreFor(second, false, true), priorP },
          scoreFor("claude-opus-5", true, true)], cardLedger: {} },
      );
      stubBoard(harness);
      await harness.runJob("balancePass");
      expect(await pinnedModel(harness, "i1")).toBe(priorP > 0.8 ? second : RIVAL);
    }
  });

  it("advances an eligible non-due counter without recording a dispatch", async () => {
    const card = issue("i1", {
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
    });
    const harness = await boot(baseConfig(), [card], [agentRow()]);
    await seedScores(harness);
    // The rival's deterministic counter is mid-cycle (not a multiple of 12):
    // Every other gate clears, so advance the eligible-pick counter even
    // though it is not this candidate's dispatch turn. Record no admission.
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState },
      {
        counter: { [RIVAL]: 1 },
        dispatchedThisWeek: {},
        activePerModel: {},
        activePerLane: {},
        firstEightOutcomes: {},
        stopped: {},
        dispatchedKeys: [],
      },
    );
    stubBoard(harness);

    await harness.runJob("balancePass");

    // The balanced T1 pick (opus) stands — the rival was refused on cadence.
    expect(await pinnedModel(harness, "i1")).toBe("claude-opus-5");
    const state = await readEarnInState(harness);
    expect(state.counter[RIVAL]).toBe(2);
    expect(state.dispatchedKeys).toEqual([]);
    expect(
      harness.activity.some((entry) => String(entry?.message).includes("earn-in admitted")),
    ).toBe(false);
  });

  it("replays thirteen eligible picks across restarts: admissions at counter zero and twelve, completed cards release slots", async () => {
    let saved: EarnInState | null = null;
    const admitted: number[] = [];
    for (let pick = 0; pick < 13; pick += 1) {
      const id = `i${pick + 1}`;
      const card = issue(id, { labels: [tierLabel("T1"), classLabel("research")] });
      const harness = await boot(baseConfig(), [card]);
      await seedScores(harness);
      if (saved) await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState }, saved,
      );
      stubBoard(harness, id);
      await harness.runJob("balancePass");
      if (await pinnedModel(harness, id) === RIVAL) {
        admitted.push(pick);
        await harness.emit("issue.updated", { changes: { status: { from: "in_progress", to: "done" } } },
          { entityId: id, companyId: COMPANY, entityType: "issue" });
        // Duplicate delivery must not fold the same completion twice.
        await harness.emit("issue.updated", { changes: { status: { from: "in_progress", to: "done" } } },
          { entityId: id, companyId: COMPANY, entityType: "issue" });
      }
      saved = await readEarnInState(harness);
    }
    expect(admitted).toEqual([0, 12]);
    expect(saved?.counter[RIVAL]).toBe(13);
    expect(saved?.activePerModel[RIVAL]).toBe(0);
    expect(saved?.firstEightOutcomes[RIVAL]).toEqual(["ok", "ok"]);
    expect(saved?.dispatchedThisWeek[RIVAL]).toHaveLength(2);
  });

  it("advisory mode writes neither a pin nor earn-in bookkeeping", async () => {
    const harness = await boot(baseConfig({ selection: { enabled: true, mode: "advise" } }),
      [issue("i1", { labels: [tierLabel("T1"), classLabel("research")] })]);
    await seedScores(harness);
    stubBoard(harness);
    await harness.runJob("balancePass");
    expect(await pinnedModel(harness, "i1")).toBeNull();
    expect(await readEarnInState(harness)).toBeNull();
  });

  it("a rejected pin write consumes no earn-in slot, key, weekly budget or counter", async () => {
    const harness = await boot(baseConfig(),
      [issue("i1", { labels: [tierLabel("T1"), classLabel("research")] })]);
    await seedScores(harness);
    stubBoard(harness);
    vi.spyOn(harness.ctx.issues, "update").mockRejectedValue(new Error("pin refused"));
    await harness.runJob("balancePass");
    expect(await pinnedModel(harness, "i1")).toBeNull();
    const state = await readEarnInState(harness);
    expect(state?.activePerModel[RIVAL] ?? 0).toBe(0);
    expect(state?.dispatchedKeys ?? []).toEqual([]);
    expect(state?.dispatchedThisWeek[RIVAL] ?? []).toEqual([]);
    expect(state?.counter[RIVAL] ?? 0).toBe(0);
    expect(harness.activity.some((entry) => String(entry.message).includes("earn-in admitted"))).toBe(false);
  });

  it("rolls back a reservation when a run arrives at the final idle guard", async () => {
    const harness = await boot(baseConfig(),
      [issue("i1", { labels: [tierLabel("T1"), classLabel("research")] })]);
    await seedScores(harness);
    stubBoard(harness);
    const query = harness.ctx.db.query;
    harness.ctx.db.query = (async (sql: string, ...args: unknown[]) => {
      if (sql.includes("from heartbeat_runs") && (await readEarnInState(harness))?.activePerModel[RIVAL]) {
        return [{ issue_id: "i1" }];
      }
      return query(sql, ...args as [never]);
    }) as typeof harness.ctx.db.query;
    await harness.runJob("balancePass");
    expect(await pinnedModel(harness, "i1")).toBeNull();
    const state = await readEarnInState(harness);
    expect(state?.counter[RIVAL] ?? 0).toBe(0);
    expect(state?.activePerModel[RIVAL] ?? 0).toBe(0);
    expect(state?.dispatchedKeys ?? []).toEqual([]);
  });

  it("admits even when the balanced selection equals a healthy agent floor", async () => {
    const harness = await boot(baseConfig(),
      [issue("i1", { labels: [tierLabel("T1"), classLabel("research")] })],
      [agentRow({ adapterConfig: { model: "claude-opus-5" } })]);
    await seedScores(harness);
    stubBoard(harness);
    await harness.runJob("balancePass");
    expect(await pinnedModel(harness, "i1")).toBe(RIVAL);
    expect((await readEarnInState(harness)).counter[RIVAL]).toBe(1);
  });

  it("does not bypass selection's context gate for an unproven rival", async () => {
    const harness = await boot(baseConfig({ models: roster().map((model) =>
      model.id === RIVAL ? { ...model, contextWindow: 1 } : model,
    ) }), [issue("i1", { labels: [tierLabel("T1"), classLabel("research")] })]);
    await seedScores(harness);
    stubBoard(harness);
    const query = harness.ctx.db.query;
    harness.ctx.db.query = (async (sql: string, ...args: unknown[]) => {
      // Existing run without a usable peak falls back to the fleet ceiling.
      if (sql === LAST_RUN_CONTEXT_USAGE_SQL) return [{ id: "prior-run" }];
      return query(sql, ...args as [never]);
    }) as typeof harness.ctx.db.query;
    await harness.runJob("balancePass");
    expect(await pinnedModel(harness, "i1")).toBe("claude-opus-5");
    expect(await readEarnInState(harness)).toBeNull();
  });

  it("concurrent duplicate completions fold each card once without losing outcomes", async () => {
    const harness = await boot(baseConfig());
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState },
      {
        counter: { [RIVAL]: 2 }, dispatchedThisWeek: { [RIVAL]: [NOW, NOW] },
        activePerModel: { [RIVAL]: 2 }, activePerLane: { [RIVAL_LANE]: ["i1", "i2"] },
        firstEightOutcomes: {}, stopped: {}, dispatchedKeys: [`i1:${RIVAL}:earnin`, `i2:${RIVAL}:earnin`],
      },
    );
    await Promise.all(["i1", "i2", "i1", "i2"].map((id) => harness.emit("issue.updated",
      { changes: { status: { from: "in_progress", to: "done" } } },
      { entityId: id, companyId: COMPANY, entityType: "issue" },
    )));
    const state = await readEarnInState(harness);
    expect(state.activePerModel[RIVAL]).toBe(0);
    expect(state.activePerLane[RIVAL_LANE]).toEqual([]);
    expect(state.firstEightOutcomes[RIVAL]).toEqual(["ok", "ok"]);
  });

  it("cancellation releases capacity without supplying accepted quality evidence", async () => {
    const harness = await boot(baseConfig(),
      [issue("i1", { labels: [tierLabel("T1"), classLabel("research")] })]);
    await seedScores(harness);
    stubBoard(harness);
    await harness.runJob("balancePass");
    await harness.emit("issue.updated", { changes: { status: { from: "todo", to: "cancelled" } } },
      { entityId: "i1", companyId: COMPANY, entityType: "issue" });
    const state = await readEarnInState(harness);
    expect(state.activePerModel[RIVAL]).toBe(0);
    expect(state.firstEightOutcomes[RIVAL] ?? []).toEqual([]);
  });

  it("late reopen and rejection replace completed first-eight slots and stop at two failures", async () => {
    const harness = await boot(baseConfig());
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState },
      {
        counter: { [RIVAL]: 2 }, dispatchedThisWeek: { [RIVAL]: [NOW, NOW] },
        activePerModel: { [RIVAL]: 2 }, activePerLane: { [RIVAL_LANE]: ["i1", "i2"] },
        firstEightOutcomes: {}, stopped: {}, dispatchedKeys: [`i1:${RIVAL}:earnin`, `i2:${RIVAL}:earnin`],
      },
    );
    for (const id of ["i1", "i2"]) await harness.emit("issue.updated",
      { changes: { status: { from: "in_progress", to: "done" } } },
      { entityId: id, companyId: COMPANY, entityType: "issue" });
    await harness.emit("issue.updated", { changes: { status: { from: "done", to: "in_progress" } } },
      { entityId: "i1", companyId: COMPANY, entityType: "issue" });
    // Duplicate adverse signals must neither append outcomes nor release again.
    for (const id of ["i1", "i2", "i2"]) await harness.emit("issue.comment.created",
      { bodySnippet: "changes requested: rework the approach" },
      { entityId: id, companyId: COMPANY, entityType: "issue" });
    const state = await readEarnInState(harness);
    expect(state.firstEightOutcomes[RIVAL]).toEqual(["material-failure", "material-failure"]);
    expect(state.activePerModel[RIVAL]).toBe(0);
    expect(state.stopped[RIVAL]).toBe(true);
  });

  it("late safety evidence stops a dispatched model even beyond its first eight completed cards", async () => {
    const harness = await boot(baseConfig());
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState },
      {
        counter: { [RIVAL]: 9 }, dispatchedThisWeek: {}, activePerModel: {}, activePerLane: {},
        firstEightOutcomes: { [RIVAL]: Array(8).fill("ok") }, stopped: {},
        dispatchedKeys: [`i9:${RIVAL}:earnin`],
      },
    );
    await harness.emit("agent.run.failed",
      { issueId: "i9", modelId: RIVAL, errorCode: "policy_violation", error: "safety violation" },
      { companyId: COMPANY });
    const state = await readEarnInState(harness);
    expect(state.stopped[RIVAL]).toBe(true);
    expect(state.firstEightOutcomes[RIVAL]).toEqual(Array(8).fill("ok"));
  });

  it("a healthy T1 incumbent cannot admit a rival whose own lane is exhausted", async () => {
    const harness = await boot(baseConfig(),
      [issue("i1", { labels: [tierLabel("T1"), classLabel("research")] })]);
    await seedScores(harness);
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneAvailability },
      laneDoc([
        { ...account("lane-opus", "opus-a"), provider: "lane-opus" },
        { ...account("lane-opus", "opus-b"), provider: "lane-opus" },
        { ...account(RIVAL_LANE, "rival-a"), provider: RIVAL_LANE, health: "exhausted" },
      ], new Date(NOW).toISOString()),
    );
    stubBoard(harness);
    await harness.runJob("balancePass");
    expect(await pinnedModel(harness, "i1")).toBe("claude-opus-5");
    expect(await readEarnInState(harness)).toBeNull();
  });

  it("releases the slot and folds a model-attributable run failure", async () => {
    const card = issue("i1", {
      status: "done",
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
      assigneeAdapterOverrides: { adapterConfig: { model: RIVAL } },
    });
    const harness = await boot(baseConfig(), [card], [agentRow()]);
    await seedScores(harness);
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState },
      {
        counter: { [RIVAL]: 1 },
        dispatchedThisWeek: { [RIVAL]: [NOW] },
        activePerModel: { [RIVAL]: 1 },
        activePerLane: { [RIVAL_LANE]: ["i1"] },
        firstEightOutcomes: {},
        stopped: {},
        dispatchedKeys: [`i1:${RIVAL}:earnin`],
      },
    );

    await harness.emit(
      "agent.run.failed",
      { issueId: "i1", errorCode: "timeout", error: "run timed out on rival" },
      { companyId: COMPANY },
    );

    const state = await readEarnInState(harness);
    expect(state.activePerModel[RIVAL]).toBe(0);
    expect(state.activePerLane[RIVAL_LANE]).toEqual([]);
    expect(state.firstEightOutcomes[RIVAL]).toEqual(["material-failure"]);
  });

  it("releases the slot without folding on infra failure", async () => {
    const card = issue("i1", {
      status: "done",
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
      assigneeAdapterOverrides: { adapterConfig: { model: RIVAL } },
    });
    const harness = await boot(baseConfig(), [card], [agentRow()]);
    await seedScores(harness);
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState },
      {
        counter: { [RIVAL]: 1 },
        dispatchedThisWeek: { [RIVAL]: [NOW] },
        activePerModel: { [RIVAL]: 1 },
        activePerLane: { [RIVAL_LANE]: ["i1"] },
        firstEightOutcomes: {},
        stopped: {},
        dispatchedKeys: [`i1:${RIVAL}:earnin`],
      },
    );

    await harness.emit(
      "agent.run.failed",
      { issueId: "i1", errorCode: "auth_unavailable", error: "503 auth_unavailable: no auth available" },
      { companyId: COMPANY },
    );

    const state = await readEarnInState(harness);
    expect(state.activePerModel[RIVAL]).toBe(0);
    expect(state.activePerLane[RIVAL_LANE]).toEqual([]);
    expect(state.firstEightOutcomes[RIVAL] ?? []).toHaveLength(0);
    expect(state.stopped[RIVAL]).toBeFalsy();
  });

  it("resolves a reopened earn-in card as a rejection without touching the rework signal", async () => {
    const card = issue("i1", {
      status: "in_progress",
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
      assigneeAdapterOverrides: { adapterConfig: { model: RIVAL } },
    });
    const harness = await boot(baseConfig(), [card], [agentRow()]);
    await seedScores(harness);
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState },
      {
        counter: { [RIVAL]: 1 },
        dispatchedThisWeek: { [RIVAL]: [NOW] },
        activePerModel: { [RIVAL]: 1 },
        activePerLane: { [RIVAL_LANE]: ["i1"] },
        firstEightOutcomes: {},
        stopped: {},
        dispatchedKeys: [`i1:${RIVAL}:earnin`],
      },
    );

    await harness.emit(
      "issue.updated",
      { changes: { status: { from: "done", to: "in_progress" } } },
      { entityId: "i1", companyId: COMPANY, entityType: "issue" },
    );

    const state = await readEarnInState(harness);
    expect(state.activePerModel[RIVAL]).toBe(0);
    expect(state.firstEightOutcomes[RIVAL]).toEqual(["material-failure"]);
  });

  it("resolves a rejection comment on an earn-in card as a material failure", async () => {
    const card = issue("i1", {
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
      assigneeAdapterOverrides: { adapterConfig: { model: RIVAL } },
    });
    const harness = await boot(baseConfig(), [card], [agentRow()]);
    await seedScores(harness);
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState },
      {
        counter: { [RIVAL]: 1 },
        dispatchedThisWeek: { [RIVAL]: [NOW] },
        activePerModel: { [RIVAL]: 1 },
        activePerLane: { [RIVAL_LANE]: ["i1"] },
        firstEightOutcomes: {},
        stopped: {},
        dispatchedKeys: [`i1:${RIVAL}:earnin`],
      },
    );

    await harness.emit(
      "issue.comment.created",
      { bodySnippet: "changes requested: rework the approach" },
      { entityId: "i1", companyId: COMPANY, entityType: "issue" },
    );

    const state = await readEarnInState(harness);
    expect(state.activePerModel[RIVAL]).toBe(0);
    expect(state.firstEightOutcomes[RIVAL]).toEqual(["material-failure"]);
  });

  it("writes nothing on resolution signals for cards with no active earn-in entry", async () => {
    const card = issue("i1", {
      status: "in_progress",
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
      assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
    });
    const harness = await boot(baseConfig(), [card], [agentRow()]);
    await seedScores(harness);

    await harness.emit(
      "issue.updated",
      { changes: { status: { from: "done", to: "in_progress" } } },
      { entityId: "i1", companyId: COMPANY, entityType: "issue" },
    );
    await harness.emit(
      "agent.run.failed",
      { issueId: "i1", errorCode: "timeout", error: "run timed out" },
      { companyId: COMPANY },
    );

    expect(await readEarnInState(harness)).toBeNull();
  });

  it("stops the rival after two material failures in its first eight", async () => {
    const card = issue("i1", {
      status: "done",
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
      assigneeAdapterOverrides: { adapterConfig: { model: RIVAL } },
    });
    const harness = await boot(baseConfig(), [card], [agentRow()]);
    await seedScores(harness);
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState },
      {
        counter: { [RIVAL]: 1 },
        dispatchedThisWeek: { [RIVAL]: [NOW] },
        activePerModel: { [RIVAL]: 1 },
        activePerLane: { [RIVAL_LANE]: ["i1"] },
        firstEightOutcomes: { [RIVAL]: ["material-failure"] },
        stopped: {},
        dispatchedKeys: [`i1:${RIVAL}:earnin`],
      },
    );

    await harness.emit(
      "agent.run.failed",
      { issueId: "i1", errorCode: "timeout", error: "run timed out again" },
      { companyId: COMPANY },
    );

    const state = await readEarnInState(harness);
    expect(state.firstEightOutcomes[RIVAL]).toEqual(["material-failure", "material-failure"]);
    expect(state.stopped[RIVAL]).toBe(true);
  });

  it("keeps the balanced pick when T1 posture is starved (per-tier, never global)", async () => {
    // BOTH T1 lanes (opus + rival) read exhausted at both instruments while
    // the T3 lane stays healthy — the per-tier rule (named mutant:
    // global-lane-check-passes-while-target-tier-starved) refuses admission
    // because the CARD's tier (T1) has no open lane, even though another
    // tier does. Starving only the rival lane would leave opus's lane open
    // and T1 available — correctly admitting, not refusing.
    const card = issue("i1", {
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
    });
    const harness = await boot(baseConfig({ pacing: { mode: "enforce" } }), [card], [agentRow()]);
    await seedScores(harness);
    // Both T1 lanes exhausted at the pace layer AND the availability
    // document (the boot seed covers both lanes healthy; overwrite both
    // instruments so every T1 lane reads starved everywhere posture looks). Pacing runs in
    // `enforce` here so the ledger hard-stop binds — under the default
    // `shadow` mode the ledger is advisory and only the document judges.
    const at = new Date(NOW).toISOString();
    // Both T1 lanes exhausted at the ledger…
    const offVerdict = (laneId: string) => ({
      laneId,
      observedAt: at,
      state: "exhausted",
      serviceable: false,
      score: null,
      accounts: [],
      knownAccountCount: 1,
      knownWeight: 1,
      serviceableAccountCount: 0,
      urgentResetAt: null,
      reason: "fixture exhausted",
    });
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
      {
        "lane-opus": {
          laneId: "lane-opus",
          fetchedAt: at,
          error: null,
          observation: null,
          verdict: offVerdict("lane-opus"),
        },
        [RIVAL_LANE]: {
          laneId: RIVAL_LANE,
          fetchedAt: at,
          error: null,
          observation: null,
          verdict: offVerdict(RIVAL_LANE),
        },
      },
    );
    // …and at the availability document. T3 (haiku, lane-less here) is
    // untouched — proving the refusal is per-tier, not global.
    const offAccount = (provider: string, key: string) => ({
      ...account(provider, key),
      provider,
      health: "exhausted",
    });
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneAvailability },
      laneDoc(
        [
          offAccount("lane-opus", "opus-a"),
          offAccount("lane-opus", "opus-b"),
          offAccount("lane-rival", "rival-a"),
          offAccount("lane-rival", "rival-b"),
        ],
        at,
      ),
    );
    stubBoard(harness);

    await harness.runJob("balancePass");

    // Starved T1: nothing pins — the balanced pick itself cannot clear
    // the dead T1 lanes either (advise finds no eligible model), so the
    // card stays unpinned. The assertion that matters is the second one:
    // no experimental traffic was admitted into a starved tier.
    expect(await pinnedModel(harness, "i1")).toBeNull();
    expect(await readEarnInState(harness)).toBeNull();
  });

  it("a late run failure after completion never rewrites a recorded outcome", async () => {
    const harness = await boot(baseConfig());
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState },
      {
        counter: { [RIVAL]: 1 },
        dispatchedThisWeek: { [RIVAL]: [NOW] },
        activePerModel: { [RIVAL]: 1 },
        activePerLane: { [RIVAL_LANE]: ["i1"] },
        firstEightOutcomes: {},
        stopped: {},
        dispatchedKeys: [`i1:${RIVAL}:earnin`],
      },
    );
    // Completion folds "ok" and records the card's first-eight slot.
    await harness.emit("issue.updated", { changes: { status: { from: "in_progress", to: "done" } } },
      { entityId: "i1", companyId: COMPANY, entityType: "issue" });
    // A model-kind run failure landing AFTER the card resolved (a run that
    // marked the card done and then timed out, or a later failed run on the
    // done card) is not a quality verdict on delivered work: the "ok" slot
    // stands and the stop circuit does not move. Only an explicit
    // rejection/reopen or a safety violation corrects a recorded outcome.
    await harness.emit("agent.run.failed",
      { issueId: "i1", errorCode: "timeout", error: "run timed out after delivery" },
      { companyId: COMPANY });
    const state = await readEarnInState(harness);
    expect(state.firstEightOutcomes[RIVAL]).toEqual(["ok"]);
    expect(state.activePerModel[RIVAL]).toBe(0);
    expect(state.activePerLane[RIVAL_LANE]).toEqual([]);
    expect(state.stopped[RIVAL] ?? false).toBe(false);
  });

  it("a run failure never waits on an in-flight balance row while disabled", async () => {
    const card = issue("i1", {
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
    });
    const harness = await boot(baseConfig({ earnIn: { enabled: false } }), [card], [agentRow()]);
    await seedScores(harness);
    stubBoard(harness);
    // Park the row inside its pin write: with earn-in disabled the row must
    // hold NO earn-in lock, so the latency-sensitive run-failure hook (which
    // funnels through the earn-in resolve seam before the lane quarantine)
    // sails through instead of queueing behind the row.
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const innerUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
    let updateCalls = 0;
    let updateEntered = false;
    harness.ctx.issues.update = (async (...args: Parameters<typeof innerUpdate>) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        updateEntered = true;
        await updateGate;
      }
      return innerUpdate(...args);
    }) as typeof innerUpdate;
    const pass = harness.runJob("balancePass");
    for (let i = 0; i < 400 && !updateEntered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(updateEntered).toBe(true);
    try {
      const verdict = await Promise.race([
        harness.emit("agent.run.failed",
          { issueId: "i9", errorCode: "timeout", error: "run timed out elsewhere" },
          { companyId: COMPANY }).then(() => "resolved"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 3000)),
      ]);
      expect(verdict).toBe("resolved");
    } finally {
      releaseUpdate();
    }
    await pass;
    expect(await readEarnInState(harness)).toBeNull();
  });

  it("releases an active entry that completes while disabled, and admits again after re-enable", async () => {
    const card = issue("i1", {
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
    });
    const harness = await boot(baseConfig(), [card], [agentRow()]);
    await seedScores(harness);
    stubBoard(harness);
    await harness.runJob("balancePass");
    expect(await pinnedModel(harness, "i1")).toBe(RIVAL);

    // Incident rollback: the flag goes off with a card still dispatched.
    harness.setConfig(baseConfig({ earnIn: { enabled: false } }));

    // Completion while disabled still releases the slot and folds the
    // outcome — otherwise the per-model/per-lane active caps stay wedged
    // after re-enable (both default to 1) and nothing ever admits again.
    await harness.emit("issue.updated", { changes: { status: { from: "in_progress", to: "done" } } },
      { entityId: "i1", companyId: COMPANY, entityType: "issue" });
    const released = await readEarnInState(harness);
    expect(released.activePerModel[RIVAL] ?? 0).toBe(0);
    expect(released.activePerLane[RIVAL_LANE] ?? []).toEqual([]);
    expect(released.firstEightOutcomes[RIVAL]).toEqual(["ok"]);

    // Re-enabled world (fresh boot, carried state — an incident rollback is
    // a restart) with the next dispatch turn due: the rival admits a fresh
    // card, proving the caps were not wedged by the disabled completion.
    // A second pass on the same harness would trip the quiet-board skip, so
    // this mirrors the replay test's one-boot-per-pass shape.
    const reopened = await boot(baseConfig(), [issue("i4", {
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
    })], [agentRow()]);
    await seedScores(reopened);
    await reopened.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.earnInState },
      { ...released, counter: { [RIVAL]: 12 } },
    );
    stubBoard(reopened, "i4");
    await reopened.runJob("balancePass");
    expect(await pinnedModel(reopened, "i4")).toBe(RIVAL);
    const readmitted = await readEarnInState(reopened);
    expect(readmitted.activePerModel[RIVAL]).toBe(1);
    expect(readmitted.activePerLane[RIVAL_LANE]).toEqual(["i4"]);
  });

  it("pins subCallPins env on the earn-in winner like any other pin", async () => {
    const card = issue("i1", {
      labels: [tierLabel("T1"), classLabel("research")],
      labelIds: ["lbl-T1", "lbl-class-research"],
    });
    const harness = await boot(baseConfig(), [card], [agentRow()]);
    await seedScores(harness);
    stubBoard(harness);

    await harness.runJob("balancePass");

    const after = await harness.ctx.issues.get("i1", COMPANY);
    expect(after?.assigneeAdapterOverrides).toEqual({
      adapterConfig: {
        model: RIVAL,
        env: subCallPins(RIVAL, "claude-haiku-4-5-20251001"),
      },
    });
  });
});
