import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, chmod, stat, readdir, mkdir, rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { receiptNamespace } from '../src/receipt-cycle.js'
import { freshHealth, beginFiring, finishFiring, healthFinding, freshAlertState, alertDecision,
  MISSED_AFTER_MS, ALERT_RETRY_MS, KEY_LIFETIME_MS } from '../src/runtime-health.js'
import { loadRuntimeManifest, initializeRuntime, runRuntime, watchRuntime, invokeAlertHook, main } from '../src/runtime-cli.js'
import { privateJson, saveHealthFile } from '../src/runtime-files.js'

const namespace = 'a'.repeat(64)
const epoch = 1000000
const window = { namespace, issuedMs: epoch, expiresMs: epoch + KEY_LIFETIME_MS }
const healthy = { ok: true, requests: 2, events: { completed: 0, deferred: 0, failures: [] },
  sweeps: { processed: 0, deferred: 0, failures: [] } }

test('fixed clock: exactly two missed 60-second firings plus grace, including never-started timer', () => {
  for (const state of [freshHealth(namespace, epoch), finishFiring(beginFiring(freshHealth(namespace, epoch), epoch), epoch + 10, healthy)]) {
    assert.equal(healthFinding(state, { ...window, now: epoch + MISSED_AFTER_MS - 1 }).key, null)
    assert.equal(healthFinding(state, { ...window, now: epoch + MISSED_AFTER_MS }).key, 'two-missed-firings')
  }
})

test('healthy, partial, failed, running and stalled cycles have distinct evidence', () => {
  const running = beginFiring(freshHealth(namespace, epoch), epoch)
  assert.equal(healthFinding(running, { ...window, now: epoch + 54999 }).key, null)
  assert.equal(healthFinding(running, { ...window, now: epoch + 55000 }).key, 'firing-stalled')
  const good = finishFiring(running, epoch + 10, healthy)
  assert.equal(good.outcome, 'healthy')
  assert.equal(good.lastHealthyMs, epoch + 10)
  const partial = finishFiring(beginFiring(good, epoch + 60000), epoch + 60010,
    { ...healthy, ok: false, reason: 'sweeps-incomplete', sweeps: { processed: 1, deferred: 3, failures: [] } })
  assert.equal(partial.outcome, 'partial')
  assert.equal(partial.summary.deferred, 3)
  assert.equal(partial.lastHealthyMs, epoch + 10)
  assert.equal(healthFinding(partial, { ...window, now: epoch + 60011 }).key, 'cycle-partial')
  const failed = finishFiring(running, epoch + 10, { ok: false, reason: 'request-budget', provider: 'SECRET' })
  assert.equal(failed.outcome, 'failed')
  assert.equal(healthFinding(failed, { ...window, now: epoch + 11 }).key, 'cycle-failed')
  assert.equal(JSON.stringify(failed).includes('SECRET'), false)
})

test('missing, corrupt, wrong-scope and future health cannot produce a false green', () => {
  for (const state of [null, {}, { ...freshHealth(namespace, epoch), namespace: 'b'.repeat(64) }]) {
    assert.equal(healthFinding(state, { ...window, now: epoch }).key, 'health-state-invalid')
  }
  assert.equal(healthFinding(freshHealth(namespace, epoch + 1), { ...window, now: epoch }).key, 'clock-or-state-invalid')
  assert.throws(() => beginFiring(freshHealth(namespace, epoch), epoch - 1))
})

test('key metadata enforces at most 30 days and warns three days before expiry', () => {
  const state = freshHealth(namespace, epoch)
  assert.throws(() => healthFinding(state, { ...window, now: epoch, expiresMs: window.expiresMs + 1 }))
  const started = beginFiring(state, window.expiresMs - 3 * 86400000)
  assert.equal(healthFinding(started, { ...window, now: started.lastStartMs }).key, 'key-expiring')
  assert.ok(healthFinding(state, { ...window, now: window.expiresMs }).reasons.includes('key-expired'))
})

