// PREPARED ONLY: no workflow invokes this driver. Installation/Security holds
// must clear separately; these misuse guards are not an approval mechanism.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectConsumer } from './consumer.mjs';
import { checkConfigRoutes } from './stock-config.mjs';
import { validateStockPackage } from './stock-package.mjs';
import { STOCK_SOURCE, STOCK_IMAGE, STOCK_RELEASE, assertEmptyUsage, partialStockReport, scheduledCompletion } from './stock-contract.mjs';

const candidate = '/qualification/candidate';
const evidence = '/qualification/evidence';
const report = partialStockReport();
const base = 'http://127.0.0.1:3100';
let disposable = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');

async function api(path, body, expectedStatus = 200) {
  assert(path.startsWith('/api/'));
  assert(!path.includes('://'));
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  // All data in this namespace is synthetic; still bound error/response reads.
  assert(response.body);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert(bytes <= 1024 * 1024, 'Stock response exceeded fixture budget');
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  assert(statuses.includes(response.status), `${path}: HTTP ${response.status}: ${String(payload?.error ?? '').slice(0, 500)}`);
  if (response.status >= 400) assert.equal(typeof payload.error, 'string');
  return payload;
}

async function ready() {
  const deadline = Date.now() + 180_000;
  let last;
  do {
    try {
      const health = await api('/api/health');
      if (health.status === 'ok') return health;
    } catch (error) { last = error; }
    await delay(1000);
  } while (Date.now() < deadline);
  throw new Error(`Stock readiness failed: ${last?.message}`);
}

async function waitForScheduledRun(pluginPath, manifest) {
  const startedAt = Date.now();
  const deadline = startedAt + 360_000; // unchanged five-minute cron plus one stock tick
  let job;
  do {
    const jobs = await api(`${pluginPath}/jobs`);
    assert(Array.isArray(jobs));
    job = jobs.find(item => item.jobKey === manifest.jobs[0].jobKey && item.nextRunAt);
    if (job) break;
    await delay(1000);
  } while (Date.now() < startedAt + 15_000);
  assert(job, 'Stock coordinator did not publish schedule readiness');
  assert.equal(job.schedule, manifest.jobs[0].schedule);
  const prior = await api(`${pluginPath}/jobs/${job.id}/runs?limit=25`);
  const priorIds = prior.map(run => run.id);
  assert(Date.parse(job.nextRunAt) <= deadline - 30_000, 'Schedule exceeds bounded observation window');
  // Validate readiness even when history is empty. Never call the manual trigger
  // route, invoke tick directly, edit the DB/cron or replace the host clock.
  scheduledCompletion([], job, priorIds, startedAt);
  do {
    const runs = await api(`${pluginPath}/jobs/${job.id}/runs?limit=25`);
    const completed = scheduledCompletion(runs, job, priorIds, startedAt);
    if (completed) return { job, run: completed };
    assert(!runs.some(run => !priorIds.includes(run.id) && ['failed', 'cancelled', 'timed_out'].includes(run.status)),
      'Stock scheduled run failed');
    await delay(2000);
  } while (Date.now() < deadline);
  throw new Error('No successful real scheduled dispatch before deadline; manual/no-op substitutes are not accepted');
}

async function invalidManifestControl(consumer) {
  // First-party negative manifest only, in disposable container storage. Neither
  // real artifact nor dependency is rewritten. The host must reject before load.
  const root = await mkdtemp('/tmp/sdk-invalid-manifest-');
  await mkdir(join(root, 'dist'));
  const invalid = { ...consumer.manifest, id: `${consumer.manifest.id}-invalid-api`, apiVersion: 999 };
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: '@qualification/invalid-api', version: '0.0.0', type: 'module',
    paperclipPlugin: { manifest: './dist/manifest.js', worker: './dist/worker.js' },
  }));
  await writeFile(join(root, 'dist/manifest.js'), `export default ${JSON.stringify(invalid)};\n`);
  await writeFile(join(root, 'dist/worker.js'), 'throw new Error("Invalid manifest must never start");\n');
  const payload = await api('/api/plugins/install', { packageName: root, isLocalPath: true }, [400, 500]);
  assert.match(payload.error, /apiVersion/i, 'Unrelated loader error cannot satisfy the control');
  const plugins = await api('/api/plugins');
  assert(Array.isArray(plugins));
  assert(!plugins.some(plugin => plugin.pluginKey === invalid.id), 'Rejected manifest was registered');
  report.checks.push('actual stock local-path manifest-load API-version refusal');
}

