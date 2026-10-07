import { describe, expect, it } from "vitest";

import { laneBurnDown } from "../src/lane-capacity/burn-down.js";
import {
  evaluateLanePace,
  normalizeLaneDocument,
  type LanePaceDefinition,
  type LanePaceVerdict,
} from "../src/lane-capacity/pace.js";
import type { LaneLedger } from "../src/engine/pacing.js";
import {
  fleetLaneInputsForLedger,
  nextFleetPreviousLevel,
} from "../src/fleet-admission-shadow.js";
import { reportDecisionAdmissionShadow } from "../src/admission-shadow.js";
import { budgetWindowId, type BudgetWindowObservation } from "../src/admission-budget.js";

const AS_OF = "2026-10-03T12:00:00.000Z";
const RESET_AT = "2026-10-06T00:00:00.000Z";
const WEEK_SECONDS = 7 * 24 * 60 * 60;

function definition(laneId: string): LanePaceDefinition {
  return {
    laneId,
    healthFields: ["health"],
    accountKeyFields: ["lane"],
    weightFields: ["weight"],
    governingWindowField: "governing_window",
    windows: [
      {
        name: "weekly",
        role: "allowance",
        utilizationFields: ["seven_day_utilization"],
        resetFields: ["seven_day_resets_at"],
        defaultWindowSeconds: WEEK_SECONDS,
      },
      {
        name: "five-hour",
        role: "serviceability",
        utilizationFields: ["five_hour_utilization"],
        resetFields: ["five_hour_resets_at"],
        defaultWindowSeconds: 5 * 60 * 60,
      },
    ],
  };
}

function verdictFor(
  laneId: string,
  records: Record<string, unknown>[],
  asOf = AS_OF,
  observedAt = asOf,
): LanePaceVerdict {
  const observation = normalizeLaneDocument({
    document: { observedAt, staleAfterSeconds: 900, records },
    definition: definition(laneId),
  });
  return evaluateLanePace({ observation, asOf });
}

function healthyRecord(key: string, utilization: number, weight = 20): Record<string, unknown> {
  return {
    lane: key,
    health: "healthy",
    weight,
    governing_window: "weekly",
    seven_day_utilization: utilization,
    seven_day_resets_at: RESET_AT,
    five_hour_utilization: 0.1,
    five_hour_resets_at: "2026-10-03T17:00:00.000Z",
  };
}

function ledgerOf(...verdicts: LanePaceVerdict[]): LaneLedger {
  return Object.fromEntries(
    verdicts.map((verdict) => [
      verdict.laneId,
      { laneId: verdict.laneId, verdict, observation: null, fetchedAt: AS_OF, error: null },
    ]),
  );
}

function shadowInput() {
  const window: BudgetWindowObservation = {
    providerId: "provider",
    poolId: "pool",
    kind: "weekly",
    startAt: 0,
    resetAt: Date.parse(RESET_AT),
    observedAt: Date.parse(AS_OF),
    sourceRevision: "fixture",
    schemaRevision: "v1",
    unit: "allowance",
    quota: 100,
    consumed: 20,
    safetyHeadroom: 1,
    planWeight: 20,
    dataState: "known",
  };
  const id = budgetWindowId(window);
  return {
    enabled: true,
    cohortId: "fleet-fixture",
    accounts: [{ accountId: "account", providerId: "provider", windowIds: [id] }],
    maxAgeMs: 500,
    windows: [window],
    holds: [],
    bindings: [],
  };
}

