/**
 * gh-token-broker — worker.
 *
 * Two routes:
 *   GET  /whoami                        — de-risk probe; echoes host-derived actor
 *   POST /issues/:issueId/github-token  — mint a scoped installation token
 *
 * The contract that makes this worth building: the PEM is resolved inside the
 * host process via `ctx.secrets.resolve` and is referenced exactly once, in
 * `mint()`, where it is passed straight to the JWT signer. It is never returned,
 * never logged, never written to state, and never placed on a command line.
 */

import crypto from "node:crypto";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { manifest } from "./manifest.js";
import {
  DEFAULT_PERMISSION_PROFILE,
  ScopeError,
  describeCiVisibility,
  resolveScope,
} from "./scope.js";
import { GitHubError, createAppJwt, getInstallationId, mintInstallationToken, submitRepositoryMutation } from "./github.js";
import { OwnershipError, assertMintOwnership } from "./ownership.js";
import {
  DisclosureError,
  assertAppPrincipal,
  assertPermissionGrant,
  disclosureRequestHash,
  grantId,
  proveAuthority,
  responseIdentifier,
  validateDisclosureRequest,
  validateDisclosureSubmission,
  verifyGrantSignature,
} from "./disclosure.js";

/** Held from setup() so onApiRequest can reach host services. */
let context = null;

function json(status, body) {
  return { status, headers: { "Content-Type": "application/json" }, body };
}

function errorStatus(error) {
  if (error instanceof ScopeError || error instanceof GitHubError || error instanceof OwnershipError || error instanceof DisclosureError) {
    return error.status ?? 400;
  }
  return 500;
}

/**
 * Deliberately conservative: our own error classes carry operator-authored,
 * caller-safe text. Anything else could be an unexpected host or runtime error
 * whose message might quote resolved config, so it is replaced wholesale.
 */
function errorMessage(error) {
  if (error instanceof ScopeError || error instanceof GitHubError || error instanceof OwnershipError || error instanceof DisclosureError) {
    return error.message;
  }
  return "Internal broker error.";
}

async function readConfig(ctx, companyId) {
  const config = (await ctx.config.get(companyId)) ?? {};
  const missing = ["appId", "org", "privateKeyRef"].filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new GitHubError(
      `Broker is not configured: missing ${missing.join(", ")}.`,
      503,
    );
  }
  return config;
}

/**
 * Derive repo + permission scope from the issue the caller demonstrably holds.
 * Every input here comes from the host, not from the request body.
 */
/**
 * Ask the host to reconcile the checkout lock before we read it (TOG-309).
 *
 * We are NOT using this as the gate — its status term is exactly what TOG-309
 * widened, so it refuses legitimate in_review callers. We call it for the two
 * things it does *before* it evaluates anything: it clears a checkout lock whose
 * holding run has terminated, and it adopts an unowned lock for the caller.
 * Without this, an issue whose previous run crashed would keep a dead lock
 * forever and `assertMintOwnership` would refuse it on the run-lock term — the
 * same "git stops working" failure this issue exists to fix, in a new place.
 *
 * A throw is expected and swallowed: for in_review/blocked it always conflicts.
 * Nothing downstream trusts its return value; the issue is re-read afterwards.
 */
async function reconcileCheckoutLock(ctx, { issueId, companyId, actor }) {
  if (typeof ctx.issues.assertCheckoutOwner !== "function") return null;
  const runId = typeof actor.runId === "string" ? actor.runId.trim() : "";
  if (!runId || !actor.agentId) return null;
  try {
    return await ctx.issues.assertCheckoutOwner({
      issueId,
      companyId,
      actorAgentId: actor.agentId,
      actorRunId: runId,
    });
  } catch {
    // Deliberately ignored. This call grants nothing; assertMintOwnership below
    // is the decision, and it runs against a freshly re-read issue either way.
    return null;
  }
}

