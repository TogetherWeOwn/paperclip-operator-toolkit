// Host-consumer orchestration. Receipt persistence and the process lock live
// outside this core, in the product-only runner. All I/O is injected so these
// decisions can be exercised against real capture routes without keys.
import { classifyPullRequestEvent, classifyCheckSuiteEvent, claimKey } from './bridge.js'
import { resolvePrTask } from './pr-task-index.js'

const WAKE_STATUSES = new Set(['todo', 'in_progress', 'in_review'])
const INTERACTION_STATUSES = new Set(['pending', 'accepted', 'rejected', 'answered', 'cancelled', 'expired', 'failed'])
const REVIEW_STATES = new Map([
  [null, 'none'],
  ['REVIEW_REQUIRED', 'needs_board_review'],
  ['APPROVED', 'approved'],
  ['CHANGES_REQUESTED', 'changes_requested'],
])

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function readDelivery(row) {
  requireValue(row && typeof row.delivery_id === 'string' && row.delivery_id.length > 0,
    'capture delivery has no identity')
  requireValue(row.body_truncated === 0, 'capture delivery body is incomplete')
  const payload = JSON.parse(row.body)
  requireValue(payload && typeof payload === 'object' && !Array.isArray(payload), 'capture delivery is not an object')
  return payload
}

function validateRepository(repo, allowedRepositories) {
  requireValue(typeof repo === 'string' && allowedRepositories.has(repo), 'repository is outside the configured scope')
}

function validatePullRequest(pr, repo, number) {
  requireValue(pr && pr.number === number && pr.base?.repo?.full_name === repo, 'GitHub PR identity mismatch')
  requireValue(pr.html_url === `https://github.com/${repo}/pull/${number}`, 'GitHub PR URL mismatch')
  requireValue(typeof pr.head?.sha === 'string' && /^[a-f0-9]{40}$/.test(pr.head.sha), 'GitHub PR head is invalid')
  requireValue(pr.state === 'open' || pr.state === 'closed', 'GitHub PR state is unknown')
  requireValue(typeof pr.draft === 'boolean' && typeof pr.merged === 'boolean', 'GitHub PR lifecycle is incomplete')
  requireValue(!(pr.merged && pr.state !== 'closed'), 'GitHub PR lifecycle is inconsistent')
  requireValue(typeof pr.title === 'string' && pr.title.length > 0, 'GitHub PR title is missing')
  // The GitHub adapter must supply the authoritative GraphQL reviewDecision,
  // including an explicit null. A missing field is NOT an unreviewed verdict.
  requireValue(REVIEW_STATES.has(pr.reviewDecision), 'GitHub reviewDecision is missing or unknown')
}

function issueMatches(issue, ref) {
  requireValue(issue && typeof issue.id === 'string' && issue.identifier === ref, 'Paperclip issue identity mismatch')
}

function wakeEligible(issue, interactions) {
  requireValue(Array.isArray(interactions) && interactions.every((i) => INTERACTION_STATUSES.has(i?.status)),
    'Paperclip interactions response is incomplete')
  requireValue(Array.isArray(issue.blockedBy), 'Paperclip blocker response is incomplete')
  // Fail closed for all pending interactions, not only ones marked human-only.
  // A pending open-audience question may still be waiting on a human.
  if (interactions.some((i) => i.status === 'pending')) return false
  if (issue.blockedBy.some((b) => b.status !== 'done')) return false
  return WAKE_STATUSES.has(issue.status) && typeof issue.assigneeAgentId === 'string' &&
    issue.assigneeAgentId.length > 0 && issue.assigneeUserId === null
}

/**
 * Dependencies:
 * github.getPullRequest(repo, number): current REST PR + GraphQL reviewDecision.
 * board.getIssue(refOrId), listInteractions(id), listWorkProducts(id),
 *       createWorkProduct(id, body), updateWorkProduct(productId, body),
 *       commentIfEligible(id, body): atomically gates lifecycle/blockers/pending
 *       interactions before posting; returns { sent, comment? }. A bare comment
 *       POST is NOT this operation (board-auth comments can reopen closed work).
 * capture.getPullRequestDelivery(repo, number, sha): complete stored PR evidence;
 *         claim(body): POST /bridge/claim's response.
 *
 * The runner must serialize calls and hold an exclusive process lock. An error
 * must leave the input cursor unadvanced. No retry loop or hidden network here.
 */
