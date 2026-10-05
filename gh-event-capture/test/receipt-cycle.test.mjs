import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { withReceiptStore } from '../src/receipt-store.js'
import { runReceiptCycle, receiptNamespace, deliveryFingerprint } from '../src/receipt-cycle.js'
import { createCaptureAdapter } from '../src/capture-adapter.js'
import { createConsumer } from '../src/consumer.js'
import { createApp } from '../src/app.js'
import { createMemoryStore } from '../src/store-memory.js'
import { ingest, agentPr, repository } from './bridge-fixtures.mjs'

const repo = repository.full_name
const digest = (value) => createHash('sha256').update(value).digest('hex')
const config = { captureOrigin: 'https://capture.test', boardOrigin: 'http://127.0.0.1:3100',
  companyId: '12345678-1234-4234-8234-123456789abc', allowedRepositories: [repo], mode: 'full-v1' }
const namespace = receiptNamespace(config)
async function storage(t, options = {}) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'bridge-receipts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'state')
  return { root, directory, use: (fn) => withReceiptStore({ directory, namespace, ...options }, fn) }
}
const row = (id, time = 1000, event = 'pull_request') => {
  const body = JSON.stringify({ repository, action: 'opened', pull_request: agentPr })
  return { delivery_id: id, received_ms: time, repository: repo, event, body, body_truncated: 0, body_sha256: digest(body) }
}
function harness(rows = []) {
  const h = { rows, lists: [], reads: [], effects: [] }
  h.capture = {
    async listDeliveries(query) {
      h.lists.push(query)
      return h.rows.filter((r) => r.repository === query.repository && r.event === query.event)
    },
    async getDelivery(id) { h.reads.push(id); return h.rows.find((r) => r.delivery_id === id) },
  }
  h.consumer = { mode: 'full-v1', async processDelivery(r) { h.effects.push(r.delivery_id); return { reconciled: 1, wakes: ['not-requested'] } } }
  h.cycle = (receipts, options = {}) => runReceiptCycle({ capture: h.capture, consumer: h.consumer,
    receipts, allowedRepositories: [repo], ...options })
  return h
}

test('products-only receipts use a separate namespace and enforce matching cycle/consumer policy', async (t) => {
  const productsNamespace = receiptNamespace({ ...config, mode: 'products-only-v1' })
  assert.notEqual(productsNamespace, namespace)
  const s = await storage(t, { namespace: productsNamespace })
  const h = harness([row('a')])
  await assert.rejects(s.use((r) => h.cycle(r, { mode: 'products-only-v1' })), /modes must match/)
  assert.deepEqual(h.lists, [])
  h.consumer.mode = 'products-only-v1'
  h.consumer.processDelivery = async () => ({ reconciled: 1, wakes: ['disabled-by-policy'] })
  assert.equal((await s.use((r) => h.cycle(r, { mode: 'products-only-v1' }))).completed, 1)
  await assert.rejects(withReceiptStore({ directory: s.directory, namespace }, async () => assert.fail('reused mode')), /namespace/)
  const fresh = await storage(t)
  h.consumer.mode = 'full-v1'
  assert.equal((await fresh.use(h.cycle)).completed, 0)
  assert.equal((await fresh.use(h.cycle)).failures[0].stage, 'process')
})

test('durable receipts survive reopening and late older/tied deliveries are not skipped', async (t) => {
  const s = await storage(t)
  const h = harness([row('new', 2000)])
  assert.equal((await s.use(h.cycle)).completed, 1)
  h.rows.push(row('old', 500), row('tied', 2000))
  const second = await s.use(h.cycle)
  assert.deepEqual(second, { ok: true, scanned: 3, skipped: 1, attempted: 2, completed: 2, failures: [], deferred: 0 })
  assert.deepEqual(h.effects, ['new', 'old', 'tied'])
  assert.ok(h.lists.every((q) => Object.keys(q).sort().join() === 'event,repository'))
  assert.equal((await s.use(h.cycle)).attempted, 0)
  assert.equal((await stat(s.directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(s.directory, 'receipts.json'))).mode & 0o777, 0o600)
  const state = JSON.parse(await readFile(join(s.directory, 'receipts.json'), 'utf8'))
  assert.deepEqual(Object.keys(state).sort(), ['completed', 'namespace', 'version'])
  assert.equal(state.completed.length, 3)
  assert.equal(JSON.stringify(state).includes('pull_request'), false)
})

