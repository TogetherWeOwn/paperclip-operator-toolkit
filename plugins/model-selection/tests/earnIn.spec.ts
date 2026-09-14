import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isMaterialFailure,
  planEarnIn,
  recordEarnInOutcome,
  ROLLING_WEEK_MS,
  SELECTION_COUNTER_MODULUS,
  type EarnInCandidateCard,
  type LanePostureByTier,
} from "../src/actuate/earnIn.js";
import type { ResolvedConfig } from "../src/config/resolve.js";
import type { ModelScore } from "../src/engine/types.js";
import { earnInState, MODEL_SCORES } from "./fixtures.js";

const EARN_IN_CONFIG: ResolvedConfig["earnIn"] = {
  enabled: true,
  perModelPerWeek: 8,
  maxActivePerModel: 1,
  maxActivePerLane: 1,
  classes: ["research", "review"],
  stopOnFirstNFailures: 2,
  stopWindow: 8,
};

const AVAILABLE_ALL: LanePostureByTier = { T1: "available", T2: "available", T3: "available" };
const STARVED_T1_ONLY: LanePostureByTier = { T1: "saturated", T2: "available", T3: "available" };

afterEach(() => {
  vi.restoreAllMocks();
});

function card(overrides: Partial<EarnInCandidateCard> = {}): EarnInCandidateCard {
  return {
    issueId: "issue-1",
    modelId: "gpt-5.6-luna",
    lane: "lane-a",
    tier: "T1",
    status: "todo",
    hasRunningRun: false,
    workClass: "research",
    hasOperatorPin: false,
    hasExclusion: false,
    requiresCredentials: false,
    requiresPermissionsOrApprovals: false,
    ...overrides,
  };
}

// gpt-5.6-luna/T1 fixture: proven=true in MODEL_SCORES, so it is NOT an
// earn-in candidate as-is. Build an unproven-but-capable score for these
// tests, mirroring the "unproven, capable" shape earn-in exists to admit.
const UNPROVEN_CAPABLE_SCORE: ModelScore = {
  modelId: "gpt-5.6-luna",
  aaIndex: 43,
  priorP: 0.873,
  tiers: {
    T1: {
      n: 3,
      ok: 3,
      failInfra: 0,
      failModel: 0,
      tmo: 0,
      nEff: 2.1,
      pObs: 1.0,
      p: 0.9,
      capable: true,
      proven: false,
      costPerSuccessUsd: null,
      medMin: null,
      rework: 0,
    },
    T2: MODEL_SCORES[1]!.tiers.T2,
    T3: MODEL_SCORES[1]!.tiers.T3,
  },
  overall: MODEL_SCORES[1]!.overall,
};

const NOW_MS = Date.parse("2026-09-12T00:00:00.000Z");

interface DecideArgs {
  card: EarnInCandidateCard;
  modelScore: ModelScore | null;
  state: ReturnType<typeof earnInState>;
  config: ResolvedConfig["earnIn"];
  lanePostureByTier: LanePostureByTier;
  pacePosture: "behind" | "on-pace" | "ahead" | "unknown";
  isClaudeModel: boolean;
  nowMs: number;
}

function baseArgs(): DecideArgs {
  return {
    card: card(),
    modelScore: UNPROVEN_CAPABLE_SCORE,
    state: earnInState({ counter: { "gpt-5.6-luna": 0 } }),
    config: EARN_IN_CONFIG,
    lanePostureByTier: AVAILABLE_ALL,
    pacePosture: "on-pace",
    isClaudeModel: false,
    nowMs: NOW_MS,
  };
}

function decide(overrides: Partial<DecideArgs> = {}) {
  const args = { ...baseArgs(), ...overrides };
  return planEarnIn(
    args.card,
    args.modelScore,
    args.state,
    args.config,
    args.lanePostureByTier,
    args.pacePosture,
    args.isClaudeModel,
    args.nowMs,
  );
}

