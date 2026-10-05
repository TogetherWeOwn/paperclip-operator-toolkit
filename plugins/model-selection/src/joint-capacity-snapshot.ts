/**
 * : joint capacity snapshot — GARM eligible vs queued vs reviewer/fixer.
 *
 * Parent  (pacer dependency for the joint agent/GARM controller,
 *  research). Read-only, pure, no live mutation.
 *
 * WHAT IT IS:
 * - A point-in-time snapshot of eligible GARM runner capacity against queued
 *   demand and reviewer/fixer capacity, with hysteresis/rollback notes for
 *   the joint controller. Caller supplies already-authorized observations;
 *   this module never fetches, never resolves secrets, never writes ledgers,
 *   never changes pool caps, never routes, never kills queued jobs.
 *
 * WHAT IT PROVES:
 * - Free public GitHub queue demand never counts toward GARM pressure
 *   (GARM-eligible queued jobs only).
 * - Reviewer/fixer capacity is preserved: a reviewer or fixer bottleneck
 *   defers scale-up even when runner slots are free.
 * - Host CPU/RAM/disk/IO budgets govern: a runner with any exhausted
 *   headroom is not counted as free; the tightest resource names the
 *   bottleneck.
 * - Quotas/reset windows govern: quota-exhausted or reset-crossed runners
 *   are ineligible, never free capacity.
 * - Hysteresis: separate up/down pressure bands plus cooldown and
 *   idle-only scale-down, so the snapshot cannot flap.
 * - Rollback is trivial: the snapshot mutates nothing, so rollback is
 *   discarding it; no static drain, no queued-job kill.
 *
 * NON-GOALS (owned elsewhere, do NOT duplicate):
 * -  admission audit log (in_review)
 * -  burn-down readout (done)
 * -  hysteresis tests (blocked)
 * -  headroom tie-break (blocked)
 * -  weekly-pace conflict (blocked)
 * -  pacing.lanes wire-up (in_progress)
 *
 * Throughput note: the joint controller optimizes completed
 * merges / lead time, not raw run count. This snapshot reports pressure, not
 * a merge rate; raw run count is never the admission objective.
 */

export const MAX_SNAPSHOT_RUNNERS = 64;
export const MAX_SNAPSHOT_POOLS = 16;

/** One GARM runner observation supplied by an authorized caller. */
export interface GarmRunnerObservation {
  runnerId: string;
  poolId: string;
  /** False means the runner cannot take GARM-eligible work right now. */
  eligible: boolean;
  /** Required when eligible is false; absent when eligible is true. */
  ineligibilityReason?:
    | 'quota-exhausted'
    | 'reset-crossover'
    | 'host-budget-exhausted'
    | 'pool-draining'
    | 'runner-offline';
  /** True while the runner executes a job. */
  busy: boolean;
  /**
   * Host headroom fractions in [0, 1] (1 = fully free). The minimum across
   * the four governs: any exhausted resource means the host cannot start.
   */
  hostHeadroom: {
    cpu: number;
    ram: number;
    disk: number;
    io: number;
  };
  /** Remaining quota job slots; null/undefined is unobserved and prevents starts. */
  quotaRemaining?: number | null;
  /** Quota reset epoch ms; null/undefined is unobserved and prevents starts. */
  resetAt?: number | null;
}

/** Queued demand split by queue class. */
export interface QueuedDemand {
  /** Jobs that can only run on GARM-eligible runners. */
  garmEligible: number;
  /** Jobs servable by the free public GitHub queue; never GARM pressure. */
  publicFree: number;
}

/**
 * Role supply and backlog supplied by an authorized caller. Available counts
 * are not residual slots after subtracting pending work. A zero supply always
 * bottlenecks; otherwise the existing threshold is pending > available. This
 * snapshot reports that threshold, not a reservation for future reviews/fixes.
 */
export interface ReviewerFixerCapacity {
  availableReviewers: number;
  availableFixers: number;
  pendingReviews: number;
  pendingFixes: number;
}

