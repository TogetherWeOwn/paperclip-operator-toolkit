import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, stat, chmod, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { loadPassSchedule, savePassSchedule } from '../src/pass-schedule.js'
import { withReceiptStore } from '../src/receipt-store.js'
import { runReceiptCycle, deliveryFingerprint } from '../src/receipt-cycle.js'
import { runSweepCycle } from '../src/sweep-cycle.js'
import { loadSweepState, saveSweepState } from '../src/sweep-store.js'

const namespace = 'a'.repeat(64)
const repo = 'ExampleOrg/example-repo'
const other = 'ExampleOrg/example-second'
async function storage(t) {
  const directory = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'pass-schedule-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const s = { directory, namespace }
  s.lock = fn => withReceiptStore(s, fn)
  return s
}
const body = '{}'
const row = (id, time) => ({ delivery_id: id, received_ms: time, repository: repo, event: 'pull_request',
  body, body_truncated: 0, body_sha256: createHash('sha256').update(body).digest('hex') })

test('private scheduling hints survive restart but never appear in successful receipts', async (t) => {
  const s = await storage(t)
  await s.lock(async receipts => {
    const schedule = await loadPassSchedule(s)
    assert.equal(schedule.nextStream, 'events')
    schedule.nextStream = 'sweeps'
    schedule.eventCursor = 'b'.repeat(64)
    schedule.sweepCursor = repo
    await savePassSchedule({ ...s, state: schedule })
    assert.equal(receipts.has('schedule.json', 'b'.repeat(64)), false)
    assert.deepEqual(await loadPassSchedule(s), schedule)
  })
  assert.equal((await stat(join(s.directory, 'schedule.json'))).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(join(s.directory, 'receipts.json'), 'utf8')).completed, [])
  assert.equal((await loadPassSchedule(s)).nextStream, 'sweeps')
  await assert.rejects(loadPassSchedule({ ...s, namespace: 'c'.repeat(64) }), /refusing to reset/)
})

test('unsafe or corrupt scheduling files fail closed, never resetting fair progress', async (t) => {
  const s = await storage(t)
  const state = await loadPassSchedule(s)
  for (const content of ['{', ' '.repeat(4097), Buffer.from([0xff]),
    JSON.stringify({ ...state, nextStream: 'full-v1' }), JSON.stringify({ ...state, eventCursor: 'delivery-id' })]) {
    await writeFile(join(s.directory, 'schedule.json'), content, { mode: 0o600 })
    const before = await readFile(join(s.directory, 'schedule.json'))
    await assert.rejects(loadPassSchedule(s), /refusing to reset/)
    assert.deepEqual(await readFile(join(s.directory, 'schedule.json')), before)
  }
  await savePassSchedule({ ...s, state })
  await chmod(join(s.directory, 'schedule.json'), 0o644)
  await assert.rejects(loadPassSchedule(s), /refusing to reset/)
  await rm(join(s.directory, 'schedule.json'))
  await writeFile(join(s.directory, 'target'), JSON.stringify(state), { mode: 0o600 })
  await symlink(join(s.directory, 'target'), join(s.directory, 'schedule.json'))
  await assert.rejects(loadPassSchedule(s), /could not be opened/)
})

