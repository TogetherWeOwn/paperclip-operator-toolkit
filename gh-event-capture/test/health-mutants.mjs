// Isolated copies only; interrupting this gate cannot mutate the working tree.
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const source = dirname(dirname(fileURLToPath(import.meta.url)))
const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'health-mutants-'))
const mutants = [
  { name: 'capture credential is not a run JWT', file: 'runtime-cli.js', from: "input.captureToken.split('.').length !== 3", to: 'true',
    test: 'runtime refuses JWT-shaped capture credentials before any pass effect' },
  { name: 'runtime wrapper validation', file: 'runtime-cli.js', from: 'await approvedGithub(manifest.consumerConfigFile)', to: "manifest.consumerConfigFile.replace(/[^/]+$/, 'bin/gh')",
    test: 'runtime revalidates the pinned gh wrapper on every firing before invoking a pass' },
  { name: 'two missed firings', file: 'runtime-health.js', from: 'age >= MISSED_AFTER_MS', to: 'false',
    test: 'fixed clock: exactly two missed 60-second firings plus grace, including never-started timer' },
  { name: 'namespace validation', file: 'runtime-health.js', from: 'state.namespace === namespace', to: 'true',
    test: 'missing, corrupt, wrong-scope and future health cannot produce a false green' },
  { name: 'successful alert suppression', file: 'runtime-health.js', from: '!incident.sent &&', to: 'true &&',
    test: 'alert decisions suppress chatter, retry ambiguous delivery with stable ID, and reset on recovery' },
  { name: 'failed alert cooldown', file: 'runtime-health.js', from: 'now - incident.attemptMs >= ALERT_RETRY_MS', to: 'true',
    test: 'alert decisions suppress chatter, retry ambiguous delivery with stable ID, and reset on recovery' },
  { name: 'running is not recovery', file: 'runtime-cli.js', from: "finding.key === null && health?.outcome === 'running'", to: 'false',
    test: 'running is not recovery and cannot cause repeated failure alerts' },
  { name: 'persist before send', file: 'runtime-cli.js', from: "await saveHealthFile(directory, 'alert.json', decision.state)", to: '// missing checkpoint',
    test: 'alert incident and attempt are durable before the hook; post-send failure retains the same ID' },
  { name: 'dedicated credential only', file: 'runtime-cli.js', from: "input.boardToken.split('.').length !== 3 &&", to: 'true &&',
    test: 'runtime refuses run JWTs and expired keys, persists failure, and never invokes the pass' },
  { name: 'key expiry gate', file: 'runtime-cli.js', from: 'now >= manifest.boardKeyIssuedMs && now < manifest.boardKeyExpiresMs', to: 'true',
    test: 'runtime refuses run JWTs and expired keys, persists failure, and never invokes the pass' },
  { name: '30-day maximum key lifetime', file: 'runtime-health.js', from: 'expiresMs - issuedMs <= KEY_LIFETIME_MS', to: 'true',
    test: 'key metadata enforces at most 30 days and warns three days before expiry' },
]
async function run(name, mutant) {
  const directory = join(root, name)
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true })
  await cp(join(source, 'test'), join(directory, 'test'), { recursive: true })
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n')
  if (mutant) {
    const path = join(directory, 'src', mutant.file)
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes(mutant.from), `${name}: mutation not applied`)
    await writeFile(path, text.replaceAll(mutant.from, mutant.to))
  }
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/runtime-health.test.mjs'],
    { cwd: directory, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
  assert.equal(result.error, undefined, `${name}: test process did not complete`)
  assert.equal(result.signal, null, `${name}: test process was killed`)
  if (mutant) {
    assert.equal(result.status, 1, `${name}: mutant survived or crashed outside tests\n${result.stdout}\n${result.stderr}`)
    assert.ok(result.stdout.split('\n').some(line => line.startsWith('not ok ') && line.endsWith(` - ${mutant.test}`)),
      `${name}: expected behavioral regression did not fail\n${result.stdout}\n${result.stderr}`)
    console.log(`KILLED ${mutant.name}: ${mutant.test}`)
  } else {
    assert.equal(result.status, 0, `${name}: positive control failed\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /# tests 19\n/)
    assert.match(result.stdout, /# pass 19\n/)
    console.log(`PASS ${name}: 19/19 controls`)
  }
}
try {
  await run('control-before')
  for (let i = 0; i < mutants.length; i++) await run(`mutant-${i}`, mutants[i])
  await run('control-after')
} finally {
  await rm(root, { recursive: true, force: true })
}
