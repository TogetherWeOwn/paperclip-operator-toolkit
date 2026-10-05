// Host-local at-most-once claims for PR-closeout exception wakes.
//
// The decision core classifies one authoritative GitHub snapshot into at most one
// exception class per (repository, PR, head SHA). This module remembers which
// (repository, PR, head SHA, class) tuples already produced a wake, so the
// event path and the repair sweep stay idempotent without ever touching D1.
//
// Own state file (`claims.json`) and own namespace, beside `receipts.json` in
// the SAME state directory. This module takes no lock of its own: the caller
// must hold the receipt-store lock for the entire pass (see the product-only runner).
// Two concurrent writers would interleave atomic renames, so overlapping passes
// must keep failing closed at the receipt lock first.
//
// Ordering guarantee: claim (in memory) and persist BEFORE posting the wake.
// A crash between the persist and the post loses one wake rather than doubling
// it; the repair sweep re-derives from live GitHub state and re-wakes at most
// once per still-open exception. Loss of the whole state directory degrades to
// the same bound: one wake per open exception PR, never a flood.
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { CLOSEOUT_CLASSES, closeoutClaimKey } from './closeout.js'

export const CLAIM_FILE = 'claims.json'
// The key IS the S1 classifier's claim tuple, shared so the two can never
// diverge: JSON encoding keeps delimiters inside external strings unambiguous.
export { CLOSEOUT_CLASSES as CLAIM_CLASSES }
const CLAIM_TAG = 'closeout'
const HEX = /^[a-f0-9]{64}$/
const MS_LIMIT = 8.64e15

const hash = (text) => createHash('sha256').update(text).digest('hex')
function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
const isMs = (value) => Number.isInteger(value) && value >= 0 && value <= MS_LIMIT
export const claimKey = closeoutClaimKey

function checkEntry(entry, maxClaims) {
  requireValue(Array.isArray(entry) && entry.length === 3, 'claim entry is invalid')
  const [key, fingerprint, claimedMs] = entry
  requireValue(typeof key === 'string' && typeof fingerprint === 'string', 'claim entry is invalid')
  let parsed
  try {
    parsed = JSON.parse(key)
  } catch {
    throw new Error('claim entry key is not JSON')
  }
  requireValue(Array.isArray(parsed) && parsed.length === 5 && parsed[0] === CLAIM_TAG,
    'claim entry key is not a closeout claim')
  // Re-validates repository, number, head SHA and class, so a hand-edited file
  // cannot smuggle in a claim for something the classifier never decided.
  claimKey({ repository: parsed[1], number: parsed[2], headSha: parsed[3], class: parsed[4] })
  requireValue(fingerprint === hash(`fingerprint:${key}`), 'claim entry fingerprint does not match its key')
  requireValue(isMs(claimedMs), 'claim entry timestamp is invalid')
  void maxClaims
}

export function checkClaimState(state, maxClaims = 20000) {
  requireValue(state && typeof state === 'object' && !Array.isArray(state) &&
    Object.keys(state).length === 3, 'claim state envelope is invalid')
  requireValue(state.version === 1 && typeof state.namespace === 'string' &&
    HEX.test(state.namespace), 'claim state version or namespace is invalid')
  requireValue(Number.isInteger(maxClaims) && maxClaims > 0 && maxClaims <= 100000,
    'claim storage budget is invalid')
  requireValue(Array.isArray(state.claimed) && state.claimed.length <= maxClaims,
    'claim state exceeds its capacity')
  const seen = new Set()
  for (const entry of state.claimed) {
    checkEntry(entry, maxClaims)
    requireValue(!seen.has(entry[0]), 'claim state holds a duplicate claim')
    seen.add(entry[0])
  }
  return state
}

export function freshClaimState(namespace) {
  requireValue(typeof namespace === 'string' && HEX.test(namespace),
    'claim namespace must be a SHA-256 digest')
  return { version: 1, namespace, claimed: [] }
}

