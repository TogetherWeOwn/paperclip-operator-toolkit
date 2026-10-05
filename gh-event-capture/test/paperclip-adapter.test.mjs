import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPaperclipAdapter } from './trusted-fixtures.mjs'
import { createConsumer } from './trusted-fixtures.mjs'

const companyId = '00000000-0000-4000-8000-000000000105'
const issueId = '00000000-0000-4000-8000-000000000104'
const productId = '00000000-0000-4000-8000-000000000102'
const otherId = '00000000-0000-4000-8000-000000000100'
const runId = '00000000-0000-4000-8000-000000000101'
const repo = 'example-owner/project'
const sha = 'a'.repeat(40)
const token = 'TEST-PRIVATE-BOARD-KEY'
const issue = { id: issueId, companyId, identifier: 'TASK-3552', status: 'done' }
const body = { type: 'pull_request', provider: 'github', title: 'Bridge PR',
  url: `https://github.com/${repo}/pull/42`, externalId: `${repo}#42`, status: 'active', reviewState: 'none',
  metadata: { repo, number: 42, headSha: sha, headRef: 'task-3552-bridge' } }
const product = { ...body, id: productId, companyId, issueId }
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json', ...headers } })
function harness(responses = [], options = {}) {
  const calls = []
  const adapter = createPaperclipAdapter({ baseUrl: 'https://board.test', token, companyId,
    allowedRepositories: [repo], runId, fetchImpl: async (url, init) => {
      calls.push({ url, init })
      assert.ok(responses.length, 'unexpected request or automatic retry')
      const value = responses.shift()
      if (value instanceof Error) throw value
      return typeof value === 'function' ? value(url, init) : value
    }, ...options })
  return { adapter, calls }
}

test('exact product routes, fields and audit header; no comment or wake capability', async () => {
  const h = harness([json(issue), json([]), json(product, 201), json({ ...product, status: 'merged' })])
  assert.deepEqual(Object.keys(h.adapter).sort(), ['createWorkProduct', 'getIssue', 'listWorkProducts', 'updateWorkProduct'])
  assert.deepEqual(await h.adapter.getIssue('TASK-3552'), { id: issueId, identifier: issue.identifier, companyId })
  assert.deepEqual(await h.adapter.listWorkProducts(issueId), [])
  await h.adapter.createWorkProduct(issueId, { ...body, assigneeAgentId: otherId, reopen: true, createdByRunId: otherId })
  await h.adapter.updateWorkProduct(productId, { ...body, status: 'merged' })
  assert.deepEqual(h.calls.map((c) => [c.init.method, new URL(c.url).pathname]), [
    ['GET', '/api/issues/TASK-3552'], ['GET', `/api/issues/${issueId}/work-products`],
    ['POST', `/api/issues/${issueId}/work-products`], ['PATCH', `/api/work-products/${productId}`],
  ])
  assert.deepEqual(JSON.parse(h.calls[2].init.body), body)
  for (const { url, init } of h.calls) {
    assert.equal(url.includes(token), false)
    assert.equal(init.headers.authorization, `Bearer ${token}`)
    assert.equal(init.redirect, 'manual')
    assert.equal(init.credentials, 'omit')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.headers['X-Paperclip-Run-Id'], init.method === 'GET' ? undefined : runId)
  }
})

test('cross-company/mismatched/malformed issue responses are rejected before writes', async () => {
  for (const bad of [{ ...issue, companyId: otherId }, { ...issue, identifier: 'TASK-7' },
    { ...issue, id: 'not-uuid' }, { ...issue, identifier: null }, null]) {
    const h = harness([json(bad)])
    await assert.rejects(h.adapter.getIssue('TASK-3552'), /identity/)
    await assert.rejects(h.adapter.createWorkProduct(issueId, body), /resolved/)
    assert.equal(h.calls.length, 1)
  }
  const h = harness([json({ ...issue, id: otherId })])
  await assert.rejects(h.adapter.getIssue(issueId), /identity/)
  await assert.rejects(h.adapter.getIssue('../comments'), /selector/)
  assert.equal(h.calls.length, 1)
})

test('complete lists reject envelopes, wrong company/issue, duplicates and missing fields', async () => {
  for (const rows of [{ products: [] }, [product, product], [{ ...product, companyId: otherId }],
    [{ ...product, issueId: otherId }], [{ ...product, reviewState: undefined }],
    [{ ...product, metadata: [] }], [{ ...product, externalId: undefined }]]) {
    const h = harness([json(issue), json(rows)])
    await h.adapter.getIssue(issueId)
    await assert.rejects(h.adapter.listWorkProducts(issueId))
    await assert.rejects(h.adapter.updateWorkProduct(productId, body), /listed/)
    assert.equal(h.calls.length, 2)
  }
})

