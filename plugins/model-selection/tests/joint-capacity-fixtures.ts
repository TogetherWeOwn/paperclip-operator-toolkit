import type {
  GarmRunnerObservation,
  JointCapacitySnapshotInput,
} from "../src/joint-capacity-snapshot.js";

/**
 *  fixtures: joint capacity snapshot inputs.
 *
 * Pure builders only; no live state, no secrets. Clocks are fixed so
 * hysteresis/cooldown assertions are deterministic.
 */

export const NOW_MS = Date.parse("2026-10-04T00:00:00.000Z");
export const COOLDOWN_MS = 15 * 60 * 1000;

export function healthyHeadroom() {
  return { cpu: 0.8, ram: 0.7, disk: 0.9, io: 0.6 };
}

export function runner(
  runnerId: string,
  overrides: Partial<GarmRunnerObservation> = {},
): GarmRunnerObservation {
  const { hostHeadroom: headroomOverride, ...rest } = overrides;
  const defaults = {
    runnerId,
    poolId: "garm-pool-a",
    eligible: true,
    busy: false,
    hostHeadroom: healthyHeadroom(),
    quotaRemaining: 10,
    resetAt: NOW_MS + 3_600_000,
  };
  return {
    ...defaults,
    ...rest,
    hostHeadroom: { ...healthyHeadroom(), ...(headroomOverride ?? {}) },
  };
}

export function baseInput(
  overrides: Partial<JointCapacitySnapshotInput> = {},
): JointCapacitySnapshotInput {
  return {
    now: NOW_MS,
    runners: [runner("runner-1"), runner("runner-2"), runner("runner-3")],
    queued: { garmEligible: 0, publicFree: 0 },
    reviewers: { availableReviewers: 2, availableFixers: 2, pendingReviews: 0, pendingFixes: 0 },
    hysteresis: {
      scaleUpPressure: 1.5,
      scaleDownPressure: 0.5,
      cooldownMs: COOLDOWN_MS,
      lastScaleAt: null,
    },
    ...overrides,
  };
}
