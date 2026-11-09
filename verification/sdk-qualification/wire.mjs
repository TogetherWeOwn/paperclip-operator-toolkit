import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { inspectConsumer } from './consumer.mjs';
import { workerBridge } from './worker-bridge.mjs';

assert.equal(process.argv.length, 3, 'Usage: node --experimental-import-meta-resolve wire.mjs <plugin-root>');
const consumer = await inspectConsumer(process.argv[2]);
const { root, worker, manifest } = consumer;
const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const results = [];
const config = {
  pollingEnabled: true, baseUrl: 'https://fixture.invalid/telemetry',
  requestTimeoutMs: 1000, laneFiles: ['fixture.json'], legacyAggregateFiles: false,
  laneApiKeySecretRef: { type: 'secret_ref', secretId: '33333333-3333-4333-8333-333333333333' },
};
const initialize = { manifest, config, apiVersion: 1,
  instanceInfo: { instanceId: '44444444-4444-4444-8444-444444444444' }, databaseNamespace: null };

// A dead worker must never satisfy a timeout-only or zero-assertion run.
const dead = workerBridge(worker, root, async () => assert.fail('Dead worker requested a service'), ['-e', 'process.exit(0)']);
try {
  await assert.rejects(dead.request('initialize', initialize), /exited early/);
  results.push('dead-worker-refused');
} finally {
  await dead.close();
}

async function scenario(name, fn) {
  const calls = [];
  const deferred = [];
  const state = new Map();
  let deferHttp = false;
  const bridge = workerBridge(worker, root, async (message, reply) => {
    const { method, params } = message;
    calls.push({ method, params });
    switch (method) {
      case 'config.get':
        assert.equal(params.companyId, COMPANY);
        reply(config);
        break;
      case 'events.subscribe':
        assert(manifest.id.includes('model-selection'));
        assert(['issue.updated', 'issue.comment.created', 'issue.created', 'agent.run.failed'].includes(params.eventPattern));
        reply(null);
        break;
      case 'state.get':
      case 'state.set': {
        if (manifest.id.includes('model-selection') && method === 'state.get') {
          assert.equal(params.scopeKind, 'instance');
          assert.equal(params.stateKey, 'knownCompanies');
          reply(null);
          break;
        }
        assert.equal(params.scopeKind, 'company');
        assert.equal(params.scopeId, COMPANY);
        const key = params.stateKey;
        if (method === 'state.set') state.set(key, params.value);
        reply(method === 'state.get' ? state.get(key) ?? null : null);
        break;
      }
      case 'metrics.write':
      case 'activity.log':
        reply(null);
        break;
      case 'secrets.resolve':
        assert.equal(params.companyId, COMPANY);
        assert.equal(params.configPath, 'laneApiKeySecretRef');
        assert.deepEqual(params.secretRef, config.laneApiKeySecretRef);
        reply('fixture-value');
        break;
      case 'http.fetch': {
        assert.equal(params.url, 'https://fixture.invalid/telemetry/fixture.json');
        assert.deepEqual(Object.keys(params.init).sort(), ['headers', 'method']);
        assert.equal(params.init.method, 'GET');
        assert.equal(params.init.headers['x-api-key'], 'fixture-value');
        const response = { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, observedAt: new Date().toISOString(), records: [] }) };
        if (deferHttp) deferred.push(() => reply(response));
        else reply(response);
        break;
      }
      default: assert.fail(`Unreviewed fixture service: ${method}`);
    }
  });
  try {
    const initialized = await bridge.request('initialize', initialize);
    assert.equal(initialized.ok, true);
    assert(Array.isArray(initialized.supportedMethods));
    await fn({ bridge, calls, deferred, defer: () => { deferHttp = true; }, initialized });
    bridge.assertHealthy();
    results.push(name);
  } finally {
    // Settle the inert host replies even after a failed assertion; timeout is
    // explicitly not evidence that the host-side operation was cancelled.
    for (const reply of deferred) reply();
    await bridge.close();
  }
}

await scenario('initialize-and-unknown-method', async ({ bridge, initialized, calls }) => {
  const before = calls.length;
  for (const method of ['resolveRunModel', 'onResolveRunModel']) {
    assert(!initialized.supportedMethods.includes(method));
    await assert.rejects(bridge.request(method, { companyId: COMPANY }), { code: -32601 });
  }
  await assert.rejects(bridge.request('runJob', { job: { jobKey: 'not-declared' } }));
  assert.equal(calls.length, before, 'Unknown dispatch must not call fixture services');
});

