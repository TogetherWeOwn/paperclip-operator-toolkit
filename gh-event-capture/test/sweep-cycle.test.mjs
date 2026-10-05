import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runSweepCycle, sweepLimits } from '../src/sweep-cycle.js'
import { loadSweepState, saveSweepState } from '../src/sweep-store.js'
import { withReceiptStore } from '../src/receipt-store.js'
import { receiptNamespace } from './trusted-fixtures.mjs'
import { createConsumer } from './trusted-fixtures.mjs'
import { agentPr } from './bridge-fixtures.mjs'

const repo = 'example-owner/project'
const other = 'example-owner/z-other'
const namespace = receiptNamespace({ captureOrigin: 'https://capture.test', boardOrigin: 'http://127.0.0.1:3100',
  companyId: '00000000-0000-4000-8000-000000000105', allowedRepositories: [repo, other], mode: 'products-only-v1' })
async function harness(t, open = { [repo]: [1, 2, 3] }) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'sweep-cycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'state')
  const h = { directory, open, lists: [], effects: [], time: 1000, saves: 0,
    lock: fn => withReceiptStore({ directory, namespace }, fn),
    load: () => loadSweepState({ directory, namespace }) }
  h.github = { async listOpenPullRequests(repository) {
    h.lists.push(repository)
    return h.open[repository].map(number => ({ repository, number }))
  } }
  h.consumer = { async backfill(refs) { h.effects.push(...refs); return { reconciled: refs.length } } }
  h.cycle = (options = {}) => h.lock(async () => {
    const state = await h.load()
    return runSweepCycle({ github: h.github, consumer: h.consumer, state,
      allowedRepositories: Object.keys(h.open), now: () => h.time, reviewIntervalMs: 100,
      save: async () => { h.saves++; await saveSweepState({ directory, state }) }, ...options })
  })
  return h
}

test('bounded backfill resumes a saved snapshot, including a PR which closed meanwhile', async (t) => {
  const h = await harness(t, { [repo]: [1, 2, 3], [other]: [5] })
  let result = await h.cycle({ maxItems: 2 })
  assert.equal(result.ok, false)
  assert.equal(result.deferred, 2)
  assert.deepEqual(h.effects, [{ repository: repo, number: 1 }, { repository: other, number: 5 }])
  assert.equal((await h.load()).repos[repo].backfill.phase, 'draining')
  h.open[repo] = [1, 4] // #2/#3 closed; #4 was not in the initial snapshot.
  result = await h.cycle({ maxItems: 2 })
  // Backfill no longer monopolizes another repository's due review budget.
  assert.deepEqual(h.effects.slice(2), [{ repository: repo, number: 2 }, { repository: other, number: 5 }])
  assert.equal(result.repos[repo].backfill.phase, 'draining')
  assert.equal(h.lists.filter(r => r === repo).length, 1)
  assert.equal(result.repos[other].review.remaining, 0)
  await h.cycle()
  assert.deepEqual(h.effects.at(-1), { repository: repo, number: 3 })
  assert.deepEqual((await h.load()).repos[repo].backfill.refs, [1, 2, 3])
  assert.equal((await h.load()).repos[repo].backfill.phase, 'complete')
  await h.cycle()
  assert.deepEqual((await h.load()).repos[repo].review.refs, [1, 4])
})

test('empty complete scans are valid and backfill is one-shot while review is periodic', async (t) => {
  const h = await harness(t, { [repo]: [] })
  assert.equal((await h.cycle()).ok, true)
  assert.equal(h.lists.length, 2)
  assert.deepEqual(h.effects, [])
  h.time = 1099
  await h.cycle()
  assert.equal(h.lists.length, 2)
  h.time = 1100
  h.open[repo] = [9]
  const result = await h.cycle()
  assert.equal(h.lists.length, 3)
  assert.deepEqual(h.effects, [{ repository: repo, number: 9 }])
  assert.equal(result.repos[repo].backfill.total, 0)
  assert.equal(result.repos[repo].review.completedAgeMs, 0)
})

