// Small private health files; independent reader/writer locks let the watcher
// observe a hung main pass. Event effects remain under the receipt-store lock.
import { constants } from 'node:fs'
import { open, mkdir, lstat, rename, unlink, rmdir } from 'node:fs/promises'
import { isAbsolute, join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

async function syncDirectory(path) {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await dir.sync() } finally { await dir.close() }
}
export async function privateJson(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('runtime path must be absolute')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > 16384) {
      throw new Error('unsafe runtime file')
    }
    const buffer = Buffer.alloc(16385)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > 16384) throw new Error('runtime file too large')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)))
  } finally { await file.close() }
}
export async function privateDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('runtime path must be absolute')
  try { await mkdir(path, { mode: 0o700 }); await syncDirectory(dirname(path)) } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error('unsafe runtime directory')
}
export async function healthDirectory(stateDirectory) {
  await privateDirectory(stateDirectory)
  const directory = join(stateDirectory, 'health')
  await privateDirectory(directory)
  return directory
}
export async function saveHealthFile(directory, name, state) {
  if (!['health.json', 'alert.json'].includes(name)) throw new Error('unknown health file')
  const text = JSON.stringify(state) + '\n'
  if (Buffer.byteLength(text) > 16384) throw new Error('health file too large')
  const temp = join(directory, `.health-${randomUUID()}.tmp`)
  let file
  try {
    file = await open(temp, 'wx', 0o600)
    await file.writeFile(text)
    await file.sync()
    await file.close()
    file = null
    await rename(temp, join(directory, name))
    await syncDirectory(directory)
  } finally {
    if (file) await file.close()
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
export async function withHealthLock(directory, kind, fn) {
  if (!['service', 'watch'].includes(kind)) throw new Error('unknown health lock')
  const lock = join(directory, `${kind}.lock`)
  await mkdir(lock, { mode: 0o700 }) // Fail closed on overlap/stale owner, never auto-reclaim.
  try { return await fn() } finally { await rmdir(lock) }
}
