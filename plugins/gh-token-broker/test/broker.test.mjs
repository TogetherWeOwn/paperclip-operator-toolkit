import test from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";

import { pluginManifestV1Schema } from "@paperclipai/shared";

import { manifest } from "../dist/manifest.js";
import {
  DEFAULT_PERMISSION_PROFILE,
  ScopeError,
  describeCiVisibility,
  narrowPermissions,
  parsePermissionSpec,
  parseRepoList,
  parseRepoName,
  resolveRepositories,
  resolveScope,
} from "../dist/scope.js";
import { createAppJwt, mintInstallationToken } from "../dist/github.js";
import { plugin } from "../dist/worker.js";

// A throwaway key. Never the real App PEM — the point of this plugin is that the
// real one stays server-side, and a test that needed it would contradict that.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const COMPANY = "11111111-1111-1111-1111-111111111111";
const ISSUE = "22222222-2222-2222-2222-222222222222";
const PROJECT = "33333333-3333-3333-3333-333333333333";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

test("manifest validates against the host's own schema", () => {
  const result = pluginManifestV1Schema.safeParse(manifest);
  assert.equal(
    result.success,
    true,
    result.success ? "" : JSON.stringify(result.error.issues, null, 2),
  );
});

test("both routes are agent-auth and declare the capability", () => {
  for (const route of manifest.apiRoutes) {
    assert.equal(route.auth, "agent", `${route.routeKey} must be agent-only`);
    assert.equal(route.capability, "api.routes.register");
  }
});

test("the mint route resolves company from the issue", () => {
  const mint = manifest.apiRoutes.find((r) => r.routeKey === "mint");
  assert.deepEqual(mint.companyResolution, { from: "issue", param: "issueId" });
});

// Regression guard. server/dist/routes/plugins.js short-circuits
// "required-for-agent-in-progress" with an early `return` when the issue is not
// in_progress or not assigned to the caller — i.e. it skips assertCheckoutOwner
// in exactly the case that matters. Only "always-for-agent" asserts ownership
// unconditionally. Changing this back silently makes any agent able to mint a
// token for any project in the company.
test("the mint route asserts checkout ownership unconditionally", () => {
  const mint = manifest.apiRoutes.find((r) => r.routeKey === "mint");
  assert.equal(mint.checkoutPolicy, "always-for-agent");
  assert.notEqual(mint.checkoutPolicy, "required-for-agent-in-progress");
});

test("manifest requests no capability beyond what the broker uses", () => {
  const expected = [
    "api.routes.register",
    "secrets.read-ref",
    "http.outbound",
    "issues.read",
    "projects.read",
    "project.workspaces.read",
    "activity.log.write",
  ].sort();
  assert.deepEqual([...manifest.capabilities].sort(), expected);
});

test("default profile carries no organization_* or members scope", () => {
  for (const key of Object.keys(DEFAULT_PERMISSION_PROFILE)) {
    assert.ok(!key.startsWith("organization_"), `unexpected org scope: ${key}`);
    assert.notEqual(key, "members");
    assert.notEqual(key, "administration");
  }
  assert.deepEqual(Object.keys(DEFAULT_PERMISSION_PROFILE).sort(), [
    "checks",
    "contents",
    "issues",
    "metadata",
    "pull_requests",
    "statuses",
  ]);
});

test("workflows is excluded from the default profile", () => {
  assert.equal(DEFAULT_PERMISSION_PROFILE.workflows, undefined);
});

// The CI-visibility permissions are read-only on purpose. checks and statuses
// both exist as `write` on this App, and a copy-paste of the granted level
// would hand every agent the ability to POST fabricated check runs and commit
// statuses — i.e. to mark its own PR green.
test("the CI-visibility permissions are read, never write", () => {
  assert.equal(DEFAULT_PERMISSION_PROFILE.checks, "read");
  assert.equal(DEFAULT_PERMISSION_PROFILE.statuses, "read");
});

