/**
 * omniroute-broker — worker (TOG-391).
 *
 * The contract that makes this worth building: the OmniRoute management key is
 * resolved inside the host process via `ctx.secrets.resolve`, referenced exactly
 * once per operation in omniroute.js, and never returned, logged, written to
 * state, or placed on a command line. The agent gets an EFFECT and a RECEIPT.
 *
 * Order of operations for every mutating request, and the order is the design:
 *
 *   1. host           auth: "agent" + assertCompanyAccess   (cross-company)
 *   2. ownership.js   assignee + status + run lock          (who and when)
 *   3. verbs.js       verb lookup + approval classification (what)
 *   4. approvals.js   second key, if the class demands one  (how many)
 *   5. audit.js       preflight — PROVE the log writable    (before anything)
 *   6. omniroute.js   resolve credential, issue the call    (the only mutation)
 *   7. audit.js       commit — loud if it fails after (6)
 *   8. redact.js      scrub whatever comes back
 *
 * Steps 2-5 all run BEFORE the credential is resolved, so a refused request
 * never touches the secret.
 */

import { createHash, randomUUID } from "node:crypto";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { manifest } from "./manifest.js";
import { APPROVAL, VerbError, assertPlainJson, buildRequest, classifyApproval, resolveVerb, VERBS } from "./verbs.js";
import { OwnershipError, assertOperationOwnership } from "./ownership.js";
import {
  ApprovalError,
  DEFAULT_TTL_MS,
  consumeProposal,
  createProposal,
  describeProposal,
  digestOperation,
} from "./approvals.js";
import { AuditError, UnrecordedMutationError, buildRecord, commit, manualRecoveryLine, preflight } from "./audit.js";
import { OmniRouteError, callManagement } from "./omniroute.js";
import { RedactionError, redactResponse } from "./redact.js";

let context = null;

const json = (status, body) => ({ status, headers: { "Content-Type": "application/json" }, body });

const sha256Hex = (input) => createHash("sha256").update(input, "utf8").digest("hex");

const KNOWN_ERRORS = [VerbError, OwnershipError, ApprovalError, AuditError, OmniRouteError, RedactionError];

const isKnown = (error) => KNOWN_ERRORS.some((Class) => error instanceof Class);

function errorStatus(error) {
  if (error instanceof UnrecordedMutationError) return 500;
  return isKnown(error) ? (error.status ?? 400) : 500;
}

/**
 * Only our own error classes carry operator-authored, caller-safe text. Anything
 * else could be a host or runtime error whose message quotes resolved config —
 * which here would mean the management key — so it is replaced wholesale.
 */
function errorMessage(error) {
  if (error instanceof UnrecordedMutationError) return error.message;
  return isKnown(error) ? error.message : "Internal broker error.";
}

async function readConfig(ctx, companyId) {
  const config = (await ctx.config.get(companyId)) ?? {};
  const missing = ["managementBaseUrl", "managementKeyRef"].filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new OmniRouteError(`Broker is not configured: missing ${missing.join(", ")}.`, 503);
  }
  return config;
}

/**
 * Ask the host to reconcile the checkout lock before we read it (TOG-309).
 *
 * NOT the gate — its status term is exactly what TOG-309 widened. We call it for
 * two side effects it performs before evaluating anything: it clears a checkout
 * lock whose holding run has terminated, and it adopts an unowned lock for the
 * caller. Without it, an issue whose previous run crashed keeps a dead lock and
 * ownership.js refuses on the run-lock term forever.
 *
 * A throw is expected and swallowed: for in_review/blocked it always conflicts.
 * Nothing downstream trusts its return value; the issue is re-read afterwards.
 */
async function reconcileCheckoutLock(ctx, { issueId, companyId, actor }) {
  if (typeof ctx.issues.assertCheckoutOwner !== "function") return;
  const runId = typeof actor.runId === "string" ? actor.runId.trim() : "";
  if (!runId || !actor.agentId) return;
  try {
    await ctx.issues.assertCheckoutOwner({
      issueId,
      companyId,
      actorAgentId: actor.agentId,
      actorRunId: runId,
    });
  } catch {
    /* Deliberately ignored. assertOperationOwnership below is the decision. */
  }
}

