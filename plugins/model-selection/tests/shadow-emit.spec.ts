import { describe, expect, it } from "vitest";

import type { LaneLedger } from "../src/engine/pacing.js";
import { selectModel } from "../src/engine/select.js";
import { buildHostRecord, buildShadowRecord, SHADOW_SCHEMA_VERSION } from "../src/shadow-emit.js";
import type { LanePaceObservation, LanePaceVerdict, PaceWindowVerdict } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };
const NOW_ISO = new Date(NOW).toISOString();
// The live deployment's window names (`pacing.fiveHourWindowName` /
// `pacing.weeklyWindowName`), which the per-lane reporting columns key on.
const WINDOW_NAMES = { weekly: "weekly", fiveHour: "five-hour" };

function verdict(overrides: Partial<LanePaceVerdict> = {}): LanePaceVerdict {
  return {
    laneId: "lane-a",
    observedAt: NOW_ISO,
    state: "on",
    serviceable: true,
    score: { utilization: 0.42, elapsed: 0.5, deviation: -0.08 },
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 1,
    urgentResetAt: null,
    reason: "ok",
    ...overrides,
  };
}

function observation(): LanePaceObservation {
  return {
    laneId: "lane-a",
    free: false,
    observedAt: NOW_ISO,
    staleAfterSeconds: 900,
    accounts: [],
    error: null,
  };
}

// MODELS in fixtures.ts carries no laneId; give each roster row one so the
// lane-snapshot/candidate-lane derivations under test have something to key on.
const MODELS_WITH_LANES = MODELS.map((m) => ({ ...m, laneId: "lane-a" }));

