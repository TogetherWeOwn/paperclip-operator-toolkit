// Local durable success receipts. This is not the D1 wake-intent ledger.
// The caller owns a private local filesystem directory, not an NFS/shared mount.
import { constants } from 'node:fs'
import { open, mkdir, lstat, rename, unlink, rmdir } from 'node:fs/promises'
import { join, isAbsolute, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const HEX = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9._:-]{1,128}$/
function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

export async function withReceiptStore({ directory, namespace, maxReceipts = 100000,
  maxBytes = 16 * 1024 * 1024 }, run) {
  requireValue(typeof directory === 'string' && isAbsolute(directory), 'receipt directory must be absolute')
  requireValue(typeof namespace === 'string' && HEX.test(namespace), 'receipt namespace must be a SHA-256 digest')
  requireValue(Number.isInteger(maxReceipts) && maxReceipts > 0 && maxReceipts <= 1000000 &&
    Number.isInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 128 * 1024 * 1024,
  'receipt storage budget is invalid')
  requireValue(typeof run === 'function', 'receipt callback is required')
  let created = false
  try { await mkdir(directory, { mode: 0o700 }); created = true } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('receipt directory could not be created')
  }
  if (created) await syncDirectory(dirname(directory))
  const stat = await lstat(directory)
  requireValue(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
    'receipt directory must be private and owned by this user')
  const lock = join(directory, 'lock')
  try { await mkdir(lock, { mode: 0o700 }) } catch {
    // Never guess whether an existing owner is dead. A crash requires explicit
    // operator recovery after proving no consumer still owns this directory.
    throw new Error('receipt lock unavailable; do not reclaim it automatically')
  }
  let active = true
  let busy = false
  let poisoned = false
  let pendingWrite
  try {
    const path = join(directory, 'receipts.json')
    let state = { version: 1, namespace, completed: [] }
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('receipt state could not be opened')
    }
    if (handle) {
      try {
        const info = await handle.stat()
        requireValue(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 &&
          info.size <= maxBytes, 'receipt state is unsafe or exceeds its budget')
        // Limit the read itself, not only stat: a concurrent writer is unsupported,
        // but must not turn an observed small file into an unbounded allocation.
        const buffer = Buffer.alloc(maxBytes + 1)
        let length = 0
        while (length < buffer.length) {
          const part = await handle.read(buffer, length, buffer.length - length, null)
          if (!part.bytesRead) break
          length += part.bytesRead
        }
        requireValue(length <= maxBytes, 'receipt state exceeds its byte budget')
        state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)))
      } catch {
        throw new Error('receipt state is corrupt, unsafe or exceeds its budget; refusing to reset it')
      } finally { await handle.close() }
    }
    requireValue(state?.version === 1 && state.namespace === namespace && Array.isArray(state.completed) &&
      Object.keys(state).length === 3 && state.completed.length <= maxReceipts,
    'receipt state version, namespace or capacity does not match')
    const completed = new Map()
    for (const entry of state.completed) {
      requireValue(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && ID.test(entry[0]) &&
        typeof entry[1] === 'string' && HEX.test(entry[1]) && !completed.has(entry[0]), 'receipt state contains invalid entries')
      completed.set(entry[0], entry[1])
    }
    function check(id, fingerprint) {
      requireValue(active && !busy && !poisoned, 'receipt store is closed, busy or failed')
      requireValue(typeof id === 'string' && ID.test(id) && typeof fingerprint === 'string' && HEX.test(fingerprint),
        'receipt identity is invalid')
      const prior = completed.get(id)
      requireValue(prior === undefined || prior === fingerprint, 'completed delivery changed identity')
      return prior !== undefined
    }
    function prepare(id, fingerprint) {
      if (check(id, fingerprint)) return null
      requireValue(completed.size < maxReceipts, 'receipt count budget exceeded')
      const text = JSON.stringify({ version: 1, namespace, completed: [...completed, [id, fingerprint]] }) + '\n'
      requireValue(Buffer.byteLength(text) <= maxBytes, 'receipt byte budget exceeded')
      return text
    }
    function record(id, fingerprint) {
      const text = prepare(id, fingerprint)
      if (text === null) return Promise.resolve()
      busy = true
      pendingWrite = (async () => {
        const temp = join(directory, `.receipts-${randomUUID()}.tmp`)
        let file
        try {
          file = await open(temp, 'wx', 0o600)
          await file.writeFile(text)
          await file.sync()
          await file.close()
          file = null
          await rename(temp, path)
          await syncDirectory(directory)
          completed.set(id, fingerprint)
        } catch {
          poisoned = true
          throw new Error('receipt persistence failed; stop processing and replay on recovery')
        } finally {
          if (file) await file.close()
          await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error })
          busy = false
        }
      })()
      // Keep a rejected write handled even if a caller forgets to await it.
      // The scope's finalizer still awaits it and propagates the failure.
      void pendingWrite.catch(() => {})
      return pendingWrite
    }
    // Persist even empty state before any external effect, binding this directory
    // to a single source/board/scope/processing-policy namespace.
    if (!handle) {
      const file = await open(path, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(state) + '\n'); await file.sync() } finally { await file.close() }
      await syncDirectory(directory)
    }
    return await run({ has: check, ensureCapacity: prepare, record })
  } finally {
    active = false
    try { await pendingWrite } finally { await rmdir(lock) }
  }
}
