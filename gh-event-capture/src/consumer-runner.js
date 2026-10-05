// One product-only event pass. No timer, retries, wake transport or background loop.
import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { createCaptureAdapter } from './capture-adapter.js'
import { createGithubAdapter } from './github-adapter.js'
import { createPaperclipAdapter } from './paperclip-adapter.js'
import { createConsumer } from './consumer.js'
import { withReceiptStore } from './receipt-store.js'
import { receiptNamespace, runReceiptCycle } from './receipt-cycle.js'
import { loadSweepState, saveSweepState } from './sweep-store.js'
import { runSweepCycle, sweepLimits } from './sweep-cycle.js'
import { loadPassSchedule, savePassSchedule } from './pass-schedule.js'

// execFile's abort callback can fire before child close. Await close explicitly;
// a SIGTERM-ignoring gh process must not survive this pass's deadline.
export function executeGithub(file, args, options) {
  return new Promise((resolve, reject) => {
    const { signal, ...childOptions } = options
    if (signal?.aborted) { reject(new Error('child execution cancelled')); return }
    let result
    let failure
    let cancelled = false
    // execFile's built-in AbortSignal path can send SIGTERM despite killSignal.
    // Own abort explicitly so a signal-ignoring child is killed, then drained.
    const child = execFile(file, args, { ...childOptions, killSignal: 'SIGKILL' }, (error, stdout) => {
      failure = error
      result = { stdout }
    })
    const cancel = () => { cancelled = true; child.kill('SIGKILL') }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    child.once('close', () => {
      signal?.removeEventListener('abort', cancel)
      if (cancelled) reject(new Error('child execution cancelled'))
      else if (failure) reject(failure)
      else resolve(result)
    })
  })
}
const MODE = 'products-only-v1'
const DEFAULTS = { maxRequests: 300, durationMs: 45000, maxDeliveries: 100,
  pageSize: 100, maxPages: 100, maxReceipts: 100000, maxReceiptBytes: 16 * 1024 * 1024,
  maxSweepItems: 50, maxSweepAttempts: 5, reviewIntervalMs: 600000 }
const MAXIMA = { maxRequests: 10000, durationMs: 300000, maxDeliveries: 10000,
  pageSize: 500, maxPages: 1000, maxReceipts: 1000000, maxReceiptBytes: 128 * 1024 * 1024 }
function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
export function runnerLimits(value = {}) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((k) => Object.hasOwn(DEFAULTS, k)), 'invalid runner limits')
  const limits = { ...DEFAULTS, ...value }
  const { maxSweepItems, maxSweepAttempts, reviewIntervalMs, ...rest } = limits
  requireValue(Object.entries(rest).every(([key, n]) => Number.isInteger(n) && n > 0 && n <= MAXIMA[key]) &&
    limits.maxReceiptBytes >= 1024, 'invalid runner limits')
  // Sweep bounds live in one table (sweep-cycle.js); the runner only allowlists the keys.
  sweepLimits({ maxItems: maxSweepItems, maxAttempts: maxSweepAttempts, reviewIntervalMs })
  return limits
}

