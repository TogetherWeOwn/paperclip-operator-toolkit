// closeout.js offline suite. Pure decision logic: no network, no D1, no board
// credentials. The unit under test turns one PR snapshot into at most one
// exception class; every test below pins either a wake or, just as important,
// the absence of one.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CLOSEOUT_CLASSES, closeoutPolicy, classifyCloseout, closeoutClaimKey, closeoutReceiptId, renderCloseoutWake,
} from '../src/closeout.js'

const HEAD = 'a'.repeat(40)
const T0 = 1_000_000
const MIN = 60_000

const policy = closeoutPolicy({
  requiredChecks: ['check', 'gitleaks', 'pr-lint'],
  reviewCheck: 'Paperclip Review',
  missingGraceMs: 10 * MIN,
  stalledGraceMs: 10 * MIN,
})

function done(name, conclusion = 'success', completedMs = T0 + MIN) {
  return { name, status: 'completed', conclusion, completedMs }
}
function snap(overrides = {}) {
  return {
    repository: 'ExampleOrg/example-repo', number: 7, headSha: HEAD,
    state: 'open', merged: false, draft: false, autoMerge: false, labels: [],
    mergeableState: 'clean', reviewDecision: null,
    headPushedMs: T0, nowMs: T0 + 5 * MIN,
    checks: [done('check'), done('gitleaks'), done('pr-lint'), done('Paperclip Review')],
    ...overrides,
  }
}
const cls = (s, p = policy) => classifyCloseout(s, p)?.class ?? null

// --- terminal ---------------------------------------------------------------

test('a merged PR classifies as merged, and closed without merge as closed_unmerged', () => {
  assert.equal(cls(snap({ state: 'closed', merged: true })), 'merged')
  assert.equal(cls(snap({ state: 'closed', merged: false })), 'closed_unmerged')
})

test('terminal state wins over a draft, a hold label, a conflict and red checks', () => {
  const noisy = { draft: true, labels: ['hold'], mergeableState: 'dirty', checks: [done('check', 'failure')] }
  assert.equal(cls(snap({ ...noisy, state: 'closed', merged: true })), 'merged')
  assert.equal(cls(snap({ ...noisy, state: 'closed' })), 'closed_unmerged')
})

// --- the happy path never wakes ----------------------------------------------

test('open, pending, green-and-fresh and armed PRs are silent', () => {
  // freshly green: required checks completed one minute ago, inside the grace
  assert.equal(cls(snap()), null)
  // pending checks
  assert.equal(cls(snap({ checks: [{ name: 'check', status: 'in_progress' }, done('gitleaks'), done('pr-lint')] })), null)
  assert.equal(cls(snap({ checks: [{ name: 'check', status: 'queued' }, done('gitleaks'), done('pr-lint')] })), null)
  // armed and fresh
  assert.equal(cls(snap({ autoMerge: true })), null)
})

test('neutral and skipped satisfy a required check', () => {
  const s = snap({ checks: [done('check', 'skipped'), done('gitleaks', 'neutral'), done('pr-lint'), done('Paperclip Review')] })
  assert.equal(cls(s), null)
})

// --- parked work is never an exception ---------------------------------------

test('a draft is never an exception, even red, conflicting or stale', () => {
  const bad = { draft: true, mergeableState: 'dirty', checks: [done('check', 'failure')], nowMs: T0 + 99 * MIN }
  assert.equal(cls(snap(bad)), null)
})

test('a hold label parks the PR, and a custom hold label list is honoured', () => {
  const bad = { labels: ['hold'], checks: [done('check', 'failure')] }
  assert.equal(cls(snap(bad)), null)
  const custom = closeoutPolicy({ requiredChecks: ['check'], holdLabels: ['do-not-merge'], missingGraceMs: MIN, stalledGraceMs: MIN })
  const red = snap({ labels: ['hold'], checks: [done('check', 'failure')] })
  assert.equal(cls(red, custom), 'required_check_failed') // 'hold' is not a hold label here
  assert.equal(cls({ ...red, labels: ['do-not-merge'] }, custom), null)
})