/** Steps 1-2: establish that this caller may drive the broker against this issue. */
async function establishOwnership(ctx, { issueId, companyId, actor }) {
  if (!issueId) throw new VerbError("Missing issueId.", 400);
  if (actor?.actorType !== "agent" || !actor?.agentId) {
    throw new OwnershipError("This route is callable only by an agent run.", 403);
  }

  const preliminary = await ctx.issues.get(issueId, companyId);
  if (!preliminary) throw new OwnershipError("Issue not found.", 404);

  // Refuse a foreign issue BEFORE touching the host's checkout machinery, so a
  // caller probing other agents' issues cannot cause lock adoption as a side
  // effect of being told no.
  if (preliminary.assigneeAgentId !== actor.agentId) {
    throw new OwnershipError("Issue is not assigned to the calling agent.", 403);
  }

  await reconcileCheckoutLock(ctx, { issueId, companyId, actor });

  // Re-read: reconcile may have cleared a dead lock or adopted an unowned one,
  // and the decision must be made on the post-reconcile record.
  const issue = (await ctx.issues.get(issueId, companyId)) ?? preliminary;
  return { issue, ownership: assertOperationOwnership(issue, actor) };
}

const proposalKey = (id) => `proposal:${id}`;

/**
 * Execute an approved (or single-approval) operation.
 *
 * Everything before `callManagement` is refusable and cheap; everything after it
 * has already changed OmniRoute. That boundary is why the audit preflight sits
 * where it does.
 */
async function execute(ctx, { companyId, config, issueId, verb, request, approval, ownership, proposal }) {
  const record = buildRecord({
    companyId,
    issueId,
    verb,
    request,
    approval,
    ownership,
    proposal,
    phase: "applied",
  });

  // Rule 1: prove the audit path by USING it, while nothing has happened yet.
  await preflight(ctx, record);

  const payload = await callManagement((url, init) => ctx.http.fetch(url, init), {
    baseUrl: config.managementBaseUrl,
    method: request.method,
    path: request.path,
    body: request.body,
    timeoutMs: config.requestTimeoutMs ?? 20_000,
    // Resolved as late as possible; bound to nothing that outlives this call.
    resolveKey: () =>
      ctx.secrets.resolve(config.managementKeyRef, { companyId, configPath: "managementKeyRef" }),
  });

  // From here the mutation HAS happened. A failed audit is now the
  // [RESOLVED-8] disaster, not an ordinary error — commit() raises
  // UnrecordedMutationError, which is handled distinctly in onApiRequest.
  await commit(ctx, record, { applied: true });

  return payload;
}

/** Ungated read. Ownership-checked, then scrubbed. Never touches the two-key path. */
async function handleRead(ctx, input) {
  const { companyId } = input;
  const issueId = input.params?.issueId;
  const body = assertPlainJson(input.body);

  const { ownership } = await establishOwnership(ctx, { issueId, companyId, actor: input.actor });
  const verb = resolveVerb(body.verb);

  if (verb.approval !== APPROVAL.NONE) {
    throw new VerbError(
      `Verb "${verb.name}" is not a read; call the operate route, which will apply its approval policy.`,
      400,
    );
  }

  const config = await readConfig(ctx, companyId);
  const request = buildRequest(verb, { params: body.params ?? {}, body: null });

  const payload = await callManagement((url, init) => ctx.http.fetch(url, init), {
    baseUrl: config.managementBaseUrl,
    method: request.method,
    path: request.path,
    body: null,
    timeoutMs: config.requestTimeoutMs ?? 20_000,
    resolveKey: () =>
      ctx.secrets.resolve(config.managementKeyRef, { companyId, configPath: "managementKeyRef" }),
  });

  // A management provider record embeds the upstream credential in the clear.
  // This is the line that makes an "ungated read" safe to expose to an agent.
  const { records, count } = redactResponse(payload, verb.resource);

  return json(200, {
    ok: true,
    verb: verb.name,
    count,
    records,
    redaction: {
      // Say so explicitly. A caller that does not know the response was filtered
      // may read an absent field as an absent setting.
      applied: true,
      note: "Fields are restricted to a per-resource allowlist; credential-bearing fields are never returned.",
    },
    actor: { agentId: ownership.agentId, runId: ownership.runId },
  });
}

