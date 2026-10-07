import { describe, expect, it } from "vitest";

import { buildPredictedVsActualReport, resetActualsForLedger } from "../src/fleet-predicted-vs-actual.js";
import { evaluateLanePace, normalizeLaneDocument } from "../src/lane-capacity/pace.js";

const WINDOW_START = "2026-09-29T00:00:00.000Z";
const WINDOW_RESET = "2026-10-06T00:00:00.000Z";
const NEAR_RESET = "2026-10-05T23:59:00.000Z";
const MID_WEEK = "2026-10-03T12:00:00.000Z";

function snapshot(laneId: string, projected: number, asOf = MID_WEEK, resetAt = WINDOW_RESET) {
  return { laneId, projected, asOf, resetAt };
}
function actual(laneId: string, utilization: number, asOf = NEAR_RESET, resetAt = WINDOW_RESET) {
  return { laneId, utilization, asOf, resetAt };
}
function reportInput() {
  return {
    windowStart: WINDOW_START, windowReset: WINDOW_RESET, asOf: WINDOW_RESET,
    snapshots: [snapshot("alpha", 0.99)], actuals: [actual("alpha", 0.985)],
    proposals: [{ level: "normal" as const, asOf: NEAR_RESET }],
    governorLevels: [{ level: "normal" as const, asOf: NEAR_RESET }],
  };
}

