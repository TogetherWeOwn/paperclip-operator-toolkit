import { describe, expect, it } from "vitest";

import {
  activeOperatorOverride,
  activeZaiPaceOverride,
  avoidThresholdFor,
  blendedListPrice,
  hardStopExcluded,
  isPreferredNearReset,
  isLaneOutageActive,
  laneAvoidExcluded,
  laneEffectiveUtilization,
  laneHasRoom,
  laneHealthyAccountCount,
  laneNamedWindowUtilization,
  laneOutageExcluded,
  mergeLedgerEntry,
  orderCandidatesByPace,
  preferredCandidateId,
  recordOperatorOverride,
  repinAllowed,
  slotAllowed,
  slotFactorFor,
  zaiPeakNow,
  zaiWeeklyPaceOk,
  ZAI_LONG_RUN_AGENTS,
  type LaneAvoidConfig,
  type LaneLedger,
  type LaneOutageOverride,
  type ZaiPaceOverride,
} from "../src/engine/pacing.js";
import { resolveConfig } from "../src/config/resolve.js";
import type { Candidate, ModelEntry } from "../src/engine/types.js";
import { evaluateLanePace, normalizeLaneDocument, type LanePaceObservation, type LanePaceVerdict, type PaceAccountObservation, type PaceWindowObservation } from "../src/lane-capacity/pace.js";

function verdict(overrides: Partial<LanePaceVerdict> = {}): LanePaceVerdict {
  return {
    laneId: "lane-a",
    observedAt: "2026-08-31T12:00:00.000Z",
    state: "on",
    serviceable: true,
    score: { utilization: 0.5, elapsed: 0.5, deviation: 0 },
    targetBurnRate: 0.1,
    observedBurnRate: 0.1,
    deficit: 0,
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 1,
    urgentResetAt: null,
    reason: "ok",
    ...overrides,
  };
}

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "m1",
    tier: "T1",
    enabled: true,
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    costPerMTokCacheRead: 1,
    capabilities: [],
    contextWindow: 200_000,
    aaIndex: null,
    releasedAt: "2026-01-01",
    fallbackOnly: false,
    note: "",
    earnIn: null,
    laneId: "lane-a",
    ...overrides,
  };
}

function window(overrides: Partial<PaceWindowObservation> = {}): PaceWindowObservation {
  return {
    name: "five_hour",
    role: "allowance",
    utilization: 0.3,
    resetsAt: "2026-09-08T17:00:00.000Z",
    windowSeconds: 5 * 60 * 60,
    sourcePath: null,
    ...overrides,
  };
}

function account(overrides: Partial<PaceAccountObservation> = {}): PaceAccountObservation {
  return {
    accountKey: "acct-1",
    health: "healthy",
    weight: 1,
    weightSource: "reported",
    governingWindow: "five_hour",
    windows: [window()],
    ...overrides,
  };
}

function observation(overrides: Partial<LanePaceObservation> = {}): LanePaceObservation {
  return {
    laneId: "lane-a",
    free: false,
    observedAt: "2026-09-08T12:00:00.000Z",
    staleAfterSeconds: 900,
    accounts: [account()],
    error: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    modelId: "m1",
    tier: "T1",
    releasedAt: "2026-01-01",
    fallbackOnly: false,
    expectedCostUsd: 1,
    runCostUsd: 1,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheReadCostUsd: 0,
    escalationRiskUsd: 0,
    profileTier: "T1",
    profileTrusted: true,
    ...overrides,
  };
}

