import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { withReceiptStore } from '../src/receipt-store.js'
import { receiptNamespace } from '../src/receipt-cycle.js'
import { PENDING_FILE, DEFAULT_DEBOUNCE_MS, pendingKey, pendingNamespace,
  freshPendingState, checkPendingState, recordObservation, duePending,
  flushEvaluated, pruneRepository, loadPendingState, savePendingState } from '../src/closeout-pending.js'

const repo = 'ExampleOrg/example-repo'
const other = 'ExampleOrg/example-second'
const config = { captureOrigin: 'https://capture.test', boardOrigin: 'http://127.0.0.1:3100',
  companyId: '12345678-1234-4234-8234-123456789abc', allowedRepositories: [repo], mode: 'products-only-v1' }
const receiptNs = receiptNamespace(config)
const namespace = pendingNamespace(receiptNs)
const ref = (over = {}) => ({ repository: repo, number: 7, ...over })

async function storage(t) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'closeout-pending-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'state')
  // The pending store takes no lock: the caller holds the receipt lock all pass.
  await withReceiptStore({ directory, namespace: receiptNs }, async () => {})
  return { directory, namespace }
}

test('absent state is fresh; pending namespace is its own digest beside receipts', async (t) => {
  const s = await storage(t)
  assert.deepEqual(await loadPendingState(s), freshPendingState(namespace))
  assert.notEqual(namespace, receiptNs)
  assert.match(namespace, /^[a-f0-9]{64}$/)
  assert.equal(pendingNamespace(receiptNs), namespace)
  assert.equal(DEFAULT_DEBOUNCE_MS, 90000)
  assert.throws(() => pendingNamespace(receiptNs.slice(0, 63) + 'g'), /receipt namespace digest/)
})

test('pending key is the tuple of repo and PR; re-observation keeps first sighting', async (t) => {
  const s = await storage(t)
  assert.equal(pendingKey(ref()), JSON.stringify(['closeout-pending', repo, 7]))
  assert.notEqual(pendingKey(ref({ number: 8 })), pendingKey(ref()))
  assert.throws(() => pendingKey(ref({ number: 0 })), /PR number/)
  assert.throws(() => pendingKey(ref({ repository: 'ExampleOrg/.' })), /repository/)
  const state = await loadPendingState(s)
  assert.deepEqual(recordObservation(state, ref(), 1000), { firstSeenMs: 1000, isNew: true })
  assert.deepEqual(recordObservation(state, ref(), 2000), { firstSeenMs: 1000, isNew: false })
  assert.deepEqual(recordObservation(state, ref({ number: 8 }), 2000), { firstSeenMs: 2000, isNew: true })
  assert.throws(() => recordObservation(state, ref({ number: 0 }), 2000), /reference/)
  assert.throws(() => recordObservation(state, ref(), -1), /observation time/)
})

test('due only after the debounce elapses; bypass skips the gate', async (t) => {
  const s = await storage(t)
  const state = await loadPendingState(s)
  recordObservation(state, ref(), 0)
  assert.deepEqual(duePending(state, 89999), [])
  assert.deepEqual(duePending(state, 90000), [{ repository: repo, number: 7, firstSeenMs: 0 }])
  assert.deepEqual(duePending(state, 0, 60000, { bypass: true }),
    [{ repository: repo, number: 7, firstSeenMs: 0 }])
  assert.deepEqual(duePending(state, 1000, 1000), [{ repository: repo, number: 7, firstSeenMs: 0 }])
  assert.throws(() => duePending(state, 90000, 999), /debounce/)
  assert.throws(() => duePending(state, 90000, DEFAULT_DEBOUNCE_MS, { bypass: 'yes' }), /boolean/)
  // The clock can never run backwards past a sighting: that is a caller bug.
  assert.throws(() => duePending(state, -1, DEFAULT_DEBOUNCE_MS), /evaluation time/)
})

