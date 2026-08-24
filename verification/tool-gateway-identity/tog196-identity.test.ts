// ===========================================================================
// TOG-196 / TOG-194 — does Paperclip's tool gateway hand an mcp_remote server
// a PER-AGENT, NON-SPOOFABLE principal?
//
// This is the executable form of the question the CTO raised on TOG-196. The
// host-side probe (TOG-196-identity-probe.mjs) answers it by observation and
// needs an operator, two live agents and a registered tool_connection. This
// answers the same question against the real gateway code path, in-process,
// and can be re-run in CI as a regression test.
//
// Four properties, in the order they matter:
//
//   1. per-agent      - two different agents produce two different
//                       x-paperclip-agent-id values, each matching the agent
//                       the gateway session was created for.
//   2. not spoofable  - an agent that puts x-paperclip-agent-id in its own
//                       request headers does not get to choose the value.
//                       This is the case a server-side observer CANNOT tell
//                       apart from a correct gateway, so it has to be tested
//                       from this side.
//   3. arguments are not identity
//                     - a `requester` tool argument travels to the upstream
//                       server untouched. It is caller-controlled data. The
//                       TOG-196 server must never read identity from it.
//   4. OPT-IN         - with no headerPolicy.metadata.forward configured, NO
//                       identity header is sent at all. This is the default,
//                       and it is the trap: a connection registered the
//                       obvious way is silently anonymous.
// ===========================================================================

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolGatewaySessions,
  toolProfileBindings,
  toolProfiles,
} from "@paperclipai/db";
import { toolGatewayRoutes } from "../routes/tool-gateway.js";
import { createToolGatewayService, ToolGatewayHttpError } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// The tool the fake upstream exposes. `requester` is deliberately accepted so
// property 3 can be exercised: the point is to show it arrives verbatim and is
// therefore worthless as identity.
const INPUT_SCHEMA = {
  type: "object",
  properties: { note: { type: "string" }, requester: { type: "string" } },
  required: ["note"],
  additionalProperties: false,
} as const;

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({ name: `TOG196 ${randomUUID()}`, issuePrefix: `T${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createIssueAndRun(db: Db, companyId: string, agentId: string) {
  const project = await db
    .insert(projects)
    .values({ companyId, name: `Project ${randomUUID()}` })
    .returning()
    .then((rows) => rows[0]!);
  const issue = await db
    .insert(issues)
    .values({
      companyId,
      projectId: project.id,
      title: `TOG196 issue ${randomUUID()}`,
      status: "in_progress",
      assigneeAgentId: agentId,
    })
    .returning()
    .then((rows) => rows[0]!);
  const run = await db
    .insert(heartbeatRuns)
    .values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: issue.id, projectId: project.id },
    })
    .returning()
    .then((rows) => rows[0]!);
  return { project, issue, run };
}

async function allowAllToolsForAgent(db: Db, companyId: string, agentId: string) {
  const profile = await db
    .insert(toolProfiles)
    .values({
      companyId,
      profileKey: `tog196-${randomUUID()}`,
      name: `TOG196 profile ${randomUUID()}`,
      defaultAction: "allow",
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(toolProfileBindings).values({
    companyId,
    profileId: profile.id,
    targetType: "agent",
    targetId: agentId,
  });
  return profile;
}

/**
 * Registers a remote MCP tool. `metadataForward` is the headerPolicy knob under
 * test: pass null to get the DEFAULT (nothing configured), which is what an
 * operator following the TOG-196 issue text verbatim would end up with.
 */
async function createRemoteMcpTool(
  db: Db,
  companyId: string,
  input: { url: string; metadataForward: string[] | null; applicationKey?: string },
) {
  const applicationKey = input.applicationKey ?? `tog196-${randomUUID().slice(0, 8)}`;
  let application = await db
    .select()
    .from(toolApplications)
    .where(and(eq(toolApplications.companyId, companyId), eq(toolApplications.applicationKey, applicationKey)))
    .limit(1)
    .then((rows) => rows[0]);
  if (!application) {
    [application] = await db
      .insert(toolApplications)
      .values({
        companyId,
        applicationKey,
        name: `TOG196 app ${randomUUID()}`,
        type: "mcp_http",
        status: "active",
      })
      .returning();
  }

  const config: Record<string, unknown> = { url: input.url };
  if (input.metadataForward) {
    config.headerPolicy = { metadata: { forward: input.metadataForward } };
  }

  const [connection] = await db
    .insert(toolConnections)
    .values({
      companyId,
      applicationId: application!.id,
      name: `TOG196 connection ${randomUUID()}`,
      uid: `tog196/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config,
      transportConfig: { url: input.url },
      credentialRefs: [],
      credentialSecretRefs: [],
    })
    .returning();

  const [catalogEntry] = await db
    .insert(toolCatalogEntries)
    .values({
      companyId,
      applicationId: application!.id,
      connectionId: connection!.id,
      entryKind: "tool",
      name: `submit-${randomUUID()}`,
      toolName: "submit",
      title: "Submit",
      description: "Submit a provisioning request",
      inputSchema: INPUT_SCHEMA,
      annotations: { readOnlyHint: false },
      riskLevel: "write",
      isReadOnly: false,
      isWrite: true,
      isDestructive: false,
      status: "active",
      versionHash: randomUUID(),
    })
    .returning();

  return { application: application!, connection: connection!, catalogEntry: catalogEntry! };
}

