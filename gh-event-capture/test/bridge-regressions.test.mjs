// Reproductions for TASK-3618 and TASK-3786. No credentials or network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPullRequestEvent, classifyCheckSuiteEvent, claimKey } from '../src/bridge.js'
import { createApp } from '../src/app.js'
import { createMemoryStore } from '../src/store-memory.js'
import { seedClaim, ingest, agentPr, repository } from './bridge-fixtures.mjs'

const pr = {
  number: 42,
  html_url: 'https://github.com/ExampleOrg/example-repo/pull/42',
  user: { login: 'togetherweown[bot]' },
  head: { ref: 'task-3552-bridge', sha: 'abc123' },
  base: { repo: { full_name: 'ExampleOrg/example-repo' } },
  draft: false,
}
const suite = {
  repository: { full_name: 'ExampleOrg/example-repo' },
  check_suite: { status: 'completed', head_sha: 'abc123', pull_requests: [{ number: 42, head: pr.head }] },
}

function work(action, deliveryId, overrides = {}) {
  return { ...classifyPullRequestEvent({ action, pull_request: { ...pr, ...overrides } }), deliveryId }
}

test('work claims distinguish action, PR, delivery, and wake effect at the same SHA', () => {
  const sync = work('synchronize', 'push-1')
  const merged = work('closed', 'merge-1', { merged: true })
  const wake = { ...merged, kind: 'pull_request_merged' }
  const keys = [
    claimKey(sync), claimKey(merged), claimKey(wake),
    claimKey(work('edited', 'edit-1')),
    claimKey(work('edited', 'edit-2')),
    claimKey(work('synchronize', 'push-1', { number: 43, html_url: pr.html_url.replace('/42', '/43') })),
  ]
  assert.equal(new Set(keys).size, keys.length)
  assert.equal(claimKey(sync), claimKey({ ...sync }))
  assert.equal(claimKey(wake), claimKey({ ...wake, deliveryId: 'retry-merge' }))
  assert.throws(() => claimKey({ ...sync, deliveryId: undefined }), /delivery/)
  assert.throws(() => claimKey({ ...sync, url: undefined }), /url/)
  assert.throws(() => claimKey({ ...sync, action: undefined }), /action/)
})

test('claim route uses the same keys and allows sync, merged update, and merge wake independently', async () => {
  const app = createApp({ store: createMemoryStore(), webhookSecret: 'test', queryToken: 'test', now: () => 1 })
  async function claim(c) {
    const res = await app(new Request('https://capture.test/bridge/claim', {
      method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ issue_ref: c.issueRef, head_sha: c.headSha, kind: c.kind,
        delivery_id: c.deliveryId, pr_url: c.url, action: c.action }),
    }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.claim_key, claimKey(c))
    return body.claimed
  }
  const sync = work('synchronize', 'push-1')
  const merged = work('closed', 'merge-1', { merged: true })
  for (const c of [sync, merged, { ...merged, deliveryId: 'retry' }]) {
    await seedClaim(app, { issue_ref: c.issueRef, head_sha: c.headSha, kind: c.kind,
      delivery_id: c.deliveryId, pr_url: c.url, action: c.action })
  }
  assert.equal(await claim(sync), true)
  assert.equal(await claim(sync), false)
  assert.equal(await claim(merged), true)
  assert.equal(await claim({ ...merged, kind: 'pull_request_merged' }), true)
  assert.equal(await claim({ ...merged, kind: 'pull_request_merged', deliveryId: 'retry' }), false)
})

test('suite wakes require an author-verified PR at the exact repository and head', () => {
  assert.deepEqual(classifyCheckSuiteEvent(suite), [])
  assert.deepEqual(classifyCheckSuiteEvent(suite, [{ ...pr, user: { login: 'human' } }]), [])
  assert.deepEqual(classifyCheckSuiteEvent(suite, [{ ...pr, head: { ...pr.head, sha: 'older-head' } }]), [])
  assert.deepEqual(classifyCheckSuiteEvent(suite, [{ ...pr, base: { repo: { full_name: 'Other/repo' } } }]), [])
  assert.deepEqual(classifyCheckSuiteEvent(suite, [{ ...pr, number: 99 }]), [])
  assert.equal(classifyCheckSuiteEvent(suite, [pr]).length, 1)
})

test('unknown review verdicts are omitted rather than overwriting existing approvals', () => {
  for (const action of ['opened', 'reopened', 'synchronize', 'edited', 'ready_for_review']) {
    const decision = work(action, 'test')
    assert.equal(Object.hasOwn(decision, 'reviewState'), false)
    for (const previous of ['approved', 'changes_requested']) {
      assert.equal({ reviewState: previous, ...decision }.reviewState, previous)
    }
  }
  const draft = work('converted_to_draft', 'draft', { draft: true })
  assert.equal(draft.status, 'draft')
  assert.equal(Object.hasOwn(draft, 'reviewState'), false)
})

function claimRequest(body) {
  return new Request('https://capture.test/bridge/claim', {
    method: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify(body),
  })
}
function claimHarness() {
  const store = createMemoryStore()
  const app = createApp({ store, webhookSecret: 'test', queryToken: 'test' })
  return { store, app }
}
const mergeClaim = { issue_ref: 'TASK-3552', head_sha: 'abc123', kind: 'pull_request_merged', delivery_id: 'merge' }

test('all PR transitions emit Paperclip statuses and never invent review verdicts', () => {
  for (const action of ['opened', 'reopened', 'synchronize', 'edited', 'ready_for_review', 'converted_to_draft', 'closed']) {
    for (const draft of [true, false]) {
      for (const merged of [true, false]) {
        const d = work(action, 'test', { draft, merged })
        assert.equal(d.status, action === 'closed' ? (merged ? 'merged' : 'closed') : (draft ? 'draft' : 'active'))
        assert.equal(Object.hasOwn(d, 'reviewState'), false)
      }
    }
  }
})

