#!/usr/bin/env node
/**
 * Stock runtime integration, NOT a permissive SDK mock.
 * Run with the installed host's loader, without starting its server or DB:
 * node --import "$PAPERCLIP_ROOT/server/node_modules/tsx/dist/loader.mjs" \
 *   deploy/stock_contract_harness.mjs --baseline  # before repair
 * Omit --baseline for the repaired worker. PAPERCLIP_ROOT defaults to /app.
 * Only storage, telemetry transport and clock inputs are in-memory adapters;
 * the scheduler, worker process manager and SDK authorization gate are real.
 * No credentials, real database, live lane requests or host mutations.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.PAPERCLIP_ROOT ?? "/app";
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.INSIGHT_PACKAGE_ROOT ?? path.resolve(here, "..");
const worker = path.join(pluginRoot, "dist/worker.js");
const { default: manifest } = await import(pathToFileURL(path.join(pluginRoot, "dist/manifest.js")));
const hostFiles = [
  "server/src/services/plugin-job-scheduler.ts",
  "server/src/services/plugin-worker-manager.ts",
  "packages/plugins/sdk/src/host-client-factory.ts",
];
const [{ createPluginJobScheduler }, { createPluginWorkerHandle }, { createHostClientHandlers }] =
  await Promise.all(hostFiles.map((file) => import(pathToFileURL(path.join(root, file)))));
for (const file of hostFiles) {
  console.log("SOURCE", createHash("sha256").update(await readFile(path.join(root, file))).digest("hex"), file);
}
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const pluginId = "stock-contract-insight";
const secretRef = { type: "secret_ref", secretId: "33333333-3333-4333-8333-333333333333" };
const fakeBearer = "contract-fixture-not-a-live-secret";
const enabled = { pollingEnabled: true, laneApiKeySecretRef: secretRef };
const stateKey = (p) => `${p.scopeKind}:${p.scopeId}:${p.stateKey}`;
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("PASS", name);
}

async function withHost(configs, fn, { replay = true, serviceError = false } = {}) {
  const state = new Map();
  const calls = [];
  const servicesCalled = [];
  const logs = [];
  const configsByCompany = new Map(configs);
  const service = (name, f) => async (params) => {
    servicesCalled.push({ name, params });
    return f(params);
  };
  const services = {
    config: { get: service("config.get", ({ companyId }) => configsByCompany.get(companyId) ?? {}) },
    companies: { list: service("companies.list", () => [{ id: B }, { id: A }]) },
    state: {
      get: service("state.get", (p) => state.get(stateKey(p)) ?? null),
      set: service("state.set", (p) => { state.set(stateKey(p), p.value); }),
      delete: service("state.delete", (p) => { state.delete(stateKey(p)); }),
    },
    secrets: { resolve: service("secrets.resolve", (p) => {
      assert.equal(p.companyId, A);
      assert.equal(p.configPath, "laneApiKeySecretRef");
      assert.deepEqual(p.secretRef, configsByCompany.get(A)?.laneApiKeySecretRef);
      if (serviceError) throw new Error(`provider accidentally echoed ${fakeBearer}`);
      return fakeBearer;
    }) },
    http: { fetch: service("http.fetch", (p) => {
      assert.equal(p.init.method, "GET");
      assert.equal(p.init.headers["x-api-key"], fakeBearer);
      assert.match(p.url, /^https:\/\/router\.example.net\/telemetry\/cliproxy\/[a-z-]+\.json$/);
      return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: JSON.stringify({
        schemaVersion: 1, observedAt: new Date().toISOString(), staleAfterSeconds: 300,
        records: [{ accountId: "fixture-account", provider: "claude", health: "ok", utilization: 0.2 }],
      }) };
    }) },
    metrics: { write: service("metrics.write", () => undefined) },
    activity: { log: service("activity.log", () => undefined) },
    logger: { log: (p) => { logs.push(p); } },
  };
  const gated = createHostClientHandlers({ pluginId, capabilities: manifest.capabilities, services });
  const hostHandlers = Object.fromEntries(Object.entries(gated).map(([method, handler]) => [method, async (params, context) => {
    calls.push({ method, params, context });
    // log is non-governed; capture without depending on the logging adapter shape.
    if (method === "log") { logs.push(params); return; }
    return handler(params, context);
  }]));
  const handle = createPluginWorkerHandle(pluginId, {
    entrypointPath: worker, manifest, config: {},
    instanceInfo: { instanceId: "contract", hostVersion: "contract" },
    apiVersion: 1, hostHandlers, autoRestart: false, rpcTimeoutMs: 5000,
    proactiveCompanyScopes: [...configsByCompany.keys()],
  });
  const runs = [];
  let advanced = 0;
  const job = { id: "contract-job", pluginId, jobKey: "cliproxy-poll", status: "active", schedule: "*/5 * * * *", nextRunAt: new Date(0) };
  const scheduler = createPluginJobScheduler({
    db: { select: () => ({ from: () => ({ where: async () => [job] }) }) },
    jobStore: {
      createRun: async (input) => { assert.equal(input.trigger, "schedule"); return { id: `run-${runs.length}` }; },
      markRunning: async () => undefined,
      completeRun: async (_id, result) => { runs.push(result); },
      updateRunTimestamps: async () => { advanced++; },
    },
    workerManager: { isRunning: () => true, call: (_plugin, method, params, timeout) => {
      assert.equal(method, "runJob");
      assert.equal(params.companyId, undefined); // real scheduler supplies NO company
      assert.equal(params.job.trigger, "schedule");
      return handle.call(method, params, timeout);
    } },
    jobTimeoutMs: 5000,
  });
  const change = async (companyId, config) => {
    configsByCompany.set(companyId, config);
    handle.setProactiveCompanyScopes([...configsByCompany.keys()]);
    await handle.call("configChanged", { companyId, config });
  };
  const tick = async () => {
    const before = runs.length;
    await scheduler.tick();
    assert.equal(runs.length, before + 1, "scheduler must record an actual run");
    assert.equal(advanced, runs.length, "scheduler must advance the schedule");
    return runs.at(-1);
  };
  try {
    await handle.start();
    if (replay) for (const [companyId, config] of configs) await change(companyId, config);
    await fn({ handle, change, tick, state, calls, servicesCalled, logs, configsByCompany, gated });
  } finally {
    scheduler.stop();
    await handle.stop();
  }
}
const count = (h, name) => h.servicesCalled.filter((c) => c.name === name).length;
const assertInert = (h) => {
  assert.equal(count(h, "http.fetch"), 0);
  assert.equal(count(h, "secrets.resolve"), 0);
  assert.equal(h.state.size, 0);
};

