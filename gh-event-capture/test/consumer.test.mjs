import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConsumer } from '../src/consumer.js'
import { createApp } from '../src/app.js'
import { createMemoryStore } from '../src/store-memory.js'
import { ingest, agentPr, repository } from './bridge-fixtures.mjs'

const repo = repository.full_name
const sha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)
const clone = (value) => structuredClone(value)
// Explicit trusted operator inputs: the app takes no policy defaults.
const BRIDGE_POLICY = Object.freeze({ trackerPrefix: 'TASK', agentLogin: 'capture-agent[bot]' })

function harness(mode = 'full-v1') {
  const h = {
    pr: { ...agentPr, title: 'A bridge PR', head: { ...agentPr.head, sha },
      state: 'open', draft: false, merged: false, reviewDecision: null },
    issue: { id: 'issue-3552', identifier: 'TASK-3552', status: 'in_progress',
      assigneeAgentId: 'engineer', assigneeUserId: null, blockedBy: [] },
    interactions: [], products: [], comments: [], claims: [], writes: [], githubReads: 0,
    evidence: null, onClaim: null, beforeComment: null, failComment: false,
  }
  h.store = createMemoryStore()
  const app = createApp({ store: h.store, webhookSecret: 'test', queryToken: 'test',
    bridgePolicy: BRIDGE_POLICY, allowedRepositories: [repo] })
  const github = { async getPullRequest() { h.githubReads++; return clone(h.pr) } }
  h.board = {
    async getIssue() { return clone(h.issue) },
    async listInteractions() { return clone(h.interactions) },
    async listWorkProducts() { return clone(h.products) },
    async createWorkProduct(issueId, body) {
      h.writes.push('create')
      const p = { ...clone(body), id: 'product-' + h.products.length, issueId }
      h.products.push(p)
      return clone(p)
    },
    async updateWorkProduct(id, body) {
      h.writes.push('update')
      const p = h.products.find((p) => p.id === id)
      Object.assign(p, clone(body))
      return clone(p)
    },
    // Contract double, NOT an implementation of the missing atomic server
    // operation. Deliberately models state changing at the instant of posting.
    async commentIfEligible(id, body) {
      h.beforeComment?.()
      if (h.failComment) throw new Error('comment transport failed')
      if (!['todo', 'in_progress', 'in_review'].includes(h.issue.status) ||
          h.issue.blockedBy.some((b) => b.status !== 'done') ||
          h.interactions.some((i) => i.status === 'pending') || !h.issue.assigneeAgentId || h.issue.assigneeUserId !== null) {
        return { sent: false }
      }
      const comment = { id: 'comment-' + h.comments.length, ...body }
      h.comments.push(comment)
      return { sent: true, comment }
    },
  }
  h.capture = {
    async getPullRequestDelivery() { return h.evidence && await h.store.get(h.evidence) },
    async claim(body) {
      h.claims.push(clone(body))
      const res = await app(new Request('https://capture.test/bridge/claim', {
        method: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify(body),
      }))
      if (!res.ok) throw new Error('claim HTTP ' + res.status)
      const result = await res.json()
      h.onClaim?.()
      return result
    },
  }
  h.consumer = createConsumer({ github, board: h.board, capture: h.capture, allowedRepositories: [repo], mode,
    bridgePolicy: BRIDGE_POLICY })
  h.prEvent = async (id, action, pr = h.pr) => {
    await ingest(app, 'pull_request', id, { action, repository, pull_request: clone(pr) })
    h.evidence = id
    return await h.store.get(id)
  }
  h.suiteEvent = async (id, overrides = {}) => {
    await ingest(app, 'check_suite', id, { action: 'completed', repository,
      check_suite: { status: 'completed', head_sha: sha, pull_requests: [{ number: 42 }], ...overrides } })
    return await h.store.get(id)
  }
  return h
}

test('backfill bounds the complete input before effects and honors asynchronous cancellation', async () => {
  const h = harness('products-only-v1')
  const ref = { repository: repo, number: h.pr.number }
  await assert.rejects(h.consumer.backfill(Array(51).fill(ref)), /bounded batch/)
  assert.equal(h.githubReads, 0)
  for (const maxItems of [0, -1, 10001, NaN]) await assert.rejects(h.consumer.backfill([ref], { maxItems }))
  await assert.rejects(h.consumer.backfill([ref], { isStopped: () => true }), /stopped/)
  await assert.rejects(h.consumer.backfill([ref], { beforeItem: async () => { await Promise.resolve(); throw new Error('cancelled') } }), /cancelled/)
  assert.equal(h.githubReads, 0)
  assert.equal(h.products.length, 0)
  assert.deepEqual(await h.consumer.backfill(Array(50).fill(ref)), { reconciled: 1 })
  assert.equal(h.githubReads, 1)
  let turns = 0
  await assert.rejects(h.consumer.backfill([ref, ref], { beforeItem: async () => { turns++ }, isStopped: () => turns === 2 }), /stopped/)
  assert.equal(h.githubReads, 2, 'stop before second candidate, even a duplicate')
  assert.equal(h.claims.length, 0)
  assert.equal(h.comments.length, 0)
})

