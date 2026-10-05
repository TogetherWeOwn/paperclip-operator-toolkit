// configured approver-GO scan on a Paperclip card. Reads the issue's comments and returns the
// set of digests the configured approver has posted GO for. No network reaches GitHub here
// and no credential is minted: the GO half arrives over this board transport,
// and a scan that cannot complete throws so the caller fails closed rather
// than reading an empty GO set as "no approval".
//
// GO recognition is deliberately narrow. A comment counts ONLY when it is
// authored by the configured approver agent identity AND names a digest bound to the literal
// `GO` marker: `GO <64hex>` for a plan hash (plan mode), `GO <40hex>` for a
// deploy head SHA (sha mode). Everything else — owner prose, operator notes,
// configured approver prose without a digest, digests without the marker — contributes
// nothing. Expansive matching here would turn ordinary discussion into an
// approval, which is exactly the failure this rule exists to prevent.
//
// The two markers are disjoint by construction: the 40-hex pattern carries a
// trailing `(?![0-9a-f])` lookahead, so the first 40 chars of a 64-hex hash
// never match it; the 64-hex pattern needs 64 chars, so a bare SHA never
// matches it. One comment can carry both markers for different digests.

import { validateApproverAgentId } from './environments.js'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const HASH64 = /[0-9a-f]{64}/g
// The markers accept hex case and normalize digests to lowercase, preserving
// the recognition contract: `GO <64hex>` (plan hash), `GO <40hex>` (deploy SHA).
// Their widths remain disjoint even when marker/digest case varies.
const GO_HASH_LINE = /(^|[\s(>"'\-*:])go[\s:]+([0-9a-f]{64})(?![0-9a-f])/gim
const GO_SHA_LINE = /(^|[\s(>"'\-*:])go[\s:]+([0-9a-f]{40})(?![0-9a-f])/gim

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

/** Validate the origin before a credential can reach a board transport. */
export function validateBoardOrigin(boardOrigin) {
  try {
    const url = new URL(boardOrigin)
    requireValue(
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash,
      'invalid origin',
    )
    return url.origin
  } catch {
    throw new Error('Paperclip board origin must be HTTPS or loopback HTTP, with no credentials, path or query')
  }
}

/**
 * Read every comment on one issue. Throws unless the read completes with a
 * valid list — the caller fails closed, never with an empty approval set.
 */
async function readBoardComments({ fetchImpl, boardOrigin, token, issueId, timeoutMs }) {
  requireValue(typeof fetchImpl === 'function', 'board transport is required')
  const origin = validateBoardOrigin(boardOrigin)
  requireValue(typeof token === 'string' && token.length > 0 && !/\s/.test(token), 'board credential is missing')
  requireValue(typeof issueId === 'string' && UUID.test(issueId), 'board issue selector is invalid')
  requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'board timeout is invalid')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let comments
  try {
    const response = await fetchImpl(`${origin}/api/issues/${issueId}/comments?order=asc`, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    })
    requireValue(response.status === 200, 'board comment read failed')
    try {
      comments = await response.json()
    } catch {
      comments = null
    }
  } finally {
    clearTimeout(timer)
  }
  requireValue(Array.isArray(comments), 'board comment list is invalid')
  return comments
}

/**
 * Collect distinct digests matching one marker pattern from configured approver-authored
 * comments, in first-seen order. The author gate runs first: identity is the
 * approval, not the text.
 */
function collectGoDigests(comments, pattern, approverAgentId) {
  /** @type {string[]} */
  const digests = []
  const seen = new Set()
  for (const comment of comments) {
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)) continue
    if (comment.authorAgentId !== approverAgentId || comment.authorUserId !== null) continue
    if (typeof comment.body !== 'string' || comment.body.length === 0) continue
    if (comment.body.length > 1024 * 1024) continue
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(comment.body)) !== null) {
      const digest = match[2].toLowerCase()
      if (!seen.has(digest)) {
        seen.add(digest)
        digests.push(digest)
      }
    }
  }
  return digests
}

/**
 * Scan every comment on the issue for configured approver `GO <64hex>` plan-hash markers.
 * Returns the distinct GO'd hashes in first-seen order.
 *
 * @param {object} args
 * @param {(url: string, init?: object) => Promise<Response>} args.fetchImpl
 * @param {string} args.boardOrigin   `https://host` only: no path, query, or credentials
 * @param {string} args.token         board credential; header only, never logged
 * @param {string} args.issueId       Paperclip issue UUID
 * @param {string} args.approverAgentId  required trusted operator configuration, never a comment/request field
 * @param {number} [args.timeoutMs]
 * @returns {Promise<string[]>}
 */
export async function scanChiefGo({ fetchImpl, boardOrigin, token, issueId, approverAgentId, timeoutMs = 30000 }) {
  validateApproverAgentId(approverAgentId)
  const comments = await readBoardComments({ fetchImpl, boardOrigin, token, issueId, timeoutMs })
  return collectGoDigests(comments, GO_HASH_LINE, approverAgentId)
}

/**
 * Scan every comment on the issue for configured approver `GO <40hex>` deploy-SHA markers.
 * Returns the distinct GO'd head SHAs in first-seen order.
 *
 * @param {object} args
 * @param {(url: string, init?: object) => Promise<Response>} args.fetchImpl
 * @param {string} args.boardOrigin   `https://host` only: no path, query, or credentials
 * @param {string} args.token         board credential; header only, never logged
 * @param {string} args.issueId       Paperclip issue UUID
 * @param {string} args.approverAgentId  required trusted operator configuration, never a comment/request field
 * @param {number} [args.timeoutMs]
 * @returns {Promise<string[]>}
 */
export async function scanChiefGoShas({ fetchImpl, boardOrigin, token, issueId, approverAgentId, timeoutMs = 30000 }) {
  validateApproverAgentId(approverAgentId)
  const comments = await readBoardComments({ fetchImpl, boardOrigin, token, issueId, timeoutMs })
  return collectGoDigests(comments, GO_SHA_LINE, approverAgentId)
}

export { HASH64 }

