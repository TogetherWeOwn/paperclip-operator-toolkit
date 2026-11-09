// First-party receipt-unit controls, NOT execution of a stock host or plugin.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertEmptyUsage, partialStockReport, scheduledCompletion } from './stock-contract.mjs';

const start = Date.parse('2026-11-09T12:00:00Z');
const job = { id: 'fixture-job', pluginId: 'fixture-plugin', status: 'active', schedule: '*/5 * * * *', nextRunAt: '2026-11-09T12:05:00Z' };
const run = { id: 'fixture-run', jobId: job.id, pluginId: job.pluginId, trigger: 'schedule', status: 'succeeded',
  startedAt: '2026-11-09T12:05:01Z', finishedAt: '2026-11-09T12:05:02Z', durationMs: 1000 };
const observe = (runs, overrides = {}, prior = []) => scheduledCompletion(runs, { ...job, ...overrides }, prior, start);

test('accepts one new successful scheduled completion after readiness', () => {
  assert.deepEqual(observe([run]), run);
});
test('manual trigger cannot satisfy the tick receipt', () => {
  assert.equal(observe([{ ...run, trigger: 'manual' }]), null);
});
test('historical, foreign and incomplete runs cannot satisfy the receipt', () => {
  assert.equal(observe([run], {}, [run.id]), null);
  for (const overrides of [{ pluginId: 'other' }, { jobId: 'other' }, { status: 'running' },
    { status: 'failed' }, { startedAt: '2026-11-09T12:04:59Z' }, { finishedAt: null },
    { finishedAt: '2026-11-09T12:04:59Z' }, { durationMs: null }, { durationMs: -1 }]) {
    assert.equal(observe([{ ...run, ...overrides }]), null);
  }
});
test('missing/changed cron and stale readiness fail even with empty history', () => {
  for (const overrides of [{ nextRunAt: null }, { nextRunAt: 'invalid' }, { nextRunAt: '2026-11-09T11:59:59Z' },
    { schedule: '* * * * *' }, { status: 'paused' }]) {
    assert.throws(() => observe([], overrides));
  }
});
test('unexpected multiple scheduled completions fail', () => {
  assert.throws(() => observe([run, { ...run, id: 'another-run' }]));
});
test('empty-state assertions require all observed surfaces, not just providers', () => {
  const empty = { providers: [], snapshots: {}, lanes: [], laneSnapshots: {}, accountsCooling: 0, modelUsage: null };
  assertEmptyUsage(empty);
  for (const key of Object.keys(empty)) {
    const missing = { ...empty };
    delete missing[key];
    assert.throws(() => assertEmptyUsage(missing));
  }
  assert.throws(() => assertEmptyUsage({ ...empty, snapshots: { foreign: {} } }));
});
test('even completed lifecycle/config/schedule subsets cannot report full qualification', () => {
  const report = partialStockReport();
  report.lifecycleCompleted = report.configRoutesCompleted = report.scheduledDispatchObserved = true;
  for (const key of ['telemetryPositive', 'runtimeCapabilityDenial', 'unauthorizedServiceEffectsMeasured',
    'stockHostQualified', 'migrationQualified']) assert.equal(report[key], false);
  assert.equal(report.prerequisites.length, 3);
  assert.deepEqual(Object.keys(report.unqualifiedControls).sort(), [
    'capabilityDenial', 'insightTelemetry', 'invocationScopeDenial', 'modelSelectionTelemetry', 'scopedHttpActor',
  ]);
  for (const control of Object.values(report.unqualifiedControls)) {
    assert.equal(control.status, 'not-exercised', 'Unavailable observation is not a measured zero');
    assert.equal(typeof control.reason, 'string');
    assert(control.reason.length > 0);
  }
});
test('Actions checks source but never invokes the held stock driver or pulls its image', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/sdk-candidate.yml', import.meta.url), 'utf8');
  assert(workflow.includes('node --check verification/sdk-qualification/stock-driver.mjs'));
  assert(!workflow.includes('docker pull') && !workflow.includes('docker run'));
  assert(!/^\s*run: node (?:--experimental-import-meta-resolve )?verification\/sdk-qualification\/stock-driver\.mjs\s*$/m.test(workflow));
});
