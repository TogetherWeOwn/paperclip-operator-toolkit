import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat, symlink, readdir, mkdir, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withReceiptStore } from '../src/receipt-store.js'
import { receiptNamespace } from './trusted-fixtures.mjs'
import { SWEEP_FILE, freshSweepState, repoSweeps, checkSweepState, loadSweepState, saveSweepState } from '../src/sweep-store.js'

const repo = 'example-owner/project'
const config = { captureOrigin: 'https://capture.test', boardOrigin: 'http://127.0.0.1:3100',
  companyId: '00000000-0000-4000-8000-000000000105', allowedRepositories: [repo], mode: 'products-only-v1' }
const namespace = receiptNamespace(config)
async function storage(t) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'sweep-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'state')
  await withReceiptStore({ directory, namespace }, async () => {})
  return { root, directory, namespace }
}
function progress() {
  const state = freshSweepState(namespace)
  const entry = repoSweeps(state, repo)
  Object.assign(entry.backfill, { phase: 'draining', refs: [1, 2, 3, 4], done: [1], failed: { 2: 1 }, poisoned: [3], listedMs: 1000 })
  return state
}

test('sweep progress round-trips privately, separately from event receipts', async (t) => {
  const s = await storage(t)
  const receipts = join(s.directory, 'receipts.json')
  // Even a delivery ID matching a scheduler filename must remain untouched.
  const sentinel = '{"delivery-id":"sweeps.json","receipt":"preserve"}\n'
  await writeFile(receipts, sentinel, { mode: 0o600 })
  const state = progress()
  await saveSweepState({ ...s, state })
  assert.deepEqual(await loadSweepState(s), state)
  assert.equal((await stat(join(s.directory, SWEEP_FILE))).mode & 0o777, 0o600)
  assert.equal(await readFile(receipts, 'utf8'), sentinel)
  assert.deepEqual((await readdir(s.directory)).sort(), ['receipts.json', 'sweeps.json'])
  assert.deepEqual(await loadSweepState(s), progress())
})

test('absent state is fresh; each origin, company, scope and mode has isolated progress', async (t) => {
  const s = await storage(t)
  assert.deepEqual(await loadSweepState(s), freshSweepState(namespace))
  await saveSweepState({ ...s, state: progress() })
  const before = await readFile(join(s.directory, SWEEP_FILE), 'utf8')
  for (const changed of [{ captureOrigin: 'https://other.test' }, { boardOrigin: 'https://board.test' },
    { companyId: '00000000-0000-4000-8000-000000000001' }, { allowedRepositories: ['example-owner/z-other'] }, { mode: 'full-v1' }]) {
    const other = receiptNamespace({ ...config, ...changed })
    assert.notEqual(other, namespace)
    await assert.rejects(loadSweepState({ ...s, namespace: other }), /namespace does not match/)
    assert.equal(await readFile(join(s.directory, SWEEP_FILE), 'utf8'), before)
  }
})

test('corrupt, oversize, invalid UTF-8 and unsafe files fail closed without reset', async (t) => {
  const s = await storage(t)
  const path = join(s.directory, SWEEP_FILE)
  for (const text of ['{', ' '.repeat(1025), Buffer.from([0xff]),
    JSON.stringify({ ...progress(), version: 2 })]) {
    await writeFile(path, text, { mode: 0o600 })
    const before = await readFile(path)
    await assert.rejects(loadSweepState({ ...s, maxBytes: 1024 }), /refusing to reset/)
    assert.deepEqual(await readFile(path), before)
  }
  await rm(path)
  await writeFile(path, JSON.stringify(progress()), { mode: 0o600 })
  await chmod(path, 0o644)
  await assert.rejects(loadSweepState(s), /could not be read/)
  await rm(path)
  await writeFile(join(s.root, 'target'), JSON.stringify(progress()), { mode: 0o600 })
  await symlink(join(s.root, 'target'), path)
  await assert.rejects(loadSweepState(s), /could not be opened/)
})

test('state validator rejects fabricated completion and inconsistent snapshots', () => {
  const mutate = [
    s => { s.version = 2 },
    s => { s.extra = true },
    s => { s.namespace = 'not-a-digest' },
    s => { s.repos[repo].backfill.phase = 'complete' },
    s => { s.repos[repo].backfill.done.push(42) },
    s => { s.repos[repo].backfill.refs.push(1) },
    s => { s.repos[repo].backfill.poisoned.push(1) },
    s => { s.repos[repo].backfill.failed[1] = 1 },
    s => { s.repos[repo].backfill.failed['02'] = 1 },
    s => { s.repos[repo].backfill.failed[2] = -1 },
    s => { s.repos[repo].backfill.listedMs = null },
    s => { s.repos[repo].backfill.phase = 'pending' },
    s => { s.repos[repo].review.extra = true },
  ]
  for (const change of mutate) {
    const state = progress()
    change(state)
    assert.throws(() => checkSweepState(state))
  }
  assert.throws(() => checkSweepState(progress(), 3), /reference list/)
  const complete = progress()
  complete.repos[repo].backfill.done.push(2, 4)
  complete.repos[repo].backfill.failed = {}
  complete.repos[repo].backfill.phase = 'complete'
  complete.repos[repo].backfill.lastCompleteMs = 2000
  assert.equal(checkSweepState(complete), complete)
})

test('failed validation or byte capacity cannot replace the last durable checkpoint', async (t) => {
  const s = await storage(t)
  const state = progress()
  await saveSweepState({ ...s, state })
  const saved = await readFile(join(s.directory, SWEEP_FILE), 'utf8')
  state.repos[repo].backfill.phase = 'complete'
  await assert.rejects(saveSweepState({ ...s, state }), /unprocessed references/)
  state.repos[repo].backfill.phase = 'draining'
  await assert.rejects(saveSweepState({ ...s, state, maxBytes: 1 }), /byte budget/)
  assert.equal(await readFile(join(s.directory, SWEEP_FILE), 'utf8'), saved)
  assert.equal((await readdir(s.directory)).some(n => n.endsWith('.tmp')), false)
})

test('interrupted temporary write is not mistaken for committed progress', async (t) => {
  const s = await storage(t)
  await saveSweepState({ ...s, state: progress() })
  await writeFile(join(s.directory, '.sweeps-interrupted.tmp'), '{"version":1,', { mode: 0o600 })
  assert.deepEqual(await loadSweepState(s), progress())
  // A failed rename cleans up this attempt's temporary file, but not others.
  await rm(join(s.directory, SWEEP_FILE))
  await mkdir(join(s.directory, SWEEP_FILE))
  await assert.rejects(saveSweepState({ ...s, state: progress() }), /persistence failed/)
  assert.deepEqual((await readdir(s.directory)).filter(n => n.endsWith('.tmp')), ['.sweeps-interrupted.tmp'])
})