describe("planEarnIn — gates", () => {
  it("dispatches an unproven, capable T1 candidate when every gate clears and the counter is due", () => {
    const decision = decide();
    expect(decision.dispatch).toBe(true);
    expect(decision.cohortTag).toBe("earnin:gpt-5.6-luna");
    expect(decision.idempotencyKey).toBe("issue-1:gpt-5.6-luna:earnin");
  });

  it("refuses when earn-in is disabled for the company", () => {
    const decision = decide({ config: { ...EARN_IN_CONFIG, enabled: false } });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("disabled");
  });

  it("refuses a non-T1 card outright", () => {
    const decision = decide({ card: card({ tier: "T2" as never }) });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("only ever admits T1");
  });

  it("refuses a work class outside the configured earn-in classes", () => {
    const decision = decide({ card: card({ workClass: "deploy" }) });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("not in the configured earn-in classes");
  });

  it("excludes cards that require credentials", () => {
    const decision = decide({ card: card({ requiresCredentials: true }) });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("credentials");
  });

  it("excludes cards that require permissions or approvals", () => {
    const decision = decide({ card: card({ requiresPermissionsOrApprovals: true }) });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("permissions/approvals");
  });

  it("excludes an operator-pinned card", () => {
    const decision = decide({ card: card({ hasOperatorPin: true }) });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("operator pin");
  });

  it("excludes a card carrying a capability exclusion", () => {
    const decision = decide({ card: card({ hasExclusion: true }) });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("capability exclusion");
  });

  it("excludes a card with a running run", () => {
    const decision = decide({ card: card({ hasRunningRun: true }) });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("running run");
  });

  it("refuses a model already proven at T1 — not an earn-in candidate", () => {
    const decision = decide({ modelScore: MODEL_SCORES[1]! }); // proven=true fixture
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("already proven");
  });

  it("refuses a model judged not capable at T1", () => {
    const notCapable: ModelScore = {
      ...UNPROVEN_CAPABLE_SCORE,
      tiers: { ...UNPROVEN_CAPABLE_SCORE.tiers, T1: { ...UNPROVEN_CAPABLE_SCORE.tiers.T1, capable: false } },
    };
    const decision = decide({ modelScore: notCapable });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("not judged capable");
  });

  it("refuses a model with no score at all", () => {
    const decision = decide({ modelScore: null });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("no model score");
  });

  it("is sticky-stopped once state.stopped is set for the model", () => {
    const decision = decide({ state: earnInState({ stopped: { "gpt-5.6-luna": true } }) });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("stopped");
  });

  it("refuses an idempotency key already recorded as dispatched", () => {
    const decision = decide({
      state: earnInState({
        counter: { "gpt-5.6-luna": 0 },
        dispatchedKeys: ["issue-1:gpt-5.6-luna:earnin"],
      }),
    });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("already dispatched");
  });

  it("caps dispatch at perModelPerWeek within the rolling window", () => {
    const recent = Array.from({ length: 8 }, (_, i) => NOW_MS - i * 60_000);
    const decision = decide({
      state: earnInState({
        counter: { "gpt-5.6-luna": 0 },
        dispatchedThisWeek: { "gpt-5.6-luna": recent },
      }),
    });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("8/8");
  });

  it("does not count dispatches older than the rolling week, even with 12 timestamps on record (exceed-8-with-injected-clock)", () => {
    // 4 stale (outside the 7-day window) + 4 fresh = only 4 should count.
    const stale = Array.from({ length: 4 }, (_, i) => NOW_MS - ROLLING_WEEK_MS - i * 60_000);
    const fresh = Array.from({ length: 4 }, (_, i) => NOW_MS - i * 60_000);
    const decision = decide({
      state: earnInState({
        counter: { "gpt-5.6-luna": 0 },
        dispatchedThisWeek: { "gpt-5.6-luna": [...stale, ...fresh] },
      }),
    });
    expect(decision.dispatch).toBe(true);
  });

  it("an injected far-future nowMs cannot make stale dispatches count as fresh capacity", () => {
    const eightStale = Array.from({ length: 8 }, (_, i) => NOW_MS - i * 60_000);
    // Advance nowMs by more than one rolling week — all 8 fall out of window.
    const decision = decide({
      state: earnInState({
        counter: { "gpt-5.6-luna": 0 },
        dispatchedThisWeek: { "gpt-5.6-luna": eightStale },
      }),
      nowMs: NOW_MS + ROLLING_WEEK_MS + 60_000,
    });
    expect(decision.dispatch).toBe(true);
  });

  it("caps at one active card per model", () => {
    const decision = decide({
      state: earnInState({ counter: { "gpt-5.6-luna": 0 }, activePerModel: { "gpt-5.6-luna": 1 } }),
    });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("already has an active earn-in card");
  });

  it("caps at one active card per lane", () => {
    const decision = decide({
      state: earnInState({ counter: { "gpt-5.6-luna": 0 }, activePerLane: { "lane-a": ["issue-x"] } }),
    });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("lane lane-a already has an active earn-in card");
  });

  it("requires Claude models to be behind pace, but does not gate non-Claude models on pace", () => {
    const behindOnly = decide({ isClaudeModel: true, pacePosture: "on-pace" });
    expect(behindOnly.dispatch).toBe(false);
    expect(behindOnly.reason).toContain("behind pace");

    const claudeBehind = decide({ isClaudeModel: true, pacePosture: "behind" });
    expect(claudeBehind.dispatch).toBe(true);

    const nonClaudeIgnoresPace = decide({ isClaudeModel: false, pacePosture: "ahead" });
    expect(nonClaudeIgnoresPace.dispatch).toBe(true);
  });

  it("skips a candidate whose deterministic counter is not a multiple of the modulus", () => {
    const decision = decide({ state: earnInState({ counter: { "gpt-5.6-luna": 1 } }) });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain(`not a multiple of ${SELECTION_COUNTER_MODULUS}`);
  });

  it("SELECTION_COUNTER_MODULUS is a fixed, non-random constant", () => {
    // Named mutant: swap-in-randomness. Pin both the literal and the absence of
    // a runtime random read at the selection boundary.
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    expect(SELECTION_COUNTER_MODULUS).toBe(12);
    expect(Number.isInteger(SELECTION_COUNTER_MODULUS)).toBe(true);
    expect(decide().dispatch).toBe(true);
    expect(random).not.toHaveBeenCalled();
  });
});