test('products-only mode reconciles merged and suite events without any wake dependency', async () => {
  for (const status of ['in_progress', 'blocked', 'done']) {
    const h = harness('products-only-v1')
    h.issue.status = status
    h.interactions = [{ status: 'pending' }]
    let forbiddenCalls = 0
    const forbidden = async () => { forbiddenCalls++; throw new Error('wake dependency must not be called') }
    h.board.listInteractions = forbidden
    h.board.commentIfEligible = forbidden
    h.capture.claim = forbidden
    h.capture.getPullRequestDelivery = forbidden
    h.pr.reviewDecision = 'CHANGES_REQUESTED'
    const suite = await h.consumer.processDelivery(await h.suiteEvent('suite'))
    assert.deepEqual(suite, { reconciled: 1, wakes: ['disabled-by-policy'] })
    assert.equal(h.products[0].reviewState, 'changes_requested')
    h.pr.merged = true
    h.pr.state = 'closed'
    const merged = await h.consumer.processDelivery(await h.prEvent('merge', 'closed'))
    assert.deepEqual(merged, { reconciled: 1, wakes: ['disabled-by-policy'] })
    assert.equal(h.products.length, 1)
    assert.equal(h.products[0].status, 'merged')
    assert.equal(forbiddenCalls, 0)
    assert.deepEqual(h.comments, [])
    assert.deepEqual(h.claims, [])
  }
})

test('an unknown consumer mode is rejected rather than becoming an implicit no-wake mode', () => {
  assert.throws(() => harness('products-only'), /mode/)
  assert.equal(harness().consumer.mode, 'full-v1')
})

test('open/reopen/synchronize/close reconcile one work product and preserve unrelated metadata', async () => {
  const h = harness()
  await h.consumer.processDelivery(await h.prEvent('open', 'opened'))
  assert.equal(h.products.length, 1)
  assert.equal(h.products[0].status, 'active')
  assert.equal(h.products[0].externalId, `${repo}#42`)
  h.products[0].metadata.operatorNote = 'keep'
  h.pr.draft = true
  await h.consumer.processDelivery(await h.prEvent('draft', 'converted_to_draft'))
  assert.equal(h.products[0].status, 'draft')
  h.pr.draft = false
  h.pr.head.sha = otherSha
  h.pr.reviewDecision = 'CHANGES_REQUESTED'
  await h.consumer.processDelivery(await h.prEvent('sync', 'synchronize'))
  assert.equal(h.products[0].metadata.headSha, otherSha)
  assert.equal(h.products[0].reviewState, 'changes_requested')
  h.pr.state = 'closed'
  await h.consumer.processDelivery(await h.prEvent('close', 'closed'))
  assert.equal(h.products[0].status, 'closed')
  h.pr.state = 'open'
  h.pr.reviewDecision = 'APPROVED'
  await h.consumer.processDelivery(await h.prEvent('reopen', 'reopened'))
  assert.equal(h.products[0].status, 'active')
  assert.equal(h.products[0].reviewState, 'approved')
  assert.equal(h.products[0].metadata.operatorNote, 'keep')
  assert.equal(h.products.length, 1)
  assert.deepEqual(h.writes, ['create', 'update', 'update', 'update', 'update'])
  assert.deepEqual(h.claims, [])
  assert.deepEqual(h.comments, [])
})

test('authoritative reviewDecision maps every value, while missing/unknown verdicts refuse writes', async () => {
  const h = harness()
  for (const [source, destination] of [['APPROVED', 'approved'], ['CHANGES_REQUESTED', 'changes_requested'],
    ['REVIEW_REQUIRED', 'needs_board_review'], [null, 'none']]) {
    h.pr.reviewDecision = source
    await h.consumer.backfill([{ repository: repo, number: 42 }])
    assert.equal(h.products[0].reviewState, destination)
  }
  const writes = h.writes.length
  for (const value of [undefined, 'unreviewed', 'draft']) {
    h.pr.reviewDecision = value
    await assert.rejects(h.consumer.backfill([{ repository: repo, number: 42 }]), /reviewDecision/)
  }
  assert.equal(h.writes.length, writes)
})

