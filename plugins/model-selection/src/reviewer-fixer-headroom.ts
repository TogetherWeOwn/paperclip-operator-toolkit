/**
 * Pacer reviewer/fixer load headroom readout (read-only).
 *
 * Joint-controller input for the research on preserving reviewer/fixer
 * capacity while scaling admission. Pure snapshot only: no admission change,
 * no pacing change.
 *
 * WHAT IT IS:
 * - A point-in-time headroom readout over per-agent assignment data: each
 *   reviewer/fixer declares a max-concurrent capacity and a current assigned
 *   load; plus pending unassigned reviews/fixes waiting for hands. Headroom
 *   is capacity minus assigned minus pending, per role and overall.
 * - Caller supplies already-authorized observations; this module never
 *   fetches, never resolves secrets, never writes ledgers, never admits
 *   work, never changes pacing, never reassigns anyone.
 *
 * WHAT IT PROVES (for the joint controller):
 * - Reviewer and fixer bottlenecks are independent: either one being at or
 *   over capacity is reported as a bottleneck that should defer admission,
 *   even when the other role has room.
 * - Pending unassigned work consumes headroom exactly like assigned work:
 *   a queue waiting for hands is load, not free capacity.
 * - The tightest individual is named so the controller (or a human) can see
 *   WHERE the pressure sits, not just that pressure exists.
 * - Zero-capacity rosters cannot read as healthy: with no hands, any
 *   assigned or pending load is a bottleneck.
 *
 * NON-GOALS (owned elsewhere, do NOT duplicate):
 * - The joint GARM eligible-vs-queued snapshot (pressure, host
 *   budgets, quotas, hysteresis live there; this probe reports headroom
 *   only and owns no hysteresis bands or cooldowns).
 * - The admission audit log.
 * - The burn-down trajectory (done).
 */

export const REVIEWER_FIXER_HEADROOM_SCHEMA = "reviewer-fixer-headroom-v1";

export const MAX_HEADROOM_AGENTS_PER_ROLE = 64;
export const MAX_SATURATED_IDS = 32;

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clock = (n: unknown): n is number => finite(n) && (n as number) >= 0;
const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/** One reviewer's (or fixer's) assignment observation, supplied by the caller. */
export interface HeadroomAssignment {
  agentId: string;
  /** Max concurrent items this agent can hold; must be >= 1. */
  maxConcurrent: number;
  /** Currently assigned items; may exceed maxConcurrent (overload). */
  assigned: number;
}

export interface ReviewerFixerHeadroomInput {
  now: number;
  reviewers: HeadroomAssignment[];
  fixers: HeadroomAssignment[];
  /** Work waiting for hands; consumes headroom like assigned work. */
  pendingUnassigned?: {
    reviews: number;
    fixes: number;
  };
}

export interface RoleHeadroom {
  totalCapacity: number;
  totalAssigned: number;
  pendingUnassigned: number;
  /** totalCapacity - totalAssigned - pendingUnassigned; negative means over capacity. */
  headroom: number;
  /** totalAssigned / totalCapacity; null when capacity is zero. */
  utilization: number | null;
  /** Agent ids at or over their personal capacity, sorted, capped. */
  saturatedAgents: string[];
  /** True when headroom <= 0 (no room to admit more of this kind). */
  bottleneck: boolean;
  /** Tightest individual headroom (maxConcurrent - assigned); null when roster empty. */
  tightestIndividualHeadroom: number | null;
}

export interface ReviewerFixerHeadroomSnapshot {
  schema: typeof REVIEWER_FIXER_HEADROOM_SCHEMA;
  mode: "snapshot-only";
  admitsWork: false;
  changesPacing: false;
  reassignsAgents: false;
  evaluatedAt: number;
  reviewers: RoleHeadroom;
  fixers: RoleHeadroom;
  /** True when neither role is bottlenecked (admission MAY proceed on this signal alone). */
  admissionMayProceedOnReviewCapacity: boolean;
  /** Always true: this readout preserves capacity by reporting, never by oversubscribing. */
  preserved: true;
  reasons: string[];
  rollbackNotes: string[];
  limitations: string[];
}

function fail(reason: string): never {
  throw new Error(reason);
}

