import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_CLI = path.join(HERE, '..', 'external_disclosure.js')
const PRODUCTION_TRUST_STORE = path.join(HERE, '..', 'external_disclosure_authorizers.json')
const FAKE_TOKEN = ['github', '_pat_', 'FAKE_DISCLOSURE_TOKEN_NOT_REAL'].join('')
const TEST_KEY_ID = 'test-owner-ed25519-v1'
const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } = crypto.generateKeyPairSync('ed25519')
const PRIVATE_SENTINEL = 'PRIVATE-REPORT-BODY-MUST-NOT-REACH-RECEIPT'
const TRUST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tog576-trust-'))
const CLI = path.join(TRUST_DIR, 'external_disclosure.js')

fs.copyFileSync(SOURCE_CLI, CLI)
writeJson(path.join(TRUST_DIR, 'external_disclosure_authorizers.json'), {
  version: 1,
  keys: [{
    keyId: TEST_KEY_ID,
    algorithm: 'ed25519',
    authorizingPrincipal: { principalClass: 'test-owner', principalId: 'offline-suite-only' },
    publicKeyPem: TEST_PUBLIC_KEY.export({ type: 'spki', format: 'pem' }),
  }],
})
process.on('exit', () => fs.rmSync(TRUST_DIR, { recursive: true, force: true }))

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function signGrant(unsigned) {
  return {
    ...unsigned,
    signature: {
      algorithm: 'ed25519',
      keyId: TEST_KEY_ID,
      value: crypto.sign(null, Buffer.from(canonical(unsigned)), TEST_PRIVATE_KEY).toString('base64'),
    },
  }
}

