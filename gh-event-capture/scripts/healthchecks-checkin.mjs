#!/usr/bin/env node
// Versioned gated Healthchecks.io check-in for gh-product-bridge.
//
// Heartbeat check-in for gh-product-bridge. Provider: a Healthchecks.io-compatible
// monitor with a Discord alert destination. Account signup and ping-URL
// provisioning are operator-private — no secret values here, in any sibling
// file, or in any document.
//
// Contract: send ONE outbound HTTPS ping every 60s (timer-driven; this script
// performs a single gated attempt per invocation and owns no repeating
// scheduler of its own — an unconditional ping loop is forbidden because it
// would report healthy while the consumer or watcher stalls) ONLY after
// confirming fresh progress from BOTH:
//   (a) bridge execution: health.json records a recent *healthy* consumer
//       completion (consumer/store recency), and
//   (b) the health watcher: alert.json was recently written by a watcher tick
//       (watcher heartbeat recency; watchRuntime persists alert state before
//       every hook decision, so its mtime is the watcher heartbeat).
// Fail-closed: stale or unreadable either side means NO ping, so the provider
// fires after timeout+grace. Provider config:
// timeout=60, grace=120 — a finite ~3 min missed-heartbeat deadline to the
// Discord alert. Delivery is the provider's Discord integration (native, else
// generic webhook to the operator-provisioned Discord webhook URL).
//
// Secret handling: the ping URL is read at runtime from a private 0600 file
// (mirror scripts/discord-alert-hook.mjs). It is never printed, never placed
// on argv (world-readable via /proc), and never sent anywhere except the
// provider ping over HTTPS. Short POST timeout (~10s). No board
// comments/wakes; no board key, GitHub PEM, capture key, repo payload or
// agent JWT leaves the host — this script does not read the consumer config
// or either board/capture key, mirroring the watcher's least privilege.
// Install: place the bare ping URL in $SECURE/healthchecks-ping.key (0600,
// user-owned), beside $SECURE/runtime.json. An explicit path may instead be
// passed as argv[2] or via $HC_PING_FILE (manual/test use; the packaged
// service strips both, so the sibling path is the production resolution).
import { readFile, lstat, stat } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { checkHealth } from '../src/runtime-health.js'

const SIBLING_PING_NAME = 'healthchecks-ping.key'
const URL_FILE_LIMIT = 4096
const PING_TIMEOUT_MS = 10000
// Freshness budgets. Main timer fires every 60s with a 45s cooperative pass
// budget, so back-to-back completions can legitimately sit ~105s apart; two
// full periods (120s) without a healthy completion is a stall. The watcher
// ticks every 30s and escalates at 130s, so 90s (three ticks) keeps this
// check-in strictly earlier than the in-host escalation: the ping stops
// before the host declares its own emergency.
export const CONSUMER_FRESH_MS = 120000
export const WATCHER_FRESH_MS = 90000
const PING_HOSTS = new Set(['hc-ping.com'])

function fail(code, message) {
  console.error(message)
  process.exit(code)
}

function pingCandidates(argv, manifestPath) {
  if (argv.length > 4) fail(2, 'check-in takes at most a manifest path and an optional private ping file')
  if (argv[3]) return [argv[3]]
  if (process.env.HC_PING_FILE) return [process.env.HC_PING_FILE]
  return [join(dirname(resolve(manifestPath)), SIBLING_PING_NAME)]
}

export function isAcceptablePingUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 || /\s/.test(raw)) return false
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return false
  const loopbackAllowed = process.env.HC_CHECKIN_ALLOW_HTTP_LOOPBACK === '1'
  if (loopbackAllowed && parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
    return parsed.pathname.length > 1
  }
  return parsed.protocol === 'https:' && PING_HOSTS.has(parsed.hostname) && parsed.pathname.length > 1
}

async function readPingUrl(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    fail(2, 'check-in unavailable; inspect private ping file placement and permissions')
  }
  let info
  try {
    info = await lstat(path)
  } catch {
    fail(2, 'check-in unavailable; inspect private ping file placement and permissions')
  }
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 ||
      info.size <= 0 || info.size > URL_FILE_LIMIT) {
    fail(2, 'check-in unavailable; inspect private ping file placement and permissions')
  }
  let raw
  try {
    raw = (await readFile(path, 'utf8')).trim()
  } catch {
    fail(2, 'check-in unavailable; inspect private ping file placement and permissions')
  }
  if (!isAcceptablePingUrl(raw)) {
    fail(2, 'check-in unavailable; inspect private ping file placement and permissions')
  }
  return raw
}