export interface SnapshotHysteresis {
  /** Pressure at/above which scale-up may be *considered* (never applied here). */
  scaleUpPressure: number;
  /** Pressure at/below which idle scale-down may be *considered*. Must be < up. */
  scaleDownPressure: number;
  /** Minimum ms between controller actions; snapshot honors it, never waits. */
  cooldownMs: number;
  /** Last controller action epoch ms; null means no prior action observed. */
  lastScaleAt: number | null;
}

export interface JointCapacitySnapshotInput {
  now: number;
  runners: GarmRunnerObservation[];
  queued: QueuedDemand;
  reviewers: ReviewerFixerCapacity;
  hysteresis: SnapshotHysteresis;
}

export type HostResource = 'cpu' | 'ram' | 'disk' | 'io';

export interface JointCapacitySnapshot {
  mode: 'snapshot-only';
  governsHostStarts: false;
  mutatesPoolCaps: false;
  killsQueuedJobs: false;
  evaluatedAt: number;
  eligibleCapacity: {
    totalEligible: number;
    freeEligible: number;
    busyEligible: number;
    ineligible: number;
    /** Tightest host resource across free-eligible runners; null when none free. */
    governingHostBottleneck: HostResource | null;
    ineligibilityReasons: string[];
  };
  queued: {
    garmEligible: number;
    publicFree: number;
    /** Public-free demand is reported, never counted toward pressure. */
    publicFreeExcludedFromPressure: true;
  };
  reviewerFixer: {
    reviewerBottleneck: boolean;
    fixerBottleneck: boolean;
    preserved: boolean;
  };
  /** GARM-eligible queued / max(1, freeEligible). Public queue excluded. */
  pressure: number;
  hysteresis: {
    scaleUpSuggested: boolean;
    scaleDownAllowed: boolean;
    cooldownActive: boolean;
    reasons: string[];
  };
  rollbackNotes: string[];
  limitations: string[];
}

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clock = (n: unknown): n is number => finite(n) && n >= 0;
const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const frac = (n: unknown): n is number => finite(n) && (n as number) >= 0 && (n as number) <= 1;

function fail(reason: string): never {
  throw new Error(reason);
}

function validateInput(input: JointCapacitySnapshotInput): void {
  if (!clock(input.now)) fail('invalid-snapshot-clock');
  if (input.runners.length > MAX_SNAPSHOT_RUNNERS) fail('too-many-snapshot-runners');
  if (new Set(input.runners.map((r) => r.poolId)).size > MAX_SNAPSHOT_POOLS) {
    fail('too-many-snapshot-pools');
  }
  const ids = new Set<string>();
  for (const r of input.runners) {
    if (typeof r.runnerId !== 'string' || !ID_RE.test(r.runnerId) || ids.has(r.runnerId)) {
      fail('invalid-snapshot-runner-identity');
    }
    ids.add(r.runnerId);
    if (typeof r.poolId !== 'string' || !ID_RE.test(r.poolId)) fail('invalid-snapshot-pool-identity');
    if (typeof r.eligible !== 'boolean' || typeof r.busy !== 'boolean') fail('invalid-snapshot-runner-state');
    if (!r.eligible && r.ineligibilityReason === undefined) fail('missing-ineligibility-reason');
    if (r.eligible && r.ineligibilityReason !== undefined) fail('eligible-runner-carries-ineligibility-reason');
    if (
      r.ineligibilityReason !== undefined &&
      !['quota-exhausted', 'reset-crossover', 'host-budget-exhausted', 'pool-draining', 'runner-offline'].includes(
        r.ineligibilityReason,
      )
    ) {
      fail('invalid-ineligibility-reason');
    }
    const h = r.hostHeadroom;
    if (!h || !frac(h.cpu) || !frac(h.ram) || !frac(h.disk) || !frac(h.io)) {
      fail('invalid-host-headroom');
    }
    if (r.quotaRemaining !== undefined && r.quotaRemaining !== null && !count(r.quotaRemaining)) {
      fail('invalid-quota-remaining');
    }
    if (r.resetAt !== undefined && r.resetAt !== null && !clock(r.resetAt)) fail('invalid-reset-at');
  }
  if (!count(input.queued.garmEligible) || !count(input.queued.publicFree)) {
    fail('invalid-queued-demand');
  }
  const v = input.reviewers;
  if (!count(v.availableReviewers) || !count(v.availableFixers) || !count(v.pendingReviews) || !count(v.pendingFixes)) {
    fail('invalid-reviewer-fixer-capacity');
  }
  const h = input.hysteresis;
  if (!finite(h.scaleUpPressure) || h.scaleUpPressure <= 0) fail('invalid-scale-up-pressure');
  if (!finite(h.scaleDownPressure) || h.scaleDownPressure < 0) fail('invalid-scale-down-pressure');
  if (!(h.scaleDownPressure < h.scaleUpPressure)) fail('hysteresis-bands-must-separate');
  if (!count(h.cooldownMs)) fail('invalid-hysteresis-cooldown');
  if (h.lastScaleAt !== null && !clock(h.lastScaleAt)) fail('invalid-last-scale-at');
}

