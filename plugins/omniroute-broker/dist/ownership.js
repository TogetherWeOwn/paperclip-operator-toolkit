/**
 * omniroute-broker — who may ask for an operation (TOG-391).
 *
 * Pure. Carried over from gh-token-broker's ownership.js, which arrived at this
 * shape the expensive way in TOG-309. Re-verified against the running host on
 * 2026-08-25 before copying — see README "checkoutPolicy".
 *
 * ## Why the gate is here and not in the host's checkoutPolicy
 *
 * TOG-391's issue text says to use `checkoutPolicy: "always-for-agent"`. That
 * instruction is STALE, and following it would ship a known bug. Both halves
 * were re-confirmed against the live build at /app on 2026-08-25:
 *
 *   "required-for-agent-in-progress" — server/dist/routes/plugins.js:394
 *       if (policy === "required-for-agent-in-progress") {
 *         if (issue.status !== "in_progress" ||
 *             issue.assigneeAgentId !== req.actor.agentId) return;   // SKIPS
 *       }
 *     Skips assertCheckoutOwner in exactly the case an attacker would pick — an
 *     issue the caller does NOT own. Never use it. (The issue is right about
 *     this, and it is worth restating because the name reads like a tightening.)
 *
 *   "always-for-agent" — calls assertCheckoutOwner unconditionally, and that
 *     function hardcodes the status term. server/dist/services/issues.js:6325:
 *         if (candidate.status === "in_progress" &&
 *             candidate.assigneeAgentId === actorAgentId &&
 *             sameRunLock(candidate.checkoutRunId, actorRunId))
 *     So an agent acting on review feedback, holding its own checkout while the
 *     issue sits in `in_review`, is refused 409. TOG-309 measured that against
 *     the live GitHub broker: the 409 does not degrade, it kills the caller.
 *
 * Two of those three terms are authorization; the third is lifecycle:
 *   - assigneeAgentId  answers WHO       — identity. Load-bearing.
 *   - checkoutRunId    answers WHICH RUN — mutual exclusion between an agent's
 *                                          own concurrent runs.
 *   - status           answers WHEN      — identifies nobody. What it buys is a
 *                                          LIFETIME BOUND: without it, an agent
 *                                          still assigned a long-finished issue
 *                                          could drive the broker forever.
 *
 * The host cannot express a wider status set, so the route runs
 * `checkoutPolicy: "none"` and the gate lives here. The honest cost, stated
 * plainly: there is no longer a second, independent enforcement of the assignee
 * and run-lock terms behind this file. Hence both are re-asserted verbatim, an
 * absent field fails closed, and this function is unit-tested on its own.
 *
 * The host still independently enforces `auth: "agent"` and, regardless of
 * checkoutPolicy, `assertCompanyAccess()` against the company resolved from the
 * issue — so the cross-company boundary does NOT depend on this file.
 */

/**
 * Statuses in which an agent legitimately holds its checkout and may operate.
 *
 * Excluded deliberately:
 *   backlog, todo      — work has not started; no run holds a checkout. Move the
 *                        issue to in_progress, which is the honest signal anyway.
 *   done, cancelled    — terminal. This is the lifetime bound: assignment
 *                        outlives the work, so without this a stale assignment
 *                        would be a standing authority over model routing.
 */
export const OPERABLE_ISSUE_STATUSES = Object.freeze(["in_progress", "in_review", "blocked"]);

const OPERABLE = new Set(OPERABLE_ISSUE_STATUSES);
const TERMINAL_STATUSES = Object.freeze(["done", "cancelled"]);
const NOT_STARTED_STATUSES = Object.freeze(["backlog", "todo"]);

export class OwnershipError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "OwnershipError";
    this.status = status;
  }
}

function explainStatus(status) {
  if (TERMINAL_STATUSES.includes(status)) {
    return "the issue is finished, and an assignment that outlives the work is not a standing authority";
  }
  if (NOT_STARTED_STATUSES.includes(status)) {
    return "work has not started, so no run holds a checkout — move the issue to in_progress first";
  }
  return "no run holds a checkout in this state";
}

/**
 * Decide whether `actor` may drive the broker against `issue`.
 *
 * @param issue the full row from `ctx.issues.get`, so `checkoutRunId` is
 *              present. If it is ever absent this refuses rather than reading it
 *              as an unheld lock.
 * @param actor `input.actor` from the host. Every field is host-derived; the
 *              caller cannot influence `agentId` or `runId`.
 */
export function assertOperationOwnership(issue, actor) {
  if (!issue) throw new OwnershipError("Issue not found.", 404);

  const agentId = actor?.agentId ?? null;
  if (actor?.actorType !== "agent" || !agentId) {
    throw new OwnershipError("This route is callable only by an agent run.", 403);
  }

  // WHO. The strongest term, and the one an attacker must defeat to drive the
  // broker against work it has no part in.
  if (issue.assigneeAgentId !== agentId) {
    throw new OwnershipError("Issue is not assigned to the calling agent.", 403);
  }

  // WHEN. Lifecycle, not identity — widened per TOG-309, still bounded.
  if (!OPERABLE.has(issue.status)) {
    throw new OwnershipError(
      `Issue is ${issue.status}; the broker operates only for ${OPERABLE_ISSUE_STATUSES.join(", ")} ` +
        `(${explainStatus(issue.status)}).`,
      409,
    );
  }

  // WHICH RUN. Nothing requires a run id once checkoutPolicy is "none", so the
  // broker does. An unidentified run cannot be audited, and an operation that
  // cannot be audited must not happen.
  const runId = typeof actor.runId === "string" ? actor.runId.trim() : "";
  if (!runId) {
    throw new OwnershipError(
      "Agent run id required. The broker operates only for an identified run.",
      403,
    );
  }

  // Fail closed on an absent field. `undefined` means the host stopped
  // returning the column, NOT that the checkout is unheld — reading it as the
  // latter would silently drop the run-lock term while every test still passed,
  // which is the exact failure mode this check exists for.
  const checkoutRunId = issue.checkoutRunId;
  if (checkoutRunId === undefined) {
    throw new OwnershipError(
      "Issue record carries no checkoutRunId; refusing to operate without the run lock.",
      409,
    );
  }
  if (checkoutRunId !== null && checkoutRunId !== runId) {
    throw new OwnershipError("Issue checkout is held by a different run of this agent.", 409);
  }

  return { agentId, runId, status: issue.status, checkoutRunId };
}

export default assertOperationOwnership;