test('review survives restart mid-drain and resnapshots only after its completion interval', async (t) => {
  const h = await harness(t)
  await h.cycle()
  const partial = await h.cycle({ maxItems: 1 })
  assert.equal(partial.ok, false)
  assert.equal(partial.backfillDeferred, 0)
  assert.equal(partial.deferred, 2)
  assert.deepEqual((await h.load()).repos[repo].review.done, [1])
  h.open[repo] = []
  h.time = 9999 // Even long delays must resume the saved queue, not resnapshot.
  await h.cycle({ maxItems: 1 })
  assert.equal(h.lists.length, 2)
  assert.deepEqual((await h.load()).repos[repo].review.done, [1, 2])
  await h.cycle()
  assert.deepEqual(h.effects.slice(-2), [{ repository: repo, number: 2 }, { repository: repo, number: 3 }])
  const saved = (await h.load()).repos[repo].review
  assert.equal(saved.lastCompleteMs, 9999)
  h.time = 10098
  await h.cycle()
  assert.equal(h.lists.length, 2)
  h.time = 10099
  await h.cycle()
  assert.equal(h.lists.length, 3)
})

test('incomplete or invalid scans never fabricate an empty successful snapshot', async (t) => {
  for (const response of [null, [{ repository: repo, number: 1 }, { repository: repo, number: 1 }],
    [{ repository: other, number: 1 }], [{ repository: repo, number: 0 }]]) {
    const h = await harness(t)
    h.github.listOpenPullRequests = async () => response
    await assert.rejects(h.cycle(), /scan/)
    assert.equal(h.saves, 0)
    assert.deepEqual((await h.load()).repos, {})
    assert.deepEqual(h.effects, [])
  }
  const h = await harness(t)
  h.github.listOpenPullRequests = async () => { throw new Error('pagination budget exhausted') }
  await assert.rejects(h.cycle(), /pagination budget/)
  assert.deepEqual(h.effects, [])
  assert.equal(h.saves, 0)
})

test('crash before snapshot commit performs no effects, and a fresh pass lists again', async (t) => {
  const h = await harness(t)
  await assert.rejects(h.cycle({ save: async () => { throw new Error('disk failure') } }), /disk failure/)
  assert.deepEqual(h.effects, [])
  assert.deepEqual((await h.load()).repos, {})
  assert.equal((await h.cycle()).processed, 3)
  assert.equal(h.lists.length, 2)
})

test('crash after an effect before save replays only uncheckpointed work in both phases', async (t) => {
  for (const phase of ['backfill', 'review']) {
    const h = await harness(t)
    if (phase === 'review') await h.cycle()
    const initial = h.effects.length
    let state
    await assert.rejects(h.lock(async () => {
      state = await h.load()
      let writes = 0
      return runSweepCycle({ github: h.github, consumer: h.consumer, state,
        allowedRepositories: [repo], now: () => h.time,
        save: async () => {
          if (++writes === 3) throw new Error('crash after second effect')
          // Persist through the normal store; this pass fails on its third write.
          await saveSweepState({ directory: h.directory, state })
        } })
    }), /crash after second effect/)
    assert.deepEqual((await h.load()).repos[repo][phase].done, [1])
    assert.deepEqual(h.effects.slice(initial).map(r => r.number), [1, 2])
    await h.cycle()
    assert.deepEqual(h.effects.slice(initial).map(r => r.number), [1, 2, 2, 3])
    assert.equal((await h.load()).repos[repo][phase].phase, 'complete')
  }
})