describe("multi-account lane pace", () => {
  const definition = {
    laneId: "cliproxy-claude",
    healthFields: ["health"],
    accountKeyFields: ["lane"],
    weightFields: ["weight"],
    governingWindowField: "governing_window",
    windows: [
      {
        name: "weekly",
        role: "allowance" as const,
        utilizationFields: ["seven_day_utilization"],
        resetFields: ["seven_day_resets_at"],
        defaultWindowSeconds: 7 * 24 * 60 * 60,
      },
    ],
  };

  function evaluate(records: Record<string, unknown>[]) {
    const observedAt = "2026-09-15T12:00:00.000Z";
    return evaluateLanePace({
      observation: normalizeLaneDocument({
        document: { observedAt, records },
        definition,
      }),
      asOf: observedAt,
    });
  }

  it("paces from accounts that can still serve, not the average of a fresh and exhausted account", () => {
    const result = evaluate([
      {
        lane: "claude-lane-1",
        health: "healthy",
        weight: 20,
        governing_window: "weekly",
        seven_day_utilization: 0.02,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      },
      {
        lane: "claude-lane-2",
        health: "exhausted",
        weight: 5,
        governing_window: "weekly",
        seven_day_utilization: 1,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      },
    ]);

    expect(result.score?.utilization).toBe(0.02);
    expect(result.knownAccountCount).toBe(1);
    expect(result.knownWeight).toBe(20);
    expect(result.serviceableAccountCount).toBe(1);
    expect(result.accounts).toMatchObject([
      { accountKey: "claude-lane-1", serviceable: true, weight: 20 },
      { accountKey: "claude-lane-2", serviceable: false, weight: 5, state: "exhausted" },
    ]);
  });

  it("drops unavailable and weekly-saturated accounts even when their health labels are not exhausted", () => {
    const result = evaluate([
      {
        lane: "serving",
        health: "healthy",
        weight: 1,
        governing_window: "weekly",
        seven_day_utilization: 0.25,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      },
      {
        lane: "unavailable",
        health: "unavailable",
        governing_window: "weekly",
        seven_day_utilization: 0.7,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      },
      {
        lane: "weekly-full",
        health: "healthy",
        governing_window: "weekly",
        seven_day_utilization: 1,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      },
    ]);

    expect(result.score?.utilization).toBe(0.25);
    expect(result.knownAccountCount).toBe(1);
    expect(result.serviceableAccountCount).toBe(1);
  });

  it("marks the lane fully exhausted when every account is unavailable or saturated", () => {
    const result = evaluate([
      {
        lane: "unavailable",
        health: "unavailable",
        governing_window: "weekly",
        seven_day_utilization: 0.6,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      },
      {
        lane: "weekly-full",
        health: "healthy",
        governing_window: "weekly",
        seven_day_utilization: 1,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      },
    ]);

    expect(result.state).toBe("exhausted");
    expect(result.serviceable).toBe(false);
    expect(result.score).toBeNull();
    expect(result.serviceableAccountCount).toBe(0);
  });

  it("weights the serviceable provider aggregate by explicit allowance capacity", () => {
    const result = evaluate([
      {
        lane: "max-20x",
        health: "healthy",
        weight: 20,
        governing_window: "weekly",
        seven_day_utilization: 0.1,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      },
      {
        lane: "max-5x",
        health: "healthy",
        weight: 5,
        governing_window: "weekly",
        seven_day_utilization: 0.9,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      },
    ]);

    expect(result.score?.utilization).toBe(0.26);
    expect(result.knownWeight).toBe(25);
  });

  it("uses production plan_weight fields when the lane config does not override them", () => {
    const config = resolveConfig({
      pacing: {
        lanes: [{
          laneId: "cliproxy-claude",
          statusUrl: "https://status.example/claude",
          accountKeyFields: ["account_key"],
          windows: [{
            name: "weekly",
            role: "allowance",
            utilizationFields: ["seven_day_utilization"],
            resetFields: ["seven_day_resets_at"],
            defaultWindowSeconds: 7 * 24 * 60 * 60,
          }],
        }],
      },
    });
    const observedAt = "2026-09-15T12:00:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [
            { account_key: "max-20x", health: "healthy", plan_weight: 20, seven_day_utilization: 0.1, seven_day_resets_at: "2026-09-20T12:00:00.000Z" },
            { account_key: "max-5x", health: "healthy", plan_weight: 5, seven_day_utilization: 0.9, seven_day_resets_at: "2026-09-20T12:00:00.000Z" },
          ],
        },
        definition: config.pacing.lanes[0]!.lane,
      }),
      asOf: observedAt,
    });

    expect(config.pacing.lanes[0]!.lane.weightFields).toEqual(["plan_weight", "weight"]);
    expect(result.score?.utilization).toBe(0.26);
    expect(result.knownWeight).toBe(25);
  });

  it("lets an explicit allowance weight override the account plan weight", () => {
    const observedAt = "2026-09-15T12:00:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [{
            account_key: "max-20x",
            plan_weight: 20,
            health: "healthy",
            windows: [{
              name: "weekly",
              role: "allowance",
              utilization: 0.2,
              resets_at: "2026-09-20T12:00:00.000Z",
              window_seconds: 604800,
              allowance_weight: 2,
            }],
          }],
        },
        definition: {
          laneId: "cliproxy-claude",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          windows: [{ name: "weekly", role: "allowance", utilizationFields: [], resetFields: [] }],
        },
      }),
      asOf: observedAt,
    });

    expect(result.accounts[0]).toMatchObject({ weight: 20, weightSource: "reported" });
    expect(result.accounts[0]?.windows?.[0]).toMatchObject({ allowanceWeight: 2, allowanceWeightSource: "reported" });
    expect(result.knownWeight).toBe(2);
  });

  it("treats absent or invalid production weights as indeterminate", () => {
    for (const weight of [undefined, null, 0, -1, "20", Number.NaN]) {
      const record: Record<string, unknown> = {
        lane: "unknown-weight",
        health: "healthy",
        governing_window: "weekly",
        seven_day_utilization: 0.2,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      };
      if (weight !== undefined) record.weight = weight;
      const result = evaluate([record]);

      expect(result).toMatchObject({
        state: "unknown",
        serviceable: null,
        score: null,
        reason: "indeterminate-account-weight",
      });
      expect(result.accounts[0]).toMatchObject({ weight: null, weightSource: "unknown" });
    }
  });

  it("does not aggregate a known account while another serviceable account has unknown weight", () => {
    const result = evaluate([
      {
        lane: "known",
        health: "healthy",
        weight: 20,
        governing_window: "weekly",
        seven_day_utilization: 0.1,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      },
      {
        lane: "unknown",
        health: "healthy",
        governing_window: "weekly",
        seven_day_utilization: 0.9,
        seven_day_resets_at: "2026-09-20T12:00:00.000Z",
      },
    ]);

    expect(result).toMatchObject({
      state: "unknown",
      serviceable: null,
      score: null,
      reason: "indeterminate-account-weight",
      knownAccountCount: 1,
      knownWeight: 20,
    });
  });

  it("binds a multi-window account on the allowance with the smallest sustainable clear rate", () => {
    const observedAt = "2026-09-15T12:00:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [
            {
              account_key: "go-2",
              plan: "go",
              plan_weight: 1,
              health: "healthy",
              windows: [
                {
                  name: "weekly",
                  role: "allowance",
                  utilization: 0,
                  resets_at: "2026-09-21T12:00:00.000Z",
                  window_seconds: 604800,
                  allowance_weight: 1,
                },
                {
                  name: "monthly",
                  role: "allowance",
                  utilization: 0.99,
                  resets_at: "2026-09-23T12:00:00.000Z",
                  window_seconds: 2592000,
                  allowance_weight: 1,
                },
              ],
            },
          ],
        },
        definition: {
          laneId: "opencode-go",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          weightFields: ["plan_weight"],
          windows: [
            { name: "weekly", role: "allowance", utilizationFields: [], resetFields: [] },
            { name: "monthly", role: "allowance", utilizationFields: [], resetFields: [] },
          ],
        },
      }),
      asOf: observedAt,
    });

    expect(result.accounts[0]).toMatchObject({
      accountKey: "go-2",
      bindingWindow: "monthly",
      bindingResetAt: "2026-09-23T12:00:00.000Z",
      serviceable: true,
    });
    expect(result.score?.utilization).toBe(0.99);
  });

  it("preserves the first-party Go D02/D03/D04 values and computes monthly target rates and deficit-weighted shares", () => {
    const observedAt = "2026-09-15T14:10:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [
            {
              account_key: "go-1",
              plan: "go",
              health: "healthy",
              recent_burn_units_per_hour: 0,
              windows: [
                { name: "five-hour", role: "allowance", utilization: 0.81, resets_at: "2026-09-15T19:10:00.000Z", window_seconds: 18_000, allowance_weight: 0.2 },
                { name: "weekly", role: "allowance", utilization: 0.61, resets_at: "2026-09-21T00:00:00.000Z", window_seconds: 604_800, allowance_weight: 0.5 },
                { name: "monthly", role: "allowance", utilization: 0.33, resets_at: "2026-10-12T07:01:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
              ],
            },
            {
              account_key: "go-2",
              plan: "go",
              health: "healthy",
              recent_burn_units_per_hour: 0,
              windows: [
                { name: "five-hour", role: "allowance", utilization: 0, resets_at: "2026-09-15T19:10:00.000Z", window_seconds: 18_000, allowance_weight: 0.2 },
                { name: "weekly", role: "allowance", utilization: 0, resets_at: "2026-09-21T00:00:00.000Z", window_seconds: 604_800, allowance_weight: 0.5 },
                { name: "monthly", role: "allowance", utilization: 0.99, resets_at: "2026-09-23T12:57:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
              ],
            },
            {
              account_key: "go-3",
              plan: "go",
              health: "healthy",
              recent_burn_units_per_hour: 0,
              windows: [
                { name: "five-hour", role: "allowance", utilization: 0, resets_at: "2026-09-15T19:10:00.000Z", window_seconds: 18_000, allowance_weight: 0.2 },
                { name: "weekly", role: "allowance", utilization: 0.08, resets_at: "2026-09-21T00:00:00.000Z", window_seconds: 604_800, allowance_weight: 0.5 },
                { name: "monthly", role: "allowance", utilization: 0.95, resets_at: "2026-10-06T15:20:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
              ],
            },
          ],
        },
        definition: {
          laneId: "cliproxy-opencode-go",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          windows: [
            { name: "five-hour", role: "allowance", utilizationFields: [], resetFields: [] },
            { name: "weekly", role: "allowance", utilizationFields: [], resetFields: [] },
            { name: "monthly", role: "allowance", utilizationFields: [], resetFields: [] },
          ],
        },
      }),
      asOf: observedAt,
    });

    expect(result.accounts.map((account) => ({
      id: account.accountKey,
      window: account.bindingWindow,
      reset: account.bindingResetAt,
    }))).toEqual([
      { id: "go-1", window: "monthly", reset: "2026-10-12T07:01:00.000Z" },
      { id: "go-2", window: "monthly", reset: "2026-09-23T12:57:00.000Z" },
      { id: "go-3", window: "monthly", reset: "2026-10-06T15:20:00.000Z" },
    ]);
    expect(result.accounts[0]?.normalizedRemaining).toBeCloseTo(0.67, 12);
    expect(result.accounts[1]?.normalizedRemaining).toBeCloseTo(0.01, 12);
    expect(result.accounts[2]?.normalizedRemaining).toBeCloseTo(0.05, 12);

    const ratesPerDay = result.accounts.map((account) => (account.targetBurnRate ?? 0) * 24);
    expect(ratesPerDay[0]).toBeCloseTo(0.025092, 6);
    expect(ratesPerDay[1]).toBeCloseTo(0.001258, 6);
    expect(ratesPerDay[2]).toBeCloseTo(0.002375, 6);
    expect(result.accounts[0]?.recommendedShare).toBeCloseTo(0.8735, 4);
    expect(result.accounts[1]?.recommendedShare).toBeCloseTo(0.0438, 4);
    expect(result.accounts[2]?.recommendedShare).toBeCloseTo(0.0827, 4);
    expect(result.accounts[0]?.recommendedShare).not.toBeCloseTo(1 / 3, 2);
  });

  it("consumes subscription-pool governing outputs and sums serviceable account target rates", () => {
    const observedAt = "2026-09-15T14:10:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [
            {
              account_key: "go-1",
              health: "healthy",
              governing_window: "monthly",
              governing_reset_at: "2026-10-12T07:01:00.000Z",
              normalized_remaining: 0.67,
              target_burn_rate: 0.025092 / 24,
              observed_burn_rate: 0.0002,
              deficit: 0.0008455,
              recommended_share: 0.8735,
              windows: [
                { name: "five-hour", role: "serviceability", utilization: 0.81, resets_at: "2026-09-15T19:10:00.000Z", window_seconds: 18_000 },
                { name: "weekly", role: "serviceability", utilization: 0.61, resets_at: "2026-09-21T00:00:00.000Z", window_seconds: 604_800 },
                { name: "monthly", role: "allowance", utilization: 0.33, resets_at: "2026-10-12T07:01:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
              ],
            },
            {
              account_key: "go-2",
              health: "healthy",
              governing_window: "monthly",
              governing_reset_at: "2026-09-23T12:57:00.000Z",
              normalized_remaining: 0.01,
              target_burn_rate: 0.001258 / 24,
              observed_burn_rate: 0,
              deficit: 0.0000524,
              recommended_share: 0.0438,
              windows: [
                { name: "five-hour", role: "serviceability", utilization: 0, resets_at: "2026-09-15T19:10:00.000Z", window_seconds: 18_000 },
                { name: "weekly", role: "serviceability", utilization: 0, resets_at: "2026-09-21T00:00:00.000Z", window_seconds: 604_800 },
                { name: "monthly", role: "allowance", utilization: 0.99, resets_at: "2026-09-23T12:57:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
              ],
            },
            {
              account_key: "go-3",
              health: "healthy",
              governing_window: "monthly",
              governing_reset_at: "2026-10-06T15:20:00.000Z",
              normalized_remaining: 0.05,
              target_burn_rate: 0.002375 / 24,
              observed_burn_rate: 0,
              deficit: 0.0000989,
              recommended_share: 0.0827,
              windows: [
                { name: "five-hour", role: "serviceability", utilization: 0, resets_at: "2026-09-15T19:10:00.000Z", window_seconds: 18_000 },
                { name: "weekly", role: "serviceability", utilization: 0.08, resets_at: "2026-09-21T00:00:00.000Z", window_seconds: 604_800 },
                { name: "monthly", role: "allowance", utilization: 0.95, resets_at: "2026-10-06T15:20:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
              ],
            },
          ],
        },
        definition: {
          laneId: "cliproxy-opencode-go",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          windows: [
            { name: "five-hour", role: "serviceability", utilizationFields: [], resetFields: [] },
            { name: "weekly", role: "serviceability", utilizationFields: [], resetFields: [] },
            { name: "monthly", role: "allowance", utilizationFields: [], resetFields: [] },
          ],
        },
      }),
      asOf: observedAt,
    });

    expect(result.accounts.map((account) => account.accountKey)).toEqual(["go-1", "go-2", "go-3"]);
    expect(result.accounts.map((account) => account.recommendedShare)).toEqual([0.8735, 0.0438, 0.0827]);
    expect((result.targetBurnRate ?? 0) * 24).toBeCloseTo(0.028725, 6);
    expect(result.accounts[0]).toMatchObject({
      governingWindow: "monthly",
      governingResetAt: "2026-10-12T07:01:00.000Z",
      normalizedRemaining: 0.67,
      targetBurnRate: 0.025092 / 24,
      observedBurnRate: 0.0002,
      deficit: 0.0008455,
    });
  });

  it("refuses to pace a declared monthly governor off another allowance window", () => {
    const observedAt = "2026-09-15T14:10:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [
            {
              account_key: "go-1",
              health: "healthy",
              governing_window: "monthly",
              windows: [
                { name: "weekly", role: "allowance", utilization: 0.1, resets_at: "2026-09-21T00:00:00.000Z", window_seconds: 604_800, allowance_weight: 0.5 },
                // The declared governor: present, but this snapshot carries no
                // reset for it, so its clear rate is not computable.
                { name: "monthly", role: "allowance", utilization: 0.33, window_seconds: 2_592_000, allowance_weight: 1 },
              ],
            },
          ],
        },
        definition: {
          laneId: "cliproxy-opencode-go",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          windows: [
            { name: "weekly", role: "allowance", utilizationFields: [], resetFields: [] },
            { name: "monthly", role: "allowance", utilizationFields: [], resetFields: [] },
          ],
        },
      }),
      asOf: observedAt,
    });

    expect(result).toMatchObject({
      state: "unknown",
      serviceable: null,
      score: null,
      reason: "invalid-configured-governing-window",
    });
    expect(result.accounts[0]).toMatchObject({
      accountKey: "go-1",
      bindingWindow: null,
      serviceable: false,
      recommendedShare: 0,
    });
  });

  it("refuses to pace a declared governor that is absent off a serviceability window", () => {
    const observedAt = "2026-09-15T14:10:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [
            {
              account_key: "go-1",
              health: "healthy",
              governing_window: "monthly",
              windows: [
                { name: "five-hour", role: "serviceability", utilization: 0.81, resets_at: "2026-09-15T19:10:00.000Z", window_seconds: 18_000 },
                { name: "weekly", role: "serviceability", utilization: 0.61, resets_at: "2026-09-21T00:00:00.000Z", window_seconds: 604_800 },
              ],
            },
          ],
        },
        definition: {
          laneId: "cliproxy-opencode-go",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          windows: [
            { name: "five-hour", role: "serviceability", utilizationFields: [], resetFields: [] },
            { name: "weekly", role: "serviceability", utilizationFields: [], resetFields: [] },
          ],
        },
      }),
      asOf: observedAt,
    });

    expect(result).toMatchObject({
      state: "unknown",
      serviceable: null,
      score: null,
      reason: "invalid-configured-governing-window",
    });
    expect(result.accounts[0]).toMatchObject({ serviceable: false, recommendedShare: 0 });
  });

  it("keeps recommended shares a partition of the lane when only some accounts report one", () => {
    const observedAt = "2026-09-15T14:10:00.000Z";
    const record = (accountKey: string, reported: number | null) => ({
      account_key: accountKey,
      health: "healthy",
      governing_window: "monthly",
      governing_reset_at: "2026-10-12T07:01:00.000Z",
      normalized_remaining: 0.5,
      target_burn_rate: 0.001,
      observed_burn_rate: 0,
      deficit: 0.001,
      ...(reported === null ? {} : { recommended_share: reported }),
      windows: [
        { name: "monthly", role: "allowance", utilization: 0.5, resets_at: "2026-10-12T07:01:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
      ],
    });
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: { observedAt, records: [record("reports", 1), record("silent", null)] },
        definition: {
          laneId: "cliproxy-opencode-go",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          windows: [{ name: "monthly", role: "allowance", utilizationFields: [], resetFields: [] }],
        },
      }),
      asOf: observedAt,
    });

    const shares = result.accounts.map((account) => account.recommendedShare ?? 0);
    // A reported 1.00 normalized against reported shares alone, plus a silent
    // account normalized against deficits alone, hands out 200% of the lane.
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 10);
    expect(shares.every((share) => share > 0)).toBe(true);
    expect(shares).toEqual([0.5, 0.5]);
  });

  it.each(["five-hour", "weekly", "monthly"])("keeps %s as a hard serviceability gate when monthly governs", (saturatedWindow) => {
    const observedAt = "2026-09-15T14:10:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [{
            account_key: "go-hard-gate",
            health: "healthy",
            governing_window: "monthly",
            target_burn_rate: 0.01,
            recommended_share: 1,
            windows: [
              { name: "five-hour", role: "serviceability", utilization: saturatedWindow === "five-hour" ? 1 : 0.1, resets_at: "2026-09-15T19:10:00.000Z", window_seconds: 18_000 },
              { name: "weekly", role: "serviceability", utilization: saturatedWindow === "weekly" ? 1 : 0.1, resets_at: "2026-09-21T00:00:00.000Z", window_seconds: 604_800 },
              { name: "monthly", role: "allowance", utilization: saturatedWindow === "monthly" ? 1 : 0.1, resets_at: "2026-10-12T07:01:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
            ],
          }],
        },
        definition: {
          laneId: "cliproxy-opencode-go",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          windows: [
            { name: "five-hour", role: "serviceability", utilizationFields: [], resetFields: [] },
            { name: "weekly", role: "serviceability", utilizationFields: [], resetFields: [] },
            { name: "monthly", role: "allowance", utilizationFields: [], resetFields: [] },
          ],
        },
      }),
      asOf: observedAt,
    });

    expect(result.serviceable).toBe(false);
    expect(result.accounts[0]?.serviceable).toBe(false);
    expect(result.targetBurnRate).toBe(0);
  });

  it("positive control: the same account can switch from monthly to weekly when weekly truly has the smaller clear rate", () => {
    const observedAt = "2026-09-15T14:10:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [{
            account_key: "go-positive-control",
            health: "healthy",
            windows: [
              { name: "weekly", role: "allowance", utilization: 0.99, resets_at: "2026-09-21T00:00:00.000Z", window_seconds: 604_800, allowance_weight: 0.5 },
              { name: "monthly", role: "allowance", utilization: 0.2, resets_at: "2026-10-12T07:01:00.000Z", window_seconds: 2_592_000, allowance_weight: 1 },
            ],
          }],
        },
        definition: {
          laneId: "cliproxy-opencode-go",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          windows: [
            { name: "weekly", role: "allowance", utilizationFields: [], resetFields: [] },
            { name: "monthly", role: "allowance", utilizationFields: [], resetFields: [] },
          ],
        },
      }),
      asOf: observedAt,
    });

    expect(result.accounts[0]?.bindingWindow).toBe("weekly");
  });

  it("elevates the lane when a serviceable account is behind inside its final 24 hours", () => {
    const observedAt = "2026-09-15T12:00:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [
            {
              account_key: "claude-company",
              plan_weight: 20,
              health: "healthy",
              windows: [
                {
                  name: "weekly",
                  role: "allowance",
                  utilization: 0.2,
                  resets_at: "2026-09-16T06:00:00.000Z",
                  window_seconds: 604800,
                  allowance_weight: 20,
                },
              ],
            },
            {
              account_key: "claude-other",
              plan_weight: 5,
              health: "healthy",
              windows: [
                {
                  name: "weekly",
                  role: "allowance",
                  utilization: 0.8,
                  resets_at: "2026-09-20T12:00:00.000Z",
                  window_seconds: 604800,
                  allowance_weight: 5,
                },
              ],
            },
          ],
        },
        definition: {
          laneId: "cliproxy-claude",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          weightFields: ["plan_weight"],
          windows: [{ name: "weekly", role: "allowance", utilizationFields: [], resetFields: [] }],
        },
      }),
      asOf: observedAt,
    });

    expect(result.accounts[0]?.state).toBe("push");
    expect(result.state).toBe("behind-urgent");
    expect(result.urgentResetAt).toBe("2026-09-16T06:00:00.000Z");
  });

  it("does not let an aggregate-ahead account mask another account's final-24h push", () => {
    const observedAt = "2026-09-15T12:00:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [
            {
              account_key: "urgent-small",
              plan_weight: 1,
              health: "healthy",
              windows: [
                {
                  name: "weekly",
                  role: "allowance",
                  utilization: 0.2,
                  resets_at: "2026-09-16T06:00:00.000Z",
                  window_seconds: 604800,
                  allowance_weight: 1,
                },
              ],
            },
            {
              account_key: "ahead-large",
              plan_weight: 20,
              health: "healthy",
              windows: [
                {
                  name: "weekly",
                  role: "allowance",
                  utilization: 0.9,
                  resets_at: "2026-09-20T12:00:00.000Z",
                  window_seconds: 604800,
                  allowance_weight: 20,
                },
              ],
            },
          ],
        },
        definition: {
          laneId: "cliproxy-claude",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          weightFields: ["plan_weight"],
          windows: [{ name: "weekly", role: "allowance", utilizationFields: [], resetFields: [] }],
        },
      }),
      asOf: observedAt,
    });

    expect(result.score?.deviation).toBeGreaterThan(0);
    expect(result.accounts[0]?.state).toBe("push");
    expect(result.state).toBe("behind-urgent");
    expect(result.urgentResetAt).toBe("2026-09-16T06:00:00.000Z");
  });

  it("marks an account unavailable when its own telemetry freshness budget is exceeded", () => {
    const observedAt = "2026-09-15T12:00:00.000Z";
    const result = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: {
          observedAt,
          records: [
            {
              account_key: "stale-account",
              stale_after_seconds: 60,
              health: "healthy",
              windows: [
                {
                  name: "weekly",
                  role: "allowance",
                  utilization: 0.1,
                  resets_at: "2026-09-20T12:00:00.000Z",
                  window_seconds: 604800,
                  allowance_weight: 1,
                },
              ],
            },
          ],
        },
        definition: {
          laneId: "lane-a",
          healthFields: ["health"],
          accountKeyFields: ["account_key"],
          windows: [{ name: "weekly", role: "allowance", utilizationFields: [], resetFields: [] }],
        },
      }),
      asOf: "2026-09-15T12:02:00.000Z",
    });

    expect(result.serviceable).toBe(false);
    expect(result.state).toBe("exhausted");
    expect(result.accounts[0]?.serviceable).toBe(false);
  });

  it("rejects missing, blank, or non-string account identities instead of synthesizing record positions", () => {
    for (const invalid of [{}, { lane: "  " }, { lane: 7 }]) {
      const observation = normalizeLaneDocument({
        document: {
          observedAt: "2026-09-15T12:00:00.000Z",
          records: [{ lane: "claude-lane-1" }, invalid],
        },
        definition,
      });
      const result = evaluateLanePace({ observation, asOf: "2026-09-15T12:00:00.000Z" });

      expect(observation.error).toBe("invalid-account-identity");
      expect(JSON.stringify(observation)).not.toContain("record-");
      expect(result).toMatchObject({
        state: "unknown",
        serviceable: null,
        reason: "invalid-account-identity",
      });
    }
  });

  it("rejects duplicate account identities", () => {
    const observation = normalizeLaneDocument({
      document: {
        observedAt: "2026-09-15T12:00:00.000Z",
        records: [{ lane: "duplicate" }, { lane: "duplicate" }],
      },
      definition,
    });

    expect(observation.error).toBe("invalid-account-identity");
    expect(evaluateLanePace({ observation })).toMatchObject({
      state: "unknown",
      serviceable: null,
      reason: "invalid-account-identity",
    });
  });

  it("preserves explicit account identities across record reordering", () => {
    const document = (records: Record<string, unknown>[]) => normalizeLaneDocument({
      document: { observedAt: "2026-09-15T12:00:00.000Z", records },
      definition,
    });
    const first = document([{ lane: "account-a", weight: 1 }, { lane: "account-b", weight: 1 }]);
    const reordered = document([{ lane: "account-b", weight: 1 }, { lane: "account-a", weight: 1 }]);

    expect(first.accounts.map((row) => row.accountKey).sort()).toEqual(["account-a", "account-b"]);
    expect(reordered.accounts.map((row) => row.accountKey).sort()).toEqual(["account-a", "account-b"]);
  });
});

