import test from 'node:test';
import assert from 'node:assert/strict';
import { ShadowRunner } from '../src/shadow.mjs';
import { SupplyError } from '../src/policy.mjs';
import { NOW, config, issue, snapshot, memoryStore, pr } from './fixtures.mjs';

function setup(data = snapshot({ issues: [issue()] }), settings = config()) {
  const store = memoryStore();
  let time = NOW, collections = 0;
  const runner = new ShadowRunner({ store, clock: () => time, collect: async () => {
    collections++; return { ...structuredClone(data), capturedAt: time };
  } });
  return { store, runner, settings, collections: () => collections, setTime: t => { time = t; } };
}

test('pause does no collection, ledger read or ledger write', async () => {
  const h = setup(undefined, config({ pause: true }));
  assert.deepEqual(await h.runner.run('backlogFloor', h.settings), { status: 'paused', observed: 0 });
  assert.equal(h.collections(), 0);
  assert.deepEqual(h.store.reads, []);
  assert.deepEqual(h.store.writes, []);
});

test('shadow records proposals and health without a core mutation surface', async () => {
  const h = setup();
  const result = await h.runner.run('backlogFloor', h.settings);
  assert.equal(result.status, 'shadow');
  assert.equal(result.observed, 1);
  assert.equal(h.store.values.get('company-a').entries[0].action.kind, 'promote_issue');
  assert.deepEqual(h.store.values.get('company-a').health.backlogFloor,
    { status: 'shadow', at: NOW, candidates: 1, observed: 1, capped: false });
  assert.equal(Object.hasOwn(h.runner, 'apply'), false);
});

test('replay is suppressed after constructing a new runner on the same persisted ledger', async () => {
  const h = setup();
  await h.runner.run('backlogFloor', h.settings);
  const fresh = new ShadowRunner({ store: h.store, clock: () => NOW,
    collect: async () => snapshot({ issues: [issue()] }) });
  assert.equal((await fresh.run('backlogFloor', h.settings)).observed, 0);
  assert.equal(h.store.values.get('company-a').observations.length, 1);
});

test('six-hour cooldown boundary is exact and does not invent new keys', async () => {
  const h = setup();
  await h.runner.run('backlogFloor', h.settings);
  h.setTime(NOW + h.settings.cooldownMs - 1);
  assert.equal((await h.runner.run('backlogFloor', h.settings)).observed, 0);
  h.setTime(NOW + h.settings.cooldownMs);
  assert.equal((await h.runner.run('backlogFloor', h.settings)).observed, 1);
  assert.equal(h.store.values.get('company-a').entries.length, 1);
  assert.equal(h.store.values.get('company-a').entries[0].firstSeenAt, NOW);
});

test('per-run and rolling-hour caps are separate; rejected surplus is not entered in ledger', async () => {
  const settings = config({ cooldownMs: 1 });
  settings.caps.backlogFloor = { perRun: 2, perHour: 3 };
  const h = setup(snapshot({ issues: [issue('a'), issue('b'), issue('c'), issue('d')] }), settings);
  assert.equal((await h.runner.run('backlogFloor', settings)).observed, 2);
  assert.equal(h.store.values.get('company-a').entries.length, 2);
  h.setTime(NOW + 1);
  assert.equal((await h.runner.run('backlogFloor', settings)).observed, 1);
  h.setTime(NOW + 2);
  assert.equal((await h.runner.run('backlogFloor', settings)).observed, 0);
  h.setTime(NOW + 3_600_000);
  assert.equal((await h.runner.run('backlogFloor', settings)).observed, 2);
});

test('zero cap prevents recording even with candidates', async () => {
  const settings = config(); settings.caps.backlogFloor = { perRun: 0, perHour: 0 };
  const h = setup(undefined, settings);
  assert.equal((await h.runner.run('backlogFloor', settings)).observed, 0);
  assert.equal(h.store.values.get('company-a').entries.length, 0);
  assert.equal(h.store.values.get('company-a').health.backlogFloor.capped, true);
});