test('redelivery repairs a failed or lost product update without generating a second row', async () => {
  const h = harness()
  const row = await h.prEvent('open', 'opened')
  const create = h.board.createWorkProduct
  h.board.createWorkProduct = async (...args) => { await create(...args); throw new Error('response lost') }
  await assert.rejects(h.consumer.processDelivery(row), /response lost/)
  h.board.createWorkProduct = create
  await h.consumer.processDelivery(row)
  assert.equal(h.products.length, 1)
  assert.deepEqual(h.writes, ['create', 'update'])
  assert.equal(h.claims.length, 0)
})

test('a delayed old open event reconciles current merged state, not its stale webhook snapshot', async () => {
  const h = harness()
  const row = await h.prEvent('old-open', 'opened')
  h.pr.state = 'closed'; h.pr.merged = true; h.pr.reviewDecision = 'APPROVED'
  await h.consumer.processDelivery(row)
  assert.equal(h.products[0].status, 'merged')
  assert.equal(h.products[0].reviewState, 'approved')
  assert.equal(h.comments.length, 0)
})

test('several suites and redelivery emit one wake per head; merging emits its independent wake', async () => {
  const h = harness()
  await h.prEvent('evidence', 'opened')
  const first = await h.suiteEvent('suite-1')
  assert.deepEqual((await h.consumer.processDelivery(first)).wakes, ['sent'])
  assert.deepEqual((await h.consumer.processDelivery(first)).wakes, ['duplicate'])
  assert.deepEqual((await h.consumer.processDelivery(await h.suiteEvent('suite-2'))).wakes, ['duplicate'])
  h.pr.state = 'closed'; h.pr.merged = true
  const merged = await h.prEvent('merge', 'closed')
  assert.deepEqual((await h.consumer.processDelivery(merged)).wakes, ['sent'])
  assert.deepEqual((await h.consumer.processDelivery(merged)).wakes, ['duplicate'])
  assert.equal(h.comments.length, 2)
  assert.equal((await h.store.listBridgeClaims({ limit: 50 })).length, 2)
  assert.equal(h.products.length, 1)
  assert.equal(h.products[0].status, 'merged')
})

test('duplicate slim PR references in one suite are processed once', async () => {
  const h = harness()
  await h.prEvent('evidence', 'opened')
  const row = await h.suiteEvent('suite', { pull_requests: [{ number: 42 }, { number: 42 }] })
  assert.deepEqual(await h.consumer.processDelivery(row), { reconciled: 1, wakes: ['sent'] })
  assert.equal(h.githubReads, 1)
})

test('blocked, terminal, backlog, unassigned and pending-interaction cards reconcile but never claim or wake', async () => {
  for (const change of [
    (h) => { h.issue.status = 'blocked' }, (h) => { h.issue.status = 'done' },
    (h) => { h.issue.status = 'cancelled' }, (h) => { h.issue.status = 'backlog' },
    (h) => { h.issue.assigneeAgentId = null }, (h) => { h.issue.assigneeUserId = 'operator' },
    (h) => { h.issue.blockedBy = [{ status: 'in_progress' }] },
    (h) => { h.interactions = [{ status: 'pending', effectiveResolverPolicy: 'anyone' }] },
    (h) => { h.interactions = [{ status: 'pending', effectiveResolverPolicy: 'human_only' }] },
  ]) {
    const h = harness(); change(h)
    h.pr.state = 'closed'; h.pr.merged = true
    const result = await h.consumer.processDelivery(await h.prEvent('merge', 'closed'))
    assert.deepEqual(result.wakes, ['ineligible'])
    assert.equal(h.products[0].status, 'merged')
    assert.equal(h.claims.length, 0)
    assert.equal(h.comments.length, 0)
  }
})

test('resolved blockers and terminal interactions do not suppress an otherwise eligible wake', async () => {
  const h = harness()
  h.issue.blockedBy = [{ status: 'done' }]
  h.interactions = [{ status: 'accepted' }, { status: 'rejected' }, { status: 'expired' }]
  h.pr.state = 'closed'; h.pr.merged = true
  assert.deepEqual((await h.consumer.processDelivery(await h.prEvent('merge', 'closed'))).wakes, ['sent'])
})