// TOG-247 refused actions:read because it also grants workflow LOG download,
// and logs carry whatever CI printed. This test is the guard on that decision:
// it is expected to fail loudly if someone adds the permission back for
// convenience. If you are here because it failed, read WITHHELD_CI_SOURCES in
// scope.js before changing it — the refusal is the point, not an oversight.
test("actions is excluded from the default profile, deliberately", () => {
  assert.equal(
    DEFAULT_PERMISSION_PROFILE.actions,
    undefined,
    "actions:read also grants workflow log download; TOG-247 refused it",
  );
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parseRepoName handles https, ssh, bare and .git forms", () => {
  assert.equal(parseRepoName("https://github.com/TogetherWeOwn/nntune.git"), "nntune");
  assert.equal(parseRepoName("git@github.com:TogetherWeOwn/kofra.git"), "kofra");
  assert.equal(parseRepoName("TogetherWeOwn/paperclip-model-router"), "paperclip-model-router");
  assert.equal(parseRepoName("routeware-shadow-api"), "routeware-shadow-api");
});

test("parseRepoName rejects junk rather than guessing", () => {
  for (const bad of ["", "   ", null, undefined, 42, "https://github.com/", "a/b/../../etc"]) {
    assert.equal(parseRepoName(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("parseRepoList splits and de-duplicates", () => {
  assert.deepEqual(parseRepoList("nntune, kofra nntune"), ["nntune", "kofra"]);
  assert.equal(parseRepoList(null), null);
  assert.equal(parseRepoList(""), null);
});

test("parsePermissionSpec parses the operator's literal form", () => {
  assert.deepEqual(parsePermissionSpec("contents=write,workflows=write"), {
    contents: "write",
    workflows: "write",
  });
});

test("parsePermissionSpec rejects malformed and unknown levels", () => {
  assert.throws(() => parsePermissionSpec("contents"), ScopeError);
  assert.throws(() => parsePermissionSpec("contents=superuser"), ScopeError);
});

// ---------------------------------------------------------------------------
// Invariant 1: never unscoped
// ---------------------------------------------------------------------------

test("refuses to mint when no repo scope can be derived", () => {
  assert.throws(
    () => resolveRepositories({ projectRepos: null, workspaceRepoUrl: null }),
    (error) => error instanceof ScopeError && error.status === 409,
  );
});

test("an empty project repo list does not silently become all repos", () => {
  assert.throws(
    () => resolveRepositories({ projectRepos: [], workspaceRepoUrl: null }),
    ScopeError,
  );
});

test("project GH_APP_REPOS wins over the workspace repo", () => {
  const scope = resolveScope({
    projectEnv: { GH_APP_REPOS: "paperclip-ops-tooling" },
    workspaceRepoUrl: "https://github.com/TogetherWeOwn/nntune.git",
  });
  assert.deepEqual(scope.repositories, ["paperclip-ops-tooling"]);
  assert.equal(scope.repoSource, "project");
});

test("falls back to the issue's workspace repo when the project pins nothing", () => {
  const scope = resolveScope({
    projectEnv: {},
    workspaceRepoUrl: "https://github.com/TogetherWeOwn/nntune.git",
  });
  assert.deepEqual(scope.repositories, ["nntune"]);
  assert.equal(scope.repoSource, "workspace");
});

test("a secret_ref in GH_APP_REPOS is ignored rather than stringified", () => {
  assert.throws(
    () =>
      resolveScope({
        projectEnv: { GH_APP_REPOS: { type: "secret_ref", secretId: "x" } },
        workspaceRepoUrl: null,
      }),
    ScopeError,
  );
});

// ---------------------------------------------------------------------------
// Invariant 2: callers may only narrow
// ---------------------------------------------------------------------------

test("a caller cannot request a repo outside the issue's scope", () => {
  assert.throws(
    () =>
      resolveScope({
        projectEnv: { GH_APP_REPOS: "nntune" },
        requestedRepositories: "kofra",
      }),
    (error) => error instanceof ScopeError && error.status === 403,
  );
});

test("a caller may narrow to a subset of the allowed repos", () => {
  const scope = resolveScope({
    projectEnv: { GH_APP_REPOS: "nntune,kofra" },
    requestedRepositories: "kofra",
  });
  assert.deepEqual(scope.repositories, ["kofra"]);
});

test("a caller cannot escalate a permission level", () => {
  assert.throws(
    () => narrowPermissions({ contents: "read" }, { contents: "write" }),
    (error) => error instanceof ScopeError && error.status === 403,
  );
});

test("a caller cannot add a permission outside the profile", () => {
  assert.throws(
    () => narrowPermissions(DEFAULT_PERMISSION_PROFILE, { organization_administration: "write" }),
    (error) => error instanceof ScopeError && error.status === 403,
  );
});

test("a caller cannot obtain workflows:write where the project does not grant it", () => {
  assert.throws(
    () =>
      resolveScope({
        projectEnv: { GH_APP_REPOS: "nntune" },
        requestedPermissions: { workflows: "write" },
      }),
    (error) => error instanceof ScopeError && error.status === 403,
  );
});

test("a project that grants workflows:write passes it through", () => {
  const scope = resolveScope({
    projectEnv: {
      GH_APP_REPOS: "paperclip-ops-tooling",
      GH_APP_PERMISSIONS: "contents=write,pull_requests=write,issues=write,metadata=read,workflows=write",
    },
  });
  assert.equal(scope.permissions.workflows, "write");
  assert.equal(scope.profileSource, "project");
});

// ---------------------------------------------------------------------------
// Env binding shape.
//
// A project's `env` is an `AgentEnvConfig`, whose values are an `EnvBinding`
// union: a bare string, or a tagged `plain` / `secret_ref` / `user_secret_ref`
// object. Every earlier test in this file used the bare-string form, and every
// GH-configured project in the company actually uses the tagged `plain` form —
// so the suite was green while project scoping was inert in production. These
// tests pin the tagged form so that cannot recur.
// ---------------------------------------------------------------------------

/** The Ops Tooling project's env, verbatim, as the API returns it. */
const OPS_TOOLING_ENV = {
  GH_APP_ID: { type: "secret_ref", secretId: "5e2ca78e", version: "latest" },
  GH_APP_ORG: { type: "secret_ref", secretId: "237ae9ac", version: "latest" },
  GH_APP_REPOS: { type: "plain", value: "paperclip-ops-tooling" },
  GH_APP_PERMISSIONS: {
    type: "plain",
    value: "contents=write,pull_requests=write,issues=write,metadata=read,workflows=write",
  },
  GH_APP_PRIVATE_KEY: { type: "secret_ref", secretId: "86b28441", version: "latest" },
  GH_APP_SCOPE_STRICT: { type: "plain", value: "1" },
};

test("the live Ops Tooling env resolves its repo and keeps workflows:write", () => {
  const scope = resolveScope({
    projectEnv: OPS_TOOLING_ENV,
    // Deliberately a different repo: if the tagged binding were ignored, scope
    // would silently fall through to this and the assertions below would fail.
    workspaceRepoUrl: "https://github.com/TogetherWeOwn/nntune.git",
  });
  assert.deepEqual(scope.repositories, ["paperclip-ops-tooling"]);
  assert.equal(scope.repoSource, "project");
  assert.equal(scope.permissions.workflows, "write");
  assert.equal(scope.permissions.contents, "write");
  assert.equal(scope.profileSource, "project");
});

test("a tagged plain GH_APP_REPOS is honoured, not ignored", () => {
  const scope = resolveScope({
    projectEnv: { GH_APP_REPOS: { type: "plain", value: "kofra" } },
    workspaceRepoUrl: "https://github.com/TogetherWeOwn/nntune.git",
  });
  assert.deepEqual(scope.repositories, ["kofra"]);
  assert.equal(scope.repoSource, "project");
});

test("bare-string bindings remain supported alongside tagged ones", () => {
  const scope = resolveScope({
    projectEnv: {
      GH_APP_REPOS: "kofra",
      GH_APP_PERMISSIONS: { type: "plain", value: "contents=read,metadata=read" },
    },
  });
  assert.deepEqual(scope.repositories, ["kofra"]);
  assert.deepEqual(scope.permissions, { contents: "read", metadata: "read" });
});

test("a user_secret_ref binding is treated as absent, never stringified", () => {
  assert.throws(
    () =>
      resolveScope({
        projectEnv: { GH_APP_REPOS: { type: "user_secret_ref", key: "MY_REPOS" } },
        workspaceRepoUrl: null,
      }),
    (error) => error instanceof ScopeError && error.status === 409,
  );
});

test("a malformed plain binding with a non-string value is treated as absent", () => {
  assert.throws(
    () =>
      resolveScope({
        projectEnv: { GH_APP_REPOS: { type: "plain", value: { nested: "kofra" } } },
        workspaceRepoUrl: null,
      }),
    (error) => error instanceof ScopeError && error.status === 409,
  );
});

test("a project narrowing below the default profile is not widened back to it", () => {
  // The fail-open direction of the binding-shape bug: if a restrictive project
  // profile were ignored, the caller would silently receive the broader default.
  const scope = resolveScope({
    projectEnv: {
      GH_APP_REPOS: { type: "plain", value: "kofra" },
      GH_APP_PERMISSIONS: { type: "plain", value: "contents=read,metadata=read" },
    },
  });
  assert.equal(scope.permissions.contents, "read");
  assert.equal(scope.permissions.pull_requests, undefined);
  assert.equal(scope.permissions.issues, undefined);
  assert.throws(
    () =>
      resolveScope({
        projectEnv: {
          GH_APP_REPOS: { type: "plain", value: "kofra" },
          GH_APP_PERMISSIONS: { type: "plain", value: "contents=read,metadata=read" },
        },
        requestedPermissions: { contents: "write" },
      }),
    (error) => error instanceof ScopeError && error.status === 403,
  );
});

test("a caller may weaken a permission", () => {
  assert.deepEqual(narrowPermissions({ contents: "write" }, { contents: "read" }), {
    contents: "read",
  });
});

test("empty requested sets are refused rather than treated as 'everything'", () => {
  assert.throws(() => narrowPermissions(DEFAULT_PERMISSION_PROFILE, {}), ScopeError);
  assert.throws(
    () => resolveScope({ projectEnv: { GH_APP_REPOS: "nntune" }, requestedRepositories: "" }),
    ScopeError,
  );
});

// ---------------------------------------------------------------------------
// JWT + mint mechanics
// ---------------------------------------------------------------------------

test("createAppJwt produces a verifiable RS256 assertion within GitHub's 10-minute cap", () => {
  const now = 1_700_000_000;
  const jwt = createAppJwt("4685085", TEST_PEM, now);
  const [header, payload, signature] = jwt.split(".");

  const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString());
  const decodedPayload = JSON.parse(Buffer.from(payload, "base64url").toString());

  assert.equal(decodedHeader.alg, "RS256");
  assert.equal(decodedPayload.iss, "4685085");
  assert.ok(decodedPayload.iat < now, "iat should be backdated for clock skew");
  assert.ok(decodedPayload.exp - decodedPayload.iat <= 600, "must stay inside GitHub's 10-minute cap");

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, "base64url")), true);
});

test("createAppJwt refuses a non-PEM secret instead of signing garbage", () => {
  assert.throws(() => createAppJwt("4685085", "not-a-key"), /PEM/);
});

test("mintInstallationToken refuses an empty repository array", async () => {
  await assert.rejects(
    () => mintInstallationToken(async () => {}, 1, "jwt", { repositories: [], permissions: { contents: "write" } }),
    /empty repository scope/,
  );
});

test("mintInstallationToken sends repositories and permissions in the body", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return {
      status: 201,
      ok: true,
      json: async () => ({
        token: "ghs_fake",
        expires_at: "2026-08-23T18:00:00Z",
        permissions: { contents: "write" },
        repositories: [{ name: "nntune" }],
      }),
    };
  };

  const result = await mintInstallationToken(fetchImpl, 42, "jwt", {
    repositories: ["nntune"],
    permissions: { contents: "write" },
  });

  assert.match(captured.url, /\/app\/installations\/42\/access_tokens$/);
  assert.deepEqual(captured.body.repositories, ["nntune"]);
  assert.deepEqual(captured.body.permissions, { contents: "write" });
  assert.equal(result.token, "ghs_fake");
  assert.deepEqual(result.repositories, ["nntune"]);
});

