import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { beforeEach, describe, expect, it } from "vitest";

import manifest from "../src/manifest.js";
import { PLUGIN_STATE_KEYS } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
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
    status: "in_progress",
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
    classification: { enabled: true },
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

function idleRow(id: string, status = "in_progress", extra: Record<string, unknown> = {}) {
  return { id, identifier: id, status, ...extra };
}

/**
 * `resolveTier()`'s issue-override precedence means a PINNED card's required
 * tier comes from the pinned model's OWN roster tier, not from the card's
 * label — so a repin within T1 needs a second T1-tier candidate to move to.
 * `MODELS` (tests/fixtures.ts) deliberately has exactly one T1 model; these
 * tests add a second one locally rather than widen the shared fixture.
 */
function withOpusAlt(overrides: Record<string, unknown> = {}) {
  const opus = MODELS.find((m) => m.id === "claude-opus-5")!;
  return [...MODELS, { ...opus, id: "claude-opus-5-alt", ...overrides }];
}

describe("scheduled passes (TOG-2481 tier_dispatcher.py port)", () => {
  describe("labelOnlyPass", () => {
    // 2026-09-07 01:0xZ owner rule: a card with an inherited/cloned tier:*
    // label but no pin (e.g. TOG-1348 cloned TOG-1334's tier:T1) is never seen
    // by classifyIssues (which only looks at unlabelled issues) and was
    // stranded on the agent floor. label_only_pass must pin it from the
    // existing label without re-classifying.
    it("pins a card from its existing tier label without calling the classifier", async () => {
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig(), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("labelOnlyPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("label-only pinned");
    });

    it("skips a card that carries pin:operator even if it has a tier label", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1"), operatorPinLabel()],
        labelIds: ["lbl-T1", "lbl-op"],
      });
      const harness = await boot(baseConfig(), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("labelOnlyPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
    });

    it("skips a card with no tier label at all", async () => {
      const card = issue("i1", { labels: [], labelIds: [] });
      const harness = await boot(baseConfig(), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("labelOnlyPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
    });

    it("skips when the pick equals the agent's own floor model", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAgentId: AGENT,
      });
      const harness = await boot(baseConfig(), [card], [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("labelOnlyPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
    });

    it("does nothing when classification.enabled is false (AC3 kill switch)", async () => {
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig({ classification: { enabled: false } }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("labelOnlyPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
    });
  });

  describe("repinPass", () => {
    // repin_pass()'s `usable(pinned) and capable(pinned, tier)[0]: continue`
    // skip rule — a still-healthy pinned model must never be touched.
    it("leaves a healthy pinned model alone", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig(), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("repinPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(0);
    });

    it("re-pins off a model whose lane has hit a serviceability hard stop", async () => {
      const modelsWithLane = withOpusAlt().map((m) => (m.id === "claude-opus-5" ? { ...m, laneId: "lane-opus" } : m));
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: modelsWithLane, pacing: { mode: "enforce" } }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        {
          "lane-opus": {
            laneId: "lane-opus",
            fetchedAt: "2026-09-13T00:00:00.000Z",
            observation: null,
            error: null,
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

      await harness.runJob("repinPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("re-pinned");
    });

    it("never repins a card that carries pin:operator (survives a routine repin)", async () => {
      const modelsWithLane = MODELS.map((m) => (m.id === "claude-opus-5" ? { ...m, laneId: "lane-opus" } : m));
      const card = issue("i1", {
        labels: [tierLabel("T1"), operatorPinLabel()],
        labelIds: ["lbl-T1", "lbl-op"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: modelsWithLane, pacing: { mode: "enforce" } }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("repinPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(0);
    });

    it("re-pins off a measurably demoted (incapable) model even without a lane hard stop", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: withOpusAlt() }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.modelScores },
        {
          modelScores: [
            {
              modelId: "claude-opus-5",
              aaIndex: 51,
              priorP: 0.9,
              tiers: {
                T1: { n: 20, ok: 5, failInfra: 0, failModel: 15, tmo: 0, nEff: 20, pObs: 0.25, p: 0.25, capable: false, proven: true, costPerSuccessUsd: null, medMin: null, rework: 10 },
                T2: { n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.8, capable: null, proven: false, costPerSuccessUsd: null, medMin: null, rework: 0 },
                T3: { n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.8, capable: null, proven: false, costPerSuccessUsd: null, medMin: null, rework: 0 },
              },
              overall: { n: 20, ok: 5, failInfra: 0, failModel: 15, tmo: 0, nEff: 20, pObs: 0.25, p: 0.25, capable: false, proven: true, costPerSuccessUsd: null, medMin: null, rework: 10 },
            },
          ],
          cardLedger: {},
        },
      );

      await harness.runJob("repinPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
    });

    it("stops writing once REPIN_PASS_WRITE_LIMIT (6) repins have happened this run", async () => {
      const modelsWithLane = withOpusAlt().map((m) => (m.id === "claude-opus-5" ? { ...m, laneId: "lane-opus" } : m));
      const cards = Array.from({ length: 8 }, (_, i) =>
        issue(`i${i}`, {
          labels: [tierLabel("T1")],
          labelIds: ["lbl-T1"],
          assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
        }),
      );
      const harness = await boot(baseConfig({ models: modelsWithLane, pacing: { mode: "enforce" } }), cards);
      harness.ctx.db.query = async () => cards.map((c) => idleRow(c.id)) as never;
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        {
          "lane-opus": {
            laneId: "lane-opus",
            fetchedAt: "2026-09-13T00:00:00.000Z",
            observation: null,
            error: null,
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

      await harness.runJob("repinPass");

      let changed = 0;
      for (const c of cards) {
        const after = await harness.ctx.issues.get(c.id, COMPANY);
        if (after?.assigneeAdapterOverrides && (after.assigneeAdapterOverrides as never as { adapterConfig: { model: string } }).adapterConfig.model !== "claude-opus-5") {
          changed += 1;
        }
      }
      expect(changed).toBe(6);
    });
  });

  describe("balancePass", () => {
    // 2026-09-05 23:05Z owner rule: unpinned + labelled cards were left on the
    // agent floor by the old exclusion rule. balance_pass must give them a
    // balanced T1-class pin — ALWAYS T1, never the card's own tier label.
    // This is the exact bug caught and fixed via advise()'s forceTier param.
    it("gives an unpinned, T3-labelled card a T1 pin, not a T3 pin", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAdapterOverrides: null,
      });
      const harness = await boot(baseConfig(), [card], [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.metadata?.tier).toBe("T1");
    });

    it("skips an unpinned labelled card when the T1 pick equals the agent floor", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: null,
      });
      const harness = await boot(baseConfig(), [card], [agentRow({ adapterConfig: { model: "claude-opus-5" } })]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
    });

    it("skips an unpinned card with no tier label", async () => {
      const card = issue("i1", { labels: [], labelIds: [], assigneeAdapterOverrides: null });
      const harness = await boot(baseConfig(), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
    });

    // balance_pass()'s `cheaper = blended(nm) <= 0.8*blended(pm)` cost-down rule.
    it("re-pins a pinned card onto a cheaper candidate (cost-down)", async () => {
      const cheapModels = withOpusAlt().map((m) =>
        m.id === "claude-opus-5" ? { ...m, costPerMTokIn: 100, costPerMTokOut: 500 } : m,
      );
      const card = issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: cheapModels }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity[0]?.metadata?.cheaper).toBe(true);
    });

    // balance_pass()'s `busier = (cur_u-new_u)>=0.25` rebalance rule.
    it("re-pins onto a far-less-busy lane even when cost is unchanged (busier >= 0.25)", async () => {
      const laned = withOpusAlt().map((m) => {
        if (m.id === "claude-opus-5") return { ...m, laneId: "lane-busy" };
        if (m.id === "claude-opus-5-alt") return { ...m, laneId: "lane-quiet" };
        return m;
      });
      const card = issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: laned, pacing: { mode: "enforce" } }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        {
          "lane-busy": {
            laneId: "lane-busy",
            fetchedAt: "2026-09-13T00:00:00.000Z",
            observation: null,
            error: null,
            verdict: {
              laneId: "lane-busy",
              observedAt: "2026-09-13T00:00:00.000Z",
              state: "ahead",
              serviceable: true,
              score: { utilization: 0.95, elapsed: 0.5, deviation: 0.45 },
              accounts: [],
              knownAccountCount: 1,
              knownWeight: 1,
              serviceableAccountCount: 1,
              urgentResetAt: null,
              reason: "ok",
            },
          },
        },
      );

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      // Pick must have moved off claude-opus-5 onto some other (less-busy) candidate.
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
    });

    it("stops writing once BALANCE_PASS_WRITE_LIMIT (8) balances have happened this run", async () => {
      const cheapModels = withOpusAlt().map((m) =>
        m.id === "claude-opus-5" ? { ...m, costPerMTokIn: 100, costPerMTokOut: 500 } : m,
      );
      const cards = Array.from({ length: 10 }, (_, i) =>
        issue(`i${i}`, {
          labels: [tierLabel("T3")],
          labelIds: ["lbl-T3"],
          assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
        }),
      );
      const harness = await boot(baseConfig({ models: cheapModels }), cards);
      harness.ctx.db.query = async () => cards.map((c) => idleRow(c.id)) as never;

      await harness.runJob("balancePass");

      let changed = 0;
      for (const c of cards) {
        const after = await harness.ctx.issues.get(c.id, COMPANY);
        if (after?.assigneeAdapterOverrides && (after.assigneeAdapterOverrides as never as { adapterConfig: { model: string } }).adapterConfig.model !== "claude-opus-5") {
          changed += 1;
        }
      }
      expect(changed).toBe(8);
    });

    it("does nothing when classification.enabled is false (AC3 kill switch)", async () => {
      const card = issue("i1", { labels: [tierLabel("T3")], labelIds: ["lbl-T3"], assigneeAdapterOverrides: null });
      const harness = await boot(baseConfig({ classification: { enabled: false } }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
    });
  });
});
