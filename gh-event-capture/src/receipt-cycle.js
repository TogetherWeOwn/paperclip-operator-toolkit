import { trustedBridgePolicy, trustedVisibility, trustedRepositories } from './trusted-policy.js'
// One serialized delivery pass. No timestamp checkpoint, retries or background
// work: the entrypoint must hold withReceiptStore's lock for the entire pass.
import { createHash } from 'node:crypto'

const EVENTS = ['pull_request', 'check_suite']
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
const WAKES = new Set(['not-requested', 'stale', 'ineligible', 'duplicate',
  'ineligible-after-claim', 'ineligible-at-post', 'sent'])
const IGNORED = new Set(['not-agent-authored', 'no-issue-reference', 'unscoped-PR', 'nonterminal-suite'])
const hash = (text) => createHash('sha256').update(text).digest('hex')
function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
function repositories(value) {
  requireValue(Array.isArray(value) && value.length > 0 && value.every((r) => typeof r === 'string' && REPOSITORY.test(r)) &&
    new Set(value).size === value.length, 'receipt cycle requires a unique repository allowlist')
  return [...trustedRepositories(value)].sort()
}
function origin(value) {
  try {
    const url = new URL(value)
    requireValue((url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) &&
      !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'invalid origin')
    return url.origin
  } catch { throw new Error('receipt namespace requires credential-free service origins') }
}
export function receiptNamespace({ captureOrigin, boardOrigin, companyId, allowedRepositories, mode, bridgePolicy, repositoryVisibility }) {
  const policy = trustedBridgePolicy(bridgePolicy)
  const visibility = trustedVisibility(repositoryVisibility, allowedRepositories)
  requireValue(typeof companyId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(companyId), 'receipt namespace requires a company ID')
  // Other modes need their own explicit policy and replay decision; never reuse
  // full-mode receipts to claim work-product-only processing delivered wakes.
  requireValue(['full-v1', 'products-only-v1'].includes(mode), 'unsupported receipt processing mode')
  return hash(JSON.stringify([origin(captureOrigin), origin(boardOrigin), companyId, repositories(allowedRepositories), mode, policy, visibility]))
}
export function deliveryFingerprint(row) {
  requireValue(row && typeof row.delivery_id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(row.delivery_id) &&
    Number.isSafeInteger(row.received_ms) && row.received_ms >= 0 && row.received_ms <= 999999999999999 &&
    typeof row.repository === 'string' && REPOSITORY.test(row.repository) && EVENTS.includes(row.event) &&
    typeof row.body_sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.body_sha256), 'delivery receipt identity is incomplete')
  return hash(JSON.stringify([row.delivery_id, row.received_ms, row.repository, row.event, row.body_sha256]))
}
function confirmed(result, mode) {
  if (IGNORED.has(result?.ignored)) return true
  return Number.isSafeInteger(result?.reconciled) && result.reconciled >= 0 && Array.isArray(result.wakes) &&
    result.wakes.length <= result.reconciled && result.wakes.every((w) =>
      mode === 'products-only-v1' ? w === 'disabled-by-policy' : WAKES.has(w))
}

export async function runReceiptCycle({ capture, consumer, receipts, allowedRepositories, maxDeliveries = 100,
  mode = 'full-v1', beforeDelivery = () => {}, afterFingerprint, beforeAttempt = async () => {} }) {
  const repos = repositories(allowedRepositories)
  requireValue(['full-v1', 'products-only-v1'].includes(mode) && consumer.mode === mode,
    'receipt cycle and consumer modes must match')
  requireValue(Number.isInteger(maxDeliveries) && maxDeliveries > 0 && maxDeliveries <= 10000, 'delivery cycle budget is invalid')
  requireValue(afterFingerprint === undefined || afterFingerprint === null ||
    (typeof afterFingerprint === 'string' && /^[a-f0-9]{64}$/.test(afterFingerprint)), 'invalid scheduling fingerprint')
  const seen = new Set()
  let pending = []
  let skipped = 0
  // Complete every bounded metadata scan BEFORE effects. A page-budget failure
  // must not look like an empty queue or a successful partial scan.
  for (const repository of repos) {
    for (const event of EVENTS) {
      const rows = await capture.listDeliveries({ repository, event })
      requireValue(Array.isArray(rows), 'capture scan is incomplete')
      for (const row of rows) {
        requireValue(row.repository === repository && row.event === event && !seen.has(row.delivery_id),
          'capture scan identity or scope is inconsistent')
        seen.add(row.delivery_id)
        const fingerprint = deliveryFingerprint(row)
        if (receipts.has(row.delivery_id, fingerprint)) skipped++
        else pending.push({ row, fingerprint })
      }
    }
  }
  pending.sort((a, b) => a.row.received_ms - b.row.received_ms ||
    (a.row.delivery_id < b.row.delivery_id ? -1 : a.row.delivery_id > b.row.delivery_id ? 1 : 0))
  if (afterFingerprint !== undefined) {
    // Circular order over stable identities: a failed oldest delivery cannot
    // occupy the first slot forever, even if the last attempted row is gone.
    pending.sort((a, b) => a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0)
    const first = afterFingerprint === null ? 0 : pending.findIndex(p => p.fingerprint > afterFingerprint)
    if (first > 0) pending = pending.slice(first).concat(pending.slice(0, first))
  }
  let completed = 0
  let attempted = 0
  const failures = []
  for (const { row, fingerprint } of pending.slice(0, maxDeliveries)) {
    // A whole-pass stop must escape, not become a retriable per-event failure.
    beforeDelivery()
    // Refuse predictable disk-capacity failure before an external effect. Actual
    // disk errors remain possible; they abort the pass, leaving safe replay.
    receipts.ensureCapacity(row.delivery_id, fingerprint)
    // Persist only a fairness hint before the attempt, never a success receipt.
    // Persistence errors escape rather than becoming ordinary event failures.
    await beforeAttempt(fingerprint)
    attempted++
    let stage = 'read'
    try {
      const delivery = await capture.getDelivery(row.delivery_id)
      requireValue(deliveryFingerprint(delivery) === fingerprint && delivery.body_truncated === 0 &&
        typeof delivery.body === 'string' && hash(delivery.body) === delivery.body_sha256,
      'delivery changed identity or has an incomplete body')
      stage = 'process'
      requireValue(confirmed(await consumer.processDelivery(delivery), mode), 'consumer did not confirm a terminal outcome')
    } catch {
      // Do not store raw transport errors or untrusted payloads in state/logs.
      // One failed event does not prevent later candidates within this budget.
      failures.push({ deliveryId: row.delivery_id, stage })
      continue
    }
    // A receipt is written only AFTER a confirmed result, never in finally.
    // Persistence failure is intentionally outside the per-delivery catch.
    await receipts.record(row.delivery_id, fingerprint)
    completed++
  }
  const deferred = pending.length - attempted
  return { ok: failures.length === 0 && deferred === 0, scanned: seen.size, skipped, attempted, completed, failures, deferred }
}