test('failed processing is retried next cycle, not receipted or retried internally', async (t) => {
  const s = await storage(t)
  const h = harness([row('missing-evidence'), row('healthy', 2000)])
  let fail = true
  h.consumer.processDelivery = async (r) => {
    h.effects.push(r.delivery_id)
    if (fail && r.delivery_id === 'missing-evidence') throw new Error('secret-bearing transport response')
    return { reconciled: 1, wakes: ['duplicate'] }
  }
  const first = await s.use(h.cycle)
  assert.equal(first.ok, false)
  assert.deepEqual(first.failures, [{ deliveryId: 'missing-evidence', stage: 'process' }])
  assert.equal(first.completed, 1)
  assert.deepEqual(h.effects, ['missing-evidence', 'healthy'])
  fail = false
  assert.equal((await s.use(h.cycle)).completed, 1)
  assert.deepEqual(h.effects, ['missing-evidence', 'healthy', 'missing-evidence'])
})

test('crash after effect before receipt replays effect, not a fabricated success checkpoint', async (t) => {
  const s = await storage(t)
  const h = harness([row('ambiguous')])
  let attempts = 0
  h.consumer.processDelivery = async () => {
    attempts++
    if (attempts === 1) throw new Error('lost response after external effect')
    return { reconciled: 1, wakes: ['duplicate'] }
  }
  assert.equal((await s.use(h.cycle)).completed, 0)
  assert.equal((await s.use(h.cycle)).completed, 1)
  assert.equal(attempts, 2)
})

test('event budget defers without dropping; successful receipts permit next bounded batch', async (t) => {
  const s = await storage(t)
  const h = harness([row('c', 3), row('b', 2), row('a', 1)])
  const first = await s.use((r) => h.cycle(r, { maxDeliveries: 2 }))
  assert.equal(first.ok, false)
  assert.equal(first.deferred, 1)
  assert.deepEqual(h.effects, ['a', 'b'])
  assert.equal((await s.use(h.cycle)).completed, 1)
  assert.deepEqual(h.effects, ['a', 'b', 'c'])
})

test('incomplete metadata scan aborts before effects, even after an earlier complete stream', async (t) => {
  const s = await storage(t)
  const h = harness([row('a')])
  h.capture.listDeliveries = async ({ event }) => {
    if (event === 'check_suite') throw new Error('page budget exceeded')
    return h.rows
  }
  await assert.rejects(s.use(h.cycle), /page budget/)
  assert.deepEqual(h.effects, [])
  assert.deepEqual(h.reads, [])
})

test('metadata identity, scope and duplicate failures never reach effects', async (t) => {
  for (const bad of [[row('same'), row('same')], [{ ...row('a'), repository: 'Other/repo' }],
    [{ ...row('a'), body_sha256: null }], null]) {
    const s = await storage(t)
    const h = harness()
    h.capture.listDeliveries = async () => bad
    await assert.rejects(s.use(h.cycle))
    assert.deepEqual(h.effects, [])
  }
})

test('changed completed identity errors rather than silently skipping', async (t) => {
  const s = await storage(t)
  const h = harness([row('a')])
  await s.use(h.cycle)
  h.rows[0].received_ms++
  await assert.rejects(s.use(h.cycle), /changed identity/)
  assert.deepEqual(h.effects, ['a'])
})

test('body identity/hash/truncation/read failures remain pending', async (t) => {
  for (const bad of [{ ...row('a'), received_ms: 42 }, { ...row('a'), body: '{}' },
    { ...row('a'), body_truncated: 1 }, null]) {
    const s = await storage(t)
    const h = harness([row('a')])
    h.capture.getDelivery = async () => bad
    const result = await s.use(h.cycle)
    assert.equal(result.completed, 0)
    assert.deepEqual(result.failures, [{ deliveryId: 'a', stage: 'read' }])
    assert.deepEqual(h.effects, [])
  }
})

test('undefined, partial and unknown consumer results are not completion receipts', async (t) => {
  for (const value of [undefined, {}, { ignored: 'unknown' }, { reconciled: 1 },
    { reconciled: 0, wakes: ['sent'] }, { reconciled: 1, wakes: ['unknown'] }]) {
    const s = await storage(t)
    const h = harness([row('a')])
    h.consumer.processDelivery = async () => value
    assert.equal((await s.use(h.cycle)).completed, 0)
  }
  const s = await storage(t)
  const h = harness([row('ignored')])
  h.consumer.processDelivery = async () => ({ ignored: 'unscoped-PR' })
  assert.equal((await s.use(h.cycle)).completed, 1)
})

