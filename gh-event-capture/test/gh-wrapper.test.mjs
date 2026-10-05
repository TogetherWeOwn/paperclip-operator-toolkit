import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, writeFile, chmod, rm, mkdir, readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const wrapperSource = join(repoRoot, 'scripts', 'gh-wrapper.mjs')

// Throwaway RSA key per run: a live App PEM must never reach a test.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })
const INSTALL_ID = '9000001'

// Stub GitHub App API: records the mint request, issues one opaque token.
function stubGithub(t, { token = 'ghs_testopaque', installations = [{ id: Number(INSTALL_ID) }] } = {}) {
  const hits = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      hits.push({ url: req.url, method: req.method, auth: req.headers.authorization, body })
      if (req.url === '/app/installations') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(installations))
      }
      if (req.url === `/app/installations/${INSTALL_ID}/access_tokens` && req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ token, expires_at: '2026-10-01T00:00:00Z' }))
      }
      res.writeHead(404)
      return res.end('{}')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close())
      resolve({ hits, port: server.address().port })
    })
  })
}

// Mirror production: the wrapper is installed at $SECURE/bin/gh (0700) beside
// consumer.json, with private key files under $SECURE. The child gets a
// minimal environment plus GH_API_URL pointing at the stub.
async function harness(t, { keyMode = 0o600 } = {}) {
  const home = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'gh-wrapper-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const secure = join(home, 'credential-drop', 'gh-product-bridge')
  await mkdir(join(secure, 'bin'), { recursive: true, mode: 0o700 })
  await writeFile(join(secure, 'gh-app.id'), '1234567\n', { mode: 0o600 })
  await writeFile(join(secure, 'gh-app.pem'), PEM, { mode: keyMode })
  if (keyMode !== 0o600) await chmod(join(secure, 'gh-app.pem'), keyMode)
  await writeFile(join(secure, 'consumer.json'),
    JSON.stringify({ allowedRepositories: ['ExampleOrg/example-repo'] }), { mode: 0o600 })
  // Stand-in for the real gh: records argv + env, exits 3 on demand. It is
  // reached through the GH_REAL_GH test seam (never present in production,
  // where the service units provide only PATH/HOME/LANG).
  const probe = join(secure, 'real-gh.mjs')
  await writeFile(probe, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.PROBE_OUT, JSON.stringify({ argv: process.argv.slice(2),
  ghToken: process.env.GH_TOKEN ?? null, githubToken: process.env.GITHUB_TOKEN ?? null,
  runKey: process.env.PAPERCLIP_API_KEY ?? null, runId: process.env.PAPERCLIP_RUN_ID ?? null }))
if (process.argv.includes('--fail-with-3')) process.exit(3)
`)
  const bin = join(secure, 'bin', 'gh')
  const source = await readFile(wrapperSource, 'utf8')
  await writeFile(bin, source, { mode: 0o700 })
  await chmod(probe, 0o755)
  const seamFile = join(home, 'real-gh-seam')
  await writeFile(seamFile, `${probe}\n`)
  const out = join(home, 'probe.json')
  const run = (args, env = {}) => new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8',
        PROBE_OUT: out, GH_API_URL: env.GH_API_URL, GH_REAL_GH_FILE: seamFile,
        ...(env.EXTRA_ENV || {}) } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (s) => { stdout += s })
    child.stderr.on('data', (s) => { stderr += s })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  return { home, secure, bin, out, probe, run }
}

test('argv and exit code pass through with a freshly minted credential', async (t) => {
  const { hits, port } = await stubGithub(t)
  const h = await harness(t)
  const result = await h.run(['pr', 'view', '12', '--json', 'title'],
    { GH_API_URL: `http://127.0.0.1:${port}` })
  assert.equal(result.code, 0)
  assert.equal(hits.filter((h) => h.url.endsWith('/access_tokens')).length, 1,
    'exactly one token mint per invocation')
  const probe = JSON.parse(await readFile(h.out, 'utf8'))
  assert.deepEqual(probe.argv, ['pr', 'view', '12', '--json', 'title'])
  assert.equal(probe.ghToken, 'ghs_testopaque')
  assert.equal(probe.githubToken, null)
  assert.equal(probe.runKey, null)
  assert.equal(probe.runId, null)
  const mintHit = hits.find((h) => h.url.endsWith('/access_tokens'))
  const mint = JSON.parse(mintHit.body)
  assert.deepEqual(mint.repositories, ['example-repo'])
  assert.deepEqual(mint.permissions, { pull_requests: 'read', metadata: 'read' })
  assert.equal(result.stdout.includes('ghs_testopaque'), false, 'minted token must not reach stdout')
  assert.equal(result.stderr.includes('ghs_testopaque'), false, 'minted token must not reach stderr')
})

