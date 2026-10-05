import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { trustedBridgePolicy, trustedRepositories, trustedVisibility, normalizeIssueRef } from '../src/trusted-policy.js'
import { extractIssueRef, classifyPullRequestEvent, classifyCheckSuiteEvent } from '../src/bridge.js'
import { extractRefsTrailer, buildPrTaskIndex, resolvePrTask } from '../src/pr-task-index.js'
import { createApp } from '../src/app.js'
import { createMemoryStore } from '../src/store-memory.js'
import { createConsumer } from '../src/consumer.js'
import { createCaptureAdapter } from '../src/capture-adapter.js'
import { createPaperclipAdapter } from '../src/paperclip-adapter.js'
import { createGithubAdapter } from '../src/github-adapter.js'
import { parseBridgeQuery } from '../src/query.js'
import { receiptNamespace } from '../src/receipt-cycle.js'
import { withReceiptStore } from '../src/receipt-store.js'
import { claimNamespace, freshClaimState, loadClaimState, saveClaimState } from '../src/claim-store.js'
import { loadConsumerConfig } from '../src/consumer-config.js'
import { runProductPass } from '../src/consumer-runner.js'
import { ingest, agentPr } from './bridge-fixtures.mjs'

const repo = 'example-owner/project'
const other = 'example-owner/z-other'
const policy = Object.freeze({ trackerPrefix: 'TASK', agentLogin: 'capture-agent[bot]' })
const companyId = '00000000-0000-4000-8000-000000000001'
const base = { captureOrigin: 'https://capture.test', boardOrigin: 'https://board.test', companyId,
  allowedRepositories: [repo], mode: 'products-only-v1', bridgePolicy: policy, repositoryVisibility: { [repo]: true } }
const scoped = { bridgePolicy: policy, allowedRepositories: [repo] }
const consumerInput = { ...scoped, mode: 'products-only-v1', isPrivateRepository: () => true }
const sha = 'a'.repeat(40)
const pr = { ...agentPr, title: 'Synthetic PR', body: '', head: { ref: 'task-7-change', sha },
  state: 'open', merged: false, draft: false, reviewDecision: null }
const productEntry = (prefix = 'TASK') => [{ issue: { id: 'synthetic-task', identifier: `${prefix}-7`, status: 'in_progress' },
  products: [{ type: 'pull_request', provider: 'github', externalId: `${repo}#42` }] }]
