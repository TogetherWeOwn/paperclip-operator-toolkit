// Credential-free test entrypoint. No installs, inherited tokens or sockets.
// All fixture writes live beneath this package and are removed after the run.
import { readdir, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = await mkdtemp(join(root, '.offline-tests-'))
await mkdir(join(scratch, 'home'), { mode: 0o700 })
const guard = new URL('../test/offline-guard.mjs', import.meta.url).href
try {
  const files = (await readdir(join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort()
  if (!files.length) throw new Error('no test files discovered')
  const extra = process.argv.slice(2)
  // Only Node's test-name filter is permitted; cannot replace the guard or files.
  if (extra.some(argument => !argument.startsWith('--test-name-pattern='))) throw new Error('unsupported test argument')
  const child = spawn(process.execPath, ['--import', guard, '--test', ...extra,
    ...files.map(name => join(root, 'test', name))], {
    stdio: 'inherit', shell: false,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: join(scratch, 'home'), TMPDIR: scratch,
      PAPERCLIP_RUN_SCRATCH_DIR: scratch, NODE_OPTIONS: `--import=${guard}`, LANG: 'C.UTF-8' },
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve(signal ? 1 : code ?? 1))
  })
} finally { await rm(scratch, { recursive: true, force: true }) }
