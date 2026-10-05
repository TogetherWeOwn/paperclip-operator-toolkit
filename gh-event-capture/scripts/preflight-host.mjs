// Offline host-path checks, not an authorization probe or a service installer.
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadRuntimeManifest, preflight } from '../src/runtime-cli.js'

export async function preflightHost(home, now = Date.now()) {
  if (typeof home !== 'string' || !home.startsWith('/') || resolve(home) !== home) throw new Error('invalid home')
  const drop = process.env.CREDENTIAL_DROP_DIR || join(home, 'credential-drop')
  const secure = join(drop, 'gh-product-bridge')
  for (const directory of [drop, secure, join(secure, 'bin')]) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('unsafe directory')
  }
  const manifest = await loadRuntimeManifest(join(secure, 'runtime.json'))
  if (manifest.stateDirectory !== join(home, '.local', 'state', 'gh-product-bridge')) throw new Error('unexpected state path')
  await preflight(manifest, now)
}
export async function main(args) {
  try {
    if (args.length) throw new Error('no arguments accepted')
    await preflightHost(process.env.HOME)
    console.log('host paths passed offline preflight; grants, transport and systemd behavior still require authorized acceptance')
    return 0
  } catch {
    console.error('host preflight failed; inspect private paths, gh wrapper, key window and Node version')
    return 2
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2))
