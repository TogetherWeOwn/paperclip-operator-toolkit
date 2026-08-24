/**
 * Who is allowed to mint against an issue (TOG-309).
 *
 * Kept free of I/O, like scope.js, so the authorization decision can be tested
 * directly rather than inferred from a route test.
 *
 * ## Why this moved out of the host
 *
 * Until TOG-309 the mint route carried `checkoutPolicy: "always-for-agent"` and
 * the host's `issuesSvc.assertCheckoutOwner` was the whole gate. That function
 * requires all three of:
 *
 *   status === "in_progress"  AND  assigneeAgentId === caller  AND  run lock
 *
 * Measured against the live broker, the status term refuses legitimate callers:
 * an agent acting on review feedback holds its checkout while the issue sits in
 * `in_review`, and got `409 Issue run ownership conflict`. Because the credential
 * helper (correctly) treats a 409 as a definitive refusal and does not fall back
 * to the org-admin PEM, that 409 does not degrade — it kills git outright.
 *
 * Two of those three terms are authorization. The third is lifecycle:
 *
 *   - `assigneeAgentId` answers *who* — this work belongs to the calling agent.
 *   - `checkoutRunId`   answers *which run* — mutual exclusion between the
 *                       agent's own concurrent runs.
 *   - `status`          answers *when* — it does not identify anyone. What it
 *                       actually buys is a lifetime bound: without it, an agent
 *                       still assigned a long-finished issue could mint a repo
 *                       token for that project indefinitely.
 *
 * So the fix is to widen the status term to the states in which an agent
 * legitimately holds a live checkout, and to keep the lifetime bound by refusing
 * the terminal and not-yet-started ones. It is NOT to make the helper retry a
 * refusal with the bigger credential — that would re-create exactly the PEM path
 * TOG-174 exists to remove.
 *
 * The host cannot express that, so the gate moves here. The trade-off is stated
 * plainly: there is no longer a second, independent enforcement of the assignee
 * and run-lock terms behind this file. That is why both terms are re-asserted
 * here verbatim, why an absent field fails closed rather than being read as
 * "no lock", and why `assertMintOwnership` is unit-tested on its own.
 */

/**
 * Statuses in which an agent legitimately holds its checkout and may mint.
 *
 * `in_progress` — active work.
 * `in_review`   — the normal state for an agent acting on review feedback. This
 *                 is the state that TOG-309 measured as broken.
 * `blocked`     — a blocked agent still has to push the branch that documents
 *                 what blocked it, and still gets woken to answer comments.
 *
 * Deliberately excluded, and each exclusion is a decision:
 *
 * `backlog`, `todo`  — work has not started, so no run holds a checkout. An
 *                      agent that needs a token here should move the issue to
 *                      `in_progress` first, which is the honest signal anyway.
 * `done`, `cancelled` — terminal. This is the lifetime bound described above:
 *                      assignment outlives the work, so without this exclusion a
 *                      stale assignment is a standing credential.
 */
export const MINTABLE_ISSUE_STATUSES = Object.freeze([
  "in_progress",
  "in_review",
  "blocked",
]);

const MINTABLE = new Set(MINTABLE_ISSUE_STATUSES);

/** Every status the host defines, so a refusal can name an unknown one. */
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
    return "the issue is finished, and an assignment that outlives the work is not a standing credential";
  }
  if (NOT_STARTED_STATUSES.includes(status)) {
    return "work has not started, so no run holds a checkout — move the issue to in_progress first";
  }
  return "no run holds a checkout in this state";
}

/**
 * Decide whether `actor` may mint against `issue`.
 *
 * Throws `OwnershipError` on refusal; returns a small record describing which
 * terms were satisfied on success, for the audit entry.
 *
 * @param issue  the issue row as returned by `ctx.issues.get` — the full row,
 *               so `checkoutRunId` is present. If it is ever absent this
 *               refuses rather than treating it as an unheld lock.
 * @param actor  `input.actor` from the host. `actorType` and `agentId` are
 *               host-derived on every auth path — `agentId` comes from the JWT
 *               claim or from the agent-key record, never from a header.
 *
 *               `runId` is NOT, and an earlier revision of this comment claimed
 *               it was (TOG-216). It is the signed `run_id` claim only when the
 *               caller authenticated with an agent JWT; on the long-lived
 *               agent-key path it is the raw `X-Paperclip-Run-Id` header with no
 *               validation (`server/dist/middleware/auth.js:302` against `:256`),
 *               and the host does not tell a plugin which path applied.
 *
 *               So the run-lock term below is mutual exclusion between an
 *               agent's own concurrent runs, which is what it is for. It is not
 *               proof of identity, and nothing downstream — the audit entry
 *               included — may read it as proof of identity.
 */
export function assertMintOwnership(issue, actor) {
  if (!issue) {
    throw new OwnershipError("Issue not found.", 404);
  }

  const agentId = actor?.agentId ?? null;
  if (actor?.actorType !== "agent" || !agentId) {
    throw new OwnershipError("This route is callable only by an agent run.", 403);
  }

  // WHO. The strongest term, and the one an attacker would have to defeat to
  // mint against a project it has no work in.
  if (issue.assigneeAgentId !== agentId) {
    throw new OwnershipError("Issue is not assigned to the calling agent.", 403);
  }

  // WHEN. Lifecycle, not identity — widened by TOG-309, but still bounded.
  if (!MINTABLE.has(issue.status)) {
    throw new OwnershipError(
      `Issue is ${issue.status}; tokens are minted only for ${MINTABLE_ISSUE_STATUSES.join(", ")} ` +
        `(${explainStatus(issue.status)}).`,
      409,
    );
  }

  // WHICH RUN. The host required a run id before this route dropped to
  // checkoutPolicy "none"; nothing requires it now, so the broker does.
  const runId = typeof actor.runId === "string" ? actor.runId.trim() : "";
  if (!runId) {
    throw new OwnershipError(
      "Agent run id required. The broker mints only for an identified run.",
      403,
    );
  }

  // Fail closed when the field is missing. `undefined` would mean the host
  // stopped returning the column, not that the checkout is unheld — reading it
  // as the latter would silently drop the run-lock term while every test here
  // still passed, which is the failure mode this check exists for.
  const checkoutRunId = issue.checkoutRunId;
  if (checkoutRunId === undefined) {
    throw new OwnershipError(
      "Issue record carries no checkoutRunId; refusing to mint without the run lock.",
      409,
    );
  }
  if (checkoutRunId !== null && checkoutRunId !== runId) {
    throw new OwnershipError(
      "Issue checkout is held by a different run of this agent.",
      409,
    );
  }

  return {
    agentId,
    runId,
    status: issue.status,
    // null means no run has taken the lock. Recorded so the audit entry
    // distinguishes "this run holds it" from "nobody did".
    checkoutRunId,
  };
}

export default assertMintOwnership;
