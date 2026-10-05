// Generic preparation controls extracted from the mixed deployment-package tests.
// No templates, units, actual wrapper, subscription or operational config is read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, symlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareRuntime } from '../scripts/prepare-runtime.mjs'
import { loadRuntimeManifest, sweepBacklog } from '../src/runtime-cli.js'
import { receiptNamespace } from '../src/receipt-cycle.js'

async function fixture(t) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'runtime-preparation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const inputs = join(root, 'inputs')
  await mkdir(join(inputs, 'bin'), { mode: 0o700, recursive: true })
  const repo = 'example-owner/project'
  const config = { version: 1, mode: 'products-only-v1', captureOrigin: 'https://capture.test', boardOrigin: 'https://board.test',
    companyId: '00000000-0000-4000-8000-000000000001', allowedRepositories: [repo], repositoryVisibility: { [repo]: true },
    bridgePolicy: { trackerPrefix: 'CASE7', agentLogin: 'synthetic-agent[bot]' }, stateDirectory: join(root, 'state'),
    captureTokenFile: join(inputs, 'capture.key'), boardTokenFile: join(inputs, 'board.key'), limits: { durationMs: 45000 } }
  await writeFile(config.captureTokenFile, 'synthetic-capture-secret', { mode: 0o600 })
  await writeFile(config.boardTokenFile, 'synthetic-board-secret', { mode: 0o600 })
  const configFile = join(inputs, 'consumer.json')
  const hook = join(inputs, 'alert-hook'), wrapper = join(inputs, 'bin', 'gh'), output = join(inputs, 'runtime.json')
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 })
  const invoked = join(root, 'unexpected-execution')
  // Inspection-only controls: either stub records and fails if ever invoked.
  const stub = `#!${process.execPath}\nimport('node:fs').then(fs => { fs.writeFileSync(${JSON.stringify(invoked)}, 'invoked'); process.exitCode = 77 })\n`
  await writeFile(hook, stub, { mode: 0o700 })
  await writeFile(wrapper, stub, { mode: 0o700 })
  const args = [configFile, hook, '2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z', output]
  return { root, inputs, config, configFile, hook, wrapper, output, invoked, args, now: Date.parse('2030-01-02T00:00:00Z') }
}
async function notCreated(path) { await assert.rejects(readFile(path), { code: 'ENOENT' }) }

test('offline preparation creates a private policy-bound manifest without executing hooks or provider stubs', async t => {
  const h = await fixture(t)
  await prepareRuntime(h.args, h.now)
  const manifest = await loadRuntimeManifest(h.output)
  assert.equal(manifest.namespace, receiptNamespace(h.config))
  assert.equal(manifest.stateDirectory, h.config.stateDirectory)
  assert.equal(manifest.alertHookFile, h.hook)
  assert.equal((await stat(h.output)).mode & 0o777, 0o600)
  const before = await readFile(h.output, 'utf8')
  assert.equal(before.includes('synthetic-board-secret'), false)
  assert.equal(before.includes('synthetic-capture-secret'), false)
  await assert.rejects(prepareRuntime(h.args, h.now), { code: 'EEXIST' })
  assert.equal(await readFile(h.output, 'utf8'), before)
  await notCreated(h.invoked)
  await assert.rejects(stat(h.config.stateDirectory), { code: 'ENOENT' })
})

test('preparation rejects expired, future, overlong or malformed key windows without creating output', async t => {
  const h = await fixture(t)
  await assert.rejects(prepareRuntime(h.args, Date.parse('2030-02-01T00:00:00Z')))
  await assert.rejects(prepareRuntime(h.args, Date.parse('2029-12-31T00:00:00Z')))
  for (const issued of ['not-a-date', '2030-02-01T00:00:00Z']) {
    const args = [...h.args]; args[2] = issued
    await assert.rejects(prepareRuntime(args, h.now))
  }
  const tooLong = [...h.args]; tooLong[3] = '2030-02-01T00:00:00Z'
  await assert.rejects(prepareRuntime(tooLong, h.now))
  await notCreated(h.output)
  await notCreated(h.invoked)
})

