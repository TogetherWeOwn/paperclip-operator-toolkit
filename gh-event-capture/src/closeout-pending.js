// Persisted debounce for PR-closeout exception evaluation.
//
// Design: the closeout runner classifies one authoritative snapshot per pass. The runner
// is a one-shot unit fired every minute, so a 60 to 120 second debounce cannot
// live in memory and the receipt store does not hold it. This module remembers
// `(repository, PR) -> first-seen ms` in its own state file (`pending.json`)
// with its own namespace, beside `receipts.json` and `claims.json` in the SAME
// state directory. A PR is evaluated once `nowMs - firstSeenMs >= debounceMs`
// (default 90 seconds, inside the design window), and its entry is flushed
// after the due evaluation runs. Entries for PRs that closed meanwhile are
// pruned at each review snapshot.
//
// Same hardening as its siblings: absolute directory, 0600 files owned by this
// user, byte and entry budgets, fail-closed errors, namespace-mismatch
// refusal. This module takes no lock of its own: the caller must hold the
// receipt-store lock for the entire pass (see consumer-runner.js). Two
// concurrent writers would interleave atomic renames, so overlapping passes
// must keep failing closed at the receipt lock first.
//
// The S6b disarm duty bypasses this gate: a drafted or held PR with auto-merge
// armed acts on the first read that sees it. That path passes `bypass: true`
// to duePending; everything else debounces.
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

export const PENDING_FILE = 'pending.json'
// Inside the 60 to 120 second design window. Configurable per call; this is
// only the default.
export const DEFAULT_DEBOUNCE_MS = 90000
const DEBOUNCE_MIN_MS = 1000
const DEBOUNCE_MAX_MS = 3600000
// `.` and `..` are excluded so a key can never smuggle a dot segment.
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
const PENDING_TAG = 'closeout-pending'
const HEX = /^[a-f0-9]{64}$/
const MS_LIMIT = 8.64e15

const hash = (text) => createHash('sha256').update(text).digest('hex')
function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
const isMs = (value) => Number.isInteger(value) && value >= 0 && value <= MS_LIMIT
const isRef = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
  typeof value.repository === 'string' && REPOSITORY.test(value.repository) &&
  Number.isSafeInteger(value.number) && value.number > 0 && value.number <= 2147483647

export function pendingKey({ repository, number }) {
  requireValue(typeof repository === 'string' && REPOSITORY.test(repository), 'pending repository is invalid')
  requireValue(Number.isSafeInteger(number) && number > 0 && number <= 2147483647, 'pending PR number is invalid')
  return JSON.stringify([PENDING_TAG, repository, number])
}

function checkEntry(entry) {
  requireValue(Array.isArray(entry) && entry.length === 2, 'pending entry is invalid')
  const [key, firstSeenMs] = entry
  requireValue(typeof key === 'string', 'pending entry is invalid')
  let parsed
  try {
    parsed = JSON.parse(key)
  } catch {
    throw new Error('pending entry key is not JSON')
  }
  requireValue(Array.isArray(parsed) && parsed.length === 3 && parsed[0] === PENDING_TAG,
    'pending entry key is not a closeout pending key')
  // Re-validates repository and number, so a hand-edited file cannot smuggle
  // in an entry for something the sweeper never observed.
  pendingKey({ repository: parsed[1], number: parsed[2] })
  requireValue(isMs(firstSeenMs), 'pending entry timestamp is invalid')
}

export function checkPendingState(state, maxEntries = 20000) {
  requireValue(state && typeof state === 'object' && !Array.isArray(state) &&
    Object.keys(state).length === 3, 'pending state envelope is invalid')
  requireValue(state.version === 1 && typeof state.namespace === 'string' &&
    HEX.test(state.namespace), 'pending state version or namespace is invalid')
  requireValue(Number.isInteger(maxEntries) && maxEntries > 0 && maxEntries <= 100000,
    'pending storage budget is invalid')
  requireValue(Array.isArray(state.pending) && state.pending.length <= maxEntries,
    'pending state exceeds its capacity')
  const seen = new Set()
  for (const entry of state.pending) {
    checkEntry(entry)
    requireValue(!seen.has(entry[0]), 'pending state holds a duplicate entry')
    seen.add(entry[0])
  }
  return state
}

export function freshPendingState(namespace) {
  requireValue(typeof namespace === 'string' && HEX.test(namespace),
    'pending namespace must be a SHA-256 digest')
  return { version: 1, namespace, pending: [] }
}

/**
 * Derive this store's namespace from the receipt namespace of the same scope.
 * Same inputs (origins, company, repository scope, mode), different digest, so
 * a scope or mode change starts with no pending debounce instead of inheriting
 * silence, and pending state can never be mistaken for receipts or claims.
 */
export function pendingNamespace(receiptNamespaceDigest) {
  requireValue(typeof receiptNamespaceDigest === 'string' && HEX.test(receiptNamespaceDigest),
    'pending namespace requires a receipt namespace digest')
  return hash(`closeout-pending-v1:${receiptNamespaceDigest}`)
}

/**
 * Record an observation of an open PR. Idempotent: a re-observed PR keeps its
 * original first-seen time, so the debounce cannot be stretched by repeated
 * sightings. Returns { firstSeenMs, isNew }. Throws, instead of dropping, on a
 * full store: a silently skipped observation would read as "not due yet" and
 * delay the exception wake without a trace.
 */
export function recordObservation(state, ref, nowMs, maxEntries = 20000) {
  requireValue(isRef(ref), 'pending PR reference is invalid')
  requireValue(isMs(nowMs), 'pending observation time is invalid')
  checkPendingState(state, maxEntries)
  const key = pendingKey(ref)
  const existing = state.pending.find(([entryKey]) => entryKey === key)
  if (existing) return { firstSeenMs: existing[1], isNew: false }
  requireValue(state.pending.length < maxEntries, 'pending entry budget exceeded')
  state.pending.push([key, nowMs])
  return { firstSeenMs: nowMs, isNew: true }
}