type FakeMcpRequest = { headers: IncomingMessage["headers"]; body: Record<string, unknown> | null };

async function startFakeRemoteMcpServer() {
  const requests: FakeMcpRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      requests.push({ headers: req.headers, body });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body?.id ?? "test",
          result: { content: [{ type: "text", text: "ok" }] },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function createTestToolGatewayService(
  db: Db,
  options: { deploymentMode?: "authenticated"; deploymentExposure?: "public" } = {},
) {
  return createToolGatewayService(db, {
    ...options,
    toolActionSigningSecret: "tog196-test-signing-secret",
  });
}

/** The tools/call request the upstream saw, ignoring the initialize handshake. */
function toolCallRequests(requests: FakeMcpRequest[]) {
  return requests.filter((request) => request.body?.method === "tools/call");
}

describeEmbeddedPostgres("TOG-196 — tool gateway agent identity", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tog196-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  // Each test reads back the audit row it just produced, so the log has to be
  // empty going in — otherwise a later assertion matches an earlier test's row.
  afterEach(async () => {
    await db.delete(activityLog);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 20_000);

  it("stamps a distinct x-paperclip-agent-id for each authenticated agent", async () => {
    const company = await createCompany(db);
    const agentA = await createAgent(db, company.id);
    const agentB = await createAgent(db, company.id);
    const runA = await createIssueAndRun(db, company.id, agentA.id);
    const runB = await createIssueAndRun(db, company.id, agentB.id);
    const fake = await startFakeRemoteMcpServer();

    try {
      const remote = await createRemoteMcpTool(db, company.id, {
        url: fake.url,
        metadataForward: ["agent_id", "company_id", "run_id"],
      });
      await allowAllToolsForAgent(db, company.id, agentA.id);
      await allowAllToolsForAgent(db, company.id, agentB.id);
      const gateway = createTestToolGatewayService(db);

      for (const [agent, ctx] of [
        [agentA, runA],
        [agentB, runB],
      ] as const) {
        const session = await gateway.createSession({
          companyId: company.id,
          agentId: agent.id,
          runId: ctx.run.id,
        });
        const tool = (await gateway.listToolsForSession(session.token)).find(
          (entry) => entry.connectionId === remote.connection.id,
        );
        expect(tool).toBeTruthy();
        await gateway.executeTool({
          sessionToken: session.token,
          tool: tool!.name,
          parameters: { note: `hello from ${agent.id}` },
        });
      }

      const calls = toolCallRequests(fake.requests);
      expect(calls).toHaveLength(2);
      // Property 1: the identity is per-agent, and it is the RIGHT agent.
      expect(calls[0]!.headers["x-paperclip-agent-id"]).toBe(agentA.id);
      expect(calls[1]!.headers["x-paperclip-agent-id"]).toBe(agentB.id);
      expect(calls[0]!.headers["x-paperclip-agent-id"]).not.toBe(
        calls[1]!.headers["x-paperclip-agent-id"],
      );
      // Same connection, so a connection-level credential would be identical for
      // both. The agent header is what distinguishes them.
      expect(calls[0]!.headers["x-paperclip-company-id"]).toBe(company.id);
      expect(calls[0]!.headers["x-paperclip-run-id"]).toBe(runA.run.id);
      expect(calls[1]!.headers["x-paperclip-run-id"]).toBe(runB.run.id);
    } finally {
      await fake.close();
    }
  });

  it("ignores a caller-supplied x-paperclip-agent-id and stamps the authenticated one", async () => {
    const company = await createCompany(db);
    const victim = await createAgent(db, company.id);
    const attacker = await createAgent(db, company.id);
    const ctx = await createIssueAndRun(db, company.id, attacker.id);
    const fake = await startFakeRemoteMcpServer();

    try {
      const remote = await createRemoteMcpTool(db, company.id, {
        url: fake.url,
        metadataForward: ["agent_id"],
      });
      await allowAllToolsForAgent(db, company.id, attacker.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({
        companyId: company.id,
        agentId: attacker.id,
        runId: ctx.run.id,
      });
      const tool = (await gateway.listToolsForSession(session.token)).find(
        (entry) => entry.connectionId === remote.connection.id,
      );

      await gateway.executeTool({
        sessionToken: session.token,
        tool: tool!.name,
        parameters: { note: "submit as someone else" },
        // The whole attack, in one line.
        callerHeaders: {
          "x-paperclip-agent-id": victim.id,
          "x-paperclip-company-id": victim.companyId,
          "x-paperclip-run-id": randomUUID(),
        },
      });

      const [call] = toolCallRequests(fake.requests);
      // Property 2: the gateway stamps its own value. The claim never lands.
      expect(call!.headers["x-paperclip-agent-id"]).toBe(attacker.id);
      expect(call!.headers["x-paperclip-agent-id"]).not.toBe(victim.id);

      // And the drop is auditable, not silent.
      const [activity] = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "tool_gateway.call_completed"));
      expect(activity!.details).toMatchObject({
        headerSummary: {
          droppedPassthroughHeaderNames: expect.arrayContaining(["x-paperclip-agent-id"]),
          metadataHeaderNames: ["x-paperclip-agent-id"],
          collisionRules: expect.arrayContaining([
            { header: "x-paperclip-agent-id", source: "caller", action: "dropped_sensitive_header" },
          ]),
        },
      });
    } finally {
      await fake.close();
    }
  });

  it("passes a `requester` tool argument through verbatim — arguments are not identity", async () => {
    const company = await createCompany(db);
    const victim = await createAgent(db, company.id);
    const attacker = await createAgent(db, company.id);
    const ctx = await createIssueAndRun(db, company.id, attacker.id);
    const fake = await startFakeRemoteMcpServer();

    try {
      const remote = await createRemoteMcpTool(db, company.id, {
        url: fake.url,
        metadataForward: ["agent_id"],
      });
      await allowAllToolsForAgent(db, company.id, attacker.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({
        companyId: company.id,
        agentId: attacker.id,
        runId: ctx.run.id,
      });
      const tool = (await gateway.listToolsForSession(session.token)).find(
        (entry) => entry.connectionId === remote.connection.id,
      );

      await gateway.executeTool({
        sessionToken: session.token,
        tool: tool!.name,
        parameters: { note: "submit", requester: victim.id },
      });

      const [call] = toolCallRequests(fake.requests);
      const params = call!.body?.params as { arguments?: Record<string, unknown> } | undefined;
      // Property 3: the gateway does NOT sanitise arguments, and should not —
      // they are tool data. It arrives exactly as the model typed it, which is
      // precisely why the TOG-196 server must never read identity from here.
      expect(params?.arguments?.requester).toBe(victim.id);
      expect(call!.headers["x-paperclip-agent-id"]).toBe(attacker.id);
    } finally {
      await fake.close();
    }
  });

  it("sends NO identity header at all when headerPolicy.metadata.forward is unset", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const ctx = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer();

    try {
      // The default. No headerPolicy — exactly what registering a connection
      // with just transport_config.url gives you.
      const remote = await createRemoteMcpTool(db, company.id, {
        url: fake.url,
        metadataForward: null,
      });
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({
        companyId: company.id,
        agentId: agent.id,
        runId: ctx.run.id,
      });
      const tool = (await gateway.listToolsForSession(session.token)).find(
        (entry) => entry.connectionId === remote.connection.id,
      );

      await gateway.executeTool({
        sessionToken: session.token,
        tool: tool!.name,
        parameters: { note: "anonymous" },
      });

      const [call] = toolCallRequests(fake.requests);
      // Property 4: silent anonymity. No error, no warning, no identity.
      expect(call!.headers["x-paperclip-agent-id"]).toBeUndefined();
      expect(call!.headers["x-paperclip-company-id"]).toBeUndefined();
      expect(call!.headers["x-paperclip-run-id"]).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  // -----------------------------------------------------------------------
  // Separate blocker, same issue. TOG-196 says "bind loopback only" and
  // register transport_config.url = http://127.0.0.1:<port>/mcp. On THIS
  // deployment (PAPERCLIP_DEPLOYMENT_MODE=authenticated,
  // PAPERCLIP_DEPLOYMENT_EXPOSURE=public) allowPrivateRemoteEndpoints() is
  // false, so the SSRF guard refuses that URL. The guard runs on every call,
  // not just at registration, so this is not something a one-time override
  // can get past.
  //
  // Every other test in this file leaves the deployment options unset, which
  // is how the existing suite reaches its own 127.0.0.1 fake servers.
  // -----------------------------------------------------------------------
  it("refuses a loopback endpoint under this instance's deployment settings", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const ctx = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer();

    try {
      const remote = await createRemoteMcpTool(db, company.id, {
        url: fake.url, // http://127.0.0.1:<port>/mcp — exactly what the issue specifies
        metadataForward: ["agent_id"],
      });
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      });
      const session = await gateway.createSession({
        companyId: company.id,
        agentId: agent.id,
        runId: ctx.run.id,
      });
      const tool = (await gateway.listToolsForSession(session.token)).find(
        (entry) => entry.connectionId === remote.connection.id,
      );

      const error = await gateway
        .executeTool({
          sessionToken: session.token,
          tool: tool!.name,
          parameters: { note: "should never reach the server" },
        })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );

      expect(error).toBeInstanceOf(ToolGatewayHttpError);
      expect((error as ToolGatewayHttpError).reasonCode).toBe("remote_http_private_endpoint");
      // The request never left the gateway.
      expect(toolCallRequests(fake.requests)).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  // -----------------------------------------------------------------------
  // The layer ABOVE the header stamping. x-paperclip-agent-id is only as
  // trustworthy as the session it is read from, and sessions are minted over
  // the API at POST /api/tool-gateway/sessions, which accepts an agentId in
  // the body. If an agent could mint a session naming a different agent, the
  // gateway would faithfully stamp the victim's id and every test above would
  // still pass while the property was broken.
  //
  // Observed against the live instance: posting another agent's id with this
  // agent's own key returns 201, not 403. That is an OVERRIDE, not a spoof —
  // but the success status makes it worth pinning down which agent the row
  // actually ends up bound to.
  // -----------------------------------------------------------------------
  it("binds a session to the authenticated agent, ignoring a body-supplied agentId", async () => {
    const company = await createCompany(db);
    const victim = await createAgent(db, company.id);
    const attacker = await createAgent(db, company.id);
    const ctx = await createIssueAndRun(db, company.id, attacker.id);
    const gateway = createTestToolGatewayService(db);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // An agent actor, exactly as middleware/auth.ts builds it from an agent
      // API key: the agent id comes from the key, never from the request.
      req.actor = {
        type: "agent",
        agentId: attacker.id,
        companyId: company.id,
        runId: ctx.run.id,
        source: "agent_key",
      } as Express.Request["actor"];
      next();
    });
    app.use("/api", toolGatewayRoutes(db, gateway));

    const response = await request(app)
      .post("/api/tool-gateway/sessions")
      .send({ companyId: company.id, agentId: victim.id, runId: ctx.run.id });

    // It succeeds — the claim is silently discarded rather than rejected.
    expect(response.status).toBe(201);

    const [row] = await db
      .select()
      .from(toolGatewaySessions)
      .where(eq(toolGatewaySessions.id, response.body.sessionId));
    // ...and the row is bound to the caller, not to the agent it named.
    expect(row!.agentId).toBe(attacker.id);
    expect(row!.agentId).not.toBe(victim.id);
  });
});