describe("mergeLedgerEntry", () => {
  it("never lets a failed poll overwrite a good verdict with a fabricated one — a failure always records null", () => {
    // Named mutant: "stale snapshot used". A prior poll returned a good
    // verdict; this poll failed. The merge must record the FAILURE (verdict
    // null, error set), never silently keep serving the old good verdict
    // relabeled as fresh, and never invent a new verdict out of the failure.
    let ledger: LaneLedger = {};
    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "2026-08-31T12:00:00.000Z",
      verdict: verdict({ state: "behind" }),
      error: null,
    });
    expect(ledger["lane-a"]!.verdict!.state).toBe("behind");

    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "2026-08-31T12:05:00.000Z",
      verdict: null,
      error: "lane-request-timeout",
    });
    expect(ledger["lane-a"]!.verdict).toBeNull();
    expect(ledger["lane-a"]!.error).toBe("lane-request-timeout");
  });

  it("keys strictly by laneId — one lane's entry never leaks into another's", () => {
    // Named mutant: "lane key logged" (a poll result attributed to the wrong
    // lane). Merging a result for lane-b must not disturb lane-a's entry.
    let ledger: LaneLedger = {};
    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "t1",
      verdict: verdict({ laneId: "lane-a", state: "behind" }),
      error: null,
    });
    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-b",
      fetchedAt: "t2",
      verdict: verdict({ laneId: "lane-b", state: "ahead" }),
      error: null,
    });
    expect(ledger["lane-a"]!.verdict!.state).toBe("behind");
    expect(ledger["lane-b"]!.verdict!.state).toBe("ahead");
    expect(Object.keys(ledger).sort()).toEqual(["lane-a", "lane-b"]);
  });
});

