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

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { manifest } from "./manifest.js";
import { DEFAULT_PERMISSION_PROFILE, ScopeError, resolveScope } from "./scope.js";
import { GitHubError, createAppJwt, getInstallationId, mintInstallationToken } from "./github.js";

/** Held from setup() so onApiRequest can reach host services. */
let context = null;

function json(status, body) {
  return { status, headers: { "Content-Type": "application/json" }, body };
}

function errorStatus(error) {
  if (error instanceof ScopeError || error instanceof GitHubError) {
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
  if (error instanceof ScopeError || error instanceof GitHubError) {
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
async function deriveScope(ctx, { issueId, companyId, body, config, actor }) {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) throw new ScopeError("Issue not found.", 404);

  // Defence in depth against a manifest regression. The host's
  // "always-for-agent" checkout policy already asserts ownership, but the
  // neighbouring "required-for-agent-in-progress" policy silently skips that
  // assertion for issues the caller does not own. If someone ever swaps the
  // policy, this keeps the broker from minting on a stale or foreign issue.
  if (issue.assigneeAgentId !== actor.agentId) {
    throw new ScopeError("Issue is not assigned to the calling agent.", 403);
  }
  if (issue.status !== "in_progress") {
    throw new ScopeError(
      `Issue is ${issue.status}, not in_progress. Tokens are minted only for active work.`,
      409,
    );
  }

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

  return { issue, scope };
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

  // The host already enforced auth: "agent" and the checkout policy. This is a
  // belt-and-braces check so a manifest edit that relaxes either one cannot
  // silently turn the broker into a board-callable mint endpoint.
  if (input.actor?.actorType !== "agent" || !input.actor?.agentId) {
    throw new ScopeError("This route is callable only by an agent run.", 403);
  }

  const config = await readConfig(ctx, companyId);
  const body = typeof input.body === "object" && input.body !== null ? input.body : {};

  const { scope } = await deriveScope(ctx, {
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
      repositories: scope.repositories,
      permissions: scope.permissions,
      repoSource: scope.repoSource,
      profileSource: scope.profileSource,
      expiresAt: result.expiresAt,
    },
  });

  return json(200, {
    token: result.token,
    expiresAt: result.expiresAt,
    repositories: result.repositories ?? scope.repositories,
    permissions: result.permissions ?? scope.permissions,
    scope: {
      repoSource: scope.repoSource,
      profileSource: scope.profileSource,
    },
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
