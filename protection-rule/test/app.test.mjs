// Offline integration suite for the protection-rule endpoint.
//
// No credentials, no network, no clock. Every transport behind the webhook is
// a stub: GitHub reads, board reads and the callback post are scripted per
// test, and the suite asserts the (HTTP status, posted verdict) pair — never
// message text. The rows that carry this suite:
//
//   * the full APPROVE path posts `approved` exactly once, and only then;
//   * every evidence or approval gap posts `rejected`, never `approved`;
//   * an unverified delivery reaches no transport at all;
//   * a missing secret answers 503 without minting or posting anything.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createApp, MAX_ACCEPTED_BODY_BYTES } from '../src/app.js'
import { zipOf } from './zip-fixture.mjs'
import { EVENT, REASON } from '../src/decide.js'
import { APPROVER_AGENT_ID, OTHER_AGENT_ID, INSTALLATION_ID, PLAN_POLICY, SHA_POLICY, TRUSTED_CONFIG, freshConfig } from './trusted-fixture.mjs'

const SECRET = 'test-webhook-secret-not-a-real-one'
const APP_ID = 'test-app-id'
const APP_KEY = 'test-app-key-PRIVATE KEY-marker-not-a-real-one'
const BOARD_TOKEN = 'test-board-token-not-a-real-one'
const BOARD_ORIGIN = 'https://board.example.invalid'

const PLAN_ENVIRONMENT = PLAN_POLICY.environment
const PLAN_ISSUE = PLAN_POLICY.goIssueId
const REPO = PLAN_POLICY.repository
const SHA_ENVIRONMENT = SHA_POLICY.environment
const SHA_REPO = SHA_POLICY.repository
const SHA_ISSUE = SHA_POLICY.goIssueId

const HEAD = 'a'.repeat(40)
const HASH = 'b'.repeat(64)
const RUN_ID = 777
const PLAN_RUN_ID = 101
const CALLBACK = `https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/deployment_protection_rule`
const SHA_CALLBACK = `https://api.github.com/repos/${SHA_REPO}/actions/runs/${RUN_ID}/deployment_protection_rule`

async function sign(secret, bodyText) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyText)))
  return 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function payload(overrides = {}) {
  return {
    action: 'requested',
    environment: PLAN_ENVIRONMENT,
    event: 'workflow_dispatch',
    sha: HEAD,
    ref: 'refs/heads/main',
    deployment_callback_url: CALLBACK,
    deployment: { run_id: RUN_ID, sha: HEAD, environment: PLAN_ENVIRONMENT },
    repository: { full_name: REPO },
    installation: { id: INSTALLATION_ID },
    ...overrides,
  }
}

function shaPayload(overrides = {}) {
  return {
    action: 'requested',
    environment: SHA_ENVIRONMENT,
    event: 'workflow_dispatch',
    sha: HEAD,
    ref: 'refs/heads/main',
    deployment_callback_url: SHA_CALLBACK,
    deployment: { run_id: RUN_ID, sha: HEAD, environment: SHA_ENVIRONMENT },
    repository: { full_name: SHA_REPO },
    installation: { id: INSTALLATION_ID },
    ...overrides,
  }
}

