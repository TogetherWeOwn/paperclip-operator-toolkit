import { describe, expect, it } from "vitest";

import { snapshotReviewerFixerHeadroom } from "../src/reviewer-fixer-headroom.js";
import { baseInput, fixer, reviewer } from "./reviewer-fixer-headroom-fixtures.js";

/**
 * TOG-14458: pacer reviewer/fixer load headroom readout (read-only).
 *
 * Parent TOG-13439 via fan-out TOG-14439; joint-controller input for
 * TOG-12456. Pure snapshot only: no admission change, no pacing change,
 * no reassignment.
 *
 * NON-GOALS (owned elsewhere): TOG-14347 GARM eligible-vs-queued snapshot
 * (pressure/host/quotas/hysteresis); TOG-14079 admission audit log;
 * TOG-14288 burn-down readout (done).
 */

describe("TOG-14458 reviewer/fixer headroom readout", () => {
  it("reports healthy headroom when both roles have room", () => {
    const snap = snapshotReviewerFixerHeadroom(baseInput());
    expect(snap.reviewers.headroom).toBe(4);
    expect(snap.fixers.headroom).toBe(4);
    expect(snap.reviewers.bottleneck).toBe(false);
    expect(snap.fixers.bottleneck).toBe(false);
    expect(snap.admissionMayProceedOnReviewCapacity).toBe(true);
    expect(snap.preserved).toBe(true);
    expect(snap.reasons).toContain("admission-may-proceed-on-review-capacity");
  });

  it("flags a reviewer bottleneck independently of fixer room", () => {
    const snap = snapshotReviewerFixerHeadroom(
      baseInput({
        reviewers: [reviewer("reviewer-1", { maxConcurrent: 2, assigned: 2 }), reviewer("reviewer-2", { maxConcurrent: 2, assigned: 2 })],
      }),
    );
    expect(snap.reviewers.headroom).toBe(0);
    expect(snap.reviewers.bottleneck).toBe(true);
    expect(snap.fixers.bottleneck).toBe(false);
    expect(snap.admissionMayProceedOnReviewCapacity).toBe(false);
    expect(snap.reasons).toContain("reviewer-bottleneck-preserved");
    expect(snap.reasons).toContain("admission-should-defer-on-review-capacity");
  });

  it("flags a fixer bottleneck independently of reviewer room", () => {
    const snap = snapshotReviewerFixerHeadroom(
      baseInput({
        fixers: [fixer("fixer-1", { maxConcurrent: 1, assigned: 3 })],
      }),
    );
    // 1 - 3 = -2: overload reads as negative headroom, still a bottleneck.
    expect(snap.fixers.headroom).toBe(-2);
    expect(snap.fixers.bottleneck).toBe(true);
    expect(snap.reviewers.bottleneck).toBe(false);
    expect(snap.admissionMayProceedOnReviewCapacity).toBe(false);
    expect(snap.reasons).toContain("fixer-bottleneck-preserved");
  });

  it("counts pending unassigned work against headroom like assigned work", () => {
    const snap = snapshotReviewerFixerHeadroom(
      baseInput({ pendingUnassigned: { reviews: 4, fixes: 0 } }),
    );
    // Reviewers: 4 capacity - 0 assigned - 4 pending = 0 → bottleneck.
    expect(snap.reviewers.headroom).toBe(0);
    expect(snap.reviewers.bottleneck).toBe(true);
    expect(snap.fixers.bottleneck).toBe(false);
    expect(snap.reasons).toContain("pending-reviews-consume-headroom");
  });

  it("names the saturated individuals and the tightest headroom", () => {
    const snap = snapshotReviewerFixerHeadroom(
      baseInput({
        reviewers: [
          reviewer("reviewer-1", { maxConcurrent: 2, assigned: 2 }),
          reviewer("reviewer-2", { maxConcurrent: 3, assigned: 1 }),
        ],
      }),
    );
    expect(snap.reviewers.saturatedAgents).toEqual(["reviewer-1"]);
    expect(snap.reviewers.tightestIndividualHeadroom).toBe(0);
    expect(snap.reasons).toContain("reviewer-individual-at-capacity");
  });

  it("reports utilization and zero-capacity rosters without reading healthy", () => {
    const snap = snapshotReviewerFixerHeadroom(
      baseInput({ reviewers: [], pendingUnassigned: { reviews: 1, fixes: 0 } }),
    );
    expect(snap.reviewers.totalCapacity).toBe(0);
    expect(snap.reviewers.utilization).toBeNull();
    expect(snap.reviewers.headroom).toBe(-1);
    expect(snap.reviewers.bottleneck).toBe(true);
    expect(snap.reviewers.tightestIndividualHeadroom).toBeNull();
    expect(snap.admissionMayProceedOnReviewCapacity).toBe(false);
  });

  it("is snapshot-only: no admission, no pacing, no reassignment, trivial rollback", () => {
    const snap = snapshotReviewerFixerHeadroom(
      baseInput({ pendingUnassigned: { reviews: 99, fixes: 99 } }),
    );
    expect(snap.mode).toBe("snapshot-only");
    expect(snap.admitsWork).toBe(false);
    expect(snap.changesPacing).toBe(false);
    expect(snap.reassignsAgents).toBe(false);
    expect(snap.rollbackNotes.join(" ")).toMatch(/discarding/i);
    expect(snap.rollbackNotes.join(" ")).toMatch(/no admission/i);
  });

  it("rejects duplicate agent ids within a role", () => {
    expect(() =>
      snapshotReviewerFixerHeadroom(
        baseInput({ reviewers: [reviewer("dup"), reviewer("dup")] }),
      ),
    ).toThrow("invalid-headroom-reviewer-identity");
  });

  it("rejects zero max-concurrent capacity", () => {
    expect(() =>
      snapshotReviewerFixerHeadroom(
        baseInput({ fixers: [fixer("fixer-1", { maxConcurrent: 0 })] }),
      ),
    ).toThrow("invalid-headroom-fixer-capacity");
  });

  it("rejects rosters over the per-role cap", () => {
    const many = Array.from({ length: 65 }, (_, i) => reviewer(`reviewer-${i}`));
    expect(() => snapshotReviewerFixerHeadroom(baseInput({ reviewers: many }))).toThrow(
      "too-many-headroom-reviewers",
    );
  });
});
