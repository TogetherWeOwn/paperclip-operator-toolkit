import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withReceiptStore } from '../src/receipt-store.js'
import { receiptNamespace } from '../src/receipt-cycle.js'
import { buildPrTaskIndex } from '../src/pr-task-index.js'
import { claimNamespace, freshClaimState, addClaim, loadClaimState, saveClaimState } from '../src/claim-store.js'
import { pendingNamespace, loadPendingState } from '../src/closeout-pending.js'
import { runCloseoutShadow, createCloseoutReview } from '../src/closeout-sweep.js'

const repo = 'ExampleOrg/example-repo'
const config = { captureOrigin: 'https://capture.test', boardOrigin: 'http://127.0.0.1:3100',
  companyId: '12345678-1234-4234-8234-123456789abc', allowedRepositories: [repo], mode: 'products-only-v1' }
const receiptNs = receiptNamespace(config)
const claimNs = claimNamespace(receiptNs)
const pendingNs = pendingNamespace(receiptNs)
const head = (c) => c.repeat(40)
const policy = { requiredChecks: ['check', 'gitleaks', 'pr-lint'], missingGraceMs: 600000, stalledGraceMs: 3600000 }

function snapshot(number, headSha, over = {}) {
  return { repository: repo, number, headSha, baseRef: 'main', state: 'open', merged: false,
    draft: false, autoMerge: false, labels: [], mergeableState: 'clean', reviewDecision: null,
    headPushedMs: 0, nowMs: 7200000, checks: [], ...over }
}
const done = (name, ms = 1000) => ({ name, status: 'completed', conclusion: 'success', completedMs: ms })
const running = (name) => ({ name, status: 'in_progress' })

function fixtures() {
  const snapshots = new Map([
    [1, snapshot(1, head('a'), { mergeableState: 'dirty' })],
    [2, snapshot(2, head('b'), { reviewDecision: 'APPROVED',
      checks: [done('check'), done('gitleaks'), done('pr-lint')] })],
    [3, snapshot(3, head('c'), { reviewDecision: 'APPROVED',
      checks: [done('check'), running('gitleaks'), done('pr-lint')] })],
    [4, snapshot(4, head('d'), { mergeableState: 'dirty' })],
    [6, snapshot(6, head('f'), { mergeableState: 'BOGUS' })],
  ])
  const calls = []
  const github = { async getCloseoutSnapshot(repository, number, { nowMs } = {}) {
    calls.push({ repository, number, nowMs })
    if (number === 5) throw new Error('GitHub query failed: transport, timeout, output limit or invalid JSON')
    return snapshots.get(number)
  } }
  const rows = [1, 2, 3, 6].map((number, i) => ({ issue: { id: `issue-${number}`,
    identifier: `TASK-${10 + i}`, status: 'in_progress' },
    products: [{ type: 'pull_request', provider: 'github', externalId: `${repo}#${number}` }] }))
  const index = buildPrTaskIndex(rows)
  const claims = freshClaimState(claimNs)
  addClaim(claims, { repository: repo, number: 2, headSha: head('b'), class: 'stalled' }, 5000)
  return { github, calls, index, claims }
}

test('shadow covers unmapped, null-decision, would-claim and already-claimed', async () => {
  const f = fixtures()
  const refs = [1, 2, 3, 4].map((number) => ({ repository: repo, number }))
  const { records, counters } = await runCloseoutShadow({ ...f, policy, references: refs, nowMs: 7200000 })
  assert.deepEqual(counters, { total: 4, mapped: 3, unmapped: 1, unmappedByReason: { 'no-ref': 1 },
    noException: 1, exceptions: 2, byClass: { conflict: 1, stalled: 1 }, wouldClaim: 1, alreadyClaimed: 1, errors: 0 })
  const byNumber = new Map(records.map((r) => [r.number, r]))
  assert.deepEqual(byNumber.get(1), { repository: repo, number: 1, headSha: head('a'), decision: 'conflict',
    mapping: { issueRef: 'TASK-10', source: 'work-product' }, claim: 'wouldClaim' })
  assert.equal(byNumber.get(2).claim, 'alreadyClaimed')
  assert.equal(byNumber.get(2).decision, 'stalled')
  assert.deepEqual(byNumber.get(3), { repository: repo, number: 3, headSha: head('c'), decision: null,
    mapping: { issueRef: 'TASK-12', source: 'work-product' }, claim: 'none' })
  assert.deepEqual(byNumber.get(4).mapping, { unmapped: 'no-ref' })
  assert.equal(byNumber.get(4).claim, 'none')
  // The run is read-only: no claim was added, none removed.
  assert.equal(f.claims.claimed.length, 1)
})

