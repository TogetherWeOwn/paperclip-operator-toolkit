import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, chmod, rm, utimes } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { receiptNamespace } from '../src/receipt-cycle.js'
import { decideCheckin, isAcceptablePingUrl, CONSUMER_FRESH_MS, WATCHER_FRESH_MS } from '../scripts/healthchecks-checkin.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const checkinSource = join(repoRoot, 'scripts', 'healthchecks-checkin.mjs')

function stubHealthchecks(t, statuses = [200]) {
  const hits = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body })
      res.writeHead(statuses[Math.min(hits.length - 1, statuses.length - 1)], { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close())
      resolve({ hits, port: server.address().port })
    })
  })
}

// Mirror production: the check-in lives at $RELEASE/gh-event-capture and reads
// the manifest at $SECURE/runtime.json plus the bare ping URL beside it at
// $SECURE/healthchecks-ping.key (0600). The timer tick gets no credentials.
async function harness(t, { healthAt = 0, alertAgeMs = 0, pingUrl, keyMode = 0o600, corruptHealth = false, dropAlert = false } = {}) {
  const home = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'hc-checkin-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const { mkdir } = await import('node:fs/promises')
  const secure = join(home, 'credential-drop', 'gh-product-bridge')
  await mkdir(secure, { recursive: true })
  const config = { version: 1, mode: 'products-only-v1', captureOrigin: 'https://capture.test', boardOrigin: 'https://board.test',
    companyId: '12345678-1234-4234-8234-123456789abc', allowedRepositories: ['ExampleOrg/example-repo'],
    stateDirectory: join(home, 'state'), captureTokenFile: join(secure, 'capture.key'), boardTokenFile: join(secure, 'board.key'), limits: {} }
  await writeFile(config.captureTokenFile, 'private-capture-test', { mode: 0o600 })
  await writeFile(config.boardTokenFile, 'private-board-test', { mode: 0o600 })
  const consumerConfigFile = join(secure, 'consumer.json')
  await writeFile(consumerConfigFile, JSON.stringify(config), { mode: 0o600 })
  await mkdir(join(secure, 'bin'), { mode: 0o700 })
  await writeFile(join(secure, 'bin', 'gh'), '#!/bin/sh\nexit 77\n', { mode: 0o700 })
  const alertHookFile = join(secure, 'alert-hook')
  await writeFile(alertHookFile, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const namespace = receiptNamespace(config)
  const epoch = Date.now()
  const manifest = { version: 1, consumerConfigFile, stateDirectory: config.stateDirectory,
    namespace, alertHookFile, boardKeyIssuedMs: epoch - 1000, boardKeyExpiresMs: epoch - 1000 + 30 * 86400000 }
  const manifestPath = join(secure, 'runtime.json')
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
  const healthDir = join(config.stateDirectory, 'health')
  await mkdir(healthDir, { recursive: true })
  const healthPath = join(healthDir, 'health.json')
  if (corruptHealth) {
    await writeFile(healthPath, '{', { mode: 0o600 })
  } else {
    const at = epoch - healthAt
    const health = { version: 1, namespace, activatedMs: at - 60000, lastStartMs: at - 1000,
      lastFinishMs: at, lastHealthyMs: at, outcome: 'healthy',
      summary: { requests: 2, processed: 0, deferred: 0, failures: 0 } }
    await writeFile(healthPath, JSON.stringify(health), { mode: 0o600 })
  }
  const alertPath = join(healthDir, 'alert.json')
  if (!dropAlert) {
    await writeFile(alertPath, JSON.stringify({ version: 1, namespace, incident: null }), { mode: 0o600 })
    if (alertAgeMs > 0) {
      const backdate = new Date(Date.now() - alertAgeMs)
      await utimes(alertPath, backdate, backdate)
    }
  }
  const keyFile = join(secure, 'healthchecks-ping.key')
  if (pingUrl !== undefined) {
    await writeFile(keyFile, `${pingUrl}\n`, { mode: keyMode })
    if (keyMode !== 0o600) await chmod(keyFile, keyMode)
  }
  const run = (extraEnv = {}) => new Promise(resolve => {
    const child = spawn(process.execPath, [checkinSource, manifestPath], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8',
        HC_CHECKIN_ALLOW_HTTP_LOOPBACK: '1', ...extraEnv } })
    let stdout = '', stderr = ''
    child.stdout.on('data', s => { stdout += s })
    child.stderr.on('data', s => { stderr += s })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
  return { run, namespace }
}

function pingFor(port) {
  return `http://127.0.0.1:${port}/a3f1c9e2b4d6478a9c0e1f2a3b4c5d6e`
}

test('fresh consumer and fresh watcher send exactly one ping', async (t) => {
  const { hits, port } = await stubHealthchecks(t)
  const h = await harness(t, { pingUrl: pingFor(port) })
  const result = await h.run()
  assert.equal(result.code, 0)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].method, 'POST')
  assert.equal(result.stdout.includes('127.0.0.1'), false, 'ping URL must not appear in stdout')
  assert.equal(result.stderr.includes('127.0.0.1'), false, 'ping URL must not appear in stderr')
})

test('stale consumer suppresses the ping with a clean exit', async (t) => {
  const { hits, port } = await stubHealthchecks(t)
  const h = await harness(t, { pingUrl: pingFor(port), healthAt: CONSUMER_FRESH_MS + 60000 })
  const result = await h.run()
  assert.equal(result.code, 0)
  assert.equal(hits.length, 0, 'stale consumer must suppress the ping')
  assert.match(result.stderr, /suppressed: consumer-stale/)
})

