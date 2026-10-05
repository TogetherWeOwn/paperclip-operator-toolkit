import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { pluginManifestV1Schema } from "@paperclipai/shared/validators/plugin";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { LOCAL_FOLDER_KEYS, PLUGIN_STATE_KEYS, TIERS, TOOL_NAMES } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { BENCHMARK_SPEC_VERSION, type BenchmarkRow } from "../src/engine/benchmark-prior.js";
import { buildModelScore } from "../src/engine/scores.js";
import type { ModelScore } from "../src/engine/types.js";
import type { LaneLedger, LaneLedgerEntry } from "../src/engine/pacing.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";
import { SHADOW_SCHEMA_VERSION } from "../src/shadow-emit.js";
import { budgetWindowId, type BudgetWindowObservation } from "../src/admission-budget.js";
import type {
  DecisionAdmissionShadowInput, AdmissionShadowReport, LaneSnapshotAdmissionShadowInput,
} from "../src/admission-shadow.js";
import { LANED_MODELS, MODELS, NO_ESCALATION, NOW, PROFILES, account, laneDoc, subCallPins } from "./fixtures.js";
import { assistantUsage, contextLogFixture, runLog } from "./context-log-fixture.js";

const COMPANY = "co-1";
const ISSUE = "issue-1";
const AGENT = "agent-1";
const TIER_LABEL_ID = "lbl-t1";
const OTHER_LABEL_ID = "lbl-other";

// : freeze the wall clock at the fixture NOW so the seeded PROFILES
// (computedAt = NOW - 1h) stay inside the production 14-day guard
// (src/engine/cost.ts). Date-only: async timers keep running. The two lane
// tests below that stamp `new Date()` explicitly stay consistent — the stamp
// and the worker's `Date.now()` read the same frozen clock.
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

/**
 * A benchmark basket that clears the coverage gate (4 populated, 0.85 weight),
 * so the score it backs carries a `blended` basis. A promotion needs one: the
 * overlay refuses to promote on an `index-only` basis, and a fixture with no
 * basket would make this test pass for the wrong reason — or, once that refusal
 * landed, fail while the wiring it exists to cover was perfectly fine.
 */
const STRONG_BASKET = {
  terminalBenchV4Pass1: 0.5,
  mercorApex11Pass1: 0.6,
  automationBenchAaGuardrailAdjusted: 0.6,
  aaOmniscienceSignedIndex: 30,
};

/**
 * A stored score that promotes the configured-T2 `claude-sonnet-5` to T1.
 * `tiers.T1.capable` is forced true because the capability gate in `select.ts`
 * is a separate concern from the tier bucket — a promoted model that still
 * reads `capable: false` would be rejected before the tier overlay could show.
 */
function promotedSonnet(basket: BenchmarkRow | null = STRONG_BASKET): ModelScore {
  const score = buildModelScore("claude-sonnet-5", 38, {}, TIERS, basket);
  return {
    ...score,
    tiers: { ...score.tiers, T1: { ...score.tiers.T1, capable: true } },
    derivedTier: "T1",
    tierSpecVersion: BENCHMARK_SPEC_VERSION,
  };
}

async function boot(
  config: Record<string, unknown>,
  seedIssue = issue(),
  agents: Parameters<ReturnType<typeof createTestHarness>["seed"]>[0]["agents"] = [],
) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ issues: [seedIssue], agents });
  // `definePlugin` returns a sealed wrapper; the lifecycle handlers live on
  // `.definition`. No optional chaining here — a missing setup must fail loudly
  // rather than leave every tool unregistered and the assertions vacuous.
  const plugin = createPlugin();
  const setup = plugin.definition.setup;
  if (!setup) throw new Error("plugin definition has no setup handler");
  await setup(harness.ctx);
  //  reopen: the worker tracks its known companies from
  // `onConfigChanged` replays instead of `ctx.companies.list()` — mirror the
  // host's real startup config-delivery sequence (plugin-loader.ts step 5b)
  // so the scheduled jobs under test see this company.
  const onConfigChanged = plugin.definition.onConfigChanged;
  if (!onConfigChanged) throw new Error("plugin definition has no onConfigChanged handler");
  await onConfigChanged(config, { companyId: COMPANY });
  // Seed the volume profiles the engine refuses to act without.
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
    { profiles: PROFILES, signals: NO_ESCALATION },
  );
  return harness;
}

function admissionSnapshot(): DecisionAdmissionShadowInput {
  const window: BudgetWindowObservation = {
    providerId: "fixture-provider", poolId: "fixture-pool", kind: "weekly", startAt: NOW - 1000,
    resetAt: NOW + 100_000, observedAt: NOW, sourceRevision: "fixture", schemaRevision: "v1",
    unit: "allowance", quota: 100, consumed: 2, safetyHeadroom: 1, planWeight: 1, dataState: "known",
  };
  const windowId = budgetWindowId(window);
  return {
    enabled: true, cohortId: "fixture-cohort", maxAgeMs: 500,
    accounts: [{ accountId: "fixture-account", providerId: "fixture-provider", windowIds: [windowId] }],
    windows: [window], holds: [],
    bindings: MODELS.map(model => ({ modelId: model.id, binding: {
      bindingKey: `binding:${model.id}`, lane: "fixture-lane", accountId: "fixture-account", providerId: "fixture-provider",
      windowIds: [windowId], canStart: true, activeSlots: 0, maxSlots: 2, cooldownUntil: null,
      estimate: { revision: "fixture", durationMs: 100, windows: [{ windowId, unit: "allowance", upperBurn: 1 }] },
    } })),
  };
}

/** The lane-snapshot alternative: identity comes from the committed lane table, never the caller. */
function laneSnapshotShadow(): LaneSnapshotAdmissionShadowInput {
  return {
    enabled: true, cohortId: "fixture-cohort", maxAgeMs: 60_000,
    laneQuotaSnapshot: { schemaVersion: 1, observedAt: new Date(NOW - 1000).toISOString(), records: [{
      lane: "claude-lane-1", observationQuality: "live",
      five_hour_utilization: 0.4, five_hour_resets_at: new Date(NOW + 3_600_000).toISOString(),
      seven_day_utilization: 0.99, seven_day_resets_at: new Date(NOW + 86_400_000).toISOString(),
    }] },
    bindings: MODELS.map(model => ({ modelId: model.id, binding: {
      bindingKey: `binding:${model.id}`, lane: "fixture-lane", accountId: "claude-acct-1", providerId: "claude",
      windowIds: null, canStart: true, activeSlots: 0, maxSlots: 2, cooldownUntil: null, estimate: null,
    } })),
  };
}

const runCtx = { companyId: COMPANY, agentId: "agent-1", runId: "run-1" };

