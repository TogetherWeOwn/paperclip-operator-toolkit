// Linux host configuration: credentials are read from private files, never argv.
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, resolve, relative } from 'node:path'
import { receiptNamespace } from './receipt-cycle.js'
import { runnerLimits } from './consumer-runner.js'

const FIELDS = new Set(['version', 'mode', 'captureOrigin', 'boardOrigin', 'companyId',
  'allowedRepositories', 'stateDirectory', 'captureTokenFile', 'boardTokenFile', 'limits'])
function requireValue(condition) {
  if (!condition) throw new Error('consumer configuration or credential file is invalid')
}
const absolute = (v) => typeof v === 'string' && isAbsolute(v) && !v.includes('\0')
async function privateText(path, limit) {
  let file
  try {
    requireValue(absolute(path))
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await file.stat()
    requireValue(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 && info.size <= limit)
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    requireValue(length <= limit)
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
  } finally { if (file) await file.close() }
}
export async function loadConsumerConfig(path) {
  try {
    const config = JSON.parse(await privateText(path, 64 * 1024))
    requireValue(config && typeof config === 'object' && !Array.isArray(config) &&
      Object.keys(config).every((key) => FIELDS.has(key)) && config.version === 1 &&
      config.mode === 'products-only-v1' && absolute(config.stateDirectory) &&
      absolute(config.captureTokenFile) && absolute(config.boardTokenFile))
    requireValue(new URL(config.captureOrigin).protocol === 'https:')
    receiptNamespace(config)
    config.limits = runnerLimits(config.limits)
    config.stateDirectory = resolve(config.stateDirectory)
    for (const file of [path, config.captureTokenFile, config.boardTokenFile]) {
      const rel = relative(config.stateDirectory, resolve(file))
      requireValue(rel === '..' || rel.startsWith('../'))
    }
    const captureToken = (await privateText(config.captureTokenFile, 16 * 1024)).replace(/\r?\n$/, '')
    const boardToken = (await privateText(config.boardTokenFile, 16 * 1024)).replace(/\r?\n$/, '')
    requireValue(captureToken.length > 0 && boardToken.length > 0 && !/\s/.test(captureToken) && !/\s/.test(boardToken))
    return { config, captureToken, boardToken }
  } catch {
    // JSON, open and decoder errors can contain private contents or file paths.
    throw new Error('consumer configuration or credential file is invalid')
  }
}
