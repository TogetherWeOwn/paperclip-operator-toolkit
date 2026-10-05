import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ScopeKey } from "@paperclipai/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import {
  BALANCE_PASS_FETCH_LIMIT,
  BALANCE_PASS_JOB_BUDGET_MS,
  BALANCE_PASS_ROW_TIMEOUT_MS,
  LABEL_ONLY_PASS_JOB_BUDGET_MS,
  LABEL_ONLY_PASS_ROW_TIMEOUT_MS,
  PLUGIN_STATE_KEYS,
  REPIN_PASS_JOB_BUDGET_MS,
  REPIN_PASS_ROW_TIMEOUT_MS,
} from "../src/constants.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES } from "./fixtures.js";

const COMPANY = "co-1";
const AGENT = "agent-1";
const scope = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: COMPANY, stateKey });
const cases = [
  { name: "label-only", job: "labelOnlyPass", pinned: false, mark: PLUGIN_STATE_KEYS.labelOnlyLastScanAt, budget: LABEL_ONLY_PASS_JOB_BUDGET_MS, slice: LABEL_ONLY_PASS_ROW_TIMEOUT_MS, counter: "pinned" },
  { name: "repin", job: "repinPass", pinned: true, mark: PLUGIN_STATE_KEYS.repinLastScanAt, budget: REPIN_PASS_JOB_BUDGET_MS, slice: REPIN_PASS_ROW_TIMEOUT_MS, counter: "repinned" },
  { name: "pinned balance", job: "balancePass", pinned: true, mark: PLUGIN_STATE_KEYS.balanceLastScanAt, budget: BALANCE_PASS_JOB_BUDGET_MS, slice: BALANCE_PASS_ROW_TIMEOUT_MS, counter: "balanced" },
  { name: "unpinned balance", job: "balancePass", pinned: false, mark: PLUGIN_STATE_KEYS.balanceLastScanAt, budget: BALANCE_PASS_JOB_BUDGET_MS, slice: BALANCE_PASS_ROW_TIMEOUT_MS, counter: "balanced" },
] as const;
type PassCase = (typeof cases)[number];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function boot(testCase: PassCase, mode: "enforce" | "advise" = "enforce") {
  const opus = MODELS.find((m) => m.id === "claude-opus-5")!;
  const config = {
    selection: { enabled: true, mode, holdOnUntrustedProfile: true },
    models: [
      ...MODELS.map((m) => m.id === "claude-opus-5" ? { ...m, laneId: "lane-opus" } : m),
      { ...opus, id: "claude-opus-5-expensive", laneId: "lane-old", costPerMTokIn: 100, costPerMTokOut: 500 },
    ],
    tierLabelIds: { T1: "lbl-T1", T2: "lbl-T2", T3: "lbl-T3" },
    classification: { enabled: true },
    pacing: { mode: "enforce" },
  };
  const originalPin = testCase.pinned ? {
    adapterConfig: { model: testCase.job === "balancePass" ? "claude-opus-5-expensive" : "claude-haiku-4-5-20251001" },
  } : null;
  const card = {
    id: "i1", companyId: COMPANY, title: "A card", status: "in_progress", assigneeAgentId: AGENT,
    assigneeAdapterOverrides: originalPin, checkoutRunId: null, executionRunId: null,
    labels: [{ id: "lbl-T1", companyId: COMPANY, name: "tier:T1", color: "#000", createdAt: new Date(0), updatedAt: new Date(0) }],
    labelIds: ["lbl-T1"],
  };
  const agent = {
    id: AGENT, companyId: COMPANY, name: "Engineer", urlKey: "engineer", role: "general", title: null,
    icon: null, status: "active", reportsTo: null, capabilities: null, adapterType: "claude_local",
    adapterConfig: { model: "claude-haiku-4-5-20251001" }, runtimeConfig: {}, budgetMonthlyCents: 0,
    spentMonthlyCents: 0, pauseReason: null, pausedAt: null, permissions: {}, lastHeartbeatAt: null,
    metadata: null, createdAt: new Date(0), updatedAt: new Date(0),
  };
  const h = createTestHarness({ manifest, config });
  h.seed({ issues: [card] as never, agents: [agent] as never, companies: [{ id: COMPANY, name: "Co" }] as never });
  const p = createPlugin();
  await p.definition.setup!(h.ctx);
  await p.definition.onConfigChanged!(config, { companyId: COMPANY });
  await h.ctx.state.set(scope(PLUGIN_STATE_KEYS.volumeProfiles), { profiles: PROFILES, signals: NO_ESCALATION });
  const updatedAt = new Date(Date.now() - 1000);
  const queryMarks: number[] = [];
  // Unlike an always-returning row stub, these implement the actual incremental
  // predicate and balance's quiet-board aggregate plus ID cursor.
  h.ctx.db.query = (async (sql: string, params: unknown[]) => {
    if (sql.includes("max(updated_at)")) return [{ max_updated: updatedAt }];
    if (!sql.includes("from issues i")) return [];
    if (testCase.job === "balancePass") {
      return "i1" > String(params[1]) ? [{ id: "i1", identifier: "i1" }] : [];
    }
    const mark = Date.parse(String(params[2]));
    queryMarks.push(mark);
    return updatedAt.getTime() > mark ? [{ id: "i1", identifier: "i1", status: "in_progress", updated_at: updatedAt }] : [];
  }) as typeof h.ctx.db.query;
  const writes = vi.spyOn(h.ctx.issues, "update");
  const logs = vi.spyOn(h.ctx.logger, "info");
  return { h, originalPin, updatedAt, queryMarks, writes, logs };
}

