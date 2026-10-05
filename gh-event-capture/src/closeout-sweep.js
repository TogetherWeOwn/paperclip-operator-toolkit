// Shadow closeout decisions over open PRs (design §5.2, slice S3b).
//
// Two pieces, kept in this one module under the design's 400-line split rule
// (scheduler state lives separately in closeout-pending.js):
//
// 1. runCloseoutShadow: the decision runner. Per open PR it reads one
//    authoritative snapshot (getCloseoutSnapshot), resolves the owning task
//    via the PR-task index (unmapped stays unmapped, never guesses),
//    classifies with closeout.js under an injected closeoutPolicy, and reads
//    the claim store read-only to say would-claim, already-claimed or none.
// 2. createCloseoutReview: the review-phase wiring. It debounces observations
//    through the pending store, prunes PRs that closed since, and runs the
//    decision runner over due PRs only.
//
// READ-ONLY BY CONSTRUCTION. Neither piece writes claims, posts comments, or
// wakes anything: they take no board, no capture, and no claim-save
// dependency at all, so there is no call path that could eat the first real
// wake (S5a has not built the wake transport). A reviewer can verify this by
// importing the module and observing it has no such parameter.
import { classifyCloseout, closeoutPolicy } from './closeout.js'
import { resolvePrTask } from './pr-task-index.js'
import { hasClaim, checkClaimState } from './claim-store.js'
import { DEFAULT_DEBOUNCE_MS, recordObservation, duePending, flushEvaluated,
  pruneRepository, checkPendingState, loadPendingState, savePendingState } from './closeout-pending.js'

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
const HEX = /^[a-f0-9]{64}$/
const MAX_SHADOW_REFS = 10000

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
const isRef = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
  typeof value.repository === 'string' && REPOSITORY.test(value.repository) &&
  Number.isSafeInteger(value.number) && value.number > 0 && value.number <= 2147483647

function checkIndex(index) {
  requireValue(index === null || (index && typeof index === 'object' &&
    index.byPr instanceof Map && index.claimed instanceof Set && index.ambiguous instanceof Set),
  'closeout shadow PR task index is invalid')
}

function emptyCounters() {
  return { total: 0, mapped: 0, unmapped: 0, unmappedByReason: {}, noException: 0,
    exceptions: 0, byClass: {}, wouldClaim: 0, alreadyClaimed: 0, errors: 0 }
}

/**
 * Run shadow closeout decisions over explicit open-PR references.
 *
 * @param {object} deps github.getCloseoutSnapshot, pr-task index (or null),
 *   loaded claim state (read-only), raw closeout policy, reference list.
 * @returns {{ records, counters }} per-PR records plus aggregate counters.
 *   A record is { repository, number, headSha, decision, mapping, claim } with
 *   decision null when the classifier stays silent and claim one of
 *   'wouldClaim' | 'alreadyClaimed' | 'none'. PRs whose snapshot cannot be
 *   read or classified are recorded as { error } and counted, never thrown:
 *   one bad PR must not blind the shadow over the rest.
 */
export async function runCloseoutShadow({ github, index = null, claims, policy,
  references, isPrivateRepository = () => true, nowMs = Date.now() }) {
  requireValue(github && typeof github.getCloseoutSnapshot === 'function',
    'closeout shadow requires a snapshot-capable GitHub adapter')
  checkIndex(index)
  requireValue(claims && typeof claims === 'object' && Array.isArray(claims.claimed),
    'closeout shadow requires a loaded claim state')
  checkClaimState(claims)
  const validated = closeoutPolicy(policy)
  requireValue(Array.isArray(references) && references.length <= MAX_SHADOW_REFS,
    'closeout shadow references are invalid')
  requireValue(typeof isPrivateRepository === 'function', 'repository visibility predicate is invalid')
  requireValue(Number.isInteger(nowMs) && nowMs >= 0, 'closeout shadow clock is invalid')
  const seen = new Set()
  const records = []
  const counters = emptyCounters()
  for (const ref of references) {
    requireValue(isRef(ref), 'closeout shadow reference is invalid')
    const key = `${ref.repository}#${ref.number}`
    requireValue(!seen.has(key), 'closeout shadow references hold a duplicate PR')
    seen.add(key)
    counters.total++
    let snapshot
    try {
      snapshot = await github.getCloseoutSnapshot(ref.repository, ref.number, { nowMs })
    } catch {
      // No transport detail is stored: child streams may carry credentials or
      // private bodies, and the adapter already reports a fixed string.
      records.push({ ...ref, headSha: null, decision: null, mapping: null, claim: 'none', error: 'snapshot-read-failed' })
      counters.errors++
      continue
    }
    const mapping = resolvePrTask({ repository: ref.repository, number: ref.number,
      isPrivate: isPrivateRepository(ref.repository) === true, index })
    if (mapping.unmapped) {
      records.push({ ...ref, headSha: snapshot.headSha, decision: null,
        mapping: { unmapped: mapping.unmapped }, claim: 'none' })
      counters.unmapped++
      counters.unmappedByReason[mapping.unmapped] = (counters.unmappedByReason[mapping.unmapped] ?? 0) + 1
      continue
    }
    counters.mapped++
    let decision
    try {
      decision = classifyCloseout(snapshot, validated)
    } catch {
      records.push({ ...ref, headSha: snapshot.headSha, decision: null,
        mapping: { issueRef: mapping.issueRef, source: mapping.source }, claim: 'none',
        error: 'unclassifiable-snapshot' })
      counters.errors++
      continue
    }
    if (decision === null) {
      records.push({ ...ref, headSha: snapshot.headSha, decision: null,
        mapping: { issueRef: mapping.issueRef, source: mapping.source }, claim: 'none' })
      counters.noException++
      continue
    }
    const claim = hasClaim(claims, decision) ? 'alreadyClaimed' : 'wouldClaim'
    records.push({ ...ref, headSha: snapshot.headSha, decision: decision.class,
      mapping: { issueRef: mapping.issueRef, source: mapping.source }, claim })
    counters.exceptions++
    counters.byClass[decision.class] = (counters.byClass[decision.class] ?? 0) + 1
    if (claim === 'alreadyClaimed') counters.alreadyClaimed++
    else counters.wouldClaim++
  }
  return { records, counters }
}