describe("orderCandidatesByPace", () => {
  it("never lets pace move a candidate ahead of one in a cheaper/more-restrictive tier", () => {
    // Named mutant: "pace crosses tiers". A T2 candidate with a perfect pace
    // score (behind-urgent) must never sort ahead of a T1 candidate, however
    // bad the T1 lane's pace state is (exhausted-adjacent "ahead" here).
    // Group order comes from first-appearance in the (already cost-sorted)
    // input array — T1 appears first here, matching select.ts's own ordering.
    const models = [
      model({ id: "t1-model", tier: "T1", laneId: "lane-t1" }),
      model({ id: "t2-model", tier: "T2", laneId: "lane-t2" }),
    ];
    const ledger: LaneLedger = {
      "lane-t1": { laneId: "lane-t1", fetchedAt: "t", error: null, observation: null, verdict: verdict({ laneId: "lane-t1", state: "ahead" }) },
      "lane-t2": { laneId: "lane-t2", fetchedAt: "t", error: null, observation: null, verdict: verdict({ laneId: "lane-t2", state: "behind-urgent" }) },
    };
    const candidates = [
      candidate({ modelId: "t1-model", tier: "T1", expectedCostUsd: 1 }),
      candidate({ modelId: "t2-model", tier: "T2", expectedCostUsd: 1 }),
    ];
    const ordered = orderCandidatesByPace(candidates, models, ledger);
    expect(ordered.map((c) => c.modelId)).toEqual(["t1-model", "t2-model"]);
  });

  it("orders within a tier by pace state, then deviation, then cost, then release date, then id", () => {
    const models = [
      model({ id: "behind-model", tier: "T1", laneId: "lane-behind" }),
      model({ id: "ahead-model", tier: "T1", laneId: "lane-ahead" }),
    ];
    const ledger: LaneLedger = {
      "lane-behind": { laneId: "lane-behind", fetchedAt: "t", error: null, observation: null, verdict: verdict({ laneId: "lane-behind", state: "behind" }) },
      "lane-ahead": { laneId: "lane-ahead", fetchedAt: "t", error: null, observation: null, verdict: verdict({ laneId: "lane-ahead", state: "ahead" }) },
    };
    const candidates = [
      candidate({ modelId: "ahead-model", tier: "T1", expectedCostUsd: 0.5 }),
      candidate({ modelId: "behind-model", tier: "T1", expectedCostUsd: 2 }),
    ];
    const ordered = orderCandidatesByPace(candidates, models, ledger);
    expect(ordered[0]!.modelId).toBe("behind-model");
  });

  it("prefers the newer releasedAt on an exact tie of everything else, matching select.ts's own tie-break", () => {
    const models = [
      model({ id: "older-model", tier: "T1", laneId: "lane-a", releasedAt: "2025-01-01" }),
      model({ id: "newer-model", tier: "T1", laneId: "lane-a", releasedAt: "2026-01-01" }),
    ];
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ state: "on" }) },
    };
    const candidates = [
      candidate({ modelId: "older-model", tier: "T1", expectedCostUsd: 1, releasedAt: "2025-01-01" }),
      candidate({ modelId: "newer-model", tier: "T1", expectedCostUsd: 1, releasedAt: "2026-01-01" }),
    ];
    const ordered = orderCandidatesByPace(candidates, models, ledger);
    expect(ordered[0]!.modelId).toBe("newer-model");
  });

  it("TOG-3406: same-price-family rule prefers the newer release, matching the corrected roster chronology", () => {
    // config/reviewed-roster.json's claude-opus-4-8 releasedAt was fabricated
    // to land AFTER claude-opus-5's real GA date (TOG-3406 root cause) — that
    // data bug is fixed separately in the roster file itself, since no
    // comparator can safely out-guess a wrong date from the id alone. This
    // exercises the named family rule against the now-correct chronology.
    const models = [
      model({ id: "claude-opus-4-8", tier: "T1", laneId: "lane-a", releasedAt: "2026-05-05" }),
      model({ id: "claude-opus-5", tier: "T1", laneId: "lane-a", releasedAt: "2026-06-24" }),
    ];
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ state: "on" }) },
    };
    const candidates = [
      candidate({ modelId: "claude-opus-4-8", tier: "T1", expectedCostUsd: 1, releasedAt: "2026-05-05" }),
      candidate({ modelId: "claude-opus-5", tier: "T1", expectedCostUsd: 1, releasedAt: "2026-06-24" }),
    ];
    const ordered = orderCandidatesByPace(candidates, models, ledger);
    expect(ordered[0]!.modelId).toBe("claude-opus-5");
  });

  it("TOG-3406: an explicit provenBetter earn-in verdict lets the older same-price-family model keep winning", () => {
    const models = [
      model({
        id: "claude-opus-4-8",
        tier: "T1",
        laneId: "lane-a",
        releasedAt: "2026-05-05",
        earnIn: { verdict: "provenBetter" },
      }),
      model({ id: "claude-opus-5", tier: "T1", laneId: "lane-a", releasedAt: "2026-06-24" }),
    ];
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ state: "on" }) },
    };
    const candidates = [
      candidate({ modelId: "claude-opus-4-8", tier: "T1", expectedCostUsd: 1, releasedAt: "2026-05-05" }),
      candidate({ modelId: "claude-opus-5", tier: "T1", expectedCostUsd: 1, releasedAt: "2026-06-24" }),
    ];
    const ordered = orderCandidatesByPace(candidates, models, ledger);
    expect(ordered[0]!.modelId).toBe("claude-opus-4-8");
  });
});