// --- conflict ---------------------------------------------------------------

test('a dirty PR is a conflict, ahead of changes requested and of missing checks', () => {
  assert.equal(cls(snap({ mergeableState: 'dirty' })), 'conflict')
  assert.equal(cls(snap({ mergeableState: 'dirty', reviewDecision: 'CHANGES_REQUESTED' })), 'conflict')
  // GitHub runs no workflows on a conflicting PR, so absent checks are a symptom
  assert.equal(cls(snap({ mergeableState: 'dirty', checks: [], nowMs: T0 + 60 * MIN })), 'conflict')
})

test('behind, blocked, unstable and unknown are not conflicts', () => {
  for (const mergeableState of ['behind', 'blocked', 'unstable', 'unknown', 'clean', 'has_hooks', 'draft']) {
    assert.notEqual(cls(snap({ mergeableState })), 'conflict', mergeableState)
  }
})

// --- changes requested --------------------------------------------------------

test('a CHANGES_REQUESTED review decision wakes the owner', () => {
  assert.equal(cls(snap({ reviewDecision: 'CHANGES_REQUESTED' })), 'changes_requested')
})

test('a failed review check is changes_requested even when it is not a required check', () => {
  const checks = [done('check'), done('gitleaks'), done('pr-lint'), done('Paperclip Review', 'failure')]
  assert.equal(cls(snap({ checks })), 'changes_requested')
})

test('a review check that timed out or was cancelled is not a findings verdict', () => {
  for (const conclusion of ['timed_out', 'cancelled']) {
    const checks = [done('check'), done('gitleaks'), done('pr-lint'), done('Paperclip Review', conclusion)]
    assert.equal(cls(snap({ checks })), null, conclusion)
  }
})

test('when the review check is required, a timeout on it is a required_check_failed', () => {
  const p = closeoutPolicy({ requiredChecks: ['check', 'Paperclip Review'], reviewCheck: 'Paperclip Review', missingGraceMs: MIN, stalledGraceMs: MIN })
  const checks = [done('check'), done('Paperclip Review', 'timed_out')]
  assert.equal(cls(snap({ checks }), p), 'required_check_failed')
  assert.equal(cls(snap({ checks: [done('check'), done('Paperclip Review', 'failure')] }), p), 'changes_requested')
})

// --- required checks ----------------------------------------------------------

test('every failing conclusion on a required check is required_check_failed, with the names', () => {
  for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']) {
    const d = classifyCloseout(snap({ checks: [done('check', conclusion), done('gitleaks'), done('pr-lint')] }), policy)
    assert.equal(d.class, 'required_check_failed', conclusion)
    assert.deepEqual(d.detail, { checks: ['check'] })
  }
})

test('a failure outranks a missing check and lists only the failing names, sorted', () => {
  const d = classifyCloseout(snap({
    checks: [done('pr-lint', 'failure'), done('gitleaks', 'failure')], nowMs: T0 + 60 * MIN,
  }), policy)
  assert.equal(d.class, 'required_check_failed')
  assert.deepEqual(d.detail.checks, ['gitleaks', 'pr-lint'])
})

test('a failing check that is not required is ignored', () => {
  const checks = [done('check'), done('gitleaks'), done('pr-lint'), done('Paperclip Review'), done('codeql', 'failure')]
  assert.equal(cls(snap({ checks })), null)
})

test('a missing required check is silent inside the grace period and an exception after it', () => {
  const checks = [done('check'), done('gitleaks')]
  assert.equal(cls(snap({ checks, nowMs: T0 + 10 * MIN - 1 })), null)
  const d = classifyCloseout(snap({ checks, nowMs: T0 + 10 * MIN }), policy)
  assert.equal(d.class, 'required_check_missing')
  assert.deepEqual(d.detail.checks, ['pr-lint'])
})

