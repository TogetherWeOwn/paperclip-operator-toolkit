import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ScopeKey } from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import {
  BALANCE_PASS_FETCH_LIMIT,
  BALANCE_PASS_JOB_BUDGET_MS,
  BALANCE_PASS_ROW_TIMEOUT_MS,
  CLASSIFY_JOB_BUDGET_MS,
  CLASSIFY_ROW_TIMEOUT_MS,
  LABEL_ONLY_PASS_FETCH_LIMIT,
  LABEL_ONLY_PASS_MAX_ROWS_PER_FIRING,
  LABEL_ONLY_PASS_JOB_BUDGET_MS,
  LABEL_ONLY_PASS_ROW_TIMEOUT_MS,
  PLUGIN_STATE_KEYS,
  REPIN_PASS_JOB_BUDGET_MS,
  REPIN_PASS_ROW_TIMEOUT_MS,
} from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, subCallPins } from "./fixtures.js";

const COMPANY = "co-1";
const AGENT = "agent-1";

// TOG-4384: freeze the wall clock at the fixture NOW so the seeded PROFILES
// (computedAt = NOW - 1h) stay inside the production 14-day guard
// (src/engine/cost.ts). Date-only: async timers keep running, and the
// budget-exhaustion test below still owns Date.now via its own spy.
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

describe("price reconciliation", () => {
  it("carries free-model notes from config through the scheduled job", async () => {
    const harness = await boot(baseConfig({
      priceSync: { enabled: true },
      models: [{
        ...MODELS[0], id: "big-pickle", laneId: "cliproxy-zen",
        costPerMTokIn: 0, costPerMTokOut: 0, costPerMTokCacheRead: 0,
        note: "free Zen model; no Go quota",
      }],
    }));
    harness.ctx.http.fetch = async () => new Response(JSON.stringify({ meta: { models: {
      "muse-spark-1.3": { cost: { input: 1.25, output: 4.25 } },
    } } }));
    await harness.runJob("reconcilePrices");
    const stored = await harness.ctx.state.get({
      scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.priceReconcileReport,
    });
    expect(stored).toMatchObject({ report: {
      excluded: [{ modelId: "big-pickle", reason: "free-tier" }],
      drift: [], unresolved: [], checked: 0,
    } });
  });
});

function idleRow(id: string, status = "in_progress", extra: Record<string, unknown> = {}) {
  return { id, identifier: id, status, ...extra };
}

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
    // Context lookup selects durable log metadata, never billing token totals.
    if (query.includes("log_sha256") && query.includes("context_snapshot")) {
      contextQueries.push(query);
      return [];
    }
    if (query.includes("from issues i")) return rows;
    return [];
  }) as typeof harness.ctx.db.query;
  return contextQueries;
}

/** How long a stalled host call blocks, past any job budget (fake time). */
const STALL_PAST_BUDGET_MS = 60_000;

/**
 * Block a host call until `budgetMs + STALL_PAST_BUDGET_MS` of fake time has
 * passed — longer than any job budget, so only the deadline race can end the
 * row. Only meaningful under `runJobPastDeadline`.
 */
function stallPastBudget(budgetMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, budgetMs + STALL_PAST_BUDGET_MS));
}

/**
 * TOG-11688 HARD RETURN harness. Production races each row body against the
 * job deadline with a `setTimeout` armed at row start for the REMAINING
 * budget, so a test must move `Date` and timers together (a mocked-`Date`
 * jump leaves the race timer ~200 s out). Runs `jobKey` on that clock and
 * returns how long after job start the job resolved — throwing if it is still
 * running `budgetMs + 1` ms in, which is the 300 s-wall failure. Before it
 * returns, the clock runs on until every stalled host call has completed, so
 * the abandoned row body has run to its write gate: a write counter read
 * afterwards catches an orphaned post-deadline write. Leaves the suite's
 * Date-only fake clock in place for a resume firing. (vitest 2 ignores a
 * second `useFakeTimers` while time is faked — reset to real timers first.)
 */
async function runJobPastDeadline(
  harness: Awaited<ReturnType<typeof boot>>,
  jobKey: string,
  budgetMs: number,
): Promise<number> {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  const jobStartedAt = Date.now();
  let resolvedAt: number | null = null;
  let failure: unknown = null;
  const run = harness.runJob(jobKey).then(
    () => {
      resolvedAt = Date.now();
    },
    (error: unknown) => {
      failure = error ?? new Error("job rejected");
    },
  );
  await vi.advanceTimersByTimeAsync(budgetMs + 1);
  if (failure !== null) throw failure;
  if (resolvedAt === null) throw new Error(`${jobKey} still running ${budgetMs + 1} ms after job start`);
  await run;
  await vi.advanceTimersByTimeAsync(budgetMs + STALL_PAST_BUDGET_MS);
  const resumeAt = Date.now();
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(resumeAt);
  return (resolvedAt as number) - jobStartedAt;
}

/**
 * TOG-11688: the stored scan mark in epoch ms, 0 when no mark was written
 * (the pass then re-reads from the epoch). A row at `updated_at` T is re-read
 * next firing exactly when this is < T (`updated_at > mark`).
 */