// Stub transport. `githubMode` scripts the GitHub half, `boardComments` the
// board half; every callback post is recorded in `posts`. The JWT mint is
// stubbed per-harness (the separate GitHub suite covers its real path with a
// generated key): the stub answers with a token except in `mint-fails`, where
// it throws the way the real minter does on a bad key or a refused mint.
function harness({ githubMode = 'happy', boardComments = [], boardCommentsByIssue = null, appOverrides = {} } = {}) {
  let mints = 0
  const mintToken = async () => {
    mints++
    if (githubMode === 'mint-fails') throw new Error('GitHub installation token mint failed')
    return 'stub-installation-token'
  }
  const posts = []
  const calls = { run: 0, jobs: 0, artifacts: 0, downloads: 0, board: 0 }
  // Fixture manifest: bytes with NO digest field; the claim and the GO
  // comment carry sha256(bytes), and verifyPlan binds bytes-digest ==
  // claimed. verifyPlan accepts a missing embedded field, so the fixture
  // needs no self-describing digest at all.
  const FIXTURE_TEXT = JSON.stringify({ fixture: 'synthetic-plan-manifest', plan: 'fixture-plan', nonce: 'fixed-bytes' })
  let trueDigest = null
  let trueZip = null
  const ensureManifest = async () => {
    if (trueZip) return trueZip
    const bytes = new TextEncoder().encode(FIXTURE_TEXT)
    trueDigest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    trueZip = zipOf(FIXTURE_TEXT)
    return trueZip
  }
  const fixtureDigest = async () => {
    await ensureManifest()
    const bytes = new TextEncoder().encode(FIXTURE_TEXT)
    return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  void fixtureDigest
  const zipForHash = () => {
    if (!trueZip) throw new Error('manifest not prepared: await ensureManifest first')
    return trueZip
  }
  const digestForClaim = async () => {
    await ensureManifest()
    return trueDigest
  }
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    const method = init.method ?? 'GET'
    requests.push({ url: target, authorization: init.headers?.authorization ?? null })
    if (target.endsWith(`/actions/runs/${RUN_ID}`) && method === 'GET') {
      calls.run++
      if (githubMode === 'run-mismatch-sha') {
        return Response.json({ id: RUN_ID, head_sha: 'd'.repeat(40), event: 'workflow_dispatch', html_url: 'https://x' })
      }
      return Response.json({ id: RUN_ID, head_sha: HEAD, event: 'workflow_dispatch', html_url: 'https://x' })
    }
    if (target.includes(`/actions/runs/${RUN_ID}/jobs`) && method === 'GET') {
      calls.jobs++
      if (githubMode === 'no-claim') return Response.json({ jobs: [] })
      const claimDigest = await digestForClaim()
      return Response.json({ jobs: [{ steps: [{ name: `migrate-plan-binding: sha256=${claimDigest} run=${PLAN_RUN_ID}` }] }] })
    }
    if (target.endsWith(`/actions/runs/${PLAN_RUN_ID}/artifacts?per_page=100`) && method === 'GET') {
      calls.artifacts++
      if (githubMode === 'plan-missing-artifact') return Response.json({ artifacts: [] })
      if (githubMode === 'redirect-download') {
        return Response.json({ artifacts: [{ id: 9, name: 'staging-migrate-manifest.json', expired: false, archive_download_url: 'https://api.github.com/dl/redirect' }] })
      }
      return Response.json({ artifacts: [{ id: 9, name: 'staging-migrate-manifest.json', expired: false, archive_download_url: 'https://api.github.com/dl/zip' }] })
    }
    if (target === 'https://api.github.com/dl/zip' && method === 'GET') {
      calls.downloads++
      if (githubMode === 'plan-hash-mismatch') {
        return new Response(zipOf(JSON.stringify({ fixture: 'different-bytes', nonce: 'mismatch' })), { status: 200 })
      }
      return new Response(zipForHash(), { status: 200 })
    }
    // Live shape: the API answers the archive download with a redirect to
    // object storage. The hop is followed WITHOUT the token (see requests).
    if (target === 'https://api.github.com/dl/redirect' && method === 'GET') {
      calls.downloads++
      return new Response(null, { status: 302, headers: { location: 'https://objects.example.invalid/zip' } })
    }
    if (target === 'https://objects.example.invalid/zip' && method === 'GET') {
      return new Response(zipForHash(), { status: 200 })
    }
    if (target.endsWith(`/actions/runs/${PLAN_RUN_ID}`) && method === 'GET') {
      if (githubMode === 'plan-commit-mismatch') {
        return Response.json({ id: PLAN_RUN_ID, head_sha: 'e'.repeat(40), event: 'workflow_dispatch', html_url: 'https://y' })
      }
      return Response.json({ id: PLAN_RUN_ID, head_sha: HEAD, event: 'workflow_dispatch', html_url: 'https://y' })
    }
    if (target.includes('/api/issues/') && target.endsWith('/comments?order=asc') && method === 'GET') {
      calls.board++
      if (githubMode === 'board-fails') return new Response('{}', { status: 500 })
      // Per-card comments: a harness serving a GO on one card does not serve
      // it on another. Keyed lists take precedence; the flat list is the
      // legacy default for callers that pass one.
      if (boardCommentsByIssue !== null) {
        const match = /\/api\/issues\/([^/]+)\/comments\?order=asc$/.exec(target)
        return Response.json(boardCommentsByIssue[match?.[1]] ?? [])
      }
      return Response.json(boardComments)
    }
    // Any protection-rule review endpoint answers: the suite models GitHub
    // faithfully enough that a post to the WRONG run would succeed (204) —
    // so a dropped run binding shows up as a post, not as an unstubbed error.
    if (/\/actions\/runs\/\d+\/deployment_protection_rule$/.test(target) && method === 'POST') {
      posts.push({ url: target, ...JSON.parse(init.body) })
      if (githubMode === 'callback-fails') return new Response('{}', { status: 500 })
      return new Response(null, { status: 204 })
    }
    throw new Error(`unstubbed fetch: ${method} ${target}`)
  }
  const app = createApp({
    webhookSecret: SECRET, appId: APP_ID, appPrivateKey: APP_KEY,
    boardToken: BOARD_TOKEN,
    boardOrigin: BOARD_ORIGIN, trustedConfig: TRUSTED_CONFIG, fetchImpl, mintToken, ...appOverrides,
  })
  const callsProxy = new Proxy(calls, { get: (t, k) => (k === 'mint' ? mints : t[k]) })
  const ready = ensureManifest()
  const manifestBytes = new TextEncoder().encode('manifest-fixture-bytes-not-compared')
  return { app, posts, calls: callsProxy, manifestBytes, requests,
    ready, digest: () => {
      if (!trueDigest) throw new Error('manifest not prepared yet')
      return trueDigest
    } }
}