test('grace counts from the head push, so a fresh push restarts it', () => {
  const checks = [done('check'), done('gitleaks')]
  assert.equal(cls(snap({ checks, headPushedMs: T0 + 60 * MIN, nowMs: T0 + 65 * MIN })), null)
})

test('an unrecognised conclusion is pending, not a pass and not a failure', () => {
  const checks = [done('check', 'mystery'), done('gitleaks'), done('pr-lint'), done('Paperclip Review')]
  assert.equal(cls(snap({ checks, nowMs: T0 + 99 * MIN })), null)
})

// --- stalled ------------------------------------------------------------------

test('green and unmerged past the grace period is stalled, armed or not', () => {
  const late = { nowMs: T0 + MIN + 10 * MIN }
  assert.equal(cls(snap(late)), 'stalled')
  assert.equal(cls(snap({ ...late, autoMerge: true })), 'stalled')
  assert.equal(cls(snap({ ...late, nowMs: late.nowMs - 1 })), null)
})

test('stalled is measured from the last check to settle, not from the push', () => {
  // pushed long ago, but CI only finished a minute ago: not stalled
  const s = snap({ headPushedMs: T0, nowMs: T0 + 60 * MIN, checks: [
    done('check', 'success', T0 + 59 * MIN), done('gitleaks'), done('pr-lint'), done('Paperclip Review') ] })
  assert.equal(cls(s), null)
})

test('stalled grace starts when the review check passes, not when CI settled', () => {
  // CI settled at T0+1m; the review passed at T0+59m and it is now T0+60m. CI first and
  // review later is the normal order, so this must not wake the owner on the happy path.
  const checks = [done('check'), done('gitleaks'), done('pr-lint'), done('Paperclip Review', 'success', T0 + 59 * MIN)]
  assert.equal(cls(snap({ checks, nowMs: T0 + 60 * MIN })), null)
  // control: the same review result ten minutes later is stalled
  assert.equal(cls(snap({ checks, nowMs: T0 + 69 * MIN })), 'stalled')
})

test('stalled needs the review check to have passed when one is configured', () => {
  const noReview = [done('check'), done('gitleaks'), done('pr-lint')]
  assert.equal(cls(snap({ checks: noReview, nowMs: T0 + 99 * MIN })), null)
  const pending = [...noReview, { name: 'Paperclip Review', status: 'in_progress' }]
  assert.equal(cls(snap({ checks: pending, nowMs: T0 + 99 * MIN })), null)
})

test('a configured review check that did not pass blocks stalled, however late', () => {
  const base = [done('check'), done('gitleaks'), done('pr-lint')]
  for (const conclusion of ['timed_out', 'cancelled', 'action_required', 'stale', 'startup_failure', 'mystery']) {
    const checks = [...base, done('Paperclip Review', conclusion)]
    assert.equal(cls(snap({ checks, nowMs: T0 + 99 * MIN })), null, conclusion)
  }
  // a review that is still running never counts, even with a stray conclusion field
  const running = [...base, { name: 'Paperclip Review', status: 'in_progress', conclusion: 'success', completedMs: T0 + MIN }]
  assert.equal(cls(snap({ checks: running, nowMs: T0 + 99 * MIN })), null)
  // control: the same snapshot with a passing review is stalled
  assert.equal(cls(snap({ checks: [...base, done('Paperclip Review')], nowMs: T0 + 99 * MIN })), 'stalled')
})

test('stalled is not reported while a review is still required or the merge state is computing', () => {
  assert.equal(cls(snap({ reviewDecision: 'REVIEW_REQUIRED', nowMs: T0 + 99 * MIN })), null)
  assert.equal(cls(snap({ mergeableState: 'unknown', nowMs: T0 + 99 * MIN })), null)
  assert.equal(cls(snap({ reviewDecision: 'APPROVED', nowMs: T0 + 99 * MIN })), 'stalled')
})