test('claims reject missing deliveries and mismatched PR effects without consuming the genuine wake', async () => {
  const { app, store } = claimHarness()
  await seedClaim(app, mergeClaim)
  await ingest(app, 'push', 'unrelated', { repository })
  await ingest(app, 'pull_request', 'not-merged', { action: 'closed', pull_request: agentPr })
  await ingest(app, 'pull_request', 'human', { action: 'closed', pull_request: { ...agentPr, merged: true, user: { login: 'human' } } })
  const invalid = [
    [{ delivery_id: 'typo' }, 404],
    [{ delivery_id: 'unrelated' }, 400],
    [{ delivery_id: 'not-merged' }, 400],
    [{ delivery_id: 'human' }, 400],
    [{ issue_ref: 'TASK-9' }, 400],
    [{ head_sha: 'wrong-head' }, 400],
    [{ kind: 'check_suite_completed' }, 400],
    [{ kind: 'work_product_create', pr_url: agentPr.html_url, action: 'closed' }, 400],
    [{ kind: 'work_product_update', pr_url: agentPr.html_url, action: 'edited' }, 400],
    [{ kind: 'work_product_update', pr_url: agentPr.html_url + '-wrong', action: 'closed' }, 400],
  ]
  for (const [overrides, status] of invalid) {
    const res = await app(claimRequest({ ...mergeClaim, ...overrides }))
    assert.equal(res.status, status, JSON.stringify(overrides))
    assert.equal((await store.listBridgeClaims({ limit: 50 })).length, 0)
  }
  assert.equal((await (await app(claimRequest(mergeClaim))).json()).claimed, true)
  assert.equal((await (await app(claimRequest(mergeClaim))).json()).claimed, false)
})

test('malformed and truncated stored bodies cannot claim an effect', async () => {
  const { app, store } = claimHarness()
  for (const [id, body, truncated] of [
    ['broken', '{', 0], ['null', 'null', 0],
    ['truncated', JSON.stringify({ action: 'closed', pull_request: { ...agentPr, merged: true } }), 1],
  ]) {
    await store.append({ delivery_id: id, event: 'pull_request', body, body_truncated: truncated })
    assert.equal((await app(claimRequest({ ...mergeClaim, delivery_id: id }))).status, 400)
  }
  assert.equal((await store.listBridgeClaims({ limit: 50 })).length, 0)
  await seedClaim(app, mergeClaim)
  assert.equal((await (await app(claimRequest(mergeClaim))).json()).claimed, true)
})

test('suite claims require stored matching bot PR evidence and an eligible suite', async () => {
  const { app, store } = claimHarness()
  const claim = { ...mergeClaim, kind: 'check_suite_completed', delivery_id: 'suite' }
  await seedClaim(app, claim)
  for (const [id, override] of [
    ['human', { user: { login: 'human' } }],
    ['other-repo', { base: { repo: { full_name: 'Other/repo' } } }],
    ['old-head', { head: { ...agentPr.head, sha: 'old' } }],
    ['other-pr', { number: 99 }],
    ['other-issue', { head: { ...agentPr.head, ref: 'task-9-work' } }],
  ]) {
    await ingest(app, 'pull_request', id, { action: 'opened', pull_request: { ...agentPr, ...override } })
    assert.equal((await app(claimRequest({ ...claim, pr_delivery_id: id }))).status, 400, id)
  }
  assert.equal((await app(claimRequest({ ...claim, pr_delivery_id: undefined }))).status, 400)
  assert.equal((await app(claimRequest({ ...claim, pr_delivery_id: 'missing' }))).status, 404)
  assert.equal((await app(claimRequest({ ...claim, pr_delivery_id: 'suite' }))).status, 400)
  for (const status of ['queued', 'in_progress']) {
    await ingest(app, 'check_suite', status, { ...suite, check_suite: { ...suite.check_suite, status } })
    assert.equal((await app(claimRequest({ ...claim, delivery_id: status }))).status, 400)
  }
  assert.equal((await store.listBridgeClaims({ limit: 50 })).length, 0)
  assert.equal((await (await app(claimRequest(claim))).json()).claimed, true)
  const retry = { ...claim, delivery_id: 'retry' }
  await seedClaim(app, retry)
  assert.equal((await (await app(claimRequest(retry))).json()).claimed, false)
})

test('claim listing rejects unknown, duplicate, malformed and out-of-range filters before store access', async () => {
  const seen = []
  const app = createApp({ queryToken: 'test', store: {
    async listBridgeClaims(filters) { seen.push(filters); return [] },
  } })
  for (const query of ['event=push', 'limti=5', 'limit=0', 'limit=501', 'limit=9999', 'limit=-1',
    'limit=1.5', 'limit=', 'limit=1&limit=2', 'issue_ref=TASK-1&issue_ref=TASK-2', 'issue_ref=no']) {
    const res = await app(new Request('https://capture.test/bridge/claims?' + query, { headers: { authorization: 'Bearer test' } }))
    assert.equal(res.status, 400, query)
  }
  assert.deepEqual(seen, [])
  for (const query of ['', 'limit=1&issue_ref=TASK-3552', 'limit=500']) {
    const res = await app(new Request('https://capture.test/bridge/claims?' + query, { headers: { authorization: 'Bearer test' } }))
    assert.equal(res.status, 200)
  }
  assert.deepEqual(seen, [{ issueRef: null, limit: 50 }, { issueRef: 'TASK-3552', limit: 1 }, { issueRef: null, limit: 500 }])
})
