// Run explicitly with npm run test:sweep-mutants. Mutations only touch isolated
// copies: interruption must never leave the working tree running mutant code.
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const source = dirname(dirname(fileURLToPath(import.meta.url)))
const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'sweep-mutants-'))
const mutants = [
  { name: 'bounded core backfill', file: 'consumer.js',
    from: 'references.length <= maxItems', to: 'true',
    test: 'backfill bounds the complete input before effects and honors asynchronous cancellation' },
  { name: 'await backfill cancellation', file: 'consumer.js',
    from: 'await beforeItem()', to: '// missing hook',
    test: 'backfill bounds the complete input before effects and honors asynchronous cancellation' },
  { name: 'backfill stop guard', file: 'consumer.js',
    from: "isStopped() === false, 'backfill stopped'", to: "true, 'backfill stopped'",
    test: 'backfill bounds the complete input before effects and honors asynchronous cancellation' },
  { name: 'pinned runtime executable', file: 'consumer-runner.js',
    from: 'run(githubExecutable, args, options)', to: 'run(_file, args, options)',
    test: 'runtime-supplied gh executable is used for event reads and both sweep scans, not PATH' },
  { name: 'event fairness across restarts', file: 'receipt-cycle.js',
    from: 'pending.findIndex(p => p.fingerprint > afterFingerprint)', to: '0',
    test: 'a permanent event failure cannot monopolize one-item batches across restarts' },
  { name: 'repository fairness across restarts', file: 'sweep-cycle.js',
    from: '(repos.indexOf(afterRepository) + 1) % repos.length', to: '0',
    test: 'a permanently broken repository scan does not starve another repository' },
  { name: 'stream fairness after exhausted pass', file: 'consumer-runner.js',
    from: 'const first = schedule.nextStream', to: "const first = 'events'",
    test: 'shared budget alternates starting streams after an exhausted pass' },
  { name: 'partial review is not healthy', file: 'sweep-cycle.js',
    from: 'failures.length === 0 && deferred === 0 && poisonedTotal === 0',
    to: 'failures.length === 0 && backfillDeferred === 0 && poisonedTotal === 0',
    test: 'review survives restart mid-drain and resnapshots only after its completion interval' },
  { name: 'namespace isolation', file: 'sweep-store.js',
    from: 'state?.namespace === namespace,', to: 'true,',
    test: 'absent state is fresh; each origin, company, scope and mode has isolated progress' },
  { name: 'honest completion', file: 'sweep-store.js',
    from: "phase !== 'complete' ||", to: 'true ||',
    test: 'state validator rejects fabricated completion and inconsistent snapshots' },
  { name: 'periodic review', file: 'sweep-cycle.js',
    from: "entry.review.phase !== 'draining'", to: "entry.review.phase === 'pending'",
    test: 'empty complete scans are valid and backfill is one-shot while review is periodic' },
  { name: 'cancelled effects never checkpoint', file: 'sweep-cycle.js',
    from: "if (isStopped()) throw new Error('sweep pass stopped')",
    to: "if (false) throw new Error('sweep pass stopped')",
    test: 'cancellation after an ambiguous effect neither checkpoints nor releases the lock early' },
]
async function run(name, mutant) {
  const directory = join(root, name)
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true })
  await cp(join(source, 'test'), join(directory, 'test'), { recursive: true })
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n')
  if (mutant) {
    const path = join(directory, 'src', mutant.file)
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes(mutant.from), `${mutant.name}: mutation was not applied`)
    await writeFile(path, text.replaceAll(mutant.from, mutant.to))
  }
  const result = spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', 'test/sweep-store.test.mjs', 'test/sweep-cycle.test.mjs',
      'test/pass-schedule.test.mjs', 'test/consumer-runner.test.mjs', 'test/consumer.test.mjs'],
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
    assert.match(result.stdout, /# tests 71\n/)
    assert.match(result.stdout, /# pass 71\n/)
    console.log(`PASS ${name}: 71/71 controls`)
  }
}
try {
  await run('control-before')
  for (let i = 0; i < mutants.length; i++) await run(`mutant-${i}`, mutants[i])
  await run('control-after')
} finally {
  await rm(root, { recursive: true, force: true })
}