describe("daily predicted-vs-actual report", () => {
  it("matches projections and pre-reset readings from the same completed weekly window", () => {
    const report = buildPredictedVsActualReport({ ...reportInput(),
      snapshots: [snapshot("alpha", 0.99), snapshot("beta", 1.2)],
      actuals: [actual("alpha", 0.985), actual("beta", 1)],
    });
    expect(report.rows).toEqual([
      expect.objectContaining({ laneId: "alpha", resetAt: WINDOW_RESET, projected: 0.99,
        actualUtilization: 0.985, actualAsOf: NEAR_RESET, status: "reset-observed", withinTargetBand: true }),
      expect.objectContaining({ laneId: "beta", projected: 1.2, actualUtilization: 1, withinTargetBand: true }),
    ]);
    expect(report.rows[0]!.projectionError).toBeCloseTo(-0.005, 5);
    expect(report.fleetLevels).toMatchObject({ proposalLevel: "normal", governorLevel: "normal", match: true });
  });

  it("flags an actual outside the band and an aligned governor level mismatch", () => {
    const report = buildPredictedVsActualReport({ ...reportInput(),
      snapshots: [snapshot("alpha", 0.7)], actuals: [actual("alpha", 0.5)],
      proposals: [{ level: "boost", asOf: NEAR_RESET }],
    });
    expect(report.rows[0]).toMatchObject({ laneId: "alpha", withinTargetBand: false });
    expect(report.fleetLevels).toMatchObject({ proposalLevel: "boost", governorLevel: "normal", match: false });
  });

  it("never labels a mid-week reading as a reset actual", () => {
    const report = buildPredictedVsActualReport({ ...reportInput(), asOf: MID_WEEK,
      snapshots: [snapshot("alpha", 0.99)], actuals: [actual("alpha", 0.64, MID_WEEK)],
    });
    expect(report.rows[0]).toMatchObject({ projected: 0.99, status: "pending-reset",
      actualUtilization: null, projectionError: null, withinTargetBand: null });
  });

  it("does not recycle a distant reading, post-reset zero or another window into an actual", () => {
    for (const readings of [
      [actual("alpha", 0.64, MID_WEEK)],
      [actual("alpha", 0, "2026-10-06T00:01:00.000Z")],
      [actual("alpha", 0.99, NEAR_RESET, "2026-10-13T00:00:00.000Z")],
    ]) {
      const report = buildPredictedVsActualReport({ ...reportInput(), actuals: readings });
      expect(report.rows.find(row => row.laneId === "alpha" && row.resetAt === WINDOW_RESET)).toMatchObject({
        status: "reset-reading-unavailable", actualUtilization: null, projectionError: null, withinTargetBand: null,
      });
    }
  });

  it("keeps lane resets separate and ignores snapshots from older weekly windows", () => {
    const betaReset = "2026-10-07T00:00:00.000Z";
    const report = buildPredictedVsActualReport({ ...reportInput(),
      snapshots: [snapshot("alpha", 0.99), snapshot("beta", 0.7, MID_WEEK, betaReset),
        snapshot("alpha", 5, "2026-09-28T12:00:00.000Z")],
      actuals: [actual("alpha", 0.985), actual("beta", 0.6, NEAR_RESET, betaReset)],
    });
    expect(report.rows.find(row => row.laneId === "alpha")).toMatchObject({ projected: 0.99, actualUtilization: 0.985 });
    expect(report.rows.find(row => row.laneId === "beta")).toMatchObject({ resetAt: betaReset,
      status: "pending-reset", actualUtilization: null, projectionError: null });
  });

  it("stays neutral when governor snapshots are missing or temporally unaligned", () => {
    for (const governorLevels of [[], [{ level: "normal" as const, asOf: MID_WEEK }]]) {
      const report = buildPredictedVsActualReport({ ...reportInput(), governorLevels });
      expect(report.fleetLevels).toMatchObject({ proposalLevel: "normal", match: null });
      expect(report.limitations).toContainEqual(expect.stringContaining("governor"));
    }
  });

  it("reports missing reset readings and legacy projections with no window identity as unknown", () => {
    const report = buildPredictedVsActualReport({ ...reportInput(),
      snapshots: [snapshot("alpha", 0.99), { laneId: "legacy", projected: 0.9, asOf: MID_WEEK, resetAt: null }],
      actuals: [], proposals: [], governorLevels: [],
    });
    expect(report.rows.find(row => row.laneId === "alpha")).toMatchObject({ projected: 0.99,
      actualUtilization: null, projectionError: null, withinTargetBand: null });
    expect(report.rows.find(row => row.laneId === "legacy")).toMatchObject({ status: "unknown-window", projectionError: null });
    expect(report.fleetLevels).toMatchObject({ proposalLevel: null, governorLevel: null, match: null });
  });

  it("reads weighted weekly utilization even when an account trips the five-hour backstop", () => {
    const definition = { laneId: "alpha", healthFields: ["health"], accountKeyFields: ["account_key"],
      weightFields: ["weight"], windows: [
        { name: "weekly", role: "allowance" as const, utilizationFields: ["weekly_u"], resetFields: ["weekly_reset"], defaultWindowSeconds: 604800 },
        { name: "five-hour", role: "serviceability" as const, utilizationFields: ["five_u"], resetFields: ["five_reset"], defaultWindowSeconds: 18000 },
      ] };
    const observation = normalizeLaneDocument({ definition, document: { observedAt: MID_WEEK, records: [
      { account_key: "heavy", health: "healthy", weekly_u: 0.2, weekly_reset: WINDOW_RESET,
        five_u: 1, five_reset: "2026-10-03T15:00:00.000Z", windows: [{ name: "weekly", allowance_weight: 100 }] },
      { account_key: "light", health: "healthy", weekly_u: 0.4, weekly_reset: WINDOW_RESET,
        five_u: 0.1, five_reset: "2026-10-03T15:00:00.000Z", windows: [{ name: "weekly", allowance_weight: 1 }] },
    ] } });
    const verdict = evaluateLanePace({ observation, asOf: MID_WEEK });
    expect(verdict.accounts[0]!.serviceable).toBe(false);
    const readings = resetActualsForLedger({ alpha: { laneId: "alpha", observation, verdict, fetchedAt: MID_WEEK, error: null } }, WINDOW_RESET);
    expect(readings[0]!.utilization).toBeCloseTo((0.2 * 100 + 0.4) / 101);
    expect(readings[0]).toMatchObject({ resetAt: WINDOW_RESET, asOf: MID_WEEK });
  });
});