async function delivery(app, body, { event = EVENT, signature = undefined } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const headers = new Headers({
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': 'd-1',
  })
  const sig = signature === undefined ? await sign(SECRET, text) : signature
  if (sig !== null) headers.set('x-hub-signature-256', sig)
  return app(new Request('https://protection-rule.example.invalid/protection-rule', { method: 'POST', headers, body: text }))
}

function goComment(hash, overrides = {}) {
  return { id: 'c1', authorAgentId: APPROVER_AGENT_ID, authorUserId: null, body: `GO ${hash}`, ...overrides }
}

// Build harness + GO comment bound to the independently computed bytes digest.
async function approvedHarness(options = {}, commentOverrides = {}) {
  const h = harness({ ...options, boardComments: [] })
  await h.ready
  const digest = h.digest()
  const comments = options.boardComments === undefined ? [goComment(digest, commentOverrides)] : options.boardComments
  // Rebuild with the real comments: same stub identity, real GO set.
  const h2 = harness({ ...options, boardComments: comments })
  await h2.ready
  return h2
}

// The artifact redirect hop crosses origins: followed without the token, and
// the approve row still verifies end to end.
test('artifact redirect to object storage verifies without sending the token cross-origin', async () => {
  const { app, posts, requests } = await approvedHarness({ githubMode: 'redirect-download' })
  const res = await delivery(app, payload())
  const body = await res.json()
  assert.equal(body.state, 'approved')
  assert.deepEqual(posts.map((p) => p.state), ['approved'])
  const objectHop = requests.find((r) => r.url === 'https://objects.example.invalid/zip')
  assert.ok(objectHop, 'redirect hop was followed')
  assert.equal(objectHop.authorization, null)
})

// The approve row: every link verified, GO present, `approved` posted once.
test('verified plan plus configured approver GO posts approved once', async () => {
  const { app, posts, calls } = await approvedHarness()
  const res = await delivery(app, payload())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.state, 'approved')
  assert.equal(body.reason, REASON.APPROVED)
  assert.equal(body.callback_posted, true)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].state, 'approved')
  assert.equal(posts[0].environment_name, PLAN_ENVIRONMENT)
  assert.equal(calls.mint, 1)
})

// Rejection rows: each gap posts `rejected`, never `approved`.
test('missing configured approver GO posts rejected', async () => {
  const { app, posts } = await approvedHarness({ boardComments: [] })
  const res = await delivery(app, payload())
  const body = await res.json()
  assert.equal(body.state, 'rejected')
  assert.equal(body.reason, REASON.GO_MISSING)
  assert.deepEqual(posts.map((p) => p.state), ['rejected'])
})

