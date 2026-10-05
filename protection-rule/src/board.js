// CEO-GO scan on a Paperclip card. Reads the issue's comments and returns the
// set of digests the CEO has posted GO for. No network reaches GitHub here
// and no credential is minted: the GO half arrives over this board transport,
// and a scan that cannot complete throws so the caller fails closed rather
// than reading an empty GO set as "no approval".
//
// GO recognition is deliberately narrow. A comment counts ONLY when it is
// authored by the CEO agent identity AND names a digest bound to the literal
// `GO` marker: `GO <64hex>` for a plan hash (plan mode), `GO <40hex>` for a
// deploy head SHA (sha mode). Everything else — owner prose, operator notes,
// CEO prose without a digest, digests without the marker — contributes
// nothing. Expansive matching here would turn ordinary discussion into an
// approval, which is exactly the failure this rule exists to prevent.
//
// The two markers are disjoint by construction: the 40-hex pattern carries a
// trailing `(?![0-9a-f])` lookahead, so the first 40 chars of a 64-hex hash
// never match it; the 64-hex pattern needs 64 chars, so a bare SHA never
// matches it. One comment can carry both markers for different digests.

// The CEO agent identity is operator configuration, never code: the scanner
// takes it as a required argument, and the server binds it from the
// PROTECTION_RULE_CEO_AGENT_ID environment. A hardcoded identity here would
// approve on one deployment's GO set wherever this module runs.
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const HASH64 = /[0-9a-f]{64}/g
// The markers, case-insensitive on the word only: `GO <64hex>` (plan hash),
// `GO <40hex>` (deploy head SHA). Digest halves stay lowercase-hex, matching
// the artifact and commit encoding everywhere else.
const GO_HASH_LINE = /(^|[\s(>"'\-*:])go[\s:]+([0-9a-f]{64})(?![0-9a-f])/gim
const GO_SHA_LINE = /(^|[\s(>"'\-*:])go[\s:]+([0-9a-f]{40})(?![0-9a-f])/gim

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Read every comment on one issue. Throws unless the read completes with a
 * valid list — the caller fails closed, never with an empty approval set.
 */
async function readBoardComments({ fetchImpl, boardOrigin, token, issueId, timeoutMs }) {
  requireValue(typeof fetchImpl === 'function', 'board transport is required')
  let origin
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
    origin = url.origin
  } catch {
    throw new Error('Paperclip board origin must be HTTPS or loopback HTTP, with no credentials, path or query')
  }
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
 * Collect distinct digests matching one marker pattern from CEO-authored
 * comments, in first-seen order. The author gate runs first: identity is the
 * approval, not the text.
 */
function collectGoDigests(comments, pattern, ceoAgentId) {
  /** @type {string[]} */
  const digests = []
  const seen = new Set()
  for (const comment of comments) {
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)) continue
    if (comment.authorAgentId !== ceoAgentId || comment.authorUserId !== null) continue
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
 * Scan every comment on the issue for CEO `GO <64hex>` plan-hash markers.
 * Returns the distinct GO'd hashes in first-seen order.
 *
 * @param {object} args
 * @param {(url: string, init?: object) => Promise<Response>} args.fetchImpl
 * @param {string} args.boardOrigin   `https://host` only: no path, query, or credentials
 * @param {string} args.token         board credential; header only, never logged
 * @param {string} args.issueId       Paperclip issue UUID
 * @param {string} args.ceoAgentId    CEO agent UUID; required, operator-configured
 * @param {number} [args.timeoutMs]
 * @returns {Promise<string[]>}
 */
export async function scanChiefGo({ fetchImpl, boardOrigin, token, issueId, ceoAgentId, timeoutMs = 30000 }) {
  requireValue(typeof ceoAgentId === 'string' && UUID.test(ceoAgentId), 'CEO identity is invalid')
  const comments = await readBoardComments({ fetchImpl, boardOrigin, token, issueId, timeoutMs })
  return collectGoDigests(comments, GO_HASH_LINE, ceoAgentId)
}

/**
 * Scan every comment on the issue for CEO `GO <40hex>` deploy-SHA markers.
 * Returns the distinct GO'd head SHAs in first-seen order.
 *
 * @param {object} args
 * @param {(url: string, init?: object) => Promise<Response>} args.fetchImpl
 * @param {string} args.boardOrigin   `https://host` only: no path, query, or credentials
 * @param {string} args.token         board credential; header only, never logged
 * @param {string} args.issueId       Paperclip issue UUID
 * @param {string} args.ceoAgentId    CEO agent UUID; required, operator-configured
 * @param {number} [args.timeoutMs]
 * @returns {Promise<string[]>}
 */
export async function scanChiefGoShas({ fetchImpl, boardOrigin, token, issueId, ceoAgentId, timeoutMs = 30000 }) {
  requireValue(typeof ceoAgentId === 'string' && UUID.test(ceoAgentId), 'CEO identity is invalid')
  const comments = await readBoardComments({ fetchImpl, boardOrigin, token, issueId, timeoutMs })
  return collectGoDigests(comments, GO_SHA_LINE, ceoAgentId)
}

export { HASH64 }