// ---------------------------------------------------------------------------
// Route behaviour
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
  const logs = [];
  const activity = [];
  const ctx = {
    logger: {
      info: (message, meta) => logs.push({ level: "info", message, meta }),
      warn: (message, meta) => logs.push({ level: "warn", message, meta }),
      error: (message, meta) => logs.push({ level: "error", message, meta }),
      debug: (message, meta) => logs.push({ level: "debug", message, meta }),
    },
    config: { get: async () => ({ appId: "4685085", org: "TogetherWeOwn", privateKeyRef: { type: "secret_ref", secretId: "pem" }, installationId: 99 }) },
    secrets: { resolve: async () => TEST_PEM },
    http: {
      fetch: async () => ({
        status: 201,
        ok: true,
        json: async () => ({
          token: "ghs_minted",
          expires_at: "2026-08-23T18:00:00Z",
          permissions: { contents: "write", issues: "write", metadata: "read", pull_requests: "write" },
          repositories: [{ name: "nntune" }],
        }),
      }),
    },
    issues: {
      get: async () => ({
        id: ISSUE,
        projectId: PROJECT,
        status: "in_progress",
        assigneeAgentId: "agent-1",
      }),
    },
    projects: {
      get: async () => ({ id: PROJECT, env: { GH_APP_REPOS: "nntune" } }),
      getWorkspaceForIssue: async () => ({ repoUrl: "https://github.com/TogetherWeOwn/nntune.git" }),
    },
    activity: { log: async (entry) => activity.push(entry) },
    ...overrides,
  };
  return { ctx, logs, activity };
}