test('review/supply share duplicate suppression across job keys', async () => {
  const h = setup(snapshot({ issues: [issue('owner', { status: 'todo', prState: 'open', pullRequestIds: ['pr-a'] })], prs: [pr()] }));
  assert.equal((await h.runner.run('prSupply', h.settings)).observed, 1);
  assert.equal((await h.runner.run('reviewReconcile', h.settings)).observed, 0);
  assert.equal(h.store.values.get('company-a').health.reviewReconcile.capped, false);
});

test('overlapping jobs for a company are fenced before collection or state I/O', async () => {
  const store = memoryStore();
  let release;
  const collection = new Promise(resolve => { release = resolve; });
  const runner = new ShadowRunner({ store, clock: () => NOW, collect: () => collection });
  const first = runner.run('backlogFloor', config());
  assert.deepEqual(await runner.run('idleWake', config()), { status: 'busy', observed: 0 });
  release(snapshot({ issues: [issue()] }));
  assert.equal((await first).observed, 1);
  assert.equal(store.reads.length, 1);
});

test('cross-company data or ledger is refused, not adopted or rewritten', async () => {
  const h = setup(snapshot({ companyId: 'company-b' }));
  await assert.rejects(h.runner.run('backlogFloor', h.settings), { code: 'invalid-snapshot' });
  assert.equal(h.store.values.get('company-a').entries.length, 0);
  h.store.values.set('company-a', { version: 1, companyId: 'company-b', entries: [], observations: [], health: {} });
  h.store.writes.length = 0;
  await assert.rejects(h.runner.run('backlogFloor', h.settings), { code: 'invalid-ledger' });
  assert.equal(h.store.writes.length, 0);
});

test('corrupt ledger and clock fail loudly without rewriting corrupt state', async () => {
  const h = setup();
  h.store.values.set('company-a', { version: 1, companyId: 'company-a', entries: [], observations: [], health: null });
  await assert.rejects(h.runner.run('backlogFloor', h.settings), { code: 'invalid-ledger' });
  assert.equal(h.store.writes.length, 0);
  h.setTime(NaN);
  await assert.rejects(h.runner.run('backlogFloor', h.settings), { code: 'invalid-time' });
});

test('ledger saturation fails closed; it does not evict dedupe records', async () => {
  const h = setup(snapshot({ issues: [issue('a'), issue('b')] }), config({ maxLedgerEntries: 1 }));
  await assert.rejects(h.runner.run('backlogFloor', h.settings), { code: 'ledger-full' });
  assert.equal(h.store.values.get('company-a').entries.length, 0);
  assert.equal(h.store.values.get('company-a').health.backlogFloor.code, 'ledger-full');
});

test('collector failures are visible, redacted and release the in-process fence', async () => {
  const store = memoryStore(); let calls = 0;
  const runner = new ShadowRunner({ store, clock: () => NOW, collect: async () => {
    if (!calls++) throw new Error('sensitive upstream response text');
    return snapshot({ issues: [issue()] });
  } });
  await assert.rejects(runner.run('backlogFloor', config()), { code: 'shadow-dependency-failed' });
  assert.equal(JSON.stringify(store.values.get('company-a')).includes('sensitive'), false);
  assert.equal(store.values.get('company-a').health.backlogFloor.status, 'error');
  assert.equal((await runner.run('backlogFloor', config())).observed, 1);
});

test('ledger write failure is not returned as success and cannot mutate the last stored value', async () => {
  const h = setup();
  await h.runner.run('backlogFloor', h.settings);
  const stored = structuredClone(h.store.values.get('company-a'));
  h.store.set = async () => { throw new Error('store unavailable'); };
  h.setTime(NOW + h.settings.cooldownMs);
  await assert.rejects(h.runner.run('backlogFloor', h.settings), { code: 'shadow-dependency-failed' });
  assert.deepEqual(h.store.values.get('company-a'), stored);
});