try {
  assert.equal(process.argv.length, 2, 'Driver has no configurable endpoint or runtime arguments');
  assert.equal(process.env.SDK_QUALIFICATION_RUN, 'disposable-actions');
  assert.equal(process.env.PAPERCLIP_DEPLOYMENT_MODE, 'local_trusted');
  assert.equal(process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE, 'private');
  assert.equal(process.env.PAPERCLIP_BUILD_COMMIT, STOCK_SOURCE);
  assert.deepEqual((await readdir('/sys/class/net')).sort(), ['lo'], 'Requires network-none namespace');
  await access(evidence);
  disposable = true;
  const [image] = await json(join(evidence, 'image.json'));
  assert(image.RepoDigests.includes(STOCK_IMAGE));
  assert.equal(image.Architecture, 'amd64');
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], STOCK_SOURCE);
  assert.equal(image.Config.Labels['org.opencontainers.image.version'].split('+')[0], STOCK_RELEASE);
  const health = await ready();
  assert.equal(health.version.split('+')[0], STOCK_RELEASE);
  assert.equal(health.deploymentMode, 'local_trusted');
  assert.equal(health.deploymentExposure, 'private');
  report.host = { health, node: process.versions.node, source: process.env.PAPERCLIP_BUILD_COMMIT,
    serverPackage: await json('/app/server/package.json'), serverBundleSha256: await digest('/app/server/dist-runtime/index.mjs') };
  assert(Number(process.versions.node.split('.')[0]) >= 24);
  // Native ESM edges are independently recorded from the mounted real workers;
  // neither an image tag nor host Zod is used as the candidate's identity.
  const consumers = [];
  for (const name of ['cliproxy-insight', 'model-selection']) {
    const consumer = await inspectConsumer(join(candidate, 'consumers', `stock-${name}`), candidate);
    await validateStockPackage(consumer.root, consumer.manifest);
    consumers.push(consumer);
  }
  report.consumers = consumers.map(consumer => consumer.report);
  await invalidManifestControl(consumers[0]);
  const installed = [];
  for (const consumer of consumers) {
    let plugin = await api('/api/plugins/install', { packageName: consumer.root, isLocalPath: true });
    plugin = plugin.plugin ?? plugin;
    assert.equal(plugin.pluginKey, consumer.manifest.id);
    assert.equal(plugin.status, 'ready');
    assert.equal(plugin.packagePath, consumer.root);
    assert.equal(plugin.version, consumer.manifest.version);
    const path = `/api/plugins/${plugin.id}`;
    await api(`${path}/disable`, {});
    const enabled = await api(`${path}/enable`, {});
    assert.equal(enabled.status, 'ready');
    const workerHealth = await api(`${path}/health`);
    assert.equal(workerHealth.healthy, true);
    installed.push({ plugin, path, workerHealth });
  }
  report.installed = installed;
  report.lifecycleCompleted = true;
  const pluginPath = installed[0].path;
  const company = await api('/api/companies', { name: 'SDK qualification same-company fixture' }, 201);
  const other = await api('/api/companies', { name: 'SDK qualification unconfigured-company fixture' }, 201);
  const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  assert.match(company.id, guid);
  assert.match(other.id, guid);
  assert.notEqual(company.id, other.id);
  // No credential or outbound telemetry is needed for this explicitly NO-OP
  // slice. This must never be promoted to the required telemetry positive.
  const config = { pollingEnabled: false, laneFiles: [], legacyAggregateFiles: false, requestTimeoutMs: 1000 };
  const saved = await api(`${pluginPath}/config`, { companyId: company.id, configJson: config });
  assert.deepEqual(saved.configJson, config);
  const configPath = `${pluginPath}/config?companyId=${company.id}`;
  assert.deepEqual((await api(configPath)).configJson, config);
  await checkConfigRoutes(api, pluginPath, company.id, config);
  const usagePath = `${pluginPath}/api/usage-summary`;
  const usage = await api(`${usagePath}?companyId=${company.id}`);
  assertEmptyUsage(usage);
  await api(usagePath, undefined, 400);
  await api(`${usagePath}?companyId=${other.id}`, undefined, 403);
  assertEmptyUsage(await api(`${usagePath}?companyId=${company.id}`));
  report.configRoutesCompleted = true;
  report.checks.push('actual stock config-save/test Ajv refusal and same-company scoped API control',
    'missing-company and unconfigured-company API refusal; not a scoped-actor authorization or service-effect count');
  report.schedule = await waitForScheduledRun(pluginPath, consumers[0].manifest);
  report.scheduledDispatchObserved = true;
  assertEmptyUsage(await api(`${usagePath}?companyId=${company.id}`));
  report.checks.push('real scheduled run completed with polling disabled; no telemetry-positive claim');
  report.driverConclusion = 'partial-lifecycle-only';
} catch (error) {
  report.driverConclusion = 'failure';
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  if (disposable) await writeFile(join(evidence, 'sdk-stock.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  // Container removal/volume removal and hosted-VM disposal belong to the future
  // authorized Actions lifecycle's always-path, not an optional driver success.
}