async function deriveScope(ctx, { issueId, companyId, body, config, actor }) {
  const preliminary = await ctx.issues.get(issueId, companyId);
  if (!preliminary) throw new ScopeError("Issue not found.", 404);

  // Refuse a foreign issue before touching the host's checkout machinery, so a
  // caller probing other agents' issues cannot cause lock adoption as a side
  // effect of being told no.
  if (preliminary.assigneeAgentId !== actor.agentId) {
    throw new OwnershipError("Issue is not assigned to the calling agent.", 403);
  }

  await reconcileCheckoutLock(ctx, { issueId, companyId, actor });

  // Re-read: the reconcile above may have cleared a dead lock or adopted an
  // unowned one, and the decision must be made on the post-reconcile record.
  const issue = (await ctx.issues.get(issueId, companyId)) ?? preliminary;

  // THE GATE. Since checkoutPolicy is "none" (see manifest.js), this is the only
  // enforcement of assignee, status and run lock. It runs before any secret is
  // resolved and before any outbound call.
  const ownership = assertMintOwnership(issue, actor);

  const workspace = await ctx.projects.getWorkspaceForIssue(issueId, companyId);

  let projectEnv = null;
  if (issue.projectId) {
    const project = await ctx.projects.get(issue.projectId, companyId);
    projectEnv = project?.env ?? null;
  }

  const scope = resolveScope({
    projectEnv,
    // Diagnostic only — lets a refusal name whether the gap is "no project" or
    // "project without GH_APP_REPOS". It never participates in the ceiling.
    projectId: issue.projectId ?? null,
    workspaceRepoUrl: workspace?.repoUrl ?? null,
    requestedRepositories: body?.repositories ?? null,
    requestedPermissions: body?.permissions ?? null,
    defaultPermissions: config.defaultPermissions ?? DEFAULT_PERMISSION_PROFILE,
  });

  return { issue, scope, ownership };
}

async function mint(ctx, { companyId, config, scope }) {
  const fetchImpl = (url, init) => ctx.http.fetch(url, init);

  // Resolved as late as possible and never bound to anything that outlives
  // this function.
  const privateKey = await ctx.secrets.resolve(config.privateKeyRef, {
    companyId,
    configPath: "privateKeyRef",
  });

  const jwt = createAppJwt(config.appId, privateKey);

  const installationId =
    config.installationId ?? (await getInstallationId(fetchImpl, config.org, jwt));

  return mintInstallationToken(fetchImpl, installationId, jwt, {
    repositories: scope.repositories,
    permissions: scope.permissions,
  });
}

const disclosureTable = (ctx) => `${ctx.db.namespace}.external_disclosure_receipts`;
const PREFLIGHT_TTL_MS = 5 * 60_000;

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function resolveDisclosureRun(ctx, { companyId, issueId, actor }) {
  const rows = await ctx.db.query(
    `SELECT id, company_id, agent_id, status, session_id_before, session_id_after, context_snapshot FROM public.heartbeat_runs WHERE id = $1 AND company_id = $2 AND agent_id = $3 LIMIT 1`,
    [actor.runId, companyId, actor.agentId],
  );
  const run = rows[0];
  if (!run || run.status !== "running") {
    throw new DisclosureError("External disclosure requires the current running heartbeat run.", 403);
  }
  const contextIssueId = firstString(run.context_snapshot?.issueId, run.context_snapshot?.taskId);
  if (contextIssueId !== issueId) {
    throw new DisclosureError("Authority refused: authenticated run is not scoped to this issue.", 403);
  }
  const sessionId = firstString(run.session_id_after, run.session_id_before);
  if (!sessionId) {
    throw new DisclosureError("Authority refused: authenticated run has no host-recorded session ID.", 403);
  }
  return { runId: run.id, sessionId };
}