/**
 * Derive this store's namespace from the receipt namespace of the same scope.
 * Same inputs (origins, company, repository scope, mode), different digest, so
 * a scope or mode change starts with no claims instead of inheriting silence,
 * and claim state can never be mistaken for delivery receipts.
 */
export function claimNamespace(receiptNamespaceDigest) {
  requireValue(typeof receiptNamespaceDigest === 'string' && HEX.test(receiptNamespaceDigest),
    'claim namespace requires a receipt namespace digest')
  return hash(`closeout-claims-v1:${receiptNamespaceDigest}`)
}

export function hasClaim(state, decision) {
  requireValue(state && typeof state === 'object' && Array.isArray(state.claimed),
    'claim state is required')
  return state.claimed.some(([key]) => key === claimKey(decision))
}

/**
 * Record a claim in memory. Returns true when newly claimed (caller must
 * persist and then post the wake), false when already claimed (post nothing).
 * Throws, instead of claiming, on an invalid decision or a full store: a
 * dropped field must never read as "already woken", and silent eviction would
 * re-wake old exceptions.
 */
export function addClaim(state, decision, nowMs, maxClaims = 20000) {
  const key = claimKey(decision)
  requireValue(isMs(nowMs), 'claim timestamp is invalid')
  if (state.claimed.some(([existing]) => existing === key)) return false
  requireValue(state.claimed.length < maxClaims, 'claim count budget exceeded')
  state.claimed.push([key, hash(`fingerprint:${key}`), nowMs])
  return true
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

export async function loadClaimState({ directory, namespace, maxBytes = 1024 * 1024, maxClaims = 20000 }) {
  requireValue(typeof directory === 'string' && isAbsolute(directory), 'claim directory must be absolute')
  requireValue(typeof namespace === 'string' && HEX.test(namespace), 'claim namespace must be a SHA-256 digest')
  requireValue(Number.isInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 16 * 1024 * 1024 &&
    Number.isInteger(maxClaims) && maxClaims > 0 && maxClaims <= 100000, 'claim storage budget is invalid')
  const path = join(directory, CLAIM_FILE)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('claim state could not be opened')
    return freshClaimState(namespace)
  }
  let text
  try {
    const info = await handle.stat()
    requireValue(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 &&
      info.size <= maxBytes, 'claim state is unsafe or exceeds its budget')
    // Limit the read itself, not only stat: a concurrent writer is unsupported,
    // but must not turn an observed small file into an unbounded allocation.
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    requireValue(length <= maxBytes, 'claim state exceeds its byte budget')
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
  } catch {
    throw new Error('claim state could not be read; refusing to reset it')
  } finally { await handle.close() }
  let state
  try {
    state = JSON.parse(text)
  } catch {
    throw new Error('claim state is corrupt; refusing to reset it')
  }
  // A scope or mode change starts fresh elsewhere instead of inheriting silence.
  // The digest itself carries no credential or scope detail.
  requireValue(state?.namespace === namespace,
    'claim state namespace does not match; refusing to mix origins, companies, scopes or modes')
  try {
    return checkClaimState(state, maxClaims)
  } catch {
    throw new Error('claim state shape is invalid; refusing to reset it')
  }
}

export async function saveClaimState({ directory, state, maxBytes = 1024 * 1024, maxClaims = 20000 }) {
  requireValue(typeof directory === 'string' && isAbsolute(directory), 'claim directory must be absolute')
  const text = JSON.stringify(checkClaimState(state, maxClaims)) + '\n'
  requireValue(Buffer.byteLength(text) <= maxBytes, 'claim state exceeds its byte budget')
  const path = join(directory, CLAIM_FILE)
  const temp = join(directory, `.claims-${randomUUID()}.tmp`)
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
    throw new Error('claim persistence failed; stop processing and replay on recovery')
  } finally {
    if (file) await file.close()
    await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error })
  }
}
