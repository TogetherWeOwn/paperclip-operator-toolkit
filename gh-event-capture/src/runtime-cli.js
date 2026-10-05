// Host entrypoints only: product-only pass, independent watcher and offline
// preflight/init. The alert hook is operator-installed and gets fixed data on
// stdin, never provider bodies, tokens, command arguments or board comments.
import { lstat } from 'node:fs/promises'
import { isAbsolute, resolve, relative, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { loadConsumerConfig } from './consumer-config.js'
import { runProductPass } from './consumer-runner.js'
import { approvedGithub } from './runtime-github.js'
import { receiptNamespace } from './receipt-cycle.js'
import { privateJson, healthDirectory, saveHealthFile, withHealthLock } from './runtime-files.js'
import { checkHealth, freshHealth, beginFiring, finishFiring, checkKeyWindow, healthFinding,
  freshAlertState, checkAlertState, alertDecision } from './runtime-health.js'

function requireValue(value) { if (!value) throw new Error('invalid runtime configuration') }
export async function loadRuntimeManifest(path) {
  const manifest = await privateJson(path)
  requireValue(manifest && Object.keys(manifest).sort().join() ===
    'alertHookFile,boardKeyExpiresMs,boardKeyIssuedMs,consumerConfigFile,namespace,stateDirectory,version' && manifest.version === 1)
  for (const key of ['consumerConfigFile', 'stateDirectory', 'alertHookFile']) {
    requireValue(typeof manifest[key] === 'string' && isAbsolute(manifest[key]) && !manifest[key].includes('\0'))
    manifest[key] = resolve(manifest[key])
  }
  requireValue(typeof manifest.namespace === 'string' && /^[a-f0-9]{64}$/.test(manifest.namespace))
  for (const file of [path, manifest.consumerConfigFile, manifest.alertHookFile]) {
    const rel = relative(manifest.stateDirectory, resolve(file))
    requireValue(rel === '..' || rel.startsWith('../'))
  }
  checkKeyWindow(manifest.boardKeyIssuedMs, manifest.boardKeyExpiresMs)
  return manifest
}
async function checkHook(path) {
  const info = await lstat(path)
  requireValue(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 && (info.mode & 0o100) !== 0)
}
async function consumerInputs(manifest, now) {
  requireValue(now >= manifest.boardKeyIssuedMs && now < manifest.boardKeyExpiresMs)
  const input = await loadConsumerConfig(manifest.consumerConfigFile)
  requireValue(input.config.stateDirectory === manifest.stateDirectory && receiptNamespace(input.config) === manifest.namespace)
  // Neither unattended credential may be a run JWT. Provisioning the dedicated
  // keys and their grants remains an operator responsibility.
  requireValue(input.boardToken.split('.').length !== 3 && input.config.limits.durationMs <= 45000)
  requireValue(input.captureToken.split('.').length !== 3)
  const githubExecutable = await approvedGithub(manifest.consumerConfigFile)
  return { ...input, githubExecutable }
}
export async function preflight(manifest, now) {
  requireValue(Number(process.versions.node.split('.')[0]) >= 22)
  await consumerInputs(manifest, now)
  await checkHook(manifest.alertHookFile)
}
export async function initializeRuntime(manifest, { now = () => Date.now() } = {}) {
  await preflight(manifest, now())
  const directory = await healthDirectory(manifest.stateDirectory)
  return withHealthLock(directory, 'service', async () => {
    try {
      // Only an absent file permits init; even valid JSON null is corrupt state.
      return checkHealth(await privateJson(join(directory, 'health.json')), manifest.namespace)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const state = freshHealth(manifest.namespace, now())
    await saveHealthFile(directory, 'health.json', state)
    return state
  })
}
export function sweepBacklog(sweeps) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null
  const pendingScans = count(sweeps?.pendingScans)
  const ages = Object.values(sweeps?.repos ?? {}).flatMap(repo => ['backfill', 'review']
    .map(phase => repo[phase]).filter(phase => phase && (phase.remaining > 0 || phase.poisoned > 0))
    .map(phase => count(phase.listedAgeMs)))
  return { pendingScans, poisoned: count(sweeps?.poisonedTotal),
    oldestPendingSnapshotAgeMs: pendingScans !== 0 || ages.includes(null) ? null : ages.reduce((a, b) => Math.max(a, b), 0) }
}
export async function runRuntime(manifest, { now = () => Date.now(), run = runProductPass, signal } = {}) {
  const directory = await healthDirectory(manifest.stateDirectory)
  return withHealthLock(directory, 'service', async () => {
    let state = checkHealth(await privateJson(join(directory, 'health.json')), manifest.namespace)
    state = beginFiring(state, now())
    await saveHealthFile(directory, 'health.json', state)
    let result
    try { result = await run(await consumerInputs(manifest, now()), { signal }) } catch {
      result = { ok: false, reason: 'runtime-failed' }
    }
    state = finishFiring(state, now(), result)
    await saveHealthFile(directory, 'health.json', state)
    return { ok: state.outcome === 'healthy', outcome: state.outcome, summary: state.summary, backlog: sweepBacklog(result?.sweeps) }
  })
}
export async function invokeAlertHook(file, payload) {
  await checkHook(file)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, [], { shell: false, stdio: ['pipe', 'ignore', 'ignore'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' } })
    let timedOut = false
    let failed = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 8000)
    child.once('error', () => { failed = true })
    child.stdin.on('error', () => { failed = true })
    child.once('close', code => {
      clearTimeout(timer)
      if (timedOut || failed || code !== 0) reject(new Error('alert hook did not confirm delivery'))
      else resolvePromise()
    })
    child.stdin.end(JSON.stringify(payload) + '\n')
  })
}
export async function watchRuntime(manifest, { now = () => Date.now(), send = invokeAlertHook } = {}) {
  const directory = await healthDirectory(manifest.stateDirectory)
  return withHealthLock(directory, 'watch', async () => {
    let health = null
    try { health = await privateJson(join(directory, 'health.json')) } catch { /* Missing/corrupt health is a finding. */ }
    let alerts
    try { alerts = checkAlertState(await privateJson(join(directory, 'alert.json')), manifest.namespace) } catch (error) {
      if (error.code !== 'ENOENT') throw error // Do not reset dedup state and flood a transport.
      alerts = freshAlertState(manifest.namespace)
    }
    const time = now()
    const finding = healthFinding(health, { namespace: manifest.namespace, now: time,
      issuedMs: manifest.boardKeyIssuedMs, expiresMs: manifest.boardKeyExpiresMs })
    // A fresh start proves firing, not recovery. Preserve the incident until
    // completion so a watcher that overlaps every failing run cannot re-alert.
    if (finding.key === null && health?.outcome === 'running') return { sent: false, finding: null }
    const decision = alertDecision(alerts, finding, time)
    // Persist incident ID + attempt BEFORE the hook. Ambiguous outcomes retry
    // after ten minutes with the same ID; approved transport must deduplicate it.
    await saveHealthFile(directory, 'alert.json', decision.state)
    if (!decision.send) return { sent: false, finding: finding.key }
    const payload = { version: 1, service: 'gh-product-bridge', incidentId: decision.state.incident.id,
      sinceMs: decision.state.incident.sinceMs, reasons: finding.reasons }
    await send(manifest.alertHookFile, payload)
    decision.state.incident.sent = true
    await saveHealthFile(directory, 'alert.json', decision.state)
    return { sent: true, finding: finding.key }
  })
}
export async function main(args, { out = line => console.log(line), error = line => console.error(line) } = {}) {
  if (args.length !== 2 || !['preflight', 'init', 'run', 'watch'].includes(args[0])) {
    error('usage: runtime-cli.js preflight|init|run|watch /absolute/private/runtime.json')
    return 2
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGTERM', cancel)
  process.once('SIGINT', cancel)
  try {
    const manifest = await loadRuntimeManifest(args[1])
    if (args[0] === 'preflight') { await preflight(manifest, Date.now()); out('runtime preflight passed (offline only)'); return 0 }
    if (args[0] === 'init') { await initializeRuntime(manifest); out('runtime health initialized or preserved'); return 0 }
    if (args[0] === 'watch') {
      const result = await watchRuntime(manifest)
      if (result.sent) out(JSON.stringify(result))
      return 0
    }
    const result = await runRuntime(manifest, { signal: controller.signal })
    out(JSON.stringify(result))
    return result.ok ? 0 : 1
  } catch {
    error('runtime operation failed; inspect private configuration, health and lock state')
    return 2
  } finally {
    process.removeListener('SIGTERM', cancel)
    process.removeListener('SIGINT', cancel)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2))