async function prepareDisclosure(ctx, input, { requirePreflightId = false } = {}) {
  const { companyId } = input;
  const issueId = input.params?.issueId;
  if (!issueId) throw new DisclosureError("Missing issueId.", 400);
  if (input.actor?.actorType !== "agent" || !input.actor?.agentId || !input.actor?.runId) {
    throw new DisclosureError("External disclosure requires an authenticated agent run.", 403);
  }

  const config = await readConfig(ctx, companyId);
  const request = requirePreflightId
    ? validateDisclosureSubmission(input.body)
    : validateDisclosureRequest(input.body);
  verifyGrantSignature(request.grant, config.externalDisclosureAuthorizers ?? []);

  const preliminary = await ctx.issues.get(issueId, companyId);
  if (!preliminary) throw new DisclosureError("Issue not found.", 404);
  if (preliminary.identifier !== request.grant.allowedIssueId) {
    throw new DisclosureError("Authority refused: route issue does not equal the signed allowed issue.", 403);
  }
  const authenticatedRun = await resolveDisclosureRun(ctx, {
    companyId,
    issueId: preliminary.id,
    actor: input.actor,
  });
  if (authenticatedRun.runId !== request.grant.allowedRunId) {
    throw new DisclosureError("Authority refused: authenticated current run does not equal the signed allowed run.", 403);
  }

  const { issue, scope, ownership } = await deriveScope(ctx, {
    issueId,
    companyId,
    body: {
      repositories: [request.grant.destination.repository.split("/")[1]],
      permissions: request.grant.requiredPermissions,
    },
    config,
    actor: { ...input.actor, runId: authenticatedRun.runId },
  });
  if (ownership.runId !== authenticatedRun.runId) {
    throw new DisclosureError("Authority refused: issue ownership does not equal the authenticated run.", 403);
  }

  const authenticatingPrincipal = assertAppPrincipal(request.grant, config.appId);
  const authority = proveAuthority({ request, issue, actorRunId: authenticatedRun.runId });
  const credential = await mint(ctx, { companyId, config, scope });
  assertPermissionGrant(request.grant.requiredPermissions, credential.permissions ?? scope.permissions);
  const repoName = request.grant.destination.repository.split("/")[1];
  const grantedRepositories = credential.repositories ?? scope.repositories;
  if (!grantedRepositories.some((name) => name.toLowerCase() === repoName.toLowerCase())) {
    throw new DisclosureError("Capability refused: GitHub did not grant the destination repository.", 403);
  }

  const id = grantId(request.grant);
  const requestHash = disclosureRequestHash(request);
  const capability = {
    ok: true,
    authenticatingPrincipal,
    tokenIssuedAt: credential.issuedAt,
    tokenExpiresAt: credential.expiresAt,
    installationId: credential.installationId,
    repositorySelection: credential.repositorySelection,
    repositories: grantedRepositories,
    effectivePermissions: credential.permissions ?? scope.permissions,
  };
  const mutation = {
    destination: request.grant.destination,
    principal: authenticatingPrincipal,
    artifacts: request.grant.artifacts,
    approvalId: request.grant.approvalRecord.id,
  };

  return {
    companyId,
    issue,
    request,
    credential,
    authenticatedRun,
    id,
    requestHash,
    capability,
    authority,
    mutation,
  };
}