// Pure gate decision. Fail-closed: every unknown or degraded input suppresses.
export function decideCheckin({ now, namespace, issuedMs, expiresMs, health, alertMtimeMs }) {
  if (!(Number.isSafeInteger(now) && now >= 0)) return { ping: false, reason: 'clock-invalid' }
  if (!(Number.isSafeInteger(issuedMs) && Number.isSafeInteger(expiresMs) && expiresMs > issuedMs)) {
    return { ping: false, reason: 'key-window-invalid' }
  }
  if (now >= expiresMs) return { ping: false, reason: 'key-expired' }
  if (now < issuedMs) return { ping: false, reason: 'key-window-invalid' }
  let checked
  try {
    checked = checkHealth(health, namespace)
  } catch {
    return { ping: false, reason: 'health-state-invalid' }
  }
  const times = [checked.activatedMs, checked.lastStartMs, checked.lastFinishMs, checked.lastHealthyMs]
    .filter(n => n !== null)
  if (times.some(n => n > now)) return { ping: false, reason: 'health-state-invalid' }
  if (checked.outcome !== 'healthy') return { ping: false, reason: 'consumer-not-healthy' }
  if (now - checked.lastFinishMs > CONSUMER_FRESH_MS) return { ping: false, reason: 'consumer-stale' }
  if (alertMtimeMs === null || alertMtimeMs === undefined) return { ping: false, reason: 'watcher-missing' }
  if (!(Number.isFinite(alertMtimeMs) && alertMtimeMs <= now)) return { ping: false, reason: 'watcher-stale' }
  if (now - alertMtimeMs > WATCHER_FRESH_MS) return { ping: false, reason: 'watcher-stale' }
  return { ping: true, reason: 'ok' }
}

async function postPing(url) {
  const response = await fetch(url, {
    method: 'POST',
    body: '',
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  })
  return response.status >= 200 && response.status < 300
}

export async function main(argv = process.argv, deps = {}) {
  const { loadRuntimeManifest } = await import('../src/runtime-cli.js')
  const { privateJson } = await import('../src/runtime-files.js')
  if (argv.length < 3 || argv.length > 4) {
    fail(2, 'usage: healthchecks-checkin.mjs /absolute/private/runtime.json [private-ping-file]')
  }
  const manifestPath = argv[2]
  let manifest
  try {
    manifest = await loadRuntimeManifest(manifestPath)
  } catch {
    fail(2, 'check-in unavailable; inspect private runtime manifest placement and permissions')
  }
  const [pingFile] = pingCandidates(argv, manifestPath)
  const url = await readPingUrl(pingFile)
  let health
  try {
    health = await privateJson(join(manifest.stateDirectory, 'health', 'health.json'))
  } catch {
    health = null // Missing/unreadable health is a finding: suppress, never invent freshness.
  }
  let alertMtimeMs = null
  try {
    const alertPath = join(manifest.stateDirectory, 'health', 'alert.json')
    const info = await lstat(alertPath)
    if (info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0) {
      alertMtimeMs = (await stat(alertPath)).mtimeMs
    }
  } catch {
    alertMtimeMs = null // Missing/unsafe watcher state is a finding: suppress.
  }
  const now = Date.now()
  const decision = decideCheckin({ now, namespace: manifest.namespace,
    issuedMs: manifest.boardKeyIssuedMs, expiresMs: manifest.boardKeyExpiresMs, health, alertMtimeMs })
  if (!decision.ping) {
    console.error(`check-in suppressed: ${decision.reason}`)
    return 0
  }
  const send = deps.postPing ?? postPing
  let confirmed = false
  try {
    confirmed = await send(url)
  } catch {
    confirmed = false
  }
  // Transport failure is NOT confirmed: exit nonzero so the timer journal shows
  // the gap, and the provider deadline keeps running toward the Discord alert.
  if (!confirmed) fail(1, 'check-in not confirmed; provider deadline continues toward alert')
  console.log(JSON.stringify({ sent: true }))
  return 0
}

if (import.meta.url === new URL(`file://${resolve(process.argv[1] ?? '')}`).href) {
  process.exitCode = await main(process.argv)
}