const AGENT_ACTOR = {
  actorType: "agent",
  actorId: "agent-1",
  agentId: "agent-1",
  userId: null,
  runId: "run-abc",
};

function request(routeKey, extra = {}) {
  return {
    routeKey,
    method: "POST",
    path: "/",
    params: { issueId: ISSUE },
    query: {},
    body: {},
    actor: AGENT_ACTOR,
    companyId: COMPANY,
    headers: {},
    ...extra,
  };
}

test("whoami echoes the host-derived runId", async () => {
  const { ctx } = makeCtx();
  await plugin.definition.setup(ctx);

  const response = await plugin.definition.onApiRequest(request("whoami", { method: "GET" }));
  assert.equal(response.status, 200);
  assert.equal(response.body.runId, "run-abc");
  assert.equal(response.body.agentId, "agent-1");
  assert.equal(response.body.companyId, COMPANY);
  assert.equal(response.body.actorType, "agent");
});

test("mint returns a scoped token and never the private key", async () => {
  const { ctx, activity, logs } = makeCtx();
  await plugin.definition.setup(ctx);

  const response = await plugin.definition.onApiRequest(request("mint"));
  assert.equal(response.status, 200);
  assert.equal(response.body.token, "ghs_minted");
  assert.deepEqual(response.body.repositories, ["nntune"]);

  const serialized = JSON.stringify({ response, activity, logs });
  assert.ok(!serialized.includes("PRIVATE KEY"), "PEM marker leaked");
  assert.ok(!serialized.includes(TEST_PEM.slice(40, 120)), "PEM body leaked");
});

