/**
 * TOG-222 — gh-app-token.js credential-source and cache tests.
 *
 * Everything here runs the real CLI as a child process against stub servers, so
 * the thing under test is the surface git actually invokes. No real GitHub App
 * key, no real installation token, and no network egress: `GH_API_URL` and
 * `GH_APP_BROKER_URL` both point at loopback stubs, and the RSA key is generated
 * per-run in memory.
 *
 * Tokens in the fixtures are obvious fakes. If one of these strings ever shows
 * up in a log it came from this file, not from GitHub.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'gh-app-token.js')

const FAKE_BROKER_TOKEN = 'ghs_FAKE_FROM_BROKER_NOT_A_REAL_TOKEN'
const FAKE_PEM_TOKEN = 'ghs_FAKE_FROM_PEM_NOT_A_REAL_TOKEN'
const FAKE_CACHED_TOKEN = 'ghs_FAKE_SYNTHETIC_NOT_A_REAL_TOKEN'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })

const hourFromNow = () => new Date(Date.now() + 3600_000).toISOString()

/** Run the CLI with a *clean* env — nothing from this process leaks in. */
function run(args, env = {}, { stdin = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.stdin.end(stdin)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Minimal HTTP stub. `handler(req, body)` returns [status, jsonBody]. */
async function stub(handler) {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body })
      const out = handler(req, body)
      if (out === null) return // deliberately never respond
      const [status, payload] = out
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    calls,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  }
}

const brokerOk = (over = {}) => (req) =>
  [200, {
    token: FAKE_BROKER_TOKEN,
    expiresAt: hourFromNow(),
    repositories: ['paperclip-ops-tooling'],
    permissions: { contents: 'write', metadata: 'read' },
    ...over,
  }]