describe("TOG-2137 Defect 5: preferred-near-reset is the two-sided counterpart to the hard stop and slot throttle", () => {
  it("prefers a serviceable lane trailing its elapsed-fraction trajectory as its reset window nears close", () => {
    const trailingNearClose = verdict({
      state: "behind",
      serviceable: true,
      score: { utilization: 0.6, elapsed: 0.85, deviation: -0.25 },
    });
    expect(isPreferredNearReset(trailingNearClose)).toBe(true);
  });

  it("does not prefer a lane still early in its window, even if trailing", () => {
    const trailingEarly = verdict({
      state: "behind",
      serviceable: true,
      score: { utilization: 0.1, elapsed: 0.3, deviation: -0.2 },
    });
    expect(isPreferredNearReset(trailingEarly)).toBe(false);
  });

  it("does not prefer a lane near reset that is running ahead, not behind", () => {
    const aheadNearClose = verdict({
      state: "ahead",
      serviceable: true,
      score: { utilization: 0.95, elapsed: 0.85, deviation: 0.1 },
    });
    expect(isPreferredNearReset(aheadNearClose)).toBe(false);
  });

  it("never prefers an unserviceable (exhausted) lane — the hard stop still wins", () => {
    const exhaustedNearClose = verdict({
      state: "exhausted",
      serviceable: false,
      score: null,
    });
    expect(isPreferredNearReset(exhaustedNearClose)).toBe(false);
  });

  it("is fail-neutral on an unpolled lane (null verdict) or a free/subscription lane (score null)", () => {
    expect(isPreferredNearReset(null)).toBe(false);
    const freeLane = verdict({ state: "free", serviceable: true, score: null });
    expect(isPreferredNearReset(freeLane)).toBe(false);
  });

  it("respects a caller-supplied elapsed threshold instead of the 0.8 default", () => {
    const trailingAtHalf = verdict({
      state: "behind",
      serviceable: true,
      score: { utilization: 0.3, elapsed: 0.55, deviation: -0.25 },
    });
    expect(isPreferredNearReset(trailingAtHalf)).toBe(false);
    expect(isPreferredNearReset(trailingAtHalf, 0.5)).toBe(true);
  });

  it("boosts a preferred-near-reset candidate ahead of a same-tier candidate with a better raw pace state", () => {
    // The trailing lane is merely "behind" (worse PACE_STATE_RANK than
    // "behind-urgent" is better, but here we pit it against an "on" lane to
    // isolate the preferred boost) — preferred-near-reset must win the
    // within-tier sort ahead of ordinary pace-state/deviation/cost ordering.
    const models = [
      model({ id: "trailing-model", tier: "T1", laneId: "lane-trailing" }),
      model({ id: "on-pace-model", tier: "T1", laneId: "lane-on" }),
    ];
    const ledger: LaneLedger = {
      "lane-trailing": {
        laneId: "lane-trailing",
        fetchedAt: "t",
        error: null,
        observation: null,
        verdict: verdict({
          laneId: "lane-trailing",
          state: "behind",
          serviceable: true,
          score: { utilization: 0.5, elapsed: 0.85, deviation: -0.35 },
        }),
      },
      "lane-on": {
        laneId: "lane-on",
        fetchedAt: "t",
        error: null,
        observation: null,
        verdict: verdict({ laneId: "lane-on", state: "on" }),
      },
    };
    const candidates = [
      // Cheaper candidate first, so an ordinary cost sort would already put
      // on-pace-model ahead — the boost must override that.
      candidate({ modelId: "on-pace-model", tier: "T1", expectedCostUsd: 0.5 }),
      candidate({ modelId: "trailing-model", tier: "T1", expectedCostUsd: 2 }),
    ];
    const ordered = orderCandidatesByPace(candidates, models, ledger);
    expect(ordered[0]!.modelId).toBe("trailing-model");
  });

  it("still never lets the preferred boost cross a tier group", () => {
    const models = [
      model({ id: "t1-model", tier: "T1", laneId: "lane-t1" }),
      model({ id: "t2-trailing-model", tier: "T2", laneId: "lane-t2" }),
    ];
    const ledger: LaneLedger = {
      "lane-t1": {
        laneId: "lane-t1",
        fetchedAt: "t",
        error: null,
        observation: null,
        verdict: verdict({ laneId: "lane-t1", state: "on" }),
      },
      "lane-t2": {
        laneId: "lane-t2",
        fetchedAt: "t",
        error: null,
        observation: null,
        verdict: verdict({
          laneId: "lane-t2",
          state: "behind",
          serviceable: true,
          score: { utilization: 0.5, elapsed: 0.9, deviation: -0.4 },
        }),
      },
    };
    const candidates = [
      candidate({ modelId: "t1-model", tier: "T1", expectedCostUsd: 1 }),
      candidate({ modelId: "t2-trailing-model", tier: "T2", expectedCostUsd: 1 }),
    ];
    const ordered = orderCandidatesByPace(candidates, models, ledger);
    expect(ordered.map((c) => c.modelId)).toEqual(["t1-model", "t2-trailing-model"]);
  });

  it("preferredCandidateId reports the first preferred candidate's modelId, or null when none qualifies", () => {
    const models = [model({ id: "m1", tier: "T1", laneId: "lane-a" })];
    const preferredLedger: LaneLedger = {
      "lane-a": {
        laneId: "lane-a",
        fetchedAt: "t",
        error: null,
        observation: null,
        verdict: verdict({ state: "behind", serviceable: true, score: { utilization: 0.5, elapsed: 0.9, deviation: -0.4 } }),
      },
    };
    expect(preferredCandidateId([candidate({ modelId: "m1" })], models, preferredLedger)).toBe("m1");
    expect(preferredCandidateId([candidate({ modelId: "m1" })], models, {})).toBeNull();
  });
});