test('alert decisions suppress chatter, retry ambiguous delivery with stable ID, and reset on recovery', () => {
  const finding = { key: 'two-missed-firings', reasons: ['two-missed-firings'] }
  const first = alertDecision(freshAlertState(namespace), finding, epoch)
  assert.equal(first.send, true)
  assert.equal(alertDecision(first.state, finding, epoch + ALERT_RETRY_MS - 1).send, false)
  const retry = alertDecision(first.state, finding, epoch + ALERT_RETRY_MS)
  assert.equal(retry.send, true)
  assert.equal(retry.state.incident.id, first.state.incident.id)
  retry.state.incident.sent = true
  assert.equal(alertDecision(retry.state, finding, epoch + 100 * ALERT_RETRY_MS).send, false)
  const recovered = alertDecision(retry.state, { key: null }, epoch + 100 * ALERT_RETRY_MS)
  assert.equal(recovered.send, false)
  assert.equal(recovered.state.incident, null)
  assert.notEqual(alertDecision(recovered.state, finding, epoch + 101 * ALERT_RETRY_MS).state.incident.id, first.state.incident.id)
})

async function harness(t) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'runtime-health-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { version: 1, mode: 'products-only-v1', captureOrigin: 'https://capture.test', boardOrigin: 'https://board.test',
    companyId: '12345678-1234-4234-8234-123456789abc', allowedRepositories: ['ExampleOrg/example-repo'],
    stateDirectory: join(root, 'state'), captureTokenFile: join(root, 'capture.key'), boardTokenFile: join(root, 'board.key'), limits: {} }
  await writeFile(config.captureTokenFile, 'private-capture-test', { mode: 0o600 })
  await writeFile(config.boardTokenFile, 'private-board-test', { mode: 0o600 })
  const consumerConfigFile = join(root, 'consumer.json')
  await writeFile(consumerConfigFile, JSON.stringify(config), { mode: 0o600 })
  await mkdir(join(root, 'bin'), { mode: 0o700 })
  await writeFile(join(root, 'bin', 'gh'), '#!/bin/sh\nexit 77\n', { mode: 0o700 })
  const alertHookFile = join(root, 'hook')
  await writeFile(alertHookFile, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const manifest = { version: 1, consumerConfigFile, stateDirectory: config.stateDirectory,
    namespace: receiptNamespace(config), alertHookFile, boardKeyIssuedMs: epoch, boardKeyExpiresMs: epoch + KEY_LIFETIME_MS }
  const manifestPath = join(root, 'runtime.json')
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
  await initializeRuntime(manifest, { now: () => epoch })
  return { root, config, manifest, manifestPath, directory: join(config.stateDirectory, 'health') }
}

test('runtime revalidates the pinned gh wrapper on every firing before invoking a pass', async (t) => {
  const h = await harness(t)
  const wrapper = join(h.root, 'bin', 'gh')
  let calls = 0
  const run = async input => { calls++; assert.equal(input.githubExecutable, wrapper); return healthy }
  assert.equal((await runRuntime(h.manifest, { now: () => epoch + 1, run })).ok, true)
  assert.equal(calls, 1)
  await chmod(wrapper, 0o755)
  assert.equal((await runRuntime(h.manifest, { now: () => epoch + 2, run })).ok, false)
  await rm(wrapper)
  assert.equal((await runRuntime(h.manifest, { now: () => epoch + 3, run })).ok, false)
  await symlink(h.manifest.alertHookFile, wrapper)
  assert.equal((await runRuntime(h.manifest, { now: () => epoch + 4, run })).ok, false)
  assert.equal(calls, 1, 'unsafe or absent wrapper must never reach transport')
})

test('runtime refuses JWT-shaped capture credentials before any pass effect', async (t) => {
  const h = await harness(t)
  await writeFile(h.config.captureTokenFile, 'eyJ.capture.signature')
  let calls = 0
  const result = await runRuntime(h.manifest, { now: () => epoch + 1, run: async () => { calls++; return healthy } })
  assert.equal(result.ok, false)
  assert.equal(calls, 0)
  assert.equal((await privateJson(join(h.directory, 'health.json'))).outcome, 'failed')
})

test('init is idempotent and preserves an old firing clock; private files remain bounded', async (t) => {
  const h = await harness(t)
  assert.equal((await loadRuntimeManifest(h.manifestPath)).namespace, h.manifest.namespace)
  const state = await initializeRuntime(h.manifest, { now: () => epoch + 1000 })
  assert.equal(state.activatedMs, epoch)
  assert.equal((await stat(join(h.directory, 'health.json'))).mode & 0o777, 0o600)
  await chmod(h.manifestPath, 0o644)
  await assert.rejects(loadRuntimeManifest(h.manifestPath), /unsafe runtime/)
})

