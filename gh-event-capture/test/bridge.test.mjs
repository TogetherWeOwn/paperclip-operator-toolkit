// bridge.js offline suite. Pure decision logic, no network, no D1,
// no Paperclip credentials — see `src/bridge.js`'s header.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractIssueRef, classifyPullRequestEvent, classifyCheckSuiteEvent, claimKey } from '../src/bridge.js'

function pr(overrides = {}) {
  return {
    number: 42,
    html_url: 'https://github.com/ExampleOrg/example-repo/pull/42',
    title: 'TASK-3552: bridge worker events onto the board',
    head: { ref: 'task-3552-bridge', sha: 'abc123' },
    user: { login: 'togetherweown[bot]' },
    draft: false,
    merged: false,
    ...overrides,
  }
}

// --- extractIssueRef --------------------------------------------------------

test('extractIssueRef finds a task reference, case-insensitively', () => {
  // Branch refs in this repo are lower-case by convention (`task-3552-bridge`);
  // the match must be case-insensitive or check_suite's wake path never fires.
  assert.equal(extractIssueRef('task-3552-bridge'), 'TASK-3552')
  assert.equal(extractIssueRef('TASK-3552-bridge'), 'TASK-3552')
  assert.equal(extractIssueRef('Fixes TASK-9 and mentions TASK-3552 later'), 'TASK-9') // first match wins
  assert.equal(extractIssueRef('no reference here'), null)
  assert.equal(extractIssueRef(null), null)
  assert.equal(extractIssueRef(undefined), null)
})

// --- classifyPullRequestEvent -----------------------------------------------

test('opened by the agent with an issue ref in the branch creates a work product, no wake', () => {
  const d = classifyPullRequestEvent({ action: 'opened', pull_request: pr() })
  assert.deepEqual(d, {
    issueRef: 'TASK-3552',
    action: 'opened',
    prNumber: 42,
    url: 'https://github.com/ExampleOrg/example-repo/pull/42',
    title: 'TASK-3552: bridge worker events onto the board',
    headSha: 'abc123',
    kind: 'work_product_create',
    status: 'active',
    wake: false,
  })
})

test('opened PR with no task ref anywhere is not classified', () => {
  const d = classifyPullRequestEvent({
    action: 'opened',
    pull_request: pr({ head: { ref: 'chore-cleanup', sha: 'x' }, title: 'cleanup', body: null }),
  })
  assert.equal(d, null)
})

test('opened by a human (not the agent login) is not classified', () => {
  const d = classifyPullRequestEvent({ action: 'opened', pull_request: pr({ user: { login: 'human-reviewer' } }) })
  assert.equal(d, null)
})

test('reopened is treated the same as opened', () => {
  const d = classifyPullRequestEvent({ action: 'reopened', pull_request: pr() })
  assert.equal(d.kind, 'work_product_create')
  assert.equal(d.wake, false)
})

test('draft PR reports status draft without asserting a review verdict', () => {
  const d = classifyPullRequestEvent({ action: 'opened', pull_request: pr({ draft: true }) })
  assert.equal(d.status, 'draft')
  assert.equal(Object.hasOwn(d, 'reviewState'), false)
})

test('synchronize patches status, no wake', () => {
  const d = classifyPullRequestEvent({ action: 'synchronize', pull_request: pr({ head: { ref: 'task-3552-bridge', sha: 'def456' } }) })
  assert.deepEqual(d, {
    issueRef: 'TASK-3552',
    action: 'synchronize',
    prNumber: 42,
    url: 'https://github.com/ExampleOrg/example-repo/pull/42',
    title: 'TASK-3552: bridge worker events onto the board',
    headSha: 'def456',
    kind: 'work_product_update',
    status: 'active',
    wake: false,
  })
})

test('closed and merged wakes; closed and not merged does not', () => {
  const merged = classifyPullRequestEvent({ action: 'closed', pull_request: pr({ merged: true }) })
  assert.equal(merged.status, 'merged')
  assert.equal(merged.wake, true)

  const closed = classifyPullRequestEvent({ action: 'closed', pull_request: pr({ merged: false }) })
  assert.equal(closed.status, 'closed')
  assert.equal(closed.wake, false)
})

