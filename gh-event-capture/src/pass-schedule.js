// Scheduling hints, never completion receipts. The caller holds the single
// receipt-store lock. Advancing a hint before I/O is safe: skipped unfinished
// work remains unreceipted and is revisited after the circular scan wraps.
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

const HEX = /^[a-f0-9]{64}$/
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
const FILE = 'schedule.json'
const MAX_BYTES = 4096
function valid(state, namespace) {
  if (!state || Object.keys(state).length !== 5 || state.version !== 1 ||
    state.namespace !== namespace || !HEX.test(namespace) ||
    !['events', 'sweeps'].includes(state.nextStream) ||
    !(state.eventCursor === null || (typeof state.eventCursor === 'string' && HEX.test(state.eventCursor))) ||
    !(state.sweepCursor === null || (typeof state.sweepCursor === 'string' && REPO.test(state.sweepCursor)))) {
    throw new Error('invalid pass schedule; refusing to reset it')
  }
  return state
}
function pathFor(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('schedule directory must be absolute')
  return join(directory, FILE)
}
export async function loadPassSchedule({ directory, namespace }) {
  const path = pathFor(directory)
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('pass schedule could not be opened')
    return valid({ version: 1, namespace, nextStream: 'events', eventCursor: null, sweepCursor: null }, namespace)
  }
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > MAX_BYTES) {
      throw new Error('unsafe schedule')
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_BYTES) throw new Error('oversize schedule')
    return valid(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))), namespace)
  } catch {
    throw new Error('pass schedule could not be read; refusing to reset it')
  } finally { await file.close() }
}
export async function savePassSchedule({ directory, namespace, state }) {
  const path = pathFor(directory)
  const text = JSON.stringify(valid(state, namespace)) + '\n'
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('pass schedule exceeds byte budget')
  const temp = join(directory, `.schedule-${randomUUID()}.tmp`)
  let file
  try {
    file = await open(temp, 'wx', 0o600)
    await file.writeFile(text)
    await file.sync()
    await file.close()
    file = null
    await rename(temp, path)
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await parent.sync() } finally { await parent.close() }
  } catch {
    throw new Error('pass schedule persistence failed; stop processing')
  } finally {
    if (file) await file.close()
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
