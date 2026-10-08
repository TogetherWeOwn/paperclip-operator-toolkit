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
    // The host persists config before its best-effort lifecycle notification.
    configs.set(companyId, raw); await plugin.onConfigChanged(raw, { companyId });
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
test('a persisted schema-valid invalid config is visible before scheduling and fails every job', async () => {
  const h = await harness({ collect: () => { throw new Error('should not collect'); }, pressure: () => { throw new Error('should not read'); } });
  const invalid = { repositories: [{ repo: 'owner/repo', projectId: 'missing-project' }] };
  await assert.rejects(h.configure('company-bad', invalid), /invalid-config/);
  const health = await h.plugin.onHealth();
  assert.equal(health.status, 'degraded');
  assert.equal(health.details.configuredCompanies, 1);
  assert.deepEqual(health.details.configErrors, [{ companyId: 'company-bad', code: 'invalid-config' }]);
  for (const key of JOBS) await assert.rejects(h.handlers.get(key)(job(key)), /work-supply-job-failed/);
  assert.equal(h.calls.reads, 0); assert.equal(h.calls.writes, 0);
  assert.ok((await h.plugin.onHealth()).details.firings.every(f => f.code === 'invalid-config'));
  assert.ok(h.logs.some(([message, details]) => message === 'work-supply: config rejected'
    && details.companyId === 'company-bad' && details.code === 'invalid-config'));
});
test('an invalid company cannot hide behind a healthy company or prevent its scheduled work', async () => {
  const h = await harness({ collect: () => { throw new Error('should not collect'); } });
  await h.configure('company-a', {});
  await assert.rejects(h.configure('company-b', { repositories: [{ repo: 'owner/repo', projectId: 'missing-project' }] }));
  await assert.rejects(h.handlers.get('idleWake')(job('idleWake')), /work-supply-job-failed/);
  const health = await h.plugin.onHealth();
  assert.equal(health.status, 'degraded');
  assert.equal(health.details.configuredCompanies, 2);
  const firings = new Map(health.details.firings.map(f => [f.companyId, f]));
  assert.equal(firings.get('company-a').status, 'paused');
  assert.equal(firings.get('company-b').code, 'invalid-config');
  assert.equal(h.calls.reads, 0); assert.equal(h.calls.writes, 0);
});
for (const pause of [false, true]) {
  test(`config rejection during a pending read cancels ${pause ? 'paused' : 'unpaused'} completion`, async () => {
    let collected = 0, started, release;
    const h = await harness({ collect: () => { collected++; return snapshot({ issues: [issue()] }); }, pressure: () => healthy() });
    await h.configure('company-a', rawConfig({ pause }));
    const reading = new Promise(resolve => { started = resolve; });
    const suspended = new Promise(resolve => { release = resolve; });
    const get = h.ctx.config.get;
    h.ctx.config.get = async id => {
      const captured = await get(id); started(); await suspended; return captured;
    };
    const pending = assert.rejects(h.handlers.get('backlogFloor')(job('backlogFloor')), /work-supply-job-failed/);
    await reading;
    try {
      await assert.rejects(h.configure('company-a', { privateField: 'sensitive-config-body' }), /invalid-config/);
    } finally { release(); }
    await pending;
    assert.equal(collected, 0); assert.equal(h.calls.reads, 0); assert.equal(h.calls.writes, 0);
    assert.equal((await h.plugin.onHealth()).details.firings[0].code, 'invalid-config');
    assert.ok(!JSON.stringify({ logs: h.logs, health: await h.plugin.onHealth() }).includes('sensitive-config-body'));
    h.ctx.config.get = get;
    await h.configure('company-a', {});
    for (const key of JOBS) await h.handlers.get(key)(job(key));
    const health = await h.plugin.onHealth();
    assert.equal(health.status, 'ok');
    assert.deepEqual(health.details.configErrors, []);
    assert.ok(health.details.firings.every(f => f.status === 'paused'));
  });
}
test('a delayed invalid notification cannot latch over newer valid persisted config', async () => {
  const h = await harness({ collect: () => { throw new Error('should not collect'); } });
  const invalid = { repositories: [{ repo: 'owner/repo', projectId: 'missing-project' }] };
  h.configs.set('company-a', invalid);
  await h.configure('company-a', {});
  await assert.rejects(h.plugin.onConfigChanged(invalid, { companyId: 'company-a' }), /invalid-config/);
  assert.equal((await h.plugin.onHealth()).status, 'degraded');
  for (const key of JOBS) await h.handlers.get(key)(job(key));
  assert.equal(h.calls.configReads.length, JOBS.length);
  assert.equal(h.calls.reads, 0); assert.equal(h.calls.writes, 0);
  const health = await h.plugin.onHealth();
  assert.equal(health.status, 'ok');
  assert.deepEqual(health.details.configErrors, []);
  assert.ok(health.details.firings.every(f => f.status === 'paused'));
});
test('a delayed valid notification cannot clear a current config rejection', async () => {
  const h = await harness({ collect: () => { throw new Error('should not collect'); } });
  await h.configure('company-a', {});
  await assert.rejects(h.configure('company-a', { repositories: [{ repo: 'owner/repo', projectId: 'missing-project' }] }));
  await h.plugin.onConfigChanged({}, { companyId: 'company-a' });
  assert.deepEqual((await h.plugin.onHealth()).details.configErrors, [{ companyId: 'company-a', code: 'invalid-config' }]);
  for (const key of JOBS) await assert.rejects(h.handlers.get(key)(job(key)), /work-supply-job-failed/);
  assert.equal(h.calls.reads, 0); assert.equal(h.calls.writes, 0);
});
for (const boundary of ['pressure', 'ledger read', 'collection']) {
  test(`config rejection during ${boundary} prevents observation and error-health writes`, async () => {
    let h;
    const rejectConfig = async () => assert.rejects(h.configure('company-a', {
      repositories: [{ repo: 'owner/repo', projectId: 'missing-project' }],
    }), /invalid-config/);
    h = await harness({
      pressure: async () => { if (boundary === 'pressure') await rejectConfig(); return healthy(); },
      collect: async () => { if (boundary === 'collection') await rejectConfig(); return snapshot({ issues: [issue()] }); },
    });
    if (boundary === 'ledger read') h.ctx.state.get = async () => { await rejectConfig(); return null; };
    await h.configure('company-a', rawConfig());
    await assert.rejects(h.handlers.get('backlogFloor')(job('backlogFloor')), /work-supply-job-failed/);
    assert.equal(h.calls.writes, 0);
    assert.equal((await h.plugin.onHealth()).details.firings[0].code, 'invalid-config');
  });
}
for (const scenario of [
  { expected: 'invalid-config', error: 'sensitive-config-store-error', update: async h => assert.rejects(h.configure('company-a', {
    repositories: [{ repo: 'owner/repo', projectId: 'missing-project' }],
  }), /invalid-config/) },
  { expected: 'config-changed', error: 'sensitive-config-store-error', update: async h => h.configure('company-a', {}) },
  { expected: 'shadow-dependency-failed', error: 'sensitive-config-store-error', update: async () => {} },
  { expected: 'shadow-dependency-failed', error: 'invalid-config', update: async () => {} },
  { expected: 'shadow-dependency-failed', error: 'config-changed', update: async () => {} },
]) {
  test(`failed persisted config read reports ${scenario.expected} for ${scenario.error}`, async () => {
    const h = await harness();
    await h.configure('company-a', {});
    h.ctx.config.get = async () => {
      await scenario.update(h);
      throw new Error(scenario.error);
    };
    await assert.rejects(h.handlers.get('backlogFloor')(job('backlogFloor')), /work-supply-job-failed/);
    assert.equal((await h.plugin.onHealth()).details.firings[0].code, scenario.expected);
    assert.ok(!JSON.stringify(h.logs).includes('sensitive-config-store-error'));
  });
}
test('config rejection after a write dispatch cannot report successful completion or compensate the write', async () => {
  const h = await harness({ collect: () => snapshot({ issues: [issue()] }), pressure: () => healthy() });
  const set = h.ctx.state.set;
  h.ctx.state.set = async (key, ledger) => {
    await assert.rejects(h.configure('company-a', { repositories: [{ repo: 'owner/repo', projectId: 'missing-project' }] }));
    return set(key, ledger);
  };
  await h.configure('company-a', rawConfig());
  await assert.rejects(h.handlers.get('backlogFloor')(job('backlogFloor')), /work-supply-job-failed/);
  assert.equal(h.calls.writes, 1);
  assert.equal((await h.plugin.onHealth()).details.firings[0].code, 'invalid-config');
  assert.equal(h.logs.filter(([message]) => message === 'work-supply: shadow firing').length, 0);
});
test('a newer valid notification cancels an old firing and the next firing uses saved config', async () => {
  let h;
  h = await harness({ pressure: () => healthy(), collect: async () => {
    await h.configure('company-a', {}); return snapshot({ issues: [issue()] });
  } });
  await h.configure('company-a', rawConfig());
  await assert.rejects(h.handlers.get('backlogFloor')(job('backlogFloor')), /work-supply-job-failed/);
  assert.equal(h.calls.writes, 0);
  assert.equal((await h.plugin.onHealth()).details.firings[0].code, 'config-changed');
  await h.handlers.get('backlogFloor')(job('backlogFloor'));
  assert.equal((await h.plugin.onHealth()).details.firings[0].status, 'paused');
});
test('stored config is validated and can recover even when notifications were dropped', async () => {
  const h = await harness({ collect: () => { throw new Error('should not collect'); } });
  await h.configure('company-a', {});
  h.configs.set('company-a', { repositories: [{ repo: 'owner/repo', projectId: 'missing-project' }] });
  await assert.rejects(h.handlers.get('idleWake')(job('idleWake')), /work-supply-job-failed/);
  assert.deepEqual((await h.plugin.onHealth()).details.configErrors, [{ companyId: 'company-a', code: 'invalid-config' }]);
  h.configs.set('company-a', {});
  await h.handlers.get('idleWake')(job('idleWake'));
  const health = await h.plugin.onHealth();
  assert.equal(health.status, 'ok');
  assert.deepEqual(health.details.configErrors, []);
});
test('validation-only and invalid host context cannot enroll or poison a company', async () => {
  const h = await harness({ collect: () => snapshot() });
  await h.configure('company-a', {});
  assert.deepEqual(await h.plugin.onValidateConfig({ repositories: [{ repo: 'owner/repo', projectId: 'missing-project' }] }),
    { ok: false, errors: ['invalid-shadow-config'] });
  await assert.rejects(h.plugin.onConfigChanged({ pause: false }, {}), /company-context-required/);
  const health = await h.plugin.onHealth();
  assert.equal(health.status, 'ok');
  assert.equal(health.details.configuredCompanies, 1);
  assert.deepEqual(health.details.configErrors, []);
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
