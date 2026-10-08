import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { manifest } from '../src/manifest.mjs';
import { createSupplyPlugin, resolveConfig } from '../src/plugin.mjs';
import { JOBS } from '../src/policy.mjs';
import { NOW, config, issue, snapshot } from './fixtures.mjs';

const rawConfig = patch => {
  const { companyId, ...raw } = config();
  return { ...raw, hostPressureScopeVerified: true, ...patch };
};
const healthy = () => ({ observedAt: new Date(NOW).toISOString(), scope: 'host',
  cpuSome: 0, ioSome: 0, memoryFull: 0, rootUsed: 40, homeUsed: 40 });
const job = key => ({ jobKey: key, runId: 'job-run', trigger: 'schedule', scheduledAt: new Date(NOW).toISOString() });

async function harness(options = {}) {
  const handlers = new Map(), data = new Map(), values = new Map(), configs = new Map(), logs = [];
  const calls = { reads: 0, writes: 0, configReads: [] };
  const plugin = createSupplyPlugin({ clock: () => NOW, ...options });
  const ctx = {
    jobs: { register: (key, fn) => handlers.set(key, fn) },
    data: { register: (key, fn) => data.set(key, fn) },
    config: { get: async companyId => { calls.configReads.push(companyId); return configs.get(companyId) ?? {}; } },
    state: {
      get: async key => { calls.reads++; return structuredClone(values.get(JSON.stringify(key)) ?? null); },
      set: async (key, value) => { calls.writes++; values.set(JSON.stringify(key), structuredClone(value)); },
    },
    logger: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    // Any unintended core, network, secret or agent mutation is fatal in the tests.
    issues: new Proxy({}, { get() { throw new Error('core mutation forbidden'); } }),
    agents: new Proxy({}, { get() { throw new Error('agent mutation forbidden'); } }),
    http: new Proxy({}, { get() { throw new Error('network forbidden'); } }),
    secrets: new Proxy({}, { get() { throw new Error('secret access forbidden'); } }),
  };
  await plugin.setup(ctx);
  async function configure(companyId, raw) {
    await plugin.onConfigChanged(raw, { companyId }); configs.set(companyId, raw);
  }
  return { plugin, handlers, data, values, configs, logs, calls, ctx, configure };
}