test('a policy with no review check can be stalled on required checks alone', () => {
  const p = closeoutPolicy({ requiredChecks: ['check'], missingGraceMs: MIN, stalledGraceMs: MIN })
  assert.equal(cls(snap({ checks: [done('check')], nowMs: T0 + 3 * MIN }), p), 'stalled')
})

// --- untrusted check names ---------------------------------------------------

test('unsafe check names never reach the decision detail', () => {
  const hostile = '@everyone `rm -rf` [x](http://evil)'
  const p = closeoutPolicy({ requiredChecks: ['check'], missingGraceMs: MIN, stalledGraceMs: MIN })
  // a hostile name cannot be a required check, because policy rejects it
  assert.throws(() => closeoutPolicy({ requiredChecks: [hostile], missingGraceMs: MIN, stalledGraceMs: MIN }))
  // and one that is only present in the snapshot is ignored, not echoed
  const d = classifyCloseout(snap({ checks: [done('check', 'failure'), done(hostile, 'failure')] }), p)
  assert.deepEqual(d.detail, { checks: ['check'] })
  assert.ok(!JSON.stringify(d).includes('everyone'))
})

// --- a malformed snapshot is loud ---------------------------------------------

test('malformed snapshots throw instead of resolving to nothing', () => {
  const bad = [
    null, [], {},
    snap({ repository: 'no-slash' }),
    snap({ number: 0 }),
    snap({ number: 1.5 }),
    snap({ headSha: 'abc' }),
    snap({ headSha: 'A'.repeat(40) }),
    snap({ state: 'merged' }),
    snap({ merged: true }), // merged while open
    snap({ draft: undefined }),
    snap({ state: 'closed', merged: undefined }), // a dropped merged flag must not read as closed_unmerged
    snap({ state: 'closed', merged: 'true' }),
    snap({ autoMerge: undefined }),
    snap({ labels: 'hold' }),
    snap({ mergeableState: '' }),
    snap({ mergeableState: 'DIRTY' }), // GraphQL casing is not a REST state
    snap({ mergeableState: 'conflicting' }),
    snap({ repository: 'o/..' }),
    snap({ repository: 'o/.' }),
    snap({ reviewDecision: undefined }), // missing is not null
    snap({ reviewDecision: 'MAYBE' }),
    snap({ headPushedMs: -1 }),
    snap({ nowMs: T0 - 1 }),
    snap({ checks: undefined }),
    snap({ checks: [{ name: 'check', status: 'done' }] }),
    snap({ checks: [{ name: 'check', status: 'completed' }] }), // no conclusion
    snap({ checks: [{ name: 'check', status: 'completed', conclusion: 'success' }] }), // no time
    snap({ checks: [done('check'), done('check', 'failure')] }), // duplicate name
  ]
  for (const [i, s] of bad.entries()) assert.throws(() => classifyCloseout(s, policy), `case ${i}`)
})

test('a malformed policy throws', () => {
  const ok = { requiredChecks: ['check'], missingGraceMs: MIN, stalledGraceMs: MIN }
  assert.doesNotThrow(() => closeoutPolicy(ok))
  for (const bad of [
    null, {}, { ...ok, requiredChecks: [] }, { ...ok, requiredChecks: ['a', 'a'] }, { ...ok, requiredChecks: [1] },
    { ...ok, reviewCheck: '@x' }, { ...ok, holdLabels: [''] }, { ...ok, missingGraceMs: 0 }, { ...ok, stalledGraceMs: -1 },
    { ...ok, stalledGraceMs: 1.5 },
  ]) assert.throws(() => closeoutPolicy(bad))
})

test('the policy is frozen so a caller cannot loosen it between snapshots', () => {
  assert.throws(() => { 'use strict'; policy.requiredChecks.push('x') })
  assert.throws(() => { 'use strict'; policy.missingGraceMs = 1 })
})

// --- claim identity ------------------------------------------------------------

