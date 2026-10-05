// Fixed-clock health decisions. No network, board comments, claims or wakes.
import { createHash } from 'node:crypto'

export const FIRING_MS = 60000
export const MISSED_AFTER_MS = 2 * FIRING_MS + 10000
export const OUTER_DEADLINE_MS = 55000
export const ALERT_RETRY_MS = 600000
export const KEY_LIFETIME_MS = 30 * 86400000
const OUTCOMES = new Set(['never', 'running', 'healthy', 'partial', 'failed'])
const timestamp = n => Number.isSafeInteger(n) && n >= 0
function requireValue(value) { if (!value) throw new Error('invalid runtime health state') }
export function checkHealth(state, namespace) {
  requireValue(state && state.version === 1 && state.namespace === namespace && /^[a-f0-9]{64}$/.test(namespace) &&
    Object.keys(state).length === 8 && timestamp(state.activatedMs) && OUTCOMES.has(state.outcome))
  for (const key of ['lastStartMs', 'lastFinishMs', 'lastHealthyMs']) requireValue(state[key] === null || timestamp(state[key]))
  requireValue(state.summary === null || (state.summary && typeof state.summary === 'object' && !Array.isArray(state.summary) &&
    Object.keys(state.summary).sort().join() === 'deferred,failures,processed,requests' &&
    Object.values(state.summary).every(n => n === null || (Number.isSafeInteger(n) && n >= 0))))
  if (state.outcome === 'never') requireValue(state.lastStartMs === null && state.lastFinishMs === null && state.lastHealthyMs === null)
  else requireValue(timestamp(state.lastStartMs) && state.lastStartMs >= state.activatedMs)
  if (state.outcome === 'running') requireValue(state.lastFinishMs === null)
  if (['healthy', 'partial', 'failed'].includes(state.outcome)) requireValue(timestamp(state.lastFinishMs) && state.lastFinishMs >= state.lastStartMs)
  if (state.lastHealthyMs !== null) requireValue(state.lastHealthyMs >= state.activatedMs)
  if (state.outcome === 'healthy') requireValue(state.lastHealthyMs === state.lastFinishMs)
  return state
}
export function freshHealth(namespace, now) {
  return checkHealth({ version: 1, namespace, activatedMs: now, lastStartMs: null,
    lastFinishMs: null, lastHealthyMs: null, outcome: 'never', summary: null }, namespace)
}
export function beginFiring(state, now) {
  checkHealth(state, state.namespace)
  requireValue(timestamp(now) && now >= Math.max(state.activatedMs, state.lastStartMs ?? 0, state.lastFinishMs ?? 0))
  return checkHealth({ ...state, lastStartMs: now, lastFinishMs: null, outcome: 'running', summary: null }, state.namespace)
}
export function finishFiring(state, now, result) {
  requireValue(state.outcome === 'running')
  const outcome = result?.ok === true ? 'healthy' : ['incomplete', 'sweeps-incomplete'].includes(result?.reason) ? 'partial' : 'failed'
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null
  const sum = (a, b) => count(a) !== null && count(b) !== null ? count(a + b) : null
  const summary = {
    requests: count(result?.requests),
    processed: sum(result?.events?.completed, result?.sweeps?.processed),
    deferred: sum(result?.events?.deferred, result?.sweeps?.deferred),
    failures: sum(result?.events?.failures?.length, result?.sweeps?.failures?.length),
  }
  return checkHealth({ ...state, outcome, lastFinishMs: now, summary,
    lastHealthyMs: outcome === 'healthy' ? now : state.lastHealthyMs }, state.namespace)
}
export function checkKeyWindow(issuedMs, expiresMs) {
  requireValue(timestamp(issuedMs) && timestamp(expiresMs) && expiresMs > issuedMs && expiresMs - issuedMs <= KEY_LIFETIME_MS)
}
export function healthFinding(state, { namespace, now, issuedMs, expiresMs }) {
  requireValue(timestamp(now))
  checkKeyWindow(issuedMs, expiresMs)
  const reasons = []
  if (now < issuedMs) reasons.push('key-window-in-future')
  else if (now >= expiresMs) reasons.push('key-expired')
  else if (expiresMs - now <= 3 * 86400000) reasons.push('key-expiring')
  try {
    checkHealth(state, namespace)
    const times = [state.activatedMs, state.lastStartMs, state.lastFinishMs, state.lastHealthyMs].filter(n => n !== null)
    if (times.some(n => n > now)) reasons.push('clock-or-state-invalid')
    else {
      const age = now - (state.lastStartMs ?? state.activatedMs)
      if (age >= MISSED_AFTER_MS) reasons.push('two-missed-firings')
      else if (state.outcome === 'running' && age >= OUTER_DEADLINE_MS) reasons.push('firing-stalled')
      else if (state.outcome === 'partial') reasons.push('cycle-partial')
      else if (state.outcome === 'failed') reasons.push('cycle-failed')
    }
  } catch { reasons.push('health-state-invalid') }
  return { key: reasons.sort().join('+') || null, reasons }
}
export function freshAlertState(namespace) {
  return { version: 1, namespace, incident: null }
}
export function checkAlertState(state, namespace) {
  requireValue(state && state.version === 1 && state.namespace === namespace && Object.keys(state).length === 3)
  const i = state.incident
  requireValue(i === null || (i && Object.keys(i).length === 5 && typeof i.key === 'string' &&
    /^[a-z+-]{1,160}$/.test(i.key) && /^[a-f0-9]{64}$/.test(i.id) && timestamp(i.sinceMs) &&
    (i.attemptMs === null || timestamp(i.attemptMs)) && typeof i.sent === 'boolean'))
  return state
}
export function alertDecision(state, finding, now) {
  checkAlertState(state, state.namespace)
  requireValue(timestamp(now))
  if (finding.key === null) return { state: freshAlertState(state.namespace), send: false }
  let incident = state.incident
  if (incident?.key !== finding.key) {
    incident = { key: finding.key, sinceMs: now, attemptMs: null, sent: false,
      id: createHash('sha256').update(JSON.stringify([state.namespace, finding.key, now])).digest('hex') }
  }
  const send = !incident.sent && (incident.attemptMs === null || now - incident.attemptMs >= ALERT_RETRY_MS)
  return { state: { ...state, incident: { ...incident, ...(send ? { attemptMs: now } : {}) } }, send }
}