test('capacity refusal happens before effects, and preserves previously committed receipts', async (t) => {
  const s = await storage(t, { maxReceipts: 1 })
  const h = harness([row('a')])
  await s.use(h.cycle)
  h.rows.push(row('b'))
  await assert.rejects(s.use(h.cycle), /count budget/)
  assert.deepEqual(h.effects, ['a'])
  const saved = JSON.parse(await readFile(join(s.directory, 'receipts.json'), 'utf8'))
  assert.equal(saved.completed.length, 1)
  const small = await storage(t, { maxBytes: 1024 })
  const many = harness(Array.from({ length: 10 }, (_, i) => row(`${i}-${'x'.repeat(120)}`, i)))
  await assert.rejects(small.use(many.cycle), /byte budget/)
  const count = JSON.parse(await readFile(join(small.directory, 'receipts.json'), 'utf8')).completed.length
  assert.ok(count > 0 && count < 10)
  assert.equal(many.effects.length, count)
})

test('corrupt, duplicate, oversized and wrong-namespace state never resets', async (t) => {
  const valid = { version: 1, namespace, completed: [['a', digest('a')]] }
  for (const text of ['{', JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, namespace: digest('other') }),
    JSON.stringify({ ...valid, completed: [valid.completed[0], valid.completed[0]] }),
    ' '.repeat(1025)]) {
    const s = await storage(t, { maxBytes: 1024 })
    await s.use(async () => {})
    await writeFile(join(s.directory, 'receipts.json'), text, { mode: 0o600 })
    let entered = false
    await assert.rejects(s.use(async () => { entered = true }))
    assert.equal(entered, false)
    assert.equal(await readFile(join(s.directory, 'receipts.json'), 'utf8'), text)
  }
})

test('exclusive lock covers full async callback and releases after ordinary errors', async (t) => {
  const s = await storage(t)
  await s.use(async () => {
    await assert.rejects(s.use(async () => assert.fail('second owner entered')), /lock unavailable/)
  })
  await assert.rejects(s.use(async () => { throw new Error('callback failed') }), /callback failed/)
  await s.use(async () => {})
  assert.equal((await readdir(s.directory)).includes('lock'), false)
})

test('independent process cannot enter held lock; abrupt exit preserves receipt and stale lock', async (t) => {
  const s = await storage(t)
  const moduleUrl = new URL('../src/receipt-store.js', import.meta.url).href
  const child = `import { withReceiptStore } from ${JSON.stringify(moduleUrl)};
    await withReceiptStore(${JSON.stringify({ directory: s.directory, namespace })}, async r => {
      await r.record('committed', ${JSON.stringify(digest('committed'))}); process.exit(23);
    });`
  const exec = promisify(execFile)
  await s.use(async () => {
    await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', child]), (e) => {
      assert.equal(e.code, 1)
      assert.match(e.stderr, /lock unavailable/)
      return true
    })
  })
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', child]), (e) => e.code === 23)
  await assert.rejects(s.use(async () => {}), /lock unavailable/)
  // Test-only operator recovery: child is reaped, so no live owner exists.
  await rm(join(s.directory, 'lock'), { recursive: true })
  await s.use(async (r) => assert.equal(r.has('committed', digest('committed')), true))
})

test('symlinked or non-private state fails without following it', async (t) => {
  const s = await storage(t)
  const external = join(s.root, 'external')
  await mkdir(external, { mode: 0o700 })
  await symlink(external, s.directory)
  await assert.rejects(s.use(async () => {}), /private/)
  await rm(s.directory)
  await s.use(async () => {})
  await rm(join(s.directory, 'receipts.json'))
  const sentinel = join(external, 'sentinel')
  await writeFile(sentinel, 'do not touch', { mode: 0o600 })
  await symlink(sentinel, join(s.directory, 'receipts.json'))
  await assert.rejects(s.use(async () => {}), /could not be opened/)
  assert.equal(await readFile(sentinel, 'utf8'), 'do not touch')
})

test('persistence error aborts cycle before a second external effect', async (t) => {
  const s = await storage(t)
  const h = harness([row('a', 1), row('b', 2)])
  h.consumer.processDelivery = async (r) => {
    h.effects.push(r.delivery_id)
    await rm(join(s.directory, 'receipts.json'))
    await mkdir(join(s.directory, 'receipts.json'))
    return { reconciled: 1, wakes: ['not-requested'] }
  }
  await assert.rejects(s.use(h.cycle), /persistence failed/)
  assert.deepEqual(h.effects, ['a'])
})

test('store rejects concurrent writes and cannot be reused outside its lock scope', async (t) => {
  const s = await storage(t)
  let escaped
  await s.use(async (r) => {
    escaped = r
    const pending = r.record('first', digest('first'))
    assert.throws(() => r.record('second', digest('second')), /busy/)
    await pending
    // An unawaited write is still drained before the scope releases its lock.
    void r.record('second', digest('second'))
  })
  assert.throws(() => escaped.has('first', digest('first')), /closed/)
  await s.use(async (r) => {
    assert.equal(r.has('first', digest('first')), true)
    assert.equal(r.has('second', digest('second')), true)
  })
})

