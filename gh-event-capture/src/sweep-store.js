// Durable one-shot backfill and periodic review-sweep progress. This file is
// scheduler metadata, not event receipts: phases, snapshots and progress keyed
// by repository. It never stores delivery IDs, claims, wakes or comments, and
// it never touches receipts.json, so sweep bookkeeping cannot evict event work.
//
// The caller must hold the receipt-store lock for the entire pass. This module
// takes no second lock: two concurrent writers would interleave atomic renames,
// so overlapping passes must keep failing closed at the receipt lock first.
//
// Recovery is deletion: if a poisoned backfill entry is repaired upstream, stop
// the service and delete sweeps.json. The next pass re-lists and re-reconciles
// idempotently; event receipts in receipts.json are untouched by that reset.
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

export const SWEEP_FILE = 'sweeps.json'
const HEX = /^[a-f0-9]{64}$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
const PHASES = new Set(['pending', 'draining', 'complete'])
const MAX_REPOS = 1000

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
const prNumber = (n) => Number.isInteger(n) && n > 0 && n <= 2147483647
const moment = (n) => n === null || (Number.isSafeInteger(n) && n >= 0)

export function freshSweep() {
  return { phase: 'pending', refs: [], done: [], failed: {}, poisoned: [],
    listedMs: null, lastCompleteMs: null }
}

function checkSweep(sweep, maxRefs) {
  requireValue(sweep && typeof sweep === 'object' && !Array.isArray(sweep) &&
    Object.keys(sweep).length === 7, 'sweep entry is invalid')
  const { phase, refs, done, failed, poisoned, listedMs, lastCompleteMs } = sweep
  requireValue(PHASES.has(phase), 'sweep phase is invalid')
  for (const list of [refs, done, poisoned]) {
    requireValue(Array.isArray(list) && list.length <= maxRefs && list.every(prNumber) &&
      new Set(list).size === list.length, 'sweep reference list is invalid')
  }
  const refSet = new Set(refs)
  const doneSet = new Set(done)
  requireValue(done.every((n) => refSet.has(n)) && poisoned.every((n) => refSet.has(n)) &&
    !poisoned.some((n) => doneSet.has(n)), 'sweep progress does not match its snapshot')
  requireValue(failed && typeof failed === 'object' && !Array.isArray(failed) &&
    Object.entries(failed).every(([key, count]) => refSet.has(Number(key)) &&
      String(Number(key)) === key && !doneSet.has(Number(key)) &&
      !poisoned.includes(Number(key)) && Number.isInteger(count) && count >= 0 &&
      count <= 1000000), 'sweep failure counts are invalid')
  requireValue(moment(listedMs) && moment(lastCompleteMs), 'sweep timestamps are invalid')
  // A pending sweep holds no snapshot; any other phase needed a complete scan.
  requireValue(phase === 'pending'
    ? refs.length === 0 && done.length === 0 && poisoned.length === 0 &&
      Object.keys(failed).length === 0 && listedMs === null
    : Number.isSafeInteger(listedMs), 'sweep snapshot does not match its phase')
  // Completion is honest: every snapshotted ref finished or is loudly poisoned.
  requireValue(phase !== 'complete' ||
    refs.every((n) => doneSet.has(n) || poisoned.includes(n)),
  'sweep claims completion with unprocessed references')
}

export function checkSweepState(state, maxRefs = 20000) {
  requireValue(state && typeof state === 'object' && !Array.isArray(state) &&
    Object.keys(state).length === 3, 'sweep state envelope is invalid')
  requireValue(state.version === 1 && typeof state.namespace === 'string' &&
    HEX.test(state.namespace), 'sweep state version or namespace is invalid')
  requireValue(state.repos && typeof state.repos === 'object' && !Array.isArray(state.repos) &&
    Object.keys(state.repos).length <= MAX_REPOS, 'sweep repository map is invalid')
  for (const [repo, entry] of Object.entries(state.repos)) {
    requireValue(REPOSITORY.test(repo) && entry && typeof entry === 'object' &&
      !Array.isArray(entry) && Object.keys(entry).length === 2, 'sweep repository entry is invalid')
    checkSweep(entry.backfill, maxRefs)
    checkSweep(entry.review, maxRefs)
  }
  return state
}

export function freshSweepState(namespace) {
  requireValue(typeof namespace === 'string' && HEX.test(namespace),
    'sweep namespace must be a SHA-256 digest')
  return { version: 1, namespace, repos: {} }
}

export function repoSweeps(state, repository) {
  requireValue(state && typeof state === 'object' && REPOSITORY.test(repository),
    'sweep repository selector is invalid')
  state.repos[repository] ??= { backfill: freshSweep(), review: freshSweep() }
  return state.repos[repository]
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

export async function loadSweepState({ directory, namespace, maxBytes = 1024 * 1024, maxRefs = 20000 }) {
  requireValue(typeof directory === 'string' && isAbsolute(directory), 'sweep directory must be absolute')
  requireValue(typeof namespace === 'string' && HEX.test(namespace), 'sweep namespace must be a SHA-256 digest')
  requireValue(Number.isInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 16 * 1024 * 1024 &&
    Number.isInteger(maxRefs) && maxRefs > 0 && maxRefs <= 100000, 'sweep storage budget is invalid')
  const path = join(directory, SWEEP_FILE)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('sweep state could not be opened')
    return freshSweepState(namespace)
  }
  let text
  try {
    const info = await handle.stat()
    requireValue(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 &&
      info.size <= maxBytes, 'sweep state is unsafe or exceeds its budget')
    // Limit the read itself, not only stat: a concurrent writer is unsupported,
    // but must not turn an observed small file into an unbounded allocation.
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    requireValue(length <= maxBytes, 'sweep state exceeds its byte budget')
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
  } catch {
    throw new Error('sweep state could not be read; refusing to reset it')
  } finally { await handle.close() }
  let state
  try {
    state = JSON.parse(text)
  } catch {
    throw new Error('sweep state is corrupt; refusing to reset it')
  }
  // Origins, company, repository scope and processing mode share one digest, so
  // a mode or scope change starts fresh elsewhere instead of reusing progress.
  // The digest itself carries no credential or scope detail.
  requireValue(state?.namespace === namespace,
    'sweep state namespace does not match; refusing to mix origins, companies, scopes or modes')
  try {
    return checkSweepState(state, maxRefs)
  } catch {
    throw new Error('sweep state shape is invalid; refusing to reset it')
  }
}

export async function saveSweepState({ directory, state, maxBytes = 1024 * 1024, maxRefs = 20000 }) {
  requireValue(typeof directory === 'string' && isAbsolute(directory), 'sweep directory must be absolute')
  const text = JSON.stringify(checkSweepState(state, maxRefs)) + '\n'
  requireValue(Buffer.byteLength(text) <= maxBytes, 'sweep state exceeds its byte budget')
  const path = join(directory, SWEEP_FILE)
  const temp = join(directory, `.sweeps-${randomUUID()}.tmp`)
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
    throw new Error('sweep persistence failed; stop processing and replay on recovery')
  } finally {
    if (file) await file.close()
    await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error })
  }
}