test('package declares real manifest and worker files with matching version', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, manifest.version);
  for (const path of Object.values(pkg.paperclipPlugin)) assert.ok(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
  assert.deepEqual(manifest.jobs.map(j => j.jobKey), JOBS);
  assert.deepEqual(manifest.capabilities, ['jobs.schedule', 'plugin.state.read', 'plugin.state.write']);
});
test('config defaults paused and shadow, identity is exclusively host-derived', () => {
  assert.equal(resolveConfig('company-a', {}).pause, true);
  assert.equal(resolveConfig('company-a', {}).mode, 'shadow');
  assert.equal(resolveConfig('company-a', {}).hostPressureScopeVerified, false);
  assert.throws(() => resolveConfig('company-a', { companyId: 'company-b' }));
  assert.throws(() => resolveConfig('company-a', { mode: 'apply' }));
  assert.throws(() => resolveConfig('company-a', { pause: 'false' }));
  assert.throws(() => resolveConfig('company-a', { hostPressureScopeVerified: 'true' }));
});
test('no company enumeration or ambient bootstrap scope', async () => {
  const h = await harness();
  for (const key of JOBS) await h.handlers.get(key)(job(key));
  assert.deepEqual(h.calls.configReads, []);
  assert.equal((await h.plugin.onHealth()).status, 'degraded');
  await assert.rejects(h.plugin.onConfigChanged({}, {}), /company-context-required/);
  await assert.rejects(h.data.get('shadow-ledger')({ companyId: 'foreign' }), /company-not-configured/);
});
test('all five paused jobs do no pressure, collection or ledger I/O', async () => {
  const h = await harness({ collect: () => { throw new Error('should not collect'); }, pressure: () => { throw new Error('should not read'); } });
  await h.configure('company-a', {});
  for (const key of JOBS) await h.handlers.get(key)(job(key));
  assert.equal(h.calls.reads, 0); assert.equal(h.calls.writes, 0);
  assert.ok((await h.plugin.onHealth()).details.firings.every(f => f.status === 'paused'));
});
test('actual default collector cannot manufacture a complete empty census', async () => {
  const h = await harness(); await h.configure('company-a', rawConfig());
  for (const key of JOBS) await assert.rejects(h.handlers.get(key)(job(key)), /work-supply-job-failed/);
  assert.equal(h.calls.writes, 0);
  const health = await h.plugin.onHealth();
  assert.equal(health.status, 'degraded');
  assert.ok(health.details.firings.every(f => f.code === 'native-snapshot-source-unavailable'));
});
for (const key of JOBS) {
  test(`${key}: high host pressure suppresses all candidate kinds before collection`, async () => {
    let collected = 0;
    // A fresh sample above any threshold must suppress the whole planning path.
    const held = await harness({ collect: () => { collected++; return snapshot(); }, pressure: () => ({ ...healthy(), cpuSome: 31 }) });
    await held.configure('company-a', rawConfig());
    await held.handlers.get(key)(job(key));
    assert.equal(collected, 0); assert.equal(held.calls.writes, 0);
    assert.equal((await held.plugin.onHealth()).details.firings[0].status, 'pressure-held');
  });
}
for (const key of JOBS) {
  test(`${key}: pressure expiring during collection does not write or consume observation budget`, async () => {
    let now = NOW, slow = true;
    const h = await harness({ clock: () => now, pressure: () => ({ ...healthy(), observedAt: new Date(now).toISOString() }),
      collect: () => {
        if (slow) now += 65_000;
        return snapshot({ capturedAt: now, issues: [issue()] });
      } });
    await h.configure('company-a', rawConfig());
    await h.handlers.get(key)(job(key));
    assert.equal(h.calls.writes, 0);
    assert.equal(h.values.size, 0);
    const firing = (await h.plugin.onHealth()).details.firings[0];
    assert.equal(firing.status, 'pressure-held');
    assert.equal(firing.observed, 0);
    assert.ok(firing.reasons.includes('pressure-stale'));
    if (key === 'backlogFloor') {
      slow = false;
      await h.handlers.get(key)(job(key));
      assert.equal((await h.plugin.onHealth()).details.firings[0].observed, 1);
    }
  });
}
test('pressure expiring during a ledger read stops collection and error-health writes', async () => {
  let now = NOW, collected = 0;
  const h = await harness({ clock: () => now, pressure: () => healthy(), collect: () => { collected++; return snapshot(); } });
  h.ctx.state.get = async () => { now += 65_000; return null; };
  await h.configure('company-a', rawConfig());
  await h.handlers.get('backlogFloor')(job('backlogFloor'));
  assert.equal(collected, 0);
  assert.equal(h.calls.writes, 0);
  assert.equal((await h.plugin.onHealth()).details.firings[0].status, 'pressure-held');
});
test('pressure read errors fail loudly and redact upstream content', async () => {
  const h = await harness({ collect: () => snapshot(), pressure: () => { throw new Error('sensitive-upstream-body'); } });
  await h.configure('company-a', rawConfig());
  await assert.rejects(h.handlers.get('idleWake')(job('idleWake')), /work-supply-job-failed/);
  assert.equal((await h.plugin.onHealth()).details.firings[0].code, 'pressure-unavailable');
  assert.ok(!JSON.stringify(h.logs).includes('sensitive-upstream-body'));
});
test('scheduled proposals persist in company-scoped plugin DB state and survive restart', async () => {
  const opts = { collect: () => snapshot({ issues: [issue()] }), pressure: () => healthy() };
  const h = await harness(opts); await h.configure('company-a', rawConfig());
  await h.handlers.get('backlogFloor')(job('backlogFloor'));
  assert.equal((await h.plugin.onHealth()).details.firings[0].observed, 1);
  const ledger = await h.data.get('shadow-ledger')({ companyId: 'company-a' });
  assert.equal(ledger.entries[0].action.kind, 'promote_issue');
  const restarted = createSupplyPlugin({ ...opts, clock: () => NOW });
  await restarted.setup(h.ctx); await restarted.onConfigChanged(rawConfig(), { companyId: 'company-a' });
  await h.handlers.get('backlogFloor')(job('backlogFloor'));
  assert.equal((await restarted.onHealth()).details.firings[0].observed, 0);
  for (const key of h.values.keys()) assert.equal(JSON.parse(key).scopeId, 'company-a');
});
test('collector failure cannot impersonate healthy empty input', async () => {
  const h = await harness({ collect: () => { throw new Error('private-response'); }, pressure: () => healthy() });
  await h.configure('company-a', rawConfig());
  await assert.rejects(h.handlers.get('prSupply')(job('prSupply')), /work-supply-job-failed/);
  assert.ok(!JSON.stringify(h.logs).includes('private-response'));
  assert.equal((await h.plugin.onHealth()).details.firings[0].code, 'shadow-dependency-failed');
});
test('company failure does not skip the next company or mix ledgers', async () => {
  const h = await harness({ collect: (key, companyId) => {
    if (companyId === 'company-a') throw new Error('unreadable');
    return snapshot({ companyId, agents: [], issues: [], prs: [], intents: [] });
  }, pressure: () => healthy() });
  await h.configure('company-a', rawConfig()); await h.configure('company-b', rawConfig());
  await assert.rejects(h.handlers.get('idleWake')(job('idleWake')), /work-supply-job-failed/);
  assert.deepEqual(h.calls.configReads, ['company-a', 'company-b']);
  const health = new Map((await h.plugin.onHealth()).details.firings.map(f => [f.companyId, f]));
  assert.equal(health.get('company-a').status, 'error'); assert.equal(health.get('company-b').status, 'shadow');
  for (const [key, value] of h.values) assert.equal(JSON.parse(key).scopeId, value.companyId);
});
test('a stalled company does not prevent another company from completing repeated schedules', async () => {
  const h = await harness();
  await h.configure('company-a', {}); await h.configure('company-b', {});
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const get = h.ctx.config.get;
  h.ctx.config.get = async id => { if (id === 'company-a') await stalled; return get(id); };
  const pending = Array.from({ length: 2 }, () => JOBS.map(key => h.handlers.get(key)(job(key)))).flat();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.calls.configReads, Array(10).fill('company-b'));
    const firings = (await h.plugin.onHealth()).details.firings;
    assert.equal(firings.length, 5);
    assert.ok(firings.every(f => f.companyId === 'company-b' && f.status === 'paused'));
  } finally { release(); await Promise.all(pending); }
});
test('simultaneous schedules serialize all five jobs instead of starving behind busy', async () => {
  const collected = [];
  const h = await harness({ collect: async key => {
    collected.push(key); await new Promise(resolve => setImmediate(resolve)); return snapshot();
  }, pressure: () => healthy() });
  await h.configure('company-a', rawConfig());
  await Promise.all(JOBS.map(key => h.handlers.get(key)(job(key))));
  assert.deepEqual(collected, JOBS);
  const ledger = await h.data.get('shadow-ledger')({ companyId: 'company-a' });
  assert.deepEqual(Object.keys(ledger.health), JOBS);
  assert.ok((await h.plugin.onHealth()).details.firings.every(f => f.status === 'shadow'));
});
test('unverified config cannot be overridden by an optimistic pressure reader', async () => {
  let collected = 0;
  const h = await harness({ collect: () => { collected++; return snapshot(); }, pressure: () => healthy() });
  await h.configure('company-a', rawConfig({ hostPressureScopeVerified: false }));
  await h.handlers.get('idleWake')(job('idleWake'));
  assert.equal(collected, 0);
  assert.equal((await h.plugin.onHealth()).details.firings[0].status, 'pressure-held');
});
test('ledger write failure is a failed job, not successful observation', async () => {
  const h = await harness({ collect: () => snapshot(), pressure: () => healthy() });
  h.ctx.state.set = async () => { throw new Error('db-failure-sensitive'); };
  await h.configure('company-a', rawConfig());
  await assert.rejects(h.handlers.get('idleWake')(job('idleWake')), /work-supply-job-failed/);
  assert.equal((await h.plugin.onHealth()).details.firings[0].status, 'error');
});
