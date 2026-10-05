// Offline only. Read private inputs, validate them, create a new manifest without
// overwriting an existing installation. No credentials on argv or in output.
import { open, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, resolve, relative, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConsumerConfig } from '../src/consumer-config.js'
import { receiptNamespace } from '../src/receipt-cycle.js'
import { checkKeyWindow } from '../src/runtime-health.js'
import { preflight } from '../src/runtime-cli.js'

export async function prepareRuntime(args, now = Date.now()) {
  if (args.length !== 5) throw new Error('invalid arguments')
  const [consumerConfigFile, alertHookFile, issued, expires, output] = args
  if (![consumerConfigFile, alertHookFile, output].every(p => isAbsolute(p) && !p.includes('\0'))) throw new Error('invalid paths')
  const boardKeyIssuedMs = Date.parse(issued)
  const boardKeyExpiresMs = Date.parse(expires)
  checkKeyWindow(boardKeyIssuedMs, boardKeyExpiresMs)
  const { config } = await loadConsumerConfig(consumerConfigFile)
  const manifest = { version: 1, consumerConfigFile: resolve(consumerConfigFile), stateDirectory: config.stateDirectory,
    namespace: receiptNamespace(config), alertHookFile: resolve(alertHookFile), boardKeyIssuedMs, boardKeyExpiresMs }
  for (const path of [consumerConfigFile, alertHookFile, output]) {
    const rel = relative(config.stateDirectory, resolve(path))
    if (!(rel === '..' || rel.startsWith('../'))) throw new Error('configuration inside state')
  }
  await preflight(manifest, now)
  const file = await open(output, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(manifest, null, 2) + '\n')
    await file.sync()
  } catch (error) {
    await unlink(output)
    throw error
  } finally { await file.close() }
  const parent = await open(dirname(output), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await parent.sync() } finally { await parent.close() }
}
export async function main(args) {
  try {
    await prepareRuntime(args)
    console.log('private runtime manifest created; no network, alerts or services invoked')
    return 0
  } catch {
    console.error('manifest not prepared: require private config, executable hook, valid key dates and a new output path')
    return 2
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2))