test('child exit code is preserved', async (t) => {
  const { port } = await stubGithub(t)
  const h = await harness(t)
  const result = await h.run(['--fail-with-3'], { GH_API_URL: `http://127.0.0.1:${port}` })
  assert.equal(result.code, 3)
})

test('grant-check runs a read-only PR GraphQL read, never auth token output', async (t) => {
  const { hits, port } = await stubGithub(t)
  const h = await harness(t)
  const result = await h.run(['grant-check', 'ExampleOrg/example-repo'],
    { GH_API_URL: `http://127.0.0.1:${port}` })
  assert.equal(result.code, 0)
  const probe = JSON.parse(await readFile(h.out, 'utf8'))
  assert.equal(probe.argv[0], 'api')
  assert.ok(probe.argv.join(' ').includes('graphql'), 'grant check is a GraphQL read')
  assert.equal(probe.argv.join(' ').includes('auth'), false, 'grant check is not an auth-token dump')
  assert.ok(probe.argv.join(' ').includes('pullRequests'), 'grant check reads PR state')
})

test('a JWT-shaped minted value is refused before any use', async (t) => {
  const { port } = await stubGithub(t, { token: 'eyJ.head.sig' })
  const h = await harness(t)
  const result = await h.run(['pr', 'view', '1'], { GH_API_URL: `http://127.0.0.1:${port}` })
  assert.notEqual(result.code, 0)
  await assert.rejects(readFile(h.out), { code: 'ENOENT' }, 'refused token must never reach the child')
})

test('inherited GH_TOKEN is refused, not overridden', async (t) => {
  const { port } = await stubGithub(t)
  const h = await harness(t)
  const result = await h.run(['pr', 'view', '1'],
    { GH_API_URL: `http://127.0.0.1:${port}`, EXTRA_ENV: { GH_TOKEN: 'ambient-token' } })
  assert.notEqual(result.code, 0)
  await assert.rejects(readFile(h.out), { code: 'ENOENT' }, 'ambient token must never reach the child')
})

test('agent run credential present in env is refused', async (t) => {
  const { port } = await stubGithub(t)
  const h = await harness(t)
  const result = await h.run(['pr', 'view', '1'],
    { GH_API_URL: `http://127.0.0.1:${port}`,
      EXTRA_ENV: { PAPERCLIP_API_KEY: 'eyJ.run.jwt' } })
  assert.notEqual(result.code, 0)
})

test('public signing key is refused without minting', async (t) => {
  const { hits, port } = await stubGithub(t)
  const h = await harness(t, { keyMode: 0o644 })
  const result = await h.run(['pr', 'view', '1'], { GH_API_URL: `http://127.0.0.1:${port}` })
  assert.notEqual(result.code, 0)
  assert.equal(hits.length, 0, 'no mint attempt with a public key')
})

test('no key material reaches output on any path', async (t) => {
  const { port } = await stubGithub(t)
  const h = await harness(t)
  const result = await h.run(['pr', 'view', '1'], { GH_API_URL: `http://127.0.0.1:${port}` })
  const combined = result.stdout + result.stderr
  assert.equal(/BEGIN [A-Z ]*PRIVATE KEY/.test(combined), false)
  assert.equal((await stat(h.bin)).mode & 0o777 & 0o077, 0, 'installed wrapper must be 0700')
})