describe("hardStopExcluded", () => {
  it("excludes a model whose lane is unserviceable", () => {
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ serviceable: false, state: "exhausted" }) },
    };
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(true);
  });

  it("is fail-neutral: an unpolled or unknown lane excludes nothing", () => {
    const ledger: LaneLedger = {};
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(false);
    const unknownLedger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ serviceable: null, state: "unknown" }) },
    };
    expect(hardStopExcluded(unknownLedger, model({ laneId: "lane-a" }))).toBe(false);
  });

  // TOG-3012. The 09-16 incident: codex measured exhausted at 16:55Z, the poll
  // then flapped, and because exclusion was read solely off `verdict` — which a
  // failed poll degrades to null — the lane became admissible again and 21 runs
  // launched onto it. Losing the reading must not erase the measurement.
  it("keeps excluding a lane it observed unserviceable after the poll stops returning a verdict", () => {
    // Named mutant: "failed poll readmits an exhausted lane".
    let ledger: LaneLedger = {};
    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "2026-09-16T16:55:00.000Z",
      verdict: verdict({ serviceable: false, state: "exhausted" }),
      error: null,
    });
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(true);

    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "2026-09-16T17:00:00.000Z",
      verdict: null,
      error: "lane-request-timeout",
    });
    // The honest "we don't know" for the live reading is preserved...
    expect(ledger["lane-a"]!.verdict).toBeNull();
    // ...but it must not be laundered into "and therefore it has capacity".
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(true);
    expect(ledger["lane-a"]!.unserviceableSince).toBe("2026-09-16T16:55:00.000Z");
  });

  it("readmits the lane only when a SUCCESSFUL poll finds it serviceable again", () => {
    // Named mutant: "exclusion is permanent". Stickiness must be clearable by
    // evidence, or a lane that recovers can never be routed to again.
    let ledger: LaneLedger = {};
    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "t1",
      verdict: verdict({ serviceable: false, state: "exhausted" }),
      error: null,
    });
    ledger = mergeLedgerEntry(ledger, { laneId: "lane-a", fetchedAt: "t2", verdict: null, error: "boom" });
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(true);

    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "t3",
      verdict: verdict({ serviceable: true, state: "on" }),
      error: null,
    });
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(false);
    expect(ledger["lane-a"]!.unserviceableSince).toBeNull();
    expect(ledger["lane-a"]!.unserviceableReason).toBeNull();
  });

  it("stays fail-neutral for a lane whose polls have ONLY ever failed", () => {
    // The original intent, which stickiness must not break: absence of
    // evidence is still not evidence of exhaustion when there was never an
    // observation to carry forward.
    let ledger: LaneLedger = {};
    ledger = mergeLedgerEntry(ledger, { laneId: "lane-a", fetchedAt: "t1", verdict: null, error: "boom" });
    ledger = mergeLedgerEntry(ledger, { laneId: "lane-a", fetchedAt: "t2", verdict: null, error: "boom" });
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(false);
    expect(ledger["lane-a"]!.unserviceableSince).toBeNull();
  });

  it("reads a ledger persisted before this field existed as 'never observed', not as excluded", () => {
    // Named mutant: "undefined counts as an observation". The deployed ledger
    // survives the upgrade, and its entries carry no `unserviceableSince` key
    // at all. `undefined !== null` is true, so a missing key must be narrowed
    // through `?? null` — otherwise the first post-deploy poll failure excludes
    // EVERY lane at once and the fleet has no candidates anywhere.
    const legacyEntry = { laneId: "lane-a", fetchedAt: "t", error: "boom", observation: null, verdict: null };
    expect("unserviceableSince" in legacyEntry).toBe(false);
    const ledger: LaneLedger = { "lane-a": legacyEntry };
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(false);
  });

  it("carries an indeterminate-capacity observation across a lost verdict too", () => {
    // The indeterminate reasons fail CLOSED while the verdict is present, so
    // they must stay closed once it is lost — same rule, same evidence.
    let ledger: LaneLedger = {};
    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "t1",
      verdict: verdict({ serviceable: null, state: "unknown", reason: "indeterminate-account-weight" }),
      error: null,
    });
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(true);
    ledger = mergeLedgerEntry(ledger, { laneId: "lane-a", fetchedAt: "t2", verdict: null, error: "boom" });
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(true);
    expect(ledger["lane-a"]!.unserviceableReason).toBe("indeterminate-account-weight");
  });

  it("records the ONSET of an outage, not the most recent confirmation of it", () => {
    // Named mutant: "onset overwritten each poll". The field is what an
    // operator reads to see how long a lane has been out; refreshing it every
    // cycle would report every outage as seconds old.
    let ledger: LaneLedger = {};
    for (const fetchedAt of ["t1", "t2", "t3"]) {
      ledger = mergeLedgerEntry(ledger, {
        laneId: "lane-a",
        fetchedAt,
        verdict: verdict({ serviceable: false, state: "exhausted" }),
        error: null,
      });
    }
    expect(ledger["lane-a"]!.unserviceableSince).toBe("t1");
    expect(ledger["lane-a"]!.fetchedAt).toBe("t3");
  });

  it("does not let one lane's lost verdict exclude another lane", () => {
    let ledger: LaneLedger = {};
    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-a",
      fetchedAt: "t1",
      verdict: verdict({ laneId: "lane-a", serviceable: false, state: "exhausted" }),
      error: null,
    });
    ledger = mergeLedgerEntry(ledger, {
      laneId: "lane-b",
      fetchedAt: "t1",
      verdict: verdict({ laneId: "lane-b", serviceable: true, state: "on" }),
      error: null,
    });
    ledger = mergeLedgerEntry(ledger, { laneId: "lane-b", fetchedAt: "t2", verdict: null, error: "boom" });
    expect(hardStopExcluded(ledger, model({ laneId: "lane-a" }))).toBe(true);
    expect(hardStopExcluded(ledger, model({ laneId: "lane-b" }))).toBe(false);
  });
});

describe("slotFactorFor / slotAllowed", () => {
  it("never drops a serviceable ahead lane's slot factor to zero, however low the configured floor", () => {
    // Named mutant: "slot factor reaches zero". Even a floor of 0 must clamp to
    // a strictly-positive epsilon — the invariant is "never zero", not
    // "whatever the config says".
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ state: "ahead" }) },
    };
    const factor = slotFactorFor(ledger, model({ laneId: "lane-a" }), 0);
    expect(factor).toBeGreaterThan(0);
  });

  it("gives full slot share to any state other than ahead", () => {
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ state: "behind" }) },
    };
    expect(slotFactorFor(ledger, model({ laneId: "lane-a" }), 0.25)).toBe(1);
  });

  it("is deterministic per issue id — the same issue always lands on the same side of the cap", () => {
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ state: "ahead" }) },
    };
    const m = model({ laneId: "lane-a" });
    const first = slotAllowed("issue-42", ledger, m, 0.25);
    const second = slotAllowed("issue-42", ledger, m, 0.25);
    expect(first).toBe(second);
  });
});

describe("operator overrides", () => {
  it("does not honor an expired override — an expired entry is treated as if none existed", () => {
    // Named mutant: "expired override honored".
    const overrides = recordOperatorOverride({}, "issue-1", "claude-opus-5", "2026-08-31T12:00:00.000Z", 60);
    const live = activeOperatorOverride(overrides, "issue-1", "2026-08-31T12:00:30.000Z");
    expect(live?.modelId).toBe("claude-opus-5");
    const expired = activeOperatorOverride(overrides, "issue-1", "2026-08-31T12:01:01.000Z");
    expect(expired).toBeNull();
  });
});

describe("avoidThresholdFor / laneAvoidExcluded (tier_dispatcher.py AVOID/AVOID_LANE)", () => {
  const config: LaneAvoidConfig = { defaultThreshold: 0.8, perLane: { codex: 0.99 } };

  it("falls back to the default threshold for a lane with no per-lane override", () => {
    expect(avoidThresholdFor(config, "zai")).toBe(0.8);
  });

  it("uses the per-lane threshold when one is configured", () => {
    expect(avoidThresholdFor(config, "codex")).toBe(0.99);
  });

  it("2026-09-07 07:12Z owner rule: codex stays usable up to 0.99, not the generic 0.8 — parking it early moved ~25 T2 cards onto bare claude-sonnet-5", () => {
    const ledger: LaneLedger = {
      codex: { laneId: "codex", fetchedAt: "t", error: null, observation: null, verdict: verdict({ laneId: "codex", score: { utilization: 0.9, elapsed: 0.9, deviation: 0 } }) },
    };
    expect(laneAvoidExcluded(ledger, model({ laneId: "codex" }), config)).toBe(false);
    const exhaustedLedger: LaneLedger = {
      codex: { laneId: "codex", fetchedAt: "t", error: null, observation: null, verdict: verdict({ laneId: "codex", score: { utilization: 0.99, elapsed: 0.99, deviation: 0 } }) },
    };
    expect(laneAvoidExcluded(exhaustedLedger, model({ laneId: "codex" }), config)).toBe(true);
  });

  it("2026-09-08 22:55Z owner rule: a lane the collector marks 'degraded' (>=0.9 utilization) stays usable until its OWN avoid threshold is crossed — this keys only on measured utilization, never on lane state/health", () => {
    // Account-level health going "degraded" surfaces here only as elevated
    // `score.utilization`, never as a distinct lane `state` this function
    // reads — excluding on the health label itself (rather than the
    // threshold) caused the Claude flood incident.
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ state: "on", score: { utilization: 0.72, elapsed: 0.7, deviation: 0 } }) },
    };
    expect(laneAvoidExcluded(ledger, model({ laneId: "lane-a" }), config)).toBe(false);
  });

  it("excludes a default-threshold lane at or above 0.8 utilization", () => {
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ score: { utilization: 0.8, elapsed: 0.8, deviation: 0 } }) },
    };
    expect(laneAvoidExcluded(ledger, model({ laneId: "lane-a" }), config)).toBe(true);
  });

  it("is fail-neutral: a model with no laneId, or a lane with no measured utilization, excludes nothing", () => {
    expect(laneAvoidExcluded({}, model({ laneId: null }), config)).toBe(false);
    const noScoreLedger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ score: null }) },
    };
    expect(laneAvoidExcluded(noScoreLedger, model({ laneId: "lane-a" }), config)).toBe(false);
    expect(laneAvoidExcluded({}, model({ laneId: "lane-a" }), config)).toBe(false);
  });
});