test('unserved environment on a known repo is refused with 400 and posts nothing', async () => {
  const { app, posts, calls } = harness({ boardComments: [goComment(HASH)] })
  const res = await delivery(app, payload({ environment: 'fixture-unserved' }))
  const body = await res.json()
  assert.equal(res.status, 400)
  assert.equal(posts.length, 0)
  assert.equal(calls.run, 0)
  void body
})

test('wrong event posts rejected', async () => {
  const { app, posts } = harness({ boardComments: [goComment(HASH)] })
  const res = await delivery(app, payload(), { event: 'push' })
  const body = await res.json()
  assert.equal(body.state, 'rejected')
  assert.equal(body.reason, REASON.WRONG_EVENT)
  assert.deepEqual(posts.map((p) => p.state), ['rejected'])
})

test('missing claim posts rejected', async () => {
  const { app, posts } = await approvedHarness({ githubMode: 'no-claim' })
  const res = await delivery(app, payload())
  const body = await res.json()
  assert.equal(body.state, 'rejected')
  assert.equal(body.reason, REASON.CLAIM_MISSING)
  assert.deepEqual(posts.map((p) => p.state), ['rejected'])
})

test('plan on another commit posts rejected', async () => {
  const { app, posts } = await approvedHarness({ githubMode: 'plan-commit-mismatch' })
  const body = await (await delivery(app, payload())).json()
  assert.equal(body.state, 'rejected')
  assert.equal(body.reason, REASON.PLAN_NOT_FOUND)
  assert.deepEqual(posts.map((p) => p.state), ['rejected'])
})

test('apply head outside the run read posts rejected', async () => {
  const { app, posts } = await approvedHarness({ githubMode: 'run-mismatch-sha' })
  const body = await (await delivery(app, payload())).json()
  assert.equal(body.state, 'rejected')
  assert.equal(body.reason, REASON.PLAN_NOT_FOUND)
})

test('foreign repository is refused with 400 and posts nothing', async () => {
  const { app, posts } = harness({ boardComments: [goComment(HASH)] })
  const res = await delivery(app, payload({ repository: { full_name: 'SomeoneElse/other' } }))
  assert.equal(res.status, 400)
  assert.equal(posts.length, 0)
})

test('GO from another agent is not an approval', async () => {
  const { app, posts } = await approvedHarness({}, { authorAgentId: OTHER_AGENT_ID })
  const body = await (await delivery(app, payload())).json()
  assert.equal(body.state, 'rejected')
  assert.equal(body.reason, REASON.GO_MISSING)
  assert.deepEqual(posts.map((p) => p.state), ['rejected'])
})

test('GO from a human user is not an approval', async () => {
  const { app, posts } = await approvedHarness({}, { authorUserId: 'some-human' })
  const body = await (await delivery(app, payload())).json()
  assert.equal(body.state, 'rejected')
  assert.equal(body.reason, REASON.GO_MISSING)
})

test('unsigned delivery is 401 and reaches no transport', async () => {
  const { app, posts, calls } = harness({ boardComments: [goComment(HASH)] })
  const res = await delivery(app, payload(), { signature: null })
  assert.equal(res.status, 401)
  assert.equal(posts.length, 0)
  assert.equal(calls.mint, 0)
  assert.equal(calls.board, 0)
})

test('missing secret is 503 and mints nothing', async () => {
  const { app, posts, calls } = harness({ appOverrides: { webhookSecret: '' } })
  const res = await delivery(app, payload())
  assert.equal(res.status, 503)
  assert.equal(posts.length, 0)
  assert.equal(calls.mint, 0)
})

test('oversized body is 413 before verification', async () => {
  const { app, posts } = harness()
  const big = 'x'.repeat(MAX_ACCEPTED_BODY_BYTES + 1)
  const headers = new Headers({
    'content-type': 'application/json',
    'content-length': String(big.length),
    'x-github-event': EVENT,
    'x-github-delivery': 'd-big',
    'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
  })
  const res = await app(new Request('https://protection-rule.example.invalid/protection-rule', { method: 'POST', headers, body: big }))
  assert.equal(res.status, 413)
  assert.equal(posts.length, 0)
})