test('unreadable and unclassifiable snapshots are counted errors, not a crash', async () => {
  const f = fixtures()
  const refs = [1, 5, 6].map((number) => ({ repository: repo, number }))
  const { records, counters } = await runCloseoutShadow({ ...f, policy, references: refs, nowMs: 7200000 })
  assert.equal(counters.errors, 2)
  assert.equal(counters.exceptions, 1)
  const byNumber = new Map(records.map((r) => [r.number, r]))
  assert.equal(byNumber.get(5).error, 'snapshot-read-failed')
  assert.equal(byNumber.get(6).error, 'unclassifiable-snapshot')
  assert.match(JSON.stringify(records), /conflict/)
})

test('claims file is byte-identical after a shadow run; no comment path exists', async (t) => {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'closeout-shadow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'state')
  await withReceiptStore({ directory, namespace: receiptNs }, async () => {})
  const f = fixtures()
  await saveClaimState({ directory, namespace: claimNs, state: f.claims })
  const path = join(directory, 'claims.json')
  const before = await readFile(path)
  const refs = [1, 2].map((number) => ({ repository: repo, number }))
  const { counters } = await runCloseoutShadow({ ...f, policy, references: refs, nowMs: 7200000 })
  assert.deepEqual([counters.wouldClaim, counters.alreadyClaimed], [1, 1])
  assert.deepEqual(await readFile(path), before)
  assert.deepEqual((await loadClaimState({ directory, namespace: claimNs })).claimed, f.claims.claimed)
})

test('policy is injected: the same snapshot flips with the grace period', async () => {
  const missing = snapshot(9, head('e'), { reviewDecision: 'APPROVED', headPushedMs: 0, nowMs: 2000,
    checks: [done('check'), done('gitleaks')] })
  const github = { async getCloseoutSnapshot() { return missing } }
  const rows = [{ issue: { id: 'issue-9', identifier: 'TASK-19', status: 'in_progress' },
    products: [{ type: 'pull_request', provider: 'github', externalId: `${repo}#9` }] }]
  const base = { github, index: buildPrTaskIndex(rows), claims: freshClaimState(claimNs),
    references: [{ repository: repo, number: 9 }], nowMs: 2000 }
  const patient = await runCloseoutShadow({ ...base, policy })
  assert.equal(patient.records[0].decision, null)
  const strict = await runCloseoutShadow({ ...base, policy: { ...policy, missingGraceMs: 1000 } })
  assert.equal(strict.records[0].decision, 'required_check_missing')
  assert.equal(strict.records[0].claim, 'wouldClaim')
})

test('null index and public repos resolve unmapped without guessing', async () => {
  const f = fixtures()
  const refs = [{ repository: repo, number: 1 }]
  const nulled = await runCloseoutShadow({ github: f.github, index: null, claims: f.claims,
    policy, references: refs, nowMs: 7200000 })
  assert.equal(nulled.counters.unmapped, 1)
  assert.deepEqual(nulled.records[0].mapping, { unmapped: 'no-ref' })
  const pub = await runCloseoutShadow({ github: f.github, index: buildPrTaskIndex([]), claims: f.claims,
    policy, references: refs, isPrivateRepository: () => false, nowMs: 7200000 })
  assert.deepEqual(pub.records[0].mapping, { unmapped: 'no-work-product' })
})

