// Durable one-shot backfill plus periodic authoritative review-state
// reconciliation. Runs INSIDE the receipt-store lock, alternating first turn
// with event processing across passes for bounded cross-stream fairness,
// through the same wrapped transports and total operation/deadline budget:
// every GitHub/board call here counts against the pass budget via the shared
// adapters, and beforeItem (the pass budget check) aborts the sweep loudly
// instead of recording a budget stop as a retriable per-PR failure.
//
// Backfill is one-shot per namespace: the open-PR snapshot is listed once,
// drained across bounded passes, and never re-listed. Review is periodic: each
// completed review cycle records lastCompleteMs, and a fresh authoritative
// snapshot starts only after reviewIntervalMs. Both phases resume saved
// progress instead of restarting the first N references forever.
//
// A PR that closes after the snapshot is NOT dropped: the snapshot holds PR
// numbers, and reconcile reads current authoritative state (open or closed).
// No delivery IDs, claims, wakes or comments are invented here; backfill uses
// the same reconcile path as events. Check status is never fetched.
import { repoSweeps } from './sweep-store.js'

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
const DEFAULTS = { maxItems: 50, maxAttempts: 5, reviewIntervalMs: 600000 }
const MAXIMA = { maxItems: 10000, maxAttempts: 100, reviewIntervalMs: 86400000 }

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
export function sweepLimits(value = {}) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((k) => Object.hasOwn(DEFAULTS, k)), 'invalid sweep limits')
  const limits = { ...DEFAULTS, ...value }
  requireValue(Object.entries(limits).every(([key, n]) => Number.isInteger(n) && n > 0 && n <= MAXIMA[key]),
    'invalid sweep limits')
  return limits
}
function repositories(value) {
  requireValue(Array.isArray(value) && value.length > 0 && value.every((r) => typeof r === 'string' && REPOSITORY.test(r)) &&
    new Set(value).size === value.length, 'sweep cycle requires a unique repository allowlist')
  return [...value].sort()
}
// The GitHub adapter guarantees shape; re-check before trusting a snapshot
// that decides what counts as complete.
function snapshotNumbers(references, repository) {
  requireValue(Array.isArray(references), 'open PR scan is incomplete')
  const numbers = []
  const seen = new Set()
  for (const ref of references) {
    requireValue(ref && ref.repository === repository && Number.isInteger(ref.number) &&
      ref.number > 0 && ref.number <= 2147483647 && !seen.has(ref.number),
    'open PR scan contains invalid or duplicate identities')
    seen.add(ref.number)
    numbers.push(ref.number)
  }
  return numbers
}
function remaining(sweep) {
  const done = new Set(sweep.done)
  const poisoned = new Set(sweep.poisoned)
  return sweep.refs.filter((n) => !done.has(n) && !poisoned.has(n))
}
function summary(sweep, now) {
  const left = remaining(sweep)
  return { phase: sweep.phase, total: sweep.refs.length, done: sweep.done.length,
    remaining: left.length, failed: Object.keys(sweep.failed).length,
    poisoned: sweep.poisoned.length,
    listedAgeMs: sweep.listedMs === null ? null : now - sweep.listedMs,
    completedAgeMs: sweep.lastCompleteMs === null ? null : now - sweep.lastCompleteMs }
}