test('invalid storage/cycle configuration refuses before processing', async (t) => {
  const s = await storage(t)
  for (const patch of [{ directory: 'relative' }, { namespace: 'not-a-digest' }, { maxBytes: 0 }, { maxReceipts: 0 }]) {
    await assert.rejects(withReceiptStore({ directory: s.directory, namespace, ...patch }, () => assert.fail('entered')))
  }
  const h = harness([row('a')])
  await assert.rejects(s.use((r) => h.cycle(r, { maxDeliveries: 0 })), /budget/)
  assert.deepEqual(h.lists, [])
})

test('namespace binds service endpoints, company, repositories and processing policy', () => {
  assert.equal(receiptNamespace({ ...config, captureOrigin: config.captureOrigin + '/' }), namespace)
  for (const patch of [{ captureOrigin: 'https://other.test' }, { boardOrigin: 'https://other-board.test' },
    { companyId: '11111111-1111-4111-8111-111111111111' }, { allowedRepositories: ['Other/repo'] }]) {
    assert.notEqual(receiptNamespace({ ...config, ...patch }), namespace)
  }
  for (const patch of [{ mode: 'products-only' }, { captureOrigin: 'https://user:secret@capture.test' },
    { boardOrigin: 'https://board.test/path' }, { allowedRepositories: [repo, repo] }]) {
    assert.throws(() => receiptNamespace({ ...config, ...patch }))
  }
})

test('real capture and consumer recover missing evidence without duplicate wakes across restarts', async (t) => {
  const s = await storage(t)
  let time = 2000
  const store = createMemoryStore()
  const app = createApp({ store, webhookSecret: 'test', queryToken: 'test-token', now: () => time,
    bridgePolicy: { trackerPrefix: 'TASK', agentLogin: 'capture-agent[bot]' }, allowedRepositories: [repo] })
  const capture = createCaptureAdapter({ baseUrl: 'https://capture.test', queryToken: 'test-token',
    allowedRepositories: [repo], bridgePolicy: { trackerPrefix: 'TASK', agentLogin: 'capture-agent[bot]' },
    pageSize: 1, fetchImpl: (url, init) => app(new Request(url, init)) })
  const pr = { ...agentPr, title: 'Receipt integration', body: '', state: 'open', merged: false, reviewDecision: null }
  const issue = { id: 'issue', identifier: 'TASK-123', status: 'in_progress', assigneeAgentId: 'agent',
    assigneeUserId: null, blockedBy: [] }
  // The fixture branch binds TASK-123; no real board or live atomic gate is used.
  pr.head = { ...pr.head, ref: 'task-123-receipts', sha: 'a'.repeat(40) }
  const products = []
  const comments = []
  const board = {
    async getIssue() { return issue }, async listInteractions() { return [] },
    async listWorkProducts() { return products },
    async createWorkProduct(id, body) { const p = { id: 'product', ...body }; products.push(p); return p },
    async updateWorkProduct(id, body) { Object.assign(products[0], body); return products[0] },
    async commentIfEligible(id, body) { const comment = { id: 'comment', ...body }; comments.push(comment); return { sent: true, comment } },
  }
  const consumer = createConsumer({ capture, board, github: { async getPullRequest() { return pr } },
    allowedRepositories: [repo],
    bridgePolicy: { trackerPrefix: 'TASK', agentLogin: 'capture-agent[bot]' } })
  const cycle = (receipts) => runReceiptCycle({ capture, consumer, receipts, allowedRepositories: [repo] })
  await ingest(app, 'check_suite', 'suite', { action: 'completed', repository,
    check_suite: { status: 'completed', head_sha: pr.head.sha, pull_requests: [{ number: pr.number }] } })
  assert.equal((await s.use(cycle)).ok, false)
  assert.equal(comments.length, 0)
  assert.equal(products.length, 1)
  time = 1000 // Evidence arrives late, behind the previous timestamp boundary.
  await ingest(app, 'pull_request', 'late-evidence', { action: 'opened', repository, pull_request: pr })
  assert.equal((await s.use(cycle)).completed, 2)
  assert.equal(comments.length, 1)
  assert.equal(products.length, 1)
  assert.equal((await s.use(cycle)).skipped, 2)
  // A different delivery ID still hits the independent D1 head/kind claim key.
  time = 3000
  await ingest(app, 'check_suite', 'same-head', { action: 'completed', repository,
    check_suite: { status: 'completed', head_sha: pr.head.sha, pull_requests: [{ number: pr.number }] } })
  assert.equal((await s.use(cycle)).completed, 1)
  assert.equal(comments.length, 1)
  assert.equal(products.length, 1)
})
