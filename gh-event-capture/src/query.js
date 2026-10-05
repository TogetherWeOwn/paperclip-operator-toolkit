// Query-string parsing for `GET /events`.
//
// Strict by construction: an unknown parameter is a 400, not a silent ignore. A
// typo'd filter that is quietly dropped returns MORE rows than asked for, and
// the caller reads that as "no matches were excluded". In a tool whose whole
// job is answering "what happened to this repo", a silently-widened query is a
// wrong answer that looks like a right one.

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 500

const ALLOWED = new Set([
  'event',
  'action',
  'repository',
  'sender',
  'organization',
  'delivery_id',
  'since',
  'until',
  'limit',
  'cursor',
  'include_body',
])

// Keyset cursor: `<received_ms>.<delivery_id>`. Opaque to callers by
// convention, readable on purpose when someone is debugging at 2am.
const CURSOR = /^(\d{1,15})\.(.{1,128})$/

function parameterError(params, allowed) {
  for (const key of params.keys()) {
    if (!allowed.has(key)) return `unknown parameter: ${key}`
    if (params.getAll(key).length !== 1) return `duplicate parameter: ${key}`
  }
  return null
}

function parseLimit(raw) {
  if (raw === null) return { ok: true, limit: DEFAULT_LIMIT }
  if (!/^\d{1,4}$/.test(raw)) return { ok: false, error: `limit is not an integer: ${raw}` }
  const limit = Number(raw)
  if (limit < 1 || limit > MAX_LIMIT) return { ok: false, error: `limit out of range 1..${MAX_LIMIT}` }
  return { ok: true, limit }
}

const BRIDGE_ALLOWED = new Set(['issue_ref', 'limit'])

export function parseBridgeQuery(params) {
  const error = parameterError(params, BRIDGE_ALLOWED)
  if (error) return { ok: false, error }
  const issueRef = params.get('issue_ref')
  // Task refs are `PREFIX-n` (letter-led prefix, positive number): the private
  // tracker is one issuer among others, never hardcoded here.
  if (issueRef !== null && !/^([A-Z][A-Z0-9]*)-\d+$/.test(issueRef)) {
    return { ok: false, error: 'issue_ref must look like PREFIX-123' }
  }
  const parsed = parseLimit(params.get('limit'))
  if (!parsed.ok) return parsed
  return { ok: true, filters: { issueRef, limit: parsed.limit } }
}

/**
 * @param {string} v
 * @returns {number | null} epoch ms, or null if unparseable
 */
function parseTime(v) {
  // Accept both ISO-8601 and a bare epoch-ms integer; operators reach for both.
  if (/^\d{10,15}$/.test(v)) return Number(v)
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : ms
}

/**
 * @param {URLSearchParams} params
 * @returns {{ ok: true, filters: object } | { ok: false, error: string }}
 */
export function parseQuery(params) {
  const error = parameterError(params, ALLOWED)
  if (error) return { ok: false, error }

  /** @type {any} */
  const filters = {
    event: params.get('event'),
    action: params.get('action'),
    repository: params.get('repository'),
    sender: params.get('sender'),
    organization: params.get('organization'),
    delivery_id: params.get('delivery_id'),
    sinceMs: null,
    untilMs: null,
    limit: DEFAULT_LIMIT,
    cursor: null,
    includeBody: false,
  }

  for (const [name, key] of [['since', 'sinceMs'], ['until', 'untilMs']]) {
    const raw = params.get(name)
    if (raw === null) continue
    const ms = parseTime(raw)
    if (ms === null) return { ok: false, error: `${name} is not a timestamp: ${raw}` }
    filters[key] = ms
  }
  if (filters.sinceMs !== null && filters.untilMs !== null && filters.sinceMs > filters.untilMs) {
    return { ok: false, error: 'since is after until' }
  }

  const parsedLimit = parseLimit(params.get('limit'))
  if (!parsedLimit.ok) return parsedLimit
  filters.limit = parsedLimit.limit

  const cursorRaw = params.get('cursor')
  if (cursorRaw !== null) {
    const m = CURSOR.exec(cursorRaw)
    if (m === null) return { ok: false, error: 'cursor is malformed' }
    filters.cursor = { receivedMs: Number(m[1]), deliveryId: m[2] }
  }

  const includeBody = params.get('include_body')
  if (includeBody !== null) {
    // Only the two explicit spellings. "0", "false", "no" and "" are all
    // plainly meant as off, and anything else is a caller who thinks this
    // parameter does something it does not.
    if (includeBody === '1' || includeBody === 'true') filters.includeBody = true
    else if (includeBody === '0' || includeBody === 'false') filters.includeBody = false
    else return { ok: false, error: 'include_body must be 1, 0, true or false' }
  }

  return { ok: true, filters }
}

/**
 * Cursor for the row after `row`, or null when the page was not full.
 *
 * @param {object[]} rows
 * @param {number} limit
 * @returns {string | null}
 */
export function nextCursor(rows, limit) {
  if (rows.length < limit) return null
  const last = /** @type {any} */ (rows[rows.length - 1])
  return `${last.received_ms}.${last.delivery_id}`
}