test('flush removes only evaluated entries and refuses unknown keys', async (t) => {
  const s = await storage(t)
  const state = await loadPendingState(s)
  recordObservation(state, ref(), 0)
  recordObservation(state, ref({ number: 8 }), 0)
  assert.equal(flushEvaluated(state, [ref()]), 1)
  assert.deepEqual(duePending(state, 90000).map((d) => d.number), [8])
  assert.throws(() => flushEvaluated(state, [ref()]), /not tracked/)
  assert.throws(() => flushEvaluated(state, 'nope'), /references are invalid/)
})

test('prune drops only this repository’s closed PRs', async (t) => {
  const s = await storage(t)
  const state = await loadPendingState(s)
  recordObservation(state, ref(), 0)
  recordObservation(state, ref({ number: 8 }), 0)
  recordObservation(state, ref({ repository: other, number: 7 }), 0)
  assert.equal(pruneRepository(state, repo, [8]), 1)
  assert.deepEqual(duePending(state, 90000).map((d) => d.number).sort(), [7, 8])
  const keys = state.pending.map(([key]) => JSON.parse(key)[1])
  assert.deepEqual(keys.sort(), [repo, other])
  assert.equal(pruneRepository(state, repo, [8]), 0)
  assert.throws(() => pruneRepository(state, repo, [8, 8]), /open PR list/)
})

test('pending round-trips privately beside receipts; claims file untouched', async (t) => {
  const s = await storage(t)
  const receipts = join(s.directory, 'receipts.json')
  const sentinel = await readFile(receipts, 'utf8')
  const state = await loadPendingState(s)
  recordObservation(state, ref(), 1000)
  await savePendingState({ ...s, state })
  assert.equal((await stat(join(s.directory, PENDING_FILE))).mode & 0o777, 0o600)
  assert.equal(await readFile(receipts, 'utf8'), sentinel)
  assert.deepEqual((await readdir(s.directory)).sort(), ['pending.json', 'receipts.json'])
  const reloaded = await loadPendingState(s)
  assert.deepEqual(duePending(reloaded, 91000), [{ repository: repo, number: 7, firstSeenMs: 1000 }])
  assert.throws(() => checkPendingState({ ...reloaded, extra: 1 }), /envelope/)
})

test('full store fails loud; nothing is silently skipped', async (t) => {
  const s = await storage(t)
  const state = await loadPendingState(s)
  recordObservation(state, ref(), 0, 1)
  assert.throws(() => recordObservation(state, ref({ number: 8 }), 0, 1), /entry budget exceeded/)
  assert.deepEqual(duePending(state, 90000, DEFAULT_DEBOUNCE_MS), [{ repository: repo, number: 7, firstSeenMs: 0 }])
  await assert.rejects(savePendingState({ ...s, state, maxEntries: 0 }), /budget/)
})

test('corrupt, foreign-namespace and hand-edited state refuse to load', async (t) => {
  const s = await storage(t)
  const path = join(s.directory, PENDING_FILE)
  await writeFile(path, 'not json\n', { mode: 0o600 })
  await assert.rejects(loadPendingState(s), /corrupt/)
  await rm(path)
  await savePendingState({ ...s, state: freshPendingState(namespace) })
  const otherNs = pendingNamespace(createHash('sha256').update('other').digest('hex'))
  await assert.rejects(loadPendingState({ ...s, namespace: otherNs }), /namespace does not match/)
  const state = await loadPendingState(s)
  recordObservation(state, ref(), 1000)
  await savePendingState({ ...s, state })
  // A hand-edited entry for a PR-shaped key outside the validator is rejected.
  const tampered = JSON.parse(await readFile(path, 'utf8'))
  tampered.pending[0][0] = JSON.stringify(['closeout-pending', 'ExampleOrg/.', 7])
  await writeFile(path, JSON.stringify(tampered) + '\n')
  await assert.rejects(loadPendingState(s), /shape is invalid/)
})

test('oversized state refuses to load even with a small budget', async (t) => {
  const s = await storage(t)
  const state = await loadPendingState(s)
  for (let n = 1; n <= 40; n++) recordObservation(state, ref({ number: n }), 1000)
  await savePendingState({ ...s, state })
  await assert.rejects(loadPendingState({ ...s, maxBytes: 1024 }), /could not be read/)
})