if (manifest.id.includes('cliproxy-insight')) {
  const job = { job: { jobKey: manifest.jobs[0].jobKey } };
  const tool = manifest.tools[0].name;
  const route = manifest.apiRoutes[0].routeKey;
  const effects = (calls) => calls.filter(({ method }) => !['metrics.write'].includes(method));
  const metric = (calls, suffix) => calls.some(({ method, params }) =>
    method === 'metrics.write' && params.name === `cliproxy_insight.${suffix}`);
  await scenario('same-company-job-tool-api', async ({ bridge, calls }) => {
    await bridge.request('configChanged', { config, companyId: COMPANY });
    await bridge.request('runJob', job);
    assert.equal(calls.filter(({ method }) => method === 'http.fetch').length, 1);
    assert(metric(calls, 'poll_ok'), 'Valid response must reach the success path');
    const toolResult = await bridge.request('executeTool', { toolName: tool, parameters: { companyId: COMPANY } });
    assert(toolResult.data && !toolResult.error);
    const apiResult = await bridge.request('handleApiRequest', { routeKey: route, companyId: COMPANY });
    assert.equal(apiResult.status, 200);
  });
  await scenario('missing-company-zero-service-effects', async ({ bridge, calls }) => {
    await bridge.request('configChanged', { config });
    await bridge.request('runJob', job);
    assert(metric(calls, 'poll_skipped_company_scope'));
    assert.equal(effects(calls).length, 0);
  });
  await scenario('cross-company-tool-api-zero-service-effects', async ({ bridge, calls }) => {
    await bridge.request('configChanged', { config, companyId: COMPANY });
    const toolResult = await bridge.request('executeTool', { toolName: tool, parameters: { companyId: OTHER } });
    assert(toolResult.error);
    const apiResult = await bridge.request('handleApiRequest', { routeKey: route, companyId: OTHER });
    assert.equal(apiResult.status, 403);
    assert.equal(effects(calls).length, 0);
  });
  await scenario('identical-second-company-latches-poll-off', async ({ bridge, calls }) => {
    await bridge.request('configChanged', { config, companyId: COMPANY });
    await assert.rejects(bridge.request('configChanged', { config, companyId: OTHER }));
    await bridge.request('runJob', job);
    assert(metric(calls, 'poll_skipped_company_scope'));
    assert.equal(effects(calls).length, 0);
  });
  await scenario('timeout-does-not-cancel-host-call', async ({ bridge, calls, deferred, defer }) => {
    await bridge.request('configChanged', { config, companyId: COMPANY });
    defer();
    const start = performance.now();
    await bridge.request('runJob', job);
    const elapsedMs = performance.now() - start;
    assert(elapsedMs >= 900 && elapsedMs < 5000, `Timeout did not bound plugin await: ${elapsedMs}`);
    assert.equal(deferred.length, 1, 'The host reply must still be outstanding');
    assert(calls.some(({ method, params }) => method === 'metrics.write' && params.tags?.reason === 'timeout'));
    assert(!metric(calls, 'poll_ok'));
    // A follow-up request proves this process is still alive before cleanup.
    const health = await bridge.request('health');
    assert.equal(health.status, 'ok');
  });
}

assert.equal(results.length, manifest.id.includes('cliproxy-insight') ? 7 : 2, 'Partial fixture run');

// Supply an actual signal via a separate tiny worker importing this consumer's
// SDK. Neither the current plugin nor JSON alone is a signal-loss control.
const signalResults = [];
const signalCalls = [];
const signalWorker = fileURLToPath(new URL('./signal-worker.mjs', import.meta.url));
const signalBridge = workerBridge(signalWorker, root, async ({ method, params }, reply) => {
  assert.equal(method, 'http.fetch');
  assert.deepEqual(params, {
    url: 'https://fixture.invalid/signal',
    init: { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'tiny-signal-control' },
  }, 'Held SDK must serialize the supported fields and omit AbortSignal');
  signalCalls.push(method);
  reply({ status: 200, statusText: 'OK', headers: {}, body: 'inert-host-response' });
}, [signalWorker, consumer.sdk]);
try {
  const initialized = await signalBridge.request('initialize', initialize);
  assert.equal(initialized.ok, true);
  assert(initialized.supportedMethods.includes('handleApiRequest'));
  for (const mode of ['normal', 'pre-aborted', 'abort-after-send']) {
    const before = signalCalls.length;
    const result = await signalBridge.request('handleApiRequest', { mode });
    assert.deepEqual(result, { status: 200, body: 'inert-host-response', aborted: mode !== 'normal' });
    assert.equal(signalCalls.length, before + 1, 'Even an aborted local signal reaches the inert host');
    signalResults.push(mode);
  }
  signalBridge.assertHealthy();
} finally {
  await signalBridge.close();
}
assert.equal(signalResults.length, 3, 'Partial signal probe');
console.log(JSON.stringify({ ...consumer.report, wire: { results,
  boundary: 'Real built worker/SDK subprocess with inert service replies; NOT stock scheduler or authorization.',
  stockScheduler: 'not exercised', capabilityDenial: 'not exercised',
  abortSignal: { boundary: 'Separate synthetic worker using consumer-resolved SDK', results: signalResults,
    serialized: false, localAbortPreventsHostCall: false },
  hostCancellation: false, stockHostQualified: false } }, null, 2));