test('stale watcher suppresses the ping with a clean exit', async (t) => {
  const { hits, port } = await stubHealthchecks(t)
  const h = await harness(t, { pingUrl: pingFor(port), alertAgeMs: WATCHER_FRESH_MS + 60000 })
  const result = await h.run()
  assert.equal(result.code, 0)
  assert.equal(hits.length, 0, 'stale watcher must suppress the ping')
  assert.match(result.stderr, /suppressed: watcher-stale/)
})

test('missing watcher state and corrupt consumer state fail closed without pinging', async (t) => {
  const { hits, port } = await stubHealthchecks(t)
  const url = pingFor(port)
  const dropped = await harness(t, { pingUrl: url, dropAlert: true })
  const missing = await dropped.run()
  assert.equal(missing.code, 0)
  assert.match(missing.stderr, /suppressed: watcher-missing/)
  const corrupt = await harness(t, { pingUrl: url, corruptHealth: true })
  const broken = await corrupt.run()
  assert.equal(broken.code, 0)
  assert.match(broken.stderr, /suppressed: health-state-invalid/)
  assert.equal(hits.length, 0, 'no degraded state may reach the transport')
})

test('transport failure exits nonzero without confirming, so the provider deadline runs', async (t) => {
  const { hits, port } = await stubHealthchecks(t, [500])
  const h = await harness(t, { pingUrl: pingFor(port) })
  const result = await h.run()
  assert.notEqual(result.code, 0)
  assert.equal(hits.length, 1)
  assert.equal(result.stdout.includes('127.0.0.1'), false)
  assert.equal(result.stderr.includes('127.0.0.1'), false)
})

test('missing, public or foreign ping file refuses before any network', async (t) => {
  const { hits, port } = await stubHealthchecks(t)
  const url = pingFor(port)
  const missing = await harness(t, {})
  assert.notEqual((await missing.run()).code, 0)
  const pub = await harness(t, { pingUrl: url, keyMode: 0o644 })
  assert.notEqual((await pub.run()).code, 0)
  const foreign = await harness(t, { pingUrl: 'https://example.com/hook' })
  assert.notEqual((await foreign.run()).code, 0)
  assert.equal(hits.length, 0, 'no misconfigured run may reach the transport')
})

test('gate boundary: fresh at exactly the threshold, stale one millisecond later', () => {
  const namespace = 'a'.repeat(64)
  const now = 1000000
  const window = { now, namespace, issuedMs: now - 1000, expiresMs: now + 30 * 86400000 }
  const healthAt = age => ({ version: 1, namespace, activatedMs: now - 60000 - age, lastStartMs: now - age - 1,
    lastFinishMs: now - age, lastHealthyMs: now - age, outcome: 'healthy',
    summary: { requests: 2, processed: 0, deferred: 0, failures: 0 } })
  assert.equal(decideCheckin({ ...window, health: healthAt(CONSUMER_FRESH_MS), alertMtimeMs: now }).ping, true)
  assert.equal(decideCheckin({ ...window, health: healthAt(CONSUMER_FRESH_MS + 1), alertMtimeMs: now }).reason, 'consumer-stale')
  assert.equal(decideCheckin({ ...window, health: healthAt(0), alertMtimeMs: now - WATCHER_FRESH_MS }).ping, true)
  assert.equal(decideCheckin({ ...window, health: healthAt(0), alertMtimeMs: now - WATCHER_FRESH_MS - 1 }).reason, 'watcher-stale')
})

test('non-healthy outcomes never ping even when recent', () => {
  const namespace = 'a'.repeat(64)
  const now = 1000000
  const window = { now, namespace, issuedMs: now - 1000, expiresMs: now + 30 * 86400000 }
  for (const outcome of ['never', 'running', 'partial', 'failed']) {
    const health = outcome === 'never'
      ? { version: 1, namespace, activatedMs: now, lastStartMs: null, lastFinishMs: null, lastHealthyMs: null, outcome, summary: null }
      : { version: 1, namespace, activatedMs: now - 60000, lastStartMs: now - 1000, lastFinishMs: outcome === 'running' ? null : now - 500,
        lastHealthyMs: null, outcome, summary: outcome === 'running' ? null : { requests: 1, processed: 0, deferred: 0, failures: 1 } }
    if (outcome === 'running') health.lastFinishMs = null
    assert.equal(decideCheckin({ ...window, health, alertMtimeMs: now }).ping, false, outcome)
  }
})

test('ping URL allowlist keeps provider scope and never leaks scope checks', () => {
  process.env.HC_CHECKIN_ALLOW_HTTP_LOOPBACK = '1'
  assert.equal(isAcceptablePingUrl('https://hc-ping.com/a3f1c9e2b4d6478a9c0e1f2a3b4c5d6e'), true)
  assert.equal(isAcceptablePingUrl('https://hc-ping.com/a3f1c9e2b4d6478a9c0e1f2a3b4c5d6e/my-check'), true)
  assert.equal(isAcceptablePingUrl('https://example.com/hook'), false)
  assert.equal(isAcceptablePingUrl('https://hc-ping.com/ short'), false)
  assert.equal(isAcceptablePingUrl('https://user@hc-ping.com/uuid'), false)
  delete process.env.HC_CHECKIN_ALLOW_HTTP_LOOPBACK
  assert.equal(isAcceptablePingUrl('http://127.0.0.1:9/uuid'), false, 'loopback only with the explicit test override')
})

test('the check-in ships no unconditional ping loop', async () => {
  const source = await readFile(checkinSource, 'utf8')
  assert.equal(source.includes('setInterval'), false, 'a separate unconditional ping timer is forbidden')
})
