import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCaptureAdapter } from '../src/capture-adapter.js'
import { createConsumer } from '../src/consumer.js'
import { createApp } from '../src/app.js'
import { createMemoryStore } from '../src/store-memory.js'
import { ingest, agentPr, repository } from './bridge-fixtures.mjs'

const repo = repository.full_name
const sha = 'a'.repeat(40)
const base = 'https://capture.test'
const token = 'TEST-PRIVATE-CREDENTIAL'
const timestamp = 1700000000000
const pr = { ...agentPr, head: { ...agentPr.head, sha }, title: 'Bridge', body: '', state: 'open', merged: false }
// Explicit trusted operator inputs: the adapter and app take no policy defaults.
const BRIDGE_POLICY = Object.freeze({ trackerPrefix: 'TASK', agentLogin: 'capture-agent[bot]' })
function harness(options = {}) {
  const store = createMemoryStore()
  const h = { time: timestamp, calls: [] }
  h.app = createApp({ store, webhookSecret: 'test', queryToken: token, now: () => h.time,
    bridgePolicy: BRIDGE_POLICY, allowedRepositories: [repo] })
  h.adapter = createCaptureAdapter({ baseUrl: base, queryToken: token, allowedRepositories: [repo], pageSize: 2,
    bridgePolicy: BRIDGE_POLICY,
    fetchImpl: async (url, init) => {
      h.calls.push({ url, init })
      return h.app(new Request(url, init))
    }, ...options })
  h.prEvent = async (id, value = pr, extra = {}) => ingest(h.app, 'pull_request', id,
    { action: 'opened', repository, pull_request: value, ...extra })
  h.suiteEvent = async (id) => ingest(h.app, 'check_suite', id,
    { action: 'completed', repository, check_suite: { status: 'completed', head_sha: sha, pull_requests: [{ number: 42 }] } })
  return h
}
const json = (body, init = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init })
function stub(responses, options = {}) {
  const calls = []
  const adapter = createCaptureAdapter({ baseUrl: base, queryToken: token, allowedRepositories: [repo], pageSize: 2,
    bridgePolicy: BRIDGE_POLICY,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      assert.ok(responses.length, 'unexpected transport retry')
      return responses.shift()
    }, ...options })
  return { adapter, calls }
}
const row = (id, ms = timestamp) => ({ delivery_id: id, received_ms: ms, repository: repo, event: 'pull_request',
  body_truncated: 0, body: JSON.stringify({ repository, pull_request: pr }) })
const metadata = (id, ms) => { const { body, ...rest } = row(id, ms); return rest }
const page = (rows, next_cursor = null) => ({ count: rows.length, events: rows, next_cursor })

test('real capture API pagination traverses timestamp ties and the terminal empty page', async () => {
  const h = harness()
  for (const id of ['a', 'b', 'c', 'd']) await h.prEvent(id)
  await h.suiteEvent('suite')
  const rows = await h.adapter.listDeliveries({ repository: repo, event: 'pull_request' })
  assert.deepEqual(rows.map((r) => r.delivery_id), ['d', 'c', 'b', 'a'])
  assert.equal(h.calls.length, 3)
  assert.equal(rows.every((r) => !Object.hasOwn(r, 'body')), true)
  assert.equal(new URL(h.calls[1].url).searchParams.get('cursor'), `${timestamp}.c`)
  assert.equal(new URL(h.calls[2].url).searchParams.get('cursor'), `${timestamp}.a`)
  for (const { url, init } of h.calls) {
    assert.equal(url.includes(token), false)
    assert.equal(init.headers.authorization, `Bearer ${token}`)
    assert.equal(init.redirect, 'manual')
    assert.equal(init.credentials, 'omit')
    assert.equal(init.cache, 'no-store')
    assert.ok(init.signal instanceof AbortSignal)
    assert.equal(init.method, 'GET')
  }
})