async function storedScanMarkMs(harness: Awaited<ReturnType<typeof boot>>, stateKey: string): Promise<number> {
  const stored = (await harness.ctx.state.get({ scopeKind: "company", scopeId: COMPANY, stateKey } as never)) as {
    at?: string;
  } | null;
  return stored?.at ? Date.parse(stored.at) : 0;
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
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
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

    // TOG-3024 (TOG-3012 root cause #3, 2026-09-16 16:40Z incident). Positive
    // control: before this fix, `labelOnlyPass` gated on `tierFromLabels(...)`
    // alone and `continue`d when it was null, so a card with NO tier:* label
    // was never even handed to `advise()` — not "considered and left alone",
    // simply invisible to the pass. Give the card an agent with no resolvable
    // floor model so the fallback must fall all the way to
    // `config.selection.defaultTier` (T1 here) to produce a pin; if the old
    // unconditional `continue` were restored, this assertion would fail back
    // to `null`.
    //
    // Pin-anchored half of the TOG-3024 pair: the mutant this test
    // exists to kill is the restored unconditional `continue`, which
    // leaves the override null — so anchor on the pin itself (a null
    // override throws on the property read) and on the sub-call
    // surfaces travelling with it. The whole-object sibling below
    // covers the full env shape instead.
    it("pins a card with no tier label via the config-default fallback (TOG-3024, pin-anchored)", async () => {
      const card = issue("i1", { labels: [], labelIds: [] });
      const harness = await boot(
        baseConfig({ selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true, defaultTier: "T1" } }),
        [card],
        [agentRow({ adapterConfig: {} })],
      );
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("labelOnlyPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      // TOG-3116 widened the write payload from model-only to model+env, so
      // the original whole-object equality here no longer describes a correct
      // write. The mutant this test exists to kill is the restored
      // unconditional `continue`, which leaves the override null — so anchor
      // on the pin itself (a null override throws on the property read) and on
      // the sub-call surface that must now travel with it.
      const cfg = (after?.assigneeAdapterOverrides as { adapterConfig: { model: string; env: Record<string, unknown> } })
        .adapterConfig;
      expect(cfg.model).toBe("claude-opus-5");
      expect(cfg.env.PAPERCLIP_ASSIGNED_MODEL).toEqual({ type: "plain", value: "claude-opus-5" });
      expect(cfg.env.ANTHROPIC_SMALL_FAST_MODEL).toEqual({ type: "plain", value: "claude-haiku-4-5-20251001" });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.metadata?.fromLabel).toBe(false);
    });

    // TOG-5227: a user-assigned card (assignee_user_id set, e.g. Operator:*
    // cards) rejects issues.update with an agent override ("Issue can only
    // have one assignee"). The pass must skip it, not attempt the pin.
    it("skips a user-assigned card even if it has a tier label (TOG-5227)", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeUserId: "user-1",
      });
      const harness = await boot(baseConfig(), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("labelOnlyPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
    });

    // TOG-5227: one card's pin rejection must not abort the pass for the
    // whole company (and must not skip the scan-mark advance, which used to
    // re-hit the same card on every firing). The stubbed update throws the
    // exact live error for i1; i2 must still pin and the watermark advance.
    it("isolates a per-issue pin failure so the rest of the pass completes (TOG-5227)", async () => {
      const cards = [
        issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] }),
        issue("i2", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] }),
      ];
      const harness = await boot(baseConfig(), cards);
      harness.ctx.db.query = async () => [idleRow("i1"), idleRow("i2")] as never;
      const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
      harness.ctx.issues.update = (async (...args: Parameters<typeof originalUpdate>) => {
        if (args[0] === "i1") throw new Error("Issue can only have one assignee");
        return originalUpdate(...args);
      }) as typeof harness.ctx.issues.update;
      const before = Date.now();

      await harness.runJob("labelOnlyPass");

      const afterBad = await harness.ctx.issues.get("i1", COMPANY);
      expect(afterBad?.assigneeAdapterOverrides ?? null).toBeNull();
      const afterGood = await harness.ctx.issues.get("i2", COMPANY);
      expect(afterGood?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
      });
      expect(harness.activity).toHaveLength(1);
      const warns = (harness.logs as Array<{ level: string; message: string }>).filter((entry) =>
        entry.message.includes("label-only pass skipped a card it could not pin"),
      );
      expect(warns).toHaveLength(1);
      const stored = (await harness.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.labelOnlyLastScanAt,
      } as ScopeKey)) as { at: string };
      expect(Date.parse(stored.at)).toBeGreaterThanOrEqual(before);
    });

    // TOG-3024 (TOG-3012 root cause #3, 2026-09-16 16:40Z incident). Positive
    // control: before this fix, `labelOnlyPass` gated on `tierFromLabels(...)`
    // alone and `continue`d when it was null, so a card with NO tier:* label
    // was never even handed to `advise()` — not "considered and left alone",
    // simply invisible to the pass. Give the card an agent with no resolvable
    // floor model so the fallback must fall all the way to
    // `config.selection.defaultTier` (T1 here) to produce a pin; if the old
    // unconditional `continue` were restored, this assertion would fail back
    // to `null`.
    it("pins a card with no tier label via the config-default fallback (TOG-3024)", async () => {
      const card = issue("i1", { labels: [], labelIds: [] });
      const harness = await boot(
        baseConfig({ selection: { enabled: true, mode: "enforce", holdOnUntrustedProfile: true, defaultTier: "T1" } }),
        [card],
        [agentRow({ adapterConfig: {} })],
      );
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("labelOnlyPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
      });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.metadata?.fromLabel).toBe(false);
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
      // TOG-3116 changed the SHAPE of every write: the override now also
      // carries the six sub-call env keys. The pin assertion is what TOG-3037
      // is about, so assert it directly rather than by whole-object equality,
      // and additionally require the env this write emits to be off the dead
      // lane — a stronger bar than the original `toEqual` gave.
      const labelOnlyCfg = (
        after?.assigneeAdapterOverrides as { adapterConfig: { model: string; env?: Record<string, unknown> } }
      ).adapterConfig;
      expect(labelOnlyCfg.model).toBe("claude-haiku-4-5-20251001");
      expect(JSON.stringify(labelOnlyCfg.env ?? {})).not.toContain("claude-opus-5");
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

    // TOG-7123: the 2026-09-27 incident — this pass walked all 100 fetched
    // rows with no elapsed-time budget and ran past the host's 300 s job RPC
    // wall (300061 ms / 300085 ms) while the worker kept walking rows it
    // could never report. Slow per-card API calls must stop STARTING new
    // rows once the cooperative budget is gone.
    it("stops starting new rows once the job budget is exhausted (TOG-7123)", async () => {
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig(), [card]);
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
      }) as typeof harness.ctx.logger.info;
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) {
          nowMs = LABEL_ONLY_PASS_JOB_BUDGET_MS + 1;
          return [idleRow("i1")];
        }
        return [];
      }) as typeof harness.ctx.db.query;

      try {
        await harness.runJob("labelOnlyPass");
      } finally {
        nowSpy.mockRestore();
      }

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(infoLogs).toHaveLength(1);
      expect(infoLogs[0]?.metadata.budgetExhausted).toBe(true);
      expect(infoLogs[0]?.metadata.jobDurationMs).toBe(LABEL_ONLY_PASS_JOB_BUDGET_MS + 1);
    });

    // TOG-7123 / TOG-3585 (reopen 2026-09-28: the row in flight when the
    // budget trips must SKIP its write — completing it after the deadline is
    // the orphaned-write half of the 11:00Z incident). The unreached rows
    // must keep their watermark (no starvation), and the next firing must
    // resume everything from live state (no dropped work).
    it("skips the in-flight row write, creeps the watermark, and resumes the rest next firing (TOG-7123)", async () => {
      const oldIso = "2026-01-01T00:00:00.000Z";
      const newIso = "2026-01-02T00:00:00.000Z";
      const rowA = idleRow("i1", "in_progress", { updated_at: oldIso });
      const rowB = idleRow("i2", "in_progress", { updated_at: newIso });
      const cards = [
        issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] }),
        issue("i2", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] }),
      ];
      const harness = await boot(baseConfig(), cards);
      harness.ctx.db.query = async () => [rowA, rowB] as never;
      const warnLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalWarn = harness.ctx.logger.warn.bind(harness.ctx.logger);
      harness.ctx.logger.warn = ((message: string, metadata: Record<string, unknown>) => {
        warnLogs.push({ message, metadata });
        return originalWarn(message, metadata);
      }) as typeof harness.ctx.logger.warn;
      // Slow per-card API: each row costs two `issues.get` reads (describe,
      // then advise re-describing). Trip the clock past the deadline while
      // the FIRST row is still being worked: its write must be skipped (no
      // orphaned mutation past the host wall) and the second row never starts.
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      let gets = 0;
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        gets += 1;
        if (gets >= 2) nowMs = LABEL_ONLY_PASS_JOB_BUDGET_MS + 1;
        return current;
      }) as typeof harness.ctx.issues.get;

      try {
        await harness.runJob("labelOnlyPass");
      } finally {
        harness.ctx.issues.get = originalGet;
        nowSpy.mockRestore();
        harness.ctx.logger.warn = originalWarn;
      }

      // The in-flight row's write was skipped instead of committed past the
      // deadline — committing it is the orphaned-write half of the 11:00Z
      // incident — ...
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(warnLogs.some((entry) => String(entry.message).includes("slow row write"))).toBe(true);
      // ... the unreached row was never started ...
      expect((await harness.ctx.issues.get("i2", COMPANY))?.assigneeAdapterOverrides ?? null).toBeNull();
      // ... and the watermark stays below the unsettled row (TOG-11688: the
      // scan cursor stops before the first unsettled row), so the next
      // firing resumes both rows instead of starving them.
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.labelOnlyLastScanAt)).toBeLessThan(Date.parse(oldIso));

      // Resume: a fresh firing with a live clock pins both rows from live state.
      await harness.runJob("labelOnlyPass");
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
      });
      expect((await harness.ctx.issues.get("i2", COMPANY))?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
      });
    });

    // TOG-7123: the cooperative budget must leave headroom beneath the
    // host's 300 s job RPC wall — a budget AT the wall is the incident again.
    it("keeps the cooperative budget a full minute beneath the host 300 s RPC wall (TOG-7123)", () => {
      expect(LABEL_ONLY_PASS_JOB_BUDGET_MS).toBeGreaterThan(0);
      expect(LABEL_ONLY_PASS_JOB_BUDGET_MS).toBeLessThanOrEqual(300_000 - 60_000);
    });

    // TOG-7123 reopen (2026-09-28): the deployed build let TOG-3867 spend
    // ~98 s inside host calls AFTER the host's 300 s wall had fired, because
    // the job budget is only checked BETWEEN rows. Admission headroom: no
    // new row starts without a full LABEL_ONLY_PASS_ROW_TIMEOUT_MS of job
    // budget left, so admission stops with far more than the minute of host
    // headroom — and the row slice itself is well under the 98 s observed
    // slow row.
    it("keeps the per-row admission slice beneath the observed 98 s slow row (TOG-7123)", () => {
      expect(LABEL_ONLY_PASS_ROW_TIMEOUT_MS).toBeGreaterThan(0);
      expect(LABEL_ONLY_PASS_ROW_TIMEOUT_MS).toBeLessThan(98_000);
      expect(LABEL_ONLY_PASS_JOB_BUDGET_MS - LABEL_ONLY_PASS_ROW_TIMEOUT_MS).toBeLessThanOrEqual(
        300_000 - 60_000,
      );
    });

    // TOG-7123 reopen (2026-09-28): a row admitted with budget left can still
    // go slow INSIDE its host calls (the TOG-3867 case). The row must then
    // complete without committing an orphaned routing mutation: no pin, no
    // activity, but the watermark still covers the examined row so next
    // firing re-attempts it from live state.
    it("skips the write (without starving the row) when the admitted row goes slow (TOG-7123)", async () => {
      const oldIso = "2026-01-01T00:00:00.000Z";
      const row = idleRow("i1", "in_progress", { updated_at: oldIso });
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig(), [card]);
      harness.ctx.db.query = async () => [row] as never;
      const warnLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalWarn = harness.ctx.logger.warn.bind(harness.ctx.logger);
      harness.ctx.logger.warn = ((message: string, metadata: Record<string, unknown>) => {
        warnLogs.push({ message, metadata });
        return originalWarn(message, metadata);
      }) as typeof harness.ctx.logger.warn;
      // Slow host calls INSIDE the admitted row: each `issues.get` (describe,
      // then advise re-describing) burns past the per-row slice while job
      // budget still remains.
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        nowMs += LABEL_ONLY_PASS_ROW_TIMEOUT_MS;
        return current;
      }) as typeof harness.ctx.issues.get;

      try {
        await harness.runJob("labelOnlyPass");
      } finally {
        harness.ctx.issues.get = originalGet;
        nowSpy.mockRestore();
        harness.ctx.logger.warn = originalWarn;
      }

      // No orphaned pin and no activity for the slow row ...
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
      expect(warnLogs.some((entry) => String(entry.message).includes("slow row write"))).toBe(true);
      // ... but the watermark stays below the unsettled row, so the next
      // firing with a live clock re-attempts and pins it — no dropped work.
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.labelOnlyLastScanAt)).toBeLessThan(Date.parse(oldIso));

      await harness.runJob("labelOnlyPass");
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
      });
    });

    // TOG-7123 reopen (2026-09-28): admission headroom must stop STARTING
    // rows before the budget is gone — a row admitted with less than a full
    // slice left is the TOG-3867 shape again. With only half a slice of job
    // budget remaining at admission, the row never starts.
    it("stops admitting rows without a full per-row slice of budget left (TOG-7123)", async () => {
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig(), [card]);
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      // The job starts with a live clock; the candidate fetch itself consumes
      // all but half a row-slice of budget — the TOG-3867 shape: budget left,
      // but not a full slice. The row must never start.
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) {
          nowMs = LABEL_ONLY_PASS_JOB_BUDGET_MS - Math.floor(LABEL_ONLY_PASS_ROW_TIMEOUT_MS / 2);
          return [idleRow("i1")];
        }
        return [];
      }) as typeof harness.ctx.db.query;

      try {
        await harness.runJob("labelOnlyPass");
      } finally {
        nowSpy.mockRestore();
        harness.ctx.logger.info = originalInfo;
      }

      const complete = infoLogs.find((entry) => entry.message === "label-only pass complete");
      expect(complete?.metadata.examined).toBe(0);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides ?? null).toBeNull();
    });

    // TOG-11688 HARD RETURN: a row whose host calls outrun the remaining job
    // budget must not hold the job past the host's 300 s wall — the race
    // abandons it at the deadline (not examined, cursor unmoved), the
    // abandoned body that finishes later reaches the write gate and commits
    // nothing, and the next firing pins the row from live state.
    it("abandons a slow row at the deadline without writing, and retries it next firing (TOG-11688)", async () => {
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig(), [card]);
      harness.ctx.db.query = async () => [idleRow("i1", "in_progress", { updated_at: "2026-01-01T00:00:00.000Z" })] as never;
      const warnLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalWarn = harness.ctx.logger.warn.bind(harness.ctx.logger);
      harness.ctx.logger.warn = ((message: string, metadata: Record<string, unknown>) => {
        warnLogs.push({ message, metadata });
        return originalWarn(message, metadata);
      }) as typeof harness.ctx.logger.warn;
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      let updates = 0;
      const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
      harness.ctx.issues.update = (async (...args: Parameters<typeof originalUpdate>) => {
        updates += 1;
        return originalUpdate(...args);
      }) as typeof harness.ctx.issues.update;
      // Only the first read stalls, so the abandoned body runs on to its
      // write gate once the stall clears — the gate, not a hung promise,
      // must be what keeps the write out.
      let stall = true;
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        if (stall) {
          stall = false;
          await stallPastBudget(LABEL_ONLY_PASS_JOB_BUDGET_MS);
        }
        return current;
      }) as typeof harness.ctx.issues.get;

      let resolvedAfterMs: number;
      try {
        resolvedAfterMs = await runJobPastDeadline(harness, "labelOnlyPass", LABEL_ONLY_PASS_JOB_BUDGET_MS);
      } finally {
        harness.ctx.logger.warn = originalWarn;
        harness.ctx.logger.info = originalInfo;
      }

      expect(resolvedAfterMs).toBeLessThanOrEqual(LABEL_ONLY_PASS_JOB_BUDGET_MS);
      expect(warnLogs.some((entry) => String(entry.message).includes("abandoned a slow row"))).toBe(true);
      // The abandoned body reached its write gate after the deadline and the
      // gate refused: no orphaned pin, no activity.
      expect(warnLogs.some((entry) => String(entry.message).includes("slow row write"))).toBe(true);
      expect(updates).toBe(0);
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
      const complete = infoLogs.find((entry) => entry.message === "label-only pass complete");
      expect(complete?.metadata.examined).toBe(0);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.labelOnlyLastScanAt)).toBe(0);

      // Resume: a fresh firing pins the abandoned row from live state.
      await harness.runJob("labelOnlyPass");
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
      });
      expect(updates).toBe(1);
      expect(harness.activity).toHaveLength(1);
    });

    // TOG-11688 ADAPTIVE admission: row 1 burns 40 s (mocked) inside its host
    // calls — tripping its own slice write gate but teaching the pass that
    // rows on THIS board cost 40 s — so row 2 (45 s left < 1.5x40 = 60 s
    // headroom) never starts. The fixed 30 s slice alone, or a 1.0x factor
    // (40 s), WOULD have admitted it.
    it("refuses a new row when the remaining budget cannot cover 1.5x the slowest row (TOG-11688)", async () => {
      const oldIso = "2026-01-01T00:00:00.000Z";
      const newIso = "2026-01-02T00:00:00.000Z";
      const cards = [
        issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] }),
        issue("i2", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] }),
      ];
      const harness = await boot(baseConfig(), cards);
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) {
          nowMs = LABEL_ONLY_PASS_JOB_BUDGET_MS - 85_000;
          return [
            idleRow("i1", "in_progress", { updated_at: oldIso }),
            idleRow("i2", "in_progress", { updated_at: newIso }),
          ];
        }
        return [];
      }) as typeof harness.ctx.db.query;
      let firstGet = true;
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        if (firstGet) {
          firstGet = false;
          nowMs += 40_000;
        }
        return current;
      }) as typeof harness.ctx.issues.get;

      try {
        await harness.runJob("labelOnlyPass");
      } finally {
        harness.ctx.issues.get = originalGet;
        nowSpy.mockRestore();
        harness.ctx.logger.info = originalInfo;
      }

      const complete = infoLogs.find((entry) => entry.message === "label-only pass complete");
      expect(complete?.metadata.examined).toBe(1);
      expect(complete?.metadata.slowestRowMs).toBe(40_000);
      expect(complete?.metadata.skippedSlowRows).toBe(1);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      // Neither card pinned: row 1's write was slow-skipped, row 2 never started.
      for (const id of ["i1", "i2"]) {
        expect((await harness.ctx.issues.get(id, COMPANY))?.assigneeAdapterOverrides ?? null).toBeNull();
      }
      expect(harness.activity).toHaveLength(0);
      // Row 1 is unsettled, so the cursor stops before it.
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.labelOnlyLastScanAt)).toBeLessThan(Date.parse(oldIso));
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

    // TOG-3024. Positive control: before this fix `repinPass` gated on
    // `tierFromLabels(...)` alone, so an unlabelled card was invisible to it
    // even though it carried a live pin — a pin to a now-hard-stopped lane
    // would sit there forever with no label to trigger a repin. Same fixture
    // as the labelled hard-stop test above, minus the tier label.
    it("re-pins an unlabelled but pinned card off a lane hard stop (TOG-3024)", async () => {
      const modelsWithLane = withOpusAlt().map((m) => (m.id === "claude-opus-5" ? { ...m, laneId: "lane-opus" } : m));
      const card = issue("i1", {
        labels: [],
        labelIds: [],
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

    // TOG-6895 (a) clear-on-blocked: a blocked card needs no lane
    // reservation, so the pass clears the pin instead of re-pinning it.
    // The pin is healthy (no lane stop, no demotion) — on the old code the
    // usability `continue` fires and the pin survives.
    it("clears the pin on a blocked card instead of re-pinning it (TOG-6895)", async () => {
      const card = issue("i1", {
        status: "blocked",
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig(), [card]);
      harness.ctx.db.query = async () => [idleRow("i1", "blocked")] as never;

      await harness.runJob("repinPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toBeNull();
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("cleared pin");
      expect(harness.activity[0]?.metadata).toMatchObject({ from: "claude-opus-5", modelId: null, reason: "clear-on-blocked" });
    });

    // TOG-6895 (a): clearing is a lifecycle behavior, not an operator
    // override — a blocked card carrying pin:operator keeps its pin.
    it("keeps a blocked operator pin untouched (TOG-6895)", async () => {
      const card = issue("i1", {
        status: "blocked",
        labels: [tierLabel("T1"), operatorPinLabel()],
        labelIds: ["lbl-T1", "lbl-op"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig(), [card]);
      harness.ctx.db.query = async () => [idleRow("i1", "blocked")] as never;

      await harness.runJob("repinPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(0);
    });

    // TOG-6895 (b) 24h expiry, both directions. The alt is strictly
    // cheaper, so a re-validation that runs MUST move the pin while a
    // skipped one leaves it alone — the pair pins the `!pinExpired`
    // guard from both sides. No lane stop, no demotion: usability alone
    // would keep the pin in both cases.
    it("re-validates an expired pin through advise even when the lane is healthy (TOG-6895)", async () => {
      const cheapAlt = withOpusAlt({ costPerMTokIn: 1, costPerMTokOut: 5, costPerMTokCacheRead: 0.1 });
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: cheapAlt }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.pinPinnedAt },
        { i1: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() },
      );

      await harness.runJob("repinPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("re-validated");
    });

    // TOG-6895 (b): missing entry = expired. A pin whose age cannot be
    // proven is re-validated, never kept on trust — fail-safe toward
    // re-validation. Kills the mutant that treats a missing entry as fresh.
    it("treats a pin with no timestamp as expired (TOG-6895)", async () => {
      const cheapAlt = withOpusAlt({ costPerMTokIn: 1, costPerMTokOut: 5, costPerMTokCacheRead: 0.1 });
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: cheapAlt }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("repinPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("re-validated");
    });

    it("leaves a fresh healthy pin alone without paying for re-validation (TOG-6895)", async () => {
      const cheapAlt = withOpusAlt({ costPerMTokIn: 1, costPerMTokOut: 5, costPerMTokCacheRead: 0.1 });
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: cheapAlt }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.pinPinnedAt },
        { i1: new Date(NOW - 60 * 60 * 1000).toISOString() },
      );

      await harness.runJob("repinPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(0);
    });

    // TOG-6895 (b): an expired pin the fresh advise re-affirms is still
    // alive — re-stamped so the next pass does not pay for the same
    // re-validation again. The stamp is the observable proof advise ran:
    // the skip path never writes it.
    it("re-stamps an expired pin that advise re-affirms (TOG-6895)", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: withOpusAlt() }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.pinPinnedAt },
        { i1: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() },
      );

      await harness.runJob("repinPass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(0);
      const stamped = (await harness.ctx.state.get({
        scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.pinPinnedAt,
      })) as Record<string, string>;
      expect(stamped.i1).toBe(new Date(NOW).toISOString());
    });

    // TOG-6895: clear and repin writes share the single write budget —
    // clears are not a side channel around REPIN_PASS_WRITE_LIMIT.
    it("counts clears against REPIN_PASS_WRITE_LIMIT (TOG-6895)", async () => {
      const cards = Array.from({ length: 8 }, (_, i) =>
        issue(`i${i}`, {
          status: "blocked",
          labels: [tierLabel("T1")],
          labelIds: ["lbl-T1"],
          assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
        }),
      );
      const harness = await boot(baseConfig(), cards);
      harness.ctx.db.query = async () => cards.map((c) => idleRow(c.id, "blocked")) as never;

      await harness.runJob("repinPass");

      let cleared = 0;
      for (const c of cards) {
        const after = await harness.ctx.issues.get(c.id, COMPANY);
        if (after?.assigneeAdapterOverrides === null) cleared += 1;
      }
      expect(cleared).toBe(6);
    });

    // TOG-11688: this pass had NO job budget — it walked up to 400 fetched
    // rows bounded only by the 6-write cap, and failed 2/24 firings at 301 s
    // over the last 4 h. The cooperative budget must sit well beneath the
    // host's 300 s job RPC wall.
    it("keeps the cooperative budget well beneath the host 300 s RPC wall (TOG-11688)", () => {
      expect(REPIN_PASS_JOB_BUDGET_MS).toBeGreaterThan(0);
      expect(REPIN_PASS_JOB_BUDGET_MS).toBeLessThanOrEqual(300_000 - 60_000);
    });

    // TOG-11688: the admission slice must stay beneath the observed slow row
    // (40-95 s in contended host RPC across the row-walking passes), with the
    // same headroom shape as the label-only pass.
    it("keeps the per-row admission slice beneath the observed slow row (TOG-11688)", () => {
      expect(REPIN_PASS_ROW_TIMEOUT_MS).toBeGreaterThan(0);
      expect(REPIN_PASS_ROW_TIMEOUT_MS).toBeLessThan(98_000);
      expect(REPIN_PASS_JOB_BUDGET_MS - REPIN_PASS_ROW_TIMEOUT_MS).toBeLessThanOrEqual(
        300_000 - 60_000,
      );
    });

    // TOG-11688 ADMISSION: with only half a row-slice of job budget left when
    // the candidate fetch returns, the row never starts — same TOG-3867 shape
    // as the label-only admission test.
    it("stops admitting rows without a full per-row slice of budget left (TOG-11688)", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig(), [card]);
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) {
          nowMs = REPIN_PASS_JOB_BUDGET_MS - Math.floor(REPIN_PASS_ROW_TIMEOUT_MS / 2);
          return [idleRow("i1")];
        }
        return [];
      }) as typeof harness.ctx.db.query;

      try {
        await harness.runJob("repinPass");
      } finally {
        nowSpy.mockRestore();
        harness.ctx.logger.info = originalInfo;
      }

      const complete = infoLogs.find((entry) => entry.message === "repin pass complete");
      expect(complete?.metadata.examined).toBe(0);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
    });

    // TOG-11688 ADAPTIVE admission: the fixed slice alone admits a row with
    // 45 s of budget left that then costs the observed 95 s. Row 1 burns 40 s
    // (mocked) inside its host calls — tripping its own slice write-gate but
    // teaching the pass that rows on THIS board cost 40 s — so row 2 (45 s
    // left < 1.5x40 = 60 s headroom) never starts. examined stays 1: the
    // fixed 30 s check alone WOULD have admitted it.
    it("refuses a new row when the remaining budget cannot cover 1.5x the slowest row (TOG-11688)", async () => {
      const oldIso = "2026-01-01T00:00:00.000Z";
      const newIso = "2026-01-02T00:00:00.000Z";
      const cards = [
        issue("i1", {
          labels: [tierLabel("T1")],
          labelIds: ["lbl-T1"],
          assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
        }),
        issue("i2", {
          labels: [tierLabel("T1")],
          labelIds: ["lbl-T1"],
          assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
        }),
      ];
      const harness = await boot(baseConfig({ models: withOpusAlt() }), cards);
      await demoteOpus(harness);
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) {
          nowMs = REPIN_PASS_JOB_BUDGET_MS - 85_000;
          return [
            idleRow("i1", "in_progress", { updated_at: oldIso }),
            idleRow("i2", "in_progress", { updated_at: newIso }),
          ];
        }
        return [];
      }) as typeof harness.ctx.db.query;
      let firstGet = true;
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        if (firstGet) {
          firstGet = false;
          nowMs += 40_000;
        }
        return current;
      }) as typeof harness.ctx.issues.get;

      try {
        await harness.runJob("repinPass");
      } finally {
        harness.ctx.issues.get = originalGet;
        nowSpy.mockRestore();
        harness.ctx.logger.info = originalInfo;
      }

      const complete = infoLogs.find((entry) => entry.message === "repin pass complete");
      expect(complete?.metadata.examined).toBe(1);
      expect(complete?.metadata.slowestRowMs).toBe(40_000);
      expect(complete?.metadata.skippedSlowRows).toBe(1);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      // Neither pin moved: row 1's write was slow-skipped, row 2 never started.
      for (const id of ["i1", "i2"]) {
        expect((await harness.ctx.issues.get(id, COMPANY))?.assigneeAdapterOverrides).toEqual({
          adapterConfig: { model: "claude-opus-5" },
        });
      }
      expect(harness.activity).toHaveLength(0);
      // Row 1 is unsettled (seen, write refused), so the cursor stops before
      // it: next firing re-reads and re-attempts it instead of starving it.
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.repinLastScanAt)).toBeLessThan(Date.parse(oldIso));
    });

    // TOG-11688 HARD RETURN: a row whose advise outruns the remaining job
    // budget must not hold the job past the host's 300 s wall — the race
    // abandons it at the deadline (not examined, cursor unmoved), the
    // abandoned body that finishes later commits nothing, and the next
    // firing retries the row from live state.
    it("abandons a slow advise at the deadline without writing, and retries it next firing (TOG-11688)", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: withOpusAlt() }), [card]);
      await demoteOpus(harness);
      harness.ctx.db.query = async () => [idleRow("i1", "in_progress", { updated_at: "2026-01-01T00:00:00.000Z" })] as never;
      const warnLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalWarn = harness.ctx.logger.warn.bind(harness.ctx.logger);
      harness.ctx.logger.warn = ((message: string, metadata: Record<string, unknown>) => {
        warnLogs.push({ message, metadata });
        return originalWarn(message, metadata);
      }) as typeof harness.ctx.logger.warn;
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      let updates = 0;
      const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
      harness.ctx.issues.update = (async (...args: Parameters<typeof originalUpdate>) => {
        updates += 1;
        return originalUpdate(...args);
      }) as typeof harness.ctx.issues.update;
      let stall = true;
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        if (stall) await stallPastBudget(REPIN_PASS_JOB_BUDGET_MS);
        return current;
      }) as typeof harness.ctx.issues.get;

      let resolvedAfterMs: number;
      try {
        resolvedAfterMs = await runJobPastDeadline(harness, "repinPass", REPIN_PASS_JOB_BUDGET_MS);
      } finally {
        stall = false;
        harness.ctx.logger.warn = originalWarn;
        harness.ctx.logger.info = originalInfo;
      }

      expect(resolvedAfterMs).toBeLessThanOrEqual(REPIN_PASS_JOB_BUDGET_MS);
      // The abandoned body ran on past the deadline to completion and still
      // committed nothing — the orphaned-write half of the incident.
      expect(updates).toBe(0);
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5" },
      });
      expect(harness.activity).toHaveLength(0);
      expect(warnLogs.some((entry) => String(entry.message).includes("abandoned a slow row"))).toBe(true);
      const complete = infoLogs.find((entry) => entry.message === "repin pass complete");
      expect(complete?.metadata.examined).toBe(0);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.repinLastScanAt)).toBe(0);

      // Resume: a fresh firing repins the abandoned row from live state.
      await harness.runJob("repinPass");
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(updates).toBe(1);
      expect(harness.activity).toHaveLength(1);
    });

    // TOG-11688 WRITE GATE: a row admitted with budget left can still go slow
    // INSIDE its host calls. It must then complete without committing an
    // orphaned mutation — no pin, no activity — while the watermark still
    // covers it, so next firing re-attempts it from live state.
    it("skips the write (without starving the row) when the admitted row goes slow (TOG-11688)", async () => {
      const oldIso = "2026-01-01T00:00:00.000Z";
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: withOpusAlt() }), [card]);
      await demoteOpus(harness);
      harness.ctx.db.query = async () => [idleRow("i1", "in_progress", { updated_at: oldIso })] as never;
      const warnLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalWarn = harness.ctx.logger.warn.bind(harness.ctx.logger);
      harness.ctx.logger.warn = ((message: string, metadata: Record<string, unknown>) => {
        warnLogs.push({ message, metadata });
        return originalWarn(message, metadata);
      }) as typeof harness.ctx.logger.warn;
      // Slow host calls INSIDE the admitted row: each `issues.get` burns a
      // full row slice while job budget still remains.
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        nowMs += REPIN_PASS_ROW_TIMEOUT_MS;
        return current;
      }) as typeof harness.ctx.issues.get;

      try {
        await harness.runJob("repinPass");
      } finally {
        harness.ctx.issues.get = originalGet;
        nowSpy.mockRestore();
        harness.ctx.logger.warn = originalWarn;
      }

      // No orphaned pin and no activity for the slow row ...
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5" },
      });
      expect(harness.activity).toHaveLength(0);
      expect(warnLogs.some((entry) => String(entry.message).includes("slow row write"))).toBe(true);
      // ... and the cursor stops before the unsettled row, so the next firing
      // with a live clock re-attempts and repins it — no dropped work.
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.repinLastScanAt)).toBeLessThan(Date.parse(oldIso));

      await harness.runJob("repinPass");
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
    });

    // TOG-11688: the reactive `agent.run.failed` sweep carries NO job budget —
    // a lane rejection must sweep the full candidate set immediately. Even
    // with a fresh watermark that would make the scheduled job skip entirely,
    // the repin still lands end to end.
    it("sweeps and repins with no job budget on the reactive path, watermark aside (TOG-11688)", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      // The rejection names claude-opus-5, so it needs a lane for the handler
      // to quarantine — without one there is no verdict and no sweep (a model
      // with no lane cannot be quarantined). The alt stays lane-free, so the
      // sweep has somewhere healthy to land.
      const modelsWithLane = withOpusAlt().map((m) => (m.id === "claude-opus-5" ? { ...m, laneId: "lane-opus" } : m));
      const harness = await boot(baseConfig({ models: modelsWithLane }), [card]);
      await demoteOpus(harness);
      // A watermark set to "now" makes the SCHEDULED job skip entirely (see
      // "repinPass skips on its watermark..."). The reactive path ignores it.
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.repinLastScanAt } as never,
        { at: new Date().toISOString() },
      );
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.emit(
        "agent.run.failed",
        { issueId: "i1", error: "All credentials for model claude-opus-5 are cooling down" },
        { companyId: COMPANY },
      );

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      // Two entries: the lane-quarantine record plus the re-pin itself — the
      // re-pin is the proof the unbounded sweep ran end to end.
      expect(harness.activity.some((entry) => String(entry?.message).includes("re-pinned"))).toBe(true);
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
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
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

    // TOG-3024 scope decision: `balancePass`'s unpinned+labelled branch force-
    // pins to T1 unconditionally (see the rule above this describe block).
    // Extending that same force-T1 promotion to a bare unpinned+unlabelled
    // card would be a policy change well beyond the incident this fix targets
    // — it would push every previously-invisible idle card onto the most
    // expensive tier. So this specific sub-case (no pin AND no label) keeps
    // the pre-fix skip; `labelOnlyPass` (above) is what makes a truly
    // invisible unlabelled card visible again.
    it("skips an unpinned card with no tier label", async () => {
      const card = issue("i1", { labels: [], labelIds: [], assigneeAdapterOverrides: null });
      const harness = await boot(baseConfig(), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
    });

    /**
     * TOG-3116, remediation half. The 2026-09-17 board sweep found 149 of 175
     * overridden open cards with a HEALTHY pin and sub-call env still frozen on
     * the exhausted Codex lane — and only 3 with a dead pin. Every other
     * balance-pass write reason reads off the pin, and the pass short-circuits
     * on `decision.modelId === pinnedModelId` before it reaches them, so
     * without `envDrifted` this whole population is unreachable and the
     * evacuation fix is inert for the entire already-frozen board.
     *
     * The write here is NOT a repin: `model` comes out unchanged, so no warm
     * session is reset — which is what makes draining these cards safe.
     */
    it("rewrites a healthy-pinned card whose sub-call env is frozen on a dead lane", async () => {
      // A Codex-lane T2 row for the frozen env to point at. Cloned off the
      // sonnet entry so it is a structurally complete ModelEntry.
      const sonnet = MODELS.find((m) => m.id === "claude-sonnet-5")!;
      const modelsWithDeadLane = [...MODELS, { ...sonnet, id: "gpt-5.6-sol", laneId: "cliproxy-codex" }];
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: {
          adapterConfig: {
            model: "claude-opus-5",
            env: {
              ...subCallPins("gpt-5.6-sol", "gpt-5.6-sol"),
              ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretKey: "ANTHROPIC_AUTH_TOKEN" },
            },
          },
        },
      });
      // TOG-3235: the agent itself binds ANTHROPIC_AUTH_TOKEN, so the
      // known-env rebuild carries it and it survives byte-for-byte. A
      // secret living ONLY on the pin snapshot would be dropped instead.
      const harness = await boot(
        baseConfig({ models: modelsWithDeadLane, pacing: { mode: "enforce" } }),
        [card],
        [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001", env: { ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretKey: "ANTHROPIC_AUTH_TOKEN" } } } })],
      );
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
        {
          "cliproxy-codex": {
            laneId: "cliproxy-codex",
            fetchedAt: "2026-09-16T16:40:00.000Z",
            observation: null,
            error: null,
            verdict: {
              laneId: "cliproxy-codex",
              observedAt: "2026-09-16T16:40:00.000Z",
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

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      const cfg = (after?.assigneeAdapterOverrides as { adapterConfig: { model: string; env: Record<string, unknown> } })
        .adapterConfig;
      // The pin is untouched — this is an env evacuation, not a repin.
      expect(cfg.model).toBe("claude-opus-5");
      // Not one model-valued key may still name the exhausted lane's model.
      expect(JSON.stringify(cfg.env)).not.toContain("gpt-5.6-sol");
      // The secret binding survives the wholesale-replace write byte-for-byte.
      expect(cfg.env.ANTHROPIC_AUTH_TOKEN).toEqual({ type: "secret_ref", secretKey: "ANTHROPIC_AUTH_TOKEN" });
      expect(harness.activity[0]?.metadata?.envDrifted).toBe(true);
    });

    // TOG-5227: same user-assigned skip as labelOnlyPass — a card with
    // assignee_user_id rejects issues.update with an agent override, so the
    // pass must skip it on the describe row, not attempt the write.
    it("skips a user-assigned card even if it would otherwise balance (TOG-5227)", async () => {
      const card = issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAdapterOverrides: null,
        assigneeUserId: "user-1",
      });
      const harness = await boot(baseConfig(), [card], [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
    });

    it("leaves a healthy-pinned card with already-healthy sub-call env alone (no churn)", async () => {
      // Guards the predicate against firing on every pass: the drain must stop
      // once the board is clean, or it becomes an infinite write loop.
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: {
          adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
        },
      });
      const harness = await boot(baseConfig({ pacing: { mode: "enforce" } }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("balancePass");

      expect(harness.activity).toHaveLength(0);
    });

    // TOG-5227: a pin rejection on one card must not abort the balance pass
    // for the whole company. i1's write throws the exact live error; i2 must
    // still re-pin.
    it("isolates a per-issue pin failure so the rest of the pass completes (TOG-5227)", async () => {
      const cheapModels = withOpusAlt().map((m) =>
        m.id === "claude-opus-5" ? { ...m, costPerMTokIn: 100, costPerMTokOut: 500 } : m,
      );
      const cards = ["i1", "i2"].map((id) =>
        issue(id, {
          labels: [tierLabel("T3")],
          labelIds: ["lbl-T3"],
          assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
        }),
      );
      const harness = await boot(baseConfig({ models: cheapModels }), cards);
      harness.ctx.db.query = async () => cards.map((c) => idleRow(c.id)) as never;
      const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
      harness.ctx.issues.update = (async (...args: Parameters<typeof originalUpdate>) => {
        if (args[0] === "i1") throw new Error("Issue can only have one assignee");
        return originalUpdate(...args);
      }) as typeof harness.ctx.issues.update;

      await harness.runJob("balancePass");

      const afterBad = await harness.ctx.issues.get("i1", COMPANY);
      expect(afterBad?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      const afterGood = await harness.ctx.issues.get("i2", COMPANY);
      expect(afterGood?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
      const warns = (harness.logs as Array<{ level: string; message: string }>).filter((entry) =>
        entry.message.includes("balance pass skipped a card it could not pin"),
      );
      expect(warns).toHaveLength(1);
    });

    // TOG-5227: the unpinned+labelled branch has its own pin write site — a
    // rejection there must be isolated too, not abort the pass. Both cards
    // are unpinned T3-labelled (force-T1 branch); i1's write throws.
    it("isolates a per-issue pin failure in the unpinned branch (TOG-5227)", async () => {
      const cards = ["i1", "i2"].map((id) =>
        issue(id, {
          labels: [tierLabel("T3")],
          labelIds: ["lbl-T3"],
          assigneeAdapterOverrides: null,
        }),
      );
      const harness = await boot(baseConfig(), cards, [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      harness.ctx.db.query = async () => cards.map((c) => idleRow(c.id)) as never;
      const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
      harness.ctx.issues.update = (async (...args: Parameters<typeof originalUpdate>) => {
        if (args[0] === "i1") throw new Error("Issue can only have one assignee");
        return originalUpdate(...args);
      }) as typeof harness.ctx.issues.update;

      await harness.runJob("balancePass");

      const afterBad = await harness.ctx.issues.get("i1", COMPANY);
      expect(afterBad?.assigneeAdapterOverrides ?? null).toBeNull();
      const afterGood = await harness.ctx.issues.get("i2", COMPANY);
      expect(afterGood?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
      });
      expect(harness.activity).toHaveLength(1);
      const warns = (harness.logs as Array<{ level: string; message: string }>).filter((entry) =>
        entry.message.includes("balance pass skipped a card it could not pin"),
      );
      expect(warns).toHaveLength(1);
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
      // See the labelOnlyPass twin: TOG-3116 added the six sub-call env keys to
      // every write, so whole-object equality no longer describes the shape.
      // The claim under test is that a pin is WRITTEN rather than elided.
      const balanceCfg = (
        after?.assigneeAdapterOverrides as { adapterConfig: { model: string; env?: Record<string, unknown> } }
      ).adapterConfig;
      expect(balanceCfg.model).toBe("claude-opus-5");
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("floor lane unserviceable");
    });

    // TOG-3024. Positive control for the OTHER balancePass sub-case: a card
    // that already carries a pin but no label. Before this fix the pass
    // gated on `tierFromLabels(...)` alone, so this card was invisible to
    // cost-down rebalancing even though it has a real pin to evaluate.
    it("re-pins a pinned-but-unlabelled card onto a cheaper candidate (TOG-3024)", async () => {
      const cheapModels = withOpusAlt().map((m) =>
        m.id === "claude-opus-5" ? { ...m, costPerMTokIn: 100, costPerMTokOut: 500 } : m,
      );
      const card = issue("i1", {
        labels: [],
        labelIds: [],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: cheapModels }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).not.toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity[0]?.metadata?.cheaper).toBe(true);
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

    // TOG-3132. The cost-down rule above is exactly the 2026-09-17T08:10:14Z
    // move: `claude-haiku-4-5-20251001` (12/12) -> `deepseek-v4-flash` (0/3),
    // reason `cost-down`. `selectModel`'s own cost-down guard CANNOT stop it
    // here: this pass calls `advise(..., suppressSticky = true)`, so the
    // incumbent pin never reaches the engine as `stickyModelId` and the engine
    // reads the incumbent lane as unproven. This guard, in the pass that does
    // the writing, is the only thing between a proven lane and an unproven one.
    const evidenceRows = (rows: Array<Record<string, unknown>>) => async (sql: string) =>
      (sql.includes("as failed") ? rows : [idleRow("i1")]) as never;
    const twoLaneCostDown = () =>
      withOpusAlt({ costPerMTokIn: 1, costPerMTokOut: 5, laneId: "lane-thin" }).map((m) =>
        m.id === "claude-opus-5"
          ? { ...m, costPerMTokIn: 100, costPerMTokOut: 500, laneId: "lane-proven" }
          : m,
      );
    const pinnedToOpus = () =>
      issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });

    it("refuses a cost-down re-pin that leaves a proven-good lane for an unproven one", async () => {
      const harness = await boot(baseConfig({ models: twoLaneCostDown() }), [pinnedToOpus()]);
      harness.ctx.db.query = evidenceRows([
        { model: "claude-opus-5", succeeded: 34, failed: 8 },
        // 0/4, not 0/5: one observation short of the zero-success rule, so the
        // destination is genuinely UNPROVEN and it is the cost-down guard —
        // not the dead-lane exclusion — that has to refuse this move.
        { model: "claude-opus-5-alt", succeeded: 0, failed: 4 },
      ]);

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity[0]?.metadata?.reason).toBe("lane-evidence");
      expect(harness.activity[0]?.message).toContain("cost-down to claude-opus-5-alt refused");
    });

    it("refuses the same re-pin outright once the destination reaches 0/5", async () => {
      // One more failure on the destination and the protection changes hands:
      // the zero-success rule drops the lane from the candidate set, so the
      // cost-down guard is never consulted. The card must still not move.
      const harness = await boot(baseConfig({ models: twoLaneCostDown() }), [pinnedToOpus()]);
      harness.ctx.db.query = evidenceRows([
        { model: "claude-opus-5", succeeded: 34, failed: 8 },
        { model: "claude-opus-5-alt", succeeded: 0, failed: 5 },
      ]);

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
    });

    it("allows the same cost-down re-pin once the destination lane is proven", async () => {
      // The control that keeps the guard from being a blanket freeze on
      // cost-down: identical config and card, the destination's counts alone
      // changed from 0/5 to 34/8.
      const harness = await boot(baseConfig({ models: twoLaneCostDown() }), [pinnedToOpus()]);
      harness.ctx.db.query = evidenceRows([
        { model: "claude-opus-5", succeeded: 34, failed: 8 },
        { model: "claude-opus-5-alt", succeeded: 34, failed: 8 },
      ]);

      await harness.runJob("balancePass");

      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5-alt", env: subCallPins("claude-opus-5-alt", "claude-haiku-4-5-20251001") },
      });
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

    // TOG-12258 pace-pull: `orderCandidatesByPace` ranks only NEW pins, so a
    // pin that landed before its lane fell behind never moves until
    // PIN_MAX_AGE_MS expiry. The balance pass pulls such idle pins toward a
    // behind-pace lane — enforce mode only, strictly-better rank only, room
    // (including caps) required, recorded as `pace-pull`.
    describe("pace-pull (TOG-12258)", () => {
      const haiku = MODELS.find((m) => m.id === "claude-haiku-4-5-20251001")!;
      // Two same-price T3 candidates on different lanes: cost never decides
      // between them, so the winner is whoever pace (or the cost tie-break)
      // prefers. Equal prices also keep `cheaper` false, isolating pace-pull
      // from the cost-down gate; utilizations within 0.25 keep `busier` false.
      const paceModels = () => [
        { ...haiku, id: "haiku-on", laneId: "lane-on" },
        { ...haiku, id: "haiku-behind", laneId: "lane-behind" },
        ...MODELS.filter((m) => m.id !== haiku.id),
      ];
      const laneVerdict = (laneId: string, state: string, utilization: number, deviation: number) => ({
        [laneId]: {
          laneId,
          fetchedAt: "2026-09-13T00:00:00.000Z",
          observation: null,
          error: null,
          verdict: {
            laneId,
            observedAt: "2026-09-13T00:00:00.000Z",
            state,
            serviceable: true,
            score: { utilization, elapsed: 0.5, deviation },
            accounts: [],
            knownAccountCount: 1,
            knownWeight: 1,
            serviceableAccountCount: 1,
            urgentResetAt: null,
            reason: "ok",
          },
        },
      });
      const behindLedger = () => ({
        ...laneVerdict("lane-on", "on", 0.5, 0),
        ...laneVerdict("lane-behind", "behind", 0.4, -0.1),
      });
      const pinnedCard = (id: string, pin: string) =>
        issue(id, {
          labels: [tierLabel("T3")],
          labelIds: ["lbl-T3"],
          assigneeAdapterOverrides: { adapterConfig: { model: pin } },
        });
      const seedLedger = async (
        harness: Awaited<ReturnType<typeof boot>>,
        ledger: Record<string, unknown>,
      ) => {
        await harness.ctx.state.set(
          { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
          ledger,
        );
      };
      // The candidate fetch, the active-pins weight read (`as pinned_model`),
      // and the pass-start aggregate each need their own shape: a blanket
      // mock would report candidate rows as pins weight.
      const queryFor = (candidateIds: string[], weightRows: Array<Record<string, unknown>> = []) =>
        async (sql: string): Promise<Record<string, unknown>[]> => {
          if (sql.includes("as pinned_model")) return weightRows;
          if (sql.includes("from issues i")) return candidateIds.map((id) => idleRow(id) as Record<string, unknown>);
          return [];
        };

      it("pulls an idle pin off an on-pace lane toward a behind-pace lane", async () => {
        const harness = await boot(baseConfig({ models: paceModels(), pacing: { mode: "enforce" } }), [
          pinnedCard("i1", "haiku-on"),
        ]);
        harness.ctx.db.query = queryFor(["i1"]) as never;
        await seedLedger(harness, behindLedger());

        await harness.runJob("balancePass");

        const after = await harness.ctx.issues.get("i1", COMPANY);
        expect(
          (after?.assigneeAdapterOverrides as { adapterConfig: { model: string } }).adapterConfig.model,
        ).toBe("haiku-behind");
        expect(harness.activity).toHaveLength(1);
        expect(harness.activity[0]?.message).toContain("pace-pull");
        expect(harness.activity[0]?.metadata?.pacePull).toBe(true);
      });

      it("does not pull when the behind lane is at its cap", async () => {
        // One 0.5-weight flash pin on the target lane with cap 1: `advise()`
        // still admits the lane (0.5 < 1), so only the pace-pull free-slot
        // cap (floor(1 - 0.5) = 0) can refuse this move. The flash model is
        // roster-disabled so it counts toward lane weight without ever being
        // a repin candidate itself.
        const flash = { ...haiku, id: "flash-behind", laneId: "lane-behind", enabled: false, costPerMTokIn: 0.1, costPerMTokOut: 0.1 };
        const harness = await boot(
          baseConfig({
            models: [...paceModels(), flash],
            pacing: { mode: "enforce", laneCapPerAccount: { "lane-behind": 1 } },
          }),
          [pinnedCard("i1", "haiku-on")],
        );
        harness.ctx.db.query = queryFor(["i1"], [{ pinned_model: "flash-behind" }]) as never;
        await seedLedger(harness, behindLedger());

        await harness.runJob("balancePass");

        const after = await harness.ctx.issues.get("i1", COMPANY);
        expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "haiku-on" } });
        expect(harness.activity).toHaveLength(0);
      });

      it("does not pull in shadow mode", async () => {
        const harness = await boot(baseConfig({ models: paceModels(), pacing: { mode: "shadow" } }), [
          pinnedCard("i1", "haiku-on"),
        ]);
        harness.ctx.db.query = queryFor(["i1"]) as never;
        await seedLedger(harness, behindLedger());

        await harness.runJob("balancePass");

        const after = await harness.ctx.issues.get("i1", COMPANY);
        expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "haiku-on" } });
        expect(harness.activity).toHaveLength(0);
      });

      it("does not pull when the decision is advisory (selection mode advise)", async () => {
        const harness = await boot(
          baseConfig({
            models: paceModels(),
            pacing: { mode: "enforce" },
            selection: { enabled: true, mode: "advise", holdOnUntrustedProfile: true },
          }),
          [pinnedCard("i1", "haiku-on")],
        );
        harness.ctx.db.query = queryFor(["i1"]) as never;
        await seedLedger(harness, behindLedger());

        await harness.runJob("balancePass");

        const after = await harness.ctx.issues.get("i1", COMPANY);
        expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "haiku-on" } });
        expect(harness.activity).toHaveLength(0);
      });

      // Mutation control for the rank comparison: both lanes are behind, and
      // pace prefers the MORE-behind target (deviation tie-break), so `advise()`
      // offers it — but the ranks are equal, not strictly better, so the pull
      // must NOT fire. Removing the comparison moves the card and fails this.
      it("does not pull sideways between equally-behind lanes", async () => {
        const twoBehindModels = () => [
          { ...haiku, id: "haiku-behind-a", laneId: "lane-behind-a" },
          { ...haiku, id: "haiku-behind-b", laneId: "lane-behind-b" },
          ...MODELS.filter((m) => m.id !== haiku.id),
        ];
        const harness = await boot(baseConfig({ models: twoBehindModels(), pacing: { mode: "enforce" } }), [
          pinnedCard("i1", "haiku-behind-a"),
        ]);
        harness.ctx.db.query = queryFor(["i1"]) as never;
        await seedLedger(harness, {
          ...laneVerdict("lane-behind-a", "behind", 0.4, -0.1),
          ...laneVerdict("lane-behind-b", "behind", 0.2, -0.3),
        });

        await harness.runJob("balancePass");

        const after = await harness.ctx.issues.get("i1", COMPANY);
        expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "haiku-behind-a" } });
        expect(harness.activity).toHaveLength(0);
      });

      // Mutation control for the behind gate: the pin sits on an `ahead` lane
      // and pace prefers the merely-`on` lane, but the target is not behind,
      // so no pull. Removing `isBehindPace` moves the card and fails this.
      it("does not pull toward a lane that is not behind", async () => {
        const aheadModels = () => [
          { ...haiku, id: "haiku-ahead", laneId: "lane-ahead" },
          { ...haiku, id: "haiku-on", laneId: "lane-on" },
          ...MODELS.filter((m) => m.id !== haiku.id),
        ];
        const harness = await boot(baseConfig({ models: aheadModels(), pacing: { mode: "enforce" } }), [
          pinnedCard("i1", "haiku-ahead"),
        ]);
        harness.ctx.db.query = queryFor(["i1"]) as never;
        await seedLedger(harness, {
          ...laneVerdict("lane-ahead", "ahead", 0.6, 0.1),
          ...laneVerdict("lane-on", "on", 0.5, 0),
        });

        await harness.runJob("balancePass");

        const after = await harness.ctx.issues.get("i1", COMPANY);
        expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "haiku-ahead" } });
        expect(harness.activity).toHaveLength(0);
      });

      it("caps pace-pull moves per pass at the target lane's free slots", async () => {
        // Cap 1, no existing weight: the first card takes the only free slot;
        // the second card's pull is refused by the in-pass move count.
        const cards = [pinnedCard("i1", "haiku-on"), pinnedCard("i2", "haiku-on")];
        const harness = await boot(
          baseConfig({
            models: paceModels(),
            pacing: { mode: "enforce", laneCapPerAccount: { "lane-behind": 1 } },
          }),
          cards,
        );
        harness.ctx.db.query = queryFor(["i1", "i2"]) as never;
        await seedLedger(harness, behindLedger());

        await harness.runJob("balancePass");

        let moved = 0;
        for (const card of cards) {
          const after = await harness.ctx.issues.get(card.id, COMPANY);
          if (
            (after?.assigneeAdapterOverrides as { adapterConfig: { model: string } } | null)?.adapterConfig
              .model === "haiku-behind"
          ) {
            moved += 1;
          }
        }
        expect(moved).toBe(1);
        expect(harness.activity).toHaveLength(1);
        expect(harness.activity[0]?.metadata?.pacePull).toBe(true);
      });
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

    // TOG-7123 reopen (2026-09-28): same slow-admitted-row defect as the
    // label-only pass — balance also failed at 300004 ms on 2026-09-28 11:00Z
    // because the job budget is only checked BETWEEN rows. Admission
    // headroom: no new row starts without a full
    // BALANCE_PASS_ROW_TIMEOUT_MS of job budget left — and the row slice
    // itself is well under the 98 s observed slow row (TOG-3867).
    it("keeps the per-row admission slice beneath the observed 98 s slow row (TOG-7123)", () => {
      expect(BALANCE_PASS_ROW_TIMEOUT_MS).toBeGreaterThan(0);
      expect(BALANCE_PASS_ROW_TIMEOUT_MS).toBeLessThan(98_000);
      expect(BALANCE_PASS_JOB_BUDGET_MS - BALANCE_PASS_ROW_TIMEOUT_MS).toBeLessThanOrEqual(
        300_000 - 60_000,
      );
    });

    // TOG-7123 reopen (2026-09-28): a row admitted with budget left can still
    // go slow INSIDE its host calls (the TOG-3867 case). The row must then
    // complete without committing an orphaned routing mutation: no pin, no
    // activity — but the keyset cursor still advances past it, so the next
    // firing does NOT hot-loop on the slow row; its live state is re-read
    // when the cycle wraps.
    it("skips the write (keeping the cursor) when the admitted row goes slow (TOG-7123)", async () => {
      const card = issue("i1", { labels: [tierLabel("T3")], labelIds: ["lbl-T3"] });
      const harness = await boot(baseConfig(), [card], [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      const warnLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalWarn = harness.ctx.logger.warn.bind(harness.ctx.logger);
      harness.ctx.logger.warn = ((message: string, metadata: Record<string, unknown>) => {
        warnLogs.push({ message, metadata });
        return originalWarn(message, metadata);
      }) as typeof harness.ctx.logger.warn;
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      // Slow host calls INSIDE the admitted row: each `issues.get` (describe,
      // advise re-describing, the write-safety re-read) burns past the
      // per-row slice while job budget still remains.
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        nowMs += BALANCE_PASS_ROW_TIMEOUT_MS;
        return current;
      }) as typeof harness.ctx.issues.get;

      try {
        await harness.runJob("balancePass");
      } finally {
        harness.ctx.issues.get = originalGet;
        nowSpy.mockRestore();
        harness.ctx.logger.warn = originalWarn;
        harness.ctx.logger.info = originalInfo;
      }

      // No orphaned pin and no activity for the slow row ...
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(harness.activity).toHaveLength(0);
      expect(warnLogs.some((entry) => String(entry.message).includes("slow row write"))).toBe(true);
      expect(infoLogs.some((entry) => entry.metadata.skippedSlowRows === 1)).toBe(true);
      // ... but the cursor advanced past it, so the next firing with a live
      // clock pins it from live state — no dropped work, no hot loop.
      expect(await harness.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.balancePassCursor,
      })).toEqual({ afterId: null });

      await harness.runJob("balancePass");
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides).toEqual({
        adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
      });
    });

    // TOG-7123 reopen (2026-09-28): admission headroom must stop STARTING
    // rows before the budget is gone — a row admitted with less than a full
    // slice left is the TOG-3867 shape again. With only half a slice of job
    // budget remaining at admission, the row never starts.
    it("stops admitting rows without a full per-row slice of budget left (TOG-7123)", async () => {
      const card = issue("i1", { labels: [], labelIds: [] });
      const harness = await boot(baseConfig(), [card]);
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      // Same TOG-3867 shape as the label-only admission test: the job starts
      // with a live clock and the candidate fetch consumes all but half a
      // row-slice of budget. The row must never start.
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) {
          nowMs = BALANCE_PASS_JOB_BUDGET_MS - Math.floor(BALANCE_PASS_ROW_TIMEOUT_MS / 2);
          return [idleRow("i1")];
        }
        return [];
      }) as typeof harness.ctx.db.query;

      try {
        await harness.runJob("balancePass");
      } finally {
        nowSpy.mockRestore();
        harness.ctx.logger.info = originalInfo;
      }

      const complete = infoLogs.find((entry) => entry.message === "balance pass complete");
      expect(complete?.metadata.scanned).toBe(0);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      expect((await harness.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides ?? null).toBeNull();
    });

    // TOG-11688 HARD RETURN: the id cursor passes every EXAMINED row and
    // stops before an abandoned one. Row i1 stalls past the deadline: the job
    // returns by the budget, the abandoned body commits nothing when it later
    // reaches its write gate, the cursor stays on the PRIOR id (not i1), no
    // scan mark is written mid-cycle, and the next firing pins i1 first.
    it("abandons a slow row at the deadline without moving the id cursor past it (TOG-11688)", async () => {
      const cards = [
        issue("i1", { labels: [tierLabel("T3")], labelIds: ["lbl-T3"] }),
        issue("i2", { labels: [tierLabel("T3")], labelIds: ["lbl-T3"] }),
      ];
      const harness = await boot(baseConfig(), cards, [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      const cursorKey = { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.balancePassCursor } as const;
      await harness.ctx.state.set(cursorKey, { afterId: "i0" });
      const candidateCursors: string[] = [];
      harness.ctx.db.query = (async (query: string, params: readonly unknown[] = []) => {
        if (!query.includes("from issues i")) return [];
        const afterId = String(params[1] ?? "");
        candidateCursors.push(afterId);
        return cards.filter((card) => card.id > afterId).map((card) => idleRow(card.id));
      }) as typeof harness.ctx.db.query;
      const warnLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalWarn = harness.ctx.logger.warn.bind(harness.ctx.logger);
      harness.ctx.logger.warn = ((message: string, metadata: Record<string, unknown>) => {
        warnLogs.push({ message, metadata });
        return originalWarn(message, metadata);
      }) as typeof harness.ctx.logger.warn;
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      let updates = 0;
      const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
      harness.ctx.issues.update = (async (...args: Parameters<typeof originalUpdate>) => {
        updates += 1;
        return originalUpdate(...args);
      }) as typeof harness.ctx.issues.update;
      // Only i1's first read stalls; the abandoned body then runs on to its
      // write gate.
      let stall = true;
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        if (stall) {
          stall = false;
          await stallPastBudget(BALANCE_PASS_JOB_BUDGET_MS);
        }
        return current;
      }) as typeof harness.ctx.issues.get;

      let resolvedAfterMs: number;
      try {
        resolvedAfterMs = await runJobPastDeadline(harness, "balancePass", BALANCE_PASS_JOB_BUDGET_MS);
      } finally {
        harness.ctx.logger.warn = originalWarn;
        harness.ctx.logger.info = originalInfo;
      }

      expect(resolvedAfterMs).toBeLessThanOrEqual(BALANCE_PASS_JOB_BUDGET_MS);
      expect(warnLogs.some((entry) => String(entry.message).includes("abandoned a slow row"))).toBe(true);
      expect(warnLogs.some((entry) => String(entry.message).includes("slow row write"))).toBe(true);
      expect(updates).toBe(0);
      expect(harness.activity).toHaveLength(0);
      for (const id of ["i1", "i2"]) {
        expect((await harness.ctx.issues.get(id, COMPANY))?.assigneeAdapterOverrides ?? null).toBeNull();
      }
      const complete = infoLogs.find((entry) => entry.message === "balance pass complete");
      expect(complete?.metadata.scanned).toBe(0);
      expect(complete?.metadata.cycleComplete).toBe(false);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      expect(await harness.ctx.state.get(cursorKey)).toEqual({ afterId: "i0" });
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.balanceLastScanAt)).toBe(0);

      // Resume: the next firing pages from the same cursor, so i1 is read
      // again and pinned; the cycle completes and only now writes the mark.
      const resumeStartedAt = Date.now();
      await harness.runJob("balancePass");
      expect(candidateCursors).toEqual(["i0", "i0"]);
      for (const id of ["i1", "i2"]) {
        expect((await harness.ctx.issues.get(id, COMPANY))?.assigneeAdapterOverrides).toEqual({
          adapterConfig: { model: "claude-opus-5", env: subCallPins("claude-opus-5", "claude-haiku-4-5-20251001") },
        });
      }
      expect(updates).toBe(2);
      expect(await harness.ctx.state.get(cursorKey)).toEqual({ afterId: null });
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.balanceLastScanAt)).toBe(resumeStartedAt);
    });

    // TOG-11688 ADAPTIVE admission (same shape as the label-only test): row 1
    // costs 40 s, so row 2 with 45 s left is refused. The id cursor passes
    // the examined (unsettled) row 1, and the budget-cut cycle writes no
    // scan mark, so a quiet board cannot skip row 2 next firing.
    it("refuses a new row when the remaining budget cannot cover 1.5x the slowest row (TOG-11688)", async () => {
      const cards = [
        issue("i1", { labels: [tierLabel("T3")], labelIds: ["lbl-T3"] }),
        issue("i2", { labels: [tierLabel("T3")], labelIds: ["lbl-T3"] }),
      ];
      const harness = await boot(baseConfig(), cards, [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) {
          nowMs = BALANCE_PASS_JOB_BUDGET_MS - 85_000;
          return [idleRow("i1"), idleRow("i2")];
        }
        return [];
      }) as typeof harness.ctx.db.query;
      let firstGet = true;
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        if (firstGet) {
          firstGet = false;
          nowMs += 40_000;
        }
        return current;
      }) as typeof harness.ctx.issues.get;

      try {
        await harness.runJob("balancePass");
      } finally {
        harness.ctx.issues.get = originalGet;
        nowSpy.mockRestore();
        harness.ctx.logger.info = originalInfo;
      }

      const complete = infoLogs.find((entry) => entry.message === "balance pass complete");
      expect(complete?.metadata.scanned).toBe(1);
      expect(complete?.metadata.slowestRowMs).toBe(40_000);
      expect(complete?.metadata.skippedSlowRows).toBe(1);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      for (const id of ["i1", "i2"]) {
        expect((await harness.ctx.issues.get(id, COMPANY))?.assigneeAdapterOverrides ?? null).toBeNull();
      }
      expect(harness.activity).toHaveLength(0);
      expect(await harness.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.balancePassCursor,
      })).toEqual({ afterId: "i1" });
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.balanceLastScanAt)).toBe(0);
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
      // TOG-11688: a capped page is mid-cycle — no scan mark yet.
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.balanceLastScanAt)).toBe(0);

      await harness.runJob("balancePass");
      expect(await harness.ctx.state.get({
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: PLUGIN_STATE_KEYS.balancePassCursor,
      })).toEqual({ afterId: null });
      expect(candidateCursors).toEqual(["", cards[BALANCE_PASS_FETCH_LIMIT - 1]?.id]);
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.balanceLastScanAt)).toBe(NOW);
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

    // TOG-11688: this pass hit 288 s max over the last 4 h — its rows
    // (`ctx.issues.get` plus the classifier HTTP call) pay the same contended
    // host-RPC cost as every other row-walking pass. The cooperative budget
    // must sit well beneath the host's 300 s job RPC wall.
    it("keeps the cooperative budget well beneath the host 300 s RPC wall (TOG-11688)", () => {
      expect(CLASSIFY_JOB_BUDGET_MS).toBeGreaterThan(0);
      expect(CLASSIFY_JOB_BUDGET_MS).toBeLessThanOrEqual(300_000 - 60_000);
    });

    // TOG-11688: the admission slice must stay beneath the observed slow row
    // (40-95 s in contended host RPC across the row-walking passes), with the
    // same headroom shape as the label-only pass.
    it("keeps the per-row admission slice beneath the observed slow row (TOG-11688)", () => {
      expect(CLASSIFY_ROW_TIMEOUT_MS).toBeGreaterThan(0);
      expect(CLASSIFY_ROW_TIMEOUT_MS).toBeLessThan(98_000);
      expect(CLASSIFY_JOB_BUDGET_MS - CLASSIFY_ROW_TIMEOUT_MS).toBeLessThanOrEqual(
        300_000 - 60_000,
      );
    });

    // TOG-11688 ADMISSION: with only half a row-slice of job budget left when
    // the candidate fetch returns, the row never starts — same TOG-3867 shape
    // as the label-only admission test. The classifier is never even called.
    it("stops admitting rows without a full per-row slice of budget left (TOG-11688)", async () => {
      const card = issue("i1", { labels: [], labelIds: [] });
      const harness = await boot(classifyConfig(), [card]);
      const calls = stubClassifier(harness, { tier: "T2", confidence: 0.9 });
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) {
          nowMs = CLASSIFY_JOB_BUDGET_MS - Math.floor(CLASSIFY_ROW_TIMEOUT_MS / 2);
          return [classifyRow("i1")];
        }
        return [];
      }) as typeof harness.ctx.db.query;

      try {
        await harness.runJob("classifyIssues");
      } finally {
        nowSpy.mockRestore();
        harness.ctx.logger.info = originalInfo;
      }

      const complete = infoLogs.find((entry) => entry.message === "issue classification pass complete");
      expect(complete?.metadata.examined).toBe(0);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      expect(calls).toHaveLength(0);
      expect((await harness.ctx.issues.get("i1", COMPANY))?.labelIds).toEqual([]);
    });

    // TOG-11688 ADAPTIVE admission: the fixed slice alone admits a row with
    // 45 s of budget left that then costs the observed 40 s. Row 1 burns 40 s
    // (mocked) inside its one live read — tripping its own slice write-gate but
    // teaching the pass that rows on THIS board cost 40 s — so row 2 (45 s
    // left < 1.5x40 = 60 s headroom) never starts. examined stays 1: the
    // fixed 30 s check alone WOULD have admitted it.
    it("refuses a new row when the remaining budget cannot cover 1.5x the slowest row (TOG-11688)", async () => {
      const oldIso = "2026-01-01T00:00:00.000Z";
      const newIso = "2026-01-02T00:00:00.000Z";
      const rowA = { ...classifyRow("i1"), updated_at: oldIso };
      const rowB = { ...classifyRow("i2"), updated_at: newIso };
      const cards = [
        issue("i1", { labels: [], labelIds: [] }),
        issue("i2", { labels: [], labelIds: [] }),
      ];
      const harness = await boot(classifyConfig(), cards);
      const calls = stubClassifier(harness, { tier: "T2", confidence: 0.9 });
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("from issues i")) {
          nowMs = CLASSIFY_JOB_BUDGET_MS - 85_000;
          return [rowA, rowB];
        }
        return [];
      }) as typeof harness.ctx.db.query;
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        nowMs += 40_000;
        return current;
      }) as typeof harness.ctx.issues.get;

      try {
        await harness.runJob("classifyIssues");
      } finally {
        harness.ctx.issues.get = originalGet;
        nowSpy.mockRestore();
        harness.ctx.logger.info = originalInfo;
      }

      // Row 1 reached the classifier (one call) but its write was slow-skipped;
      // row 2 never started, so the classifier saw exactly one call total.
      expect(calls).toHaveLength(1);
      const complete = infoLogs.find((entry) => entry.message === "issue classification pass complete");
      expect(complete?.metadata.examined).toBe(1);
      expect(complete?.metadata.slowestRowMs).toBe(40_000);
      expect(complete?.metadata.skippedSlowRows).toBe(1);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      expect((await harness.ctx.issues.get("i1", COMPANY))?.labelIds).toEqual([]);
      expect((await harness.ctx.issues.get("i2", COMPANY))?.labelIds).toEqual([]);
      expect(harness.activity).toHaveLength(0);
      // Row 1 is unsettled (seen, write refused), so the cursor stops before
      // it and next firing re-attempts it instead of starving it. Resume
      // proves both rows classify from live state.
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.classifyLastScanAt)).toBeLessThan(Date.parse(oldIso));

      await harness.runJob("classifyIssues");
      expect(calls).toHaveLength(3);
      expect((await harness.ctx.issues.get("i1", COMPANY))?.labelIds).toEqual(["lbl-T2"]);
      expect((await harness.ctx.issues.get("i2", COMPANY))?.labelIds).toEqual(["lbl-T2"]);
    });

    // TOG-11688 HARD RETURN: a row whose host calls outrun the remaining job
    // budget must not hold the job past the host's 300 s wall — the race
    // abandons it at the deadline (not examined, cursor unmoved), the
    // abandoned body that finishes later writes no label, provenance or
    // activity, and the next firing retries the row from live state.
    it("abandons a slow row at the deadline without writing, and retries it next firing (TOG-11688)", async () => {
      const card = issue("i1", { labels: [], labelIds: ["lbl-other"] });
      const harness = await boot(classifyConfig(), [card]);
      stubClassifier(harness, { tier: "T2", confidence: 0.9 });
      harness.ctx.db.query = async () =>
        [{ ...classifyRow("i1"), updated_at: "2026-01-01T00:00:00.000Z" }] as never;
      const warnLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalWarn = harness.ctx.logger.warn.bind(harness.ctx.logger);
      harness.ctx.logger.warn = ((message: string, metadata: Record<string, unknown>) => {
        warnLogs.push({ message, metadata });
        return originalWarn(message, metadata);
      }) as typeof harness.ctx.logger.warn;
      const infoLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalInfo = harness.ctx.logger.info.bind(harness.ctx.logger);
      harness.ctx.logger.info = ((message: string, metadata: Record<string, unknown>) => {
        infoLogs.push({ message, metadata });
        return originalInfo(message, metadata);
      }) as typeof harness.ctx.logger.info;
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      let updates = 0;
      const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
      harness.ctx.issues.update = (async (...args: Parameters<typeof originalUpdate>) => {
        updates += 1;
        return originalUpdate(...args);
      }) as typeof harness.ctx.issues.update;
      let stall = true;
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        if (stall) await stallPastBudget(CLASSIFY_JOB_BUDGET_MS);
        return current;
      }) as typeof harness.ctx.issues.get;

      let resolvedAfterMs: number;
      try {
        resolvedAfterMs = await runJobPastDeadline(harness, "classifyIssues", CLASSIFY_JOB_BUDGET_MS);
      } finally {
        stall = false;
        harness.ctx.logger.warn = originalWarn;
        harness.ctx.logger.info = originalInfo;
      }

      expect(resolvedAfterMs).toBeLessThanOrEqual(CLASSIFY_JOB_BUDGET_MS);
      // The abandoned body ran on past the deadline to completion and still
      // committed nothing.
      expect(updates).toBe(0);
      expect((await harness.ctx.issues.get("i1", COMPANY))?.labelIds).toEqual(["lbl-other"]);
      expect(harness.activity).toHaveLength(0);
      expect(warnLogs.some((entry) => String(entry.message).includes("abandoned a slow row"))).toBe(true);
      const complete = infoLogs.find((entry) => entry.message === "issue classification pass complete");
      expect(complete?.metadata.examined).toBe(0);
      expect(complete?.metadata.budgetExhausted).toBe(true);
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.classifyLastScanAt)).toBe(0);

      // Resume: a fresh firing classifies the abandoned row from live state.
      await harness.runJob("classifyIssues");
      expect((await harness.ctx.issues.get("i1", COMPANY))?.labelIds).toEqual(["lbl-other", "lbl-T2"]);
    });

    // TOG-11688 WRITE GATE: a row admitted with budget left can still go slow
    // INSIDE its host calls. It must then complete without committing an
    // orphaned mutation — no label, no provenance, no activity — while the
    // watermark still covers it, so next firing re-attempts it from live state.
    it("skips the write (without starving the row) when the admitted row goes slow (TOG-11688)", async () => {
      const oldIso = "2026-01-01T00:00:00.000Z";
      const card = issue("i1", { labels: [], labelIds: ["lbl-other"] });
      const harness = await boot(classifyConfig(), [card]);
      stubClassifier(harness, { tier: "T2", confidence: 0.9 });
      harness.ctx.db.query = async () => [{ ...classifyRow("i1"), updated_at: oldIso }] as never;
      const warnLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const originalWarn = harness.ctx.logger.warn.bind(harness.ctx.logger);
      harness.ctx.logger.warn = ((message: string, metadata: Record<string, unknown>) => {
        warnLogs.push({ message, metadata });
        return originalWarn(message, metadata);
      }) as typeof harness.ctx.logger.warn;
      // A slow host call INSIDE the admitted row: its live read burns a full
      // row slice while job budget still remains.
      let nowMs = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
      harness.ctx.issues.get = (async (...args: Parameters<typeof originalGet>) => {
        const current = await originalGet(...args);
        nowMs += CLASSIFY_ROW_TIMEOUT_MS;
        return current;
      }) as typeof harness.ctx.issues.get;

      try {
        await harness.runJob("classifyIssues");
      } finally {
        harness.ctx.issues.get = originalGet;
        nowSpy.mockRestore();
        harness.ctx.logger.warn = originalWarn;
      }

      // No orphaned label and no activity for the slow row ...
      expect((await harness.ctx.issues.get("i1", COMPANY))?.labelIds).toEqual(["lbl-other"]);
      expect(harness.activity).toHaveLength(0);
      expect(warnLogs.some((entry) => String(entry.message).includes("slow row write"))).toBe(true);
      // ... and the cursor stops before the unsettled row, so the next firing
      // with a live clock re-attempts and classifies it — no dropped work.
      expect(await storedScanMarkMs(harness, PLUGIN_STATE_KEYS.classifyLastScanAt)).toBeLessThan(Date.parse(oldIso));

      await harness.runJob("classifyIssues");
      expect((await harness.ctx.issues.get("i1", COMPANY))?.labelIds).toEqual(["lbl-other", "lbl-T2"]);
    });
  });

  describe("TOG-3585 incremental scans", () => {
    function scanMarkKey(stateKey: string) {
      return { scopeKind: "company", scopeId: COMPANY, stateKey } as never;
    }

    function skipLogs(harness: Awaited<ReturnType<typeof boot>>) {
      return (harness.logs as Array<{ level: string; message: string }>).filter((entry) =>
        entry.message.includes("no issues changed since last scan"),
      );
    }

    it("classifyIssues skips the per-candidate work when nothing changed since its watermark", async () => {
      const card = issue("i1", { labels: [], labelIds: [] });
      const harness = await boot(
        baseConfig({ classification: { enabled: true, baseUrl: "https://x.example.com", modelId: "m" } }),
        [card],
      );
      await harness.ctx.state.set(scanMarkKey(PLUGIN_STATE_KEYS.classifyLastScanAt), {
        at: new Date().toISOString(),
      });
      // No rows changed since the mark: the row query returns nothing.
      harness.ctx.db.query = async () => [] as never;

      await harness.runJob("classifyIssues");

      expect(skipLogs(harness)).toHaveLength(1);
      expect(harness.activity).toHaveLength(0);
    });

    it("classifyIssues advances its watermark past a drained scan", async () => {
      const card = issue("i1", { labels: [], labelIds: [] });
      const harness = await boot(
        baseConfig({ classification: { enabled: true, baseUrl: "https://x.example.com", modelId: "m" } }),
        [card],
      );
      const before = Date.now();
      harness.ctx.db.query = async () => [] as never;

      await harness.runJob("classifyIssues");

      const stored = (await harness.ctx.state.get(scanMarkKey(PLUGIN_STATE_KEYS.classifyLastScanAt))) as {
        at: string;
      };
      expect(Date.parse(stored.at)).toBeGreaterThanOrEqual(before);
    });

    it("classifyIssues moves the watermark only through the examined row when a batch-size break cuts a drained fetch short", async () => {
      // Two rows fetched, both well under the fetch limit (10x batchSize) —
      // a drained fetch by the old, buggy definition. With batchSize=1 only
      // the first row is ever examined before the break fires. Pre-fix,
      // "drained" alone jumped the mark straight to the firing start,
      // silently starving row B (never examined) out of every future scan.
      // TOG-11688: the mark is a cursor — it stops at row A, so row B
      // (`updated_at > mark`) is read next firing.
      const oldIso = "2026-01-01T00:00:00.000Z";
      const newIso = "2026-01-02T00:00:00.000Z";
      const rowA = { id: "i1", identifier: "i1", status: "in_progress", agent_name: "x", title: "t", description: "d", updated_at: oldIso };
      const rowB = { id: "i2", identifier: "i2", status: "in_progress", agent_name: "x", title: "t", description: "d", updated_at: newIso };
      const cardA = issue("i1", { labels: [], labelIds: [] });
      const cardB = issue("i2", { labels: [], labelIds: [] });
      const harness = await boot(classifyConfig({ batchSize: 1 }), [cardA, cardB]);
      harness.ctx.db.query = async () => [rowA, rowB] as never;
      stubClassifier(harness, { tier: "T2", confidence: 0.9 });
      const before = Date.now();

      await harness.runJob("classifyIssues");

      const stored = (await harness.ctx.state.get(scanMarkKey(PLUGIN_STATE_KEYS.classifyLastScanAt))) as {
        at: string;
      };
      expect(stored.at).toBe(oldIso);
      expect(Date.parse(stored.at)).toBeLessThan(Date.parse(newIso));
      expect(Date.parse(stored.at)).toBeLessThan(before);
    });

    it("repinPass moves the watermark only through the rows it settled when the write-limit break cuts a drained fetch short", async () => {
      // Same fixture as "stops writing once REPIN_PASS_WRITE_LIMIT (6)..." —
      // 8 eligible cards, all on an exhausted lane, only the first 6 (write
      // limit) ever get examined before the break fires. Pre-fix this
      // drained fetch (8 rows, well under REPIN_PASS_FETCH_LIMIT) would have
      // jumped the mark to the firing start, starving cards 7 and 8.
      // TOG-11688: the mark is a cursor at the sixth (last settled) row, so
      // cards 7 and 8 are read next firing — and the six repinned rows are
      // not re-walked, which the old creep-to-oldest rule did forever once a
      // deadline-bounded walk reached only a few rows per firing.
      const modelsWithLane = withOpusAlt().map((m) => (m.id === "claude-opus-5" ? { ...m, laneId: "lane-opus" } : m));
      const base = Date.parse("2026-01-01T00:00:00.000Z");
      const cards = Array.from({ length: 8 }, (_, i) =>
        issue(`i${i}`, {
          labels: [tierLabel("T1")],
          labelIds: ["lbl-T1"],
          assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
        }),
      );
      const harness = await boot(baseConfig({ models: modelsWithLane, pacing: { mode: "enforce" } }), cards);
      harness.ctx.db.query = async () =>
        cards.map((c, i) => idleRow(c.id, "in_progress", { updated_at: new Date(base + i * 1000).toISOString() })) as never;
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
      const before = Date.now();

      await harness.runJob("repinPass");

      const stored = (await harness.ctx.state.get(scanMarkKey(PLUGIN_STATE_KEYS.repinLastScanAt))) as { at: string };
      expect(stored.at).toBe(new Date(base + 5 * 1000).toISOString());
      expect(Date.parse(stored.at)).toBeLessThan(base + 6 * 1000);
      expect(Date.parse(stored.at)).toBeLessThan(before);
    });

    it("labelOnlyPass skips when nothing changed and scans when rows return", async () => {
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig(), [card]);
      await harness.ctx.state.set(scanMarkKey(PLUGIN_STATE_KEYS.labelOnlyLastScanAt), {
        at: new Date().toISOString(),
      });
      harness.ctx.db.query = async () => [] as never;

      await harness.runJob("labelOnlyPass");

      expect(skipLogs(harness)).toHaveLength(1);
      expect(harness.activity).toHaveLength(0);
    });

    it("labelOnlyPass carries a capped fetch to the next firing through its row cap, not past it", async () => {
      // TOG-3622: a capped (limit-hit) fetch is the OTHER shape of the
      // starvation bug — unfetched rows beyond the limit are always newer
      // than the fetched batch only when the fetch is oldest-first.
      // TOG-11688: the per-firing row cap now ends the walk long before the
      // fetch limit, so the cursor stops at the last walked row: every row
      // carries an operator pin (settled at once), the walk stops at
      // LABEL_ONLY_PASS_MAX_ROWS_PER_FIRING, and the next firing reads from
      // the first unwalked row. The capped-fetch tie rule itself is pinned
      // in row-walk.spec.ts (`scanMarkAfterWalk`).
      const base = Date.parse("2026-01-01T00:00:00.000Z");
      const cards = Array.from({ length: LABEL_ONLY_PASS_FETCH_LIMIT }, (_, i) =>
        issue(`i${i}`, { labels: [operatorPinLabel()], labelIds: ["lbl-op"] }),
      );
      const harness = await boot(baseConfig(), cards);
      harness.ctx.db.query = async () =>
        cards.map((c, i) => idleRow(c.id, "in_progress", { updated_at: new Date(base + i * 1000).toISOString() })) as never;
      const before = Date.now();

      await harness.runJob("labelOnlyPass");

      const lastWalked = base + (LABEL_ONLY_PASS_MAX_ROWS_PER_FIRING - 1) * 1000;
      const stored = (await harness.ctx.state.get(scanMarkKey(PLUGIN_STATE_KEYS.labelOnlyLastScanAt))) as { at: string };
      expect(stored.at).toBe(new Date(lastWalked).toISOString());
      expect(Date.parse(stored.at)).toBeLessThan(lastWalked + 1000);
      expect(Date.parse(stored.at)).toBeLessThan(before);
    });

    it("classifyIssues, labelOnlyPass, and repinPass all issue their candidate-fetch SQL ordered oldest-first", async () => {
      // TOG-3626: the fixture-level ASC/DESC tests above are necessary but not
      // sufficient — every `db.query` stub ignores the SQL text, so a
      // regression that silently reverts a query back to `updated_at desc`
      // (the exact bug TOG-3622 found) leaves the whole suite green. Assert
      // directly on the issued SQL for all three watermarked passes so a DESC
      // reintroduction fails here even when nothing else catches it.
      const classifyQueries: string[] = [];
      {
        const card = issue("i1", { labels: [], labelIds: [] });
        const harness = await boot(
          baseConfig({ classification: { enabled: true, baseUrl: "https://x.example.com", modelId: "m" } }),
          [card],
        );
        harness.ctx.db.query = (async (query: string) => {
          classifyQueries.push(query);
          return [];
        }) as typeof harness.ctx.db.query;
        await harness.runJob("classifyIssues");
      }
      const labelOnlyQueries: string[] = [];
      {
        const card = issue("i1", { labels: [], labelIds: [] });
        const harness = await boot(baseConfig(), [card]);
        harness.ctx.db.query = (async (query: string) => {
          labelOnlyQueries.push(query);
          return [];
        }) as typeof harness.ctx.db.query;
        await harness.runJob("labelOnlyPass");
      }
      const repinQueries: string[] = [];
      {
        const card = issue("i1", { labels: [], labelIds: [] });
        const harness = await boot(baseConfig(), [card]);
        harness.ctx.db.query = (async (query: string) => {
          repinQueries.push(query);
          return [];
        }) as typeof harness.ctx.db.query;
        await harness.runJob("repinPass");
      }

      const rowQueries = [
        ...classifyQueries.filter((q) => q.includes("from issues i")),
        ...labelOnlyQueries.filter((q) => q.includes("from issues i")),
        ...repinQueries.filter((q) => q.includes("from issues i")),
      ];
      expect(rowQueries.length).toBeGreaterThanOrEqual(3);
      for (const q of rowQueries) {
        expect(q).toMatch(/order by i\.updated_at asc/);
        expect(q).not.toMatch(/updated_at desc/);
      }
    });

    it("repinPass skips on its watermark but the reactive path still scans fully", async () => {
      const card = issue("i1", { labels: [], labelIds: [] });
      const harness = await boot(baseConfig(), [card]);
      await harness.ctx.state.set(scanMarkKey(PLUGIN_STATE_KEYS.repinLastScanAt), {
        at: new Date().toISOString(),
      });
      const queries: string[] = [];
      harness.ctx.db.query = (async (query: string) => {
        queries.push(query);
        return [];
      }) as typeof harness.ctx.db.query;

      await harness.runJob("repinPass");

      // The scheduled firing probed with a cursor predicate and skipped.
      expect(queries.some((q) => q.includes("i.updated_at > $3"))).toBe(true);
      expect(skipLogs(harness)).toHaveLength(1);
    });

    it("the reactive agent.run.failed path sweeps the full repin candidate set, no cursor, even with a fresh watermark", async () => {
      const modelsWithLane = withOpusAlt().map((m) => (m.id === "claude-opus-5" ? { ...m, laneId: "lane-opus" } : m));
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ models: modelsWithLane }), [card]);
      // A watermark set to "now" would make the SCHEDULED job skip entirely
      // (as the test above confirms). The reactive path must ignore it.
      await harness.ctx.state.set(scanMarkKey(PLUGIN_STATE_KEYS.repinLastScanAt), {
        at: new Date().toISOString(),
      });
      const repinQueries: string[] = [];
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("join agents a") && query.includes("adapterConfig'->>'model' is not null")) {
          repinQueries.push(query);
          return [idleRow("i1")];
        }
        return [];
      }) as typeof harness.ctx.db.query;

      await harness.emit(
        "agent.run.failed",
        { issueId: "i1", error: "All credentials for model claude-opus-5 are cooling down" },
        { companyId: COMPANY },
      );

      // A full, cursor-free sweep: the candidate query ran, and it carried no
      // `i.updated_at > $3` incremental predicate despite the fresh mark
      // written above.
      expect(repinQueries.length).toBeGreaterThan(0);
      expect(repinQueries.every((q) => !q.includes("i.updated_at > $3"))).toBe(true);
    });

    it("balancePass skips the whole cycle on a quiet board and runs it when the aggregate is unreadable", async () => {
      const card = issue("i1", { labels: [], labelIds: [] });
      const harness = await boot(baseConfig(), [card]);
      await harness.ctx.state.set(scanMarkKey(PLUGIN_STATE_KEYS.balanceLastScanAt), {
        at: new Date().toISOString(),
      });
      // Aggregate answers "nothing newer than the mark"; the page fetch must
      // never run.
      const pageQueries: string[] = [];
      harness.ctx.db.query = (async (query: string) => {
        if (query.includes("max_updated")) return [{ max_updated: new Date(0).toISOString() }] as never;
        pageQueries.push(query);
        return [];
      }) as typeof harness.ctx.db.query;

      await harness.runJob("balancePass");

      expect(skipLogs(harness)).toHaveLength(1);
      expect(pageQueries).toHaveLength(0);

      // Fail-open: when the aggregate shape is missing (a fake returning card
      // rows for every query, like the legacy overrides), the cycle runs
      // instead of skipping.
      const harness2 = await boot(baseConfig(), [card]);
      harness2.ctx.db.query = async () => [idleRow("i1")] as never;

      await harness2.runJob("balancePass");

      expect(skipLogs(harness2)).toHaveLength(0);
    });
  });
});