describe("paired decision records", () => {
  it("produces every field the tog2138-decision-v1 schema requires", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: MODELS_WITH_LANES }),
    });

    const record = buildShadowRecord({
      issueId: "i1",
      issueIdentifier: "TOG-1",
      nowIso: NOW_ISO,
      decision,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      status: "todo",
      hasOverride: false,
      hasOperatorPin: false,
      isIdle: true,
      models: MODELS_WITH_LANES,
      laneLedger: { "lane-a": { laneId: "lane-a", verdict: verdict(), fetchedAt: NOW_ISO, error: null, observation: null } },
      slotFloorFraction: 0.25,
      windowNames: WINDOW_NAMES,
      operatorOverride: null,
    });

    expect(record.schema).toBe(SHADOW_SCHEMA_VERSION);
    expect(record.writer).toBe("plugin-shadow");
    expect(record.issueId).toBe("i1");
    expect(record.issueIdentifier).toBe("TOG-1");
    expect(record.ts).toBe(NOW_ISO);
    expect(["new-card", "repin"]).toContain(record.trigger);
    expect(["T1", "T2", "T3"]).toContain(record.tier);
    expect(record.pickedModel).toBe(decision.modelId);
    expect(record.stateFingerprint).toEqual({
      status: "todo",
      hadOverride: false,
      hadRunningRun: false,
      pinOperator: false,
    });
    expect(record.laneSnapshot.quality).toBe("live");
    expect(record.laneSnapshot.laneFetchErrors).toEqual([]);
    expect(record.laneSnapshot.lanes["lane-a"]).toMatchObject({
      // This verdict carries a lane `score.utilization` of 0.42 but no
      // accounts, so neither named window is observable. Both columns are
      // `null` — NOT the governing 0.42 they used to copy, and not 0.
      weekly: null,
      fiveHour: null,
      state: "available",
      paceDeviation: -0.08,
      targetBurnRate: null,
      observedBurnRate: null,
      deficit: null,
    });
    expect(record.candidates.length).toBeGreaterThan(0);
    for (const candidate of record.candidates) {
      expect(candidate).toMatchObject({ capable: true, usable: true, proven: true });
      expect(typeof candidate.blended).toBe("number");
      expect(candidate.lane).toBe("lane-a");
    }
    expect(record.laneSnapshot.lanes["lane-a"]!.accounts).toEqual([]);
    expect(record.explanations).toEqual([]);
    expect(record.operatorOverride).toBeNull();
    expect(typeof record.pickWhy).toBe("string");
  });

  it("builds a host projection from the identical decision snapshot", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i-host", labelNames: ["tier:T3"] },
      config: config({ models: MODELS_WITH_LANES }),
    });
    const input = {
      issueId: "i-host",
      issueIdentifier: "TOG-HOST",
      nowIso: NOW_ISO,
      decision,
      descriptor: { issueId: "i-host", labelNames: ["tier:T3"] },
      status: "todo",
      hasOverride: false,
      hasOperatorPin: false,
      isIdle: true,
      models: MODELS_WITH_LANES,
      laneLedger: { "lane-a": { laneId: "lane-a", verdict: verdict(), fetchedAt: NOW_ISO, error: null, observation: null } },
      slotFloorFraction: 0.25,
      windowNames: WINDOW_NAMES,
      operatorOverride: null,
    };

    const host = buildHostRecord(input);
    const shadow = buildShadowRecord(input);

    expect(host).toEqual({ ...shadow, writer: "host" });
    expect(host.schema).toBe(SHADOW_SCHEMA_VERSION);
    expect(host.ts).toBe(shadow.ts);
    expect(host.stateFingerprint).toEqual(shadow.stateFingerprint);
    expect(host.candidates).toEqual(shadow.candidates);
  });

  it("emits each account's serving posture in the paired decision log", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i-accounts", labelNames: ["tier:T3"] },
      config: config({ models: MODELS_WITH_LANES }),
    });
    const record = buildShadowRecord({
      issueId: "i-accounts",
      issueIdentifier: "TOG-ACCOUNTS",
      nowIso: NOW_ISO,
      decision,
      descriptor: { issueId: "i-accounts", labelNames: ["tier:T3"] },
      status: "todo",
      hasOverride: false,
      hasOperatorPin: false,
      isIdle: true,
      models: MODELS_WITH_LANES,
      laneLedger: {
        "lane-a": {
          laneId: "lane-a",
          verdict: verdict({
            targetBurnRate: 0.25,
            observedBurnRate: 0,
            deficit: 5.4,
            accounts: [
              {
                accountKey: "claude-lane-1",
                authKey: "auth-1",
                plan: "max-20x",
                health: "healthy",
                weight: 20,
                weightSource: "reported",
                governingWindow: "weekly",
                governingResetAt: "2026-09-20T12:00:00.000Z",
                bindingWindow: "weekly",
                bindingResetAt: "2026-09-20T12:00:00.000Z",
                serviceable: true,
                state: "behind",
                score: { utilization: 0.02, elapsed: 0.29, deviation: -0.27 },
                paceDebt: 5.4,
                clearRate: 0.25,
              },
              {
                accountKey: "claude-lane-2",
                authKey: "auth-2",
                plan: "max-5x",
                health: "exhausted",
                weight: 5,
                weightSource: "reported",
                governingWindow: "weekly",
                governingResetAt: "2026-09-20T12:00:00.000Z",
                bindingWindow: "weekly",
                bindingResetAt: "2026-09-20T12:00:00.000Z",
                serviceable: false,
                state: "exhausted",
                score: { utilization: 1, elapsed: 0.29, deviation: 0.71 },
                paceDebt: -3.55,
                clearRate: 0,
              },
            ],
          }),
          fetchedAt: NOW_ISO,
          error: null,
          observation: observation(),
        },
      },
      slotFloorFraction: 0.25,
      windowNames: WINDOW_NAMES,
      operatorOverride: null,
    });

    expect(record.laneSnapshot.lanes["lane-a"]).toMatchObject({
      targetBurnRate: 0.25,
      observedBurnRate: 0,
      deficit: 5.4,
    });
    expect(record.laneSnapshot.lanes["lane-a"]!.accounts).toMatchObject([
      {
        accountKey: "claude-lane-1",
        authKey: "auth-1",
        plan: "max-20x",
        serviceable: true,
        governingWindow: "weekly",
        governingResetAt: "2026-09-20T12:00:00.000Z",
        bindingWindow: "weekly",
        bindingResetAt: "2026-09-20T12:00:00.000Z",
        targetBurnRate: 0.25,
        deficit: 5.4,
        recommendedShare: 1,
        desiredWeight: 1_000_000,
      },
      {
        accountKey: "claude-lane-2",
        authKey: "auth-2",
        plan: "max-5x",
        serviceable: false,
        targetBurnRate: 0,
        recommendedShare: 0,
        desiredWeight: 0,
      },
    ]);
  });

  it("projects an unknown account weight without inventing capacity", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i-unknown-weight", labelNames: ["tier:T3"] },
      config: config({ models: MODELS_WITH_LANES }),
    });
    const record = buildShadowRecord({
      issueId: "i-unknown-weight",
      issueIdentifier: null,
      nowIso: NOW_ISO,
      decision,
      descriptor: { issueId: "i-unknown-weight", labelNames: ["tier:T3"] },
      status: "todo",
      hasOverride: false,
      hasOperatorPin: false,
      isIdle: true,
      models: MODELS_WITH_LANES,
      laneLedger: {
        "lane-a": {
          laneId: "lane-a",
          verdict: verdict({
            state: "unknown",
            serviceable: null,
            score: null,
            reason: "indeterminate-account-weight",
            accounts: [{
              accountKey: "unknown-weight",
              health: "healthy",
              weight: null,
              weightSource: "unknown",
              governingWindow: "weekly",
              governingResetAt: "2026-09-20T12:00:00.000Z",
              serviceable: true,
              state: "unknown",
              score: null,
            }],
          }),
          fetchedAt: NOW_ISO,
          error: null,
          observation: observation(),
        },
      },
      slotFloorFraction: 0.25,
      windowNames: WINDOW_NAMES,
      operatorOverride: null,
    });

    expect(record.laneSnapshot.lanes["lane-a"]!.accounts[0]).toMatchObject({
      accountKey: "unknown-weight",
      weight: null,
      weightSource: "unknown",
      desiredWeight: 0,
    });
  });

  it("assigns final-24h push accounts priority 100 in the paired decision log", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i-push", labelNames: ["tier:T3"] },
      config: config({ models: MODELS_WITH_LANES }),
    });
    const record = buildShadowRecord({
      issueId: "i-push",
      issueIdentifier: null,
      nowIso: NOW_ISO,
      decision,
      descriptor: { issueId: "i-push", labelNames: ["tier:T3"] },
      status: "todo",
      hasOverride: false,
      hasOperatorPin: false,
      isIdle: true,
      models: MODELS_WITH_LANES,
      laneLedger: {
        "lane-a": {
          laneId: "lane-a",
          verdict: verdict({
            accounts: [{
              accountKey: "urgent",
              health: "healthy",
              weight: 20,
              weightSource: "reported",
              governingWindow: "weekly",
              governingResetAt: "2026-09-16T06:00:00.000Z",
              bindingWindow: "weekly",
              bindingResetAt: "2026-09-16T06:00:00.000Z",
              serviceable: true,
              state: "push",
              score: { utilization: 0.2, elapsed: 0.9, deviation: -0.7 },
              paceDebt: 14,
              clearRate: 0.8,
            }],
          }),
          fetchedAt: NOW_ISO,
          error: null,
          observation: observation(),
        },
      },
      slotFloorFraction: 0.25,
      windowNames: WINDOW_NAMES,
      operatorOverride: null,
    });

    expect(record.laneSnapshot.lanes["lane-a"]!.accounts[0]).toMatchObject({
      accountKey: "urgent",
      state: "push",
      desiredPriority: 100,
      desiredWeight: 1_000_000,
    });
  });

  it("maps an exhausted lane verdict to state exhausted, not available", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i2", labelNames: ["tier:T3"] },
      config: config({ models: MODELS_WITH_LANES }),
    });
    const record = buildShadowRecord({
      issueId: "i2",
      issueIdentifier: null,
      nowIso: NOW_ISO,
      decision,
      descriptor: { issueId: "i2", labelNames: ["tier:T3"] },
      status: "todo",
      hasOverride: false,
      hasOperatorPin: false,
      isIdle: true,
      models: MODELS_WITH_LANES,
      laneLedger: {
        "lane-a": {
          laneId: "lane-a",
          verdict: verdict({ state: "exhausted", serviceable: false, score: null }),
          fetchedAt: NOW_ISO,
          error: null,
          observation: null,
        },
      },
      slotFloorFraction: 0.25,
      windowNames: WINDOW_NAMES,
      operatorOverride: null,
    });
    expect(record.laneSnapshot.lanes["lane-a"]!.state).toBe("exhausted");
  });

  it("maps an unpolled lane (no ledger entry) to unavailable, not a false all-clear", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i3", labelNames: ["tier:T3"] },
      config: config({ models: MODELS_WITH_LANES }),
    });
    const record = buildShadowRecord({
      issueId: "i3",
      issueIdentifier: null,
      nowIso: NOW_ISO,
      decision,
      descriptor: { issueId: "i3", labelNames: ["tier:T3"] },
      status: "todo",
      hasOverride: false,
      hasOperatorPin: false,
      isIdle: true,
      models: MODELS_WITH_LANES,
      laneLedger: {} as LaneLedger,
      slotFloorFraction: 0.25,
      windowNames: WINDOW_NAMES,
      operatorOverride: null,
    });
    expect(record.laneSnapshot.lanes["lane-a"]!.state).toBe("unavailable");
    expect(record.laneSnapshot.quality).toBe("cached");
  });

  it("reports a live operator override with its id and expiry", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i4", labelNames: ["tier:T3"] },
      config: config({ models: MODELS_WITH_LANES }),
    });
    const record = buildShadowRecord({
      issueId: "i4",
      issueIdentifier: null,
      nowIso: NOW_ISO,
      decision,
      descriptor: { issueId: "i4", labelNames: ["tier:T3"] },
      status: "todo",
      hasOverride: true,
      hasOperatorPin: false,
      isIdle: true,
      models: MODELS_WITH_LANES,
      laneLedger: {},
      slotFloorFraction: 0.25,
      windowNames: WINDOW_NAMES,
      operatorOverride: {
        issueId: "i4",
        modelId: "claude-opus-5",
        setAt: NOW_ISO,
        expiresAt: "2026-09-10T13:00:00.000Z",
      },
    });
    expect(record.operatorOverride).toEqual({ id: "claude-opus-5", expiresAt: "2026-09-10T13:00:00.000Z" });
    expect(record.trigger).toBe("repin");
  });
});