async function createDisclosurePreflight(ctx, prepared) {
  const preflightId = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + PREFLIGHT_TTL_MS);
  const table = disclosureTable(ctx);
  const result = await ctx.db.execute(
    `INSERT INTO ${table} (grant_id, company_id, issue_id, issue_identifier, run_id, approval_id, status, receipt_json) VALUES ($1, $2, $3, $4, $5, $6, 'preflighted', $7::jsonb) ON CONFLICT (grant_id) DO NOTHING`,
    [prepared.id, prepared.companyId, prepared.issue.id, prepared.issue.identifier, prepared.authenticatedRun.runId, prepared.request.grant.approvalRecord.id, JSON.stringify({
      version: 1,
      grantId: prepared.id,
      preflightId,
      requestHash: prepared.requestHash,
      issueId: prepared.issue.identifier,
      issueUuid: prepared.issue.id,
      runId: prepared.authenticatedRun.runId,
      sessionId: prepared.authenticatedRun.sessionId,
      approvalId: prepared.request.grant.approvalRecord.id,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: "preflighted",
    })],
  );
  if (result.rowCount !== 1) {
    throw new DisclosureError(`Grant ${prepared.id} has already been preflighted or consumed; replay refused.`, 409);
  }
  return { preflightId, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

async function consumeDisclosurePreflight(ctx, prepared, preflightId, claimedAt) {
  const table = disclosureTable(ctx);
  const result = await ctx.db.execute(
    `UPDATE ${table} SET status = 'claimed', receipt_json = $4::jsonb, updated_at = now() WHERE grant_id = $1 AND status = 'preflighted' AND receipt_json ->> 'preflightId' = $2 AND receipt_json ->> 'requestHash' = $3 AND (receipt_json ->> 'expiresAt')::timestamptz > now()`,
    [prepared.id, preflightId, prepared.requestHash, JSON.stringify({
      version: 1,
      grantId: prepared.id,
      preflightId,
      requestHash: prepared.requestHash,
      issueId: prepared.issue.identifier,
      issueUuid: prepared.issue.id,
      runId: prepared.authenticatedRun.runId,
      sessionId: prepared.authenticatedRun.sessionId,
      approvalId: prepared.request.grant.approvalRecord.id,
      claimedAt,
      status: "claimed",
    })],
  );
  if (result.rowCount !== 1) {
    throw new DisclosureError("Preflight confirmation is missing, expired, mismatched, or already consumed.", 409);
  }
}

async function completeDisclosure(ctx, id, receipt) {
  const table = disclosureTable(ctx);
  const result = await ctx.db.execute(
    `UPDATE ${table} SET status = $2, receipt_json = $3::jsonb, updated_at = now() WHERE grant_id = $1 AND status = 'claimed'`,
    [id, receipt.success ? "accepted" : "rejected", JSON.stringify(receipt)],
  );
  if (result.rowCount !== 1) {
    throw new DisclosureError("Disclosure was consumed but its server-side receipt could not be finalized.", 500);
  }
}

async function handleDisclosurePreflight(ctx, input) {
  const prepared = await prepareDisclosure(ctx, input);
  const confirmation = await createDisclosurePreflight(ctx, prepared);
  return json(200, {
    ok: true,
    capability: prepared.capability,
    authority: prepared.authority,
    mutation: prepared.mutation,
    confirmation,
  });
}

async function handleDisclosure(ctx, input) {
  const prepared = await prepareDisclosure(ctx, input, { requirePreflightId: true });
  const { companyId, issue, request, credential, authenticatedRun, id } = prepared;
  const claimedAt = new Date().toISOString();
  await consumeDisclosurePreflight(ctx, prepared, request.preflightId, claimedAt);

  const entries = [];
  for (const artifact of request.artifacts) {
    const response = await submitRepositoryMutation(
      (url, init) => ctx.http.fetch(url, init),
      credential.token,
      request.grant.destination,
      request.grant.action,
      artifact.body,
    );
    entries.push({
      id: artifact.id,
      artifactSha256: artifact.sha256,
      responseStatus: response.status,
      responseIdentifier: responseIdentifier(response.body),
      outcome: response.ok ? "accepted" : "rejected",
    });
    if (!response.ok) break;
  }

  const success = entries.length === request.artifacts.length && entries.every((entry) => entry.outcome === "accepted");
  const receipt = {
    version: 1,
    grantId: id,
    preflightId: request.preflightId,
    approvalId: request.grant.approvalRecord.id,
    approvalRecordSha256: request.grant.approvalRecord.sha256,
    approvedAt: request.grant.approvedAt,
    claimedAt,
    completedAt: new Date().toISOString(),
    destination: request.grant.destination,
    channel: request.grant.channel,
    action: request.grant.action,
    issueId: issue.identifier,
    issueUuid: issue.id,
    runId: authenticatedRun.runId,
    sessionId: authenticatedRun.sessionId,
    authenticatingPrincipal: prepared.capability.authenticatingPrincipal,
    authorizingPrincipal: request.grant.authorizingPrincipal,
    tokenIssuedAt: credential.issuedAt,
    tokenExpiresAt: credential.expiresAt,
    installationId: credential.installationId,
    repositorySelection: credential.repositorySelection,
    repositories: prepared.capability.repositories,
    effectivePermissions: prepared.capability.effectivePermissions,
    authority: prepared.authority,
    artifacts: entries,
    success,
  };
  await completeDisclosure(ctx, id, receipt);
  await ctx.activity.log({
    companyId,
    message: "External disclosure attempted under task-specific grant",
    entityType: "issue",
    entityId: issue.id,
    metadata: {
      grantId: id,
      preflightId: receipt.preflightId,
      approvalId: receipt.approvalId,
      runId: receipt.runId,
      sessionId: receipt.sessionId,
      destination: receipt.destination,
      artifactHashes: receipt.artifacts.map(({ id: artifactId, artifactSha256 }) => ({ id: artifactId, sha256: artifactSha256 })),
      success,
    },
  });

  return json(success ? 200 : 502, {
    ok: success,
    capability: prepared.capability,
    authority: prepared.authority,
    mutation: prepared.mutation,
    receipt,
  });
}

async function handleWhoami(input) {
  // Reports only what the host derived about the caller. The point of the probe
  // is that the caller cannot influence any of these values.
  return json(200, {
    ok: true,
    plugin: manifest.id,
    version: manifest.version,
    routeKey: input.routeKey,
    companyId: input.companyId,
    actorType: input.actor?.actorType ?? null,
    agentId: input.actor?.agentId ?? null,
    runId: input.actor?.runId ?? null,
  });
}

async function handleMint(ctx, input) {
  const { companyId } = input;
  const issueId = input.params?.issueId;

  if (!issueId) throw new ScopeError("Missing issueId.", 400);

  // The host enforced auth: "agent" and assertCompanyAccess. It no longer
  // enforces checkout ownership for this route (see manifest.js), so this check
  // and assertMintOwnership below are the only things standing between a
  // non-agent caller and a mint.
  if (input.actor?.actorType !== "agent" || !input.actor?.agentId) {
    throw new OwnershipError("This route is callable only by an agent run.", 403);
  }

  const config = await readConfig(ctx, companyId);
  const body = typeof input.body === "object" && input.body !== null ? input.body : {};

  const { scope, ownership } = await deriveScope(ctx, {
    issueId,
    companyId,
    body,
    config,
    actor: input.actor,
  });
  const result = await mint(ctx, { companyId, config, scope });

  // Audit the grant, never the grant material.
  await ctx.activity.log({
    companyId,
    message: `Minted GitHub token for ${scope.repositories.join(", ")}`,
    entityType: "issue",
    entityId: issueId,
    metadata: {
      agentId: input.actor.agentId,
      runId: input.actor.runId ?? null,
      // TOG-309. The gate now lives in the broker, so the audit trail has to
      // record which lifecycle state and which lock the mint was authorised
      // under — otherwise a widened status set is invisible after the fact.
      issueStatus: ownership.status,
      checkoutRunId: ownership.checkoutRunId,
      repositories: scope.repositories,
      permissions: scope.permissions,
      repoSource: scope.repoSource,
      profileSource: scope.profileSource,
      expiresAt: result.expiresAt,
    },
  });

  // Derived from what GitHub actually granted, not from what we asked for. If
  // the App's own ceiling is narrower than the profile, the caller must be told
  // it is blind based on the real grant. (TOG-247)
  const granted = result.permissions ?? scope.permissions;

  return json(200, {
    token: result.token,
    expiresAt: result.expiresAt,
    repositories: result.repositories ?? scope.repositories,
    permissions: granted,
    scope: {
      repoSource: scope.repoSource,
      profileSource: scope.profileSource,
    },
    ciVisibility: describeCiVisibility(granted),
  });
}

export const plugin = definePlugin({
  async setup(ctx) {
    context = ctx;
    ctx.logger.info("gh-token-broker ready", {
      routes: manifest.apiRoutes.map((route) => route.routeKey),
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
          return await handleWhoami(input);
        case "disclosure-preflight":
          return await handleDisclosurePreflight(ctx, input);
        case "disclose":
          return await handleDisclosure(ctx, input);
        case "mint":
          return await handleMint(ctx, input);
        default:
          return json(404, { error: `Unknown route "${input.routeKey}".` });
      }
    } catch (error) {
      const status = errorStatus(error);
      // Log the class and route, never the request body or resolved config.
      ctx.logger.error("gh-token-broker request failed", {
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
