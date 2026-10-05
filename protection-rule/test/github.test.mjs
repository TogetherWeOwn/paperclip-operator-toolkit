// Offline tests of the generic credential/read/callback plumbing. The RSA key
// is generated in memory for this run, never committed or sent to a real API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mintInstallationToken, createGithubReader } from '../src/github.js'
import { extractCallbackRunId, postVerdict } from '../src/callback.js'
import { PLAN_POLICY, INSTALLATION_ID } from './trusted-fixture.mjs'

const REPO = PLAN_POLICY.repository
const RUN_ID = 777
const HEAD = 'a'.repeat(40)
const TOKEN = 'synthetic-installation-token-not-real'
const CALLBACK = `https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/deployment_protection_rule`
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })

test('App mint signs the configured identity for exactly the supplied installation', async () => {
  const requests = []
  const token = await mintInstallationToken({
    appId: '9000', privateKeyPem, installationId: INSTALLATION_ID, nowMs: 1800000000000,
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return Response.json({ token: TOKEN }, { status: 201 })
    },
  })
  assert.equal(token, TOKEN)
  assert.equal(requests.length, 1)
  const { url, init } = requests[0]
  assert.equal(url, `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['user-agent'], 'protection-rule')
  const jwt = init.headers.authorization.replace(/^Bearer /, '')
  const [header, payload, signature] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: '9000', iat: 1799999940, exp: 1800000540 })
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature, 'base64url')))
})
test('App mint refuses invalid installation or key without any API call', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return Response.json({ token: TOKEN }, { status: 201 }) }
  for (const installationId of [undefined, 0, -1, '9001', 1.1]) {
    await assert.rejects(mintInstallationToken({ fetchImpl, appId: '9000', privateKeyPem, installationId }))
  }
  await assert.rejects(mintInstallationToken({ fetchImpl, appId: '9000', privateKeyPem: 'synthetic PRIVATE KEY invalid', installationId: INSTALLATION_ID }))
  assert.equal(calls, 0)
})
test('App mint failure or invalid response cannot fall through to another identity', async () => {
  for (const response of [new Response('{}', { status: 403 }), Response.json({}), Response.json({ token: 'has space' }, { status: 201 })]) {
    let calls = 0
    await assert.rejects(mintInstallationToken({
      appId: '9000', privateKeyPem, installationId: INSTALLATION_ID,
      fetchImpl: async () => { calls++; return response },
    }))
    assert.equal(calls, 1)
  }
})
test('reader requires an explicit valid repository allowlist', () => {
  for (const allowedRepositories of [undefined, [], ['invalid'], null]) {
    assert.throws(() => createGithubReader({ fetchImpl: async () => {}, token: TOKEN, allowedRepositories }))
  }
})
test('foreign repository reads refuse before using the transport', async () => {
  let calls = 0
  const github = createGithubReader({
    allowedRepositories: [REPO], token: TOKEN,
    fetchImpl: async () => { calls++; return Response.json({}) },
  })
  await assert.rejects(github.getRun('ForeignOrg/unserved', RUN_ID))
  await assert.rejects(github.listArtifacts('ForeignOrg/unserved', RUN_ID))
  assert.equal(calls, 0, 'foreign repository must not spend the credential')
})
test('fresh run identity mismatch refuses even with the approved commit', async () => {
  const github = createGithubReader({
    allowedRepositories: [REPO], token: TOKEN,
    fetchImpl: async () => Response.json({ id: RUN_ID + 1, head_sha: HEAD, event: 'workflow_dispatch', html_url: 'https://run.example.invalid' }),
  })
  await assert.rejects(github.getRun(REPO, RUN_ID))
})
test('cross-origin artifact hops strip token, including nondefault API ports', async () => {
  for (const destination of ['https://objects.example.invalid/archive', 'https://api.github.com:8443/archive']) {
    const calls = []
    const github = createGithubReader({
      allowedRepositories: [REPO], token: TOKEN,
      fetchImpl: async (url, init) => {
        calls.push({ url, authorization: init.headers.authorization })
        return calls.length === 1 ? new Response(null, { status: 302, headers: { location: destination } }) : new Response('archive')
      },
    })
    assert.ok((await github.downloadBytes('https://api.github.com/archive', 100)).length > 0)
    assert.equal(calls[0].authorization, `Bearer ${TOKEN}`)
    assert.equal(calls[1].authorization, undefined, 'token must not cross the API origin')
  }
})
test('insecure or excessive redirects fail closed', async () => {
  let calls = 0
  const github = createGithubReader({
    allowedRepositories: [REPO], token: TOKEN,
    fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://objects.example.invalid/archive' } }) },
  })
  await assert.rejects(github.downloadBytes('https://api.github.com/archive', 100))
  assert.equal(calls, 1)
  const looping = createGithubReader({
    allowedRepositories: [REPO], token: TOKEN,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://objects.example.invalid/archive' } }),
  })
  await assert.rejects(looping.downloadBytes('https://api.github.com/archive', 100))
})
test('callback identity refuses foreign repository, origin, credentials, port and decorations', () => {
  for (const callbackUrl of [
    CALLBACK.replace(REPO, 'ForeignOrg/unserved'),
    CALLBACK.replace('https:', 'http:'),
    CALLBACK.replace('api.github.com', 'callback.example.invalid'),
    CALLBACK.replace('api.github.com', 'user@api.github.com'),
    CALLBACK.replace('api.github.com', 'api.github.com:8443'),
    CALLBACK + '?caller=true', CALLBACK + '#fragment',
  ]) assert.throws(() => extractCallbackRunId({ callbackUrl, repository: REPO }))
  assert.equal(extractCallbackRunId({ callbackUrl: CALLBACK, repository: REPO }), RUN_ID)
})
test('callback identity and reviewed-run binding refuse before a post', async () => {
  let calls = 0
  const args = {
    fetchImpl: async () => { calls++; return new Response(null, { status: 204 }) },
    token: TOKEN, repository: REPO, runId: RUN_ID,
    environment: PLAN_POLICY.environment, state: 'approved', reason: 'plan_and_go_verified',
  }
  for (const callbackUrl of [CALLBACK.replace(REPO, 'ForeignOrg/unserved'), CALLBACK.replace(`/runs/${RUN_ID}/`, '/runs/999/')]) {
    await assert.rejects(postVerdict({ ...args, callbackUrl }))
  }
  assert.equal(calls, 0, 'foreign callback must not receive a verdict or token')
})
test('callback posts stable verdict only, without digests or redirect following', async () => {
  const posts = []
  await postVerdict({
    fetchImpl: async (url, init) => { posts.push({ url, init }); return new Response(null, { status: 204 }) },
    token: TOKEN, callbackUrl: CALLBACK, repository: REPO, runId: RUN_ID,
    environment: PLAN_POLICY.environment, state: 'approved', reason: 'plan_and_go_verified',
  })
  assert.equal(posts.length, 1)
  assert.equal(posts[0].init.redirect, 'manual')
  assert.equal(posts[0].init.headers.authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(JSON.parse(posts[0].init.body), {
    environment_name: PLAN_POLICY.environment, state: 'approved',
    comment: `${PLAN_POLICY.environment} protection rule: approved (plan_and_go_verified)`,
  })
})