test('an action outside the scoped set is not classified', () => {
  assert.equal(classifyPullRequestEvent({ action: 'labeled', pull_request: pr() }), null)
  assert.equal(classifyPullRequestEvent({ action: 'assigned', pull_request: pr() }), null)
})

test('missing pull_request object is not classified', () => {
  assert.equal(classifyPullRequestEvent({ action: 'opened' }), null)
  assert.equal(classifyPullRequestEvent(null), null)
})

// --- classifyCheckSuiteEvent -------------------------------------------------

function checkSuite(overrides = {}) {
  return {
    status: 'completed',
    conclusion: 'success',
    head_sha: 'abc123',
    pull_requests: [{ number: 42, head: { ref: 'task-3552-bridge' } }],
    ...overrides,
  }
}

test('completed check_suite against a task-ref branch yields one wake candidate', () => {
  const out = classifyCheckSuiteEvent({ repository: { full_name: 'ExampleOrg/example-repo' }, check_suite: checkSuite() },
    [pr({ base: { repo: { full_name: 'ExampleOrg/example-repo' } } })])
  assert.deepEqual(out, [
    { issueRef: 'TASK-3552', prNumber: 42, headSha: 'abc123', conclusion: 'success', kind: 'check_suite_completed', wake: true },
  ])
})

test('non-completed check_suite yields nothing', () => {
  assert.deepEqual(classifyCheckSuiteEvent({ check_suite: checkSuite({ status: 'in_progress' }) }), [])
  assert.deepEqual(classifyCheckSuiteEvent({ check_suite: checkSuite({ status: 'queued' }) }), [])
})

test('completed check_suite with no associated PRs yields nothing', () => {
  assert.deepEqual(classifyCheckSuiteEvent({ check_suite: checkSuite({ pull_requests: [] }) }), [])
})

test('a PR whose branch carries no task ref is skipped, others still yield', () => {
  const resolved = [
    pr({ number: 1, title: '', head: { ref: 'chore-cleanup', sha: 'abc123' }, base: { repo: { full_name: 'ExampleOrg/example-repo' } } }),
    pr({ number: 2, head: { ref: 'task-9-fix', sha: 'abc123' }, base: { repo: { full_name: 'ExampleOrg/example-repo' } } }),
  ]
  const out = classifyCheckSuiteEvent({
    repository: { full_name: 'ExampleOrg/example-repo' },
    check_suite: checkSuite({ pull_requests: resolved.map(({ number, head }) => ({ number, head })) }),
  }, resolved)
  assert.deepEqual(out, [
    { issueRef: 'TASK-9', prNumber: 2, headSha: 'abc123', conclusion: 'success', kind: 'check_suite_completed', wake: true },
  ])
})

test('missing check_suite object yields nothing', () => {
  assert.deepEqual(classifyCheckSuiteEvent({}), [])
  assert.deepEqual(classifyCheckSuiteEvent(null), [])
})

// --- claimKey ----------------------------------------------------------------

test('claimKey is stable and distinguishes kind and head sha', () => {
  const a = claimKey({ issueRef: 'TASK-3552', headSha: 'abc123', kind: 'check_suite_completed' })
  const b = claimKey({ issueRef: 'TASK-3552', headSha: 'abc123', kind: 'check_suite_completed' })
  assert.equal(a, b)

  const differentSha = claimKey({ issueRef: 'TASK-3552', headSha: 'def456', kind: 'check_suite_completed' })
  assert.notEqual(a, differentSha)

  const differentKind = claimKey({ issueRef: 'TASK-3552', headSha: 'abc123', kind: 'pull_request_merged' })
  assert.notEqual(a, differentKind)
})

test('only work-product claims tolerate a null head sha', () => {
  const c = { issueRef: 'TASK-3552', headSha: null, kind: 'work_product_create',
    url: pr().html_url, action: 'opened', deliveryId: 'd-1' }
  assert.equal(claimKey(c), claimKey({ ...c, headSha: undefined }))
  assert.throws(() => claimKey({ ...c, kind: 'check_suite_completed' }), /head_sha/)
})