test('configuration is captured before collection and cannot redirect writes or the fence', async () => {
  const store = memoryStore();
  const other = setup(snapshot({ companyId: 'company-b', agents: [] }), config({ companyId: 'company-b' }));
  await other.runner.run('idleWake', other.settings);
  const otherLedger = structuredClone(other.store.values.get('company-b'));
  store.values.set('company-b', otherLedger);
  let release, entered;
  const collected = new Promise(resolve => { entered = resolve; });
  const runner = new ShadowRunner({ store, clock: () => NOW, collect: async () => {
    entered();
    return new Promise(resolve => { release = resolve; });
  } });
  const settings = config();
  const first = runner.run('backlogFloor', settings);
  await collected;
  settings.companyId = 'company-b';
  settings.projects[0].admitted = false;
  settings.caps.backlogFloor.perRun = 0;
  release(snapshot({ issues: [issue()] }));
  assert.equal((await first).observed, 1);
  assert.deepEqual(store.values.get('company-b'), otherLedger);
  runner.collect = async () => snapshot();
  assert.equal((await runner.run('idleWake', config())).status, 'shadow');
  assert.deepEqual(store.writes, ['company-a', 'company-a']);
});

test('configuration changes cannot redirect error-health persistence either', async () => {
  const store = memoryStore();
  let reject, entered;
  const collected = new Promise(resolve => { entered = resolve; });
  const runner = new ShadowRunner({ store, clock: () => NOW, collect: () => {
    entered();
    return new Promise((_, fail) => { reject = fail; });
  } });
  const settings = config();
  const first = runner.run('idleWake', settings);
  await collected;
  settings.companyId = 'company-b';
  reject(new Error('unavailable'));
  await assert.rejects(first, { code: 'shadow-dependency-failed' });
  assert.deepEqual(store.writes, ['company-a']);
  assert.equal(store.values.has('company-b'), false);
  runner.collect = async () => snapshot();
  assert.equal((await runner.run('idleWake', config())).status, 'shadow');
});

test('a throwing first clock is redacted and never strands the company fence', async () => {
  const store = memoryStore(); let calls = 0;
  const runner = new ShadowRunner({ store, collect: async () => snapshot(), clock: () => {
    if (!calls++) throw new Error('synthetic-sensitive-clock-value');
    return NOW;
  } });
  await assert.rejects(runner.run('idleWake', config()), { code: 'shadow-dependency-failed' });
  assert.equal(store.writes.length, 0);
  assert.equal((await runner.run('idleWake', config())).status, 'shadow');
});

test('an ambiguous committed write is not overwritten and still consumes cooldown and cap', async () => {
  const settings = config(); settings.caps.backlogFloor = { perRun: 1, perHour: 1 };
  const h = setup(undefined, settings);
  const persist = h.store.set;
  let calls = 0;
  h.store.set = async (...args) => {
    await persist(...args);
    if (!calls++) throw new Error('acknowledgement lost');
  };
  await assert.rejects(h.runner.run('backlogFloor', settings), { code: 'shadow-dependency-failed' });
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.values.get('company-a').observations.length, 1);
  assert.equal((await h.runner.run('backlogFloor', settings)).observed, 0);
  assert.equal(h.store.values.get('company-a').observations.length, 1);
  h.setTime(NOW + 1);
  h.runner.collect = async () => snapshot({ capturedAt: NOW + 1, issues: [issue('new-intent')] });
  assert.equal((await h.runner.run('backlogFloor', settings)).observed, 0);
});

for (const boundary of ['get', 'collect', 'clock', 'set']) {
  test(`dependency SupplyError is redacted at the ${boundary} boundary`, async () => {
    const h = setup();
    const fail = () => { throw new SupplyError('token=synthetic-sensitive-data'); };
    if (['get', 'set'].includes(boundary)) h.store[boundary] = fail;
    else h.runner[boundary] = fail;
    await assert.rejects(h.runner.run('backlogFloor', h.settings), { code: 'shadow-dependency-failed' });
    assert.equal(JSON.stringify([...h.store.values]).includes('synthetic-sensitive-data'), false);
  });
}