/**
 * Pure joint capacity snapshot. Never fetches, never resolves secrets, never
 * writes, never changes pool caps, never routes, never kills queued jobs.
 */
export function snapshotJointCapacity(input: JointCapacitySnapshotInput): JointCapacitySnapshot {
  validateInput(input);

  // Host budgets govern per runner: any exhausted headroom (<= 0) means the
  // runner cannot start, even when nominally eligible and idle. Quota and
  // reset-crossing govern the same way: missing evidence, quotaRemaining <= 0,
  // or a reset at/before now keeps the runner out of the eligible count.
  const ineligibilityReasons: string[] = [];
  let totalEligible = 0;
  let freeEligible = 0;
  let busyEligible = 0;
  let ineligible = 0;
  const freeHeadroomMin: Record<HostResource, number> = { cpu: 1, ram: 1, disk: 1, io: 1 };
  let sawFree = false;

  for (const r of input.runners) {
    const hostExhausted = r.hostHeadroom.cpu <= 0 || r.hostHeadroom.ram <= 0 || r.hostHeadroom.disk <= 0 || r.hostHeadroom.io <= 0;
    const quotaUnobserved = r.quotaRemaining === undefined || r.quotaRemaining === null;
    const resetUnobserved = r.resetAt === undefined || r.resetAt === null;
    const quotaExhausted = r.quotaRemaining !== undefined && r.quotaRemaining !== null && r.quotaRemaining <= 0;
    const resetCrossed = r.resetAt !== undefined && r.resetAt !== null && r.resetAt <= input.now;
    if (!r.eligible || hostExhausted || quotaUnobserved || resetUnobserved || quotaExhausted || resetCrossed) {
      ineligible += 1;
      if (r.ineligibilityReason) ineligibilityReasons.push(r.ineligibilityReason);
      else if (hostExhausted) ineligibilityReasons.push('host-budget-exhausted');
      else if (quotaUnobserved) ineligibilityReasons.push('quota-unobserved');
      else if (quotaExhausted) ineligibilityReasons.push('quota-exhausted');
      else if (resetUnobserved) ineligibilityReasons.push('reset-unobserved');
      else if (resetCrossed) ineligibilityReasons.push('reset-crossover');
      continue;
    }
    totalEligible += 1;
    if (r.busy) {
      busyEligible += 1;
    } else {
      freeEligible += 1;
      sawFree = true;
      freeHeadroomMin.cpu = Math.min(freeHeadroomMin.cpu, r.hostHeadroom.cpu);
      freeHeadroomMin.ram = Math.min(freeHeadroomMin.ram, r.hostHeadroom.ram);
      freeHeadroomMin.disk = Math.min(freeHeadroomMin.disk, r.hostHeadroom.disk);
      freeHeadroomMin.io = Math.min(freeHeadroomMin.io, r.hostHeadroom.io);
    }
  }

  let governingHostBottleneck: HostResource | null = null;
  if (sawFree) {
    const entries = Object.entries(freeHeadroomMin) as Array<[HostResource, number]>;
    entries.sort((a, b) => a[1] - b[1]);
    governingHostBottleneck = entries[0]![0];
  }

  // Reviewer/fixer capacity is preserved, never oversubscribed by runner
  // headroom: missing hands or pending work beyond available hands is a
  // bottleneck that defers scale-up on its own.
  const reviewerBottleneck =
    input.reviewers.availableReviewers === 0 || input.reviewers.pendingReviews > input.reviewers.availableReviewers;
  const fixerBottleneck =
    input.reviewers.availableFixers === 0 || input.reviewers.pendingFixes > input.reviewers.availableFixers;

  // Pressure counts GARM-eligible queued jobs ONLY. The free public queue is
  // reported alongside and explicitly excluded — public demand must never
  // justify GARM capacity action.
  const pressure = input.queued.garmEligible / Math.max(1, freeEligible);

  const cooldownActive =
    input.hysteresis.lastScaleAt !== null && input.now - input.hysteresis.lastScaleAt < input.hysteresis.cooldownMs;

  const reasons: string[] = [];
  if (cooldownActive) reasons.push('hysteresis-cooldown-active');
  if (reviewerBottleneck) reasons.push('reviewer-bottleneck-preserved');
  if (fixerBottleneck) reasons.push('fixer-bottleneck-preserved');
  if (input.queued.garmEligible === 0) reasons.push('no-garm-eligible-demand');
  if (freeEligible === 0 && input.queued.garmEligible > 0) reasons.push('no-free-eligible-capacity');

  // Hysteresis: scale-up needs high-band pressure with reviewers/fixers OK
  // and cooldown elapsed. Scale-down is idle-only (nothing eligible queued,
  // nothing busy) in the low band with cooldown elapsed — idle resources
  // drain gracefully, never under load.
  const scaleUpSuggested =
    !cooldownActive &&
    !reviewerBottleneck &&
    !fixerBottleneck &&
    pressure >= input.hysteresis.scaleUpPressure &&
    input.queued.garmEligible > 0;
  if (scaleUpSuggested) reasons.push('scale-up-may-be-considered-by-controller');
  else if (!cooldownActive && pressure >= input.hysteresis.scaleUpPressure && input.queued.garmEligible > 0) {
    reasons.push('scale-up-deferred-by-reviewer-fixer-bottleneck');
  }

  // Start eligibility cannot erase executing work from the idle-only guard.
  const idle = input.queued.garmEligible === 0 && input.runners.every((r) => !r.busy);
  const scaleDownAllowed =
    !cooldownActive && idle && pressure <= input.hysteresis.scaleDownPressure && freeEligible > 0;
  if (scaleDownAllowed) reasons.push('idle-scale-down-may-be-considered-by-controller');
  else if (idle && !cooldownActive) reasons.push('idle-but-above-scale-down-band');

  return {
    mode: 'snapshot-only',
    governsHostStarts: false,
    mutatesPoolCaps: false,
    killsQueuedJobs: false,
    evaluatedAt: input.now,
    eligibleCapacity: {
      totalEligible,
      freeEligible,
      busyEligible,
      ineligible,
      governingHostBottleneck,
      ineligibilityReasons: [...new Set(ineligibilityReasons)],
    },
    queued: {
      garmEligible: input.queued.garmEligible,
      publicFree: input.queued.publicFree,
      publicFreeExcludedFromPressure: true,
    },
    reviewerFixer: {
      reviewerBottleneck,
      fixerBottleneck,
      preserved: true,
    },
    pressure,
    hysteresis: {
      scaleUpSuggested,
      scaleDownAllowed,
      cooldownActive,
      reasons,
    },
    rollbackNotes: [
      'Snapshot mutates nothing: rollback is discarding this object.',
      'No pool cap change, no routing change, no queued-job kill, no static drain.',
      'A high queue alone never raises a pool cap; caps move on a separate reviewed path.',
      'Scale-down applies to idle resources only, never under queued or busy load.',
    ],
    limitations: [
      'Caller-declared observations are not certified production evidence.',
      'Pressure is a point-in-time ratio, not a merge-throughput or lead-time measure.',
      'Raw run count is never the admission objective; completed merges / lead time are owned by the joint controller.',
      'Missing quota/reset evidence keeps runners ineligible, never free capacity.',
    ],
  };
}