test('mint failure reports rejected with no verdict posted', async () => {
  const { app, posts, calls } = harness({ githubMode: 'mint-fails', boardComments: [goComment(HASH)] })
  const res = await delivery(app, payload())
  const body = await res.json()
  assert.equal(body.state, 'rejected')
  assert.equal(body.reason, REASON.CLAIM_MISSING)
  assert.equal(body.callback_posted, false)
  assert.equal(posts.length, 0) // both mints failed, so no review could be delivered
  assert.equal(calls.mint, 2) // slow-path mint plus one best-effort rejection mint, same identity
})

// A callback URL naming another run is refused before any token travels: the
// run id in the URL must equal the run just reviewed. Slow path (up-front
// gate, no mint) and fast path (verdict-post binding, no post) both refuse.
test('callback URL naming another run is refused with 400 and posts nothing', async () => {
  const { app, posts, calls } = await approvedHarness()
  const other = `https://api.github.com/repos/${REPO}/actions/runs/999/deployment_protection_rule`
  const res = await delivery(app, payload({ deployment_callback_url: other }))
  const body = await res.json()
  assert.equal(res.status, 400)
  assert.equal(posts.length, 0)
  assert.equal(calls.mint, 0)
  void body
})

test('fast-path callback URL naming another run is refused with 400 and posts nothing', async () => {
  const { app, posts } = harness({ boardComments: [goComment(HASH)] })
  const other = `https://api.github.com/repos/${REPO}/actions/runs/999/deployment_protection_rule`
  const res = await delivery(app, payload({ environment: 'fixture-unserved', deployment_callback_url: other }))
  const body = await res.json()
  assert.equal(res.status, 400)
  assert.equal(posts.length, 0)
  void body
})

// sha mode rows: production deploys carry no plan artifact. The GO binds the
// exact head SHA on the environment's own card — a GO on any other card
// approves nothing, and a GO on this card for another SHA approves nothing.
test('sha mode: configured approver GO for the exact head SHA posts approved once', async () => {
  const { app, posts, calls } = harness({ boardCommentsByIssue: { [SHA_ISSUE]: [goComment(HEAD)] } })
  const res = await delivery(app, shaPayload())
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.state, 'approved')
  assert.equal(body.reason, REASON.APPROVED)
  assert.equal(body.callback_posted, true)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].state, 'approved')
  assert.equal(posts[0].environment_name, SHA_ENVIRONMENT)
  assert.equal(calls.mint, 1)
})

test('sha mode: GO on the wrong card approves nothing', async () => {
  // The GO sits on the plan card, not this environment's card.
  const { app, posts } = harness({ boardCommentsByIssue: { [PLAN_ISSUE]: [goComment(HEAD)] } })
  const body = await (await delivery(app, shaPayload())).json()
  assert.equal(body.state, 'rejected')
  assert.equal(body.reason, REASON.GO_SHA_MISSING)
  assert.deepEqual(posts.map((p) => p.state), ['rejected'])
})

test('sha mode: GO for another SHA approves nothing', async () => {
  const { app, posts } = harness({ boardCommentsByIssue: { [SHA_ISSUE]: [goComment('d'.repeat(40))] } })
  const body = await (await delivery(app, shaPayload())).json()
  assert.equal(body.state, 'rejected')
  assert.equal(body.reason, REASON.GO_SHA_MISSING)
  assert.deepEqual(posts.map((p) => p.state), ['rejected'])
})

test('sha mode: a plan-hash GO does not approve a production delivery', async () => {
  // The SHA card carries only a 64-hex plan-hash GO: the sha scanner reads
  // nothing from it, so the delivery rejects.
  const { app, posts } = harness({ boardCommentsByIssue: { [SHA_ISSUE]: [goComment(HASH)] } })
  const body = await (await delivery(app, shaPayload())).json()
  assert.equal(body.state, 'rejected')
  assert.equal(body.reason, REASON.GO_SHA_MISSING)
  assert.deepEqual(posts.map((p) => p.state), ['rejected'])
})

test('health is unauthenticated and says nothing about configuration', async () => {
  const { app } = harness()
  const res = await app(new Request('https://protection-rule.example.invalid/health'))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, service: 'protection-rule' })
})