test('a permanent event failure cannot monopolize one-item batches across restarts', async (t) => {
  const s = await storage(t)
  const rows = [row('old-failing', 1), row('healthy', 2), row('healthy-later', 3)]
  const order = [...rows].sort((a, b) => deliveryFingerprint(a).localeCompare(deliveryFingerprint(b)))
  const bad = order[0].delivery_id // Fail the first sorted slot, not a lucky later one.
  const effects = []
  const capture = { listDeliveries: async ({ event }) => event === 'pull_request' ? rows : [],
    getDelivery: async id => rows.find(r => r.delivery_id === id) }
  const consumer = { mode: 'products-only-v1', processDelivery: async delivery => {
    effects.push(delivery.delivery_id)
    if (delivery.delivery_id === bad) throw new Error('permanent failure')
    return { reconciled: 1, wakes: ['disabled-by-policy'] }
  } }
  const pass = () => s.lock(async receipts => {
    const schedule = await loadPassSchedule(s)
    return runReceiptCycle({ capture, consumer, receipts, allowedRepositories: [repo], mode: consumer.mode,
      maxDeliveries: 1, afterFingerprint: schedule.eventCursor,
      beforeAttempt: async fingerprint => { schedule.eventCursor = fingerprint; await savePassSchedule({ ...s, state: schedule }) } })
  })
  for (let i = 0; i < 3; i++) assert.equal((await pass()).ok, false)
  assert.deepEqual(effects, order.map(r => r.delivery_id))
  assert.equal((await pass()).failures[0].deliveryId, bad) // Wrap, not drop or quarantine silently.
  const saved = JSON.parse(await readFile(join(s.directory, 'receipts.json'), 'utf8'))
  assert.equal(saved.completed.length, 2)
  assert.equal(saved.completed.some(([id]) => id === bad), false)
  consumer.processDelivery = async () => ({ reconciled: 1, wakes: ['disabled-by-policy'] })
  assert.equal((await pass()).ok, true)
})

test('lost scheduling write aborts before an event effect, not a success receipt', async (t) => {
  const s = await storage(t)
  let effects = 0
  const r = row('a', 1)
  await assert.rejects(s.lock(receipts => runReceiptCycle({
    capture: { listDeliveries: async ({ event }) => event === 'pull_request' ? [r] : [],
      getDelivery: async () => { effects++; return r } },
    consumer: { mode: 'products-only-v1' }, receipts, allowedRepositories: [repo], mode: 'products-only-v1',
    afterFingerprint: null, beforeAttempt: async () => { throw new Error('disk error') },
  })), /disk error/)
  assert.equal(effects, 0)
  assert.deepEqual(JSON.parse(await readFile(join(s.directory, 'receipts.json'), 'utf8')).completed, [])
})

test('a permanently broken repository scan does not starve another repository', async (t) => {
  const s = await storage(t)
  const effects = []
  const pass = () => s.lock(async () => {
    const schedule = await loadPassSchedule(s)
    const state = await loadSweepState(s)
    return runSweepCycle({ state, allowedRepositories: [repo, other], now: () => 1000,
      afterRepository: schedule.sweepCursor,
      beforeRepository: async repository => { schedule.sweepCursor = repository; await savePassSchedule({ ...s, state: schedule }) },
      github: { listOpenPullRequests: async repository => {
        if (repository === repo) throw new Error('page limit; incomplete scan')
        return [{ repository, number: 1 }]
      } },
      consumer: { backfill: async refs => { effects.push(...refs) } },
      save: () => saveSweepState({ ...s, state }),
    })
  })
  await assert.rejects(pass(), /page limit/)
  assert.deepEqual(effects, [])
  await assert.rejects(pass(), /page limit/)
  assert.deepEqual(effects, [{ repository: other, number: 1 }])
  const state = await loadSweepState(s)
  assert.equal(state.repos[other].backfill.phase, 'complete')
  assert.equal(state.repos[repo], undefined, 'failed scan never saved a fabricated snapshot')
})

test('one-item sweep budgets rotate repositories without claiming unscanned work complete', async (t) => {
  const s = await storage(t)
  const effects = []
  const pass = () => s.lock(async () => {
    const state = await loadSweepState(s)
    const schedule = await loadPassSchedule(s)
    return runSweepCycle({ state, allowedRepositories: [repo, other], maxItems: 1,
      afterRepository: schedule.sweepCursor,
      beforeRepository: async repository => { schedule.sweepCursor = repository; await savePassSchedule({ ...s, state: schedule }) },
      github: { listOpenPullRequests: async repository => [{ repository, number: 1 }, { repository, number: 2 }] },
      consumer: { backfill: async refs => { effects.push(...refs) } }, save: () => saveSweepState({ ...s, state }),
    })
  })
  const first = await pass()
  assert.equal(first.ok, false)
  assert.equal(first.pendingScans, 1)
  await pass()
  assert.deepEqual(effects, [{ repository: repo, number: 1 }, { repository: other, number: 1 }])
  await pass(); await pass()
  assert.deepEqual(effects.slice(2), [{ repository: repo, number: 2 }, { repository: other, number: 2 }])
})
