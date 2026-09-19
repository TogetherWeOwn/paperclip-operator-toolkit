import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ScopeKey } from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { BALANCE_PASS_FETCH_LIMIT, BALANCE_PASS_JOB_BUDGET_MS, PLUGIN_STATE_KEYS } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { MODELS, NO_ESCALATION, PROFILES, subCallPins } from "./fixtures.js";

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

/**
 * Scores `claude-opus-5` as measurably incapable at T1 (5 ok / 15 model-fails
 * over 20 runs, `capable: false`, `proven: true`) so a card pinned to it is
 * re-pinnable without a lane hard stop. Pair with {@link withOpusAlt} so there
 * is somewhere else to land.
 */
async function demoteOpus(harness: Awaited<ReturnType<typeof boot>>) {
  const demoted = { n: 20, ok: 5, failInfra: 0, failModel: 15, tmo: 0, nEff: 20, pObs: 0.25, p: 0.25, capable: false, proven: true, costPerSuccessUsd: null, medMin: null, rework: 10 };
  const unproven = { n: 0, ok: 0, failInfra: 0, failModel: 0, tmo: 0, nEff: 0, pObs: null, p: 0.8, capable: null, proven: false, costPerSuccessUsd: null, medMin: null, rework: 0 };
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.modelScores },
    {
      modelScores: [
        {
          modelId: "claude-opus-5",
          aaIndex: 51,
          priorP: 0.9,
          tiers: { T1: demoted, T2: unproven, T3: unproven },
          overall: demoted,
        },
      ],
      cardLedger: {},
    },
  );
}

/**
 * TOG-2862: no pass may pay a `heartbeat_runs` read per scanned candidate.
 *
 * The incident was `balancePass` hitting the host's 300 s RPC wall on EVERY
 * run; the cause was one unindexed context lookup per candidate, doubled on
 * the pinned path because `advise()` re-described the same issue. `repinPass`
 * walks the same candidates through the same `describeIssue`/`advise` pair, so
 * it carries the identical doubling and is gated here too.
 *
 * These bound the COUNT, not the wall-clock — a duration assertion would be
 * flaky and would not name the defect.
 */