test('time-window bounds are inclusive and each scan starts from newest, not a saved maximum', async () => {
  const h = harness()
  await h.prEvent('a')
  h.time++; await h.prEvent('b')
  h.time++; await h.prEvent('c')
  const filtered = await h.adapter.listDeliveries({ repository: repo, event: 'pull_request', sinceMs: timestamp + 1, untilMs: timestamp + 1 })
  assert.deepEqual(filtered.map((r) => r.delivery_id), ['b'])
  await h.adapter.listDeliveries({ repository: repo, event: 'pull_request' })
  h.time = timestamp; await h.prEvent('late-insert')
  const replay = await h.adapter.listDeliveries({ repository: repo, event: 'pull_request' })
  assert.ok(replay.some((r) => r.delivery_id === 'late-insert'))
  assert.equal(replay.length, 4)
})

test('missing, duplicate, out-of-order and filtered-out rows refuse a successful scan', async () => {
  const a = metadata('a'), b = metadata('b')
  const cases = [
    {}, { events: [] }, { count: 1, events: [] , next_cursor: null },
    page([a], `${timestamp}.a`), page([b, a]),
    page([a, b], `${timestamp}.b`), page([a, a], `${timestamp}.a`),
    page([{ ...a, repository: 'Other/repo' }]), page([{ ...a, event: 'push' }]),
    page([{ ...a, received_ms: '1700000000000' }]), page([{ ...a, delivery_id: '' }]),
  ]
  for (const result of cases) {
    const { adapter } = stub([json(result)])
    await assert.rejects(adapter.listDeliveries({ repository: repo, event: 'pull_request' }))
  }
  const crossPage = stub([json(page([b, a], `${timestamp}.a`)), json(page([a]))])
  await assert.rejects(crossPage.adapter.listDeliveries({ repository: repo, event: 'pull_request' }), /order/)
  const outsideWindow = stub([json(page([a]))])
  await assert.rejects(outsideWindow.adapter.listDeliveries({ repository: repo, event: 'pull_request', sinceMs: timestamp + 1 }), /filters/)
})

test('page budget fails loudly even when a full final page might have been the last one', async () => {
  const h = harness({ maxPages: 1 })
  await h.prEvent('a'); await h.prEvent('b')
  await assert.rejects(h.adapter.listDeliveries({ repository: repo, event: 'pull_request' }), /budget/)
  assert.equal(h.calls.length, 1)
  const empty = harness({ maxPages: 1 })
  assert.deepEqual(await empty.adapter.listDeliveries({ repository: repo, event: 'pull_request' }), [])
})

test('getDelivery fetches complete stored body and refuses wrong identity/scope/invalid JSON', async () => {
  const h = harness()
  await h.prEvent('delivery')
  const result = await h.adapter.getDelivery('delivery')
  assert.equal(JSON.parse(result.body).pull_request.head.sha, sha)
  assert.equal(result.body_truncated, 0)
  for (const result of [null, { ...row('delivery'), delivery_id: 'other' },
    { ...row('delivery'), repository: 'Other/repo' }, { ...row('delivery'), event: 'push' },
    { ...row('delivery'), body_truncated: 1 }, { ...row('delivery'), body: undefined },
    { ...row('delivery'), body: '{PRIVATE' }, { ...row('delivery'), body: 'null' },
    { ...row('delivery'), body: '[]' }, { ...row('delivery'), body: '{}' },
    { ...row('delivery'), body: JSON.stringify({ repository: { full_name: 'Other/repo' } }) },
  ]) {
    const { adapter } = stub([json(result)])
    await assert.rejects(adapter.getDelivery('delivery'))
  }
})