describe("fleet admission shadow wiring", () => {
  it("proposes from real normalizer/evaluator output and records the proposal row", () => {
    // Elapsed 4.5d of 7d (~= 0.643); utilization 0.3 -> projected ~= 0.47:
    // under-use, so the fleet proposes a boost while nothing is tripped.
    const alpha = verdictFor("alpha", [healthyRecord("alpha-1", 0.3)]);
    const beta = verdictFor("beta", [healthyRecord("beta-1", 0.3)]);
    expect(alpha.reason).toBe("ok");
    expect(beta.reason).toBe("ok");

    const lanes = fleetLaneInputsForLedger(ledgerOf(alpha, beta));
    expect(lanes).toHaveLength(2);
    // Burn-downs come from the evaluated verdicts, not hand-written numbers.
    expect(lanes[0]!.burndown).toEqual(laneBurnDown(alpha));
    expect(lanes[1]!.burndown).toEqual(laneBurnDown(beta));

    const report = reportDecisionAdmissionShadow(shadowInput(), Date.parse(AS_OF),
      [{ modelId: "m", lane: "lane" }], { lanes })!;
    const fleet = report.fleetProposal!;
    expect(fleet.level).toBe("boost");
    expect(fleet.admissionFraction).toBeGreaterThan(1);
    expect(fleet.spendOrder).toEqual(expect.arrayContaining(["alpha", "beta"]));
    expect(fleet.withheld).toEqual([]);
    expect(fleet.backstop).toMatchObject({ trippedLanes: [], trippedShare: 0, capped: false });
    expect(fleet.inventory).toMatchObject({ knownAccountCount: 2, computableAccountCount: 2 });
    expect(fleet.inventory.lanes).toEqual([
      expect.objectContaining({ laneId: "alpha", knownAccountCount: 1, computableAccountCount: 1 }),
      expect.objectContaining({ laneId: "beta", knownAccountCount: 1, computableAccountCount: 1 }),
    ]);
    // Per-lane pace-target rate against the window-average rate, both real.
    for (const lane of fleet.lanes) {
      expect(typeof lane.targetRatePerHour).toBe("number");
      expect(typeof lane.windowRatePerHour).toBe("number");
    }
    expect(typeof fleet.asOf).toBe("string");
  });

  it("unknown records nothing and changes nothing", () => {
    const stale = verdictFor("alpha", [healthyRecord("alpha-1", 0.3)], AS_OF, "2026-09-01T12:00:00.000Z");
    expect(stale.reason).toBe("snapshot-stale");
    const lanes = fleetLaneInputsForLedger(ledgerOf(stale));
    const report = reportDecisionAdmissionShadow(shadowInput(), Date.parse(AS_OF),
      [{ modelId: "m", lane: "lane" }], { lanes, previousLevel: "normal" })!;
    expect(report.fleetProposal).toBeUndefined();
    expect(nextFleetPreviousLevel("normal", null)).toBe("normal");
    expect(nextFleetPreviousLevel("normal", undefined)).toBe("normal");
  });

  it("hysteresis carries across two cycles: the stored level gates the upgrade", () => {
    // Elapsed at AS_OF is 4.5d of 7d (~0.643): utilization 0.7 projects ~1.09.
    const hot = verdictFor("alpha", [healthyRecord("alpha-1", 0.7)]);
    const first = reportDecisionAdmissionShadow(shadowInput(), Date.parse(AS_OF),
      [{ modelId: "m", lane: "lane" }],
      { lanes: fleetLaneInputsForLedger(ledgerOf(hot)) })!;
    expect(first.fleetProposal!.level).toBe("hold");
    const stored = nextFleetPreviousLevel(null, first.fleetProposal!);
    expect(stored).toBe("hold");

    // Cycle 2 cools to a raw boost (0.62 / 0.643 ~= 0.96) but stays inside the
    // upgrade deadband, so the carried level holds the fleet back.
    const cooling = verdictFor("alpha", [healthyRecord("alpha-1", 0.62)]);
    const held = reportDecisionAdmissionShadow(shadowInput(), Date.parse(AS_OF),
      [{ modelId: "m", lane: "lane" }],
      { lanes: fleetLaneInputsForLedger(ledgerOf(cooling)), previousLevel: stored })!;
    expect(held.fleetProposal!.level).toBe("hold");
    expect(held.fleetProposal).toMatchObject({ level: "hold", previousLevel: "hold" });

    // Same snapshot with no carried level upgrades immediately.
    const fresh = reportDecisionAdmissionShadow(shadowInput(), Date.parse(AS_OF),
      [{ modelId: "m", lane: "lane" }],
      { lanes: fleetLaneInputsForLedger(ledgerOf(cooling)) })!;
    expect(fresh.fleetProposal!.level).toBe("boost");
    expect(fresh.fleetProposal).toMatchObject({ level: "boost", previousLevel: null });
  });

  it("an added account shows up in the next report inventory with no config edit", () => {
    const before = verdictFor("alpha", [healthyRecord("alpha-1", 0.3)]);
    const first = reportDecisionAdmissionShadow(shadowInput(), Date.parse(AS_OF),
      [{ modelId: "m", lane: "lane" }],
      { lanes: fleetLaneInputsForLedger(ledgerOf(before)) })!;
    expect(first.fleetProposal!.inventory.knownAccountCount).toBe(1);

    const after = verdictFor("alpha", [
      healthyRecord("alpha-1", 0.3),
      healthyRecord("alpha-2", 0.1, 10),
    ]);
    const second = reportDecisionAdmissionShadow(shadowInput(), Date.parse(AS_OF),
      [{ modelId: "m", lane: "lane" }],
      { lanes: fleetLaneInputsForLedger(ledgerOf(after)) })!;
    expect(second.fleetProposal!.inventory.knownAccountCount).toBe(2);
    expect(second.fleetProposal!.inventory.lanes).toEqual([
      expect.objectContaining({ laneId: "alpha", knownAccountCount: 2, computableAccountCount: 2 }),
    ]);
  });

  it("a majority five-hour trip caps the weekly level at hold and names the lane", () => {
    const tripped = {
      ...healthyRecord("heavy-1", 0.2, 100),
      five_hour_utilization: 1,
    };
    const heavy = verdictFor("heavy", [tripped]);
    expect(heavy.reason).toBe("serviceability-window-exhausted");
    const light = verdictFor("light", [healthyRecord("light-1", 0.3, 1)]);

    const report = reportDecisionAdmissionShadow(shadowInput(), Date.parse(AS_OF),
      [{ modelId: "m", lane: "lane" }],
      { lanes: fleetLaneInputsForLedger(ledgerOf(heavy, light)) })!;
    const fleet = report.fleetProposal!;
    // Weekly alone would boost; the backstop caps at hold without conserving.
    expect(fleet.level).toBe("hold");
    expect(fleet.backstop.trippedLanes).toEqual(["heavy"]);
    expect(fleet.backstop.trippedShare).toBeGreaterThanOrEqual(0.5);
    expect(fleet.backstop.capped).toBe(true);
    expect(fleet.spendOrder).not.toContain("heavy");
    expect(fleet.withheld).toContain("heavy");
  });

  it("a minority trip withholds the lane but leaves the weekly level standing", () => {
    const tripped = {
      ...healthyRecord("small-1", 0.2, 1),
      five_hour_utilization: 1,
    };
    const small = verdictFor("small", [tripped]);
    const big = verdictFor("big", [healthyRecord("big-1", 0.3, 100)]);

    const report = reportDecisionAdmissionShadow(shadowInput(), Date.parse(AS_OF),
      [{ modelId: "m", lane: "lane" }],
      { lanes: fleetLaneInputsForLedger(ledgerOf(small, big)) })!;
    const fleet = report.fleetProposal!;
    expect(fleet.level).toBe("boost");
    expect(fleet.backstop.trippedLanes).toEqual(["small"]);
    expect(fleet.backstop.capped).toBe(false);
    expect(fleet.withheld).toContain("small");
  });
});
