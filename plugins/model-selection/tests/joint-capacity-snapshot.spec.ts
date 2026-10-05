import { describe, expect, it } from "vitest";

import { snapshotJointCapacity } from "../src/joint-capacity-snapshot.js";
import { baseInput, COOLDOWN_MS, NOW_MS, runner } from "./joint-capacity-fixtures.js";

/**
 * joint capacity snapshot — GARM eligible vs queued (read-only).
 *
 * Parent  (joint agent/GARM controller dependency).
 * Pure snapshot only: no pool cap change, no routing change, no queued-job
 * kill, no static drain.
 *
 * NON-GOALS (owned elsewhere):  admission audit log; 
 * burn-down readout;  hysteresis tests;  headroom
 * tie-break;  weekly-pace conflict;  pacing.lanes wire-up.
 */

describe(" joint capacity snapshot", () => {
  it("excludes the free public queue from GARM pressure", () => {
    const snap = snapshotJointCapacity(
      baseInput({ queued: { garmEligible: 0, publicFree: 25 } }),
    );
    expect(snap.pressure).toBe(0);
    expect(snap.queued.publicFreeExcludedFromPressure).toBe(true);
    expect(snap.hysteresis.scaleUpSuggested).toBe(false);
    expect(snap.hysteresis.reasons).toContain("no-garm-eligible-demand");
  });

  it("counts only GARM-eligible queued jobs toward pressure", () => {
    const snap = snapshotJointCapacity(
      baseInput({ queued: { garmEligible: 6, publicFree: 100 } }),
    );
    // 3 free eligible runners: 6 / 3 = 2.0 pressure; public 100 ignored.
    expect(snap.pressure).toBeCloseTo(2, 9);
    expect(snap.hysteresis.scaleUpSuggested).toBe(true);
  });

  it("preserves reviewer/fixer capacity: bottleneck defers scale-up", () => {
    const snap = snapshotJointCapacity(
      baseInput({
        queued: { garmEligible: 6, publicFree: 0 },
        reviewers: { availableReviewers: 1, availableFixers: 2, pendingReviews: 5, pendingFixes: 0 },
      }),
    );
    expect(snap.reviewerFixer.reviewerBottleneck).toBe(true);
    expect(snap.reviewerFixer.preserved).toBe(true);
    expect(snap.hysteresis.scaleUpSuggested).toBe(false);
    expect(snap.hysteresis.reasons).toContain("reviewer-bottleneck-preserved");
  });

  it("preserves fixer capacity independently of reviewers", () => {
    const snap = snapshotJointCapacity(
      baseInput({
        queued: { garmEligible: 6, publicFree: 0 },
        reviewers: { availableReviewers: 5, availableFixers: 1, pendingReviews: 0, pendingFixes: 4 },
      }),
    );
    expect(snap.reviewerFixer.fixerBottleneck).toBe(true);
    expect(snap.hysteresis.scaleUpSuggested).toBe(false);
    expect(snap.hysteresis.reasons).toContain("fixer-bottleneck-preserved");
  });

  it("lets host CPU/RAM/disk/IO budgets govern free capacity", () => {
    const snap = snapshotJointCapacity(
      baseInput({
        runners: [
          runner("runner-1", { hostHeadroom: { cpu: 0, ram: 0.7, disk: 0.9, io: 0.6 } }),
          runner("runner-2"),
        ],
        queued: { garmEligible: 2, publicFree: 0 },
      }),
    );
    // CPU-exhausted runner is out of the free count: 2 / 1 = 2.0.
    expect(snap.eligibleCapacity.freeEligible).toBe(1);
    expect(snap.eligibleCapacity.ineligible).toBe(1);
    expect(snap.eligibleCapacity.ineligibilityReasons).toContain("host-budget-exhausted");
    expect(snap.pressure).toBeCloseTo(2, 9);
  });

  it("names the tightest host resource as the bottleneck", () => {
    const snap = snapshotJointCapacity(baseInput());
    // Fixture headroom: cpu 0.8 / ram 0.7 / disk 0.9 / io 0.6 → io tightest.
    expect(snap.eligibleCapacity.governingHostBottleneck).toBe("io");
  });

  it("keeps quota-exhausted and reset-crossed runners ineligible", () => {
    const snap = snapshotJointCapacity(
      baseInput({
        runners: [
          runner("runner-1", { quotaRemaining: 0 }),
          runner("runner-2", { resetAt: NOW_MS - 1 }),
          runner("runner-3"),
        ],
        queued: { garmEligible: 1, publicFree: 0 },
      }),
    );
    expect(snap.eligibleCapacity.freeEligible).toBe(1);
    expect(snap.eligibleCapacity.ineligible).toBe(2);
    expect(snap.eligibleCapacity.ineligibilityReasons).toEqual(
      expect.arrayContaining(["quota-exhausted", "reset-crossover"]),
    );
  });

  it("separates hysteresis bands and honors cooldown", () => {
    const input = baseInput();
    expect(input.hysteresis.scaleDownPressure).toBeLessThan(input.hysteresis.scaleUpPressure);
    const cooling = snapshotJointCapacity(
      baseInput({
        queued: { garmEligible: 9, publicFree: 0 },
        hysteresis: {
          scaleUpPressure: 1.5,
          scaleDownPressure: 0.5,
          cooldownMs: COOLDOWN_MS,
          lastScaleAt: NOW_MS - 60_000,
        },
      }),
    );
    expect(cooling.hysteresis.cooldownActive).toBe(true);
    expect(cooling.hysteresis.scaleUpSuggested).toBe(false);
    expect(cooling.hysteresis.reasons).toContain("hysteresis-cooldown-active");
  });

  it("allows scale-down for idle resources only", () => {
    const idle = snapshotJointCapacity(baseInput());
    expect(idle.hysteresis.scaleDownAllowed).toBe(true);
    const busy = snapshotJointCapacity(
      baseInput({ runners: [runner("runner-1"), runner("runner-2", { busy: true })] }),
    );
    // Idle capacity and low pressure leave the busy guard as the only veto.
    expect(busy.eligibleCapacity.freeEligible).toBe(1);
    expect(busy.eligibleCapacity.busyEligible).toBe(1);
    expect(busy.pressure).toBe(0);
    expect(busy.hysteresis.cooldownActive).toBe(false);
    expect(busy.hysteresis.scaleDownAllowed).toBe(false);
    const queued = snapshotJointCapacity(
      baseInput({ queued: { garmEligible: 1, publicFree: 0 } }),
    );
    expect(queued.hysteresis.scaleDownAllowed).toBe(false);
  });

  it("is snapshot-only: no cap change, no routing, no kills, trivial rollback", () => {
    const snap = snapshotJointCapacity(
      baseInput({ queued: { garmEligible: 99, publicFree: 0 } }),
    );
    expect(snap.mode).toBe("snapshot-only");
    expect(snap.governsHostStarts).toBe(false);
    expect(snap.mutatesPoolCaps).toBe(false);
    expect(snap.killsQueuedJobs).toBe(false);
    expect(snap.rollbackNotes.join(" ")).toMatch(/discarding/i);
    expect(snap.rollbackNotes.join(" ")).toMatch(/no pool cap change/i);
  });

  // Boundary cases adapted from the Code Reviewer's PR #609 reproductions.
  it.each([
    ["quotaRemaining", null, "quota-unobserved"],
    ["quotaRemaining", undefined, "quota-unobserved"],
    ["resetAt", null, "reset-unobserved"],
    ["resetAt", undefined, "reset-unobserved"],
  ] as const)("fails closed on unobserved %s (%s)", (field, value, reason) => {
    const unobserved = runner("unobserved", { [field]: value });
    const snap = snapshotJointCapacity(baseInput({ runners: [unobserved] }));
    expect(snap.eligibleCapacity.totalEligible).toBe(0);
    expect(snap.eligibleCapacity.freeEligible).toBe(0);
    expect(snap.eligibleCapacity.ineligible).toBe(1);
    expect(snap.eligibleCapacity.ineligibilityReasons).toContain(reason);
    expect(snap.hysteresis.scaleDownAllowed).toBe(false);

    const mixed = snapshotJointCapacity(
      baseInput({ runners: [unobserved, runner("healthy")] }),
    );
    expect(mixed.eligibleCapacity.freeEligible).toBe(1);
    expect(mixed.eligibleCapacity.ineligible).toBe(1);
    expect(mixed.hysteresis.scaleDownAllowed).toBe(true);
  });

  it.each([
    ["quota-exhausted", { quotaRemaining: 0 }],
    ["reset-crossover", { resetAt: NOW_MS - 1 }],
    ["host-budget-exhausted", { hostHeadroom: { cpu: 0, ram: 0.7, disk: 0.9, io: 0.6 } }],
    ["pool-draining", { eligible: false, ineligibilityReason: "pool-draining" }],
    ["runner-offline", { eligible: false, ineligibilityReason: "runner-offline" }],
    ["quota-unobserved", { quotaRemaining: null }],
    ["reset-unobserved", { resetAt: undefined }],
  ] as const)("preserves busy work even when %s prevents new starts", (reason, override) => {
    const snap = snapshotJointCapacity(
      baseInput({ runners: [runner("idle"), runner("busy", { busy: true, ...override })] }),
    );
    expect(snap.eligibleCapacity.freeEligible).toBe(1);
    expect(snap.eligibleCapacity.busyEligible).toBe(0);
    expect(snap.eligibleCapacity.ineligible).toBe(1);
    expect(snap.eligibleCapacity.ineligibilityReasons).toContain(reason);
    expect(snap.pressure).toBe(0);
    expect(snap.hysteresis.cooldownActive).toBe(false);
    expect(snap.hysteresis.scaleDownAllowed).toBe(false);
  });

  it.each(["reviewer", "fixer"] as const)(
    "defers scale-up with zero %s capacity before backlog accrues",
    (role) => {
      const reviewers = { ...baseInput().reviewers };
      if (role === "reviewer") reviewers.availableReviewers = 0;
      else reviewers.availableFixers = 0;
      const snap = snapshotJointCapacity(
        baseInput({ queued: { garmEligible: 6, publicFree: 0 }, reviewers }),
      );
      expect(snap.pressure).toBe(2);
      expect(snap.eligibleCapacity.freeEligible).toBe(3);
      expect(snap.hysteresis.cooldownActive).toBe(false);
      expect(snap.reviewerFixer.reviewerBottleneck).toBe(role === "reviewer");
      expect(snap.reviewerFixer.fixerBottleneck).toBe(role === "fixer");
      expect(snap.hysteresis.reasons).toContain(`${role}-bottleneck-preserved`);
      expect(snap.hysteresis.scaleUpSuggested).toBe(false);
    },
  );

  it("keeps nonzero backlog equality at the existing oversubscription boundary", () => {
    const snap = snapshotJointCapacity(
      baseInput({
        queued: { garmEligible: 6, publicFree: 0 },
        reviewers: { availableReviewers: 2, availableFixers: 2, pendingReviews: 2, pendingFixes: 2 },
      }),
    );
    expect(snap.reviewerFixer.reviewerBottleneck).toBe(false);
    expect(snap.reviewerFixer.fixerBottleneck).toBe(false);
    expect(snap.hysteresis.scaleUpSuggested).toBe(true);
  });

  it("rejects blended hysteresis bands that would flap", () => {
    expect(() =>
      snapshotJointCapacity(
        baseInput({
          hysteresis: {
            scaleUpPressure: 1.0,
            scaleDownPressure: 1.0,
            cooldownMs: COOLDOWN_MS,
            lastScaleAt: null,
          },
        }),
      ),
    ).toThrow("hysteresis-bands-must-separate");
  });

  it("dead band: demand below the scale-up band suggests nothing", () => {
    const snap = snapshotJointCapacity(baseInput({ queued: { garmEligible: 2, publicFree: 0 } }));
    expect(snap.pressure).toBeCloseTo(2 / 3);
    expect(snap.hysteresis.scaleUpSuggested).toBe(false);
    expect(snap.hysteresis.scaleDownAllowed).toBe(false);
  });

  it("scale-up fires exactly at the up band", () => {
    const snap = snapshotJointCapacity(
      baseInput({ runners: [runner("a"), runner("b")], queued: { garmEligible: 3, publicFree: 0 } }),
    );
    expect(snap.pressure).toBe(1.5);
    expect(snap.hysteresis.scaleUpSuggested).toBe(true);
  });

  it("cooldown vetoes idle scale-down", () => {
    const snap = snapshotJointCapacity(
      baseInput({
        hysteresis: {
          scaleUpPressure: 1.5,
          scaleDownPressure: 0.5,
          cooldownMs: COOLDOWN_MS,
          lastScaleAt: NOW_MS - 60_000,
        },
      }),
    );
    expect(snap.hysteresis.cooldownActive).toBe(true);
    expect(snap.hysteresis.scaleDownAllowed).toBe(false);
  });

  it("cooldown ends exactly at cooldownMs", () => {
    const at = (age: number) =>
      snapshotJointCapacity(
        baseInput({
          queued: { garmEligible: 9, publicFree: 0 },
          hysteresis: {
            scaleUpPressure: 1.5,
            scaleDownPressure: 0.5,
            cooldownMs: COOLDOWN_MS,
            lastScaleAt: NOW_MS - age,
          },
        }),
      );
    expect(at(COOLDOWN_MS - 1).hysteresis.cooldownActive).toBe(true);
    expect(at(COOLDOWN_MS).hysteresis.cooldownActive).toBe(false);
    expect(at(COOLDOWN_MS).hysteresis.scaleUpSuggested).toBe(true);
  });

  it("a runner whose reset is exactly now is ineligible", () => {
    const snap = snapshotJointCapacity(baseInput({ runners: [runner("r", { resetAt: NOW_MS })] }));
    expect(snap.eligibleCapacity.ineligibilityReasons).toContain("reset-crossover");
    expect(snap.eligibleCapacity.freeEligible).toBe(0);
  });
});