test('unknown path is 404', async () => {
  const { app } = harness()
  const res = await app(new Request('https://protection-rule.example.invalid/elsewhere'))
  assert.equal(res.status, 404)
})

function assertConfigurationRefused(trustedConfig) {
  let calls = 0
  const touched = async () => { calls++; throw new Error('configuration must refuse before transport') }
  assert.throws(() => createApp({
    webhookSecret: SECRET, appId: APP_ID, appPrivateKey: APP_KEY,
    boardToken: BOARD_TOKEN, boardOrigin: BOARD_ORIGIN,
    trustedConfig, fetchImpl: touched, mintToken: touched,
  }), { name: 'Error' }, 'unconfigured authority must refuse construction')
  assert.equal(calls, 0, 'configuration refusal must not touch a transport')
}

test('unconfigured trusted input cannot construct an authorizer', () => {
  for (const trustedConfig of [undefined, null, {}, [], 'request-selected']) assertConfigurationRefused(trustedConfig)
})
test('unconfigured policy cannot construct an authorizer', () => {
  for (const policies of [undefined, null, []]) {
    assertConfigurationRefused({ ...TRUSTED_CONFIG, policies, reviewedPlanRepositories: [] })
  }
})
test('unconfigured approver cannot construct an authorizer', () => {
  for (const approverAgentId of [undefined, null, '', 'request-selected']) {
    assertConfigurationRefused({ ...TRUSTED_CONFIG, approverAgentId })
  }
})
test('unconfigured reviewed plan scope cannot construct an authorizer', () => {
  for (const reviewedPlanRepositories of [undefined, null, [], ['ForeignOrg/unreviewed']]) {
    assertConfigurationRefused({ ...TRUSTED_CONFIG, reviewedPlanRepositories })
  }
})
test('unconfigured installation allowlist cannot construct an authorizer', () => {
  for (const installationIds of [undefined, null, [], [0]]) assertConfigurationRefused({ ...TRUSTED_CONFIG, installationIds })
})
test('foreign repository cannot supply trusted policy through a signed webhook', async () => {
  const foreign = 'ForeignOrg/unreviewed'
  const { app, posts, calls } = await approvedHarness()
  const res = await delivery(app, payload({
    repository: { full_name: foreign },
    deployment_callback_url: CALLBACK.replace(REPO, foreign),
    policies: [{ ...PLAN_POLICY, repository: foreign }],
    reviewedPlanRepositories: [foreign],
    trustedConfig: { ...TRUSTED_CONFIG, policies: [{ ...PLAN_POLICY, repository: foreign }], reviewedPlanRepositories: [foreign] },
  }))
  assert.equal(res.status, 400, 'foreign webhook must not expand trusted repository scope')
  assert.equal(calls.mint, 0)
  assert.equal(calls.run, 0)
  assert.equal(calls.board, 0)
  assert.equal(posts.length, 0)
})
test('foreign installation refuses before minting despite signed caller allowlist', async () => {
  const { app, posts, calls } = await approvedHarness()
  const res = await delivery(app, payload({ installation: { id: 9002 }, installationIds: [9002] }))
  assert.equal(res.status, 400)
  assert.equal(calls.mint, 0)
  assert.equal(calls.run, 0)
  assert.equal(posts.length, 0)
})
test('callback identity naming a foreign repository refuses before minting', async () => {
  const { app, posts, calls } = await approvedHarness()
  const res = await delivery(app, payload({ deployment_callback_url: CALLBACK.replace(REPO, 'ForeignOrg/unserved') }))
  assert.equal(res.status, 400, 'foreign callback identity must not receive an approval')
  assert.equal(calls.mint, 0)
  assert.equal(posts.length, 0)
})
test('caller approver and card fields cannot authorize another agent GO', async () => {
  const { app, posts } = harness({ boardCommentsByIssue: { [SHA_ISSUE]: [goComment(HEAD, { authorAgentId: OTHER_AGENT_ID })] } })
  const res = await delivery(app, shaPayload({
    approverAgentId: OTHER_AGENT_ID, goIssueId: PLAN_ISSUE,
    policy: { ...SHA_POLICY, goIssueId: PLAN_ISSUE },
    trustedConfig: { ...TRUSTED_CONFIG, approverAgentId: OTHER_AGENT_ID },
  }))
  const body = await res.json()
  assert.equal(body.state, 'rejected')
  assert.deepEqual(posts.map((post) => post.state), ['rejected'])
})
test('trusted configured approver replaces fixture identity; caller identity never does', async () => {
  const trustedConfig = { ...TRUSTED_CONFIG, approverAgentId: OTHER_AGENT_ID }
  for (const [authorAgentId, state] of [[APPROVER_AGENT_ID, 'rejected'], [OTHER_AGENT_ID, 'approved']]) {
    const { app, posts } = harness({
      appOverrides: { trustedConfig },
      boardCommentsByIssue: { [SHA_ISSUE]: [goComment(HEAD, { authorAgentId })] },
    })
    const body = await (await delivery(app, shaPayload())).json()
    assert.equal(body.state, state)
    assert.deepEqual(posts.map((post) => post.state), [state])
  }
})
test('runtime caller mutation cannot change pinned policy, identity or scope', async () => {
  const trustedConfig = freshConfig()
  const { app, posts } = harness({
    appOverrides: { trustedConfig },
    boardCommentsByIssue: { [SHA_ISSUE]: [goComment(HEAD)] },
  })
  trustedConfig.policies[1].goIssueId = PLAN_ISSUE
  trustedConfig.policies[1].repository = 'ForeignOrg/unreviewed'
  trustedConfig.approverAgentId = OTHER_AGENT_ID
  trustedConfig.installationIds[0] = 9002
  trustedConfig.reviewedPlanRepositories[0] = 'ForeignOrg/unreviewed'
  const body = await (await delivery(app, shaPayload())).json()
  assert.equal(body.state, 'approved', 'original reviewed snapshot must remain in force')
  assert.deepEqual(posts.map((post) => post.state), ['approved'])
})
test('an explicitly reviewed synthetic plan repository works without a hidden repo pin', async () => {
  const repository = 'FixtureOrg/second-apply'
  const policy = { ...PLAN_POLICY, repository, environment: 'fixture-second-apply', goIssueId: '00000000-0000-4000-8000-000000000014' }
  const trustedConfig = { ...TRUSTED_CONFIG, policies: [policy], reviewedPlanRepositories: [repository] }
  const { app, posts } = await approvedHarness({ appOverrides: { trustedConfig } })
  const body = await (await delivery(app, payload({
    repository: { full_name: repository }, environment: policy.environment,
    deployment_callback_url: CALLBACK.replace(REPO, repository),
  }))).json()
  assert.equal(body.state, 'approved')
  assert.deepEqual(posts.map((post) => post.state), ['approved'])
})
test('forged and body-tampered deliveries never reach a transport', async () => {
  const text = JSON.stringify(payload())
  const cases = [
    [text, await sign('different-synthetic-secret', text)],
    [JSON.stringify(payload({ extra: 'tampered' })), await sign(SECRET, text)],
  ]
  for (const [body, signature] of cases) {
    const { app, posts, calls } = harness()
    const res = await delivery(app, body, { signature })
    assert.equal(res.status, 401)
    assert.equal(calls.mint, 0)
    assert.equal(calls.run, 0)
    assert.equal(calls.board, 0)
    assert.equal(posts.length, 0)
  }
})
test('callback failure never reports an approval as delivered', async () => {
  const { app, posts } = await approvedHarness({ githubMode: 'callback-fails' })
  const res = await delivery(app, payload())
  const body = await res.json()
  assert.equal(res.status, 502)
  assert.equal(body.state, 'approved')
  assert.equal(body.callback_posted, false)
  assert.equal(body.ok, false)
  assert.equal(posts.length, 1)
})
test('failed board read and artifact byte mismatch reject without approval fallback', async () => {
  for (const githubMode of ['board-fails', 'plan-hash-mismatch', 'plan-missing-artifact']) {
    const { app, posts } = await approvedHarness({ githubMode })
    const body = await (await delivery(app, payload())).json()
    assert.equal(body.state, 'rejected')
    assert.deepEqual(posts.map((post) => post.state), ['rejected'])
  }
})