test('eligibility changing during claim or at post consumes at most one claim without a comment', async () => {
  for (const hook of ['onClaim', 'beforeComment']) {
    const h = harness(); h.pr.state = 'closed'; h.pr.merged = true
    h[hook] = () => { h.interactions = [{ status: 'pending' }] }
    const row = await h.prEvent('merge', 'closed')
    const outcome = await h.consumer.processDelivery(row)
    assert.deepEqual(outcome.wakes, [hook === 'onClaim' ? 'ineligible-after-claim' : 'ineligible-at-post'])
    assert.equal(h.comments.length, 0)
    assert.equal((await h.store.listBridgeClaims({ limit: 50 })).length, 1)
  }
})

test('missing atomic comment capability refuses before spending a wake claim', async () => {
  const h = harness(); h.pr.state = 'closed'; h.pr.merged = true
  delete h.board.commentIfEligible
  await assert.rejects(h.consumer.processDelivery(await h.prEvent('merge', 'closed')), /atomic eligibility/)
  assert.equal(h.claims.length, 0)
})

test('failed comment transport is loud; replay cannot duplicate a possibly sent wake', async () => {
  const h = harness(); h.pr.state = 'closed'; h.pr.merged = true; h.failComment = true
  const row = await h.prEvent('merge', 'closed')
  await assert.rejects(h.consumer.processDelivery(row), /comment transport failed/)
  h.failComment = false
  assert.deepEqual((await h.consumer.processDelivery(row)).wakes, ['duplicate'])
  assert.equal(h.comments.length, 0)
})

test('stale head or changed issue binding reconciles current product but never claims the old wake', async () => {
  for (const changeBinding of [true, false]) {
    const h = harness(); h.pr.state = 'closed'; h.pr.merged = true
    const row = await h.prEvent('merge', 'closed')
    if (changeBinding) {
      h.pr.head.ref = 'task-9-new-binding'
      h.issue.identifier = 'TASK-9'; h.issue.id = 'issue-9'
    } else h.pr.head.sha = otherSha
    assert.deepEqual((await h.consumer.processDelivery(row)).wakes, ['stale'])
    assert.equal(h.products.length, 1)
    assert.equal(h.claims.length, 0)
  }
})

test('suite without stored bot evidence fails loudly; providing genuine evidence makes retry executable', async () => {
  const h = harness()
  const row = await h.suiteEvent('suite')
  await assert.rejects(h.consumer.processDelivery(row), /evidence is missing/)
  assert.equal(h.claims.length, 0)
  await h.prEvent('evidence', 'opened')
  assert.deepEqual((await h.consumer.processDelivery(row)).wakes, ['sent'])
  assert.equal(h.products.length, 1)
})

test('suite evidence from wrong PR, repository, author or head cannot claim', async () => {
  for (const override of [{ number: 99 }, { base: { repo: { full_name: 'Other/repo' } } },
    { user: { login: 'human' } }, { head: { ...agentPr.head, sha: otherSha } }]) {
    const h = harness()
    await h.prEvent('wrong-evidence', 'opened', { ...h.pr, ...override })
    await assert.rejects(h.consumer.processDelivery(await h.suiteEvent('suite')), /evidence does not match/)
    assert.equal(h.claims.length, 0)
  }
})

test('backfill deduplicates references, adopts URL-only products, and never fabricates event claims', async () => {
  const h = harness()
  h.products = [{ id: 'old-product', type: 'pull_request', provider: 'github', url: h.pr.html_url,
    metadata: { operatorNote: 'preserve' } }]
  const refs = [{ repository: repo, number: 42 }, { repository: repo, number: 42 }]
  assert.deepEqual(await h.consumer.backfill(refs), { reconciled: 1 })
  assert.equal(h.products.length, 1)
  assert.equal(h.products[0].id, 'old-product')
  assert.equal(h.products[0].externalId, `${repo}#42`)
  assert.equal(h.products[0].metadata.operatorNote, 'preserve')
  assert.equal(h.claims.length, 0)
  assert.equal(h.comments.length, 0)
})

test('ambiguous duplicate work products or conflicting identity refuse automatic repair', async () => {
  for (const products of [
    [{ id: 'a', externalId: `${repo}#42` }, { id: 'b', url: agentPr.html_url }],
    [{ id: 'a', externalId: `${repo}#42`, url: agentPr.html_url + '-wrong' }],
    [{ id: 'a', externalId: 'Other/repo#42', url: agentPr.html_url }],
  ]) {
    const h = harness()
    h.products = products.map((p) => ({ type: 'pull_request', provider: 'github', ...p }))
    await assert.rejects(h.consumer.backfill([{ repository: repo, number: 42 }]), /multiple|conflicts/)
    assert.deepEqual(h.writes, [])
  }
})