test('PR evidence lookup paginates and skips mismatched author, number, repository and SHA', async () => {
  const h = harness()
  await h.prEvent('a-good')
  await h.prEvent('b-human', { ...pr, user: { login: 'human' } })
  await h.prEvent('c-other-number', { ...pr, number: 43 })
  await h.prEvent('d-other-sha', { ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } })
  await h.prEvent('e-other-repo', { ...pr, base: { repo: { full_name: 'Other/repo' } } })
  const result = await h.adapter.getPullRequestDelivery(repo, 42, sha)
  assert.equal(result.delivery_id, 'a-good')
  assert.equal(h.calls.filter((c) => new URL(c.url).pathname === '/events').length, 3)
  const missing = await h.adapter.getPullRequestDelivery(repo, 99, sha)
  assert.equal(missing, null)
})

test('evidence lookup refuses truncated candidates instead of claiming absence', async () => {
  const entry = metadata('a')
  const { adapter } = stub([json(page([entry])), json({ ...row('a'), body_truncated: 1 })])
  await assert.rejects(adapter.getPullRequestDelivery(repo, 42, sha), /incomplete/)
})

test('merge wake claim uses stored source scope and real route deduplication', async () => {
  const h = harness()
  await h.prEvent('merge', { ...pr, state: 'closed', merged: true }, { action: 'closed' })
  const claim = { issue_ref: 'TASK-3552', head_sha: sha, kind: 'pull_request_merged', delivery_id: 'merge', arbitrary: 'PRIVATE' }
  const result = await h.adapter.claim(claim)
  assert.deepEqual(result, { ok: true, claimed: true, claim_key: `TASK-3552|${sha}|pull_request_merged` })
  assert.equal((await h.adapter.claim(claim)).claimed, false)
  const writes = h.calls.filter((c) => c.init.method === 'POST')
  assert.equal(writes.length, 2)
  assert.equal(Object.hasOwn(JSON.parse(writes[0].init.body), 'arbitrary'), false)
  await assert.rejects(h.adapter.claim({ ...claim, issue_ref: 'TASK-9' }))
})

test('suite claims require stored matching PR evidence and preserve genuine claim after a rejection', async () => {
  const h = harness()
  await h.prEvent('evidence'); await h.suiteEvent('suite')
  const claim = { issue_ref: 'TASK-3552', head_sha: sha, kind: 'check_suite_completed', delivery_id: 'suite' }
  await assert.rejects(h.adapter.claim(claim), /ID/)
  assert.equal(h.calls.filter((c) => c.init.method === 'POST').length, 0)
  await h.prEvent('human-evidence', { ...pr, user: { login: 'human' } })
  await assert.rejects(h.adapter.claim({ ...claim, pr_delivery_id: 'human-evidence' }))
  assert.equal((await h.adapter.claim({ ...claim, pr_delivery_id: 'evidence' })).claimed, true)
  assert.equal((await h.adapter.claim({ ...claim, pr_delivery_id: 'evidence' })).claimed, false)
})

test('out-of-scope wake sources and wrong event types cause no write', async () => {
  for (const source of [{ ...row('source'), repository: 'Other/repo' }, { ...row('source'), event: 'check_suite' }]) {
    const { adapter, calls } = stub([json(source)])
    await assert.rejects(adapter.claim({ issue_ref: 'TASK-3552', head_sha: sha, kind: 'pull_request_merged', delivery_id: 'source' }))
    assert.equal(calls.filter((c) => c.init.method === 'POST').length, 0)
  }
})

test('valid other-repository deliveries are rejected solely by the configured scope', async () => {
  const otherRepo = 'Other/repo'
  const source = { ...row('source'), repository: otherRepo,
    body: JSON.stringify({ repository: { full_name: otherRepo }, pull_request: {
      ...pr, merged: true, base: { repo: { full_name: otherRepo } },
    } }) }
  const closed = stub([json(source)])
  await assert.rejects(closed.adapter.getDelivery('source'), /scope/)
  const allowed = stub([json(source)], { allowedRepositories: [repo, otherRepo] })
  assert.equal((await allowed.adapter.getDelivery('source')).repository, otherRepo)
})