test("the audit entry records the grant but not the token", async () => {
  const { ctx, activity } = makeCtx();
  await plugin.definition.setup(ctx);
  await plugin.definition.onApiRequest(request("mint"));

  assert.equal(activity.length, 1);
  assert.deepEqual(activity[0].metadata.repositories, ["nntune"]);
  assert.equal(activity[0].metadata.runId, "run-abc");
  assert.ok(!JSON.stringify(activity[0]).includes("ghs_minted"), "token leaked into audit log");
});

test("a board/user actor is refused even if the host let it through", async () => {
  const { ctx } = makeCtx();
  await plugin.definition.setup(ctx);

  const response = await plugin.definition.onApiRequest(
    request("mint", { actor: { actorType: "user", actorId: "u1", userId: "u1", runId: null } }),
  );
  assert.equal(response.status, 403);
});

test("an unconfigured broker fails closed with 503", async () => {
  const { ctx } = makeCtx({ config: { get: async () => ({}) } });
  await plugin.definition.setup(ctx);

  const response = await plugin.definition.onApiRequest(request("mint"));
  assert.equal(response.status, 503);
  assert.match(response.body.error, /not configured/);
});

test("minting is refused for an issue assigned to a different agent", async () => {
  const { ctx } = makeCtx({
    issues: {
      get: async () => ({
        id: ISSUE,
        projectId: PROJECT,
        status: "in_progress",
        assigneeAgentId: "some-other-agent",
      }),
    },
  });
  await plugin.definition.setup(ctx);

  const response = await plugin.definition.onApiRequest(request("mint"));
  assert.equal(response.status, 403);
  assert.match(response.body.error, /not assigned to the calling agent/);
});