describe("planEarnIn — per-tier lane posture (global-lane-check-passes-while-target-tier-starved)", () => {
  it("refuses to dispatch a T1 card when the T1 lane is saturated, even though other tiers are available", () => {
    const decision = decide({ lanePostureByTier: STARVED_T1_ONLY });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain("T1 lane posture is saturated");
  });

  it("dispatches once the T1 lane specifically becomes available, independent of other tiers", () => {
    const t3Starved: LanePostureByTier = { T1: "available", T2: "available", T3: "saturated" };
    const decision = decide({ lanePostureByTier: t3Starved });
    expect(decision.dispatch).toBe(true);
  });
});

describe("recordEarnInOutcome", () => {
  it("stops a model after 2 material failures within its first 8 outcomes", () => {
    let state = earnInState();
    state = recordEarnInOutcome(state, "m1", "material-failure", false);
    expect(state.stopped.m1).toBeFalsy();
    state = recordEarnInOutcome(state, "m1", "ok", false);
    expect(state.stopped.m1).toBeFalsy();
    state = recordEarnInOutcome(state, "m1", "material-failure", false);
    expect(state.stopped.m1).toBe(true);
  });

  it("does not stop on a single material failure", () => {
    let state = earnInState();
    state = recordEarnInOutcome(state, "m1", "material-failure", false);
    expect(state.stopped.m1).toBeFalsy();
  });

  it("stops immediately on any safety or authority violation, regardless of outcome history", () => {
    const state = recordEarnInOutcome(earnInState(), "m1", "ok", true);
    expect(state.stopped.m1).toBe(true);
  });

  it("stops remain sticky even after the first-8 window is exhausted", () => {
    let state = earnInState();
    for (let i = 0; i < 8; i++) {
      state = recordEarnInOutcome(state, "m1", i < 2 ? "material-failure" : "ok", false);
    }
    expect(state.stopped.m1).toBe(true);
    // A 9th "ok" outcome must not un-stop the model, and must not grow the
    // capped first-8 window (named mutant: exceed-8-with-injected-clock).
    state = recordEarnInOutcome(state, "m1", "ok", false);
    expect(state.stopped.m1).toBe(true);
    expect(state.firstEightOutcomes.m1).toHaveLength(8);
  });

  it("caps firstEightOutcomes at exactly 8 entries even when never stopped", () => {
    let state = earnInState();
    for (let i = 0; i < 12; i++) {
      state = recordEarnInOutcome(state, "m1", "ok", false);
    }
    expect(state.firstEightOutcomes.m1).toHaveLength(8);
    expect(state.stopped.m1).toBeFalsy();
  });

  it("isMaterialFailure discriminates the two outcome literals", () => {
    expect(isMaterialFailure("material-failure")).toBe(true);
    expect(isMaterialFailure("ok")).toBe(false);
  });
});
