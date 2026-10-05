// GitHub -> board bridge: pure decision logic.
//
// No I/O here. This module turns an already-verified, already-stored delivery
// payload into a small decision object. The planned consumer (not shipped)
// will own Paperclip writes, D1 claims and issue-eligibility checks. This split
// lets the decisions be pinned under `node --test` with zero credentials —
// see README § "Bridge primitives (not a deployed consumer)".
//
// SILENT ON NO MATCH. An event this module cannot tie to a task ref
// (`PREFIX-n`) issue, or that is not one of the shapes the card scoped,
// resolves to `null` (or an empty array) rather than a best guess. A guess
// here becomes a wrong write on a board neither this file nor its caller
// can see.

// Only agent-opened pull requests are the board's business. A human opening a
// PR by hand is not tied to an issue by convention and must not get a
// work-product row synthesised for it.
export const AGENT_LOGIN = 'togetherweown[bot]'

// Case-insensitive: branch conventions are usually lowercase
// (`task-3552-bridge`), and `check_suite` payloads carry only `head.ref` — no
// title — so a case-sensitive match here would silently never fire on a real
// PR's check-suite completion, the only source of requirement #2's wake.
//
// Task refs are prefix-agnostic (`PREFIX-n`): the private tracker is one issuer
// among others, never hardcoded here. The prefix normalizes to uppercase.
const ISSUE_REF = /\b([A-Z][A-Z0-9]*)-(\d+)\b/i

/**
 * @param {string | null | undefined} text
 * @returns {string | null} normalized `PREFIX-n`, or null when no reference is present
 */
export function extractIssueRef(text) {
  if (typeof text !== 'string') return null
  const m = ISSUE_REF.exec(text)
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null
}

/**
 * Where an issue ref is looked for, in order: the branch name is the most
 * reliable (it is what the branch-creation step names after the card),
 * the title next, the body last because a PR body can quote another
 * issue's number in prose.
 *
 * @param {{ head?: { ref?: string }, title?: string, body?: string }} pr
 * @returns {string | null}
 */
function issueRefOfPr(pr) {
  return extractIssueRef(pr?.head?.ref) ?? extractIssueRef(pr?.title) ?? extractIssueRef(pr?.body)
}

const CREATE_ACTIONS = new Set(['opened', 'reopened'])
const SYNC_ACTIONS = new Set(['synchronize', 'edited', 'ready_for_review', 'converted_to_draft'])

// Paperclip uses active/draft for open work products, not GitHub's "open".
// Draft is a lifecycle status, NOT a review verdict. PR webhooks do not carry
// aggregate reviews, so omit reviewState even for drafts; the consumer must
// reconcile it authoritatively without overwriting approvals with guesses.

/**
 * `pull_request` events, scoped to the three things the card asks for:
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
export function classifyPullRequestEvent(payload) {
  const pr = payload?.pull_request
  if (!pr || pr.user?.login !== AGENT_LOGIN) return null

  const issueRef = issueRefOfPr(pr)
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
    // Opening or reopening never wakes anyone by itself — the card scopes
    // wakes to check_suite completion and merges, not to "a PR exists".
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
export function classifyCheckSuiteEvent(payload, resolvedPullRequests = []) {
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
      candidate?.head?.sha === suite.head_sha && candidate?.user?.login === AGENT_LOGIN)
    if (!pr) continue
    const issueRef = issueRefOfPr(pr)
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