function checkDebounce(debounceMs) {
  requireValue(Number.isInteger(debounceMs) && debounceMs >= DEBOUNCE_MIN_MS &&
    debounceMs <= DEBOUNCE_MAX_MS, 'pending debounce must be 1s to 1h in milliseconds')
}

/**
 * Entries whose debounce has elapsed at nowMs. With `bypass: true` every
 * tracked entry is due: the S6b disarm hook skips the gate. Must be a real
 * boolean, so a dropped option cannot silently disarm the debounce.
 */
export function duePending(state, nowMs, debounceMs = DEFAULT_DEBOUNCE_MS, { bypass = false } = {}) {
  requireValue(isMs(nowMs), 'pending evaluation time is invalid')
  checkDebounce(debounceMs)
  requireValue(typeof bypass === 'boolean', 'pending bypass flag must be a boolean')
  checkPendingState(state)
  const due = []
  for (const [key, firstSeenMs] of state.pending) {
    requireValue(nowMs >= firstSeenMs, 'pending evaluation time precedes first sighting')
    if (bypass || nowMs - firstSeenMs >= debounceMs) {
      const [, repository, number] = JSON.parse(key)
      due.push({ repository, number, firstSeenMs })
    }
  }
  return due
}

/**
 * Remove entries after their due evaluation ran. Unknown keys throw: flushing
 * something never observed would hide a scheduler bug as a quiet no-op.
 */
export function flushEvaluated(state, refs) {
  requireValue(Array.isArray(refs), 'pending flush references are invalid')
  checkPendingState(state)
  let removed = 0
  for (const ref of refs) {
    requireValue(isRef(ref), 'pending PR reference is invalid')
    const key = pendingKey(ref)
    const at = state.pending.findIndex(([entryKey]) => entryKey === key)
    requireValue(at !== -1, 'pending entry is not tracked; refusing to flush what was never observed')
    state.pending.splice(at, 1)
    removed++
  }
  return removed
}

/**
 * Drop this repository's entries for PRs no longer open. Other repositories'
 * entries are untouched: one repo's snapshot must never flush another's
 * debounce. Returns the pruned count.
 */
export function pruneRepository(state, repository, openNumbers) {
  requireValue(typeof repository === 'string' && REPOSITORY.test(repository), 'pending repository is invalid')
  requireValue(Array.isArray(openNumbers) && openNumbers.every((n) =>
    Number.isSafeInteger(n) && n > 0 && n <= 2147483647) &&
    new Set(openNumbers).size === openNumbers.length, 'pending open PR list is invalid')
  checkPendingState(state)
  const open = new Set(openNumbers.map((number) => pendingKey({ repository, number })))
  const before = state.pending.length
  state.pending = state.pending.filter(([key]) => {
    const [, repo] = JSON.parse(key)
    return repo !== repository || open.has(key)
  })
  return before - state.pending.length
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

export async function loadPendingState({ directory, namespace, maxBytes = 1024 * 1024, maxEntries = 20000 }) {
  requireValue(typeof directory === 'string' && isAbsolute(directory), 'pending directory must be absolute')
  requireValue(typeof namespace === 'string' && HEX.test(namespace), 'pending namespace must be a SHA-256 digest')
  requireValue(Number.isInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 16 * 1024 * 1024 &&
    Number.isInteger(maxEntries) && maxEntries > 0 && maxEntries <= 100000, 'pending storage budget is invalid')
  const path = join(directory, PENDING_FILE)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('pending state could not be opened')
    return freshPendingState(namespace)
  }
  let text
  try {
    const info = await handle.stat()
    requireValue(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 &&
      info.size <= maxBytes, 'pending state is unsafe or exceeds its budget')
    // Limit the read itself, not only stat: a concurrent writer is unsupported,
    // but must not turn an observed small file into an unbounded allocation.
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    requireValue(length <= maxBytes, 'pending state exceeds its byte budget')
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
  } catch {
    throw new Error('pending state could not be read; refusing to reset it')
  } finally { await handle.close() }
  let state
  try {
    state = JSON.parse(text)
  } catch {
    throw new Error('pending state is corrupt; refusing to reset it')
  }
  // A scope or mode change starts fresh elsewhere instead of inheriting silence.
  // The digest itself carries no credential or scope detail.
  requireValue(state?.namespace === namespace,
    'pending state namespace does not match; refusing to mix origins, companies, scopes or modes')
  try {
    return checkPendingState(state, maxEntries)
  } catch {
    throw new Error('pending state shape is invalid; refusing to reset it')
  }
}

export async function savePendingState({ directory, state, maxBytes = 1024 * 1024, maxEntries = 20000 }) {
  requireValue(typeof directory === 'string' && isAbsolute(directory), 'pending directory must be absolute')
  const text = JSON.stringify(checkPendingState(state, maxEntries)) + '\n'
  requireValue(Buffer.byteLength(text) <= maxBytes, 'pending state exceeds its byte budget')
  const path = join(directory, PENDING_FILE)
  const temp = join(directory, `.pending-${randomUUID()}.tmp`)
  let file
  try {
    file = await open(temp, 'wx', 0o600)
    await file.writeFile(text)
    await file.sync()
    await file.close()
    file = null
    await rename(temp, path)
    await syncDirectory(directory)
  } catch {
    throw new Error('pending persistence failed; stop processing and replay on recovery')
  } finally {
    if (file) await file.close()
    await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error })
  }
}