if (process.argv.includes("--baseline")) {
  for (const configs of [[], [[A, enabled]]]) {
    await check(`old worker reproduces exact rejection with ${configs.length} configured companies`, () => withHost(configs, async (h) => {
      const run = await h.tick();
      assert.equal(run.status, "failed");
      assert.equal(run.error, `Plugin "${pluginId}" is not allowed to perform "config.get": company context is required`);
      assertInert(h);
      assert.equal(count(h, "config.get"), 0, "denied before config storage");
    }, { replay: false }));
  }
} else {
  await check("unconfigured startup is inert, successful schedule, no company enumeration", () => withHost([], async (h) => {
    assert.equal((await h.tick()).status, "succeeded");
    assertInert(h);
    assert.equal(count(h, "companies.list"), 0);
    assert.equal(count(h, "config.get"), 0);
  }));
  await check("unattributed config delivery is non-throwing and latches schedules inert with a bounded metric", async () => {
    for (const configs of [[], [[A, enabled]]]) {
      await withHost(configs, async (h) => {
        await h.handle.call("configChanged", { companyId: null, config: enabled });
        assert(h.servicesCalled.some((c) => c.name === "metrics.write" &&
          c.params.name === "cliproxy_insight.company_scope_refused" && c.params.tags?.reason === "missing_company_id"));
        assert.equal((await h.tick()).status, "succeeded");
        await h.change(A, enabled);
        assert.equal((await h.tick()).status, "succeeded");
        assert.equal(count(h, "config.get"), 0);
        assertInert(h);
      });
    }
  });
  await check("configured disabled and null-secret schedules are inert", async () => {
    for (const config of [{ pollingEnabled: false }, { pollingEnabled: true, laneApiKeySecretRef: null }]) {
      await withHost([[A, config]], async (h) => {
        assert.equal((await h.tick()).status, "succeeded");
        assertInert(h);
      });
    }
  });
  await check("one configured company: real schedule, six bounded GETs, scoped secret and persisted state", () => withHost([[A, enabled]], async (h) => {
    assert.equal((await h.tick()).status, "succeeded");
    assert.equal(count(h, "companies.list"), 0);
    assert.equal(count(h, "config.get"), 1);
    assert.equal(count(h, "secrets.resolve"), 1);
    assert.equal(count(h, "http.fetch"), 6);
    assert(h.state.size > 0);
    assert([...h.state.keys()].every((key) => key.startsWith(`company:${A}:`)));
    for (const call of h.calls.filter((c) => ["config.get", "secrets.resolve", "state.get", "state.set"].includes(c.method))) {
      assert.equal(call.context.invocationScope.companyId, A);
    }
    assert(!JSON.stringify([...h.state]).includes(fakeBearer));
  }));
  await check("config save enables after inert startup; same-company replay stays idempotent; disable stops requests", () => withHost([], async (h) => {
    assert.equal((await h.tick()).status, "succeeded");
    await h.change(A, enabled);
    await h.change(A, enabled);
    assert.equal((await h.tick()).status, "succeeded");
    assert.equal(count(h, "http.fetch"), 6);
    await h.change(A, { ...enabled, pollingEnabled: false });
    assert.equal((await h.tick()).status, "succeeded");
    assert.equal(count(h, "http.fetch"), 6);
  }));
  await check("two configured companies fail closed even when configs are byte-identical", async () => {
    for (const configB of [enabled, { ...enabled, staleAfterSeconds: 123 }]) {
      await withHost([[A, enabled]], async (h) => {
        await assert.rejects(h.change(B, configB), /exactly one configured company/);
        assert(h.servicesCalled.some((c) => c.name === "metrics.write" &&
          c.params.name === "cliproxy_insight.company_scope_refused" && c.params.tags?.reason === "multiple_companies"));
        for (let replay = 0; replay < 2; replay++) {
          await assert.rejects(h.change(A, enabled), /exactly one configured company/);
          assert.equal((await h.tick()).status, "succeeded");
        }
        assertInert(h);
        assert.equal(count(h, "config.get"), 0);
      });
    }
  });
  await check("cross-company tool and API invocations cannot read another company's config or state", () => withHost([[A, enabled]], async (h) => {
    await assert.rejects(h.handle.call("executeTool", {
      toolName: "get_provider_usage", parameters: { companyId: A },
      runContext: { companyId: B, agentId: "fixture", runId: "fixture" },
    }), /requested company|company context|not configured/);
    assert.equal(count(h, "config.get"), 0);
    assert.equal(count(h, "state.get"), 0);
    const api = await h.handle.call("handleApiRequest", {
      routeKey: "usage-summary", method: "GET", path: "/usage-summary",
      companyId: B, params: {}, query: { companyId: B }, headers: {}, body: null,
      actor: { actorType: "agent", actorId: "fixture" },
    });
    assert.equal(api.status, 403);
    assert.equal(count(h, "config.get"), 0);
    const scopedA = { invocationScope: { companyId: A } };
    for (const [method, params] of [
      ["config.get", { companyId: B }],
      ["secrets.resolve", { companyId: B, secretRef, configPath: "laneApiKeySecretRef" }],
      ["state.get", { scopeKind: "company", scopeId: B, stateKey: "fixture" }],
      ["state.set", { scopeKind: "company", scopeId: B, stateKey: "fixture", value: "forbidden" }],
    ]) {
      await assert.rejects(h.gated[method](params, scopedA), /requested company/);
      await assert.rejects(h.gated[method](params, {}), /company context is required/);
      assert.equal(count(h, method), 0);
    }
  }));
  await check("revoked host scope refuses before config/secret/state adapters, with no outbound requests", () => withHost([[A, enabled]], async (h) => {
    h.handle.setProactiveCompanyScopes([]);
    assert.equal((await h.tick()).status, "succeeded");
    assertInert(h);
    assert.equal(count(h, "config.get"), 0);
    assert(h.calls.some((c) => c.method === "config.get"));
    assert(h.servicesCalled.some((c) => c.name === "metrics.write" && c.params.tags?.reason === "unhandled"));
  }));
  await check("secret service failure prevents requests and records a bounded failure metric", () => withHost([[A, enabled]], async (h) => {
    assert.equal((await h.tick()).status, "succeeded");
    assert.equal(count(h, "secrets.resolve"), 1);
    assert.equal(count(h, "http.fetch"), 0);
    assert(h.servicesCalled.some((c) => c.name === "metrics.write" && c.params.tags?.reason === "secret_resolve_failed"));
    assert(!JSON.stringify([...h.state]).includes(fakeBearer));
  }, { serviceError: true }));
}
console.log(`STOCK CONTRACT: ${passed} PASS, 0 FAIL`);