test('preparation rejects public config or credentials, JWT-shaped keys and excessive pass duration', async t => {
  const h = await fixture(t)
  for (const path of [h.configFile, h.config.captureTokenFile, h.config.boardTokenFile]) {
    await chmod(path, 0o644)
    await assert.rejects(prepareRuntime(h.args, h.now))
    await chmod(path, 0o600)
  }
  for (const path of [h.config.captureTokenFile, h.config.boardTokenFile]) {
    const original = await readFile(path, 'utf8')
    await writeFile(path, 'eyJ.synthetic.jwt')
    await assert.rejects(prepareRuntime(h.args, h.now))
    await writeFile(path, original)
  }
  await writeFile(h.configFile, JSON.stringify({ ...h.config, limits: { durationMs: 45001 } }))
  await assert.rejects(prepareRuntime(h.args, h.now))
  await notCreated(h.output)
  await notCreated(h.invoked)
})

test('preparation inspects but never runs missing, public or symlinked approved executables', async t => {
  const h = await fixture(t)
  for (const path of [h.wrapper, h.hook]) {
    await chmod(path, 0o755)
    await assert.rejects(prepareRuntime(h.args, h.now))
    await chmod(path, 0o700)
    const content = await readFile(path, 'utf8')
    await rm(path)
    await assert.rejects(prepareRuntime(h.args, h.now))
    const target = join(h.root, 'executable-target')
    await writeFile(target, content, { mode: 0o700 })
    await symlink(target, path)
    await assert.rejects(prepareRuntime(h.args, h.now))
    await rm(path)
    await writeFile(path, content, { mode: 0o700 })
  }
  await chmod(h.inputs, 0o755)
  await assert.rejects(prepareRuntime(h.args, h.now))
  await notCreated(h.output)
  await notCreated(h.invoked)
})

test('preparation requires explicit absolute paths and keeps config and output outside state', async t => {
  const h = await fixture(t)
  for (const args of [[], h.args.slice(0, 4), [...h.args, 'extra']]) await assert.rejects(prepareRuntime(args, h.now))
  for (const index of [0, 1, 4]) {
    const args = [...h.args]; args[index] = 'relative-file'
    await assert.rejects(prepareRuntime(args, h.now))
  }
  const inside = [...h.args]; inside[4] = join(h.config.stateDirectory, 'runtime.json')
  await assert.rejects(prepareRuntime(inside, h.now), /configuration inside state/)
  const noPolicy = { ...h.config }; delete noPolicy.bridgePolicy
  await writeFile(h.configFile, JSON.stringify(noPolicy))
  await assert.rejects(prepareRuntime(h.args, h.now), /configuration/)
  await notCreated(h.output)
  await notCreated(h.invoked)
})

test('preparation refuses an existing output symlink and never overwrites its target', async t => {
  const h = await fixture(t)
  const target = join(h.root, 'existing-manifest')
  await writeFile(target, 'existing-private-state', { mode: 0o600 })
  await symlink(target, h.output)
  await assert.rejects(prepareRuntime(h.args, h.now), { code: 'EEXIST' })
  assert.equal(await readFile(target, 'utf8'), 'existing-private-state')
  await notCreated(h.invoked)
})

test('generic backlog reporting preserves unknown ages and omits raw repository or provider data', () => {
  assert.deepEqual(sweepBacklog(null), { pendingScans: null, poisoned: null, oldestPendingSnapshotAgeMs: null })
  const sweeps = { pendingScans: 0, poisonedTotal: 1, repos: { 'example-owner/project': {
    backfill: { remaining: 2, poisoned: 0, listedAgeMs: 9000 }, review: { remaining: 0, poisoned: 1, listedAgeMs: 15000 } } },
    failures: [{ message: 'SYNTHETIC_PROVIDER_ERROR' }] }
  assert.deepEqual(sweepBacklog(sweeps), { pendingScans: 0, poisoned: 1, oldestPendingSnapshotAgeMs: 15000 })
  assert.equal(sweepBacklog({ ...sweeps, pendingScans: 1 }).oldestPendingSnapshotAgeMs, null)
  sweeps.repos['example-owner/project'].review.listedAgeMs = -1
  assert.equal(sweepBacklog(sweeps).oldestPendingSnapshotAgeMs, null)
  assert.equal(JSON.stringify(sweepBacklog(sweeps)).includes('SYNTHETIC_PROVIDER_ERROR'), false)
  assert.equal(JSON.stringify(sweepBacklog(sweeps)).includes('example-owner/project'), false)
})