describe("TOG-12431 advisory selection writes no model/env pins", () => {
  // Parent TOG-12427: the passes wrote model pins in the default advisory
  // install, bypassing the quota guard. Every router-owned pin site is gated
  // on selection.enabled && mode=enforce; in any other posture the passes
  // still walk their rows and still log, but write no override. Both
  // non-enforcing postures are covered: explicit advise mode and selection
  // disabled outright.
  const ADVISORY_SELECTIONS: Array<{ name: string; selection: Record<string, unknown> }> = [
    { name: "advise", selection: { enabled: true, mode: "advise", holdOnUntrustedProfile: true } },
    // Disabled wins even when mode says enforce: both conjuncts are load-bearing.
    { name: "selection-disabled", selection: { enabled: false, mode: "enforce", holdOnUntrustedProfile: true } },
  ];

  /** Every issues.update this run, so tests can prove no override was written. */
  function recordIssueUpdates(harness: Awaited<ReturnType<typeof boot>>) {
    const seen: Array<{ issueId: string; patch: Record<string, unknown> }> = [];
    const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
    harness.ctx.issues.update = (async (...args: Parameters<typeof originalUpdate>) => {
      seen.push({ issueId: args[0] as string, patch: args[1] as unknown as Record<string, unknown> });
      return originalUpdate(...args);
    }) as typeof harness.ctx.issues.update;
    return seen;
  }

  /** Updates carrying a model/env pin (or a pin clear) — the gated writes. */
  function overridePatches(seen: Array<{ issueId: string; patch: Record<string, unknown> }>) {
    return seen.filter((entry) => "assigneeAdapterOverrides" in entry.patch);
  }

  for (const { name, selection } of ADVISORY_SELECTIONS) {
    it(`labelOnlyPass writes no override in ${name} mode but still logs the decision`, async () => {
      const card = issue("i1", { labels: [tierLabel("T1")], labelIds: ["lbl-T1"] });
      const harness = await boot(baseConfig({ selection }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      const seen = recordIssueUpdates(harness);

      await harness.runJob("labelOnlyPass");

      // The TOG-12427 defect: this update fired in advisory installs.
      expect(overridePatches(seen)).toHaveLength(0);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      // ... but the decision is still visible: one activity entry, marked.
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("advisory, nothing written");
      expect(harness.activity[0]?.metadata).toMatchObject({ advisory: true });
      // Labels are not pins: the existing tier label survives untouched.
      expect(after?.labelIds).toEqual(["lbl-T1"]);
    });

    it(`repinPass preserves a demoted pin in ${name} mode but still logs the decision`, async () => {
      const card = issue("i1", {
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ selection, models: withOpusAlt() }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      await demoteOpus(harness);
      const seen = recordIssueUpdates(harness);

      await harness.runJob("repinPass");

      expect(overridePatches(seen)).toHaveLength(0);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("advisory, nothing written");
      expect(harness.activity[0]?.metadata).toMatchObject({ advisory: true });
    });

    it(`repinPass preserves a blocked card's pin in ${name} mode (the clear is a write too)`, async () => {
      const card = issue("i1", {
        status: "blocked",
        labels: [tierLabel("T1")],
        labelIds: ["lbl-T1"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ selection }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1", "blocked")] as never;
      const seen = recordIssueUpdates(harness);

      await harness.runJob("repinPass");

      // Clearing a pin mutates a selection variable like any other write:
      // advisory reports it without doing it.
      expect(overridePatches(seen)).toHaveLength(0);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("advisory, nothing written");
      expect(harness.activity[0]?.metadata).toMatchObject({ reason: "clear-on-blocked", advisory: true });
    });

    it(`balancePass preserves a pinned card in ${name} mode but still logs the decision`, async () => {
      // Same cost-down fixture as the TOG-5227 isolation test: enforce would
      // move this card off claude-opus-5 onto the cheap alt.
      const cheapModels = withOpusAlt().map((m) =>
        m.id === "claude-opus-5" ? { ...m, costPerMTokIn: 100, costPerMTokOut: 500 } : m,
      );
      const card = issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
      });
      const harness = await boot(baseConfig({ selection, models: cheapModels }), [card]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      const seen = recordIssueUpdates(harness);

      await harness.runJob("balancePass");

      expect(overridePatches(seen)).toHaveLength(0);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("advisory, nothing written");
      expect(harness.activity[0]?.metadata).toMatchObject({ advisory: true });
    });

    it(`balancePass leaves an unpinned labelled card unpinned in ${name} mode`, async () => {
      const card = issue("i1", {
        labels: [tierLabel("T3")],
        labelIds: ["lbl-T3"],
        assigneeAdapterOverrides: null,
      });
      const harness = await boot(baseConfig({ selection }), [card], [agentRow({ adapterConfig: { model: "claude-haiku-4-5-20251001" } })]);
      harness.ctx.db.query = async () => [idleRow("i1")] as never;
      const seen = recordIssueUpdates(harness);

      await harness.runJob("balancePass");

      expect(overridePatches(seen)).toHaveLength(0);
      const after = await harness.ctx.issues.get("i1", COMPANY);
      expect(after?.assigneeAdapterOverrides ?? null).toBeNull();
      expect(after?.labelIds).toEqual(["lbl-T3"]);
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0]?.message).toContain("advisory, nothing written");
      expect(harness.activity[0]?.metadata).toMatchObject({ advisory: true });
    });
  }
});