test('claim response must explicitly confirm kind/head key and boolean outcome', async () => {
  for (const response of [{}, { ok: true, claimed: true, claim_key: 'wrong' },
    { ok: true, claimed: 'true', claim_key: `TASK-3552|${sha}|pull_request_merged` }]) {
    const { adapter, calls } = stub([json(row('source')), json(response)])
    await assert.rejects(adapter.claim({ issue_ref: 'TASK-3552', head_sha: sha, kind: 'pull_request_merged', delivery_id: 'source' }), /confirm/)
    assert.equal(calls.length, 2)
  }
})

test('HTTP failures, redirects, partial success, wrong content types and malformed JSON are redacted without retry', async () => {
  for (const response of [json({ error: token }, { status: 401 }), json({ error: token }, { status: 404 }),
    json({ error: token }, { status: 503 }), json(row('a'), { status: 206 }),
    new Response(token, { status: 302, headers: { location: `https://attacker.test/${token}` } }),
    new Response(token, { headers: { 'content-type': 'text/html' } }),
    new Response(token, { headers: { 'content-type': 'application/json' } }),
  ]) {
    const { adapter, calls } = stub([response])
    await assert.rejects(adapter.getDelivery('a'), (error) => {
      assert.equal(error.stack.includes(token), false)
      assert.equal(Object.hasOwn(error, 'cause'), false)
      return true
    })
    assert.equal(calls.length, 1)
  }
})

test('declared and streaming body limits reject otherwise valid deliveries', async () => {
  const text = JSON.stringify(row('a'))
  const bytes = new TextEncoder().encode(text)
  const response = (length) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 20))
    controller.enqueue(bytes.slice(20))
    controller.close()
  } }), { headers: { 'content-type': 'application/json', ...(length === null ? {} : { 'content-length': length }) } })
  // With a budget larger than the valid row, its dishonest declared length is
  // the only rejection reason. Without a length, count actual streamed bytes.
  for (const [length, budget] of [[String(bytes.length * 3), bytes.length * 2], ['NaN', bytes.length * 2], [null, 32]]) {
    const { adapter } = stub([response(length)], { maxResponseBytes: budget })
    await assert.rejects(adapter.getDelivery('a'), /request failed/)
  }
  const control = stub([response(null)], { maxResponseBytes: bytes.length })
  assert.equal((await control.adapter.getDelivery('a')).delivery_id, 'a')
})

test('request deadline aborts before headers and while reading a partial body', async () => {
  for (const streamPhase of [false, true]) {
    let aborted = false
    const adapter = createCaptureAdapter({ baseUrl: base, queryToken: token, allowedRepositories: [repo], timeoutMs: 20,
      bridgePolicy: BRIDGE_POLICY,
      fetchImpl: async (url, { signal }) => {
        if (!streamPhase) return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => { aborted = true; reject(new Error(token)) }, { once: true })
        })
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{'))
          signal.addEventListener('abort', () => { aborted = true; controller.error(new Error(token)) }, { once: true })
        } }), { headers: { 'content-type': 'application/json' } })
      },
    })
    await assert.rejects(adapter.getDelivery('a'), /timed out/)
    assert.equal(aborted, true)
  }
})

test('aborted claim response is not retried and replay sees the already-recorded intent', async () => {
  const h = harness()
  await h.prEvent('merge', { ...pr, merged: true }, { action: 'closed' })
  let writes = 0
  const adapter = createCaptureAdapter({ baseUrl: base, queryToken: token, allowedRepositories: [repo],
    bridgePolicy: BRIDGE_POLICY,
    fetchImpl: async (url, init) => {
      const response = await h.app(new Request(url, init))
      if (init.method === 'POST' && ++writes === 1) throw new Error(token)
      return response
    },
  })
  const claim = { issue_ref: 'TASK-3552', head_sha: sha, kind: 'pull_request_merged', delivery_id: 'merge' }
  await assert.rejects(adapter.claim(claim), /request failed/)
  assert.equal(writes, 1)
  assert.equal((await adapter.claim(claim)).claimed, false)
})