/**
 * Review-phase wiring with persisted debounce (S3b scheduler side).
 *
 * Owns the pending store at { directory, namespace } and reads the claim
 * state callers load once per pass. runReview records every listed open PR,
 * prunes entries for PRs that closed since, evaluates only due PRs (or all
 * with bypass, the S6b disarm hook), flushes each evaluated entry after its
 * evaluation runs, and persists only when something changed.
 */
export function createCloseoutReview({ directory, namespace, claims, github, index = null,
  policy, isPrivateRepository = () => true, debounceMs = DEFAULT_DEBOUNCE_MS, bypass = false,
  maxBytes = 1024 * 1024, maxEntries = 20000, nowMs = () => Date.now() }) {
  requireValue(typeof directory === 'string' && directory.length > 0, 'closeout review directory is required')
  requireValue(typeof namespace === 'string' && HEX.test(namespace), 'closeout review namespace must be a SHA-256 digest')
  requireValue(claims && typeof claims === 'object' && Array.isArray(claims.claimed),
    'closeout review requires a loaded claim state')
  checkClaimState(claims)
  requireValue(github && typeof github.getCloseoutSnapshot === 'function',
    'closeout review requires a snapshot-capable GitHub adapter')
  checkIndex(index)
  const validated = closeoutPolicy(policy)
  requireValue(typeof isPrivateRepository === 'function', 'repository visibility predicate is invalid')
  requireValue(Number.isInteger(debounceMs) && debounceMs >= 1000 && debounceMs <= 3600000,
    'closeout review debounce must be 1s to 1h in milliseconds')
  requireValue(typeof bypass === 'boolean', 'closeout review bypass flag must be a boolean')
  requireValue(typeof nowMs === 'function', 'closeout review clock is invalid')
  const storage = { directory, namespace, maxBytes, maxEntries }

  async function runReview({ repository, numbers }) {
    requireValue(typeof repository === 'string' && REPOSITORY.test(repository), 'closeout review repository is invalid')
    requireValue(Array.isArray(numbers) && numbers.length <= MAX_SHADOW_REFS &&
      numbers.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647) &&
      new Set(numbers).size === numbers.length, 'closeout review PR list is invalid')
    const now = nowMs()
    requireValue(Number.isInteger(now) && now >= 0, 'closeout review clock is invalid')
    const state = await loadPendingState(storage)
    checkPendingState(state, maxEntries)
    let dirty = false
    const pruned = pruneRepository(state, repository, numbers)
    if (pruned > 0) dirty = true
    let observedNew = 0
    for (const number of numbers) {
      const { isNew } = recordObservation(state, { repository, number }, now, maxEntries)
      if (isNew) { observedNew++; dirty = true }
    }
    const due = duePending(state, now, debounceMs, { bypass })
    // This repository only: another repo's debounce must never be evaluated or
    // flushed from here.
    const dueHere = due.filter((d) => d.repository === repository)
    const shadow = await runCloseoutShadow({ github, index, claims, policy: validated,
      references: dueHere, isPrivateRepository, nowMs: now })
    const flushed = flushEvaluated(state, dueHere)
    if (flushed > 0) dirty = true
    if (dirty) await savePendingState({ ...storage, state })
    return { ...shadow, pending: { observed: numbers.length, observedNew,
      due: dueHere.length, debounced: numbers.length - dueHere.length,
      flushed, pruned } }
  }

  return { runReview }
}