test("minting is refused for an issue that is not in progress", async () => {
  const { ctx } = makeCtx({
    issues: {
      get: async () => ({
        id: ISSUE,
        projectId: PROJECT,
        status: "todo",
        assigneeAgentId: "agent-1",
      }),
    },
  });
  await plugin.definition.setup(ctx);

  const response = await plugin.definition.onApiRequest(request("mint"));
  assert.equal(response.status, 409);
  assert.match(response.body.error, /not in_progress/);
});

test("an issue with no project and no workspace repo is refused, not minted broadly", async () => {
  const { ctx } = makeCtx({
    issues: {
      get: async () => ({
        id: ISSUE,
        projectId: null,
        status: "in_progress",
        assigneeAgentId: "agent-1",
      }),
    },
    projects: {
      get: async () => null,
      getWorkspaceForIssue: async () => null,
    },
  });
  await plugin.definition.setup(ctx);

  const response = await plugin.definition.onApiRequest(request("mint"));
  assert.equal(response.status, 409);
  assert.match(response.body.error, /no repository scope/);
});

test("a missing issue is a 404", async () => {
  const { ctx } = makeCtx({ issues: { get: async () => null } });
  await plugin.definition.setup(ctx);

  const response = await plugin.definition.onApiRequest(request("mint"));
  assert.equal(response.status, 404);
});

test("an unexpected internal error does not echo its message to the caller", async () => {
  const { ctx } = makeCtx({
    secrets: {
      resolve: async () => {
        throw new Error("connection string postgres://user:hunter2@db/paperclip failed");
      },
    },
  });
  await plugin.definition.setup(ctx);

  const response = await plugin.definition.onApiRequest(request("mint"));
  assert.equal(response.status, 500);
  assert.equal(response.body.error, "Internal broker error.");
  assert.ok(!JSON.stringify(response).includes("hunter2"));
});

test("an unknown routeKey is rejected", async () => {
  const { ctx } = makeCtx();
  await plugin.definition.setup(ctx);

  const response = await plugin.definition.onApiRequest(request("definitely-not-a-route"));
  assert.equal(response.status, 404);
});