export function createConsumer({ github, board, capture, allowedRepositories, mode = 'full-v1',
  prTaskIndex = null, isPrivateRepository = () => true }) {
  requireValue(['full-v1', 'products-only-v1'].includes(mode), 'consumer mode is invalid')
  requireValue(Array.isArray(allowedRepositories) && allowedRepositories.length > 0,
    'an explicit repository allowlist is required')
  requireValue(typeof isPrivateRepository === 'function', 'repository visibility predicate is invalid')
  requireValue(prTaskIndex === null || (prTaskIndex.byPr instanceof Map &&
    prTaskIndex.claimed instanceof Set && prTaskIndex.ambiguous instanceof Set),
  'PR task index is invalid')
  const repositories = new Set(allowedRepositories)

  async function reconcile(repo, number) {
    validateRepository(repo, repositories)
    requireValue(Number.isSafeInteger(number) && number > 0, 'PR number is invalid')
    const pr = await github.getPullRequest(repo, number)
    validatePullRequest(pr, repo, number)
    // PR-to-task mapping: the work-product row is authoritative, private repos
    // fall back to branch then Refs trailer, otherwise unmapped. The old
    // author gate is gone on purpose: owner-authored PRs reconcile through
    // backfill/sweep via the task index instead.
    const mapping = resolvePrTask({ repository: repo, number, branchRef: pr.head?.ref ?? null,
      bodyText: pr.body ?? null, isPrivate: isPrivateRepository(repo) === true, index: prTaskIndex })
    if (mapping.unmapped) return { ignored: 'unmapped-pr', reason: mapping.unmapped, pr }
    // Per-repo visibility flags may arrive later; until then every repo takes
    // the private path and public repos stay clean because agents put no
    // internal refs in them.
    const decision = { issueRef: mapping.issueRef, prNumber: number,
      status: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'active',
      source: mapping.source }
    const issue = await board.getIssue(mapping.issueId ?? mapping.issueRef)
    issueMatches(issue, decision.issueRef)
    const products = await board.listWorkProducts(issue.id)
    requireValue(Array.isArray(products), 'Paperclip work-product response is incomplete')
    const externalId = `${repo}#${number}`
    // Older agent PR rows may have only a URL. Adopt that row rather than
    // creating a second product. Ambiguous duplicates need explicit repair.
    const matches = products.filter((p) => p.type === 'pull_request' && p.provider === 'github' &&
      (p.externalId === externalId || p.url === pr.html_url))
    requireValue(matches.length <= 1, 'multiple Paperclip work products match this PR')
    const existing = matches[0]
    if (existing) {
      requireValue(!existing.url || existing.url === pr.html_url, 'existing work-product URL conflicts with PR identity')
      requireValue(!existing.externalId || existing.externalId === externalId,
        'existing work-product externalId conflicts with PR identity')
    }
    const body = {
      type: 'pull_request', provider: 'github', externalId, url: pr.html_url, title: pr.title,
      status: decision.status, reviewState: REVIEW_STATES.get(pr.reviewDecision),
      metadata: { ...(existing?.metadata ?? {}), repo, number, headSha: pr.head.sha,
        headRef: pr.head.ref, state: pr.merged ? 'merged' : pr.state, draft: pr.draft },
    }
    const product = existing
      ? await board.updateWorkProduct(existing.id, body)
      : await board.createWorkProduct(issue.id, body)
    requireValue(product && product.id && product.url === body.url && product.externalId === externalId &&
      product.status === body.status && product.reviewState === body.reviewState,
    'Paperclip did not confirm the work-product write')
    return { pr, issue, decision, product }
  }

  async function maybeWake(result, candidate, deliveryId, prDeliveryId) {
    const { pr, issue } = result
    // A delayed delivery may describe an older head or a renamed issue binding.
    // Reconcile the current product, but never wake for that stale identity.
    if (candidate.headSha !== pr.head.sha || candidate.issueRef !== issue.identifier) return 'stale'
    if (candidate.kind === 'pull_request_merged' && !pr.merged) return 'stale'
    let current = await board.getIssue(issue.id)
    issueMatches(current, candidate.issueRef)
    if (!wakeEligible(current, await board.listInteractions(issue.id))) return 'ineligible'
    requireValue(typeof board.commentIfEligible === 'function', 'atomic eligibility-gated comment transport is not configured')
    const claim = {
      issue_ref: candidate.issueRef, head_sha: candidate.headSha, kind: candidate.kind,
      delivery_id: deliveryId,
      ...(prDeliveryId ? { pr_delivery_id: prDeliveryId } : {}),
    }
    const claimed = await capture.claim(claim)
    requireValue(claimed?.ok === true && typeof claimed.claimed === 'boolean' && claimed.claim_key === claimKey(candidate),
      'capture did not confirm the wake claim')
    if (!claimed.claimed) return 'duplicate'
    // Recheck after claiming: an interaction/blocker may have appeared while
    // D1 was writing. Losing this wake is safer than waking an ineligible card.
    current = await board.getIssue(issue.id)
    issueMatches(current, candidate.issueRef)
    if (!wakeEligible(current, await board.listInteractions(issue.id))) return 'ineligible-after-claim'
    const label = candidate.kind === 'pull_request_merged' ? 'merged' : 'check suite completed'
    // Only fixed words, a validated GitHub URL and a hex SHA reach the wake
    // comment. PR titles/bodies can contain mentions and must never be pasted.
    const response = await board.commentIfEligible(issue.id, {
      body: `GitHub bridge: [PR #${pr.number}](${pr.html_url}) ${label} at head \`${pr.head.sha}\`.`,
    })
    requireValue(response && typeof response.sent === 'boolean', 'Paperclip did not confirm the gated comment outcome')
    if (!response.sent) return 'ineligible-at-post'
    requireValue(response.comment?.id, 'Paperclip did not confirm the wake comment')
    return 'sent'
  }

  async function processDelivery(row) {
    if (row?.event !== 'pull_request' && row?.event !== 'check_suite') return { ignored: 'unscoped-event' }
    const payload = readDelivery(row)
    const repo = payload.repository?.full_name
    validateRepository(repo, repositories)
    if (row.event === 'pull_request') {
      // Event hints stay bot-scoped until the relay stage; owner-authored PRs
      // reconcile through backfill/sweep via the task index instead.
      const original = classifyPullRequestEvent(payload)
      if (!original) return { ignored: 'unscoped-PR' }
      const result = await reconcile(repo, original.prNumber)
      if (result.ignored) return result
      // Reconciliation is deliberately replayable, not gated on an intent
      // claim: a crash after a product claim must not permanently lose a row.
      const wake = mode === 'products-only-v1' ? 'disabled-by-policy' : original.wake
        ? await maybeWake(result, { ...original, kind: 'pull_request_merged' }, row.delivery_id)
        : 'not-requested'
      return { reconciled: 1, wakes: [wake] }
    }
    if (payload.action !== 'completed' || payload.check_suite?.status !== 'completed') {
      return { ignored: 'nonterminal-suite' }
    }
    const refs = payload.check_suite.pull_requests
    requireValue(Array.isArray(refs), 'check suite PR references are missing')
    const seen = new Set()
    const wakes = []
    let reconciled = 0
    for (const ref of refs) {
      if (seen.has(ref.number)) continue
      seen.add(ref.number)
      const result = await reconcile(repo, ref.number)
      if (result.ignored) continue
      reconciled++
      // Staged product-only delivery uses current authenticated GitHub state.
      // No eligibility reads, stored wake evidence, claims or comments in this mode.
      if (mode === 'products-only-v1') { wakes.push('disabled-by-policy'); continue }
      if (result.pr.head.sha !== payload.check_suite.head_sha) { wakes.push('stale'); continue }
      const evidence = await capture.getPullRequestDelivery(repo, ref.number, result.pr.head.sha)
      requireValue(evidence?.event === 'pull_request', 'stored bot PR evidence is missing; do not advance cursor')
      const verified = readDelivery(evidence)
      const candidates = classifyCheckSuiteEvent(payload, [verified.pull_request])
      const candidate = candidates.find((c) => c.prNumber === ref.number && c.issueRef === result.issue.identifier)
      requireValue(candidate, 'stored bot PR evidence does not match suite identity; do not advance cursor')
      wakes.push(await maybeWake(result, candidate, row.delivery_id, evidence.delivery_id))
    }
    return { reconciled, wakes }
  }

  // Backfill/review reconciliation does not manufacture delivery IDs or wakes.
  // Input pagination and the one-shot checkpoint are runner responsibilities.
  async function backfill(references, { maxItems = 50, beforeItem = () => {}, isStopped = () => false } = {}) {
    requireValue(Number.isSafeInteger(maxItems) && maxItems > 0 && maxItems <= 10000, 'invalid backfill limit')
    requireValue(Array.isArray(references) && references.length <= maxItems, 'backfill references exceed the bounded batch')
    requireValue(typeof beforeItem === 'function' && typeof isStopped === 'function', 'invalid backfill hooks')
    const seen = new Set()
    let reconciled = 0
    for (const { repository, number } of references) {
      await beforeItem()
      requireValue(isStopped() === false, 'backfill stopped')
      const key = JSON.stringify([repository, number])
      if (seen.has(key)) continue
      seen.add(key)
      const result = await reconcile(repository, number)
      requireValue(isStopped() === false, 'backfill stopped')
      if (!result.ignored) reconciled++
    }
    return { reconciled }
  }

  return { mode, processDelivery, backfill }
}