describe("isLaneOutageActive / laneOutageExcluded (2026-09-07 06:40Z owner note: OpenCode Go 400 MissingSessionID)", () => {
  it("excludes a model whose lane is under an active outage", () => {
    const override: LaneOutageOverride = { lanes: ["opencode-go"], models: [], until: "2026-09-08T00:00:00.000Z" };
    expect(laneOutageExcluded(override, "2026-09-07T12:00:00.000Z", model({ laneId: "opencode-go" }))).toBe(true);
  });

  it("excludes a model named directly, even if its lane is not listed", () => {
    const override: LaneOutageOverride = { lanes: [], models: ["m1"], until: "2026-09-08T00:00:00.000Z" };
    expect(laneOutageExcluded(override, "2026-09-07T12:00:00.000Z", model({ id: "m1", laneId: "other-lane" }))).toBe(true);
  });

  it("treats an outage past its `until` exactly as if none existed", () => {
    const override: LaneOutageOverride = { lanes: ["opencode-go"], models: [], until: "2026-09-08T00:00:00.000Z" };
    expect(isLaneOutageActive(override, "2026-09-08T00:00:01.000Z")).toBe(false);
    expect(laneOutageExcluded(override, "2026-09-08T00:00:01.000Z", model({ laneId: "opencode-go" }))).toBe(false);
  });

  it("is a no-op when there is no override recorded at all", () => {
    expect(isLaneOutageActive(null, "2026-09-07T12:00:00.000Z")).toBe(false);
    expect(laneOutageExcluded(null, "2026-09-07T12:00:00.000Z", model({ laneId: "opencode-go" }))).toBe(false);
  });

  it("does not exclude a lane/model outside the declared outage", () => {
    const override: LaneOutageOverride = { lanes: ["opencode-go"], models: [], until: "2026-09-08T00:00:00.000Z" };
    expect(laneOutageExcluded(override, "2026-09-07T12:00:00.000Z", model({ laneId: "zai" }))).toBe(false);
  });
});

describe("repinAllowed", () => {
  const context = {
    hasOperatorPin: false,
    isIdle: true,
    lastRepinAt: null as string | null,
    now: "2026-08-31T12:00:00.000Z",
    idleRepinHysteresisSeconds: 300,
    isServiceabilityHardStop: false,
  };

  it("never repins an issue with a running or queued run", () => {
    // Named mutant: "running card repinned".
    const gate = repinAllowed({ ...context, isIdle: false });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("running or queued run");
  });

  it("lets pin:operator survive a routine pace repin", () => {
    const gate = repinAllowed({ ...context, hasOperatorPin: true });
    expect(gate.allowed).toBe(false);
  });

  it("forces a repin through pin:operator when it is a serviceability hard stop", () => {
    const gate = repinAllowed({ ...context, hasOperatorPin: true, isServiceabilityHardStop: true });
    expect(gate.allowed).toBe(true);
  });

  it("blocks a repin inside the idle-repin hysteresis window", () => {
    const gate = repinAllowed({
      ...context,
      lastRepinAt: "2026-08-31T11:58:00.000Z",
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("hysteresis");
  });

  it("allows a repin once past the hysteresis window", () => {
    const gate = repinAllowed({
      ...context,
      lastRepinAt: "2026-08-31T11:50:00.000Z",
    });
    expect(gate.allowed).toBe(true);
  });
});

describe("blendedListPrice (tier_dispatcher.py blended())", () => {
  it("weights input 3x against a 4-part total, matching (3*in + out)/4", () => {
    const m = model({ costPerMTokIn: 4, costPerMTokOut: 8 });
    expect(blendedListPrice(m)).toBeCloseTo((3 * 4 + 8) / 4, 10);
  });

  it("a sub-$1/Mtok flash model blends under 1 — the exact line lane_active_pins() checks for half-weighting", () => {
    const flash = model({ costPerMTokIn: 0.5, costPerMTokOut: 1.5 });
    expect(blendedListPrice(flash)).toBeLessThan(1);
    const premium = model({ costPerMTokIn: 3, costPerMTokOut: 15 });
    expect(blendedListPrice(premium)).toBeGreaterThan(1);
  });
});

describe("ZAI_LONG_RUN_AGENTS (2026-09-08 22:15Z owner rule)", () => {
  it("names every long-turn engineering agent role hit by Z.ai's 1214 error, and nothing else", () => {
    expect(ZAI_LONG_RUN_AGENTS.has("Founding Engineer")).toBe(true);
    expect(ZAI_LONG_RUN_AGENTS.has("Web Engineer")).toBe(true);
    expect(ZAI_LONG_RUN_AGENTS.has("Automation Engineer")).toBe(true);
    expect(ZAI_LONG_RUN_AGENTS.has("DevOps & Reliability Engineer")).toBe(true);
    expect(ZAI_LONG_RUN_AGENTS.has("CTO & Chief AI Officer")).toBe(true);
    expect(ZAI_LONG_RUN_AGENTS.has("Director of Engineering")).toBe(true);
    expect(ZAI_LONG_RUN_AGENTS.has("QA Reviewer")).toBe(false);
  });
});

describe("laneEffectiveUtilization (tier_dispatcher.py eff_util())", () => {
  it("reads the lane's measured utilization when one exists", () => {
    const ledger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ score: { utilization: 0.6, elapsed: 0.5, deviation: 0.1 } }) },
    };
    expect(laneEffectiveUtilization(ledger, "lane-a")).toBe(0.6);
  });

  it("fails neutral to 0.5 (mid-pack), not 0 or 1, when nothing has been measured — distinct from laneAvoidExcluded's fail-to-false", () => {
    expect(laneEffectiveUtilization({}, "lane-a")).toBe(0.5);
    const noScoreLedger: LaneLedger = {
      "lane-a": { laneId: "lane-a", fetchedAt: "t", error: null, observation: null, verdict: verdict({ score: null }) },
    };
    expect(laneEffectiveUtilization(noScoreLedger, "lane-a")).toBe(0.5);
  });
});

describe("zaiPeakNow (Z.ai Coding Plan peak hours: Mon-Fri 14:00-18:00 Asia/Shanghai = 06:00-10:00 UTC)", () => {
  it("is true inside the peak window on a weekday", () => {
    expect(zaiPeakNow(Date.parse("2026-09-08T07:00:00.000Z"))).toBe(true); // Tuesday
  });

  it("is false just before and just at the end of the peak window", () => {
    expect(zaiPeakNow(Date.parse("2026-09-08T05:59:00.000Z"))).toBe(false);
    expect(zaiPeakNow(Date.parse("2026-09-08T10:00:00.000Z"))).toBe(false);
  });

  it("is false on a weekend even during peak UTC hours", () => {
    expect(zaiPeakNow(Date.parse("2026-09-06T07:00:00.000Z"))).toBe(false); // Sunday
  });
});

describe("laneNamedWindowUtilization (tier_dispatcher.py lane_5h(), generalized to any named window)", () => {
  it("takes the max utilization across healthy accounts for the named window", () => {
    const ledger: LaneLedger = {
      "lane-a": {
        laneId: "lane-a",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({
          accounts: [
            account({ accountKey: "a1", windows: [window({ utilization: 0.3 })] }),
            account({ accountKey: "a2", windows: [window({ utilization: 0.7 })] }),
          ],
        }),
      },
    };
    expect(laneNamedWindowUtilization(ledger, "lane-a", "five_hour")).toBe(0.7);
  });

  it("ignores an unhealthy account's window entirely", () => {
    const ledger: LaneLedger = {
      "lane-a": {
        laneId: "lane-a",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({
          accounts: [account({ health: "exhausted", windows: [window({ utilization: 0.99 })] })],
        }),
      },
    };
    expect(laneNamedWindowUtilization(ledger, "lane-a", "five_hour")).toBe(0);
  });

  it("is fail-neutral to 0 (no measured pressure) when there is no observation at all, never excluding on ignorance", () => {
    expect(laneNamedWindowUtilization({}, "lane-a", "five_hour")).toBe(0);
  });

  it("2026-09-07 03:15Z owner rule: new admission to opencode-go stops at >= 0.5 on the 5h window (tightened from 0.6)", () => {
    const atThreshold: LaneLedger = {
      "opencode-go": {
        laneId: "opencode-go",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({ accounts: [account({ windows: [window({ name: "five_hour", utilization: 0.5 })] })] }),
      },
    };
    expect(laneNamedWindowUtilization(atThreshold, "opencode-go", "five_hour")).toBeGreaterThanOrEqual(0.5);
  });
});