/** Stub of the two api.github.com endpoints the PEM path touches. */
const githubOk = () => (req) => {
  if (req.url === '/app/installations') return [200, [{ id: 42 }]]
  if (req.url.endsWith('/access_tokens')) {
    return [200, {
      token: FAKE_PEM_TOKEN,
      expires_at: hourFromNow(),
      permissions: { contents: 'write', metadata: 'read' },
      repository_selection: 'selected',
      repositories: [{ name: 'paperclip-ops-tooling' }],
    }]
  }
  return [404, { message: 'unexpected' }]
}

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tog222-${name}-`))
  return dir
}

const brokerEnv = (base, over = {}) => ({
  GH_APP_BROKER_URL: base,
  PAPERCLIP_API_KEY: 'pk_test_key',
  PAPERCLIP_TASK_ID: 'TOG-222',
  PAPERCLIP_RUN_ID: 'run-1',
  ...over,
})

// --- defect 1: the broker is wired to the credential path --------------------

test('credential get mints via the broker when no PEM is present', async () => {
  const b = await stub(brokerOk())
  const dir = scratch('broker')
  try {
    const r = await run(['credential', 'get'], brokerEnv(b.base, { PAPERCLIP_RUN_SCRATCH_DIR: dir }), {
      stdin: 'protocol=https\nhost=github.com\n',
    })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, `username=x-access-token\npassword=${FAKE_BROKER_TOKEN}\n`)

    const call = b.calls.at(-1)
    assert.equal(call.method, 'POST')
    assert.equal(call.url, '/api/plugins/gh-token-broker/api/issues/TOG-222/github-token')
    assert.equal(call.headers.authorization, 'Bearer pk_test_key')
    assert.equal(call.headers['x-paperclip-run-id'], 'run-1')
  } finally {
    await b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a local scope is forwarded to the broker as a narrowing request', async () => {
  const b = await stub(brokerOk())
  const dir = scratch('narrow')
  try {
    const r = await run(
      ['credential', 'get'],
      brokerEnv(b.base, {
        PAPERCLIP_RUN_SCRATCH_DIR: dir,
        GH_APP_REPOS: 'paperclip-ops-tooling',
        GH_APP_PERMISSIONS: 'contents=read',
      }),
      { stdin: 'host=github.com\n' }
    )
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(b.calls.at(-1).body), {
      repositories: ['paperclip-ops-tooling'],
      permissions: { contents: 'read' },
    })
  } finally {
    await b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the broker token is reused from cache within a run', async () => {
  const b = await stub(brokerOk())
  const dir = scratch('reuse')
  try {
    const env = brokerEnv(b.base, { PAPERCLIP_RUN_SCRATCH_DIR: dir })
    const first = await run(['credential', 'get'], env, { stdin: 'host=github.com\n' })
    const second = await run(['credential', 'get'], env, { stdin: 'host=github.com\n' })
    assert.equal(first.code, 0, first.stderr)
    assert.equal(second.code, 0, second.stderr)
    assert.equal(b.calls.length, 1, 'second invocation should be served from cache')
  } finally {
    await b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- defect 2: a withdrawn credential invalidates its cache ------------------

test('REGRESSION: a pre-TOG-222 cache (GH_APP_ID only, no cred) is refused', async () => {
  // This is verbatim the reproduction from the issue: GH_APP_ID still bound,
  // GH_APP_PRIVATE_KEY unbound, a cache entry holding a live token. It used to
  // exit 0 and print the password.
  const dir = scratch('legacy')
  const cache = path.join(dir, 'legacy.json')
  fs.writeFileSync(
    cache,
    JSON.stringify({ token: FAKE_CACHED_TOKEN, expires_at: hourFromNow(), appId: '123456' })
  )
  try {
    const r = await run(['credential', 'get'], {
      GH_APP_ID: '123456',
      GH_APP_TOKEN_CACHE: cache,
      GH_APP_TOKEN_SOURCE: 'pem',
    }, { stdin: 'host=github.com\n' })

    assert.equal(r.code, 1)
    assert.ok(!r.stdout.includes(FAKE_CACHED_TOKEN), 'must not serve the orphaned cache entry')
    assert.ok(!r.stdout.includes('password='), 'must not answer at all')
    assert.match(r.stderr, /GH_APP_PRIVATE_KEY is not set/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unbinding the PEM invalidates a PEM-minted cache entry', async () => {
  const g = await stub(githubOk())
  const dir = scratch('unbind')
  try {
    const base = { GH_API_URL: g.base, GH_APP_ID: '123456', PAPERCLIP_RUN_SCRATCH_DIR: dir, GH_APP_TOKEN_SOURCE: 'pem' }

    const minted = await run(['credential', 'get'], { ...base, GH_APP_PRIVATE_KEY: PEM }, { stdin: 'host=github.com\n' })
    assert.equal(minted.code, 0, minted.stderr)
    assert.ok(minted.stdout.includes(FAKE_PEM_TOKEN))

    // Same cache, same GH_APP_ID, PEM withdrawn — the post-unbind state.
    const after = await run(['credential', 'get'], base, { stdin: 'host=github.com\n' })
    assert.equal(after.code, 1)
    assert.ok(!after.stdout.includes(FAKE_PEM_TOKEN), 'cache survived the unbind')
    assert.match(after.stdout, /^quit=1$/m)
  } finally {
    await g.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rotating PAPERCLIP_API_KEY invalidates a broker-minted cache entry', async () => {
  const b = await stub(brokerOk())
  const dir = scratch('rotate')
  try {
    const first = await run(['credential', 'get'], brokerEnv(b.base, { PAPERCLIP_RUN_SCRATCH_DIR: dir }), {
      stdin: 'host=github.com\n',
    })
    assert.equal(first.code, 0, first.stderr)
    assert.equal(b.calls.length, 1)

    const second = await run(
      ['credential', 'get'],
      brokerEnv(b.base, { PAPERCLIP_RUN_SCRATCH_DIR: dir, PAPERCLIP_API_KEY: 'pk_rotated' }),
      { stdin: 'host=github.com\n' }
    )
    assert.equal(second.code, 0, second.stderr)
    assert.equal(b.calls.length, 2, 'a rotated key must not ride the old cache entry')
  } finally {
    await b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a PEM-minted entry is still reused while that same PEM is held', async () => {
  // The invalidation must key on the credential, not merely punish caching.
  const g = await stub(githubOk())
  const dir = scratch('samepem')
  try {
    const env = { GH_API_URL: g.base, GH_APP_ID: '1', GH_APP_PRIVATE_KEY: PEM, PAPERCLIP_RUN_SCRATCH_DIR: dir, GH_APP_TOKEN_SOURCE: 'pem' }
    await run(['credential', 'get'], env, { stdin: 'host=github.com\n' })
    await run(['credential', 'get'], env, { stdin: 'host=github.com\n' })
    const mints = g.calls.filter((c) => c.url.endsWith('/access_tokens')).length
    assert.equal(mints, 1)
  } finally {
    await g.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a different PEM under the same GH_APP_ID does not reuse the entry', async () => {
  const g = await stub(githubOk())
  const dir = scratch('rotpem')
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
  try {
    const base = { GH_API_URL: g.base, GH_APP_ID: '1', PAPERCLIP_RUN_SCRATCH_DIR: dir, GH_APP_TOKEN_SOURCE: 'pem' }
    await run(['credential', 'get'], { ...base, GH_APP_PRIVATE_KEY: PEM }, { stdin: 'host=github.com\n' })
    await run(['credential', 'get'], { ...base, GH_APP_PRIVATE_KEY: other }, { stdin: 'host=github.com\n' })
    const mints = g.calls.filter((c) => c.url.endsWith('/access_tokens')).length
    assert.equal(mints, 2)
  } finally {
    await g.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- defect 2b: no cross-run, cross-agent-readable cache file ----------------

test('with no run scratch dir, no token file is written to os.tmpdir()', async () => {
  const b = await stub(brokerOk())
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('.gh-app-token')))
  try {
    const env = brokerEnv(b.base)
    delete env.PAPERCLIP_RUN_SCRATCH_DIR
    const r = await run(['credential', 'get'], env, { stdin: 'host=github.com\n' })

    // Still answers — losing the cache must not break git.
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.stdout.includes(FAKE_BROKER_TOKEN))
    // ...but says so, and writes nothing shared.
    assert.match(r.stderr, /not caching/)

    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('.gh-app-token'))
    assert.deepEqual(after.filter((f) => !before.has(f)), [])
  } finally {
    await b.close()
  }
})

test('the cache file is written 0600 even if it already existed world-readable', async () => {
  const b = await stub(brokerOk())
  const dir = scratch('perm')
  const cache = path.join(dir, 'c.json')
  fs.writeFileSync(cache, '{}', { mode: 0o644 })
  fs.chmodSync(cache, 0o644)
  try {
    await run(['credential', 'get'], brokerEnv(b.base, { GH_APP_TOKEN_CACHE: cache }), {
      stdin: 'host=github.com\n',
    })
    assert.equal(fs.statSync(cache).mode & 0o777, 0o600)
  } finally {
    await b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- attributable, fail-closed failure ---------------------------------------

test('a failed credential get emits quit=1, an attributable line, and no password', async () => {
  const started = Date.now()
  const r = await run(['credential', 'get'], { GH_APP_TOKEN_SOURCE: 'pem' }, { stdin: 'host=github.com\n' })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /^quit=1$/m)
  assert.ok(!r.stdout.includes('password='))
  assert.match(r.stderr, /^gh-app-token: /m)
  assert.ok(Date.now() - started < 5000, 'must fail fast, not hang')
})

test('a non-github host is left alone: silent, exit 0, and no quit=1', async () => {
  // quit=1 aborts the whole lookup, so emitting it for someone else's host
  // would break every other credential helper on the box.
  const r = await run(['credential', 'get'], { GH_APP_TOKEN_SOURCE: 'pem' }, { stdin: 'host=gitlab.com\n' })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
})

test('gist.github.com is claimed', async () => {
  const r = await run(['credential', 'get'], { GH_APP_TOKEN_SOURCE: 'pem' }, { stdin: 'host=gist.github.com\n' })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /^quit=1$/m)
})

test('store and erase stay no-ops', async () => {
  for (const verb of ['store', 'erase']) {
    const r = await run(['credential', verb], { GH_APP_TOKEN_SOURCE: 'pem' }, { stdin: 'host=github.com\n' })
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
  }
})

// --- source selection --------------------------------------------------------

test('auto falls back to the PEM when the broker is absent (404), loudly', async () => {
  const b = await stub(() => [404, { error: 'Unknown plugin' }])
  const g = await stub(githubOk())
  const dir = scratch('fallback')
  try {
    const r = await run(
      ['credential', 'get'],
      brokerEnv(b.base, { PAPERCLIP_RUN_SCRATCH_DIR: dir, GH_API_URL: g.base, GH_APP_ID: '1', GH_APP_PRIVATE_KEY: PEM }),
      { stdin: 'host=github.com\n' }
    )
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.stdout.includes(FAKE_PEM_TOKEN))
    assert.match(r.stderr, /falling back to GH_APP_PRIVATE_KEY/)
    assert.match(r.stderr, /TOG-174/)
  } finally {
    await b.close()
    await g.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('auto does NOT fall back to the PEM on a definitive refusal (403)', async () => {
  // A broker that says "no" has answered. Retrying with the org-wide signing key
  // would turn an authorization decision into an authorization bypass.
  const b = await stub(() => [403, { error: 'Issue is not assigned to the calling agent.' }])
  const g = await stub(githubOk())
  const dir = scratch('refuse')
  try {
    const r = await run(
      ['credential', 'get'],
      brokerEnv(b.base, { PAPERCLIP_RUN_SCRATCH_DIR: dir, GH_API_URL: g.base, GH_APP_ID: '1', GH_APP_PRIVATE_KEY: PEM }),
      { stdin: 'host=github.com\n' }
    )
    assert.equal(r.code, 1)
    assert.ok(!r.stdout.includes(FAKE_PEM_TOKEN), 'PEM must not rescue a 403')
    assert.match(r.stdout, /^quit=1$/m)
    assert.match(r.stderr, /definitive refusal/)
    assert.equal(g.calls.filter((c) => c.url.endsWith('/access_tokens')).length, 0)
  } finally {
    await b.close()
    await g.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('source=broker never touches the PEM, even when one is bound', async () => {
  const b = await stub(() => [503, { error: 'Broker is not configured.' }])
  const g = await stub(githubOk())
  try {
    const r = await run(
      ['credential', 'get'],
      brokerEnv(b.base, {
        GH_APP_TOKEN_SOURCE: 'broker',
        GH_API_URL: g.base,
        GH_APP_ID: '1',
        GH_APP_PRIVATE_KEY: PEM,
      }),
      { stdin: 'host=github.com\n' }
    )
    assert.equal(r.code, 1)
    assert.match(r.stderr, /there is no fallback/)
    assert.equal(g.calls.length, 0)
  } finally {
    await b.close()
    await g.close()
  }
})

test('source=pem never calls the broker', async () => {
  const b = await stub(brokerOk())
  const g = await stub(githubOk())
  try {
    const r = await run(
      ['credential', 'get'],
      brokerEnv(b.base, { GH_APP_TOKEN_SOURCE: 'pem', GH_API_URL: g.base, GH_APP_ID: '1', GH_APP_PRIVATE_KEY: PEM }),
      { stdin: 'host=github.com\n' }
    )
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.stdout.includes(FAKE_PEM_TOKEN))
    assert.equal(b.calls.length, 0)
  } finally {
    await b.close()
    await g.close()
  }
})

test('an unreachable broker fails within the timeout rather than hanging', async () => {
  const b = await stub(() => null) // accepts, never responds
  const started = Date.now()
  try {
    const r = await run(
      ['credential', 'get'],
      brokerEnv(b.base, {
        GH_APP_TOKEN_SOURCE: 'broker',
        GH_APP_BROKER_TIMEOUT_MS: '400',
        GH_APP_BROKER_RETRIES: '0',
      }),
      { stdin: 'host=github.com\n' }
    )
    assert.equal(r.code, 1)
    assert.match(r.stderr, /broker timed out/)
    assert.match(r.stderr, /GH_APP_BROKER_TIMEOUT_MS/)
    assert.match(r.stdout, /^quit=1$/m)
    assert.ok(Date.now() - started < 8000, `took ${Date.now() - started}ms`)
  } finally {
    await b.close()
  }
})

// --- TOG-2899: retry-with-backoff on a transient broker failure -------------

test('a timeout is retried before falling closed, and names the timeout knob', async () => {
  const b = await stub(() => null) // accepts, never responds, every attempt
  try {
    const r = await run(
      ['credential', 'get'],
      brokerEnv(b.base, {
        GH_APP_TOKEN_SOURCE: 'broker',
        GH_APP_BROKER_TIMEOUT_MS: '300',
        GH_APP_BROKER_RETRIES: '2',
        GH_APP_BROKER_RETRY_DELAY_MS: '50',
      }),
      { stdin: 'host=github.com\n' }
    )
    assert.equal(r.code, 1)
    assert.equal(b.calls.length, 3, 'one initial attempt plus two retries')
    assert.match(r.stderr, /attempt 1\/3.*retrying in 50ms/)
    assert.match(r.stderr, /attempt 2\/3.*retrying in 50ms/)
    // Final failure still names the workaround.
    assert.match(r.stderr, /broker timed out.*GH_APP_BROKER_TIMEOUT_MS/)
  } finally {
    await b.close()
  }
})

test('a transient failure succeeds on retry without falling back to the PEM', async () => {
  let calls = 0
  const b = await stub(() => {
    calls += 1
    return calls === 1 ? [503, { error: 'busy' }] : brokerOk()()
  })
  const dir = scratch('retry-success')
  try {
    const r = await run(
      ['credential', 'get'],
      brokerEnv(b.base, { PAPERCLIP_RUN_SCRATCH_DIR: dir, GH_APP_BROKER_RETRY_DELAY_MS: '50' }),
      { stdin: 'host=github.com\n' }
    )
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.stdout.includes(FAKE_BROKER_TOKEN))
    assert.equal(b.calls.length, 2)
    assert.match(r.stderr, /broker refused \(503.*attempt 1\/2/)
  } finally {
    await b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a definitive refusal (403) is not retried', async () => {
  const b = await stub(() => [403, { error: 'nope' }])
  try {
    const r = await run(
      ['credential', 'get'],
      brokerEnv(b.base, { GH_APP_TOKEN_SOURCE: 'broker', GH_APP_BROKER_RETRY_DELAY_MS: '50' }),
      { stdin: 'host=github.com\n' }
    )
    assert.equal(r.code, 1)
    assert.equal(b.calls.length, 1, 'a definitive refusal must not be retried')
    assert.doesNotMatch(r.stderr, /retrying/)
  } finally {
    await b.close()
  }
})

test('a 404 (route absent) falls back to the PEM without a local retry', async () => {
  const b = await stub(() => [404, { error: 'Unknown plugin' }])
  const g = await stub(githubOk())
  const dir = scratch('404-no-retry')
  try {
    const r = await run(
      ['credential', 'get'],
      brokerEnv(b.base, {
        PAPERCLIP_RUN_SCRATCH_DIR: dir,
        GH_API_URL: g.base,
        GH_APP_ID: '1',
        GH_APP_PRIVATE_KEY: PEM,
        GH_APP_BROKER_RETRY_DELAY_MS: '50',
      }),
      { stdin: 'host=github.com\n' }
    )
    assert.equal(r.code, 0, r.stderr)
    assert.equal(b.calls.length, 1, 'a stable 404 must not be retried before falling back')
    assert.doesNotMatch(r.stderr, /retrying/)
  } finally {
    await b.close()
    await g.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an unset broker and unset PEM name both, and mint nothing', async () => {
  const r = await run(['credential', 'get'], {}, { stdin: 'host=github.com\n' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /broker not configured/)
  assert.match(r.stderr, /GH_APP_PRIVATE_KEY is not set/)
})

test('an invalid GH_APP_TOKEN_SOURCE is refused', async () => {
  const r = await run(['token'], { GH_APP_TOKEN_SOURCE: 'whatever' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /GH_APP_TOKEN_SOURCE must be one of/)
})

// --- diagnostics that must never emit credential material --------------------

test('source mode reports readiness and mints nothing', async () => {
  const b = await stub(brokerOk())
  try {
    const r = await run(['source'], brokerEnv(b.base, { GH_APP_ID: '99' }))
    assert.equal(r.code, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.mode, 'auto')
    assert.equal(out.broker.configured, true)
    assert.equal(out.broker.issueId, 'TOG-222')
    assert.equal(out.pem.present, false)
    assert.equal(b.calls.length, 0, 'source must not mint')
    assert.ok(!r.stdout.includes('pk_test_key'), 'must not echo the API key')
    assert.ok(out.credentials.every((c) => /^(broker|pem):[0-9a-f]{16}$/.test(c)))
  } finally {
    await b.close()
  }
})

test('source mode reports the TOG-2899 broker timeout/retry defaults, and their overrides', async () => {
  const b = await stub(brokerOk())
  try {
    const defaults = await run(['source'], brokerEnv(b.base))
    assert.equal(defaults.code, 0, defaults.stderr)
    const d = JSON.parse(defaults.stdout).broker
    assert.equal(d.timeoutMs, 60000)
    assert.equal(d.retries, 1)
    assert.equal(d.retryDelayMs, 1000)

    const overridden = await run(
      ['source'],
      brokerEnv(b.base, { GH_APP_BROKER_TIMEOUT_MS: '5000', GH_APP_BROKER_RETRIES: '3', GH_APP_BROKER_RETRY_DELAY_MS: '250' })
    )
    const o = JSON.parse(overridden.stdout).broker
    assert.equal(o.timeoutMs, 5000)
    assert.equal(o.retries, 3)
    assert.equal(o.retryDelayMs, 250)
  } finally {
    await b.close()
  }
})

test('unknown commands still refuse to fall through to a mint', async () => {
  const b = await stub(brokerOk())
  try {
    for (const arg of ['--help-me', 'mint', 'get']) {
      const r = await run([arg], brokerEnv(b.base))
      assert.equal(r.code, 1, arg)
      assert.ok(!r.stdout.includes(FAKE_BROKER_TOKEN), arg)
    }
    assert.equal(b.calls.length, 0)
  } finally {
    await b.close()
  }
})
