// S2 (design §5.3): PR-to-task index and mapping order. Pure, no credentials.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrTaskIndex, resolvePrTask, extractRefsTrailer } from '../src/pr-task-index.js'
import { createConsumer } from '../src/consumer.js'

const REPO = 'ExampleOrg/example-repo'
const row = (issue, externalId) => ({ issue, products: [{ type: 'pull_request', provider: 'github', externalId }] })
const open = (id, identifier, status = 'in_progress') => ({ id, identifier, status })

test('work-product row wins over a conflicting branch ref', () => {
  const index = buildPrTaskIndex([row(open('a', 'TASK-10'), `${REPO}#42`)])
  const got = resolvePrTask({ repository: REPO, number: 42, branchRef: 'task-99-other', bodyText: 'Refs: TASK-99' })
  // No index passed: private fallback reads the branch.
  assert.equal(got.issueRef, 'TASK-99')
  assert.equal(got.source, 'ref')
  const withIndex = resolvePrTask({ repository: REPO, number: 42, branchRef: 'task-99-other',
    bodyText: 'Refs: TASK-99', index })
  assert.deepEqual(withIndex, { issueRef: 'TASK-10', issueId: 'a', source: 'work-product' })
})

test('two tasks claiming one PR is unmapped, even with a branch ref', () => {
  const index = buildPrTaskIndex([
    row(open('a', 'TASK-10'), `${REPO}#42`),
    row(open('b', 'TASK-11'), `${REPO}#42`),
  ])
  assert.deepEqual([...index.ambiguous], [`${REPO}#42`])
  assert.deepEqual(resolvePrTask({ repository: REPO, number: 42, branchRef: 'task-10-x', index }),
    { unmapped: 'ambiguous' })
})

test('terminal-only claimants are unmapped, not fallen back to refs', () => {
  const index = buildPrTaskIndex([row(open('a', 'TASK-10', 'done'), `${REPO}#42`)])
  assert.equal(index.byPr.size, 0)
  assert.deepEqual(resolvePrTask({ repository: REPO, number: 42, branchRef: 'task-10-x', index }),
    { unmapped: 'terminal-only' })
})

test('duplicate rows on the same task are one claimant, not ambiguity', () => {
  const issue = open('a', 'TASK-10')
  const index = buildPrTaskIndex([{ issue, products: [
    { type: 'pull_request', provider: 'github', externalId: `${REPO}#42` },
    { type: 'pull_request', provider: 'github', externalId: `${REPO}#42` },
  ] }])
  assert.deepEqual(index.byPr.get(`${REPO}#42`), { issueId: 'a', issueRef: 'TASK-10' })
})

test('public repos never resolve from branch or body refs', () => {
  const got = resolvePrTask({ repository: REPO, number: 42, branchRef: 'task-10-x',
    bodyText: 'Refs: TASK-10', isPrivate: false })
  assert.deepEqual(got, { unmapped: 'no-work-product' })
})

test('private repos prefer the branch, then the trailer, never prose', () => {
  assert.equal(resolvePrTask({ repository: REPO, number: 1, branchRef: 'task-10-a',
    bodyText: 'Refs: TASK-11' }).issueRef, 'TASK-10')
  const trailer = resolvePrTask({ repository: REPO, number: 1, branchRef: 'feature-x',
    bodyText: 'Some work.\nRefs: TASK-11\nFixes nothing else.' })
  assert.deepEqual(trailer, { issueRef: 'TASK-11', issueId: null, source: 'ref' })
  assert.deepEqual(resolvePrTask({ repository: REPO, number: 1, branchRef: 'feature-x',
    bodyText: 'Mentions TASK-11 in prose.' }), { unmapped: 'no-ref' })
  assert.deepEqual(resolvePrTask({ repository: REPO, number: 1, branchRef: 'task-0-x' }),
    { unmapped: 'no-ref' })
})

test('Refs trailer parsing is strict about the value', () => {
  assert.equal(extractRefsTrailer('Refs: TASK-42'), 'TASK-42')
  assert.equal(extractRefsTrailer('refs: task-42'), 'TASK-42')
  assert.equal(extractRefsTrailer('  Refs:   TASK-7  '), 'TASK-7')
  assert.equal(extractRefsTrailer('Refs: see TASK-42'), null)
  assert.equal(extractRefsTrailer('Refs: TASK-0'), null)
  assert.equal(extractRefsTrailer(null), null)
  assert.equal(extractRefsTrailer('Refs: TASK-1\nRefs: TASK-2'), 'TASK-1')
})