const request = body => new Request('https://capture.test/bridge/claim', { method: 'POST',
  headers: { authorization: 'Bearer test-query', 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function scratch(t) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'trusted-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('trusted policy requires an explicit bounded canonical prefix and bot identity', () => {
  for (const trackerPrefix of ['A', 'CASE7', 'ABCDEFGHIJKLMNOP']) {
    assert.equal(trustedBridgePolicy({ ...policy, trackerPrefix }).trackerPrefix, trackerPrefix)
  }
  for (const trackerPrefix of ['', 'task', '1TASK', 'TASK-', 'TASK.*', 'A'.repeat(17), 'TASK\n', 'ＴＡＳＫ']) {
    assert.throws(() => trustedBridgePolicy({ ...policy, trackerPrefix }), /trusted bridge policy/)
  }
  for (const agentLogin of ['', 'human', 'agent[Bot]', 'agent/name[bot]', '-agent[bot]', 'agent-[bot]', 'agent[bot]\n']) {
    assert.throws(() => trustedBridgePolicy({ ...policy, agentLogin }), /trusted bridge policy/)
  }
  for (const missing of [undefined, null, {}, [], { trackerPrefix: 'TASK' }, { agentLogin: policy.agentLogin },
    { ...policy, repositoryVisibility: true }, { ...policy, untrustedOverride: true }]) {
    assert.throws(() => trustedBridgePolicy(missing), /trusted bridge policy/)
  }
})

test('trusted inputs are copied and frozen instead of retaining mutable policy or scope', () => {
  const input = { ...policy }
  const normalized = trustedBridgePolicy(input)
  input.trackerPrefix = 'OTHER'
  assert.equal(normalized.trackerPrefix, 'TASK')
  assert.throws(() => { normalized.agentLogin = 'other[bot]' }, TypeError)
  const repositories = [repo]
  const snapshot = trustedRepositories(repositories)
  repositories.push(other)
  assert.deepEqual(snapshot, [repo])
  const visibility = { [repo]: false }
  const frozen = trustedVisibility(visibility, [repo])
  visibility[repo] = true
  assert.equal(frozen[repo], false)
})

test('repository scope and visibility reject absent, duplicate, path-like and incomplete inputs', () => {
  for (const repositories of [undefined, null, [], [repo, repo], ['owner/.'], ['owner/..'], ['owner/repo/extra'],
    ['owner/repo\n'], ['owner/repo;command']]) {
    assert.throws(() => trustedRepositories(repositories), /repository scope/)
    assert.throws(() => createGithubAdapter({ allowedRepositories: repositories }), /repository scope/)
  }
  for (const visibility of [undefined, null, {}, [], { [repo]: 'private' }, { [repo]: undefined },
    { [repo]: true, [other]: false }]) assert.throws(() => trustedVisibility(visibility, [repo]), /visibility/)
})

test('prefix parsing and exact Refs trailers use configured lengths, not a fixed identifier offset', () => {
  for (const trackerPrefix of ['A', 'TASK', 'CASE7', 'ABCDEFGHIJKLMNOP']) {
    const config = { ...policy, trackerPrefix }
    const ref = `${trackerPrefix}-7`
    assert.equal(extractIssueRef(`${ref.toLowerCase()}-branch`, config), ref)
    assert.equal(extractRefsTrailer(`Refs: ${ref.toLowerCase()}`, config), ref)
    assert.equal(extractRefsTrailer(`Refs: ${ref} extra\n ReFs: ${ref} `, config), ref)
    assert.equal(resolvePrTask({ repository: repo, number: 42, branchRef: ref.toLowerCase(),
      isPrivate: true, bridgePolicy: config }).issueRef, ref)
    assert.equal(buildPrTaskIndex(productEntry(trackerPrefix), config).byPr.get(`${repo}#42`).issueRef, ref)
  }
})

test('zero, leading zeros, wrong prefix, oversized numbers and prose cannot establish ownership', () => {
  for (const text of ['TASK-0', 'TASK-00', 'TASK-07', 'TASK-9007199254740992', 'TASK-7suffix', 'OTHER-7']) {
    assert.equal(extractIssueRef(text, policy), null)
    assert.equal(normalizeIssueRef(text, policy), null)
    assert.equal(extractRefsTrailer(`Refs: ${text}`, policy), null)
  }
  assert.equal(normalizeIssueRef('TASK-9007199254740991', policy), 'TASK-9007199254740991')
  assert.equal(extractRefsTrailer('Fixes TASK-7 in prose', policy), null)
  assert.equal(extractRefsTrailer('Refs: TASK-7 and TASK-8', policy), null)
  assert.equal(normalizeIssueRef('task-7', policy), null)
  assert.equal(parseBridgeQuery(new URLSearchParams('issue_ref=OTHER-7'), policy).ok, false)
})

test('pure parsing and every effect boundary reject missing trusted policy before I/O', () => {
  let calls = 0
  const io = () => { calls++; assert.fail('effect before configuration validation') }
  assert.throws(() => extractIssueRef('TASK-7'), /trusted bridge policy/)
  assert.throws(() => extractRefsTrailer('Refs: TASK-7'), /trusted bridge policy/)
  assert.throws(() => buildPrTaskIndex(productEntry()), /trusted bridge policy/)
  assert.throws(() => parseBridgeQuery(new URLSearchParams()), /trusted bridge policy/)
  assert.throws(() => createApp({ store: { append: io }, allowedRepositories: [repo] }), /trusted bridge policy/)
  assert.throws(() => createConsumer({ ...consumerInput, bridgePolicy: undefined, github: { getPullRequest: io } }), /trusted bridge policy/)
  assert.throws(() => createCaptureAdapter({ baseUrl: base.captureOrigin, queryToken: 'test', allowedRepositories: [repo], fetchImpl: io }), /trusted bridge policy/)
  assert.throws(() => createPaperclipAdapter({ baseUrl: base.boardOrigin, token: 'test', companyId, allowedRepositories: [repo], fetchImpl: io }), /trusted bridge policy/)
  assert.equal(calls, 0)
})

test('consumer requires explicit processing mode and complete boolean visibility, with no private default', () => {
  for (const patch of [{ mode: undefined }, { isPrivateRepository: undefined },
    { isPrivateRepository: () => undefined }, { isPrivateRepository: () => 'private' }]) {
    assert.throws(() => createConsumer({ ...consumerInput, ...patch }), /mode|visibility/)
  }
  assert.throws(() => resolvePrTask({ repository: repo, number: 42, bridgePolicy: policy }), /visibility/)
})

test('an index cannot cross a configured policy boundary or carry a foreign prefix', () => {
  const foreignPolicy = { ...policy, trackerPrefix: 'OTHER' }
  const foreign = buildPrTaskIndex(productEntry('OTHER'), foreignPolicy)
  assert.throws(() => resolvePrTask({ repository: repo, number: 42, isPrivate: false,
    bridgePolicy: policy, index: foreign }), /policy does not match/)
  assert.throws(() => createConsumer({ ...consumerInput, prTaskIndex: foreign }), /index/)
  assert.throws(() => buildPrTaskIndex(productEntry('OTHER'), policy), /issue/)
})

test('public repositories ignore branch and trailer policy claims but accept authoritative products', async () => {
  const options = { repository: repo, number: 42, isPrivate: false, bridgePolicy: policy,
    branchRef: 'task-7-change', bodyText: 'Refs: TASK-7\nrepositoryVisibility: private' }
  assert.deepEqual(resolvePrTask(options), { unmapped: 'no-work-product' })
  assert.equal(resolvePrTask({ ...options, index: buildPrTaskIndex(productEntry(), policy) }).issueId, 'synthetic-task')
  let boardReads = 0
  const consumer = createConsumer({ ...consumerInput, isPrivateRepository: () => false,
    github: { getPullRequest: async () => pr }, board: { getIssue: async () => { boardReads++; assert.fail('public fallback') } } })
  assert.deepEqual(await consumer.backfill([{ repository: repo, number: 42 }]), { reconciled: 0 })
  assert.equal(boardReads, 0)
})

test('bot ownership needs both configured login and an explicit Bot actor, not a User suffix or sender', () => {
  const event = { action: 'opened', pull_request: pr, repository: { full_name: repo } }
  assert.equal(classifyPullRequestEvent(event, policy).issueRef, 'TASK-7')
  const suite = { repository: { full_name: repo }, sender: pr.user,
    check_suite: { status: 'completed', head_sha: sha, pull_requests: [{ number: 42, user: pr.user }] } }
  for (const user of [{ login: policy.agentLogin }, { type: 'User', login: policy.agentLogin },
    { type: 'Bot', login: 'other-agent[bot]' }, null]) {
    assert.equal(classifyPullRequestEvent({ ...event, pull_request: { ...pr, user } }, policy), null)
    assert.deepEqual(classifyCheckSuiteEvent(suite, [{ ...pr, user }], policy), [])
  }
  assert.equal(classifyCheckSuiteEvent(suite, [pr], policy).length, 1)
})

test('capture evidence rejects missing, human or foreign bot authors even with a bot-shaped login', async () => {
  for (const user of [undefined, { type: 'User', login: policy.agentLogin },
    { login: policy.agentLogin }, { type: 'Bot', login: 'other-agent[bot]' }, pr.user]) {
    const row = { delivery_id: 'synthetic-pr', received_ms: 100, repository: repo, event: 'pull_request',
      body_truncated: 0, body: JSON.stringify({ repository: { full_name: repo }, pull_request: { ...pr, user } }) }
    let calls = 0
    const capture = createCaptureAdapter({ ...scoped, baseUrl: base.captureOrigin, queryToken: 'test',
      fetchImpl: async url => {
        calls++
        const data = new URL(url).pathname === '/events' ? { count: 1, next_cursor: null, events: [row] } : row
        return Response.json(data)
      } })
    const result = await capture.getPullRequestDelivery(repo, 42, sha)
    assert.equal(result?.delivery_id ?? null, user === pr.user ? row.delivery_id : null)
    assert.equal(calls, 2)
  }
})

test('consumer snapshots caller visibility once and never accepts webhook visibility overrides', async () => {
  let privateFlag = false, reads = 0, boardCalls = 0
  const config = { ...policy }
  const consumer = createConsumer({ ...consumerInput, bridgePolicy: config,
    isPrivateRepository: () => { reads++; return privateFlag }, github: { getPullRequest: async () => pr },
    board: { getIssue: async () => { boardCalls++; assert.fail('untrusted visibility enabled fallback') } } })
  privateFlag = true
  config.trackerPrefix = 'OTHER'
  assert.deepEqual(await consumer.backfill([{ repository: repo, number: 42 }]), { reconciled: 0 })
  const result = await consumer.processDelivery({ delivery_id: 'override', body_truncated: 0, event: 'pull_request',
    body: JSON.stringify({ action: 'opened', repository: { full_name: repo, private: true }, pull_request: pr,
      bridgePolicy: config, repositoryVisibility: { [repo]: true } }) })
  assert.equal(result.ignored, 'unmapped-pr')
  assert.equal(reads, 1)
  assert.equal(boardCalls, 0)
})

test('untrusted webhook policy cannot change trusted prefix, bot or repository claim scope', async () => {
  const mutablePolicy = { ...policy }
  const store = createMemoryStore()
  const app = createApp({ ...scoped, bridgePolicy: mutablePolicy, store, webhookSecret: 'test', queryToken: 'test-query' })
  mutablePolicy.trackerPrefix = 'OTHER'
  mutablePolicy.agentLogin = 'other-agent[bot]'
  const override = { bridgePolicy: mutablePolicy, allowedRepositories: [other], repositoryVisibility: { [repo]: true } }
  const claim = { issue_ref: 'TASK-7', head_sha: sha, kind: 'pull_request_merged', delivery_id: 'genuine' }
  const merged = { ...pr, state: 'closed', merged: true }
  await ingest(app, 'pull_request', 'wrong-prefix', { ...override, action: 'closed', repository: { full_name: repo },
    pull_request: { ...merged, head: { ref: 'other-7-change', sha } } })
  await ingest(app, 'pull_request', 'wrong-bot', { ...override, action: 'closed', repository: { full_name: repo },
    pull_request: { ...merged, user: { type: 'Bot', login: mutablePolicy.agentLogin } } })
  await ingest(app, 'pull_request', 'wrong-scope', { ...override, action: 'closed', repository: { full_name: other },
    pull_request: { ...merged, base: { repo: { full_name: other } }, html_url: `https://github.com/${other}/pull/42` } })
  await ingest(app, 'pull_request', 'wrong-base', { ...override, action: 'closed', repository: { full_name: repo },
    pull_request: { ...merged, base: { repo: { full_name: other } } } })
  for (const delivery_id of ['wrong-prefix', 'wrong-bot', 'wrong-scope', 'wrong-base']) {
    assert.equal((await app(request({ ...claim, delivery_id, ...override }))).status, 400)
  }
  assert.equal((await store.listBridgeClaims({ limit: 50 })).length, 0)
  await ingest(app, 'pull_request', 'genuine', { ...override, action: 'closed', repository: { full_name: repo }, pull_request: merged })
  const result = await app(request({ ...claim, ...override }))
  assert.equal(result.status, 200)
  assert.equal((await result.json()).claimed, true)
  assert.equal((await (await app(request(claim))).json()).claimed, false)
})

test('receipts and closeout claim namespaces bind prefix, bot and explicit repository visibility', async t => {
  const root = await scratch(t)
  const directory = join(root, 'state')
  const namespace = receiptNamespace(base)
  const claims = claimNamespace(namespace)
  await withReceiptStore({ directory, namespace }, async receipts => {
    await receipts.record('synthetic-delivery', 'a'.repeat(64))
    await saveClaimState({ directory, state: freshClaimState(claims) })
  })
  const before = await readFile(join(directory, 'receipts.json'), 'utf8')
  for (const patch of [{ bridgePolicy: { ...policy, trackerPrefix: 'OTHER' } },
    { bridgePolicy: { ...policy, agentLogin: 'other-agent[bot]' } }, { repositoryVisibility: { [repo]: false } }]) {
    const changed = receiptNamespace({ ...base, ...patch })
    assert.notEqual(changed, namespace)
    assert.notEqual(claimNamespace(changed), claims)
    await assert.rejects(withReceiptStore({ directory, namespace: changed }, async () => assert.fail('foreign receipt scope')))
    await assert.rejects(loadClaimState({ directory, namespace: claimNamespace(changed) }))
    assert.equal(await readFile(join(directory, 'receipts.json'), 'utf8'), before)
  }
  const both = { ...base, allowedRepositories: [repo, other], repositoryVisibility: { [repo]: true, [other]: false } }
  assert.equal(receiptNamespace(both), receiptNamespace({ ...both, allowedRepositories: [other, repo],
    bridgePolicy: { agentLogin: policy.agentLogin, trackerPrefix: policy.trackerPrefix }, repositoryVisibility: { [other]: false, [repo]: true } }))
})

test('file configuration and runner refuse omitted policy, scope, mode and visibility before transport', async t => {
  const root = await scratch(t)
  const path = join(root, 'config.json')
  const config = { ...base, version: 1, stateDirectory: join(root, 'state'), limits: {},
    captureTokenFile: join(root, 'capture.key'), boardTokenFile: join(root, 'board.key') }
  await writeFile(config.captureTokenFile, 'synthetic-capture-token', { mode: 0o600 })
  await writeFile(config.boardTokenFile, 'synthetic-board-token', { mode: 0o600 })
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  assert.equal((await loadConsumerConfig(path)).config.bridgePolicy.trackerPrefix, 'TASK')
  let calls = 0
  const io = () => { calls++; assert.fail('transport reached invalid config') }
  for (const patch of [{ bridgePolicy: undefined }, { repositoryVisibility: undefined },
    { allowedRepositories: undefined }, { mode: undefined }, { repositoryVisibility: { [repo]: 'private' } }]) {
    const bad = { ...config, ...patch }
    await writeFile(path, JSON.stringify(bad), { mode: 0o600 })
    await assert.rejects(loadConsumerConfig(path), /configuration/)
    await assert.rejects(runProductPass({ config: bad, captureToken: 'test', boardToken: 'test' }, { fetchImpl: io, run: io }))
  }
  assert.equal(calls, 0)
  await assert.rejects(readFile(join(config.stateDirectory, 'receipts.json')), { code: 'ENOENT' })
})