test('shadow rejects invalid wiring instead of running half-configured', async () => {
  const f = fixtures()
  const refs = [{ repository: repo, number: 1 }]
  await assert.rejects(runCloseoutShadow({ ...f, policy, references: refs, claims: null, nowMs: 1 }), /claim state/)
  await assert.rejects(runCloseoutShadow({ ...f, claims: f.claims, references: refs, policy: null, nowMs: 1 }), /policy/)
  await assert.rejects(runCloseoutShadow({ ...f, policy, references: [refs[0], refs[0]], nowMs: 1 }), /duplicate/)
  await assert.rejects(runCloseoutShadow({ ...f, policy, references: [{ repository: repo, number: 0 }], nowMs: 1 }),
    /reference is invalid/)
})

async function reviewStorage(t) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'closeout-review-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'state')
  await withReceiptStore({ directory, namespace: receiptNs }, async () => {})
  return { directory, namespace: pendingNs }
}

test('review wiring debounces first sightings and flushes after due evaluation', async (t) => {
  const f = fixtures()
  const storage = await reviewStorage(t)
  let now = 0
  const review = createCloseoutReview({ ...storage, claims: f.claims, github: f.github,
    index: f.index, policy, nowMs: () => now })
  // First sighting: observed, none due, no snapshot reads at all.
  let result = await review.runReview({ repository: repo, numbers: [1, 2] })
  assert.deepEqual(result.records, [])
  assert.deepEqual(result.pending, { observed: 2, observedNew: 2, due: 0, debounced: 2, flushed: 0, pruned: 0 })
  assert.equal(f.calls.length, 0)
  // Still inside the debounce: still silent, no re-observation.
  now = 89999
  result = await review.runReview({ repository: repo, numbers: [1, 2] })
  assert.deepEqual(result.records, [])
  assert.equal(result.pending.observedNew, 0)
  assert.equal(f.calls.length, 0)
  // Past the debounce: both evaluate, both flush, claims read but untouched.
  now = 90000
  result = await review.runReview({ repository: repo, numbers: [1, 2] })
  assert.equal(result.records.length, 2)
  assert.equal(result.counters.wouldClaim, 1)
  assert.equal(result.counters.alreadyClaimed, 1)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(result.pending, { observed: 2, observedNew: 0, due: 2, debounced: 0, flushed: 2, pruned: 0 })
  assert.deepEqual((await loadPendingState(storage)).pending, [])
  assert.equal(f.claims.claimed.length, 1)
})

test('review wiring prunes closed PRs and bypass evaluates immediately', async (t) => {
  const f = fixtures()
  const storage = await reviewStorage(t)
  let now = 0
  const review = createCloseoutReview({ ...storage, claims: f.claims, github: f.github,
    index: f.index, policy, nowMs: () => now })
  await review.runReview({ repository: repo, numbers: [1, 2] })
  const pruned = await review.runReview({ repository: repo, numbers: [2] })
  assert.equal(pruned.pending.pruned, 1)
  assert.deepEqual(pruned.records, [])
  const g = fixtures()
  const storage2 = await reviewStorage(t)
  const disarm = createCloseoutReview({ ...storage2, claims: g.claims, github: g.github,
    index: g.index, policy, bypass: true, nowMs: () => 0 })
  const result = await disarm.runReview({ repository: repo, numbers: [1] })
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].decision, 'conflict')
  assert.equal(result.pending.due, 1)
  assert.equal(result.pending.flushed, 1)
})

test('review wiring rejects bad configuration loudly', async (t) => {
  const f = fixtures()
  const storage = await reviewStorage(t)
  assert.throws(() => createCloseoutReview({ ...storage, claims: f.claims, github: f.github,
    index: f.index, policy, debounceMs: 999 }), /debounce/)
  assert.throws(() => createCloseoutReview({ ...storage, claims: f.claims, github: f.github,
    index: f.index, policy, bypass: 'yes' }), /bypass/)
  const review = createCloseoutReview({ ...storage, claims: f.claims, github: f.github,
    index: f.index, policy, nowMs: () => 0 })
  await assert.rejects(review.runReview({ repository: repo, numbers: [1, 1] }), /PR list/)
})