/**
 * Regression cover for the defect measured on the live stream at `32aa30b9`:
 * `laneSnapshot.lanes[*].weekly` and `.fiveHour` were both written from
 * `verdict.score.utilization`, so they were byte-identical in 25,000/25,000
 * lane observations across 5,000 decisions. The quota page reads these two
 * columns, which meant a governing-window number was rendered under a
 * `fiveHour` label — a mislabelled reading, which is worse than a missing one
 * because it reads as a measurement. TOG-2482 Build item 1 is "the 5-hour
 * window binds first", and the 2026-09-11 incident lost 60 runs precisely
 * because weekly looked fine while 5h was gone.
 */
describe("per-lane window columns report their own window", () => {
  function paceWindow(overrides: Partial<PaceWindowVerdict> & { name: string; utilization: number }): PaceWindowVerdict {
    return {
      role: "allowance",
      resetsAt: "2026-09-20T12:00:00.000Z",
      windowSeconds: 604_800,
      allowanceWeight: 1,
      allowanceWeightSource: "reported",
      sourcePath: null,
      elapsed: 0.29,
      normalizedRemaining: 0.5,
      paceDebt: 0,
      clearRate: 0.25,
      serviceable: true,
      ...overrides,
    };
  }

  function account(
    accountKey: string,
    windows: PaceWindowVerdict[],
    overrides: Partial<LanePaceVerdict["accounts"][number]> = {},
  ): LanePaceVerdict["accounts"][number] {
    return {
      accountKey,
      authKey: `auth-${accountKey}`,
      plan: "max-20x",
      health: "healthy",
      weight: 20,
      weightSource: "reported",
      governingWindow: "weekly",
      governingResetAt: "2026-09-20T12:00:00.000Z",
      bindingWindow: "weekly",
      bindingResetAt: "2026-09-20T12:00:00.000Z",
      serviceable: true,
      state: "on",
      score: { utilization: 0.42, elapsed: 0.5, deviation: -0.08 },
      windows,
      ...overrides,
    };
  }

  function laneColumns(accounts: LanePaceVerdict["accounts"], windowNames = WINDOW_NAMES) {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i-win", labelNames: ["tier:T3"] },
      config: config({ models: MODELS_WITH_LANES }),
    });
    const record = buildShadowRecord({
      issueId: "i-win",
      issueIdentifier: "TOG-WIN",
      nowIso: NOW_ISO,
      decision,
      descriptor: { issueId: "i-win", labelNames: ["tier:T3"] },
      status: "todo",
      hasOverride: false,
      hasOperatorPin: false,
      isIdle: true,
      models: MODELS_WITH_LANES,
      laneLedger: {
        "lane-a": {
          laneId: "lane-a",
          verdict: verdict({ accounts }),
          fetchedAt: NOW_ISO,
          error: null,
          observation: observation(),
        },
      },
      slotFloorFraction: 0.25,
      windowNames,
      operatorOverride: null,
    });
    const lane = record.laneSnapshot.lanes["lane-a"]!;
    return { weekly: lane.weekly, fiveHour: lane.fiveHour };
  }

  it("does not copy one governing score into both columns", () => {
    // The governing score on every account here is 0.42 (see `account()`), the
    // number the old code copied. Neither column may come back as 0.42.
    const columns = laneColumns([
      account("a1", [
        paceWindow({ name: "weekly", utilization: 0.31 }),
        paceWindow({ name: "five-hour", utilization: 0.88, windowSeconds: 18_000 }),
      ]),
    ]);
    expect(columns).toEqual({ weekly: 0.31, fiveHour: 0.88 });
    expect(columns.weekly).not.toBe(columns.fiveHour);
    expect(columns.fiveHour).not.toBe(0.42);
  });

  it("surfaces an exhausted 5h window that a weight-weighted mean would hide", () => {
    // The 2026-09-11 shape: one account's 5h is gone while the lane's weekly
    // still looks roomy. A mean over these accounts reads 0.51; the column
    // must report the account that is about to stop serving.
    const columns = laneColumns([
      account("fresh", [
        paceWindow({ name: "weekly", utilization: 0.02 }),
        paceWindow({ name: "five-hour", utilization: 0.02, windowSeconds: 18_000 }),
      ]),
      account("gone", [
        paceWindow({ name: "weekly", utilization: 0.4 }),
        paceWindow({ name: "five-hour", utilization: 1, windowSeconds: 18_000, serviceable: false }),
      ], { health: "exhausted", serviceable: false, state: "exhausted" }),
    ]);
    expect(columns).toEqual({ weekly: 0.4, fiveHour: 1 });
  });

  it("reports null, never 0, for a window this lane does not observe", () => {
    // A `0` here would render on the quota page as "the 5-hour window is
    // untouched" for a window nobody has measured. `pacing.ts`'s
    // `laneNamedWindowUtilization` IS fail-neutral to 0 on purpose — it gates
    // admission and must not exclude on ignorance — so the reporting path
    // deliberately does not reuse it.
    const columns = laneColumns([account("weekly-only", [paceWindow({ name: "weekly", utilization: 0.31 })])]);
    expect(columns).toEqual({ weekly: 0.31, fiveHour: null });
    expect(columns.fiveHour).not.toBe(0);
  });

  it("still reports equal columns when the two windows genuinely agree", () => {
    // Positive control: the assertion above is "each column reads its own
    // window", not "the columns must differ". Equal inputs stay equal.
    const columns = laneColumns([
      account("a1", [
        paceWindow({ name: "weekly", utilization: 0.5 }),
        paceWindow({ name: "five-hour", utilization: 0.5, windowSeconds: 18_000 }),
      ]),
    ]);
    expect(columns).toEqual({ weekly: 0.5, fiveHour: 0.5 });
  });

  it("keys on the configured window names, not on hardcoded ones", () => {
    const columns = laneColumns(
      [
        account("a1", [
          paceWindow({ name: "rolling-7d", utilization: 0.33 }),
          paceWindow({ name: "5h", utilization: 0.77, windowSeconds: 18_000 }),
        ]),
      ],
      { weekly: "rolling-7d", fiveHour: "5h" },
    );
    expect(columns).toEqual({ weekly: 0.33, fiveHour: 0.77 });
  });
});