/** Single-approval execution, or the PROPOSE half of a two-key operation. */
async function handleOperate(ctx, input) {
  const { companyId } = input;
  const issueId = input.params?.issueId;
  const body = assertPlainJson(input.body);

  const { ownership } = await establishOwnership(ctx, { issueId, companyId, actor: input.actor });
  const verb = resolveVerb(body.verb);
  const operationBody = assertPlainJson(body.body ?? {});
  const params = body.params ?? {};

  if (verb.approval === APPROVAL.NONE) {
    throw new VerbError(`Verb "${verb.name}" is a read; call the read route.`, 400);
  }

  // Server-side. The caller cannot choose its own approval class by picking a
  // route or by setting a field — this is the only place the class is decided.
  const approval = classifyApproval(verb, operationBody);
  const request = buildRequest(verb, { params, body: operationBody });
  const config = await readConfig(ctx, companyId);

  if (approval.approval === APPROVAL.DUAL) {
    // Do NOT execute. Record a proposal and hand back the digest a second,
    // different agent must present.
    const digest = digestOperation({ issueId, verb: verb.name, params, body: operationBody }, sha256Hex);
    const ttlMs = (config.proposalTtlMinutes ?? 60) * 60 * 1000 || DEFAULT_TTL_MS;
    const proposal = createProposal({
      id: randomUUID(),
      digest,
      issueId,
      verb: verb.name,
      params,
      body: operationBody,
      proposer: { agentId: ownership.agentId, runId: ownership.runId },
      now: Date.now(),
      ttlMs,
    });

    await ctx.state.set(companyId, proposalKey(proposal.id), proposal);

    // Audited at proposal time as well as at execution: a proposal that is never
    // approved is still something a reviewer needs to be able to see.
    await commit(
      ctx,
      buildRecord({ companyId, issueId, verb, request, approval, ownership, proposal, phase: "proposed" }),
      { applied: false },
    );

    return json(202, {
      ok: true,
      status: "awaiting_second_key",
      approval,
      proposal: describeProposal(proposal),
      next: {
        route: `POST /api/plugins/${manifest.id}/api/issues/{yourIssueId}/approve`,
        body: { proposalId: proposal.id, digest },
        note:
          "A DIFFERENT agent must call this, under an issue that agent holds. The digest must match exactly; it commits the approver to this operation and not a re-stated one.",
      },
    });
  }

  const payload = await execute(ctx, {
    companyId,
    config,
    issueId,
    verb,
    request,
    approval,
    ownership,
    proposal: null,
  });

  return json(200, {
    ok: true,
    status: "applied",
    approval,
    verb: verb.name,
    result: summarizeMutation(payload, verb),
  });
}

/** The APPROVE half. Must be a different agent, holding its own issue. */
async function handleApprove(ctx, input) {
  const { companyId } = input;
  const issueId = input.params?.issueId;
  const body = assertPlainJson(input.body);

  // The approver must itself hold an issue. This is what makes the second key a
  // real agent doing real work rather than an anonymous token.
  const { ownership } = await establishOwnership(ctx, { issueId, companyId, actor: input.actor });

  const proposalId = body.proposalId;
  if (typeof proposalId !== "string" || proposalId.length === 0) {
    throw new ApprovalError("A proposalId is required.", 400);
  }

  const stored = await ctx.state.get(companyId, proposalKey(proposalId));
  const updated = consumeProposal({
    proposal: stored,
    presentedDigest: body.digest,
    approver: { agentId: ownership.agentId, runId: ownership.runId, actorType: "agent" },
    now: Date.now(),
  });

  // Mark consumed BEFORE executing. If the mutation then fails, the proposal is
  // spent and must be re-proposed — deliberately chosen over the alternative,
  // where a crash between execute and mark leaves a live second key that could
  // be replayed into a second delete.
  await ctx.state.set(companyId, proposalKey(proposalId), updated);

  const verb = resolveVerb(updated.verb);
  const request = buildRequest(verb, { params: updated.params, body: updated.body });
  const approval = classifyApproval(verb, updated.body);
  const config = await readConfig(ctx, companyId);

  const payload = await execute(ctx, {
    companyId,
    config,
    // The audit entry is anchored to the issue the operation was PROPOSED under,
    // which is where the work lives, not to the approver's issue.
    issueId: updated.issueId ?? issueId,
    verb,
    request,
    approval,
    ownership,
    proposal: updated,
  });

  return json(200, {
    ok: true,
    status: "applied",
    approval,
    verb: verb.name,
    proposal: describeProposal(updated),
    result: summarizeMutation(payload, verb),
  });
}

