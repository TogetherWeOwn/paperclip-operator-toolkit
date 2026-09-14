import { describe, expect, it } from "vitest";

import type { LaneLedger } from "../src/engine/pacing.js";
import { selectModel } from "../src/engine/select.js";
import { buildShadowRecord, SHADOW_SCHEMA_VERSION } from "../src/shadow-emit.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";
import { MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };
const NOW_ISO = new Date(NOW).toISOString();

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

// MODELS in fixtures.ts carries no laneId; give each roster row one so the
// lane-snapshot/candidate-lane derivations under test have something to key on.
const MODELS_WITH_LANES = MODELS.map((m) => ({ ...m, laneId: "lane-a" }));

describe("buildShadowRecord", () => {
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
      weekly: 0.42,
      fiveHour: 0.42,
      state: "available",
      paceDeviation: -0.08,
    });
    expect(record.candidates.length).toBeGreaterThan(0);
    for (const candidate of record.candidates) {
      expect(candidate).toMatchObject({ capable: true, usable: true, proven: true });
      expect(typeof candidate.blended).toBe("number");
      expect(candidate.lane).toBe("lane-a");
    }
    expect(record.explanations).toEqual([]);
    expect(record.operatorOverride).toBeNull();
    expect(typeof record.pickWhy).toBe("string");
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