test('watcher detects an unfired main timer without consumer config or credentials and suppresses repeats', async (t) => {
  const h = await harness(t)
  await rm(h.manifest.consumerConfigFile)
  await rm(h.config.captureTokenFile)
  await rm(h.config.boardTokenFile)
  const alerts = []
  const watch = time => watchRuntime(h.manifest, { now: () => time, send: async (file, payload) => alerts.push(payload) })
  assert.equal((await watch(epoch + MISSED_AFTER_MS - 1)).sent, false)
  assert.equal((await watch(epoch + MISSED_AFTER_MS)).sent, true)
  assert.equal((await watch(epoch + MISSED_AFTER_MS * 2)).sent, false)
  assert.equal(alerts.length, 1)
  assert.deepEqual(alerts[0].reasons, ['two-missed-firings'])
  assert.equal(alerts[0].service, 'gh-product-bridge')
  assert.equal(JSON.stringify(alerts).includes('private-'), false)
})

test('watcher can inspect a running pass; main overlap fails without overwriting firing evidence', async (t) => {
  const h = await harness(t)
  let enter, release
  const started = new Promise(resolve => { enter = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const pass = runRuntime(h.manifest, { now: () => epoch + 1000, run: async () => { enter(); await pending; return healthy } })
  await started
  await assert.rejects(runRuntime(h.manifest, { now: () => epoch + 2000 }), { code: 'EEXIST' })
  assert.equal((await privateJson(join(h.directory, 'health.json'))).lastStartMs, epoch + 1000)
  let findings = 0
  await watchRuntime(h.manifest, { now: () => epoch + 56000, send: async () => { findings++ } })
  assert.equal(findings, 1)
  release()
  assert.equal((await pass).ok, true)
  assert.equal((await watchRuntime(h.manifest, { now: () => epoch + 56001, send: async () => assert.fail('healthy chatter') })).sent, false)
  assert.equal((await readdir(h.directory)).some(name => name.endsWith('.lock')), false)
})

test('lost alert response retries the same incident after cooldown, never acknowledges failure', async (t) => {
  const h = await harness(t)
  const ids = []
  const now = epoch + MISSED_AFTER_MS
  await assert.rejects(watchRuntime(h.manifest, { now: () => now, send: async (file, payload) => {
    ids.push(payload.incidentId); throw new Error('response lost')
  } }), /response lost/)
  assert.equal((await privateJson(join(h.directory, 'alert.json'))).incident.sent, false)
  await watchRuntime(h.manifest, { now: () => now + 1, send: async () => assert.fail('retry too soon') })
  await watchRuntime(h.manifest, { now: () => now + ALERT_RETRY_MS, send: async (file, payload) => ids.push(payload.incidentId) })
  assert.equal(ids.length, 2)
  assert.equal(ids[0], ids[1])
  assert.equal((await privateJson(join(h.directory, 'alert.json'))).incident.sent, true)
})

test('runtime refuses run JWTs and expired keys, persists failure, and never invokes the pass', async (t) => {
  for (const jwt of [true, false]) {
    const h = await harness(t)
    if (jwt) await writeFile(h.config.boardTokenFile, 'eyJ.test.signature')
    let calls = 0
    const result = await runRuntime(h.manifest, { now: () => jwt ? epoch + 1 : h.manifest.boardKeyExpiresMs,
      run: async () => { calls++; return healthy } })
    assert.equal(calls, 0)
    assert.equal(result.outcome, 'failed')
    assert.equal((await privateJson(join(h.directory, 'health.json'))).outcome, 'failed')
  }
})

test('corrupt health alerts rather than resetting; corrupt dedup fails closed', async (t) => {
  const h = await harness(t)
  await writeFile(join(h.directory, 'health.json'), '{')
  await assert.rejects(initializeRuntime(h.manifest, { now: () => epoch }))
  const sent = []
  await watchRuntime(h.manifest, { now: () => epoch, send: async (file, payload) => sent.push(payload) })
  assert.deepEqual(sent[0].reasons, ['health-state-invalid'])
  await writeFile(join(h.directory, 'alert.json'), '{')
  await assert.rejects(watchRuntime(h.manifest, { now: () => epoch, send: async () => assert.fail('dedup reset') }))
})

test('native alert hook gets payload only on stdin and no inherited run/provider credentials', async (t) => {
  const h = await harness(t)
  const output = join(h.root, 'hook-input.json')
  await writeFile(h.manifest.alertHookFile, `#!/usr/bin/env node\nlet data = ''; process.stdin.on('data', s => data += s); process.stdin.on('end', () => {
    if (process.argv.length !== 2 || process.env.PAPERCLIP_API_KEY || process.env.TEST_RUNTIME_SECRET) process.exit(3);
    require('node:fs').writeFileSync(${JSON.stringify(output)}, data, {mode: 0o600});
  });\n`, { mode: 0o700 })
  const prior = process.env.TEST_RUNTIME_SECRET
  process.env.TEST_RUNTIME_SECRET = 'do-not-inherit'
  try {
    const payload = { version: 1, service: 'gh-product-bridge', reasons: ['two-missed-firings'] }
    await invokeAlertHook(h.manifest.alertHookFile, payload)
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), payload)
    await writeFile(h.manifest.alertHookFile, '#!/bin/sh\nexit 9\n')
    await assert.rejects(invokeAlertHook(h.manifest.alertHookFile, payload), /did not confirm/)
  } finally {
    if (prior === undefined) delete process.env.TEST_RUNTIME_SECRET
    else process.env.TEST_RUNTIME_SECRET = prior
  }
})

