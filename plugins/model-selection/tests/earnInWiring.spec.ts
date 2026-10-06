import { describe, expect, it } from "vitest";

import type { PaceState } from "../src/lane-capacity/pace.js";
import type { LanePaceVerdict } from "../src/lane-capacity/pace.js";
import type { AvailabilitySnapshot } from "../src/engine/availability.js";
import { buildLaneEvidence } from "../src/engine/lane-evidence.js";
import type { LaneAvoidConfig, LaneLedger, LaneOutageOverride } from "../src/engine/pacing.js";
import type { EarnInState, ModelEntry, ModelScore } from "../src/engine/types.js";
import { planEarnIn } from "../src/actuate/earnIn.js";
import {
  buildEarnInCandidateCard,
  classifyEarnInResolution,
  earnInIdempotencyKey,
  emptyEarnInState,
  isEarnInCandidateIssue,
  isEarnInCandidateModel,
  lanePostureByTier,
  nextEarnInStateOnDispatch,
  nextEarnInStateOnResolve,
  normalizeEarnInState,
  pacePostureForModel,
  pacePostureOfPaceState,
  resolveIsClaudeModel,
  type EarnInLaneInputs,
} from "../src/actuate/earnInWiring.js";

const NOW_MS = Date.parse("2026-09-12T00:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const FUTURE_ISO = new Date(NOW_MS + 3600 * 1000).toISOString();

function testModel(overrides: Partial<ModelEntry> & Pick<ModelEntry, "id">): ModelEntry {
  return {
    tier: "T1",
    enabled: true,
    costPerMTokIn: 1,
    costPerMTokOut: 5,
    costPerMTokCacheRead: 0.1,
    capabilities: ["tools"],
    contextWindow: 1_000_000,
    aaIndex: null,
    releasedAt: "2026-01-01",
    fallbackOnly: false,
    note: "",
    earnIn: null,
    laneId: "lane-a",
    ...overrides,
  };
}

function verdict(overrides: Partial<LanePaceVerdict> = {}): LanePaceVerdict {
  return {
    laneId: "lane-a",
    observedAt: NOW_ISO,
    state: "on",
    serviceable: true,
    score: { utilization: 0.5, elapsed: 0.5, deviation: 0 },
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 1,
    urgentResetAt: null,
    reason: "ok",
    ...overrides,
  };
}

function ledgerFor(laneId: string, laneVerdict: LanePaceVerdict | null): LaneLedger {
  return {
    [laneId]: {
      laneId,
      verdict: laneVerdict,
      observation: null,
      fetchedAt: NOW_ISO,
      error: null,
    },
  };
}

function availableSnapshot(laneId: string): AvailabilitySnapshot {
  return {
    lanes: [
      {
        laneId,
        state: "available",
        term: null,
        reason: "healthy",
        accountCount: 2,
        serviceableAccountCount: 2,
        ageMinutes: 1,
      },
    ],
    unreadableReason: null,
  };
}

function baseInputs(overrides: Partial<EarnInLaneInputs> = {}): EarnInLaneInputs {
  return {
    ledger: ledgerFor("lane-a", verdict()),
    availability: null,
    laneEvidence: null,
    laneAvoidConfig: null,
    laneOutageOverride: null,
    pacingActive: true,
    nowMs: NOW_MS,
    nowIso: NOW_ISO,
    ...overrides,
  };
}

function tierScore(proven: boolean, capable: boolean | null) {
  return {
    n: proven ? 20 : 3,
    ok: proven ? 18 : 3,
    failInfra: 0,
    failModel: 0,
    tmo: 0,
    nEff: 2,
    pObs: 0.9,
    p: 0.9,
    capable,
    proven,
    costPerSuccessUsd: null,
    medMin: null,
    rework: 0,
  };
}

function modelScore(modelId: string, t1Proven: boolean, t1Capable: boolean | null): ModelScore {
  return {
    modelId,
    aaIndex: null,
    priorP: 0.8,
    tiers: {
      // : `Tier` now includes T0 (explicit-only, never earn-in
      // admitted) — the fixture carries it as unproven/unknown.
      T0: tierScore(false, null),
      T1: tierScore(t1Proven, t1Capable),
      T2: tierScore(false, null),
      T3: tierScore(false, null),
    },
    overall: tierScore(false, null),
  };
}

describe("normalizeEarnInState", () => {
  it("returns empty bookkeeping for null/undefined/garbage", () => {
    for (const raw of [null, undefined, 42, "nope", []]) {
      expect(normalizeEarnInState(raw)).toEqual(emptyEarnInState());
    }
  });

  it("keeps well-shaped fields and drops malformed ones", () => {
    const raw = {
      counter: { m1: 3, bad: "x" },
      dispatchedThisWeek: { m1: [NOW_MS, "stale", Number.NaN] },
      activePerModel: { m1: 1 },
      activePerLane: { "lane-a": ["issue-1", 7] },
      firstEightOutcomes: { m1: ["ok", "material-failure", "bogus"] },
      stopped: { m1: true, m2: "yes" },
      dispatchedKeys: ["a:b:earnin", 5],
    };
    const state = normalizeEarnInState(raw);
    expect(state.counter).toEqual({ m1: 3 });
    expect(state.dispatchedThisWeek).toEqual({ m1: [NOW_MS] });
    expect(state.activePerModel).toEqual({ m1: 1 });
    expect(state.activePerLane).toEqual({ "lane-a": ["issue-1"] });
    expect(state.firstEightOutcomes).toEqual({ m1: ["ok", "material-failure"] });
    expect(state.stopped).toEqual({ m1: true });
    expect(state.dispatchedKeys).toEqual(["a:b:earnin"]);
  });
});

describe("pace posture mapping", () => {
  it("maps behind-urgent/behind to behind, on/ahead through, everything else to unknown", () => {
    const cases: Array<[PaceState | null | undefined, string]> = [
      ["behind", "behind"],
      ["behind-urgent", "behind"],
      ["on", "on-pace"],
      ["ahead", "ahead"],
      ["unknown", "unknown"],
      ["exhausted", "unknown"],
      ["free", "unknown"],
      [null, "unknown"],
      [undefined, "unknown"],
    ];
    for (const [input, expected] of cases) {
      expect(pacePostureOfPaceState(input)).toBe(expected);
    }
  });

  it("reads the model's own lane verdict, lane-less models are unknown", () => {
    const ledger = ledgerFor("lane-a", verdict({ state: "behind" }));
    expect(pacePostureForModel(ledger, { laneId: "lane-a" })).toBe("behind");
    expect(pacePostureForModel(ledger, { laneId: "lane-b" })).toBe("unknown");
    expect(pacePostureForModel(ledger, {})).toBe("unknown");
  });
});

describe("lanePostureByTier", () => {
  it("reads available when an enabled non-devin T1 row clears every gate", () => {
    const posture = lanePostureByTier([testModel({ id: "m1" })], baseInputs());
    expect(posture.T1).toBe("available");
  });

  it("reads saturated per tier, never global: starved T1 stays starved while T3 is open", () => {
    const models = [
      testModel({ id: "m-t1", tier: "T1", laneId: "lane-a" }),
      testModel({ id: "m-t3", tier: "T3", laneId: "lane-b" }),
    ];
    const ledger: LaneLedger = {
      ...ledgerFor("lane-a", verdict({ laneId: "lane-a", state: "exhausted", serviceable: false, reason: "all-accounts-unserviceable" })),
      ...ledgerFor("lane-b", verdict({ laneId: "lane-b", state: "on" })),
    };
    const posture = lanePostureByTier(models, baseInputs({ ledger }));
    expect(posture.T1).toBe("saturated");
    expect(posture.T3).toBe("available");
  });

  it("excludes devin rows from every tier: a T1 served only by Devin reads starved", () => {
    const models = [testModel({ id: "devin/swe", tier: "T1", laneId: "lane-a" })];
    const posture = lanePostureByTier(models, baseInputs());
    expect(posture.T1).toBe("saturated");
  });

  it("refuses on a hard-stop (unserviceable) lane verdict", () => {
    const ledger = ledgerFor(
      "lane-a",
      verdict({ state: "exhausted", serviceable: false, reason: "all-accounts-unserviceable" }),
    );
    expect(lanePostureByTier([testModel({ id: "m1" })], baseInputs({ ledger })).T1).toBe("saturated");
  });

  it("refuses on an active model cooldown", () => {
    const ledger: LaneLedger = {
      "lane-a": {
        laneId: "lane-a",
        verdict: verdict(),
        observation: null,
        fetchedAt: NOW_ISO,
        error: null,
        modelCooldownEvidence: [
          {
            observedAt: NOW_ISO,
            staleAfterSeconds: 3600,
            entries: [{ model: "m1", scope: "lane", reason: "quota", retry_at: FUTURE_ISO }],
          },
        ],
      },
    };
    expect(lanePostureByTier([testModel({ id: "m1" })], baseInputs({ ledger })).T1).toBe("saturated");
  });

  it("refuses on an operator outage covering the lane", () => {
    const outage: LaneOutageOverride = { lanes: ["lane-a"], models: [], until: FUTURE_ISO };
    expect(
      lanePostureByTier([testModel({ id: "m1" })], baseInputs({ laneOutageOverride: outage })).T1,
    ).toBe("saturated");
  });

  it("refuses on an avoid-threshold lane when pacing is active", () => {
    const avoid: LaneAvoidConfig = { defaultThreshold: 0.8, perLane: {} };
    const ledger = ledgerFor(
      "lane-a",
      verdict({ score: { utilization: 0.95, elapsed: 0.5, deviation: 0.45 } }),
    );
    expect(lanePostureByTier([testModel({ id: "m1" })], baseInputs({ ledger, laneAvoidConfig: avoid })).T1).toBe(
      "saturated",
    );
  });

  it("treats UNKNOWN/unmapped/unreadable availability as saturated (tighter than selection)", () => {
    const unknown: AvailabilitySnapshot = {
      lanes: [
        {
          laneId: "lane-a",
          state: "unknown",
          term: "staleness",
          reason: "stale snapshot",
          accountCount: 1,
          serviceableAccountCount: 1,
          ageMinutes: 99,
        },
      ],
      unreadableReason: null,
    };
    expect(lanePostureByTier([testModel({ id: "m1" })], baseInputs({ availability: unknown })).T1).toBe(
      "saturated",
    );
    const unmapped: AvailabilitySnapshot = { lanes: [], unreadableReason: null };
    expect(lanePostureByTier([testModel({ id: "m1" })], baseInputs({ availability: unmapped })).T1).toBe(
      "saturated",
    );
    const unreadable: AvailabilitySnapshot = { lanes: [], unreadableReason: "contract fetch failed" };
    expect(
      lanePostureByTier([testModel({ id: "m1" })], baseInputs({ availability: unreadable })).T1,
    ).toBe("saturated");
  });

  it("applies the AC-3 fleet-default single-account rule", () => {
    const single: AvailabilitySnapshot = {
      lanes: [
        {
          laneId: "lane-a",
          state: "available",
          term: null,
          reason: "healthy",
          accountCount: 1,
          serviceableAccountCount: 1,
          ageMinutes: 1,
        },
      ],
      unreadableReason: null,
    };
    expect(
      lanePostureByTier([testModel({ id: "m1" })], baseInputs({ availability: single, trafficScale: "fleet-default" })).T1,
    ).toBe("saturated");
    expect(lanePostureByTier([testModel({ id: "m1" })], baseInputs({ availability: single })).T1).toBe(
      "available",
    );
  });

  it("refuses a proven-dead lane that no contract mentions (the devin 0/74 shape)", () => {
    const evidence = buildLaneEvidence([{ laneId: "lane-a", succeeded: 0, failed: 20 }], 24);
    expect(lanePostureByTier([testModel({ id: "m1" })], baseInputs({ laneEvidence: evidence })).T1).toBe(
      "saturated",
    );
    const good = buildLaneEvidence([{ laneId: "lane-a", succeeded: 34, failed: 8 }], 24);
    expect(lanePostureByTier([testModel({ id: "m1" })], baseInputs({ laneEvidence: good })).T1).toBe(
      "available",
    );
  });

  it("saturates disabled rows and lane-less models", () => {
    expect(
      lanePostureByTier([testModel({ id: "m1", enabled: false })], baseInputs()).T1,
    ).toBe("saturated");
    expect(
      lanePostureByTier([testModel({ id: "m1", laneId: null })], baseInputs()).T1,
    ).toBe("saturated");
  });

  it("reads a fully available contract as available (positive control)", () => {
    expect(
      lanePostureByTier([testModel({ id: "m1" })], baseInputs({ availability: availableSnapshot("lane-a") })).T1,
    ).toBe("available");
  });
});

describe("buildEarnInCandidateCard", () => {
  const base = {
    issueId: "issue-1",
    status: "todo",
    hasRunningRun: false,
    hasOperatorPin: false,
    exclusionExcluded: false,
    model: { id: "m1", laneId: "lane-a" as string | null },
  };

  it("builds a T1 card with the recorded class verbatim", () => {
    const card = buildEarnInCandidateCard({ ...base, labelNames: ["tier:T1", "class:research"] });
    expect(card).toMatchObject({
      issueId: "issue-1",
      modelId: "m1",
      lane: "lane-a",
      tier: "T1",
      status: "todo",
      workClass: "research",
      hasOperatorPin: false,
      hasExclusion: false,
      requiresCredentials: false,
      requiresPermissionsOrApprovals: false,
    });
  });

  it("returns null for non-T1 cards and lane-less models", () => {
    expect(buildEarnInCandidateCard({ ...base, labelNames: ["tier:T2"] })).toBeNull();
    expect(buildEarnInCandidateCard({ ...base, labelNames: [] })).toBeNull();
    expect(
      buildEarnInCandidateCard({
        ...base,
        labelNames: ["tier:T1"],
        model: { id: "m1", laneId: null },
      }),
    ).toBeNull();
  });

  it("resolves unknown when no class label is recorded, and triples exclusion flags", () => {
    const unknown = buildEarnInCandidateCard({ ...base, labelNames: ["tier:T1"] });
    expect(unknown?.workClass).toBe("unknown");
    const excluded = buildEarnInCandidateCard({
      ...base,
      labelNames: ["tier:T1", "class:review"],
      exclusionExcluded: true,
    });
    expect(excluded?.hasExclusion).toBe(true);
    expect(excluded?.requiresCredentials).toBe(true);
    expect(excluded?.requiresPermissionsOrApprovals).toBe(true);
  });
});

describe("isEarnInCandidateIssue", () => {
  const open = {
    status: "todo",
    isIdle: true,
    hasOperatorPin: false,
    exclusionExcluded: false,
    hasExistingOverride: false,
    assigneeUserId: null,
    labelNames: ["tier:T1"],
    priority: "low",
    title: "Add a bounded admission test",
  };

  it("accepts a plain T1 todo card", () => {
    expect(isEarnInCandidateIssue(open)).toBe(true);
  });

  it("rejects non-todo, busy, pinned, excluded, overridden, user-assigned, and non-T1 cards", () => {
    expect(isEarnInCandidateIssue({ ...open, status: "in_progress" })).toBe(false);
    expect(isEarnInCandidateIssue({ ...open, isIdle: false })).toBe(false);
    expect(isEarnInCandidateIssue({ ...open, hasOperatorPin: true })).toBe(false);
    expect(isEarnInCandidateIssue({ ...open, exclusionExcluded: true })).toBe(false);
    expect(isEarnInCandidateIssue({ ...open, hasExistingOverride: true })).toBe(false);
    expect(isEarnInCandidateIssue({ ...open, assigneeUserId: "u1" })).toBe(false);
    expect(isEarnInCandidateIssue({ ...open, labelNames: ["tier:T2"] })).toBe(false);
  });

  it("never admits protected cards (priority or review title)", () => {
    expect(isEarnInCandidateIssue({ ...open, priority: "critical" })).toBe(false);
    expect(isEarnInCandidateIssue({ ...open, priority: "HIGH" })).toBe(false);
    expect(isEarnInCandidateIssue({ ...open, title: "Review the release gate" })).toBe(false);
  });
});

describe("isEarnInCandidateModel", () => {
  it("accepts an enabled unproven T1 row", () => {
    expect(
      isEarnInCandidateModel({
        model: testModel({ id: "m1" }),
        modelScores: { m1: modelScore("m1", false, true) },
      }),
    ).toBe(true);
  });

  it("rejects disabled, non-T1, devin, adapter-blocked, proven, and incapable rows", () => {
    expect(isEarnInCandidateModel({ model: testModel({ id: "m1", enabled: false }) })).toBe(false);
    expect(isEarnInCandidateModel({ model: testModel({ id: "m1", tier: "T2" }) })).toBe(false);
    expect(isEarnInCandidateModel({ model: testModel({ id: "devin/swe" }) })).toBe(false);
    expect(
      isEarnInCandidateModel({ model: testModel({ id: "devin/swe" }), agentAdapterType: "opencode_local" }),
    ).toBe(false);
    expect(
      isEarnInCandidateModel({
        model: testModel({ id: "m1" }),
        modelScores: { m1: modelScore("m1", true, true) },
      }),
    ).toBe(false);
    expect(
      isEarnInCandidateModel({
        model: testModel({ id: "m1" }),
        modelScores: { m1: modelScore("m1", false, false) },
      }),
    ).toBe(false);
  });

  it("rejects claude_local + devin via the adapter gate", () => {
    expect(
      isEarnInCandidateModel({
        model: testModel({ id: "devin/swe", tier: "T1" }),
        agentAdapterType: "claude_local",
      }),
    ).toBe(false);
  });
});

describe("resolveIsClaudeModel + idempotency key", () => {
  it("matches the served namespace, never a substring", () => {
    expect(resolveIsClaudeModel("claude-opus-5")).toBe(true);
    expect(resolveIsClaudeModel("anthropic/claude-sonnet-5")).toBe(true);
    expect(resolveIsClaudeModel("gpt-5.6-luna")).toBe(false);
    expect(resolveIsClaudeModel("muse-spark-claude-compat")).toBe(false);
  });

  it("builds the same key planEarnIn derives", () => {
    expect(earnInIdempotencyKey("issue-1", "m1")).toBe("issue-1:m1:earnin");
  });
});

describe("nextEarnInStateOnDispatch", () => {
  it("bumps the counter, appends the timestamp, occupies model + lane, records the key", () => {
    const card = buildEarnInCandidateCard({
      issueId: "issue-1",
      status: "todo",
      hasRunningRun: false,
      hasOperatorPin: false,
      exclusionExcluded: false,
      labelNames: ["tier:T1", "class:research"],
      model: { id: "m1", laneId: "lane-a" },
    })!;
    const next = nextEarnInStateOnDispatch(emptyEarnInState(), card, NOW_MS);
    expect(next.counter.m1).toBe(1);
    expect(next.dispatchedThisWeek.m1).toEqual([NOW_MS]);
    expect(next.activePerModel.m1).toBe(1);
    expect(next.activePerLane["lane-a"]).toEqual(["issue-1"]);
    expect(next.dispatchedKeys).toEqual(["issue-1:m1:earnin"]);
  });

  it("is append-only: stale timestamps are preserved for planEarnIn's own window filter", () => {
    const card = buildEarnInCandidateCard({
      issueId: "issue-2",
      status: "todo",
      hasRunningRun: false,
      hasOperatorPin: false,
      exclusionExcluded: false,
      labelNames: ["tier:T1", "class:research"],
      model: { id: "m1", laneId: "lane-a" },
    })!;
    const stale: EarnInState = {
      ...emptyEarnInState(),
      dispatchedThisWeek: { m1: [NOW_MS - 30 * 24 * 3600 * 1000] },
      dispatchedKeys: ["issue-1:m1:earnin"],
    };
    const next = nextEarnInStateOnDispatch(stale, card, NOW_MS);
    expect(next.dispatchedThisWeek.m1).toHaveLength(2);
    expect(next.counter.m1).toBe(1);
  });

  it("does not duplicate an already-recorded idempotency key", () => {
    const card = buildEarnInCandidateCard({
      issueId: "issue-1",
      status: "todo",
      hasRunningRun: false,
      hasOperatorPin: false,
      exclusionExcluded: false,
      labelNames: ["tier:T1", "class:research"],
      model: { id: "m1", laneId: "lane-a" },
    })!;
    const state: EarnInState = { ...emptyEarnInState(), dispatchedKeys: ["issue-1:m1:earnin"] };
    const next = nextEarnInStateOnDispatch(state, card, NOW_MS);
    expect(next.dispatchedKeys).toEqual(["issue-1:m1:earnin"]);
  });
});

describe("classifyEarnInResolution", () => {
  it("stops immediately on an explicit safety/authority marker", () => {
    expect(
      classifyEarnInResolution({
        runStatus: "failed",
        errorText: "flagged for possible cybersecurity concern",
        errorCode: null,
        rejected: false,
        modelId: "m1",
      }),
    ).toEqual({ outcome: "material-failure", safetyOrAuthorityViolation: true });
    expect(
      classifyEarnInResolution({
        runStatus: "succeeded",
        errorText: null,
        errorCode: "content_filter",
        rejected: false,
        modelId: "m1",
      }),
    ).toEqual({ outcome: "material-failure", safetyOrAuthorityViolation: true });
  });

  it("counts a human reopen/rejection as a material failure without a safety stop", () => {
    expect(
      classifyEarnInResolution({
        runStatus: "succeeded",
        errorText: null,
        errorCode: null,
        rejected: true,
        modelId: "m1",
      }),
    ).toEqual({ outcome: "material-failure", safetyOrAuthorityViolation: false });
  });

  it("counts success as ok and a bare refusal as a material failure, not a stop", () => {
    expect(
      classifyEarnInResolution({
        runStatus: "succeeded",
        errorText: null,
        errorCode: null,
        rejected: false,
        modelId: "m1",
      }),
    ).toEqual({ outcome: "ok", safetyOrAuthorityViolation: false });
    expect(
      classifyEarnInResolution({
        runStatus: "failed",
        errorText: "refus",
        errorCode: null,
        rejected: false,
        modelId: "m1",
      }),
    ).toEqual({ outcome: "material-failure", safetyOrAuthorityViolation: false });
  });

  it("ignores infra failures and unknown statuses (slot releases, window does not move)", () => {
    expect(
      classifyEarnInResolution({
        runStatus: "failed",
        errorText: "503 auth_unavailable: no auth available",
        errorCode: null,
        rejected: false,
        modelId: "m1",
      }),
    ).toEqual({ outcome: "ignore", safetyOrAuthorityViolation: false });
    expect(
      classifyEarnInResolution({
        runStatus: "queued",
        errorText: null,
        errorCode: null,
        rejected: false,
        modelId: "m1",
      }),
    ).toEqual({ outcome: "ignore", safetyOrAuthorityViolation: false });
  });
});

describe("nextEarnInStateOnResolve", () => {
  function dispatched(): EarnInState {
    return {
      ...emptyEarnInState(),
      counter: { m1: 1 },
      dispatchedThisWeek: { m1: [NOW_MS] },
      activePerModel: { m1: 1 },
      activePerLane: { "lane-a": ["issue-1"] },
      dispatchedKeys: ["issue-1:m1:earnin"],
    };
  }

  it("always releases the active slot, even when the outcome is ignored", () => {
    const next = nextEarnInStateOnResolve(dispatched(), "m1", "lane-a", "issue-1", {
      outcome: "ignore",
      safetyOrAuthorityViolation: false,
    });
    expect(next.activePerModel.m1).toBe(0);
    expect(next.activePerLane["lane-a"]).toEqual([]);
    expect(next.firstEightOutcomes.m1 ?? []).toHaveLength(0);
    expect(next.stopped.m1).toBeFalsy();
  });

  it("folds an ok outcome and stops after two material failures", () => {
    let state = nextEarnInStateOnResolve(dispatched(), "m1", "lane-a", "issue-1", {
      outcome: "ok",
      safetyOrAuthorityViolation: false,
    });
    expect(state.firstEightOutcomes.m1).toEqual(["ok"]);
    state = nextEarnInStateOnResolve({ ...state, activePerModel: { m1: 1 }, activePerLane: { "lane-a": ["issue-2"] } }, "m1", "lane-a", "issue-2", {
      outcome: "material-failure",
      safetyOrAuthorityViolation: false,
    });
    state = nextEarnInStateOnResolve({ ...state, activePerModel: { m1: 1 }, activePerLane: { "lane-a": ["issue-3"] } }, "m1", "lane-a", "issue-3", {
      outcome: "material-failure",
      safetyOrAuthorityViolation: false,
    });
    expect(state.stopped.m1).toBe(true);
  });

  it("clamps release at zero and removes only the resolved issue", () => {
    const state: EarnInState = {
      ...emptyEarnInState(),
      activePerLane: { "lane-a": ["issue-1", "issue-2"] },
    };
    const next = nextEarnInStateOnResolve(state, "m1", "lane-a", "issue-1", {
      outcome: "ignore",
      safetyOrAuthorityViolation: false,
    });
    expect(next.activePerModel.m1).toBe(0);
    expect(next.activePerLane["lane-a"]).toEqual(["issue-2"]);
  });
});

describe("wiring translators feed planEarnIn", () => {
  const config = {
    enabled: true,
    perModelPerWeek: 8,
    maxActivePerModel: 1,
    maxActivePerLane: 1,
    classes: ["research", "review"],
    stopOnFirstNFailures: 2,
    stopWindow: 8,
  };

  it("dispatches when every translator agrees, refuses when T1 is starved", () => {
    const card = buildEarnInCandidateCard({
      issueId: "issue-1",
      status: "todo",
      hasRunningRun: false,
      hasOperatorPin: false,
      exclusionExcluded: false,
      labelNames: ["tier:T1", "class:research"],
      model: { id: "m1", laneId: "lane-a" },
    })!;
    const posture = lanePostureByTier([testModel({ id: "m1" })], baseInputs());
    const pace = pacePostureForModel(ledgerFor("lane-a", verdict({ state: "on" })), { laneId: "lane-a" });
    const open = planEarnIn(
      card,
      modelScore("m1", false, true),
      { ...emptyEarnInState(), counter: { m1: 0 } },
      config,
      posture,
      pace,
      resolveIsClaudeModel("m1"),
      NOW_MS,
    );
    expect(open.dispatch).toBe(true);

    const starvedLedger: LaneLedger = {
      ...ledgerFor("lane-a", verdict({ laneId: "lane-a", state: "exhausted", serviceable: false, reason: "all-accounts-unserviceable" })),
      ...ledgerFor("lane-b", verdict({ laneId: "lane-b", state: "on" })),
    };
    const starved = lanePostureByTier(
      [testModel({ id: "m1", laneId: "lane-a" }), testModel({ id: "m3", tier: "T3", laneId: "lane-b" })],
      baseInputs({ ledger: starvedLedger }),
    );
    const refused = planEarnIn(
      card,
      modelScore("m1", false, true),
      { ...emptyEarnInState(), counter: { m1: 0 } },
      config,
      starved,
      pace,
      false,
      NOW_MS,
    );
    expect(refused.dispatch).toBe(false);
    expect(refused.reason).toContain("T1 lane posture is saturated");
  });
});