/** Let a would-be approver read what it is being asked to approve. */
async function handleProposals(ctx, input) {
  const { companyId } = input;
  const issueId = input.params?.issueId;
  await establishOwnership(ctx, { issueId, companyId, actor: input.actor });

  const proposalId = input.query?.proposalId;
  if (typeof proposalId !== "string" || proposalId.length === 0) {
    throw new ApprovalError("Pass ?proposalId= to read a specific proposal.", 400);
  }
  const stored = await ctx.state.get(companyId, proposalKey(proposalId));
  if (!stored) throw new ApprovalError("No such proposal.", 404);

  return json(200, { ok: true, proposal: describeProposal(stored) });
}

/**
 * Summarise what a mutation returned WITHOUT leaking it.
 *
 * A create returns the created provider — including its upstream credential. So
 * the mutation response goes through the same allowlist as a read; if it does
 * not fit a known resource shape, only the fact of success is reported.
 */
function summarizeMutation(payload, verb) {
  try {
    const { records, count } = redactResponse(payload, verb.resource);
    return { count, records };
  } catch (error) {
    if (error instanceof RedactionError) {
      // The operation SUCCEEDED; only the echo could not be safely rendered.
      // Say exactly that rather than turning a success into an error.
      return { count: null, records: [], note: "Operation applied; response withheld by the scrubber." };
    }
    throw error;
  }
}

export const plugin = definePlugin({
  async setup(ctx) {
    context = ctx;
    ctx.logger.info("omniroute-broker ready", {
      routes: manifest.apiRoutes.map((route) => route.routeKey),
      verbs: Object.keys(VERBS).length,
    });
  },

  async onHealth() {
    return {
      status: context ? "ok" : "error",
      message: context ? "Broker worker running." : "Worker not initialised.",
    };
  },

  async onApiRequest(input) {
    const ctx = context;
    if (!ctx) return json(503, { error: "Broker worker not initialised." });

    try {
      switch (input.routeKey) {
        case "whoami":
          return json(200, {
            ok: true,
            plugin: manifest.id,
            version: manifest.version,
            routeKey: input.routeKey,
            companyId: input.companyId,
            actorType: input.actor?.actorType ?? null,
            agentId: input.actor?.agentId ?? null,
            runId: input.actor?.runId ?? null,
            verbs: Object.keys(VERBS),
          });
        case "read":
          return await handleRead(ctx, input);
        case "operate":
          return await handleOperate(ctx, input);
        case "approve":
          return await handleApprove(ctx, input);
        case "proposals":
          return await handleProposals(ctx, input);
        default:
          return json(404, { error: `Unknown route "${input.routeKey}".` });
      }
    } catch (error) {
      // The [RESOLVED-8] case: the mutation happened and is not in the log.
      // Loud, specific, and carrying the line to enter by hand.
      if (error instanceof UnrecordedMutationError) {
        ctx.logger.error("THE MUTATION WAS APPLIED AND IS NOT IN THE LOG", {
          routeKey: input.routeKey,
          record: error.record,
        });
        return json(500, {
          error: error.message,
          mutationApplied: true,
          auditRecorded: false,
          recordToAddByHand: manualRecoveryLine(error.record),
        });
      }

      const status = errorStatus(error);
      // Class and route only. Never the request body, never resolved config.
      ctx.logger.error("omniroute-broker request failed", {
        routeKey: input.routeKey,
        status,
        error: errorMessage(error),
      });
      return json(status, { error: errorMessage(error) });
    }
  },
});

export default plugin;

runWorker(plugin, import.meta.url);