test('index ignores non-PR rows and legacy URL-only rows, rejects malformed rows', () => {
  const index = buildPrTaskIndex([{ issue: open('a', 'TASK-10'), products: [
    { type: 'artifact', provider: 'paperclip', externalId: `${REPO}#42` },
    { type: 'pull_request', provider: 'github', externalId: null },
    { type: 'pull_request', provider: 'github', externalId: `${REPO}#7` },
  ] }])
  assert.deepEqual(index.byPr.get(`${REPO}#7`), { issueId: 'a', issueRef: 'TASK-10' })
  assert.equal(index.byPr.size, 1)
  assert.throws(() => buildPrTaskIndex([{ issue: open('a', 'TASK-10'), products: [
    { type: 'pull_request', provider: 'github', externalId: 'not-a-key' } ] }]), /externalId/)
  assert.throws(() => buildPrTaskIndex('nope'), /entries/)
  assert.throws(() => buildPrTaskIndex([{ issue: open('a', 'nope'), products: [] }]), /issue/)
})

function wiring({ pr, index = null, isPrivateRepository = () => true }) {
  const h = { writes: [], gotIssueWith: null, products: [] }
  const github = { async getPullRequest() { return structuredClone(pr) } }
  const board = {
    async getIssue(refOrId) {
      h.gotIssueWith = refOrId
      return { id: 'issue-a', identifier: 'TASK-10' }
    },
    async listWorkProducts() { return structuredClone(h.products) },
    async createWorkProduct(issueId, body) {
      h.writes.push('create')
      const p = { ...structuredClone(body), id: 'product-0', issueId }
      h.products.push(p)
      return structuredClone(p)
    },
    async updateWorkProduct(id, body) {
      h.writes.push('update')
      return { ...structuredClone(body), id }
    },
  }
  h.consumer = createConsumer({ github, board, capture: {}, allowedRepositories: [REPO],
    prTaskIndex: index, isPrivateRepository })
  return h
}

const sha = 'c'.repeat(40)
const basePr = { number: 42, html_url: `https://github.com/${REPO}/pull/42`,
  user: { login: 'fixture-owner' }, head: { ref: 'feature-work', sha },
  base: { repo: { full_name: REPO } }, title: 'Owner PR', body: 'No refs here.',
  state: 'open', draft: false, merged: false, reviewDecision: null }

test('owner-authored PR with an index row reconciles through the row', async () => {
  const index = buildPrTaskIndex([row(open('issue-a', 'TASK-10'), `${REPO}#42`)])
  const h = wiring({ pr: basePr, index })
  const result = await h.consumer.backfill([{ repository: REPO, number: 42 }])
  assert.deepEqual(result, { reconciled: 1 })
  assert.equal(h.gotIssueWith, 'issue-a')
  assert.equal(h.products[0].externalId, `${REPO}#42`)
  assert.equal(result.reconciled, 1)
})

test('owner-authored public PR with no row is unmapped and writes nothing', async () => {
  const h = wiring({ pr: basePr, isPrivateRepository: () => false })
  const result = await h.consumer.backfill([{ repository: REPO, number: 42 }])
  assert.deepEqual(result, { reconciled: 0 })
  assert.deepEqual(h.writes, [])
})

test('private branch refs still resolve with no index (author gate gone)', async () => {
  const pr = { ...basePr, head: { ref: 'task-10-work', sha }, user: { login: 'someone-else' } }
  const h = wiring({ pr })
  const result = await h.consumer.backfill([{ repository: REPO, number: 42 }])
  assert.deepEqual(result, { reconciled: 1 })
  assert.equal(h.gotIssueWith, 'TASK-10')
})

test('ambiguous index blocks the branch fallback and writes nothing', async () => {
  const index = buildPrTaskIndex([
    row(open('a', 'TASK-10'), `${REPO}#42`),
    row(open('b', 'TASK-11'), `${REPO}#42`),
  ])
  const pr = { ...basePr, head: { ref: 'task-10-work', sha } }
  const h = wiring({ pr, index })
  const result = await h.consumer.backfill([{ repository: REPO, number: 42 }])
  assert.deepEqual(result, { reconciled: 0 })
  assert.deepEqual(h.writes, [])
})