function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tog576-${name}-`))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: os.tmpdir(),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function stub({ principal = 'app', postStatus = 201, onRepositoryProbe = null } = {}) {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body })
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.method === 'GET' && req.url === '/installation') {
        if (principal === 'app') return send(200, { id: 99, app_slug: 'togetherweown' })
        return send(403, { message: 'not an installation token' })
      }
      if (req.method === 'GET' && req.url === '/user') {
        if (principal === 'human') return send(200, { login: 'owner-login' })
        return send(403, { message: 'not a user token' })
      }
      if (req.method === 'GET' && req.url === '/repos/paperclipai/paperclip') {
        if (onRepositoryProbe) onRepositoryProbe()
        return send(200, { full_name: 'paperclipai/paperclip' })
      }
      if (req.method === 'POST' && req.url === '/repos/paperclipai/paperclip/private-vulnerability-reporting') {
        return send(postStatus, postStatus === 201 ? { ghsa_id: 'GHSA-test-0000-0000' } : { message: 'refused' })
      }
      return send(404, { message: 'unexpected' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function fixture(dir, origin, { grantPrincipal = 'app', runtimePrincipal = 'app', issue = 'TOG-576', runId = 'run-576', artifactBody = null } = {}) {
  const approval = path.join(dir, 'approval.txt')
  const artifact = path.join(dir, 'report.json')
  const credential = path.join(dir, 'credential.json')
  const grantPath = path.join(dir, 'grant.json')
  const runtimePath = path.join(dir, 'runtime.json')
  const state = path.join(dir, 'state')

  fs.writeFileSync(approval, 'approved exact disclosure set\n')
  fs.writeFileSync(artifact, artifactBody ?? JSON.stringify({ title: 'private report', description: PRIVATE_SENTINEL }))

  const principal = (kind) => kind === 'app'
    ? { principalClass: 'github_app', credentialClass: 'github_app_installation_token', principalId: 'github-app:togetherweown' }
    : { principalClass: 'human', credentialClass: 'github_user_token', principalId: 'github-user:owner-login' }

  const now = Date.now()
  const destination = {
    provider: 'github',
    apiOrigin: origin,
    repository: 'paperclipai/paperclip',
    endpoint: '/repos/paperclipai/paperclip/private-vulnerability-reporting',
  }
  writeJson(credential, {
    tokenIssuedAt: new Date(now - 60_000).toISOString(),
    tokenExpiresAt: new Date(now + 60 * 60_000).toISOString(),
    installationId: runtimePrincipal === 'app' ? '99' : null,
    repositorySelection: runtimePrincipal === 'app' ? 'selected' : null,
    repositories: ['paperclip'],
    effectivePermissions: { security_advisories: 'write', metadata: 'read' },
  })
  writeJson(grantPath, signGrant({
    version: 1,
    destination,
    channel: 'github-private-vulnerability-reporting',
    action: 'POST',
    artifacts: [{ id: 'report-1', sha256: sha256(fs.readFileSync(artifact)) }],
    authenticatingPrincipal: principal(grantPrincipal),
    authorizingPrincipal: { principalClass: 'test-owner', principalId: 'offline-suite-only' },
    approvalRecord: { id: 'approval-exact-1', source: 'TOG-576 interaction', sha256: sha256(fs.readFileSync(approval)) },
    approvedAt: new Date(now - 120_000).toISOString(),
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
    allowedIssueId: 'TOG-576',
    allowedRunId: 'run-576',
    requiredPermissions: { security_advisories: 'write' },
  }))
  writeJson(runtimePath, {
    version: 1,
    destination,
    channel: 'github-private-vulnerability-reporting',
    action: 'POST',
    artifacts: [{ id: 'report-1', path: artifact }],
    principal: principal(runtimePrincipal),
    approvalRecordPath: approval,
    credentialMetadataPath: credential,
    issueId: issue,
    runId,
    sessionId: 'session-576',
  })
  return { grantPath, runtimePath, state, artifact, approval, credential }
}

const env = { EXTERNAL_DISCLOSURE_TOKEN: FAKE_TOKEN }

test('the production trust store rejects the offline fixture signer', async () => {
  const dir = scratch('production-trust')
  const api = await stub({ principal: 'app' })
  try {
    const f = fixture(dir, api.origin)
    const productionCli = path.join(dir, 'external_disclosure.js')
    fs.copyFileSync(SOURCE_CLI, productionCli)
    fs.copyFileSync(PRODUCTION_TRUST_STORE, path.join(dir, 'external_disclosure_authorizers.json'))
    const child = spawn(process.execPath, [productionCli, 'preflight', '--grant', f.grantPath, '--runtime', f.runtimePath], {
      env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const code = await new Promise((resolve) => child.on('close', resolve))
    assert.equal(code, 1)
    assert.match(stderr, /not trusted/)
    assert.equal(api.calls.length, 0)
  } finally {
    await api.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// TOG-574 reproduction: the credential is capable and the runtime says App,
// but the grant names a human principal. The read-only capability probes may run;
// the external POST must not.
test('a grant edited after authorization is rejected by its signature before any probe', async () => {
  const dir = scratch('signature')
  const api = await stub({ principal: 'app' })
  try {
    const f = fixture(dir, api.origin)
    const grant = JSON.parse(fs.readFileSync(f.grantPath, 'utf8'))
    grant.allowedIssueId = 'TOG-551'
    writeJson(f.grantPath, grant)
    const result = await run(['preflight', '--grant', f.grantPath, '--runtime', f.runtimePath], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /signature is invalid/)
    assert.equal(api.calls.length, 0)
  } finally {
    await api.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('REGRESSION: an available App token cannot satisfy a human-principal grant', async () => {
  const dir = scratch('principal')
  const api = await stub({ principal: 'app' })
  try {
    const f = fixture(dir, api.origin, { grantPrincipal: 'human', runtimePrincipal: 'app' })
    const result = await run(['preflight', '--grant', f.grantPath, '--runtime', f.runtimePath], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /authenticating principal/)
    assert.equal(api.calls.filter((call) => call.method === 'POST').length, 0)
  } finally {
    await api.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('REGRESSION: broad route approval without exact issue/run binding fails closed', async () => {
  const dir = scratch('binding')
  const api = await stub({ principal: 'app' })
  try {
    const f = fixture(dir, api.origin, { issue: 'TOG-551', runId: 'broad-route-run' })
    const result = await run(['submit', '--grant', f.grantPath, '--runtime', f.runtimePath, '--state-dir', f.state], env)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /host-authenticated gh-token-broker/)
    assert.equal(api.calls.filter((call) => call.method === 'POST').length, 0)
    assert.ok(!fs.existsSync(f.state), 'a refused preflight must not consume the grant')
  } finally {
    await api.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a destination endpoint outside the named repository is refused', async () => {
  const dir = scratch('destination')
  const api = await stub({ principal: 'app' })
  try {
    const f = fixture(dir, api.origin)
    const runtime = JSON.parse(fs.readFileSync(f.runtimePath, 'utf8'))
    runtime.destination.endpoint = '/repos/someone-else/other/issues'
    writeJson(f.runtimePath, runtime)
    const result = await run(['preflight', '--grant', f.grantPath, '--runtime', f.runtimePath], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /beneath the named repository/)
    assert.equal(api.calls.length, 0)
  } finally {
    await api.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact substitution is refused before mutation', async () => {
  const dir = scratch('artifact')
  const api = await stub({ principal: 'app' })
  try {
    const f = fixture(dir, api.origin)
    fs.appendFileSync(f.artifact, '\nsubstituted')
    const result = await run(['submit', '--grant', f.grantPath, '--runtime', f.runtimePath, '--state-dir', f.state], env)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /host-authenticated gh-token-broker/)
    assert.equal(api.calls.filter((call) => call.method === 'POST').length, 0)
  } finally {
    await api.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('local submit is disabled before a claim or external mutation', async () => {
  const dir = scratch('disabled-submit')
  const api = await stub({ principal: 'app' })
  try {
    const f = fixture(dir, api.origin)
    const result = await run(['submit', '--grant', f.grantPath, '--runtime', f.runtimePath, '--state-dir', f.state], env)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /host-authenticated gh-token-broker/)
    assert.equal(api.calls.length, 0)
    assert.ok(!fs.existsSync(f.state))
  } finally {
    await api.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('preflight rejects a non-canonical spelling of a valid signature', async () => {
  const dir = scratch('signature-encoding')
  const api = await stub({ principal: 'app' })
  try {
    const f = fixture(dir, api.origin)
    const grant = JSON.parse(fs.readFileSync(f.grantPath, 'utf8'))
    assert.match(grant.signature.value, /==$/)
    grant.signature.value = grant.signature.value.replace(/=+$/, '')
    writeJson(f.grantPath, grant)

    const result = await run(['preflight', '--grant', f.grantPath, '--runtime', f.runtimePath], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /canonical padded base64/)
    assert.equal(api.calls.length, 0)
  } finally {
    await api.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown command refuses and never probes or submits', async () => {
  const result = await run(['definitely-not-a-command'], env)
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /unknown command/)
})