function countContextQueries(
  harness: Awaited<ReturnType<typeof boot>>,
  rows: Array<Record<string, unknown>>,
) {
  const contextQueries: string[] = [];
  harness.ctx.db.query = (async (query: string) => {
    // The context lookup is the only query selecting this alias.
    if (query.includes("input_tokens") && query.includes("context_snapshot")) {
      contextQueries.push(query);
      return [];
    }
    if (query.includes("from issues i")) return rows;
    return [];
  }) as typeof harness.ctx.db.query;
  return contextQueries;
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
      expect(after?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5") },
      });
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

    // TOG-3037: the equality check alone (`pick === floor`, above) treats an
    // implicit NULL-override floor pin as a neutral no-op, but NULL is an
    // implicit pin to the floor lane — never tested for serviceability here.
    // If that lane is exhausted, this pass must write an EXPLICIT pin to a
    // serviceable candidate instead of leaving the card parked on a dead
    // lane. This test forces the floor's lane to read exhausted at the
    // moment this pass takes its own per-company ledger snapshot, then
    // recovered by the time `advise()` takes its own fresh per-row read — a
    // real mid-pass race (the ledger is written by a separate poller/operator
    // action, and a pass walks many rows with real I/O between them) — to
    // exercise the new health gate deterministically.
    it("writes an explicit pin instead of silently eliding when the floor's lane reads exhausted at snapshot time", async () => {
      const modelsWithLane = MODELS.map((m) =>
        m.id === "claude-haiku-4-5-20251001" ? { ...m, laneId: "lane-sol" } : m,
      );
      const card = issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAgentId: AGENT,
      });
      const harness = await boot(
        baseConfig({ models: modelsWithLane, pacing: { mode: "enforce" } }),
        [card],
        [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })],
      );
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      const deadLedger = {
        "lane-sol": {
          laneId: "lane-sol",
          fetchedAt: "2026-09-13T00:00:00.000Z",
          observation: null,
          error: null,
          verdict: {
            laneId: "lane-sol",
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
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        deadLedger,
      );
      const originalGet = harness.ctx.state.get.bind(harness.ctx.state);
      let laneLedgerReads = 0;
      harness.ctx.state.get = (async (input: ScopeKey) => {
        if (input.stateKey === PLUGIN_STATE_KEYS.laneLedger) {
          laneLedgerReads += 1;
          return laneLedgerReads === 1 ? deadLedger : {};
        }
        return originalGet(input);
      }) as typeof harness.ctx.state.get;

      await harness.runJob("labelOnlyPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-haiku-4-5-20251001", env: subCallPins("claude-haiku-4-5-20251001") },
      });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("floor lane unserviceable");
    });

    it("still elides when the floor's lane is healthy throughout (unchanged cost)", async () => {
      const modelsWithLane = MODELS.map((m) =>
        m.id === "claude-haiku-4-5-20251001" ? { ...m, laneId: "lane-sol" } : m,
      );
      const card = issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAgentId: AGENT,
      });
      const harness = await boot(
        baseConfig({ models: modelsWithLane, pacing: { mode: "enforce" } }),
        [card],
        [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })],
      );
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("labelOnlyPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
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
      await demoteOpus(harness);

      await harness.runJob("repinPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
    });

    // TOG-2862. `repinPass` reaches the context lookup on two separate lines:
    // `describeIssue` reads the estimate to judge capability, and the
    // `advise()` call it then makes re-describes the same issue. Without the
    // shared per-pass cache that is two unindexed reads per re-pinnable
    // candidate, which is the same shape that walked `balancePass` into the
    // 300 s wall. The balance gates do not cover this path.
    it("reads the heartbeat context at most once per re-pinnable candidate", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: withOpusAlt() }), [card]);
      const contextQueries = countContextQueries(harness, [idleRow("i1")]);
      await demoteOpus(harness);

      await harness.runJob("repinPass");

      // Non-vacuity: the pass really did re-pin, so it really did run both the
      // describe and the advise read. A card that bailed early would report
      // zero queries and pass a bare `toBeLessThan(2)`.
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
      expect(contextQueries).toHaveLength(1);
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
      expect(after?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5") },
      });
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

    // TOG-3037: same gap as labelOnlyPass's floor-equality skip, in the
    // unpinned branch. See the labelOnlyPass test of the same name for why
    // the race is forced via a `state.get` sequencing mock rather than a
    // single consistent ledger.
    it("writes an explicit pin instead of silently eliding when the floor's lane reads exhausted at snapshot time", async () => {
      const modelsWithLane = MODELS.map((m) => (m.id === "claude-opus-5" ? { ...m, laneId: "lane-opus" } : m));
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: null,
      });
      const harness = await boot(
        baseConfig({ models: modelsWithLane, pacing: { mode: "enforce" } }),
        [card],
        [agentRow({ adapterConfig: { model: "claude-opus-5" } })],
      );
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      const deadLedger = {
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
      };
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        deadLedger,
      );
      const originalGet = harness.ctx.state.get.bind(harness.ctx.state);
      let laneLedgerReads = 0;
      harness.ctx.state.get = (async (input: ScopeKey) => {
        if (input.stateKey === PLUGIN_STATE_KEYS.laneLedger) {
          laneLedgerReads += 1;
          return laneLedgerReads === 1 ? deadLedger : {};
        }
        return originalGet(input);
      }) as typeof harness.ctx.state.get;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5") },
      });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("floor lane unserviceable");
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

    it("skips a candidate with a queued heartbeat run even before issue lock fields attach", async () => {
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig(), [card], [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) return [idleRow("i1")];
        if (query.includes("select distinct coalesce")) return [{ issue_id: "i1" }];
        return [];
      }) as typeof harness.ctx.db.query;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
    });

    it("refuses a write when a heartbeat run queues during selection", async () => {
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig(), [card], [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) return [idleRow("i1")];
        if (query.includes("select distinct coalesce")) return [];
        if (query.includes("status in ('running','queued')") && query.includes("limit 1")) {
          return [{ issue_id: "i1" }];
        }
        return [];
      }) as typeof harness.ctx.db.query;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
    });

    it("drops a stale candidate row after the issue becomes terminal", async () => {
      const card = issue("i1", {
        status: "done",
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
      });
      const harness = await boot(baseConfig(), [card], [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) return [idleRow("i1", "in_progress")];
        return [];
      }) as typeof harness.ctx.db.query;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
    });

    it("refuses a write when the issue becomes terminal during selection", async () => {
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig(), [card], [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) return [idleRow("i1")];
        return [];
      }) as typeof harness.ctx.db.query;
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      let reads = 0;
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        reads += 1;
        return reads >= 3 && current ? ({ ...current, status: "done" } as typeof current) : current;
      }) as typeof harness.ctx.issues.get;

      try {
        await harness.runJob("balancePass");
      } finally {
        harness.ctx.issues.get = originalGet;
      }

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
    });

    it("stops starting rows when the global job budget is exhausted", async () => {
      const card = issue("i1", { labels: [], labelIds: [] });
      const harness = await boot(baseConfig(), [card]);
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
      }) as typeof harness.ctx.logger.info;
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) {
          nowMs = BALANCE_PASS_JOB_BUDGET_MS + 1;
          return [idleRow("i1")];
        }
        return [];
      }) as typeof harness.ctx.db.query;

      try {
        await harness.runJob("balancePass");
      } finally {
        nowSpy.mockRestore();
      }

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(infoLogs).toHaveLength(1);
      expect(infoLogs[0]?.metadata.budgetExhausted).toBe(true);
      expect(infoLogs[0]?.metadata.jobDurationMs).toBe(BALANCE_PASS_JOB_BUDGET_MS + 1);
    });

    it("pages candidates with a persisted keyset cursor and logs durationMs", async () => {
      const cards = Array.from({ length: BALANCE_PASS_FETCH_LIMIT + 5 }, (_, i) =>
        issue(`i${String(i).padStart(3, "0")}`, { labels: [], labelIds: [] }),
      );
      const harness = await boot(baseConfig(), cards);
      const candidateCursors: string[] = [];
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
      }) as typeof harness.ctx.logger.info;
      harness.ctx.db.query = (async (query: string, params: readonly unknown[] = []) => {
        if (!query.includes("from issues i")) return [];
        const afterId = String(params[1] ?? "");
        const limit = Number(params[2]);
        candidateCursors.push(afterId);
        return cards
          .filter((card) => card.id > afterId)
          .slice(0, limit)
          .map((card) => idleRow(card.id));
      }) as typeof harness.ctx.db.query;

      await harness.runJob("balancePass");
      expect(await harness.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.balancePassCursor,
      })).toEqual({ afterId: cards[BALANCE_PASS_FETCH_LIMIT - 1]?.id });

      await harness.runJob("balancePass");
      expect(await harness.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.balancePassCursor,
      })).toEqual({ afterId: null });
      expect(candidateCursors).toEqual(["", cards[BALANCE_PASS_FETCH_LIMIT - 1]?.id]);
      expect(infoLogs).toHaveLength(2);
      expect(infoLogs.every((entry) => typeof entry.metadata.durationMs === "number")).toBe(true);
    });

    it("rechecks idleness after the candidate query before writing", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        checkoutRunId: "run-1",
      });
      const harness = await boot(baseConfig(), [card], [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
    });

    // --- TOG-2862: the pass must not pay a heartbeat_runs read per scanned
    // candidate. See `countContextQueries` above.
    it("reads no heartbeat context for candidates it cannot re-pin", async () => {
      // Twelve untiered cards: every one is rejected on already-read fields,
      // so the expensive lookup must never run.
      const cards = Array.from({ length: 12 }, (_, i) =>
        issue(`i${String(i).padStart(3, "0")}`, { labels: [], labelIds: [], assigneeAdapterOverrides: null }),
      );
      const harness = await boot(baseConfig(), cards);
      const contextQueries = countContextQueries(harness, cards.map((card) => idleRow(card.id)));

      await harness.runJob("balancePass");

      expect(contextQueries).toHaveLength(0);
    });

    it("reads the heartbeat context at most once per re-pinnable candidate", async () => {
      // Same shape as the cost-down test, which does reach `advise()` — before
      // TOG-2862 this one card cost TWO context reads (describe, then advise
      // re-describing it).
      const cheapModels = withOpusAlt().map((m) =>
        m.id === "claude-opus-5" ? { ...m, costPerMTokIn: 100, costPerMTokOut: 500 } : m,
      );
      const card = issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: cheapModels }), [card]);
      const contextQueries = countContextQueries(harness, [idleRow("i1")]);

      await harness.runJob("balancePass");

      // Non-vacuity: the pass really did re-pin, so it really did reach the
      // path that needs the estimate.
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(contextQueries).toHaveLength(1);
    });

    it("never filters the context lookup on an unindexed coalesce expression", async () => {
      const cheapModels = withOpusAlt().map((m) =>
        m.id === "claude-opus-5" ? { ...m, costPerMTokIn: 100, costPerMTokOut: 500 } : m,
      );
      const card = issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: cheapModels }), [card]);
      const contextQueries = countContextQueries(harness, [idleRow("i1")]);

      await harness.runJob("balancePass");

      expect(contextQueries.length).toBeGreaterThan(0);
      for (const query of contextQueries) {
        expect(query).not.toMatch(/coalesce\s*\(\s*context_snapshot/i);
      }
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

  /**
   * TOG-3200. `classifyIssues` used to skip any card carrying a `tier:*` label,
   * which made it a one-shot stamp. Measured 2026-09-17: 120 of 126 eligible
   * open cards already carried one, 1,498 of the company's 1,542 tier labels
   * (97.1%) were written by somebody other than this plugin, and the job ran 36
   * times that day writing ZERO classifications while 53% of runs and 93.8% of
   * spend sat on T1.
   */
  describe("classifyIssues foreign-label reclassification", () => {
    function classifyConfig(overrides: Record<string, unknown> = {}) {
      return baseConfig({
        classification: {
          enabled: true,
          baseUrl: "https://classifier.example.com",
          modelId: "gpt-5.6-luna",
          ...overrides,
        },
      });
    }

    /** Stub the classifier HTTP call and record how many times it was asked. */
    function stubClassifier(
      harness: Awaited<ReturnType<typeof boot>>,
      verdict: { tier: string; confidence: number; exclusion?: boolean },
    ) {
      const calls: string[] = [];
      harness.ctx.http.fetch = (async (_url: string, init: { body: string }) => {
        calls.push(init.body);
        return {
          status: 200,
          headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
          redirected: false,
          text: async () =>
            JSON.stringify({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    tier: verdict.tier,
                    confidence: verdict.confidence,
                    exclusion: verdict.exclusion ?? false,
                    reason: "test",
                  }),
                },
              ],
            }),
        };
      }) as typeof harness.ctx.http.fetch;
      return calls;
    }

    function classifyRow(id: string) {
      return { id, identifier: id, status: "in_progress", agent_name: "Founding Engineer", title: "A card", description: "d" };
    }

    it("reclassifies a card whose tier label this plugin did not write", async () => {
      // The whole defect in one case: an agent self-assessed T1, the plugin had
      // no record of writing it, and the old code skipped the card forever.
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(classifyConfig(), [card]);
      harness.ctx.db.query = async () => [classifyRow("i1")] as never;
      const calls = stubClassifier(harness, { tier: "T2", confidence: 0.9 });

      await harness.runJob("classifyIssues");

      expect(calls).toHaveLength(1);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.labelIds).toEqual(["lbl-T2"]);
    });

    it("DROPS the foreign tier label rather than adding alongside it", async () => {
      // An additive write would leave tier:T1 and tier:T2 both attached, and
      // `tierFromLabels` resolves a two-tier card by taking the most capable —
      // so the card would still route T1 and the fix would be silently inert.
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1", "lbl-other"] });
      const harness = await boot(classifyConfig(), [card]);
      harness.ctx.db.query = async () => [classifyRow("i1")] as never;
      stubClassifier(harness, { tier: "T3", confidence: 0.95 });

      await harness.runJob("classifyIssues");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.labelIds).not.toContain("lbl-T1");
      expect(after?.labelIds).toContain("lbl-T3");
      // Non-tier labels are untouched — this job writes a tier, not a triage.
      expect(after?.labelIds).toContain("lbl-other");
    });

    it("does NOT reclassify a card whose tier label this plugin did write", async () => {
      // Re-running the classifier against its own last answer is pure spend,
      // and on a T1 lane at 0.915 weekly utilisation that spend is the problem
      // the card is about.
      const card = issue("i1", { labels: [tierLabel("T2")], labelIds: ["lbl-T2"] });
      const harness = await boot(classifyConfig(), [card]);
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.classifierLabeledIssues },
        { i1: "T2" },
      );
      harness.ctx.db.query = async () => [classifyRow("i1")] as never;
      const calls = stubClassifier(harness, { tier: "T3", confidence: 0.95 });

      await harness.runJob("classifyIssues");

      expect(calls).toHaveLength(0);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.labelIds).toEqual(["lbl-T2"]);
    });

    it("records provenance so the next run skips the card it just classified", async () => {
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(classifyConfig(), [card]);
      harness.ctx.db.query = async () => [classifyRow("i1")] as never;
      const calls = stubClassifier(harness, { tier: "T2", confidence: 0.9 });

      await harness.runJob("classifyIssues");
      await harness.runJob("classifyIssues");

      // Two runs, one classifier call: the second run recognised its own label.
      //
      // This also pins the label-view tie-break. The harness patches `labelIds`
      // without rehydrating `labels`, so on run 2 the name view still reads
      // tier:T1 while the id view reads lbl-T2 — the two disagree. That must
      // resolve to "ours": resolving it to "foreign" would re-run the
      // classifier on this card on every job tick, forever.
      expect(calls).toHaveLength(1);
      const stored = await harness.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.classifierLabeledIssues,
      } as ScopeKey);
      expect(stored).toEqual({ i1: "T2" });
    });

    it("never touches a pin:operator card, foreign label or not", async () => {
      // "Leave the model choice on this issue alone" outranks reclassification.
      const card = issue("i1", { labels: [tierLabel("T1"), operatorPinLabel()], labelIds: ["lbl-T1", "lbl-op"] });
      const harness = await boot(classifyConfig(), [card]);
      harness.ctx.db.query = async () => [classifyRow("i1")] as never;
      const calls = stubClassifier(harness, { tier: "T3", confidence: 0.95 });

      await harness.runJob("classifyIssues");

      expect(calls).toHaveLength(0);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.labelIds).toEqual(["lbl-T1", "lbl-op"]);
    });

    it("restores the pre-3200 unconditional skip when reclassifyForeignLabels is false", async () => {
      // The documented one-key rollback. If this stops working the change has
      // no off switch.
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(classifyConfig({ reclassifyForeignLabels: false }), [card]);
      harness.ctx.db.query = async () => [classifyRow("i1")] as never;
      const calls = stubClassifier(harness, { tier: "T2", confidence: 0.9 });

      await harness.runJob("classifyIssues");

      expect(calls).toHaveLength(0);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.labelIds).toEqual(["lbl-T1"]);
    });

    it("still classifies an unlabelled card, and adds without dropping anything", async () => {
      const card = issue("i1", { labels: [], labelIds: ["lbl-other"] });
      const harness = await boot(classifyConfig(), [card]);
      harness.ctx.db.query = async () => [classifyRow("i1")] as never;

      stubClassifier(harness, { tier: "T2", confidence: 0.9 });
      await harness.runJob("classifyIssues");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.labelIds).toEqual(["lbl-other", "lbl-T2"]);
    });

    it("over-fetches candidates so skipped rows cannot starve the batch", async () => {
      // With `limit = batchSize` the row query returned the same top-N rows
      // every run. Once those rows are all skipped after the fact — which is
      // precisely what provenance now causes — row N+1 was never reached and
      // the job classified nothing forever. The fetch limit must exceed the
      // write cap.
      let seenLimitArg: string | null = null;
      const card = issue("i1", { labels: [], labelIds: [] });
      const harness = await boot(classifyConfig({ batchSize: 3 }), [card]);
      harness.ctx.db.query = (async (query: string, params: string[]) => {
        if (query.includes("from issues i")) {
          seenLimitArg = params[1] ?? null;
          return [classifyRow("i1")];
        }
        return [];
      }) as typeof harness.ctx.db.query;
      stubClassifier(harness, { tier: "T2", confidence: 0.9 });

      await harness.runJob("classifyIssues");

      expect(Number(seenLimitArg)).toBeGreaterThan(3);
      expect(Number(seenLimitArg)).toBe(30);
    });

    it("stops at batchSize ACTUAL classifications, not at batchSize rows scanned", async () => {
      const cards = ["i1", "i2", "i3", "i4", "i5"].map((id) => issue(id, { labels: [], labelIds: [] }));
      const harness = await boot(classifyConfig({ batchSize: 2 }), cards);
      harness.ctx.db.query = async () => cards.map((c) => classifyRow(c.id)) as never;
      const calls = stubClassifier(harness, { tier: "T2", confidence: 0.9 });

      await harness.runJob("classifyIssues");

      expect(calls).toHaveLength(2);
    });
  });
});