type Fixture = Awaited<ReturnType<typeof boot>>;

function interceptPreWriteRead(h: Fixture["h"], read: () => Promise<unknown>) {
  const get = h.ctx.state.get.bind(h.ctx.state);
  let reads = 0;
  h.ctx.state.get = (async (input: ScopeKey) => {
    if (input.stateKey === PLUGIN_STATE_KEYS.laneOutage) {
      reads++;
      return reads <= 2 ? null : read();
    }
    return get(input);
  }) as typeof h.ctx.state.get;
  return () => reads;
}

async function markMs(h: Fixture["h"], key: string): Promise<number> {
  const mark = await h.ctx.state.get(scope(key)) as { at?: string } | null;
  return mark?.at ? Date.parse(mark.at) : 0;
}

function expectCounter(fixture: Fixture, testCase: PassCase, count: number) {
  expect(fixture.logs.mock.calls.some(([, data]) => data?.[testCase.counter] === count)).toBe(true);
}

async function expectUnwritten(fixture: Fixture, testCase: PassCase) {
  expect(fixture.writes).not.toHaveBeenCalled();
  expect(fixture.h.activity).toHaveLength(0);
  expect((await fixture.h.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides ?? null).toEqual(fixture.originalPin);
  expectCounter(fixture, testCase, 0);
}

describe.each(cases.filter((testCase) => testCase.job === "balancePass"))("balance retry cycle: $name", (testCase) => {
  it("carries an early-page skip through wrap and clears it only after a clean cycle", async () => {
    const fixture = await boot(testCase);
    const ids = ["i1", ...Array.from({ length: BALANCE_PASS_FETCH_LIMIT }, (_, i) => `i${String(i + 1000)}`)];
    fixture.h.ctx.db.query = (async (sql: string, params: unknown[]) => {
      if (sql.includes("max(updated_at)")) return [{ max_updated: fixture.updatedAt }];
      if (!sql.includes("from issues i")) return [];
      return ids.filter((id) => id > String(params[1])).slice(0, Number(params[2])).map((id) => ({ id, identifier: id }));
    }) as typeof fixture.h.ctx.db.query;
    let cleared = false;
    interceptPreWriteRead(fixture.h, async () => cleared ? null : {
      lanes: ["lane-opus"], models: [], until: new Date(NOW + 15 * 60_000).toISOString(), reason: "test quarantine",
    });
    const cursor = scope(PLUGIN_STATE_KEYS.balancePassCursor);
    await fixture.h.runJob("balancePass");
    await expectUnwritten(fixture, testCase);
    expect(await fixture.h.ctx.state.get(cursor)).toMatchObject({ retryPending: true, unsettledInCycle: true });
    // A clean terminal page must not forget the skipped card on page one.
    cleared = true;
    vi.setSystemTime(NOW + 16 * 60_000);
    await fixture.h.runJob("balancePass");
    expect(await fixture.h.ctx.state.get(cursor)).toEqual({ afterId: null, retryPending: true });
    expect(await markMs(fixture.h, testCase.mark)).toBeLessThan(fixture.updatedAt.getTime());
    await fixture.h.runJob("balancePass");
    expect(fixture.writes).toHaveBeenCalledTimes(1);
    expect((await fixture.h.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides?.adapterConfig?.model).toBe("claude-opus-5");
    // The retry remains live across clean intermediate pages too.
    expect(await fixture.h.ctx.state.get(cursor)).toMatchObject({ retryPending: true });
    await fixture.h.runJob("balancePass");
    expect(await fixture.h.ctx.state.get(cursor)).toEqual({ afterId: null });
    expect(await markMs(fixture.h, testCase.mark)).toBe(Date.now());
  });

  it("bypasses a quiet-board gate while a retry is pending", async () => {
    const fixture = await boot(testCase);
    await fixture.h.ctx.state.set(scope(testCase.mark), { at: new Date(NOW).toISOString() });
    await fixture.h.ctx.state.set(scope(PLUGIN_STATE_KEYS.balancePassCursor), { afterId: null, retryPending: true });
    await fixture.h.runJob("balancePass");
    expect(fixture.writes).toHaveBeenCalledTimes(1);
    expect(await fixture.h.ctx.state.get(scope(PLUGIN_STATE_KEYS.balancePassCursor))).toEqual({ afterId: null });
  });
});

// Extends the Code Reviewer's two isolated reproductions to all four write
// branches, including repin's watermark and balance's quiet-board gate.
describe.each(cases)("scheduled quarantine safety: $name", (testCase) => {
  it("writes normally when the pre-write snapshot is healthy", async () => {
    const fixture = await boot(testCase);
    const reads = interceptPreWriteRead(fixture.h, async () => null);
    await fixture.h.runJob(testCase.job);
    expect(reads()).toBe(3);
    expect(fixture.writes).toHaveBeenCalledTimes(1);
    expect((await fixture.h.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides?.adapterConfig?.model).toBe("claude-opus-5");
    expectCounter(fixture, testCase, 1);
  });

  it("does not write after the pre-write read outlives the job deadline", async () => {
    const fixture = await boot(testCase);
    const reads = interceptPreWriteRead(fixture.h, async () => {
      await new Promise((resolve) => setTimeout(resolve, testCase.budget + 60_000));
      return null;
    });
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const start = Date.now();
    let resolvedAt: number | null = null;
    const run = fixture.h.runJob(testCase.job).then(() => { resolvedAt = Date.now(); });
    await vi.advanceTimersByTimeAsync(testCase.budget + 1);
    expect(resolvedAt).not.toBeNull();
    expect(resolvedAt! - start).toBeLessThanOrEqual(testCase.budget);
    await run;
    // The abandoned callback keeps running. Let it finish before checking
    // writes, activity and counters; an early assertion would be vacuous.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toBe(3);
    await expectUnwritten(fixture, testCase);
    expect(await markMs(fixture.h, testCase.mark)).toBeLessThan(fixture.updatedAt.getTime());
  });

  it("does not write when the pre-write read consumes the row slice", async () => {
    const fixture = await boot(testCase);
    const reads = interceptPreWriteRead(fixture.h, async () => {
      vi.setSystemTime(Date.now() + testCase.slice);
      return null;
    });
    await fixture.h.runJob(testCase.job);
    expect(reads()).toBe(3);
    await expectUnwritten(fixture, testCase);
    expect(await markMs(fixture.h, testCase.mark)).toBeLessThan(fixture.updatedAt.getTime());
  });

  it("retries an unchanged row after the quarantine clears on the next firing", async () => {
    const fixture = await boot(testCase);
    let cleared = false;
    const reads = interceptPreWriteRead(fixture.h, async () => cleared ? null : {
      lanes: ["lane-opus"], models: [], until: new Date(NOW + 15 * 60_000).toISOString(), reason: "test quarantine",
    });
    await fixture.h.runJob(testCase.job);
    expect(reads()).toBe(3);
    await expectUnwritten(fixture, testCase);
    const firstMark = await markMs(fixture.h, testCase.mark);
    cleared = true;
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await fixture.h.runJob(testCase.job);
    expect((await fixture.h.ctx.issues.get("i1", COMPANY))?.assigneeAdapterOverrides?.adapterConfig?.model).toBe("claude-opus-5");
    expect(firstMark).toBeLessThan(fixture.updatedAt.getTime());
    expect(fixture.writes).toHaveBeenCalledTimes(1);
    expect(fixture.h.activity).toHaveLength(1);
    expectCounter(fixture, testCase, 1);
    if (testCase.job !== "balancePass") {
      expect(fixture.queryMarks).toHaveLength(2);
      expect(fixture.queryMarks[1]).toBeLessThan(fixture.updatedAt.getTime());
    }
  });

  it("does not add a pre-write read or pin in advisory mode", async () => {
    const fixture = await boot(testCase, "advise");
    const reads = interceptPreWriteRead(fixture.h, async () => { throw new Error("advisory pre-write read"); });
    await fixture.h.runJob(testCase.job);
    expect(reads()).toBe(2);
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(fixture.h.activity).toHaveLength(1);
    expect(fixture.h.activity[0]?.metadata).toMatchObject({ advisory: true, written: false });
    expectCounter(fixture, testCase, 0);
  });
});