test('consumer plus capture transport reconciles a PR and deduplicates suite and merge wakes', async () => {
  const h = harness()
  const current = { ...structuredClone(pr), reviewDecision: 'APPROVED' }
  const products = []
  const comments = []
  const consumer = createConsumer({ capture: h.adapter, allowedRepositories: [repo], bridgePolicy: BRIDGE_POLICY,
    github: { async getPullRequest() { return structuredClone(current) } }, board: {
      async getIssue() { return { id: 'issue', identifier: 'TASK-3552', status: 'in_progress',
        assigneeAgentId: 'engineer', assigneeUserId: null, blockedBy: [] } },
      async listInteractions() { return [] },
      async listWorkProducts() { return structuredClone(products) },
      async createWorkProduct(id, body) { products.push({ id: 'product', ...body }); return products[0] },
      async updateWorkProduct(id, body) { Object.assign(products[0], body); return products[0] },
      // Contract double only: this does NOT install an atomic board operation.
      async commentIfEligible(id, body) { comments.push(body); return { sent: true, comment: { id: 'comment' } } },
    },
  })
  await h.prEvent('opened')
  await consumer.processDelivery(await h.adapter.getDelivery('opened'))
  await h.suiteEvent('suite')
  const suite = await h.adapter.getDelivery('suite')
  assert.deepEqual((await consumer.processDelivery(suite)).wakes, ['sent'])
  assert.deepEqual((await consumer.processDelivery(suite)).wakes, ['duplicate'])
  current.state = 'closed'; current.merged = true
  await h.prEvent('merged', current, { action: 'closed' })
  const merged = await h.adapter.getDelivery('merged')
  assert.deepEqual((await consumer.processDelivery(merged)).wakes, ['sent'])
  assert.deepEqual((await consumer.processDelivery(merged)).wakes, ['duplicate'])
  assert.equal(comments.length, 2)
  assert.equal(products.length, 1)
  assert.equal(products[0].status, 'merged')
  assert.equal(products[0].reviewState, 'approved')
})

test('invalid configuration/selectors fail before any request and never reveal configuration contents', async () => {
  const good = { baseUrl: base, queryToken: token, allowedRepositories: [repo], bridgePolicy: BRIDGE_POLICY }
  for (const config of [{ baseUrl: `https://user:${token}@capture.test` }, { baseUrl: `https://capture.test/?token=${token}` },
    { baseUrl: 'http://capture.test' }, { baseUrl: 'https://capture.test/path' }, { baseUrl: token },
    { queryToken: '' }, { queryToken: 'bad\nvalue' }, { allowedRepositories: [] }, { allowedRepositories: ['bad'] },
    { maxPages: 0 }, { maxPages: 1001 }, { pageSize: 0 }, { pageSize: 501 }, { timeoutMs: 0 }, { maxResponseBytes: 0 },
  ]) assert.throws(() => createCaptureAdapter({ ...good, ...config }), (e) => !e.stack.includes(token))
  const { adapter, calls } = stub([])
  for (const selector of [{ repository: 'Other/repo', event: 'pull_request' }, { repository: repo, event: 'push' },
    { repository: repo, event: 'pull_request', sinceMs: 2, untilMs: 1 },
    { repository: repo, event: 'pull_request', sinceMs: 'invalid' },
    { repository: repo, event: 'pull_request', since: timestamp },
    null, [],
  ]) await assert.rejects(adapter.listDeliveries(selector))
  for (const id of ['', '../escape', 'id\n', null]) await assert.rejects(adapter.getDelivery(id))
  await assert.rejects(adapter.getPullRequestDelivery(repo, 0, sha))
  await assert.rejects(adapter.getPullRequestDelivery(repo, 42, 'bad'))
  await assert.rejects(adapter.claim({ kind: 'work_product_create' }))
  assert.equal(calls.length, 0)
})