for (const [name, change] of [
  ['changed action payload', ledger => { ledger.entries[0].action.issueId = 'other-issue'; }],
  ['unknown action field', ledger => { ledger.entries[0].action.body = 'synthetic-sensitive-data'; }],
  ['invalid action schema', ledger => { delete ledger.entries[0].action.expectedUpdatedAt; }],
  ['raw health body', ledger => { ledger.health.backlogFloor.body = 'synthetic-sensitive-data'; }],
  ['unbounded health code', ledger => { ledger.health.backlogFloor = { status: 'error', at: NOW, code: 'synthetic-sensitive-data' }; }],
  ['invalid health count', ledger => { ledger.health.backlogFloor.observed = -1; }],
  ['unknown health job', ledger => { ledger.health.unknown = ledger.health.backlogFloor; }],
  ['raw root field', ledger => { ledger.body = 'synthetic-sensitive-data'; }],
  ['raw entry field', ledger => { ledger.entries[0].body = 'synthetic-sensitive-data'; }],
  ['raw observation field', ledger => { ledger.observations[0].body = 'synthetic-sensitive-data'; }],
  ['observation attributed to the wrong job', ledger => { ledger.observations[0].job = 'idleWake'; }],
  ['missing recent observation', ledger => { ledger.observations = []; }],
]) {
  test(`persisted ledger rejects ${name} without rewriting it`, async () => {
    const h = setup();
    await h.runner.run('backlogFloor', h.settings);
    change(h.store.values.get('company-a'));
    const corrupt = structuredClone(h.store.values.get('company-a'));
    h.store.writes.length = 0;
    await assert.rejects(h.runner.run('idleWake', h.settings), { code: 'invalid-ledger' });
    assert.deepEqual(h.store.values.get('company-a'), corrupt);
    assert.equal(h.store.writes.length, 0);
  });
}

test('returned proposals cannot mutate a caching store or a later durable ledger write', async () => {
  const h = setup(); const cache = new Map();
  const persist = h.store.set;
  h.store.get = async companyId => cache.get(companyId) ?? null;
  h.store.set = async (companyId, value) => {
    cache.set(companyId, value);
    await persist(companyId, value);
  };
  const result = await h.runner.run('backlogFloor', h.settings);
  result.actions[0].issueId = 'changed-by-caller';
  assert.equal(cache.get('company-a').entries[0].action.issueId, 'issue-a');
  await h.runner.run('idleWake', h.settings);
  assert.equal(h.store.values.get('company-a').entries[0].action.issueId, 'issue-a');
});

for (const job of ['idleWake', 'prSupply']) {
  test(`${job} observes a changed issue version within the previous intent cooldown`, async () => {
    const data = snapshot({ issues: [issue('owner', { status: 'todo', prState: 'open', pullRequestIds: ['pr-a'] })], prs: [pr()] });
    const h = setup(data);
    assert.equal((await h.runner.run(job, h.settings)).observed, 1);
    data.issues[0].updatedAt++;
    assert.equal((await h.runner.run(job, h.settings)).observed, 1);
    assert.equal(h.store.values.get('company-a').entries.length, 2);
  });
}

test('an undefined store result is corrupt state, not an empty ledger', async () => {
  const h = setup(); h.store.get = async () => undefined;
  await assert.rejects(h.runner.run('idleWake', h.settings), { code: 'invalid-ledger' });
  assert.equal(h.store.writes.length, 0);
});

for (const [job, data] of [
  ['prSupply', snapshot({ prs: [pr()] })],
  ['backlogFloor', snapshot({ issues: [issue()] })],
  ['idleWake', snapshot({ issues: [issue('ready', { status: 'todo' })] })],
  ['reviewReconcile', snapshot({ issues: [issue('owner', { status: 'todo', pullRequestIds: ['pr-a'] })], prs: [pr()] })],
  ['intentSweep', snapshot({ intents: [{ id: 'intent-a', companyId: 'company-a', issueId: 'issue-a', status: 'pending' }] })],
]) {
  test(`${job} persists a schema-valid ledger that replays without another observation`, async () => {
    const h = setup(data);
    assert.equal((await h.runner.run(job, h.settings)).observed, 1);
    const fresh = new ShadowRunner({ store: h.store, clock: () => NOW, collect: async () => data });
    assert.equal((await fresh.run(job, h.settings)).observed, 0);
    assert.equal(h.store.values.get('company-a').observations.length, 1);
  });
}

test('each company has an independent fence and ledger namespace', async () => {
  const store = memoryStore();
  const runner = new ShadowRunner({ store, clock: () => NOW, collect: async (_, companyId) => snapshot({ companyId,
    agents: [], issues: [], prs: [], intents: [] }) });
  await Promise.all([runner.run('idleWake', config()), runner.run('idleWake', config({ companyId: 'company-b' }))]);
  assert.equal(store.values.get('company-a').companyId, 'company-a');
  assert.equal(store.values.get('company-b').companyId, 'company-b');
});