// No Promise.race: an aborted write/child must settle before the lock is released.
// The deadline stays armed through HTTP body reads and every awaited operation.
// One clock owns the deadline: `now` measures elapsed budget at each checkpoint and
// `setTimer` arms the abort that interrupts in-flight I/O between them. Injecting only
// `now` would leave that abort on the real clock, so a caller virtualising time — the
// deadline tests — must replace both or the two halves disagree.
export function createPassBudget({ maxRequests, durationMs, signal, now = () => performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  runnerLimits({ maxRequests, durationMs })
  const controller = new AbortController()
  const started = now()
  let requests = 0
  let reason = null
  const stop = (why) => { reason ??= why; controller.abort() }
  const cancel = () => stop('cancelled')
  const timer = setTimer(() => stop('deadline'), durationMs)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  function check() {
    if (now() - started >= durationMs) stop('deadline')
    requireValue(reason === null, 'consumer pass stopped')
  }
  function reserve() {
    check()
    if (requests >= maxRequests) stop('request-budget')
    check()
    requests++
  }
  return {
    check,
    snapshot: () => ({ requests, reason }),
    fetch: (fetchImpl) => async (url, init) => {
      reserve()
      return fetchImpl(url, { ...init, signal: AbortSignal.any([controller.signal, init.signal]) })
    },
    run: (run) => async (file, args, options = {}) => {
      reserve()
      const result = await run(file, args, { ...options, signal: controller.signal,
        timeout: Math.max(1, Math.min(options.timeout ?? 30000, Math.ceil(durationMs - (now() - started)))) })
      check()
      return result
    },
    close: () => { clearTimer(timer); signal?.removeEventListener('abort', cancel) },
  }
}

export async function runProductPass({ config, captureToken, boardToken, runId = null, githubExecutable = 'gh' },
  { fetchImpl = globalThis.fetch, run = executeGithub, signal, clock = {} } = {}) {
  requireValue(config?.mode === MODE, 'runner requires explicit products-only-v1 mode')
  const limits = runnerLimits(config.limits)
  const namespace = receiptNamespace(config)
  const budget = createPassBudget({ ...limits, signal, ...clock })
  let events = null
  let sweeps = null
  try {
    const scoped = { allowedRepositories: config.allowedRepositories, bridgePolicy: config.bridgePolicy }
    const transport = budget.fetch(fetchImpl)
    const capture = createCaptureAdapter({ ...scoped, baseUrl: config.captureOrigin, queryToken: captureToken,
      fetchImpl: transport, pageSize: limits.pageSize, maxPages: limits.maxPages })
    const github = createGithubAdapter({ ...scoped,
      run: budget.run((_file, args, options) => run(githubExecutable, args, options)), maxPages: limits.maxPages })
    const board = createPaperclipAdapter({ ...scoped, baseUrl: config.boardOrigin, token: boardToken,
      companyId: config.companyId, runId, fetchImpl: transport })
    const consumer = createConsumer({ ...scoped, github, board, capture, mode: MODE,
      isPrivateRepository: repository => config.repositoryVisibility[repository] })
    budget.check()
    // One lock and one total budget. Persist the next starting stream BEFORE
    // work so an exhausted/crashed capture pass cannot starve reconciliation.
    // schedule.json holds only fairness hints, separate from success receipts.
    await withReceiptStore({ directory: config.stateDirectory, namespace,
      maxReceipts: limits.maxReceipts, maxBytes: limits.maxReceiptBytes }, async (receipts) => {
      budget.check()
      const storage = { directory: config.stateDirectory, namespace }
      const schedule = await loadPassSchedule(storage)
      const saveSchedule = () => savePassSchedule({ ...storage, state: schedule })
      const first = schedule.nextStream
      schedule.nextStream = first === 'events' ? 'sweeps' : 'events'
      await saveSchedule()
      const guarded = { ...receipts, record: async (...args) => {
        budget.check()
        await receipts.record(...args)
      } }
      for (const stream of [first, schedule.nextStream]) {
        budget.check()
        if (stream === 'events') {
          events = await runReceiptCycle({ ...scoped, capture, consumer, receipts: guarded,
            mode: MODE, maxDeliveries: limits.maxDeliveries, beforeDelivery: budget.check,
            afterFingerprint: schedule.eventCursor,
            beforeAttempt: async fingerprint => { schedule.eventCursor = fingerprint; await saveSchedule() } })
        } else {
          const state = await loadSweepState(storage)
          sweeps = await runSweepCycle({ ...scoped, github, consumer, state,
            maxItems: limits.maxSweepItems, maxAttempts: limits.maxSweepAttempts,
            reviewIntervalMs: limits.reviewIntervalMs, beforeItem: budget.check,
            isStopped: () => budget.snapshot().reason !== null,
            afterRepository: schedule.sweepCursor,
            beforeRepository: async repository => { schedule.sweepCursor = repository; await saveSchedule() },
            // Wall time survives restarts; the shared monotonic budget bounds I/O.
            now: () => Date.now(), save: () => saveSweepState({ ...storage, state }) })
        }
        budget.check()
      }
    })
    budget.check()
    const ok = events.ok && sweeps.ok
    return { ok, mode: MODE, reason: ok ? null : events.ok ? 'sweeps-incomplete' : 'incomplete',
      requests: budget.snapshot().requests, events, sweeps }
  } catch {
    // Only fixed reason labels escape. Even local filesystem errors can contain
    // a credential path; adapters/provider errors must not enter service logs.
    return { ok: false, mode: MODE, reason: budget.snapshot().reason ?? 'cycle-failed',
      requests: budget.snapshot().requests, events, sweeps }
  } finally { budget.close() }
}
