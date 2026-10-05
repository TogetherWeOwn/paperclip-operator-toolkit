// Non-waking Paperclip transport for products-only-v1. Deliberately exposes no
// comment, agent wakeup, issue mutation or eligibility operation.
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
import { trustedBridgePolicy, trustedRepositories, normalizeIssueRef } from './trusted-policy.js'
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
const TYPES = new Set(['preview_url', 'runtime_service', 'pull_request', 'branch', 'commit', 'artifact', 'document'])
const STATUSES = new Set(['active', 'ready_for_review', 'approved', 'changes_requested', 'merged', 'closed', 'failed', 'archived', 'draft'])
const REVIEWS = new Set(['none', 'needs_board_review', 'approved', 'changes_requested'])
function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const uuid = (v) => typeof v === 'string' && UUID.test(v)

export function createPaperclipAdapter({ baseUrl, token, companyId, allowedRepositories, bridgePolicy,
  runId = null, fetchImpl = globalThis.fetch, timeoutMs = 30000,
  maxResponseBytes = 4 * 1024 * 1024, maxProducts = 10000 }) {
  const policy = trustedBridgePolicy(bridgePolicy)
  trustedRepositories(allowedRepositories)
  let origin
  try {
    const url = new URL(baseUrl)
    requireValue((url.protocol === 'https:' || (url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash, 'invalid origin')
    origin = url.origin
  } catch { throw new Error('Paperclip base URL must be HTTPS or loopback HTTP, with no credentials, path or query') }
  requireValue(typeof token === 'string' && token.length > 0 && !/\s/.test(token), 'Paperclip credential is missing or invalid')
  requireValue(uuid(companyId) && (runId === null || uuid(runId)), 'Paperclip company/run identity is invalid')
  requireValue(Array.isArray(allowedRepositories) && allowedRepositories.length > 0 &&
    allowedRepositories.every((repo) => typeof repo === 'string' && REPO.test(repo)), 'Paperclip repository scope is required')
  requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000 &&
    Number.isInteger(maxResponseBytes) && maxResponseBytes > 0 && maxResponseBytes <= 16 * 1024 * 1024 &&
    Number.isInteger(maxProducts) && maxProducts > 0 && maxProducts <= 100000, 'Paperclip transport budget is invalid')
  const repositories = new Set(allowedRepositories)
  const issues = new Set()
  const productIssues = new Map()

  async function request(method, path, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    let reader
    try {
      const encoded = body === undefined ? undefined : JSON.stringify(body)
      requireValue(encoded === undefined || Buffer.byteLength(encoded) <= maxResponseBytes, 'request too large')
      response = await fetchImpl(origin + '/api' + path, {
        method, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json',
          ...(encoded === undefined ? {} : { 'content-type': 'application/json' }),
          ...(method !== 'GET' && runId !== null ? { 'X-Paperclip-Run-Id': runId } : {}) },
        ...(encoded === undefined ? {} : { body: encoded }),
      })
      requireValue((response.status === 200 || (method === 'POST' && response.status === 201)) &&
        !response.redirected && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''),
      'invalid response')
      const length = response.headers.get('content-length')
      requireValue(length === null || (/^\d+$/.test(length) && Number(length) <= maxResponseBytes), 'response too large')
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0
      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        requireValue(bytes <= maxResponseBytes, 'response too large')
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
      return JSON.parse(text)
    } catch {
      // Do not retain provider error messages, response bodies or nested causes.
      // In particular, a failed write is never automatically retried here.
      throw new Error(controller.signal.aborted ? 'Paperclip request timed out' : 'Paperclip request failed or response was invalid')
    } finally {
      clearTimeout(timer)
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock() }
      else if (response?.body) void response.body.cancel().catch(() => {})
    }
  }
  async function getIssue(refOrId) {
    requireValue(typeof refOrId === 'string' && (normalizeIssueRef(refOrId, policy) !== null || uuid(refOrId)), 'Paperclip issue selector is invalid')
    const issue = await request('GET', `/issues/${encodeURIComponent(refOrId)}`)
    requireValue(object(issue) && uuid(issue.id) && issue.companyId === companyId && normalizeIssueRef(issue.identifier, policy) !== null &&
      (uuid(refOrId) ? issue.id === refOrId : issue.identifier === refOrId), 'Paperclip issue identity or company does not match')
    issues.add(issue.id)
    // Product mode needs identity only. Do not expose partial eligibility data
    // that a full-mode caller could mistake for an atomic eligibility contract.
    return { id: issue.id, identifier: issue.identifier, companyId }
  }
  function issueScope(id) {
    requireValue(uuid(id) && issues.has(id), 'Paperclip issue must first be resolved in this company')
  }
  function productShape(p, issueId) {
    requireValue(object(p) && uuid(p.id) && p.companyId === companyId && p.issueId === issueId &&
      TYPES.has(p.type) && typeof p.provider === 'string' && p.provider.length > 0 &&
      typeof p.title === 'string' && p.title.length > 0 && STATUSES.has(p.status) && REVIEWS.has(p.reviewState) &&
      (p.url === null || typeof p.url === 'string') && (p.externalId === null || typeof p.externalId === 'string') &&
      (p.metadata === null || object(p.metadata)), 'Paperclip product identity or shape does not match')
  }
  async function listWorkProducts(issueId) {
    issueScope(issueId)
    // Installed API returns the complete array, with no pagination or limit.
    // Refuse a future envelope/cap rather than treating it as an empty result.
    const rows = await request('GET', `/issues/${issueId}/work-products`)
    requireValue(Array.isArray(rows) && rows.length <= maxProducts, 'Paperclip product list is incomplete or exceeds its budget')
    const ids = new Set()
    for (const p of rows) {
      productShape(p, issueId)
      requireValue(!ids.has(p.id), 'Paperclip product list contains duplicate identities')
      ids.add(p.id)
    }
    for (const [id, bound] of productIssues) if (bound === issueId) productIssues.delete(id)
    for (const p of rows) if (p.type === 'pull_request' && p.provider === 'github') productIssues.set(p.id, issueId)
    return rows
  }
  function writeBody(body) {
    requireValue(object(body) && body.type === 'pull_request' && body.provider === 'github' &&
      typeof body.title === 'string' && body.title.length > 0 && STATUSES.has(body.status) && REVIEWS.has(body.reviewState) &&
      object(body.metadata), 'Paperclip PR write is incomplete')
    const { repo, number, headSha } = body.metadata
    requireValue(repositories.has(repo) && Number.isSafeInteger(number) && number > 0 &&
      typeof headSha === 'string' && /^[a-f0-9]{40}$/.test(headSha) &&
      body.url === `https://github.com/${repo}/pull/${number}` && body.externalId === `${repo}#${number}`,
    'Paperclip PR write is outside repository scope or has conflicting identity')
    // Whitelist fields. Callers cannot smuggle assignees, status transitions of
    // issues, run attribution or other issue fields through a product request.
    return { type: 'pull_request', provider: 'github', title: body.title, url: body.url,
      externalId: body.externalId, status: body.status, reviewState: body.reviewState, metadata: body.metadata }
  }
  async function write(method, path, issueId, body, expectedId) {
    issueScope(issueId)
    const payload = writeBody(body)
    const result = await request(method, path, payload)
    productShape(result, issueId)
    requireValue((!expectedId || result.id === expectedId) &&
      ['type', 'provider', 'title', 'url', 'externalId', 'status', 'reviewState'].every((key) => result[key] === payload[key]) &&
      result.metadata?.repo === payload.metadata.repo && result.metadata?.number === payload.metadata.number &&
      result.metadata?.headSha === payload.metadata.headSha, 'Paperclip did not confirm the PR write')
    productIssues.set(result.id, issueId)
    return result
  }
  async function createWorkProduct(issueId, body) {
    issueScope(issueId)
    return write('POST', `/issues/${issueId}/work-products`, issueId, body)
  }
  async function updateWorkProduct(id, body) {
    requireValue(uuid(id) && productIssues.has(id), 'Paperclip product must first be listed in this company')
    return write('PATCH', `/work-products/${id}`, productIssues.get(id), body, id)
  }
  return { getIssue, listWorkProducts, createWorkProduct, updateWorkProduct }
}