describe("laneHealthyAccountCount (tier_dispatcher.py lane_accounts())", () => {
  it("counts only healthy accounts", () => {
    const ledger: LaneLedger = {
      "lane-a": {
        laneId: "lane-a",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({
          accounts: [
            account({ accountKey: "a1", health: "healthy" }),
            account({ accountKey: "a2", health: "healthy" }),
            account({ accountKey: "a3", health: "exhausted" }),
          ],
        }),
      },
    };
    expect(laneHealthyAccountCount(ledger, "lane-a")).toBe(2);
  });

  it("falls back to 1 (never 0, never unlimited) when the lane has never been polled — matching the Python source's try/except default", () => {
    expect(laneHealthyAccountCount({}, "lane-a")).toBe(1);
  });
});

describe("activeZaiPaceOverride / zaiWeeklyPaceOk (2026-09-08 13:20Z owner rule: Z.ai Pro is 60k credits/week but 12k per 5h)", () => {
  it("treats an override past its `until` exactly as if none existed", () => {
    const override: ZaiPaceOverride = { margin: 0.4, until: "2026-09-08T00:00:00.000Z" };
    expect(activeZaiPaceOverride(override, "2026-09-08T00:00:01.000Z")).toBeNull();
    expect(activeZaiPaceOverride(override, "2026-09-07T23:59:59.000Z")).toBe(0.4);
  });

  it("is a no-op when there is no override recorded at all", () => {
    expect(activeZaiPaceOverride(null, "2026-09-07T12:00:00.000Z")).toBeNull();
  });

  it("admits a new zai card when weekly utilization is at or under elapsed-week fraction plus margin", () => {
    // Week starts 2026-09-07T00:00Z, resets 2026-09-14T00:00Z (7 days) — exactly
    // 2 days (28.6%) elapsed at the check time below.
    const ledger: LaneLedger = {
      zai: {
        laneId: "zai",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({
          accounts: [
            account({
              windows: [window({ name: "weekly", role: "allowance", utilization: 0.3, resetsAt: "2026-09-14T00:00:00.000Z" })],
            }),
          ],
        }),
      },
    };
    const nowMs = Date.parse("2026-09-09T00:00:00.000Z");
    expect(
      zaiWeeklyPaceOk({ ledger, laneId: "zai", weeklyWindowName: "weekly", defaultMargin: 0.15, overrideMargin: null, nowMs }),
    ).toBe(true);
  });

  it("refuses a new zai card once weekly utilization outruns elapsed-week fraction plus margin", () => {
    const ledger: LaneLedger = {
      zai: {
        laneId: "zai",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({
          accounts: [
            account({
              windows: [window({ name: "weekly", role: "allowance", utilization: 0.9, resetsAt: "2026-09-14T00:00:00.000Z" })],
            }),
          ],
        }),
      },
    };
    const nowMs = Date.parse("2026-09-09T00:00:00.000Z"); // ~28.6% elapsed + 0.15 margin << 0.9 used
    expect(
      zaiWeeklyPaceOk({ ledger, laneId: "zai", weeklyWindowName: "weekly", defaultMargin: 0.15, overrideMargin: null, nowMs }),
    ).toBe(false);
  });

  it("an operator override margin (e.g. during a Codex outage) widens admission over the default margin", () => {
    const ledger: LaneLedger = {
      zai: {
        laneId: "zai",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({
          accounts: [
            account({
              windows: [window({ name: "weekly", role: "allowance", utilization: 0.9, resetsAt: "2026-09-14T00:00:00.000Z" })],
            }),
          ],
        }),
      },
    };
    const nowMs = Date.parse("2026-09-09T00:00:00.000Z");
    expect(
      zaiWeeklyPaceOk({ ledger, laneId: "zai", weeklyWindowName: "weekly", defaultMargin: 0.15, overrideMargin: 0.8, nowMs }),
    ).toBe(true);
  });

  it("reads only the FIRST reported account, matching the Python source's records[0]", () => {
    const ledger: LaneLedger = {
      zai: {
        laneId: "zai",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({
          accounts: [
            account({
              accountKey: "a1",
              windows: [window({ name: "weekly", role: "allowance", utilization: 0.9, resetsAt: "2026-09-14T00:00:00.000Z" })],
            }),
            account({
              accountKey: "a2",
              windows: [window({ name: "weekly", role: "allowance", utilization: 0.05, resetsAt: "2026-09-14T00:00:00.000Z" })],
            }),
          ],
        }),
      },
    };
    const nowMs = Date.parse("2026-09-09T00:00:00.000Z");
    // a1 (first) is at 0.9 utilization — must refuse even though a2 is nearly empty.
    expect(
      zaiWeeklyPaceOk({ ledger, laneId: "zai", weeklyWindowName: "weekly", defaultMargin: 0.15, overrideMargin: null, nowMs }),
    ).toBe(false);
  });

  it("is fail-neutral to true (admits) when there is no weekly window observed at all", () => {
    expect(
      zaiWeeklyPaceOk({ ledger: {}, laneId: "zai", weeklyWindowName: "weekly", defaultMargin: 0.15, overrideMargin: null, nowMs: Date.now() }),
    ).toBe(true);
  });
});

describe("laneHasRoom (tier_dispatcher.py lane_has_room())", () => {
  const capPerAccount = { "opencode-go": 2, zai: 3 };
  const baseArgs = {
    ledger: {} as LaneLedger,
    capPerAccount,
    fiveHourWindowName: "five_hour",
    zaiLaneId: "zai",
    zaiWeeklyWindowName: "weekly",
    zaiWeeklyDefaultMargin: 0.15,
    zaiPaceOverrideMargin: null as number | null,
    nowMs: Date.parse("2026-09-08T12:00:00.000Z"), // Tuesday, outside zai peak hours
  };

  it("2026-09-06 17:1xZ / 2026-09-07 12:32Z owner rule: a lane with no configured cap always has room", () => {
    expect(laneHasRoom({ ...baseArgs, laneId: "codex", activePinsWeight: 999 })).toBe(true);
  });

  it("admits a new card while active weight stays under cap * healthy account count", () => {
    const ledger: LaneLedger = {
      "opencode-go": {
        laneId: "opencode-go",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({
          accounts: [account({ accountKey: "a1" }), account({ accountKey: "a2" })],
        }),
      },
    };
    // cap 2 * 2 healthy accounts = 4 slots; 3 active + 1 new = 4, still admitted.
    expect(laneHasRoom({ ...baseArgs, ledger, laneId: "opencode-go", activePinsWeight: 3 })).toBe(true);
    // 4 active + 1 new = 5 > 4, refused.
    expect(laneHasRoom({ ...baseArgs, ledger, laneId: "opencode-go", activePinsWeight: 4 })).toBe(false);
  });

  it("2026-09-06 23:5xZ owner rule: stops NEW admission once any healthy account's 5h window hits 0.5, even with weight under the cap", () => {
    const ledger: LaneLedger = {
      "opencode-go": {
        laneId: "opencode-go",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({
          accounts: [account({ windows: [window({ name: "five_hour", utilization: 0.5 })] })],
        }),
      },
    };
    expect(laneHasRoom({ ...baseArgs, ledger, laneId: "opencode-go", activePinsWeight: 0 })).toBe(false);
  });

  it("2026-09-08 13:20Z owner rule: refuses a new zai card when the weekly pace gate fails, regardless of the per-account cap", () => {
    const ledger: LaneLedger = {
      zai: {
        laneId: "zai",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({
          accounts: [
            account({
              windows: [
                window({ name: "five_hour", utilization: 0.1 }),
                window({ name: "weekly", role: "allowance", utilization: 0.95, resetsAt: "2026-09-14T00:00:00.000Z" }),
              ],
            }),
          ],
        }),
      },
    };
    expect(laneHasRoom({ ...baseArgs, ledger, laneId: "zai", activePinsWeight: 0 })).toBe(false);
  });

  it("2026-09-08 13:20Z owner rule: during zai peak hours the per-account cap drops to 1 regardless of the configured cap", () => {
    const ledger: LaneLedger = {
      zai: {
        laneId: "zai",
        fetchedAt: "t",
        error: null,
        verdict: verdict(),
        observation: observation({
          accounts: [
            account({
              windows: [
                window({ name: "five_hour", utilization: 0.1 }),
                window({ name: "weekly", role: "allowance", utilization: 0.1, resetsAt: "2026-09-14T00:00:00.000Z" }),
              ],
            }),
          ],
        }),
      },
    };
    const peakNowMs = Date.parse("2026-09-08T07:00:00.000Z"); // Tuesday 07:00 UTC — inside peak
    // cap 1 * 1 healthy account = 1 slot; 1 active + 1 new = 2 > 1, refused during peak...
    expect(laneHasRoom({ ...baseArgs, ledger, laneId: "zai", activePinsWeight: 1, nowMs: peakNowMs })).toBe(false);
    // ...but the same weight is fine outside peak, where the configured cap of 3 applies.
    expect(laneHasRoom({ ...baseArgs, ledger, laneId: "zai", activePinsWeight: 1, nowMs: baseArgs.nowMs })).toBe(true);
  });
});