test('out-of-scope repository fails before GitHub I/O; malformed GitHub identity fails before board writes', async () => {
  const h = harness()
  await assert.rejects(h.consumer.backfill([{ repository: 'Other/repo', number: 42 }]), /scope/)
  assert.equal(h.githubReads, 0)
  for (const change of [
    { number: 99 }, { html_url: 'https://attacker.example/pull/42' },
    { head: { ref: agentPr.head.ref, sha: 'not-a-sha' } }, { state: 'unknown' },
    { draft: undefined }, { merged: undefined }, { title: '' },
  ]) {
    const f = harness(); Object.assign(f.pr, change)
    await assert.rejects(f.consumer.backfill([{ repository: repo, number: 42 }]))
    assert.deepEqual(f.writes, [])
  }
})

test('reconcile resolves by task link, not authorship: a human-authored PR with a branch ref reconciles', async () => {
  const h = harness('products-only-v1')
  const row = await h.prEvent('bot-at-capture', 'opened')
  h.pr.user = { login: 'human' }
  const result = await h.consumer.processDelivery(row)
  assert.deepEqual(result, { reconciled: 1, wakes: ['disabled-by-policy'] })
  assert.equal(h.githubReads, 1)
  assert.equal(h.products.length, 1)
  assert.deepEqual(h.claims, [])
})

test('PRs with no task link do not create work products, regardless of author', async () => {
  for (const change of [{ head: { ref: 'no-card', sha } },
    { head: { ref: 'no-card', sha }, user: { login: 'human' } }]) {
    const h = harness(); Object.assign(h.pr, change)
    h.pr.title = 'No issue'
    assert.deepEqual(await h.consumer.backfill([{ repository: repo, number: 42 }]), { reconciled: 0 })
    assert.deepEqual(h.writes, [])
  }
})

test('unconfirmed product writes and malformed board snapshots fail before wake claims', async () => {
  for (const change of [
    (h) => { h.board.createWorkProduct = async () => ({}) },
    (h) => { h.board.getIssue = async () => ({ id: 'wrong', identifier: 'TASK-9' }) },
    (h) => { h.board.listInteractions = async () => ({ items: [] }) },
    (h) => { h.interactions = [{}] },
    (h) => { h.interactions = [{ status: 'unknown' }] },
    (h) => { h.interactions = [null] },
    (h) => { delete h.issue.blockedBy },
  ]) {
    const h = harness(); change(h); h.pr.state = 'closed'; h.pr.merged = true
    await assert.rejects(h.consumer.processDelivery(await h.prEvent('merge', 'closed')))
    assert.equal(h.claims.length, 0)
  }
})

test('unconfirmed claim responses fail without posting a wake', async () => {
  for (const response of [{}, { ok: true, claimed: true, claim_key: 'wrong' }, { ok: true, claimed: 'yes' }]) {
    const h = harness(); h.pr.state = 'closed'; h.pr.merged = true
    h.capture.claim = async () => response
    await assert.rejects(h.consumer.processDelivery(await h.prEvent('merge', 'closed')), /confirm the wake claim/)
    assert.equal(h.comments.length, 0)
  }
})

test('wake text never echoes untrusted PR titles or bodies and carries no reopen/resume intent', async () => {
  const h = harness(); h.pr.state = 'closed'; h.pr.merged = true
  h.pr.title = '@everyone [@Other Agent](agent://other)'; h.pr.body = 'TASK-999'
  await h.consumer.processDelivery(await h.prEvent('merge', 'closed'))
  assert.equal(h.comments.length, 1)
  assert.equal(h.comments[0].body.includes('@'), false)
  assert.equal(h.comments[0].body.includes('TASK-999'), false)
  assert.equal(h.comments[0].body.includes(sha), true)
  assert.equal(Object.hasOwn(h.comments[0], 'resume'), false)
  assert.equal(Object.hasOwn(h.comments[0], 'reopen'), false)
})

test('malformed/truncated deliveries fail before I/O and unscoped events do nothing', async () => {
  const h = harness()
  for (const row of [
    { event: 'pull_request', delivery_id: 'd', body_truncated: 1, body: '{}' },
    { event: 'pull_request', delivery_id: 'd', body_truncated: 0, body: '{' },
    { event: 'pull_request', delivery_id: 'd', body_truncated: 0, body: 'null' },
  ]) await assert.rejects(h.consumer.processDelivery(row))
  assert.deepEqual(await h.consumer.processDelivery({ event: 'push' }), { ignored: 'unscoped-event' })
  assert.equal(h.githubReads, 0)
})