test('failed PRs are retried and loudly quarantined so healthy refs eventually advance', async (t) => {
  const h = await harness(t)
  h.consumer.backfill = async ([ref]) => {
    h.effects.push(ref)
    if (ref.number === 1) throw new Error('secret-bearing response')
    return { reconciled: 1 }
  }
  for (let i = 0; i < 3; i++) {
    const result = await h.cycle({ maxItems: 1, maxAttempts: 2 })
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(result).includes('secret-bearing'), false)
  }
  assert.deepEqual((await h.load()).repos[repo].backfill.poisoned, [1])
  await h.cycle({ maxItems: 1, maxAttempts: 2 })
  const result = await h.cycle({ maxItems: 1, maxAttempts: 2 })
  assert.equal(result.ok, false)
  assert.equal(result.poisonedTotal, 1)
  assert.equal(result.repos[repo].backfill.phase, 'complete')
  assert.deepEqual(h.effects.map(r => r.number), [1, 1, 1, 2, 3])
})

test('fixed clocks report backlog age and shared budget stops are not PR failures', async (t) => {
  const h = await harness(t)
  await h.cycle({ maxItems: 1 })
  h.time = 5000
  const result = await h.cycle({ maxItems: 1 })
  assert.equal(result.repos[repo].backfill.listedAgeMs, 4000)
  assert.equal(result.deferred, 1)
  const before = await h.load()
  await assert.rejects(h.cycle({ beforeItem: () => { throw new Error('total operation budget exhausted') } }), /total operation budget/)
  assert.deepEqual(await h.load(), before)
})

test('cancellation after an ambiguous effect neither checkpoints nor releases the lock early', async (t) => {
  const h = await harness(t, { [repo]: [1] })
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { release = resolve })
  let stopped = false
  h.consumer.backfill = async refs => {
    h.effects.push(...refs)
    entered()
    await pending
    stopped = true
    throw new Error('aborted transport')
  }
  const pass = h.cycle({ isStopped: () => stopped })
  const rejected = assert.rejects(pass, /sweep pass stopped/)
  await started
  await assert.rejects(h.cycle(), /lock/)
  release()
  await rejected
  const state = await h.load()
  assert.deepEqual(state.repos[repo].backfill.done, [])
  assert.deepEqual(state.repos[repo].backfill.failed, {})
  h.consumer.backfill = async () => ({ reconciled: 1 })
  assert.equal((await h.cycle()).processed, 1)
})

test('real product consumer adopts a lost board response without claims, eligibility or wake APIs', async (t) => {
  const h = await harness(t, { [repo]: [1] })
  const products = []
  let creates = 0, updates = 0
  const pr = { ...agentPr, number: 1, title: 'TASK-42: product', body: '',
    state: 'closed', merged: true, draft: false, reviewDecision: 'APPROVED',
    html_url: `https://github.com/${repo}/pull/1`, base: { repo: { full_name: repo } },
    head: { sha: 'a'.repeat(40), ref: 'task-42-product' } }
  h.consumer = createConsumer({ mode: 'products-only-v1', allowedRepositories: [repo],
    github: { getPullRequest: async () => pr },
    board: {
      getIssue: async () => ({ id: 'issue', identifier: 'TASK-42', status: 'blocked' }),
      listWorkProducts: async () => structuredClone(products),
      createWorkProduct: async (_id, body) => {
        creates++
        products.push({ id: 'product', ...body })
        throw new Error('response lost after committed board write')
      },
      updateWorkProduct: async (_id, body) => { updates++; return Object.assign(products[0], body) },
    },
  })
  assert.equal((await h.cycle()).ok, false)
  assert.deepEqual((await h.load()).repos[repo].backfill.done, [])
  assert.equal((await h.cycle()).ok, true)
  assert.equal(products.length, 1)
  assert.equal(creates, 1)
  assert.equal(updates, 1)
  assert.equal(products[0].reviewState, 'approved')
  assert.equal(products[0].metadata.state, 'merged')
})

test('sweep limits reject invalid and unbounded work before I/O', () => {
  for (const limits of [{ maxItems: 0 }, { maxAttempts: -1 }, { reviewIntervalMs: Infinity }, { unknown: 1 }]) {
    assert.throws(() => sweepLimits(limits), /invalid sweep limits/)
  }
})