export async function runSweepCycle({ github, consumer, state, allowedRepositories,
  maxItems = 50, maxAttempts = 5, reviewIntervalMs = 600000,
  beforeItem = () => {}, isStopped = () => false, now = () => Date.now(), save,
  afterRepository = null, beforeRepository = async () => {} }) {
  const repos = repositories(allowedRepositories)
  requireValue(afterRepository === null || repos.includes(afterRepository), 'invalid repository scheduling cursor')
  const first = afterRepository === null ? 0 : (repos.indexOf(afterRepository) + 1) % repos.length
  repos.push(...repos.splice(0, first))
  const limits = sweepLimits({ maxItems, maxAttempts, reviewIntervalMs })
  requireValue(github && typeof github.listOpenPullRequests === 'function' &&
    consumer && typeof consumer.backfill === 'function' &&
    state && typeof state === 'object' && typeof save === 'function',
  'sweep cycle dependencies are incomplete')
  const failures = []
  let processed = 0
  const poisonedNow = []

  async function snapshot(repository, sweep, startedMs) {
    await beforeItem()
    const numbers = snapshotNumbers(await github.listOpenPullRequests(repository), repository)
    requireValue(isStopped() === false, 'sweep pass stopped')
    sweep.phase = numbers.length === 0 ? 'complete' : 'draining'
    sweep.refs = numbers
    sweep.done = []
    sweep.failed = {}
    sweep.poisoned = []
    sweep.listedMs = startedMs
    sweep.lastCompleteMs = numbers.length === 0 ? startedMs : null
    await save()
  }
  async function reconcile(repository, sweep, phase, number) {
    // A whole-pass stop must escape, not become a retriable per-PR failure.
    await beforeItem()
    try {
      await consumer.backfill([{ repository, number }], { maxItems: limits.maxItems, beforeItem, isStopped })
    } catch {
      if (isStopped()) throw new Error('sweep pass stopped')
      // Do not store transport errors or untrusted payloads in state/logs.
      // One failed PR does not prevent later candidates within this budget.
      const attempts = (sweep.failed[number] ?? 0) + 1
      if (attempts > limits.maxAttempts) {
        delete sweep.failed[number]
        sweep.poisoned.push(number)
        poisonedNow.push({ repository, number, phase })
      } else {
        sweep.failed[number] = attempts
      }
      failures.push({ repository, number, phase, attempt: attempts })
      await save()
      return
    }
    if (isStopped()) throw new Error('sweep pass stopped')
    sweep.done.push(number)
    delete sweep.failed[number]
    processed++
    await save()
  }
  async function finish(repository, sweep, finishedMs) {
    if (sweep.phase === 'draining' && remaining(sweep).length === 0) {
      sweep.phase = 'complete'
      sweep.lastCompleteMs = finishedMs
      await save()
    }
  }

  // Each repository gets a bounded share. Prepare and drain it before moving
  // on: a broken later scan must not prevent earlier healthy effects. Persist
  // the repository hint before I/O so a scan which exhausts the whole pass
  // starts AFTER that repository next time, without recording false completion.
  for (const [index, repository] of repos.entries()) {
    const used = processed + failures.length
    if (used >= limits.maxItems) break
    await beforeItem()
    await beforeRepository(repository)
    const quota = Math.ceil((limits.maxItems - used) / (repos.length - index))
    const entry = repoSweeps(state, repository)
    const startedMs = now()
    if (entry.backfill.phase === 'pending') await snapshot(repository, entry.backfill, startedMs)
    if (entry.backfill.phase === 'complete' && entry.review.phase !== 'draining' &&
      (entry.review.lastCompleteMs === null || startedMs - entry.review.lastCompleteMs >= limits.reviewIntervalMs)) {
      await snapshot(repository, entry.review, startedMs)
    }
    for (const phase of ['backfill', 'review']) {
      const sweep = entry[phase]
      if (sweep.phase !== 'draining') continue
      for (const number of remaining(sweep)) {
        if (processed + failures.length - used >= quota) break
        await reconcile(repository, sweep, phase, number)
      }
      await finish(repository, sweep, now())
    }
  }
  const summaries = {}
  let backfillDeferred = 0
  let poisonedTotal = 0
  for (const repository of repos) {
    const entry = repoSweeps(state, repository)
    summaries[repository] = { backfill: summary(entry.backfill, now()), review: summary(entry.review, now()) }
    backfillDeferred += summaries[repository].backfill.remaining
    poisonedTotal += summaries[repository].backfill.poisoned + summaries[repository].review.poisoned
  }
  // A bounded pass may legitimately defer review work, but is still partial.
  // Alert chatter is the health layer's responsibility, not a reason to report
  // unfinished authoritative reconciliation as healthy.
  const deferred = backfillDeferred + Object.values(summaries).reduce((n, s) => n + s.review.remaining, 0)
  const pendingScans = Object.values(summaries).filter(s => s.backfill.phase === 'pending').length
  const ok = failures.length === 0 && deferred === 0 && poisonedTotal === 0 && pendingScans === 0
  return { ok, processed, failures, deferred, backfillDeferred, pendingScans, poisonedTotal, poisonedNow, repos: summaries }
}
