// No I/O. Classify already-verified, stored deliveries using explicit trusted
// prefix and bot policy. The consumer owns scoped reconciliation and eligibility;
// the injected store owns atomic claims. Deployment adapters are not included.
//
// SILENT ON NO MATCH. Events without a configured-prefix reference or verified
// bot actor resolve to null (or an empty array), never a guessed board write.

import { trustedBridgePolicy, findIssueRef } from './trusted-policy.js'

/**
 * @param {string | null | undefined} text
 * @param {{trackerPrefix: string, agentLogin: string}} bridgePolicy trusted configuration
 * @returns {string | null} configured-prefix reference, or null
 */
export function extractIssueRef(text, bridgePolicy) {
  return findIssueRef(text, bridgePolicy)
}

/**
 * Look for a configured reference in branch, title, then body. This classifier
 * yields a candidate, not authoritative ownership. The consumer resolves the
 * owning task separately, and public repositories never use text fallback.
 *
 * @param {{ head?: { ref?: string }, title?: string, body?: string }} pr
 * @returns {string | null}
 */
function issueRefOfPr(pr, bridgePolicy) {
  return extractIssueRef(pr?.head?.ref, bridgePolicy) ?? extractIssueRef(pr?.title, bridgePolicy) ?? extractIssueRef(pr?.body, bridgePolicy)
}

const CREATE_ACTIONS = new Set(['opened', 'reopened'])
const SYNC_ACTIONS = new Set(['synchronize', 'edited', 'ready_for_review', 'converted_to_draft'])

// Paperclip uses active/draft for open work products, not GitHub's "open".
// Draft is a lifecycle status, NOT a review verdict. PR webhooks do not carry
// aggregate reviews, so omit reviewState even for drafts; the consumer must
// reconcile it authoritatively without overwriting approvals with guesses.

/**
 * Supported `pull_request` lifecycle events:
 * create a work-product row on open/reopen, patch it on sync, patch it and
 * decide merge-wake on close.
 *
 * @param {any} payload  parsed webhook body, `event === 'pull_request'`
 * @returns {null | {
 *   issueRef: string, prNumber: number, url: string | null, title: string | null,
 *   headSha: string | null, kind: 'work_product_create' | 'work_product_update',
 *   status: 'active' | 'draft' | 'merged' | 'closed',
 *   action: string, wake: boolean,
 * }}
 */
export function classifyPullRequestEvent(payload, bridgePolicy) {
  const { agentLogin } = trustedBridgePolicy(bridgePolicy)
  const pr = payload?.pull_request
  if (!pr || pr.user?.type !== 'Bot' || pr.user?.login !== agentLogin) return null

  const issueRef = issueRefOfPr(pr, bridgePolicy)
  if (!issueRef) return null

  const base = {
    issueRef,
    action: payload.action,
    prNumber: pr.number,
    url: pr.html_url ?? null,
    title: pr.title ?? null,
    headSha: pr.head?.sha ?? null,
  }

  if (CREATE_ACTIONS.has(payload.action)) {
    // Opening or reopening never wakes anyone. Only completed suites and
    // merges may yield wake candidates, subject to consumer eligibility.
    return { ...base, kind: 'work_product_create', status: pr.draft ? 'draft' : 'active', wake: false }
  }

  if (payload.action === 'closed') {
    return {
      ...base,
      kind: 'work_product_update',
      status: pr.merged === true ? 'merged' : 'closed',
      wake: pr.merged === true,
    }
  }

  if (SYNC_ACTIONS.has(payload.action)) {
    return { ...base, kind: 'work_product_update', status: pr.draft ? 'draft' : 'active', wake: false }
  }

  return null
}

/**
 * `check_suite` events. Only the terminal `completed` status is a decision —
 * `requested`/`in_progress` say nothing final yet. One candidate per PR the
 * suite ran against, because a suite can cover several open PRs sharing a
 * head (rare, but the payload allows it, and a wrong 1:1 assumption here would
 * silently drop a wake rather than fail loudly).
 *
 * @param {any} payload  parsed webhook body, `event === 'check_suite'`
 * @param {Array<any>} resolvedPullRequests full, author-verified PR records
 * @returns {Array<{
 *   issueRef: string, prNumber: number, headSha: string, conclusion: string | null,
 *   kind: 'check_suite_completed', wake: true,
 * }>}
 */
export function classifyCheckSuiteEvent(payload, resolvedPullRequests = [], bridgePolicy) {
  const { agentLogin } = trustedBridgePolicy(bridgePolicy)
  const suite = payload?.check_suite
  const repository = payload?.repository?.full_name
  if (!suite || suite.status !== 'completed' || !suite.head_sha || !repository) return []

  // GitHub's slim check_suite.pull_requests entries do not carry an author.
  // The consumer must resolve them through GitHub or a verified PR record;
  // branch names and the suite's sender are not author evidence.
  const prs = Array.isArray(suite.pull_requests) ? suite.pull_requests : []
  const out = []
  for (const ref of prs) {
    const pr = resolvedPullRequests.find((candidate) =>
      candidate?.number === ref?.number && candidate?.base?.repo?.full_name === repository &&
      candidate?.head?.sha === suite.head_sha && candidate?.user?.type === 'Bot' && candidate?.user?.login === agentLogin)
    if (!pr) continue
    const issueRef = issueRefOfPr(pr, bridgePolicy)
    if (!issueRef) continue
    out.push({
      issueRef,
      prNumber: pr.number,
      headSha: suite.head_sha,
      conclusion: suite.conclusion ?? null,
      kind: 'check_suite_completed',
      wake: true,
    })
  }
  return out
}

/**
 * Wake claims remain one per (issue, head sha, event), independently of PR
 * writes. Claim a merged work-product update with its original kind, then
 * claim its wake separately with kind `pull_request_merged`.
 *
 * Work-product effects are per PR/action/delivery, not per SHA: an edit, draft
 * transition, reopen, or merge may change the same PR without changing its
 * head. GitHub redelivery preserves deliveryId; repeated distinct edits do not.
 * JSON tuple encoding keeps delimiters in external strings unambiguous.
 *
 * @param {{ issueRef: string, headSha?: string | null, kind: string,
 *   url?: string | null, action?: string, deliveryId?: string }} c
 * @returns {string}
 */
export function claimKey({ issueRef, headSha, kind, url, action, deliveryId }) {
  if (kind === 'check_suite_completed' || kind === 'pull_request_merged') {
    if (typeof headSha !== 'string' || !headSha || headSha.includes('|')) {
      throw new Error('head_sha is required for wake claims and must not contain |')
    }
    return `${issueRef}|${headSha}|${kind}`
  }
  if (kind !== 'work_product_create' && kind !== 'work_product_update') {
    throw new Error('unsupported claim kind')
  }
  for (const [name, value] of Object.entries({ pr_url: url, action, delivery_id: deliveryId })) {
    if (typeof value !== 'string' || !value) throw new Error(`${name} is required for work-product claims`)
  }
  return JSON.stringify(['work_product', issueRef, headSha ?? null, kind, url, action, deliveryId])
}