function validateRoster(roster: HeadroomAssignment[], role: string): void {
  if (!Array.isArray(roster) || roster.length > MAX_HEADROOM_AGENTS_PER_ROLE) {
    fail(role === "reviewers" ? "too-many-headroom-reviewers" : "too-many-headroom-fixers");
  }
  const ids = new Set<string>();
  for (const entry of roster) {
    if (!entry || typeof entry.agentId !== "string" || !ID_RE.test(entry.agentId) || ids.has(entry.agentId)) {
      fail(role === "reviewers" ? "invalid-headroom-reviewer-identity" : "invalid-headroom-fixer-identity");
    }
    ids.add(entry.agentId);
    if (!Number.isSafeInteger(entry.maxConcurrent) || entry.maxConcurrent < 1) {
      fail(role === "reviewers" ? "invalid-headroom-reviewer-capacity" : "invalid-headroom-fixer-capacity");
    }
    if (!count(entry.assigned)) {
      fail(role === "reviewers" ? "invalid-headroom-reviewer-assigned" : "invalid-headroom-fixer-assigned");
    }
  }
}

function validateInput(input: ReviewerFixerHeadroomInput): void {
  if (!clock(input.now)) fail("invalid-headroom-clock");
  validateRoster(input.reviewers, "reviewers");
  validateRoster(input.fixers, "fixers");
  const pending = input.pendingUnassigned ?? { reviews: 0, fixes: 0 };
  if (!pending || !count(pending.reviews) || !count(pending.fixes)) fail("invalid-headroom-pending");
}

function summarizeRole(roster: HeadroomAssignment[], pending: number): RoleHeadroom {
  const totalCapacity = roster.reduce((sum, a) => sum + a.maxConcurrent, 0);
  const totalAssigned = roster.reduce((sum, a) => sum + a.assigned, 0);
  const headroom = totalCapacity - totalAssigned - pending;
  const utilization = totalCapacity === 0 ? null : totalAssigned / totalCapacity;
  const saturatedAgents = roster
    .filter((a) => a.assigned >= a.maxConcurrent)
    .map((a) => a.agentId)
    .sort()
    .slice(0, MAX_SATURATED_IDS);
  const bottleneck = headroom <= 0;
  const tightestIndividualHeadroom =
    roster.length === 0 ? null : Math.min(...roster.map((a) => a.maxConcurrent - a.assigned));
  return {
    totalCapacity,
    totalAssigned,
    pendingUnassigned: pending,
    headroom,
    utilization,
    saturatedAgents,
    bottleneck,
    tightestIndividualHeadroom,
  };
}

/**
 * Pure reviewer/fixer headroom readout. Never fetches, never resolves
 * secrets, never writes, never admits work, never changes pacing, never
 * reassigns agents.
 */
export function snapshotReviewerFixerHeadroom(input: ReviewerFixerHeadroomInput): ReviewerFixerHeadroomSnapshot {
  validateInput(input);
  const pendingReviews = input.pendingUnassigned?.reviews ?? 0;
  const pendingFixes = input.pendingUnassigned?.fixes ?? 0;

  const reviewers = summarizeRole(input.reviewers, pendingReviews);
  const fixers = summarizeRole(input.fixers, pendingFixes);
  const admissionMayProceedOnReviewCapacity = !reviewers.bottleneck && !fixers.bottleneck;

  const reasons: string[] = [];
  if (reviewers.bottleneck) reasons.push("reviewer-bottleneck-preserved");
  else reasons.push("reviewer-headroom-available");
  if (fixers.bottleneck) reasons.push("fixer-bottleneck-preserved");
  else reasons.push("fixer-headroom-available");
  if (pendingReviews > 0) reasons.push("pending-reviews-consume-headroom");
  if (pendingFixes > 0) reasons.push("pending-fixes-consume-headroom");
  if (reviewers.saturatedAgents.length > 0) reasons.push("reviewer-individual-at-capacity");
  if (fixers.saturatedAgents.length > 0) reasons.push("fixer-individual-at-capacity");
  if (admissionMayProceedOnReviewCapacity) reasons.push("admission-may-proceed-on-review-capacity");
  else reasons.push("admission-should-defer-on-review-capacity");

  return {
    schema: REVIEWER_FIXER_HEADROOM_SCHEMA,
    mode: "snapshot-only",
    admitsWork: false,
    changesPacing: false,
    reassignsAgents: false,
    evaluatedAt: input.now,
    reviewers,
    fixers,
    admissionMayProceedOnReviewCapacity,
    preserved: true,
    reasons,
    rollbackNotes: [
      "Snapshot mutates nothing: rollback is discarding this object.",
      "No admission, no pacing change, no reassignment, no ledger write.",
      "Headroom pressure alone never admits work; admission moves on a separate reviewed path.",
    ],
    limitations: [
      "Caller-declared assignments are not certified production evidence.",
      "Headroom is a point-in-time count, not a merge-throughput or lead-time measure.",
      "Raw review/fix counts are never the admission objective; completed merges / lead time are owned by the joint controller.",
      "Hysteresis and cooldown are owned by the joint GARM snapshot; this probe reports headroom only and cannot flap-guard on its own.",
    ],
  };
}