// ---------------------------------------------------------------------------
// CI visibility (TOG-247)
//
// The broker cannot make an agent read CI status correctly, but it can refuse
// to let one be blind and unaware of it. These assert that the mint response
// states the blindness rather than leaving the caller to infer it from a 403
// it will not see until much later.
// ---------------------------------------------------------------------------

// Since the TOG-247 decision the default profile CAN observe CI. This is the
// acceptance test for that change: an agent minting with no overrides must be
// able to answer "did my own PR pass" from check runs and commit statuses.
test("the default profile can observe CI from checks and statuses", () => {
  const v = describeCiVisibility(DEFAULT_PERMISSION_PROFILE);
  assert.equal(v.observable, true);
  assert.deepEqual(v.readable.sort(), ["checks", "statuses"]);
  assert.equal(v.warning, null, "an observable grant must not carry a standing warning");
});

// The refusal has to survive contact with a reader. `actions` is absent from
// the default grant, but it must not show up as a gap — it reports as withheld,
// with the reason attached, so the next agent to read a mint response does not
// file "we should add actions:read" as an improvement.
test("actions reports as withheld-by-decision, not as a blind spot", () => {
  const v = describeCiVisibility(DEFAULT_PERMISSION_PROFILE);
  assert.deepEqual(v.blind, [], "no source should read as an unclosed gap");
  assert.deepEqual(Object.keys(v.withheld), ["actions"]);
  assert.match(v.withheld.actions, /log/i, "the reason must name log download");
  assert.match(v.withheld.actions, /TOG-247/);
});

// A grant that really is blind must still say so in the dangerous terms. This
// is the pre-decision profile — the shape an older deployment, or an App whose
// ceiling is narrower than our profile, still hands out.
test("a blind grant still names the empty-list misreading, not just the missing scope", () => {
  const legacy = { contents: "write", pull_requests: "write", metadata: "read" };
  const { warning, observable } = describeCiVisibility(legacy);
  assert.equal(observable, false);
  assert.match(warning, /denied/i);
  assert.match(warning, /not treat the absence of failing checks as a pass/i);
  // Every source is named when nothing is readable, withheld ones included:
  // a caller who can see no CI at all needs the complete list to diagnose it.
  for (const scope of ["checks:read", "actions:read", "statuses:read"]) {
    assert.ok(warning.includes(scope), `warning should name ${scope}`);
  }
});

// checks:read and statuses:read are different permissions. A grant that can
// read check runs is still blind to a repo whose CI posts commit statuses, and
// the response must keep reporting that rather than rounding up to "observable,
// nothing more to say".
test("statuses is reported separately from checks", () => {
  const v = describeCiVisibility({ checks: "read", actions: "read" });
  assert.deepEqual(v.blind, ["statuses"]);
});

test("visibility is computed from what GitHub granted, not what was requested", async () => {
  // The App ceiling is narrower than the profile: we ask for checks:read and
  // GitHub declines to grant it. The caller must be told it is blind.
  const { ctx } = makeCtx({
    http: {
      fetch: async () => ({
        status: 201,
        ok: true,
        json: async () => ({
          token: "ghs_minted",
          expires_at: "2026-08-23T18:00:00Z",
          // No `checks` key: the grant is narrower than the ask.
          permissions: { contents: "write", metadata: "read" },
          repositories: [{ name: "nntune" }],
        }),
      }),
    },
  });
  await plugin.definition.setup(ctx);

  const response = await plugin.definition.onApiRequest(
    request("mint", { body: { permissions: { contents: "write" } } }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.ciVisibility.observable, false);
  assert.ok(response.body.ciVisibility.warning);
});

test("the advisory changes no grant", async () => {
  // Belt and braces: describing CI visibility must never alter permissions.
  const before = resolveScope({
    projectEnv: { GH_APP_REPOS: "paperclip-ops-tooling" },
    workspaceRepoUrl: null,
  });
  describeCiVisibility(before.permissions);
  assert.deepEqual(before.permissions, { ...DEFAULT_PERMISSION_PROFILE });
});
