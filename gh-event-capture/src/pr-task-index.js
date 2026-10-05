// PR-to-task index.
//
// Pure mapping, no I/O. Order, first unambiguous match wins:
//   1. work-product row `provider=github, type=pull_request, externalId=repo#N`
//      on a non-terminal task (authoritative; agents must register the row);
//   2. private repos only: a task ref in the branch, then a `Refs:` trailer
//      in the body;
//   3. otherwise unmapped (counted, never guessed).
//
// Ambiguity (two non-terminal tasks claim one PR) and terminal-only claimants
// are unmapped: falling back to a branch ref there would pick a task to wake,
// which is exactly the wrong guess this module exists to refuse. Legacy
// URL-only rows (no externalId) cannot be indexed; reconcile adopts them by
// URL on the already-resolved issue instead.
//
// PR text is untrusted input: a bad or missing ref resolves to unmapped, never
// throws. Our own index shapes throw, because a silently misread index would
// look exactly like "nothing to do".
import { extractIssueRef } from './bridge.js'

// Task refs are `PREFIX-n` (letter-led prefix, positive number): the private
// tracker is one issuer among others, never hardcoded here.
const REF = /^([A-Z][A-Z0-9]*)-([1-9]\d*)$/
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+#[1-9]\d*$/
const TERMINAL = new Set(['done', 'cancelled'])

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * A `Refs: PREFIX-n` trailer line in the PR body (GitHub standard, Linked
 * Issues section). Prose mentions of other issues do not count: only a line
 * whose value is exactly the ref. First valid trailer wins.
 *
 * @param {string | null | undefined} text
 * @returns {string | null} normalized `PREFIX-n`, or null
 */
export function extractRefsTrailer(text) {
  if (typeof text !== 'string') return null
  for (const line of text.split('\n')) {
    const m = /^\s*refs:\s*(.*?)\s*$/i.exec(line)
    if (!m) continue
    const t = /^([A-Za-z][A-Za-z0-9]*)-([1-9]\d*)$/.exec(m[1])
    const ref = t ? `${t[1].toUpperCase()}-${t[2]}` : null
    if (ref) return ref
  }
  return null
}

function strictRef(text) {
  const ref = extractIssueRef(text)
  return ref && REF.test(ref) ? ref : null
}

/**
 * Build the index from candidate issue/product rows.
 *
 * @param {Array<{ issue: { id: string, identifier: string, status: string },
 *   products: Array<{ type: string, provider: string, externalId: string | null }> }>} entries
 * @returns {{ byPr: Map<string, { issueId: string, issueRef: string }>,
 *   claimed: Set<string>, ambiguous: Set<string> }}
 */
export function buildPrTaskIndex(entries) {
  requireValue(Array.isArray(entries) && entries.length <= 100000, 'PR task index entries are invalid')
  const claimants = new Map()
  for (const entry of entries) {
    requireValue(entry && typeof entry === 'object', 'PR task index entry is invalid')
    const { issue, products } = entry
    requireValue(issue && typeof issue.id === 'string' && issue.id.length > 0 &&
      typeof issue.identifier === 'string' && REF.test(issue.identifier) &&
      typeof issue.status === 'string' && issue.status.length > 0, 'PR task index issue is invalid')
    requireValue(Array.isArray(products) && products.length <= 10000, 'PR task index products are invalid')
    const terminal = TERMINAL.has(issue.status)
    for (const p of products) {
      requireValue(p && typeof p === 'object' && typeof p.type === 'string' &&
        typeof p.provider === 'string' && (p.externalId === null || typeof p.externalId === 'string'),
      'PR task index product is invalid')
      if (p.type !== 'pull_request' || p.provider !== 'github') continue
      if (p.externalId === null) continue
      requireValue(EXTERNAL_ID.test(p.externalId), 'PR task index externalId is malformed')
      // One claimant per issue: duplicate rows on the same task are a repair
      // job for reconcile, not two owners.
      const byIssue = claimants.get(p.externalId) ?? new Map()
      byIssue.set(issue.id, { issueId: issue.id, issueRef: issue.identifier, terminal })
      claimants.set(p.externalId, byIssue)
    }
  }
  const byPr = new Map()
  const claimed = new Set()
  const ambiguous = new Set()
  for (const [key, byIssue] of claimants) {
    claimed.add(key)
    const live = [...byIssue.values()].filter((c) => !c.terminal)
    if (live.length === 1) byPr.set(key, { issueId: live[0].issueId, issueRef: live[0].issueRef })
    else if (live.length > 1) ambiguous.add(key)
  }
  return { byPr, claimed, ambiguous }
}

/**
 * Resolve one PR to its owning task.
 *
 * @param {{ repository: string, number: number, branchRef?: string | null,
 *   bodyText?: string | null, isPrivate?: boolean, index?: ReturnType<typeof buildPrTaskIndex> | null }} args
 * @returns {{ issueRef: string, issueId: string | null, source: 'work-product' | 'ref' } |
 *   { unmapped: 'ambiguous' | 'terminal-only' | 'no-work-product' | 'no-ref' }}
 */
export function resolvePrTask({ repository, number, branchRef = null, bodyText = null, isPrivate = true, index = null }) {
  requireValue(typeof repository === 'string' && repository.length > 0, 'PR repository is invalid')
  requireValue(Number.isSafeInteger(number) && number > 0, 'PR number is invalid')
  const key = `${repository}#${number}`
  if (index) {
    requireValue(index.byPr instanceof Map && index.claimed instanceof Set && index.ambiguous instanceof Set,
      'PR task index is invalid')
    const hit = index.byPr.get(key)
    if (hit) return { issueRef: hit.issueRef, issueId: hit.issueId, source: 'work-product' }
    if (index.claimed.has(key)) {
      return { unmapped: index.ambiguous.has(key) ? 'ambiguous' : 'terminal-only' }
    }
  }
  // Public repos carry no internal refs (standing rule); never guess from
  // branch or body text there. The work-product row above is their only path.
  if (!isPrivate) return { unmapped: 'no-work-product' }
  const ref = strictRef(branchRef) ?? extractRefsTrailer(bodyText)
  return ref
    ? { issueRef: ref, issueId: null, source: 'ref' }
    : { unmapped: 'no-ref' }
}
