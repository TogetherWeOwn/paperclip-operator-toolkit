import { describe, expect, it } from "vitest";

import { buildPredictedVsActualReport } from "../src/fleet-predicted-vs-actual.js";

const WINDOW_START = "2026-09-29T00:00:00.000Z";
const WINDOW_RESET = "2026-10-06T00:00:00.000Z";

describe("daily predicted-vs-actual report", () => {
  it("matches end-of-window projections against reset utilization lane by lane", () => {
    const report = buildPredictedVsActualReport({
      windowStart: WINDOW_START,
      windowReset: WINDOW_RESET,
      asOf: WINDOW_RESET,
      snapshots: [
        { laneId: "alpha", projected: 0.99, asOf: "2026-10-05T12:00:00.000Z" },
        { laneId: "beta", projected: 1.2, asOf: "2026-10-05T12:00:00.000Z" },
      ],
      actuals: [
        { laneId: "alpha", utilization: 0.985 },
        { laneId: "beta", utilization: 1 },
      ],
      proposals: [{ level: "normal", asOf: "2026-10-05T12:00:00.000Z" }],
      governorLevels: [{ level: "normal", asOf: "2026-10-05T12:00:00.000Z" }],
    });

    expect(report.rows).toEqual([
      expect.objectContaining({
        laneId: "alpha",
        projected: 0.99,
        actualUtilization: 0.985,
        withinTargetBand: true,
      }),
      expect.objectContaining({
        laneId: "beta",
        projected: 1.2,
        actualUtilization: 1,
        withinTargetBand: true,
      }),
    ]);
    expect(report.rows[0]!.projectionError).toBeCloseTo(-0.005, 5);
    expect(report.fleetLevels).toMatchObject({
      proposalLevel: "normal",
      governorLevel: "normal",
      match: true,
    });
  });

  it("flags a lane that landed outside the band and a level mismatch", () => {
    const report = buildPredictedVsActualReport({
      windowStart: WINDOW_START,
      windowReset: WINDOW_RESET,
      asOf: WINDOW_RESET,
      snapshots: [{ laneId: "alpha", projected: 0.7, asOf: "2026-10-05T12:00:00.000Z" }],
      actuals: [{ laneId: "alpha", utilization: 0.5 }],
      proposals: [{ level: "boost", asOf: "2026-10-05T12:00:00.000Z" }],
      governorLevels: [{ level: "normal", asOf: "2026-10-05T12:00:00.000Z" }],
    });

    expect(report.rows[0]).toMatchObject({ laneId: "alpha", withinTargetBand: false });
    expect(report.fleetLevels).toMatchObject({
      proposalLevel: "boost",
      governorLevel: "normal",
      match: false,
    });
  });

  it("stays neutral when governor snapshots are missing: no invented level, no false mismatch", () => {
    const report = buildPredictedVsActualReport({
      windowStart: WINDOW_START,
      windowReset: WINDOW_RESET,
      asOf: WINDOW_RESET,
      snapshots: [{ laneId: "alpha", projected: 0.99, asOf: "2026-10-05T12:00:00.000Z" }],
      actuals: [{ laneId: "alpha", utilization: 0.985 }],
      proposals: [{ level: "normal", asOf: "2026-10-05T12:00:00.000Z" }],
      governorLevels: [],
    });

    expect(report.fleetLevels).toMatchObject({ proposalLevel: "normal", governorLevel: null, match: null });
    expect(report.limitations).toContainEqual(expect.stringContaining("governor"));
  });

  it("reports lanes with no snapshot or no reset reading as unknown, never a guess", () => {
    const report = buildPredictedVsActualReport({
      windowStart: WINDOW_START,
      windowReset: WINDOW_RESET,
      asOf: WINDOW_RESET,
      snapshots: [{ laneId: "alpha", projected: 0.99, asOf: "2026-10-05T12:00:00.000Z" }],
      actuals: [],
      proposals: [],
      governorLevels: [],
    });

    expect(report.rows[0]).toMatchObject({
      laneId: "alpha",
      projected: 0.99,
      actualUtilization: null,
      projectionError: null,
      withinTargetBand: null,
    });
    expect(report.fleetLevels).toMatchObject({ proposalLevel: null, governorLevel: null, match: null });
  });
});