test('complete lists have no implicit 100-row cap, but enforce explicit product budget', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ ...product,
    id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}` }))
  const h = harness([json(issue), json(rows)])
  await h.adapter.getIssue(issueId)
  assert.equal((await h.adapter.listWorkProducts(issueId)).length, 101)
  const small = harness([json(issue), json(rows)], { maxProducts: 100 })
  await small.adapter.getIssue(issueId)
  await assert.rejects(small.adapter.listWorkProducts(issueId), /budget/)
})

test('only previously listed github PRs can be updated; refresh removes stale bindings', async () => {
  const h = harness([json(issue), json([{ ...product, type: 'branch' }]), json([product]), json([])])
  await h.adapter.getIssue(issueId)
  await h.adapter.listWorkProducts(issueId)
  await assert.rejects(h.adapter.updateWorkProduct(productId, body), /listed/)
  await h.adapter.listWorkProducts(issueId)
  await h.adapter.listWorkProducts(issueId)
  await assert.rejects(h.adapter.updateWorkProduct(productId, body), /listed/)
  assert.equal(h.calls.length, 4)
})

test('write scope and canonical PR identities are checked before network I/O', async () => {
  const h = harness([json(issue)])
  await h.adapter.getIssue(issueId)
  for (const patch of [{ type: 'branch' }, { provider: 'other' }, { url: 'https://attacker.test' },
    { externalId: `${repo}#43` }, { metadata: { ...body.metadata, repo: 'Other/repo' } },
    { metadata: { ...body.metadata, headSha: 'bad' } }, { reviewState: 'draft' }, { status: 'open' }, { title: '' }]) {
    await assert.rejects(h.adapter.createWorkProduct(issueId, { ...body, ...patch }))
  }
  await assert.rejects(h.adapter.listWorkProducts(otherId), /resolved/)
  assert.equal(h.calls.length, 1)
})

test('create and patch require exact product/company/issue and confirmed field echoes', async () => {
  for (const patch of [{ issueId: otherId }, { companyId: otherId }, { status: 'closed' },
    { url: 'https://attacker.test' }, { reviewState: 'approved' }, { metadata: { ...body.metadata, headSha: 'b'.repeat(40) } }]) {
    const h = harness([json(issue), json({ ...product, ...patch }, 201)])
    await h.adapter.getIssue(issueId)
    await assert.rejects(h.adapter.createWorkProduct(issueId, body))
    assert.equal(h.calls.length, 2)
  }
  const h = harness([json(issue), json([product]), json({ ...product, id: otherId })])
  await h.adapter.getIssue(issueId)
  await h.adapter.listWorkProducts(issueId)
  await assert.rejects(h.adapter.updateWorkProduct(productId, body), /confirm/)
})

test('HTTP/parse/redirect failures and provider exceptions are redacted without retries', async () => {
  for (const response of [json({ error: token }, 403), json(issue, 206), json(issue, 201),
    new Response(token, { status: 302, headers: { location: 'https://other.test', 'content-type': 'application/json' } }),
    new Response(token, { headers: { 'content-type': 'text/html' } }),
    new Response(token, { headers: { 'content-type': 'application/json' } }), new Error(token)]) {
    const h = harness([response])
    await assert.rejects(h.adapter.getIssue(issueId), (e) => {
      assert.equal(e.message.includes(token), false)
      assert.equal(e.cause, undefined)
      assert.match(e.message, /Paperclip request/)
      return true
    })
    assert.equal(h.calls.length, 1)
  }
})

test('declared and streamed byte limits reject otherwise valid data, exact budget succeeds', async () => {
  const length = Buffer.byteLength(JSON.stringify(issue))
  const control = harness([json(issue)], { maxResponseBytes: length })
  assert.equal((await control.adapter.getIssue(issueId)).id, issueId)
  for (const [response, budget] of [[json(issue, 200, { 'content-length': String(length + 1) }), length],
    [json(issue), length - 1]]) {
    const h = harness([response], { maxResponseBytes: budget })
    await assert.rejects(h.adapter.getIssue(issueId), /request failed/)
  }
})

test('deadlines remain active during headers and response body reads', async () => {
  for (const phase of ['headers', 'body']) {
    const h = harness([], { timeoutMs: 10, fetchImpl: async (url, { signal }) => {
      if (phase === 'headers') return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error(token)), { once: true })
      })
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        signal.addEventListener('abort', () => controller.error(new Error(token)), { once: true })
      } }), { headers: { 'content-type': 'application/json' } })
    } })
    await assert.rejects(h.adapter.getIssue(issueId), /timed out/)
  }
})

