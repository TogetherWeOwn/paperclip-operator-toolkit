/**
 * omniroute-broker — audit discipline (TOG-391).
 *
 * Carries over TOG-151-omniroute_combo_cli.sh `[RESOLVED-8]`, which was written
 * after a measured failure on v0.2.4: an unwritable log directory produced a
 * bare "Permission denied" AFTER the PUT had already been applied, with no
 * record written and nothing on screen saying the combo had changed. That is
 * the single worst outcome available to this design — a mutation that happened
 * and left no trace — so its four rules are reproduced here verbatim in intent.
 *
 *   1. PROVE THE AUDIT PATH BY USING IT, BEFORE THE MUTATION. Not by testing a
 *      permission bit — by writing a real record. `preflight()` below.
 *   2. BUILD THE RECORD BEFORE THE MUTATION IS ISSUED. A record assembled after
 *      the fact can fail to assemble after the fact.
 *   3. NEVER MAKE THE AUDIT WRITE BEST-EFFORT. The shell original says it
 *      plainly: `|| true` on those lines is what let an unrecorded mutation look
 *      like a normal error. There is no swallowed catch in this file.
 *   4. ON A POST-MUTATION AUDIT FAILURE, BE LOUD AND BE SPECIFIC. Say that the
 *      mutation was applied, and hand over the exact record to enter by hand.
 *
 * The substrate differs — `ctx.activity.log` rather than a JSONL file — so the
 * symlink and umask rules of the original have no analogue and are deliberately
 * not simulated. Everything about ordering and loudness does transfer, and does.
 */

import { maskForAudit } from "./redact.js";

export class AuditError extends Error {
  constructor(message, status, details = null) {
    super(message);
    this.name = "AuditError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Thrown ONLY when a mutation succeeded and its audit record could not be
 * written. Separate class because it needs separate handling everywhere: it is
 * not a failed operation, it is a successful operation that is now invisible.
 */
export class UnrecordedMutationError extends Error {
  constructor(record, cause) {
    super(
      "THE MUTATION WAS APPLIED AND IS NOT IN THE LOG. " +
        "The operation below succeeded against OmniRoute, but the audit record could not be written. " +
        "Record it by hand before doing anything else.",
    );
    this.name = "UnrecordedMutationError";
    this.status = 500;
    this.record = record;
    this.cause = cause;
  }
}

/** Build the audit record BEFORE the mutation is issued (rule 2). */
export function buildRecord({
  companyId,
  issueId,
  verb,
  request,
  approval,
  ownership,
  proposal = null,
  phase,
}) {
  return {
    companyId,
    entityType: "issue",
    entityId: issueId,
    message: `omniroute-broker ${phase}: ${verb.name}`,
    metadata: {
      phase,
      verb: verb.name,
      method: request.method,
      path: request.path,
      approvalClass: approval.approval,
      approvalEscalated: approval.escalated,
      approvalReason: approval.reason,
      agentId: ownership.agentId,
      runId: ownership.runId,
      issueStatus: ownership.status,
      checkoutRunId: ownership.checkoutRunId,
      proposalId: proposal?.id ?? null,
      proposerAgentId: proposal?.proposerAgentId ?? null,
      approverAgentId: proposal?.approverAgentId ?? null,
      // The body is caller-influenced, so it is masked before it is recorded.
      // An audit trail that echoes a submitted credential is a disclosure
      // channel wearing a compliance hat.
      body: maskForAudit(request.body ?? {}),
    },
  };
}

/**
 * Rule 1 — prove the audit path is writable by WRITING to it, before any
 * mutation is issued. A permission probe is not a proof; only a successful
 * write is.
 *
 * Throws rather than returning false. A broker that cannot audit must not
 * mutate, so this failure has to stop the request, and it stops it at a point
 * where nothing has happened yet.
 */
export async function preflight(ctx, record) {
  const attempt = {
    ...record,
    message: `${record.message} (attempt)`,
    metadata: { ...record.metadata, phase: "attempt" },
  };
  try {
    await ctx.activity.log(attempt);
  } catch (error) {
    throw new AuditError(
      "Refusing to mutate: the audit log is not writable, proven by attempting a write. " +
        `No change has been made. Underlying failure: ${error?.message ?? "unknown"}`,
      503,
    );
  }
  return attempt;
}

/**
 * Rule 3 and 4 — write the completion record. Never best-effort.
 *
 * `applied` distinguishes the two failure worlds:
 *   applied === false  the mutation did not happen; a lost record is survivable
 *                      and surfaces as an ordinary AuditError.
 *   applied === true   the mutation DID happen; a lost record is the
 *                      [RESOLVED-8] disaster and surfaces as
 *                      UnrecordedMutationError with the line to add by hand.
 */
export async function commit(ctx, record, { applied }) {
  try {
    await ctx.activity.log(record);
  } catch (error) {
    if (applied) throw new UnrecordedMutationError(record, error);
    throw new AuditError(
      `Audit record could not be written: ${error?.message ?? "unknown"}. No change was made.`,
      503,
    );
  }
  return record;
}

/**
 * The exact JSON a human should append when `UnrecordedMutationError` fires.
 * Handed back in the error response so recovery does not require reconstructing
 * it from logs — the original prints the line to add by hand for the same reason.
 */
export function manualRecoveryLine(record) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    source: "omniroute-broker",
    note: "written by hand after an audit-write failure; the mutation WAS applied",
    ...record,
  });
}

export default { buildRecord, preflight, commit, manualRecoveryLine };
