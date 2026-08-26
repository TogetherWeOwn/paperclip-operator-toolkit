/**
 * omniroute-broker — the two-key protocol (TOG-391).
 *
 * Pure w.r.t. decisions: every function here takes the stored record and the
 * caller and returns a verdict. Persistence lives in worker.js
 * (`ctx.state.*`), so the state machine can be tested with plain objects.
 *
 * ## The owner's line
 *
 *   read                                     -> ungated
 *   create / update                          -> single approval, responsible agent
 *   delete, or moving PAID traffic           -> TWO KEYS
 *
 * OmniRoute bills Claude to OpenRouter PAYG today, so the third row is real
 * money and is the reason this file exists.
 *
 * ## What "two keys" has to mean to be worth anything
 *
 * A second approval is security theatre unless all four of these hold. Each has
 * a test.
 *
 *  1. TWO DISTINCT AGENTS. The approver must not be the proposer. This is the
 *     entire property being bought; without it the protocol is a two-step form.
 *     Compared on host-derived `agentId`, never on anything caller-supplied.
 *
 *  2. THE OPERATION CANNOT CHANGE BETWEEN THE KEYS. The approver is consenting
 *     to a specific operation. If the proposer could mutate the body after
 *     approval — or if approval were by id alone — the second key would be
 *     consent to something unread. So a proposal is identified by a DIGEST over
 *     its canonical form, and the approver must present the same digest. A
 *     mismatch is a refusal, never a re-proposal.
 *
 *  3. SINGLE USE. A consumed proposal cannot be replayed into a second
 *     execution. Enforced by a state transition that only ever moves forward.
 *
 *  4. IT EXPIRES. An approval that never expires is a standing grant held by
 *     whoever finds the id. Default TTL is one hour.
 */

export const PROPOSAL_STATE = Object.freeze({
  PENDING: "pending",
  CONSUMED: "consumed",
});

/** One hour. Long enough for a second agent to be woken and act. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class ApprovalError extends Error {
  constructor(message, status, details = null) {
    super(message);
    this.name = "ApprovalError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Canonical JSON with sorted keys at every level, so two structurally identical
 * operations digest identically regardless of key order. Without this, the same
 * operation re-serialised by a different client would fail the digest check and
 * the protocol would be unusable in practice.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

/**
 * Digest the operation the two keys are agreeing about.
 *
 * `issueId` is included deliberately: an approval is scoped to the piece of work
 * it was raised under. The same operation proposed under a different issue is a
 * different proposal and needs its own second key.
 *
 * @param sha256Hex an injected hasher — worker.js passes node:crypto. Injected
 *                  rather than imported so this module stays trivially testable
 *                  and carries no I/O-capable import.
 */
export function digestOperation({ issueId, verb, params, body }, sha256Hex) {
  const canonical = canonicalize({
    issueId: issueId ?? null,
    verb,
    params: params ?? {},
    body: body ?? {},
  });
  return sha256Hex(canonical);
}

/** Build the record persisted for a pending proposal. Never holds a credential. */
export function createProposal({ id, digest, issueId, verb, params, body, proposer, now, ttlMs = DEFAULT_TTL_MS }) {
  if (!proposer?.agentId) {
    throw new ApprovalError("A proposal must record the proposing agent.", 403);
  }
  return {
    id,
    digest,
    state: PROPOSAL_STATE.PENDING,
    issueId: issueId ?? null,
    verb,
    params: params ?? {},
    body: body ?? {},
    proposerAgentId: proposer.agentId,
    proposerRunId: proposer.runId ?? null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    // Filled in by consume(); present from the start so the record's shape does
    // not change between states.
    approverAgentId: null,
    approverRunId: null,
    consumedAt: null,
  };
}

/**
 * Decide whether `approver` may execute `proposal`, and return the record to
 * persist. Throws `ApprovalError` on every refusal.
 *
 * `presentedDigest` is what the approving caller says it is approving. It is
 * compared against the stored digest, which was computed from the stored
 * operation — so an approver that fetched the proposal, read it, and echoed its
 * digest is consenting to exactly the bytes that will be sent.
 */
export function consumeProposal({ proposal, presentedDigest, approver, now }) {
  if (!proposal) {
    throw new ApprovalError("No such proposal. It may have expired and been swept.", 404);
  }

  if (proposal.state !== PROPOSAL_STATE.PENDING) {
    throw new ApprovalError(
      `Proposal is already ${proposal.state}; a second key is single-use and cannot be replayed.`,
      409,
    );
  }

  if (Date.parse(proposal.expiresAt) <= now) {
    throw new ApprovalError(
      `Proposal expired at ${proposal.expiresAt}. Re-propose the operation; an approval that outlives its window is a standing grant.`,
      409,
    );
  }

  // (2) The operation cannot change between the keys.
  if (typeof presentedDigest !== "string" || presentedDigest.length === 0) {
    throw new ApprovalError(
      "An approving call must present the digest of the operation it is approving.",
      400,
    );
  }
  if (!timingSafeEqualHex(presentedDigest, proposal.digest)) {
    throw new ApprovalError(
      "Presented digest does not match the stored proposal. The second key must approve the exact operation that was proposed, not a re-stated one.",
      409,
    );
  }

  // (1) Two distinct agents. The whole point.
  if (!approver?.agentId || approver.actorType !== "agent") {
    throw new ApprovalError("Only an agent run may approve a proposal.", 403);
  }
  if (approver.agentId === proposal.proposerAgentId) {
    throw new ApprovalError(
      "The approving agent must differ from the proposing agent. This operation changes paid routing or deletes configuration, and requires two keys held by two agents.",
      403,
    );
  }

  const approverRunId = typeof approver.runId === "string" ? approver.runId.trim() : "";
  if (!approverRunId) {
    throw new ApprovalError("Agent run id required to approve.", 403);
  }

  // (3) Single use — the returned record is what the caller must persist, and it
  // is no longer PENDING.
  return {
    ...proposal,
    state: PROPOSAL_STATE.CONSUMED,
    approverAgentId: approver.agentId,
    approverRunId,
    consumedAt: new Date(now).toISOString(),
  };
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The digest is not a secret, so this is defence in depth rather than a
 * load-bearing control — but it costs nothing and removes the question.
 */
export function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Caller-safe view of a proposal. Mirrors what a would-be approver needs to read. */
export function describeProposal(proposal) {
  return {
    id: proposal.id,
    digest: proposal.digest,
    state: proposal.state,
    verb: proposal.verb,
    params: proposal.params,
    body: proposal.body,
    issueId: proposal.issueId,
    proposerAgentId: proposal.proposerAgentId,
    approverAgentId: proposal.approverAgentId,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    consumedAt: proposal.consumedAt,
  };
}

export default { createProposal, consumeProposal, digestOperation, canonicalize };
