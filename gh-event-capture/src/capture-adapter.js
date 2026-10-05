// Host transport for the capture API, not a durable cursor/checkpoint runner.
// Every scan starts at its newest page; callers must not treat received_ms as
// an append sequence or skip replay solely because a timestamp was seen before.
import { AGENT_LOGIN, claimKey } from './bridge.js'

const EVENTS = new Set(['pull_request', 'check_suite'])
const ID = /^[A-Za-z0-9._:-]{1,128}$/
const SHA = /^[a-f0-9]{40}$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
const MAX_MS = 999999999999999

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_MS
}
function identity(row) {
  requireValue(row && typeof row.delivery_id === 'string' && ID.test(row.delivery_id) &&
    timestamp(row.received_ms), 'capture row identity is incomplete')
}
function older(a, b) {
  return a.received_ms < b.received_ms || (a.received_ms === b.received_ms && a.delivery_id < b.delivery_id)
}
function payloadOf(row) {
  let payload
  try { payload = JSON.parse(row.body) } catch { throw new Error('capture delivery JSON is invalid') }
  requireValue(payload && typeof payload === 'object' && !Array.isArray(payload) &&
    payload.repository?.full_name === row.repository, 'capture delivery repository is incomplete or mismatched')
  return payload
}

export function createCaptureAdapter({ baseUrl, queryToken, allowedRepositories,
  fetchImpl = globalThis.fetch, timeoutMs = 30000, maxResponseBytes = 4 * 1024 * 1024,
  pageSize = 50, maxPages = 100 }) {
  let origin
  try {
    const url = new URL(baseUrl)
    requireValue(url.protocol === 'https:' && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash, 'invalid origin')
    origin = url.origin
  } catch { throw new Error('capture base URL must be an HTTPS origin without credentials, path or query') }
  requireValue(typeof queryToken === 'string' && queryToken.length > 0 && !/\s/.test(queryToken),
    'capture query token is missing or invalid')
  requireValue(Array.isArray(allowedRepositories) && allowedRepositories.length > 0 &&
    allowedRepositories.every((repo) => typeof repo === 'string' && REPOSITORY.test(repo)),
  'an explicit capture repository allowlist is required')
  requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'capture timeout is invalid')
  requireValue(Number.isInteger(maxResponseBytes) && maxResponseBytes > 0 && maxResponseBytes <= 16 * 1024 * 1024,
    'capture response budget is invalid')
  requireValue(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 500 &&
    Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 1000, 'capture page budget is invalid')
  const repositories = new Set(allowedRepositories)
  function scope(repo) { requireValue(repositories.has(repo), 'capture repository is outside the configured scope') }

  async function request(path, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    let reader
    try {
      response = await fetchImpl(origin + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
        headers: { authorization: `Bearer ${queryToken}`, accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      })
      // No redirect following with a bearer credential; no HTML/partial-success
      // response can masquerade as data. Never expose error response contents.
      requireValue(response.status === 200 && !response.redirected &&
        /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'invalid capture response')
      const length = response.headers.get('content-length')
      requireValue(length === null || (/^\d+$/.test(length) && Number(length) <= maxResponseBytes), 'capture body too large')
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0
      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        requireValue(bytes <= maxResponseBytes, 'capture body too large')
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
      return JSON.parse(text)
    } catch {
      // Fetch errors may contain request URLs, credentials or response bodies.
      // Do not retain their message/cause or log a partially received response.
      throw new Error(controller.signal.aborted ? 'capture request timed out' : 'capture request failed or response was invalid')
    } finally {
      clearTimeout(timer)
      if (reader) {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      } else if (response?.body) {
        void response.body.cancel().catch(() => {})
      }
    }
  }

  async function getDelivery(id) {
    requireValue(typeof id === 'string' && ID.test(id), 'capture delivery ID is invalid')
    const row = await request(`/events/${encodeURIComponent(id)}`)
    identity(row)
    requireValue(row.delivery_id === id && EVENTS.has(row.event), 'capture delivery identity does not match')
    scope(row.repository)
    requireValue(row.body_truncated === 0 && typeof row.body === 'string', 'capture delivery body is incomplete')
    payloadOf(row)
    return row
  }

  async function listDeliveries(options) {
    requireValue(options && typeof options === 'object' && !Array.isArray(options) &&
      Object.keys(options).every((key) => ['repository', 'event', 'sinceMs', 'untilMs'].includes(key)),
    'capture scan has unknown or invalid filters')
    const { repository, event, sinceMs = null, untilMs = null } = options
    scope(repository)
    requireValue(EVENTS.has(event), 'capture event is outside bridge scope')
    requireValue((sinceMs === null || timestamp(sinceMs)) && (untilMs === null || timestamp(untilMs)) &&
      (sinceMs === null || untilMs === null || sinceMs <= untilMs), 'capture time window is invalid')
    const params = new URLSearchParams({ repository, event, limit: String(pageSize), include_body: '0' })
    if (sinceMs !== null) params.set('since', new Date(sinceMs).toISOString())
    if (untilMs !== null) params.set('until', new Date(untilMs).toISOString())
    const rows = []
    const ids = new Set()
    let previous = null
    for (let page = 0; page < maxPages; page++) {
      const result = await request(`/events?${params}`)
      requireValue(result && Array.isArray(result.events) && result.count === result.events.length &&
        result.count <= pageSize, 'capture page is incomplete')
      for (const row of result.events) {
        identity(row)
        requireValue(row.repository === repository && row.event === event &&
          (sinceMs === null || row.received_ms >= sinceMs) && (untilMs === null || row.received_ms <= untilMs),
        'capture page does not match its filters')
        requireValue(!ids.has(row.delivery_id) && (!previous || older(row, previous)), 'capture page order did not advance')
        ids.add(row.delivery_id)
        rows.push(row)
        previous = row
      }
      const expected = result.count < pageSize ? null : `${previous.received_ms}.${previous.delivery_id}`
      requireValue(result.next_cursor === expected, 'capture page cursor is incomplete or inconsistent')
      if (expected === null) return rows
      params.set('cursor', expected)
    }
    throw new Error('capture page budget exceeded; scan is incomplete')
  }

  async function getPullRequestDelivery(repository, number, sha) {
    scope(repository)
    requireValue(Number.isSafeInteger(number) && number > 0 && typeof sha === 'string' && SHA.test(sha),
      'capture PR evidence selector is invalid')
    // Listing omits bodies to keep page responses bounded. There is no PR-number
    // filter in this API, so resolve candidate bodies individually, newest first.
    const rows = await listDeliveries({ repository, event: 'pull_request' })
    for (const entry of rows) {
      const row = await getDelivery(entry.delivery_id)
      requireValue(row.repository === repository && row.event === 'pull_request' && row.received_ms === entry.received_ms,
        'capture PR evidence changed identity')
      const pr = payloadOf(row).pull_request
      if (pr?.number === number && pr.base?.repo?.full_name === repository &&
        pr.head?.sha === sha && pr.user?.login === AGENT_LOGIN) return row
    }
    return null
  }

  async function claim(body) {
    requireValue(body && /^([A-Z][A-Z0-9]*)-\d+$/.test(body.issue_ref) && typeof body.head_sha === 'string' && SHA.test(body.head_sha) &&
      ['check_suite_completed', 'pull_request_merged'].includes(body.kind), 'capture wake claim is invalid')
    // Re-read source identity before POST so the shared query token cannot be
    // used by this adapter to claim outside its configured repository scope.
    const delivery = await getDelivery(body.delivery_id)
    requireValue(delivery.event === (body.kind === 'pull_request_merged' ? 'pull_request' : 'check_suite'),
      'capture wake source event does not match')
    const claim = { issue_ref: body.issue_ref, head_sha: body.head_sha, kind: body.kind, delivery_id: body.delivery_id }
    if (body.kind === 'check_suite_completed') {
      const evidence = await getDelivery(body.pr_delivery_id)
      requireValue(evidence.event === 'pull_request' && evidence.repository === delivery.repository,
        'capture wake evidence repository does not match')
      claim.pr_delivery_id = body.pr_delivery_id
    }
    // The server reclassifies stored signed bodies and validates the exact
    // effect. Neither HTTP failures nor ambiguous write responses are retried.
    const result = await request('/bridge/claim', claim)
    const key = claimKey({ issueRef: body.issue_ref, headSha: body.head_sha, kind: body.kind })
    requireValue(result?.ok === true && typeof result.claimed === 'boolean' && result.claim_key === key,
      'capture did not confirm the wake claim')
    return result
  }

  return { listDeliveries, getDelivery, getPullRequestDelivery, claim }
}