test('running is not recovery and cannot cause repeated failure alerts', async (t) => {
  const h = await harness(t)
  let count = 0
  const send = async () => { count++ }
  const failed = finishFiring(beginFiring(freshHealth(h.manifest.namespace, epoch), epoch), epoch + 1, { ok: false })
  await saveHealthFile(h.directory, 'health.json', failed)
  await watchRuntime(h.manifest, { now: () => epoch + 2, send })
  const running = beginFiring(failed, epoch + 60000)
  await saveHealthFile(h.directory, 'health.json', running)
  await watchRuntime(h.manifest, { now: () => epoch + 60001, send })
  await saveHealthFile(h.directory, 'health.json', finishFiring(running, epoch + 60002, { ok: false }))
  await watchRuntime(h.manifest, { now: () => epoch + 60003, send })
  assert.equal(count, 1)
})

test('JSON null health is corrupt and init cannot reset its firing baseline', async (t) => {
  const h = await harness(t)
  await writeFile(join(h.directory, 'health.json'), 'null')
  await assert.rejects(initializeRuntime(h.manifest, { now: () => epoch }))
  assert.equal(await readFile(join(h.directory, 'health.json'), 'utf8'), 'null')
})

test('alert incident and attempt are durable before the hook; post-send failure retains the same ID', async (t) => {
  const h = await harness(t)
  const path = join(h.directory, 'alert.json')
  const backup = join(h.directory, 'alert-backup.json')
  let first
  await assert.rejects(watchRuntime(h.manifest, { now: () => epoch + MISSED_AFTER_MS, send: async (file, payload) => {
    first = payload.incidentId
    const saved = await privateJson(path)
    assert.equal(saved.incident.id, first)
    assert.equal(saved.incident.attemptMs, epoch + MISSED_AFTER_MS)
    assert.equal(saved.incident.sent, false)
    await rename(path, backup)
    await mkdir(path, { mode: 0o700 }) // Fail the post-effect atomic rename.
  } }))
  await rm(path, { recursive: true })
  await rename(backup, path)
  await watchRuntime(h.manifest, { now: () => epoch + MISSED_AFTER_MS + ALERT_RETRY_MS, send: async (file, payload) => {
    assert.equal(payload.incidentId, first)
  } })
  assert.equal((await privateJson(path)).incident.sent, true)
  assert.equal((await readdir(h.directory)).some(name => name.endsWith('.tmp')), false)
})

test('unsafe dedup storage stops before any alert side effect', async (t) => {
  const h = await harness(t)
  await mkdir(join(h.directory, 'alert.json'), { mode: 0o700 })
  await assert.rejects(watchRuntime(h.manifest, { now: () => epoch + MISSED_AFTER_MS,
    send: async () => assert.fail('effect before durable alert state') }))
})

test('CLI refuses unsupported modes and redacts configuration errors', async () => {
  const logs = []
  const io = { out: line => logs.push(line), error: line => logs.push(line) }
  assert.equal(await main(['full-v1', '/private/SECRET'], io), 2)
  assert.equal(await main(['run', '/private/SECRET'], io), 2)
  assert.equal(logs.join().includes('SECRET'), false)
})