function fakeBoard(options = {}) {
  const h = { products: [], calls: [], loseCreate: options.loseCreate ?? false }
  h.fetch = async (url, init) => {
    const path = new URL(url).pathname
    h.calls.push([init.method, path])
    if (init.method === 'GET' && ['/api/issues/TASK-3552', `/api/issues/${issueId}`].includes(path)) return json(issue)
    if (init.method === 'GET' && path === `/api/issues/${issueId}/work-products`) return json(h.products)
    if (init.method === 'POST' && path === `/api/issues/${issueId}/work-products`) {
      const p = { ...JSON.parse(init.body), id: productId, companyId, issueId }
      h.products.push(p)
      if (h.loseCreate) { h.loseCreate = false; throw new Error('lost response '+token) }
      return json(p, 201)
    }
    if (init.method === 'PATCH' && path === `/api/work-products/${productId}`) {
      Object.assign(h.products[0], JSON.parse(init.body))
      return json(h.products[0])
    }
    assert.fail('unexpected route: '+path)
  }
  h.pr = { number: 42, html_url: body.url, user: { type: 'Bot', login: 'capture-agent[bot]' },
    head: { ref: 'task-3552-bridge', sha }, base: { repo: { full_name: repo } },
    title: 'Bridge PR', state: 'open', draft: false, merged: false, reviewDecision: null }
  h.adapter = createPaperclipAdapter({ baseUrl: 'https://board.test', token, companyId,
    allowedRepositories: [repo], fetchImpl: h.fetch })
  h.consumer = createConsumer({ board: h.adapter, github: { async getPullRequest() { return h.pr } },
    allowedRepositories: [repo], mode: 'products-only-v1' })
  h.delivery = (action = 'opened') => ({ delivery_id: 'a', event: 'pull_request', body_truncated: 0,
    body: JSON.stringify({ action, repository: { full_name: repo }, pull_request: h.pr }) })
  return h
}

test('real core plus HTTP contract double recovers a lost create response into one product', async () => {
  const h = fakeBoard({ loseCreate: true })
  await assert.rejects(h.consumer.processDelivery(h.delivery()), /Paperclip request/)
  assert.equal(h.products.length, 1)
  assert.equal(h.calls.filter(([method]) => method === 'POST').length, 1)
  await h.consumer.processDelivery(h.delivery())
  assert.equal(h.products.length, 1)
  assert.equal(h.calls.filter(([method]) => method === 'POST').length, 1)
  h.products[0].metadata.operatorNote = 'preserve'
  h.pr.merged = true; h.pr.state = 'closed'; h.pr.reviewDecision = 'APPROVED'
  const result = await h.consumer.processDelivery(h.delivery('closed'))
  assert.deepEqual(result.wakes, ['disabled-by-policy'])
  assert.equal(h.products[0].status, 'merged')
  assert.equal(h.products[0].reviewState, 'approved')
  assert.equal(h.products[0].metadata.operatorNote, 'preserve')
  assert.equal(h.calls.some(([, path]) => /comments|wakeup|bridge\/claim/.test(path)), false)
})

test('in-memory Request/Response transport handles product writes with non-waking routes only', async () => {
  const h = fakeBoard()
  const adapter = createPaperclipAdapter({ baseUrl: 'http://127.0.0.1:3100', token,
    companyId, allowedRepositories: [repo], fetchImpl: async (url, init) => {
      const request = new Request(url, init)
      assert.equal(request.headers.get('authorization'), `Bearer ${token}`)
      assert.equal(request.redirect, 'manual')
      const body = init.body === undefined ? undefined : await request.text()
      const response = await h.fetch(request.url, { method: request.method, body })
      return new Response(await response.text(), { status: response.status, headers: response.headers })
    } })
  await adapter.getIssue('TASK-3552')
  await adapter.listWorkProducts(issueId)
  assert.equal((await adapter.createWorkProduct(issueId, body)).id, productId)
  assert.equal((await adapter.updateWorkProduct(productId, { ...body, reviewState: 'approved' })).reviewState, 'approved')
  assert.equal(h.products.length, 1)
  assert.deepEqual(h.calls.map(([method]) => method), ['GET', 'GET', 'POST', 'PATCH'])
  assert.equal(h.calls.some(([, path]) => /comments|wakeup|bridge\/claim/.test(path)), false)
})

test('configuration failures redact secrets and refuse unsafe origins', () => {
  for (const options of [{ baseUrl: 'http://remote.test' }, { baseUrl: `https://${token}@board.test` },
    { baseUrl: 'https://board.test/api' }, { baseUrl: 'https://board.test?token='+token },
    { token: '' }, { companyId: 'bad' }, { runId: 'bad' }, { allowedRepositories: [] }, { timeoutMs: 0 },
    { maxResponseBytes: 0 }, { maxProducts: 0 }]) {
    assert.throws(() => harness([], options), (e) => !e.message.includes(token))
  }
})