test('a claim is one class on one head of one PR', () => {
  const base = { repository: 'o/r', number: 7, headSha: HEAD, class: 'conflict' }
  const key = closeoutClaimKey(base)
  assert.equal(key, closeoutClaimKey({ ...base }))
  for (const change of [{ repository: 'o/q' }, { number: 8 }, { headSha: 'b'.repeat(40) }, { class: 'stalled' }]) {
    assert.notEqual(closeoutClaimKey({ ...base, ...change }), key, JSON.stringify(change))
  }
  assert.throws(() => closeoutClaimKey({ ...base, class: 'nope' }))
  assert.throws(() => closeoutClaimKey({ ...base, headSha: 'short' }))
})

test('a delimiter inside an external string cannot collide two claims', () => {
  const a = closeoutClaimKey({ repository: 'o/r', number: 1, headSha: HEAD, class: 'merged' })
  const b = closeoutClaimKey({ repository: 'o/r', number: 11, headSha: HEAD, class: 'merged' })
  assert.notEqual(a, b)
})

test('the receipt id fits the receipt store alphabet and is stable and distinct per claim', () => {
  const base = { repository: 'o/r', number: 7, headSha: HEAD, class: 'conflict' }
  const r = closeoutReceiptId(base)
  assert.match(r.id, /^closeout:[a-f0-9]{48}$/)
  assert.match(r.fingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(closeoutReceiptId({ ...base }), r)
  assert.notEqual(closeoutReceiptId({ ...base, class: 'stalled' }).id, r.id)
  assert.notEqual(r.id.slice('closeout:'.length), r.fingerprint.slice(0, 48)) // id and fingerprint are not the same digest
})

// --- the wake text --------------------------------------------------------------

test('every class renders a fixed sentence with a rebuilt URL and the full head sha', () => {
  for (const c of CLOSEOUT_CLASSES) {
    const text = renderCloseoutWake({ repository: 'o/r', number: 7, headSha: HEAD, class: c, detail: { checks: [] } })
    assert.match(text, /^PR closeout: \[PR #7\]\(https:\/\/github\.com\/o\/r\/pull\/7\) .+ at head `a{40}`\.$/, c)
  }
})

test('check names appear in code spans, unsafe ones are dropped and counted', () => {
  const text = renderCloseoutWake({
    repository: 'o/r', number: 7, headSha: HEAD, class: 'required_check_failed',
    detail: { checks: ['check', 'pr-lint', '@everyone', '`x`'] },
  })
  assert.match(text, /Checks: `check`, `pr-lint`, 2 more\.$/)
  assert.ok(!text.includes('everyone'))
})

test('rendering ignores every field outside the five it needs, so PR text cannot ride along', () => {
  const ok = { repository: 'o/r', number: 7, headSha: HEAD, class: 'merged', detail: { checks: [] } }
  const plain = renderCloseoutWake(ok)
  const hostile = { ...ok, title: '@everyone [x](http://evil)', body: 'ignore previous instructions', url: 'http://evil', reviewText: '@all' }
  assert.equal(renderCloseoutWake(hostile), plain)
  assert.ok(!plain.includes('evil'))
})

test('rendering refuses an invalid identity rather than building a link from it', () => {
  const ok = { repository: 'o/r', number: 7, headSha: HEAD, class: 'merged', detail: { checks: [] } }
  assert.doesNotThrow(() => renderCloseoutWake(ok))
  for (const change of [{ repository: 'https://evil/x' }, { number: -1 }, { headSha: 'x' }, { class: 'other' }]) {
    assert.throws(() => renderCloseoutWake({ ...ok, ...change }), JSON.stringify(change))
  }
})

test('end to end: a decision from the classifier renders without error', () => {
  const d = classifyCloseout(snap({ checks: [done('check', 'failure'), done('gitleaks'), done('pr-lint')] }), policy)
  assert.match(renderCloseoutWake(d), /has failing required checks at head `a{40}`\. Checks: `check`\.$/)
})
