import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { withReceiptStore } from '../src/receipt-store.js'
import { receiptNamespace } from './trusted-fixtures.mjs'
import { CLAIM_FILE, CLAIM_CLASSES, claimKey, claimNamespace, hasClaim, addClaim,
  freshClaimState, checkClaimState, loadClaimState, saveClaimState } from '../src/claim-store.js'

const repo = 'example-owner/project'
const config = { captureOrigin: 'https://capture.test', boardOrigin: 'http://127.0.0.1:3100',
  companyId: '00000000-0000-4000-8000-000000000105', allowedRepositories: [repo], mode: 'products-only-v1' }
const receiptNs = receiptNamespace(config)
const namespace = claimNamespace(receiptNs)
const head = 'a'.repeat(40)
const decision = (over = {}) => ({ repository: repo, number: 7, headSha: head, class: 'conflict', ...over })

async function storage(t) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'claim-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'state')
  // The claim store takes no lock: the caller holds the receipt lock all pass.
  await withReceiptStore({ directory, namespace: receiptNs }, async () => {})
  return { directory, namespace }
}

test('absent state is fresh; claim namespace is its own digest beside receipts', async (t) => {
  const s = await storage(t)
  assert.deepEqual(await loadClaimState(s), freshClaimState(namespace))
  assert.notEqual(namespace, receiptNs)
  assert.match(namespace, /^[a-f0-9]{64}$/)
  assert.equal(claimNamespace(receiptNs), namespace)
  assert.throws(() => claimNamespace(receiptNs.slice(0, 63) + 'g'), /receipt namespace digest/)
})

test('claim key is the closeout tuple of repo, PR, head SHA and class', (t) => {
  assert.equal(claimKey(decision()), JSON.stringify(['closeout', repo, 7, head, 'conflict']))
  assert.notEqual(claimKey(decision({ number: 8 })), claimKey(decision()))
  assert.notEqual(claimKey(decision({ headSha: 'b'.repeat(40) })), claimKey(decision()))
  assert.notEqual(claimKey(decision({ class: 'stalled' })), claimKey(decision()))
  for (const cls of CLAIM_CLASSES) claimKey(decision({ class: cls }))
  assert.throws(() => claimKey(decision({ class: 'opened' })), /claim class is unknown/)
  assert.throws(() => claimKey(decision({ headSha: head.slice(0, 39) })), /head sha/)
  assert.throws(() => claimKey(decision({ repository: 'example-owner/.' })), /repository/)
  assert.throws(() => claimKey(decision({ number: 0 })), /PR number/)
  assert.throws(() => claimKey({}), /claim repository is invalid/)
})

test('claim round-trips privately beside receipts; second claim is a no-op', async (t) => {
  const s = await storage(t)
  const receipts = join(s.directory, 'receipts.json')
  const sentinel = await readFile(receipts, 'utf8')
  const state = await loadClaimState(s)
  assert.equal(hasClaim(state, decision()), false)
  assert.equal(addClaim(state, decision(), 1000), true)
  assert.equal(addClaim(state, decision(), 1001), false)
  assert.equal(hasClaim(state, decision()), true)
  assert.equal(hasClaim(state, decision({ number: 8 })), false)
  await saveClaimState({ ...s, state })
  assert.equal((await stat(join(s.directory, CLAIM_FILE))).mode & 0o777, 0o600)
  assert.equal(await readFile(receipts, 'utf8'), sentinel)
  assert.deepEqual((await readdir(s.directory)).sort(), ['claims.json', 'receipts.json'])
  const reloaded = await loadClaimState(s)
  assert.equal(hasClaim(reloaded, decision()), true)
  assert.equal(addClaim(reloaded, decision(), 1002), false)
})

test('persisted claim survives a crash between persist and post: no double', async (t) => {
  const s = await storage(t)
  const state = await loadClaimState(s)
  // Claim and persist, then "crash" before posting: the rerun sees the claim.
  assert.equal(addClaim(state, decision(), 1000), true)
  await saveClaimState({ ...s, state })
  const rerun = await loadClaimState(s)
  assert.equal(addClaim(rerun, decision(), 2000), false)
})

test('lost state directory re-arms at most one wake per open exception', async (t) => {
  const s = await storage(t)
  const state = await loadClaimState(s)
  assert.equal(addClaim(state, decision(), 1000), true)
  await saveClaimState({ ...s, state })
  await rm(join(s.directory, CLAIM_FILE))
  // Fresh state claims the same still-open exception exactly once more.
  const fresh = await loadClaimState(s)
  assert.equal(hasClaim(fresh, decision()), false)
  assert.equal(addClaim(fresh, decision(), 2000), true)
  assert.equal(addClaim(fresh, decision(), 2001), false)
})

test('full store fails loud; nothing is silently evicted', async (t) => {
  const s = await storage(t)
  const state = await loadClaimState(s)
  assert.equal(addClaim(state, decision(), 1000, 1), true)
  assert.throws(() => addClaim(state, decision({ number: 8 }), 1001, 1), /claim count budget exceeded/)
  assert.equal(hasClaim(state, decision()), true)
  assert.equal(hasClaim(state, decision({ number: 8 })), false)
  await assert.rejects(saveClaimState({ ...s, state, maxClaims: 0 }), /budget/)
})

test('corrupt, foreign-namespace and hand-edited state refuse to load', async (t) => {
  const s = await storage(t)
  const path = join(s.directory, CLAIM_FILE)
  await writeFile(path, 'not json\n', { mode: 0o600 })
  await assert.rejects(loadClaimState(s), /corrupt/)
  await rm(path)
  await saveClaimState({ ...s, state: freshClaimState(namespace) })
  const other = claimNamespace(createHash('sha256').update('other').digest('hex'))
  await assert.rejects(loadClaimState({ ...s, namespace: other }), /namespace does not match/)
  const state = await loadClaimState(s)
  addClaim(state, decision(), 1000)
  await saveClaimState({ ...s, state })
  // A hand-edited entry for a class the classifier never emits is rejected.
  const tampered = JSON.parse(await readFile(path, 'utf8'))
  tampered.claimed[0][0] = JSON.stringify(['closeout', repo, 7, head, 'opened'])
  await writeFile(path, JSON.stringify(tampered) + '\n')
  await assert.rejects(loadClaimState(s), /shape is invalid/)
  // A valid key with a forged fingerprint is rejected too: without this gate a
  // hand-edited file could plant silence for a live exception.
  const forged = JSON.parse(await readFile(path, 'utf8'))
  forged.claimed[0][0] = claimKey(decision())
  forged.claimed[0][1] = '0'.repeat(64)
  await writeFile(path, JSON.stringify(forged) + '\n')
  await assert.rejects(loadClaimState(s), /shape is invalid/)
})

test('invalid timestamps and envelopes throw instead of misreading', async (t) => {
  const s = await storage(t)
  const state = await loadClaimState(s)
  assert.throws(() => addClaim(state, decision(), -1), /timestamp/)
  assert.throws(() => addClaim(state, decision(), NaN), /timestamp/)
  assert.throws(() => checkClaimState({ version: 1, namespace, claimed: [], extra: 1 }), /envelope/)
  assert.throws(() => checkClaimState({ version: 2, namespace, claimed: [] }), /version or namespace/)
  assert.throws(() => hasClaim({}, decision()), /claim state is required/)
})