describe("worker", () => {
  let harness: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    harness = await boot(baseConfig());
  });

  it("ships a manifest the host's own validator accepts", () => {
    // This is the install gate. It caught a camelCase routeKey and a missing
    // database.namespace.migrate capability that unit tests could not see.
    const result = pluginManifestV1Schema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it.each(["advise", "enforce", "sticky", "held", "exhausted", "hard-stop-repin"].flatMap(
    scenario => ["explicit", "lane-snapshot"].map(variant => [scenario, variant] as const),
  ))(
    "keeps complete legacy decisions and actuation golden-identical with account shadow on/off (%s, %s input)",
    async (scenario, variant) => {
      const models = MODELS.map(model => ({ ...model,
        laneId: scenario === "hard-stop-repin" && model.id === "claude-opus-5" ? "dead-lane" : "fixture-lane",
        enabled: scenario === "exhausted" ? false : model.enabled }));
      if (scenario === "hard-stop-repin") models.push({ ...models.find(m => m.id === "claude-opus-5")!, id: "healthy-t1", laneId: "fixture-lane" });
      const config = baseConfig({ models,
        pacing: { mode: scenario === "hard-stop-repin" ? "enforce" : "off" },
        selection: { enabled: true, mode: scenario === "advise" ? "advise" : "enforce", stickyModelWithinIssue: true } });
      const seed = scenario === "sticky" || scenario === "hard-stop-repin"
        ? issue({ assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } }, checkoutRunId: null, executionRunId: null }) : issue();
      const run = async (enabled?: boolean) => {
        const h = await boot({ ...config, ...(enabled === undefined ? {} : { accountAdmissionShadow: { enabled } }) }, seed);
        if (scenario === "hard-stop-repin") await h.ctx.state.set(
          { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
          { "dead-lane": { laneId: "dead-lane", fetchedAt: new Date(NOW).toISOString(), error: null, observation: null,
            verdict: { laneId: "dead-lane", observedAt: new Date(NOW).toISOString(), state: "exhausted", serviceable: false,
              score: null, accounts: [], knownAccountCount: 1, knownWeight: 1, serviceableAccountCount: 0,
              urgentResetAt: null, reason: "fixture exhausted" } } });
        if (scenario === "held") await h.ctx.state.set(
          { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles }, { profiles: [], signals: NO_ESCALATION });
        const params = { issueId: ISSUE, admissionShadow: variant === "explicit" ? admissionSnapshot() : laneSnapshotShadow() };
        const advice = await h.executeTool(TOOL_NAMES.advise, params, runCtx);
        const applied = await h.executeTool(TOOL_NAMES.apply, params, runCtx);
        return { h, advice, applied, finalIssue: await h.ctx.issues.get(ISSUE, COMPANY) };
      };
      const omitted = await run();
      const off = await run(false);
      const on = await run(true);
      for (const actual of [off, on]) {
        expect(JSON.stringify(actual.advice)).toBe(JSON.stringify(omitted.advice));
        expect(JSON.stringify(actual.applied)).toBe(JSON.stringify(omitted.applied));
        expect(actual.finalIssue).toEqual(omitted.finalIssue);
        expect(actual.h.activity).toEqual(omitted.h.activity);
      }
      const key = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.admissionShadowReport };
      expect(await omitted.h.ctx.state.get(key)).toBeNull();
      expect(await off.h.ctx.state.get(key)).toBeNull();
      const stored = await on.h.ctx.state.get(key) as { report: AdmissionShadowReport };
      expect(stored.report).toMatchObject({ governsHostStarts: false, claimsReservations: false, selectedOrServedAccount: null });
      if (variant === "lane-snapshot") {
        const rows = stored.report.observationAdapter!.rows;
        expect(rows).toHaveLength(2 * 2 + 3 + 2 + 8 * 2);
        expect(rows.filter(r => r.laneId === "claude-lane-1").map(r => r.state)).toEqual(["known", "known"]);
        expect(rows.filter(r => r.laneId !== "claude-lane-1").every(r => r.reasons.includes("lane-absent-from-snapshot"))).toBe(true);
        expect(stored.report.evaluations[0]!.bindings.every(b => b.proposal === "unknown" && b.allowedStarts === null)).toBe(true);
      } else expect(stored.report.observationAdapter).toBeUndefined();
      if (scenario === "enforce" || scenario === "advise") {
        expect(stored.report.evaluations[0]!.bindings.length).toBeGreaterThan(0);
        expect((omitted.advice as { data: { modelId: string } }).data.modelId).toBe("claude-opus-5");
      }
      if (scenario === "enforce") expect(on.finalIssue?.assigneeAdapterOverrides).not.toBeNull();
      if (scenario === "hard-stop-repin") expect(on.finalIssue?.assigneeAdapterOverrides?.adapterConfig?.model).toBe("healthy-t1");
      if (scenario === "sticky" || scenario === "exhausted") {
        expect(stored.report.evaluations[0]!.bindings).toEqual([]);
        expect(stored.report.accounts[0]!.infeasibilityReasons).toContain("no-observed-eligible-account-binding");
      }
    },
  );

  it("isolates malformed account shadow and report storage failures from actual apply", async () => {
    const config = baseConfig({ selection: { enabled: true, mode: "enforce" },
      models: MODELS.map(model => ({ ...model, laneId: "fixture-lane" })), accountAdmissionShadow: { enabled: true } });
    const baseline = await boot(config);
    const expected = await baseline.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
    for (const failure of ["malformed", "storage", "bad-lane-snapshot"]) {
      const h = await boot(config);
      if (failure === "storage") {
        const original = h.ctx.state.set.bind(h.ctx.state);
        vi.spyOn(h.ctx.state, "set").mockImplementation(async (key, value) => {
          if (key.stateKey === PLUGIN_STATE_KEYS.admissionShadowReport) throw new Error("fixture-storage-failure");
          return original(key, value);
        });
      }
      const result = await h.executeTool(TOOL_NAMES.apply, {
        issueId: ISSUE, admissionShadow: failure === "malformed" ? { enabled: true }
          : failure === "bad-lane-snapshot" ? { ...laneSnapshotShadow(), maxAgeMs: 0 } : admissionSnapshot(),
      }, runCtx);
      expect(result).toEqual(expected);
      expect(await h.ctx.issues.get(ISSUE, COMPANY)).toEqual(await baseline.ctx.issues.get(ISSUE, COMPANY));
      expect(h.activity).toEqual(baseline.activity);
    }
  });

  it("reads account shadow without invoking advice, alarms, override writes or another company", async () => {
    const h = await boot(baseConfig());
    const update = vi.spyOn(h.ctx.issues, "update");
    const get = vi.spyOn(h.ctx.issues, "get");
    expect((await h.executeTool(TOOL_NAMES.admissionShadowReport, {}, runCtx) as { data: { ok: boolean } }).data.ok).toBe(false);
    const key = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.admissionShadowReport };
    const snapshot = { issueId: ISSUE, evaluatedAt: NOW, report: { mode: "shadow-only" } };
    await h.ctx.state.set(key, snapshot);
    expect((await h.executeTool(TOOL_NAMES.admissionShadowReport, {}, runCtx) as { data: unknown }).data).toEqual(snapshot);
    expect((await h.executeTool(TOOL_NAMES.admissionShadowReport, {}, { ...runCtx, companyId: "other-company" }) as { data: unknown }).data).not.toEqual(snapshot);
    expect(update).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(h.activity).toEqual([]);
  });

  // : the derived tier has to reach `selectModel`, not just sit on the
  // stored score. Unit-testing `applyDerivedTiers` directly leaves the wiring
  // uncovered — the same gap  found for the shadow emitter — so these
  // two drive the real advise path and read the model actually chosen.
  it("selects on the derived tier, not the roster's configured tier", async () => {
    // claude-sonnet-5 is configured T2. Promoted to T1 by its score, it becomes
    // the cheapest T1 candidate for a tier:T1 card and must beat opus.
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.modelScores },
      { modelScores: [promotedSonnet()] },
    );
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
    expect((result as { data: { modelId: string } }).data.modelId).toBe("claude-sonnet-5");
  });

  // The same promotion, minus the basket. The selection path must decline it:
  // an aa.ai composite on its own is not evidence a model can carry T1 work.
  it("does not select a model promoted on an index-only basis", async () => {
    // Identical to the promoted fixture in every other respect — same forced
    // `capable: true`, same T1 verdict — so the only thing that can decline it
    // is the basis. Without that, the capability gate would refuse it first and
    // the assertion would prove nothing.
    const indexOnly = promotedSonnet(null);
    expect(indexOnly.priorBasis).toBe("index-only");
    expect(indexOnly.tiers.T1.capable).toBe(true);
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.modelScores },
      { modelScores: [indexOnly] },
    );
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
    expect((result as { data: { modelId: string } }).data.modelId).toBe("claude-opus-5");
  });

  it("keeps the configured tier when the stored tier came from another spec version", async () => {
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.modelScores },
      { modelScores: [{ ...promotedSonnet(), tierSpecVersion: "benchmark-prior-v0" }] },
    );
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
    expect((result as { data: { modelId: string } }).data.modelId).toBe("claude-opus-5");
  });

  it("advises a model without writing anything", async () => {
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
    const decision = (result as { data: { modelId: string; advisory: boolean } }).data;
    expect(decision.modelId).toBe("claude-opus-5");
    expect(decision.advisory).toBe(true);
    expect(harness.activity).toHaveLength(0);
  });

  it("writes nothing in advise mode even from the apply tool", async () => {
    const result = await harness.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
    expect((result as { content: string }).content).toContain("No write");
    expect(harness.activity).toHaveLength(0);
    const after = await harness.ctx.issues.get(ISSUE, COMPANY);
    expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
  });

  it.each([
    { peak: 150_000, selected: "narrow" },
    { peak: 400_000, selected: "wide" },
  ])("routes cumulative 2.7M usage by actual peak $peak, not by totals or ceiling", async ({ peak, selected }) => {
    const t1 = MODELS.find((model) => model.tier === "T1")!;
    const narrow = { ...t1, id: "narrow", contextWindow: 200_000, costPerMTokIn: 0.1 };
    const wide = { ...t1, id: "wide", contextWindow: 1_000_000 };
    const repeatedTurns = peak === 150_000 ? 25 : 22;
    const fixture = await contextLogFixture(runLog([
      ...Array.from({ length: repeatedTurns }, () => assistantUsage(20_000, 70_000, 10_000)),
      assistantUsage(20_000, peak - 30_000, 10_000),
      assistantUsage(2_700_000 - repeatedTurns * 100_000 - peak),
      { type: "result", usage: { input_tokens: 2_700_000 } },
    ]));
    try {
      const enforcing = await boot(baseConfig({
        selection: { enabled: true, mode: "enforce", fleetContextCeilingTokens: 200_000, contextRunLogRoot: fixture.root },
        models: [narrow, wide],
      }));
      enforcing.ctx.db.query = async (sql: string) => sql.includes("log_ref")
        ? ([{ ...fixture.row, input_tokens: 2_700_000, cached_input_tokens: 2_000_000 }] as never)
        : ([] as never);
      const result = await enforcing.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
      const decision = (result as {
        data: { decision: { modelId: string; trace: string[]; rejections: Array<{ modelId: string; stage: string }> } };
      }).data.decision;
      expect(decision.modelId).toBe(selected);
      expect(decision.trace).toContain(
        `context: source=last-run-peak tokens=${peak} run=run-prev evidence=local-file/claude-assistant-usage`,
      );
      expect(decision.rejections.some((entry) => entry.modelId === "narrow" && entry.stage === "context-window"))
        .toBe(peak > 200_000);
    } finally { await fixture.cleanup(); }
  });

  it("labels missing peak evidence as a conservative fleet fallback, never a run measurement", async () => {
    const advising = await boot(baseConfig({ selection: { fleetContextCeilingTokens: 200_000 } }));
    advising.ctx.db.query = async (sql: string) => sql.includes("log_ref")
      ? ([{ id: "run-prev", input_tokens: 2_700_000, cached_input_tokens: 2_000_000 }] as never)
      : ([] as never);
    const result = await advising.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
    expect((result as { data: { trace: string[] } }).data.trace).toContain(
      "context: source=fleet-ceiling-fallback tokens=200000 run=run-prev evidence=log-root-unconfigured",
    );
  });

  it("keeps explicit requirements authoritative even if the history read fails", async () => {
    const advising = await boot(baseConfig({ selection: { fleetContextCeilingTokens: 200_000 } }));
    advising.ctx.db.query = async (sql: string) => {
      if (sql.includes("log_ref")) throw new Error("history unavailable");
      return [] as never;
    };
    const result = await advising.executeTool(TOOL_NAMES.advise, { issueId: ISSUE, requiredContextTokens: 300_000 }, runCtx);
    expect((result as { data: { trace: string[] } }).data.trace).toContain(
      "context: source=explicit tokens=300000 run=none evidence=history-read-failed",
    );
  });

  it("preserves a narrow assignee-floor model when only cumulative tier totals exist", async () => {
    const narrowT3 = {
      ...MODELS.find((model) => model.tier === "T3")!,
      contextWindow: 200_000,
    };
    const floorOnly = issue({
      assigneeAgentId: AGENT,
      labels: [{ id: OTHER_LABEL_ID, companyId: COMPANY, name: "area:platform" }],
      labelIds: [OTHER_LABEL_ID],
    } as unknown as Partial<Issue>);
    const enforcing = await boot(
      baseConfig({
        selection: { enabled: true, mode: "enforce", defaultTier: "T1" },
        models: [narrowT3],
      }),
      floorOnly,
      [
        {
          id: AGENT,
          companyId: COMPANY,
          name: "Mechanical worker",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: { model: narrowT3.id },
        } as never,
      ],
    );
    const result = await enforcing.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
    const decision = (result as {
      data: { decision: { modelId: string | null; judgement: { source: string; tier: string } } };
    }).data.decision;

    expect(decision.judgement).toMatchObject({ source: "agent-floor", tier: "T3" });
    expect(decision.modelId).toBe(narrowT3.id);
    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    expect(after?.assigneeAdapterOverrides).toEqual({
      adapterConfig: {
        model: narrowT3.id,
        env: {
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: { type: "plain", value: "200000" },
          ...subCallPins(narrowT3.id),
        },
      },
    });
  });

  // : the pin carries only plugin-owned keys. KEEP_ME and the
  // agent's own ceiling stay on the agent record — the run resolves them
  // from the base env under the per-key merge.
  it("pins a narrow model with plugin-only env and preserves unrelated labels", async () => {
    const narrowModels = MODELS.map((model) =>
      model.id === "claude-opus-5" ? { ...model, contextWindow: 200_000 } : model,
    );
    const assigned = issue({ assigneeAgentId: AGENT });
    const enforcing = await boot(
      baseConfig({ selection: { enabled: true, mode: "enforce" }, models: narrowModels }),
      assigned,
      [
        {
          id: AGENT,
          companyId: COMPANY,
          name: "Agent",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: {
            model: "claude-sonnet-5",
            env: {
              KEEP_ME: { type: "plain", value: "yes" },
              CLAUDE_CODE_MAX_CONTEXT_TOKENS: { type: "plain", value: "1000000" },
            },
          },
        } as never,
      ],
    );
    await enforcing.executeTool(TOOL_NAMES.apply, { issueId: ISSUE, requiredContextTokens: 100_000 }, runCtx);

    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    expect(after?.assigneeAdapterOverrides).toEqual({
      adapterConfig: {
        model: "claude-opus-5",
        env: {
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: { type: "plain", value: "200000" },
          // T3 pick on the fixtures roster is haiku, so the cheap keys land there,
          // not on the T1 pin.
          ...subCallPins("claude-opus-5", "claude-haiku-4-5-20251001"),
        },
      },
    });
    expect(enforcing.activity).toHaveLength(1);
    expect(enforcing.activity[0]?.metadata?.tierSource).toBe("issue-label");
  });

  it("pins excluded work to T1 even when the assignee floor is T3", async () => {
    const excluded = issue({
      assigneeAgentId: AGENT,
      labels: [{ id: OTHER_LABEL_ID, companyId: COMPANY, name: "area:platform" }],
      labelIds: [OTHER_LABEL_ID],
    } as unknown as Partial<Issue>);
    const enforcing = await boot(
      baseConfig({ selection: { enabled: true, mode: "enforce" } }),
      excluded,
      [
        {
          id: AGENT,
          companyId: COMPANY,
          name: "Mechanical worker",
          urlKey: "mechanical-worker",
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
        } as never,
      ],
    );

    await enforcing.executeTool(
      TOOL_NAMES.apply,
      { issueId: ISSUE, exclusion: { excluded: true, reasons: ["credential access"] } },
      runCtx,
    );

    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    // The agent row carries no `env` at all, but it was READ successfully, so
    // the sub-call pins still land — there is nothing to preserve and nothing
    // to lose. Contrast the unreadable-agent case, where env is left alone
    // entirely (`context.spec.ts`, "writes no env at all when ... unknown").
    expect(after?.assigneeAdapterOverrides).toEqual({
      adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
    });
    expect(new Set(after?.labelIds ?? [])).toEqual(new Set([OTHER_LABEL_ID, TIER_LABEL_ID]));
    expect(enforcing.activity[0]?.metadata?.tierSource).toBe("capability-exclusion");
  });

  it("unions the tier label with the labels already on the issue", async () => {
    // `issues.update` REPLACES the label set (issues.ts:4835-4852). An issue
    // with no tier label yet must come out with BOTH labels, not just the new
    // one — this is the regression that would silently strip board metadata.
    const unlabelled = issue({
      labels: [{ id: OTHER_LABEL_ID, companyId: COMPANY, name: "area:platform" }],
      labelIds: [OTHER_LABEL_ID],
    } as unknown as Partial<Issue>);
    const enforcing = await boot(
      baseConfig({
        selection: { enabled: true, mode: "enforce", defaultTier: "T1" },
      }),
      unlabelled,
    );

    await enforcing.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    expect(new Set(after?.labelIds ?? [])).toEqual(new Set([OTHER_LABEL_ID, TIER_LABEL_ID]));
  });

  it("never re-pins an issue that already carries an override", async () => {
    // A mid-flight model change resets the session and discards the warm prompt
    // cache — the single largest cost line we have.
    const pinned = issue({
      assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
    } as unknown as Partial<Issue>);
    const enforcing = await boot(
      baseConfig({ selection: { enabled: true, mode: "enforce" } }),
      pinned,
    );

    const result = await enforcing.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
    expect((result as { content: string }).content).toContain("already carries");
    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
    expect(enforcing.activity).toHaveLength(0);
  });

  it("resolves a legacy wrapped pin before checking the pinned lane hard stop", async () => {
    // Fixture roster carries exactly one T1 row (claude-opus-5). Pinning it
    // while its lane is a serviceability hard stop is therefore the 
    // Defect 2 dead end, not an ordinary pace reorder: T2/T3 are below the
    // required tier, so there is nowhere to escalate to, and the correct
    // outcome is `tier-exhausted` (no write) — same as an unwrapped pin would
    // get. What THIS test actually guards is  composition: the raw
    // `cliproxy/`-wrapped pin must still resolve to `claude-opus-5` and reach
    // its lane's hard-stop check (proven by the trace below), not silently
    // fail to match and skip the hard stop entirely.
    const models = MODELS.map((model) =>
      model.id === "claude-opus-5" ? { ...model, laneId: "lane-opus" } : model,
    );
    const pinned = issue({
      assigneeAdapterOverrides: { adapterConfig: { model: "cliproxy/claude-opus-5" } },
      checkoutRunId: null,
      executionRunId: null,
    } as unknown as Partial<Issue>);
    const enforcing = await boot(
      baseConfig({
        selection: { enabled: true, mode: "enforce" },
        models,
        pacing: { mode: "enforce", idleRepinHysteresisSeconds: 300 },
      }),
      pinned,
    );
    await enforcing.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
      {
        "lane-opus": {
          laneId: "lane-opus",
          fetchedAt: "2026-09-13T00:00:00.000Z",
          error: null,
          observation: null,
          verdict: {
            laneId: "lane-opus",
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
      },
    );

    const result = await enforcing.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
    // The legacy id resolved far enough to be evaluated against the lane
    // hard stop (not silently unmatched) — the decision trace names the
    // canonical id and the lane, and the tool declines to write because the
    // sole T1 candidate is unserviceable with nowhere to escalate to.
    const decisionTrace = (result as { data: { decision: { trace: string[] } } }).data.decision.trace;
    expect(decisionTrace.some((line) => line.includes("claude-opus-5") && line.includes("lane-opus"))).toBe(true);
    expect((result as { content: string }).content).toContain("tier-exhausted");
    expect((result as { content: string }).content).not.toContain("already carries");
    expect((result as { data: { decision: { outcome: string } } }).data.decision.outcome).toBe("tier-exhausted");
    // No write happened: the original (legacy-wrapped) pin is left exactly
    // as it was, never rewritten.
    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    expect(after?.assigneeAdapterOverrides).toEqual({
      adapterConfig: { model: "cliproxy/claude-opus-5" },
    });
    expect(enforcing.activity).toHaveLength(0);
  });

  it("writes the override without a label when no label id is configured", async () => {
    const unlabelled = issue({
      labels: [{ id: OTHER_LABEL_ID, companyId: COMPANY, name: "area:platform" }],
      labelIds: [OTHER_LABEL_ID],
    } as unknown as Partial<Issue>);
    const enforcing = await boot(
      {
        selection: { enabled: true, mode: "enforce", defaultTier: "T1" },
        models: MODELS,
      },
      unlabelled,
    );

    const result = await enforcing.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
    expect((result as { content: string }).content).toContain("no configured label id");
    const after = await enforcing.ctx.issues.get(ISSUE, COMPANY);
    expect(after?.assigneeAdapterOverrides).not.toBeNull();
  });

  it("reads lane availability from plugin state and will not pin a dead lane", async () => {
    // End-to-end proof that the term is actually plumbed through config
    // resolution, the state read, and `selectModel`: same config, same issue,
    // ONE difference in the stored lane document.
    //
    // `observedAt` is real-clock `now`, not the fixtures' `NOW`: the worker
    // reads `Date.now()`, and a document dated to a fixture constant would
    // cross the 120-minute staleness cutoff on its own and make both arms
    // UNKNOWN — a test that passes for a calendar reason rather than a code one.
    const t3Label = { id: TIER_LABEL_ID, companyId: COMPANY, name: "tier:T3" };
    const t3Issue = issue({ labels: [t3Label], labelIds: [TIER_LABEL_ID] } as unknown as Partial<Issue>);
    const laned = {
      selection: { enabled: true, mode: "enforce" },
      models: LANED_MODELS,
      tierLabelIds: { T3: TIER_LABEL_ID },
    };
    const observedAt = new Date().toISOString();
    const arm = async (zai: Array<Record<string, unknown>>) => {
      const harnessForArm = await boot(laned, t3Issue);
      await harnessForArm.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneAvailability },
        laneDoc([account("claude", "claude-a"), account("claude", "claude-b"), ...zai], observedAt),
      );
      await harnessForArm.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
      const after = await harnessForArm.ctx.issues.get(ISSUE, COMPANY);
      return (after?.assigneeAdapterOverrides as { adapterConfig?: { model?: string } } | null)?.adapterConfig?.model
        ?? null;
    };

    // Live zai: the cheapest eligible row wins, as it does today.
    expect(await arm([account("zai", "zai-a"), account("zai", "zai-b")])).toBe("claude-haiku-4-5-20251001");
    // Exhausted zai: the same selection escalates off the dead lane.
    expect(
      await arm([
        account("zai", "zai-a", { health: "exhausted" }),
        account("zai", "zai-b", { health: "exhausted" }),
      ]),
    ).toBe("claude-sonnet-5");
  });

  it("reads lane evidence from heartbeat_runs and will not pin a lane proven dead", async () => {
    // . The sibling test above proves the AVAILABILITY term is plumbed.
    // It cannot prove this one: `devin/*` publishes no quota contract at all,
    // which is why the availability term passed it and it took 0-for-69. The
    // only end-to-end proof that the run-outcome term reaches `selectModel` is
    // a pair of arms differing in nothing but the `heartbeat_runs` counts.
    const t3Label = { id: TIER_LABEL_ID, companyId: COMPANY, name: "tier:T3" };
    const t3Issue = issue({ labels: [t3Label], labelIds: [TIER_LABEL_ID] } as unknown as Partial<Issue>);
    const laned = {
      selection: { enabled: true, mode: "enforce" },
      models: LANED_MODELS,
      tierLabelIds: { T3: TIER_LABEL_ID },
    };
    const arm = async (haiku: { succeeded: number; failed: number }) => {
      const harnessForArm = await boot(laned, t3Issue);
      harnessForArm.ctx.db.query = (async (sql: string) =>
        sql.includes("as failed")
          ? [{ model: "claude-haiku-4-5-20251001", ...haiku }, { model: "claude-sonnet-5", succeeded: 34, failed: 8 }]
          : []) as never;
      await harnessForArm.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);
      const after = await harnessForArm.ctx.issues.get(ISSUE, COMPANY);
      return (after?.assigneeAdapterOverrides as { adapterConfig?: { model?: string } } | null)?.adapterConfig?.model
        ?? null;
    };

    // Healthy zai: the cheapest eligible row wins, as it does today.
    expect(await arm({ succeeded: 34, failed: 8 })).toBe("claude-haiku-4-5-20251001");
    // The measured devin shape, 0 of 74: the same selection escalates off it.
    expect(await arm({ succeeded: 0, failed: 74 })).toBe("claude-sonnet-5");
  });

  it("reports a missing issue rather than throwing", async () => {
    const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: "nope" }, runCtx);
    expect((result as { content: string }).content).toContain("not found");
  });

  it("queries only the allowlisted table when refreshing volume profiles", async () => {
    harness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });
    await harness.runJob("refreshVolumeProfiles");
    for (const q of harness.dbQueries) {
      expect(q.sql).toContain("heartbeat_runs");
      // `labels` is absent from PLUGIN_DATABASE_CORE_READ_TABLES; a query
      // against it would be rejected by assertAllowedPublicRead at runtime.
      expect(q.sql).not.toMatch(/\bfrom\s+labels\b/i);
    }
  });

  it("queries only allowlisted tables when refreshing scores, never activity_log or labels", async () => {
    harness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });
    await harness.runJob("refreshScores");
    expect(harness.dbQueries.length).toBeGreaterThan(0);
    for (const q of harness.dbQueries) {
      // Named mutant: read-disallowed-activity_log — this must never appear,
      // since activity_log is absent from PLUGIN_DATABASE_CORE_READ_TABLES.
      expect(q.sql).not.toMatch(/\bfrom\s+activity_log\b/i);
      expect(q.sql).not.toMatch(/\bfrom\s+labels\b/i);
      expect(q.sql).not.toMatch(/\bjoin\s+labels\b/i);
      expect(q.sql).not.toMatch(/\bjoin\s+issue_labels\b/i);
    }
  });

  it("writes a modelScores + cardLedger state shape after refreshScores runs", async () => {
    harness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });
    await harness.runJob("refreshScores");
    const stored = (await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: PLUGIN_STATE_KEYS.modelScores,
    })) as { modelScores: unknown[]; cardLedger: Record<string, unknown> } | undefined;
    expect(stored).toBeDefined();
    expect(Array.isArray(stored?.modelScores)).toBe(true);
    // One row per configured model, even with zero runs observed (model_scores.py's roster union).
    expect(stored?.modelScores).toHaveLength(MODELS.length);
    expect(typeof stored?.cardLedger).toBe("object");
  });

  it("attributes legacy-wrapped score and card rows to the canonical roster id", async () => {
    const closed = issue({
      status: "done",
      assigneeAdapterOverrides: { adapterConfig: { model: "cliproxy/claude-opus-5" } },
    } as unknown as Partial<Issue>);
    const scoring = await boot(baseConfig(), closed);
    scoring.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });

    let queryIndex = 0;
    scoring.ctx.db.query = async () => {
      queryIndex += 1;
      if (queryIndex === 1) {
        return [{
          model: "cliproxy/claude-opus-5",
          status: "succeeded",
          issue_id: ISSUE,
          error_code: "",
          error: "",
          cost_usd: "3",
          mins: "5",
          age_days: "0",
        }] as never;
      }
      if (queryIndex === 2) {
        return [{
          issue_id: ISSUE,
          model: "claude-opus-5",
          agent_id: AGENT,
          cost_usd: "3",
          finished_at_ms: "1",
        }] as never;
      }
      if (queryIndex === 3) {
        return [{
          id: ISSUE,
          closed_at_ms: "1",
          pinned_model: "cliproxy/claude-opus-5",
        }] as never;
      }
      return [] as never;
    };

    await scoring.runJob("refreshScores");
    const stored = (await scoring.ctx.state.get({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: PLUGIN_STATE_KEYS.modelScores,
    })) as {
      modelScores: Array<{ modelId: string; tiers: { T1: { n: number } } }>;
      cardLedger: Record<string, { modelId: string; foreignRunShare: number | null }>;
    } | undefined;

    const opus = stored?.modelScores.find((score) => score.modelId === "claude-opus-5");
    expect(opus?.tiers.T1.n).toBe(1);
    expect(stored?.cardLedger).toHaveProperty("claude-opus-5:T1");
    expect(stored?.cardLedger).not.toHaveProperty("cliproxy/claude-opus-5:T1");
    expect(stored?.cardLedger["claude-opus-5:T1"]?.foreignRunShare).toBe(0);
  });

  it("drops unknown telemetry model ids instead of attributing them by suffix", async () => {
    const scoring = await boot(baseConfig());
    scoring.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });

    let queryIndex = 0;
    scoring.ctx.db.query = async () => {
      queryIndex += 1;
      if (queryIndex === 1) {
        return [{
          model: "cliproxy/not-in-roster",
          status: "succeeded",
          issue_id: ISSUE,
          error_code: "",
          error: "",
          cost_usd: "1",
          mins: "1",
          age_days: "0",
        }] as never;
      }
      return [] as never;
    };

    await scoring.runJob("refreshScores");
    const stored = (await scoring.ctx.state.get({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: PLUGIN_STATE_KEYS.modelScores,
    })) as { modelScores: Array<{ tiers: { T1: { n: number } } }> } | undefined;
    expect(stored?.modelScores.every((score) => score.tiers.T1.n === 0)).toBe(true);
  });

  it("counts a known closing run as foreign when the persisted pin is unknown", async () => {
    const closed = issue({
      status: "done",
      assigneeAdapterOverrides: { adapterConfig: { model: "cliproxy/not-in-roster" } },
    } as unknown as Partial<Issue>);
    const scoring = await boot(baseConfig(), closed);
    scoring.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });

    let queryIndex = 0;
    scoring.ctx.db.query = async () => {
      queryIndex += 1;
      if (queryIndex === 1) return [] as never;
      if (queryIndex === 2) {
        return [{
          issue_id: ISSUE,
          model: "claude-opus-5",
          agent_id: AGENT,
          cost_usd: "3",
          finished_at_ms: "1",
        }] as never;
      }
      if (queryIndex === 3) {
        return [{
          id: ISSUE,
          closed_at_ms: "1",
          pinned_model: "cliproxy/not-in-roster",
        }] as never;
      }
      return [] as never;
    };

    await scoring.runJob("refreshScores");
    const stored = (await scoring.ctx.state.get({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: PLUGIN_STATE_KEYS.modelScores,
    })) as {
      cardLedger: Record<string, { foreignRunShare: number | null }>;
    } | undefined;

    expect(stored?.cardLedger["claude-opus-5:T1"]?.foreignRunShare).toBe(1);
  });

  // . `usage_json.costUsd` is the serving CLI's own figure and the
  // claude-local adapter stamps `provider: "anthropic"` unconditionally
  // (execute.ts:1235-1236), so a CLIProxy lane serving somebody else's model
  // records an Anthropic-priced cost — measured 93.7x over for
  // muse-spark-1.3-contributor. These two drive the whole refreshScores path,
  // because the guard lives in the worker's row mapping and a unit test of the
  // predicate alone would still pass if the call site were removed.
  describe(": provider-misattributed closing-run costs", () => {
    const MUSE = "muse-spark-1.3-contributor";
    const rosterWithMuse = [
      ...MODELS,
      { ...MODELS[MODELS.length - 1]!, id: MUSE, note: " fixture" },
    ];

    async function ledgerForProvider(provider: string) {
      const closed = issue({
        status: "done",
        assigneeAdapterOverrides: { adapterConfig: { model: MUSE } },
      } as unknown as Partial<Issue>);
      const scoring = await boot(baseConfig({ models: rosterWithMuse }), closed);
      scoring.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });

      let queryIndex = 0;
      scoring.ctx.db.query = async () => {
        queryIndex += 1;
        if (queryIndex === 2) {
          return [{
            issue_id: ISSUE,
            model: MUSE,
            agent_id: AGENT,
            cost_usd: "2.867",
            provider,
            finished_at_ms: "1",
          }] as never;
        }
        if (queryIndex === 3) {
          return [{ id: ISSUE, closed_at_ms: "1", pinned_model: MUSE }] as never;
        }
        return [] as never;
      };

      await scoring.runJob("refreshScores");
      const stored = (await scoring.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.modelScores,
      })) as {
        cardLedger: Record<string, { costPerCard: number | null; costPerAcceptedCard: number | null; cardsClosed: number }>;
      } | undefined;
      const entry = stored?.cardLedger[`${MUSE}:T1`];
      if (!entry) throw new Error(`missing ledger entry ${MUSE}:T1`);
      return entry;
    }

    it("records no cost for a run the harness priced against Anthropic's table", async () => {
      const entry = await ledgerForProvider("anthropic");
      expect(entry.costPerCard).toBeNull();
      // Null is the ledger's existing "unknown", and orderByCostPerAcceptedCard
      // drops a null-cost candidate rather than ranking it — so the model falls
      // back to list-price ordering instead of being ranked as cheap.
      expect(entry.costPerAcceptedCard).toBeNull();
      // Only the cost term is invalidated; the card still counts as evidence.
      expect(entry.cardsClosed).toBe(1);
    });

    it("keeps the recorded cost when the run carries no provider at all", async () => {
      // The control. Absence is not evidence of misattribution, and rejecting
      // it would silently discard every run recorded before provider capture.
      const entry = await ledgerForProvider("");
      expect(entry.costPerCard).toBeCloseTo(2.867);
    });
  });

  it("canonicalizes a legacy-wrapped operator override before storing it", async () => {
    const result = await harness.executeTool(
      TOOL_NAMES.setOperatorOverride,
      { issueId: ISSUE, modelId: "cliproxy/claude-opus-5" },
      runCtx,
    );
    expect((result as { content: string }).content).toContain("-> claude-opus-5");
    expect((result as { data: { modelId: string } }).data.modelId).toBe("claude-opus-5");
  });

  it("rejects an operator override that does not resolve to a configured roster id", async () => {
    const result = await harness.executeTool(
      TOOL_NAMES.setOperatorOverride,
      { issueId: ISSUE, modelId: "cliproxy/not-in-roster" },
      runCtx,
    );
    expect((result as { content: string }).content).toContain("not a configured roster entry");
    // : rejections still carry a plain-object data (never null), so the
    // gateway's structuredContent mapping never yields null.
    expect((result as { data: unknown }).data).toEqual({ ok: false, error: "unknown-model", modelId: "cliproxy/not-in-roster" });
  });

  // : a lane's apiKeySecretRef is resolved inside the pollLaneCapacity
  // job, before the poll, never inside poll.ts itself.
  describe("pollLaneCapacity secret resolution", () => {
    const laneConfig = (apiKeySecretRef?: Record<string, unknown>) =>
      baseConfig({
        pacing: {
          mode: "enforce",
          lanes: [
            {
              laneId: "lane-a",
              statusUrl: "https://status.example.com/lane-a",
              ...(apiKeySecretRef ? { apiKeySecretRef } : {}),
              windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
            },
          ],
        },
      });

    async function ledgerFor(h: Awaited<ReturnType<typeof boot>>) {
      return h.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.laneLedger,
      }) as Promise<Record<string, { error: string | null }> | null>;
    }

    it("resolves the secret and sends it as X-Api-Key when ctx.secrets.resolve succeeds", async () => {
      const secretHarness = await boot(
        laneConfig({ type: "secret_ref", secretId: "153ddc6c-4d7d-4ad8-b71d-882d6cfd5ad4" }),
      );
      secretHarness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });

      let seenHeaders: Record<string, string> | undefined;
      let seenResolveArgs: unknown[] = [];
      secretHarness.ctx.secrets.resolve = async (ref: unknown, options?: unknown) => {
        seenResolveArgs = [ref, options];
        return "resolved-lane-key";
      };
      secretHarness.ctx.http.fetch = async (_url: unknown, init?: unknown) => {
        seenHeaders = (init as { headers?: Record<string, string> } | undefined)?.headers;
        return new Response(
          JSON.stringify({ observedAt: new Date().toISOString(), records: [{ health: "ok", utilization: 0.1 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ) as never;
      };

      await secretHarness.runJob("pollLaneCapacity");

      expect(seenHeaders).toMatchObject({ "X-Api-Key": "resolved-lane-key" });
      // : the host's plugin-secrets-handler.ts binds config_secret_bindings
      // rows by the lane's array INDEX (pacing.lanes.<n>.apiKeySecretRef), not by
      // laneId — a laneId-keyed resolve path reads back nothing after any config
      // write, since syncSecretRefsForTarget(replaceAll: true) drops non-matching rows.
      expect(seenResolveArgs[1]).toMatchObject({
        companyId: COMPANY,
        configPath: "pacing.lanes.0.apiKeySecretRef",
      });
      const ledger = await ledgerFor(secretHarness);
      expect(ledger?.["lane-a"]?.error ?? null).toBeNull();
    });

    it("resolves lane N's secret at the same array-index path the host's config extractor binds for lane N", async () => {
      const multiLaneConfig = baseConfig({
        pacing: {
          mode: "enforce",
          lanes: [
            {
              laneId: "lane-a",
              statusUrl: "https://status.example.com/lane-a",
              windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
            },
            {
              laneId: "lane-b",
              statusUrl: "https://status.example.com/lane-b",
              apiKeySecretRef: { type: "secret_ref", secretId: "153ddc6c-4d7d-4ad8-b71d-882d6cfd5ad4" },
              windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
            },
          ],
        },
      });
      const multiHarness = await boot(multiLaneConfig);
      multiHarness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });

      let seenConfigPath: unknown;
      multiHarness.ctx.secrets.resolve = async (_ref: unknown, options?: unknown) => {
        seenConfigPath = (options as { configPath?: unknown } | undefined)?.configPath;
        return "resolved-lane-key";
      };
      multiHarness.ctx.http.fetch = async () =>
        new Response(
          JSON.stringify({ observedAt: new Date().toISOString(), records: [{ health: "ok", utilization: 0.1 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ) as never;

      await multiHarness.runJob("pollLaneCapacity");

      // extractSecretRefBindingsFromConfig walks the array and binds by index
      // (0-based position, not laneId) — lane-b is index 1 here.
      expect(seenConfigPath).toBe("pacing.lanes.1.apiKeySecretRef");
    });

    it("records lane-secret-unavailable and never calls http.fetch when ctx.secrets.resolve throws", async () => {
      const secretHarness = await boot(
        laneConfig({ type: "secret_ref", secretId: "153ddc6c-4d7d-4ad8-b71d-882d6cfd5ad4" }),
      );
      secretHarness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });

      let fetchCalled = false;
      secretHarness.ctx.secrets.resolve = async () => {
        throw new Error("secret not found");
      };
      secretHarness.ctx.http.fetch = async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) as never;
      };

      await secretHarness.runJob("pollLaneCapacity");

      expect(fetchCalled).toBe(false);
      const ledger = await ledgerFor(secretHarness);
      expect(ledger?.["lane-a"]?.error).toBe("lane-secret-unavailable");
    });

    it("polls unauthenticated (no X-Api-Key, no secrets.resolve call) when the lane has no apiKeySecretRef", async () => {
      const noSecretHarness = await boot(laneConfig());
      noSecretHarness.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });

      let resolveCalled = false;
      let seenHeaders: Record<string, string> | undefined;
      noSecretHarness.ctx.secrets.resolve = async () => {
        resolveCalled = true;
        return "unused";
      };
      noSecretHarness.ctx.http.fetch = async (_url: unknown, init?: unknown) => {
        seenHeaders = (init as { headers?: Record<string, string> } | undefined)?.headers;
        return new Response(
          JSON.stringify({ observedAt: new Date().toISOString(), records: [{ health: "ok", utilization: 0.1 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ) as never;
      };

      await noSecretHarness.runJob("pollLaneCapacity");

      expect(resolveCalled).toBe(false);
      expect(seenHeaders).not.toHaveProperty("X-Api-Key");
      const ledger = await ledgerFor(noSecretHarness);
      expect(ledger?.["lane-a"]?.error ?? null).toBeNull();
    });
  });

  // . Per-tier lane-poll outcome counters: the `pollLaneCapacity` job
  // increments them from the same results it merges into the lane ledger, and
  // `model_selection_tier_outcomes` reads them back. Read-only end to end —
  // nothing here may change which model a decision selects.
  describe(" tier poll outcomes", () => {
    const LANED = MODELS.map((entry) => ({
      ...entry,
      laneId: entry.id === "claude-haiku-4-5-20251001" ? "lane-zai" : "lane-claude",
    }));
    // `free: true` lanes are the deterministic served-fixture: the pace
    // engine returns `serviceable: true` for them by construction
    // (`pace.ts` free-lane branch), with no document-shape or clock
    // dependence — so these tests measure the counters, not the verdict.
    const tierConfig = () =>
      baseConfig({
        models: LANED,
        pacing: {
          mode: "enforce",
          lanes: [
            {
              laneId: "lane-zai",
              statusUrl: "https://status.example.com/lane-zai",
              free: true,
              windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
            },
            {
              laneId: "lane-claude",
              statusUrl: "https://status.example.com/lane-claude",
              free: true,
              windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
            },
          ],
        },
      });

    async function outcomesFor(h: Awaited<ReturnType<typeof boot>>) {
      return h.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.tierPollOutcomes,
      }) as Promise<Record<string, unknown> | null>;
    }

    it("accumulates per-tier counters from a live lane poll without changing selection", async () => {
      const h = await boot(tierConfig());
      h.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });
      h.ctx.http.fetch = async () =>
        new Response(
          JSON.stringify({ observedAt: new Date().toISOString(), records: [{ health: "ok", utilization: 0.1 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ) as never;

      const before = await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      await h.runJob("pollLaneCapacity");
      const after = await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      // The acceptance invariant: the counters move, the selection does not.
      expect((after as { data: { modelId: string } }).data.modelId).toBe(
        (before as { data: { modelId: string } }).data.modelId,
      );

      const stored = await outcomesFor(h);
      const tiers = (stored?.tiers ?? {}) as Record<string, { polls: number; succeeded: number; failed: number }>;
      // lane-zai serves T3 alone; lane-claude serves T1 + T2.
      expect(tiers.T3).toMatchObject({ polls: 1, succeeded: 1, failed: 0 });
      expect(tiers.T2).toMatchObject({ polls: 1, succeeded: 1, failed: 0 });
      expect(tiers.T1).toMatchObject({ polls: 1, succeeded: 1, failed: 0 });
    });

    it("counts a failing lane as failed for exactly the tiers it serves", async () => {
      const h = await boot(tierConfig());
      h.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });
      h.ctx.http.fetch = async (url: unknown) => {
        if (String(url).includes("lane-zai")) return new Response("nope", { status: 404 }) as never;
        return new Response(
          JSON.stringify({ observedAt: new Date().toISOString(), records: [{ health: "ok", utilization: 0.1 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ) as never;
      };

      await h.runJob("pollLaneCapacity");

      const stored = await outcomesFor(h);
      const tiers = (stored?.tiers ?? {}) as Record<string, { polls: number; succeeded: number; failed: number }>;
      expect(tiers.T3).toMatchObject({ polls: 1, succeeded: 0, failed: 1 });
      expect(tiers.T2).toMatchObject({ polls: 1, succeeded: 1, failed: 0 });
      expect(tiers.T1).toMatchObject({ polls: 1, succeeded: 1, failed: 0 });
    });

    it("tierOutcomes tool answers zeroes before any poll and counters after", async () => {
      const h = await boot(tierConfig());
      const empty = (await h.executeTool(TOOL_NAMES.tierOutcomes, {}, runCtx)) as {
        content: string;
        data: { updatedAt: null; tiers: Record<string, { polls: number }> };
      };
      expect(typeof empty.content).toBe("string");
      expect(empty.data.updatedAt).toBeNull();
      expect(empty.data.tiers.T3!.polls).toBe(0);

      h.seed({ companies: [{ id: COMPANY, name: "Co" } as never] });
      h.ctx.http.fetch = async () =>
        new Response(
          JSON.stringify({ observedAt: new Date().toISOString(), records: [{ health: "ok", utilization: 0.1 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ) as never;
      await h.runJob("pollLaneCapacity");

      const filled = (await h.executeTool(TOOL_NAMES.tierOutcomes, {}, runCtx)) as {
        content: string;
        data: { updatedAt: string | null; tiers: Record<string, { polls: number; succeeded: number; failed: number }> };
      };
      expect(typeof filled.content).toBe("string");
      expect(typeof filled.data.updatedAt).toBe("string");
      expect(filled.data.tiers.T3).toMatchObject({ polls: 1, succeeded: 1, failed: 0 });
    });
  });

  describe(" Defect 2: tier-exhausted operator alarm", () => {
    function unserviceableVerdict(laneId: string): LanePaceVerdict {
      return {
        laneId,
        observedAt: "2026-09-10T11:00:00.000Z",
        state: "exhausted",
        serviceable: false,
        score: null,
        accounts: [],
        knownAccountCount: 1,
        knownWeight: 1,
        serviceableAccountCount: 0,
        urgentResetAt: null,
        reason: "all-accounts-unserviceable",
      };
    }

    function ledgerWith(...laneIds: string[]): LaneLedger {
      const ledger: LaneLedger = {};
      for (const laneId of laneIds) {
        ledger[laneId] = { laneId, verdict: unserviceableVerdict(laneId), fetchedAt: "2026-09-10T11:00:00.000Z", error: null, observation: null };
      }
      return ledger;
    }

    // The T1 model is the only one required for a `tier:T1` issue, so pinning
    // its lane exhausted with nothing above it to escalate to is enough to
    // force `tier-exhausted` regardless of the T2/T3 rows' own laneId.
    const t1LaneId = "lane-t1";
    const laned = MODELS.map((entry) => (entry.tier === "T1" ? { ...entry, laneId: t1LaneId } : entry));

    async function bootExhausted() {
      const h = await boot(baseConfig({ pacing: { mode: "enforce" }, models: laned }));
      await h.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        ledgerWith(t1LaneId),
      );
      return h;
    }

    async function listEscalations(h: Awaited<ReturnType<typeof bootExhausted>>) {
      const all = await h.ctx.issues.list({ companyId: COMPANY, limit: 1000 });
      return all.filter((i) => i.parentId === ISSUE && i.title.startsWith("Operator:"));
    }

    it("raises exactly one Operator: escalation issue when tier-exhausted", async () => {
      const exhausted = await bootExhausted();
      const result = await exhausted.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      expect((result as { data: { outcome: string } }).data.outcome).toBe("tier-exhausted");

      const escalations = await listEscalations(exhausted);
      expect(escalations).toHaveLength(1);
      expect(escalations[0]?.title).toContain("Operator:");
      expect(escalations[0]?.assigneeAgentId ?? null).toBeNull();
    });

    it("does not raise a duplicate escalation issue on a second advise call while still exhausted", async () => {
      const exhausted = await bootExhausted();
      await exhausted.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      await exhausted.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      await exhausted.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);

      const escalations = await listEscalations(exhausted);
      expect(escalations).toHaveLength(1);
    });

    it("clears the alarm once no longer exhausted, so a later exhaustion raises a fresh escalation", async () => {
      const exhausted = await bootExhausted();
      await exhausted.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      // Lane recovers: clear the ledger.
      await exhausted.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        {},
      );
      await exhausted.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      const alarms = await exhausted.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.tierExhaustedAlarms,
      });
      expect(alarms).toEqual({});

      // Exhausted again: a fresh escalation must be raised, not suppressed.
      await exhausted.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        ledgerWith(t1LaneId),
      );
      await exhausted.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      const escalations = await listEscalations(exhausted);
      expect(escalations).toHaveLength(2);
    });

    it("never raises an escalation for an ordinary selected decision", async () => {
      const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      expect((result as { data: { outcome: string } }).data.outcome).toBe("selected");
      const escalations = await listEscalations(harness);
      expect(escalations).toHaveLength(0);
    });
  });

  describe(": dead-lane veto poller-suspect operator alarm", () => {
    // haiku serves T3 alone on `lane-zai`; sonnet + opus share `lane-claude`.
    // Killing both lanes at once is the CEO fail-open shape: a poller-side
    // failure hits every lane together, so selection must admit as today and
    // raise the card as "poller suspect" instead of `tier-exhausted`.
    const LANES = ["lane-zai", "lane-claude"];
    const LANED = MODELS.map((entry) => ({
      ...entry,
      laneId: entry.id === "claude-haiku-4-5-20251001" ? "lane-zai" : "lane-claude",
    }));

    // Seeded straight into state, the way `mergeLedgerEntry` would have left
    // it after 5 consecutive failed polls: no verdict, a poll error, and the
    // streak at the veto threshold — but no `unserviceableSince`, so the
    //  hard stop stays out of the picture and this block measures the
    // veto bypass, not the older exclusion.
    function deadLedger(): LaneLedger {
      const ledger: LaneLedger = {};
      for (const laneId of LANES) {
        const entry: LaneLedgerEntry = {
          laneId,
          verdict: null,
          observation: null,
          fetchedAt: "2026-09-10T11:00:00.000Z",
          error: "lane-request-failed",
          consecutiveNonSuccess: 5,
        };
        ledger[laneId] = entry;
      }
      return ledger;
    }

    function vetoConfig() {
      return baseConfig({
        models: LANED,
        pacing: {
          mode: "enforce",
          lanes: LANES.map((laneId) => ({
            laneId,
            statusUrl: `https://status.example.com/${laneId}`,
            free: true,
            windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
          })),
        },
      });
    }

    async function bootAllDead() {
      const h = await boot(vetoConfig());
      await h.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        deadLedger(),
      );
      return h;
    }

    async function listPollerEscalations(h: Awaited<ReturnType<typeof bootAllDead>>) {
      const all = await h.ctx.issues.list({ companyId: COMPANY, limit: 1000 });
      return all.filter((i) => i.parentId === ISSUE && i.title.startsWith("Operator: lane poller suspect"));
    }

    it("admits as today and raises one poller-suspect card when every configured lane is dead", async () => {
      const h = await bootAllDead();
      const result = await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      expect((result as { data: { outcome: string } }).data.outcome).toBe("selected");
      expect(
        (result as { data: { deadVeto: { bypassedAllDead: boolean } } }).data.deadVeto.bypassedAllDead,
      ).toBe(true);

      const escalations = await listPollerEscalations(h);
      expect(escalations).toHaveLength(1);
      expect(escalations[0]?.title).toContain("poller suspect");
    });

    it("does not raise a duplicate poller-suspect card on repeated advise while still all-dead", async () => {
      const h = await bootAllDead();
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      await h.executeTool(TOOL_NAMES.apply, { issueId: ISSUE }, runCtx);

      const escalations = await listPollerEscalations(h);
      expect(escalations).toHaveLength(1);
    });

    it("clears the alarm once a lane recovers, so a later all-dead window raises a fresh card", async () => {
      const h = await bootAllDead();
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      // lane-zai recovers: its streak resets, so the next decision vetoes
      // (rather than bypasses) and the bypass streak ends.
      const healed = deadLedger();
      healed["lane-zai"] = {
        laneId: "lane-zai",
        verdict: null,
        observation: null,
        fetchedAt: "2026-09-10T11:00:00.000Z",
        error: null,
        consecutiveNonSuccess: 0,
      };
      await h.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        healed,
      );
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      const alarms = await h.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.deadVetoPollerAlarms,
      });
      expect(alarms).toEqual({});

      // All dead again: a fresh escalation must be raised, not suppressed.
      await h.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        deadLedger(),
      );
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      const escalations = await listPollerEscalations(h);
      expect(escalations).toHaveLength(2);
    });

    it("never raises a poller-suspect card for an ordinary selected decision", async () => {
      const result = await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      expect((result as { data: { outcome: string } }).data.outcome).toBe("selected");
      const escalations = await listPollerEscalations(harness);
      expect(escalations).toHaveLength(0);
    });
  });

  describe("/2138: shadow decision emitter wiring in worker.ts", () => {
    // : emits land in the UTC-hour shard for the decision timestamp
    // (`decisions-YYYY-MM-DD-HHZ.jsonl`), not in a single `decisions.jsonl`.
    // The fixture clock is frozen at NOW (2026-09-10T12:00Z), so every advise()
    // in these tests lands in `decisions-2026-09-10-12Z.jsonl`. The shard name
    // is pinned here deliberately rather than imported — the emitter keeps it
    // as a local `const`, and the QA-flagged gap this block covers is exactly
    // that no test drove this path.
    const SHADOW_SHARD = "decisions-2026-09-10-12Z.jsonl";

    async function readShadowLines(h: Awaited<ReturnType<typeof boot>>): Promise<string[]> {
      const text = await h.ctx.localFolders.readText(COMPANY, LOCAL_FOLDER_KEYS.shadowDecisions, SHADOW_SHARD);
      return text.split("\n").filter((line) => line.trim().length > 0);
    }

    async function listShards(h: Awaited<ReturnType<typeof boot>>): Promise<string[]> {
      const listing = await h.ctx.localFolders.list(COMPANY, LOCAL_FOLDER_KEYS.shadowDecisions);
      return listing.entries.filter((entry) => entry.kind === "file").map((entry) => entry.name).sort();
    }

    it("writes a correlated host/plugin-shadow pair on advise() when shadowEmit.enabled is true", async () => {
      const h = await boot(baseConfig({ shadowEmit: { enabled: true, shardMaxRecords: 100 } }));
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      const lines = await readShadowLines(h);
      expect(lines).toHaveLength(2);
      const records = lines.map((line) => JSON.parse(line));
      expect(records.map((record) => record.writer)).toEqual(["host", "plugin-shadow"]);
      for (const record of records) {
        expect(record.schema).toBe(SHADOW_SCHEMA_VERSION);
        expect(record.issueId).toBe(ISSUE);
      }
      expect(records[0].ts).toBe(records[1].ts);
      expect(records[0].stateFingerprint).toEqual(records[1].stateFingerprint);
      expect(records[0].candidates).toEqual(records[1].candidates);
    });

    it("writes nothing to the shadow folder when shadowEmit.enabled is false (the default)", async () => {
      // baseConfig() carries no `shadowEmit` key, so resolveConfig defaults it
      // to { enabled: false }. This is the exact config the QA finding named:
      // disabling the worker.ts integration block must leave no JSONL write.
      await harness.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      await expect(readShadowLines(harness)).rejects.toThrow(/not found/i);
    });

    it("caps the shadow shard at config.shadowEmit.shardMaxRecords, keeping the newest records", async () => {
      const h = await boot(baseConfig({ shadowEmit: { enabled: true, shardMaxRecords: 2 } }));
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      const lines = await readShadowLines(h);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(JSON.parse(line).issueId).toBe(ISSUE);
      }
    });

    it("keeps complete pairs when shardMaxRecords is odd", async () => {
      const h = await boot(baseConfig({ shadowEmit: { enabled: true, shardMaxRecords: 3 } }));
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      const records = (await readShadowLines(h)).map((line) => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.writer)).toEqual(["host", "plugin-shadow"]);
      expect(records[0].ts).toBe(records[1].ts);
    });

    it(": retention deletes whole old shards past retentionShards, newest pair intact", async () => {
      const h = await boot(baseConfig({ shadowEmit: { enabled: true, shardMaxRecords: 100, retentionShards: 1 } }));
      // Seed two shards from older hours directly — the emitter never writes
      // outside the current hour, so retention is the only path that removes
      // them.
      await h.ctx.localFolders.writeTextAtomic(
        COMPANY, LOCAL_FOLDER_KEYS.shadowDecisions, "decisions-2020-01-01-00Z.jsonl", '{"writer":"host"}\n',
      );
      await h.ctx.localFolders.writeTextAtomic(
        COMPANY, LOCAL_FOLDER_KEYS.shadowDecisions, "decisions-2020-01-01-01Z.jsonl", '{"writer":"host"}\n',
      );
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      // Current-hour shard holds the fresh pair; both seeded shards are gone.
      expect(await listShards(h)).toEqual([SHADOW_SHARD]);
      const records = (await readShadowLines(h)).map((line) => JSON.parse(line));
      expect(records.map((record) => record.writer)).toEqual(["host", "plugin-shadow"]);
    });

    it(": retention never touches the legacy single-file decisions.jsonl", async () => {
      const h = await boot(baseConfig({ shadowEmit: { enabled: true, shardMaxRecords: 100, retentionShards: 1 } }));
      await h.ctx.localFolders.writeTextAtomic(
        COMPANY, LOCAL_FOLDER_KEYS.shadowDecisions, "decisions.jsonl", '{"writer":"host","legacy":true}\n',
      );
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);

      const legacy = await h.ctx.localFolders.readText(COMPANY, LOCAL_FOLDER_KEYS.shadowDecisions, "decisions.jsonl");
      expect(legacy).toContain('"legacy":true');
    });

    it(": a write failure still swallows — advise() returns, failure logged, retention never runs", async () => {
      const h = await boot(baseConfig({ shadowEmit: { enabled: true, shardMaxRecords: 100 } }));
      const originalWrite = h.ctx.localFolders.writeTextAtomic.bind(h.ctx.localFolders);
      h.ctx.localFolders.writeTextAtomic = async () => {
        throw new Error("simulated local-folder I/O failure");
      };

      const result = await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      expect((result as { data: { modelId: string } }).data.modelId).toBe("claude-opus-5");
      expect(h.logs.some((l) => l.level === "warn" && l.message.includes("shadow decision emit failed"))).toBe(true);

      h.ctx.localFolders.writeTextAtomic = originalWrite;
    });

    it(": a transient read failure after existing records aborts the emit instead of truncating history", async () => {
      const h = await boot(baseConfig({ shadowEmit: { enabled: true, shardMaxRecords: 100 } }));
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      expect(await readShadowLines(h)).toHaveLength(4);

      const originalRead = h.ctx.localFolders.readText.bind(h.ctx.localFolders);
      h.ctx.localFolders.readText = async () => {
        throw new Error("simulated transient local-folder read failure");
      };

      const result = await h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx);
      expect((result as { data: { modelId: string } }).data.modelId).toBe("claude-opus-5");

      h.ctx.localFolders.readText = originalRead;

      // A transient read error must never be treated as "file is empty" — the
      // two prior pairs must survive untouched, not be overwritten by a
      // single pair built from a false-empty read.
      expect(await readShadowLines(h)).toHaveLength(4);
      expect(
        h.logs.some(
          (l) => l.level === "warn" && l.message.includes("shadow decision emit aborted — could not read existing log"),
        ),
      ).toBe(true);
    });

    it(": two overlapping emits both land instead of collapsing to one record", async () => {
      const h = await boot(baseConfig({ shadowEmit: { enabled: true, shardMaxRecords: 100 } }));

      await Promise.all([
        h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx),
        h.executeTool(TOOL_NAMES.advise, { issueId: ISSUE }, runCtx),
      ]);

      // Two concurrent read-modify-write cycles against the same file must
      // serialize, not race — racing them means both read the same "before"
      // content and the later write silently drops the earlier pair.
      expect(await readShadowLines(h)).toHaveLength(4);
    });
  });

  describe(" Defect 3: ancillary model pin drift", () => {
    function agentWith(overrides: Record<string, unknown>) {
      return {
        id: "agent-drift",
        companyId: COMPANY,
        name: "Mechanical worker",
        urlKey: "mechanical-worker",
        role: "general",
        title: null,
        icon: null,
        status: "active",
        reportsTo: null,
        capabilities: null,
        adapterType: "claude_local",
        adapterConfig: {},
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

    it("reports drift on an agent whose ancillary pin disagrees with the T3 recommendation", async () => {
      const h = await boot(baseConfig(), issue(), [
        agentWith({
          adapterConfig: { env: { ANTHROPIC_SMALL_FAST_MODEL: "some-stale-model" } },
        }),
      ]);
      const result = await h.executeTool(TOOL_NAMES.ancillaryDrift, {}, runCtx);
      const data = (result as { data: { recommendedModelId: string; drift: Array<Record<string, unknown>> } }).data;
      expect(data.recommendedModelId).toBe("claude-haiku-4-5-20251001");
      expect(data.drift).toHaveLength(1);
      expect(data.drift[0]).toMatchObject({
        surface: "ANTHROPIC_SMALL_FAST_MODEL",
        currentModelId: "some-stale-model",
        agentId: "agent-drift",
      });
    });

    it("reports no drift when every ancillary surface already matches the recommendation", async () => {
      const h = await boot(baseConfig(), issue(), [
        agentWith({
          adapterConfig: { env: { ANTHROPIC_SMALL_FAST_MODEL: "cliproxy/claude-haiku-4-5-20251001" } },
        }),
      ]);
      const result = await h.executeTool(TOOL_NAMES.ancillaryDrift, {}, runCtx);
      const data = (result as { data: { drift: unknown[] } }).data;
      expect(data.drift).toHaveLength(0);
    });

    it("writes nothing — read-only regardless of what drift it finds", async () => {
      const h = await boot(baseConfig(), issue(), [
        agentWith({ adapterConfig: { env: { ANTHROPIC_SMALL_FAST_MODEL: "some-stale-model" } } }),
      ]);
      await h.executeTool(TOOL_NAMES.ancillaryDrift, {}, runCtx);
      expect(h.activity).toHaveLength(0);
    });
  });
});
