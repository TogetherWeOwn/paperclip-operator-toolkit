import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
let count = 0
for (const directory of ['src', 'test', 'scripts']) {
  for (const name of (await readdir(join(root, directory))).sort()) {
    if (!/\.(?:js|mjs)$/.test(name)) continue
    const result = spawnSync(process.execPath, ['--check', join(root, directory, name)], {
      stdio: 'inherit', shell: false, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    })
    if (result.status !== 0) process.exit(result.status ?? 1)
    count++
  }
}
console.log(`Syntax checked ${count} source, script and test files`)
