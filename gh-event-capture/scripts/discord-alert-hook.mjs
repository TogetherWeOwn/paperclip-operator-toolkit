#!/usr/bin/env node
// Versioned gh-product-bridge Discord alert hook.
//
// Discord alert hook for gh-product-bridge (Discord-family reuse, dedicated
// operator-provisioned webhook, no new vendor). Webhook URL provisioning is
// operator-private at install.
//
// Contract (runtime-cli.js
// invokeAlertHook/watchRuntime): one JSON line on stdin, no args, minimal env
// (PATH/HOME/LANG only). Exit 0 only after confirmed delivery (2xx). Dedup by
// stable incidentId; ambiguous delivery must retry in 10 min with the same ID
// (the runtime persists the attempt before launch and retries; this hook must
// NOT record delivery unless the POST is confirmed, and must skip the POST
// when the ID is already recorded delivered). No board comments or wakes, no
// provider bodies, no CI polling.
//
// Secret handling: the webhook URL is read at runtime from a private file. It
// is never printed, never embedded here, never placed on argv (world-readable
// via /proc), and never sent anywhere except the Discord POST body/URL over
// HTTPS. All failure messages are generic and carry no credential material.
// Install: copy this file to $SECURE/alert-hook (0700, user-owned) and place
// the bare webhook URL in the sibling file $SECURE/discord-webhook.key (0600,
// user-owned). An explicit path may instead be passed as argv[1] or via
// $DISCORD_WEBHOOK_FILE (manual/test use; the runtime strips both, so the
// sibling path is the production resolution).
import { readFile, writeFile, lstat } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute } from 'node:path'

const SERVICE = 'gh-product-bridge'
const VERSION = 1
const STDIN_LIMIT = 65536
const URL_FILE_LIMIT = 4096
const DELIVERY_TIMEOUT_MS = 6000
const DEDUP_PRUNE_MS = 30 * 86400000
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com'])
const INCIDENT_RE = /^[a-f0-9]{64}$/
const REASON_RE = /^[a-z+-]{1,160}$/
const SIBLING_WEBHOOK_NAME = 'discord-webhook.key'

function fail(code, message) {
  console.error(message)
  process.exit(code)
}

function webhookCandidates(argv) {
  if (argv.length > 3) fail(2, 'alert hook takes at most one argument: the private webhook file')
  if (argv[2]) return [argv[2]]
  if (process.env.DISCORD_WEBHOOK_FILE) return [process.env.DISCORD_WEBHOOK_FILE]
  const sibling = join(dirname(resolve(argv[1])), SIBLING_WEBHOOK_NAME)
  const home = process.env.HOME
  const dropDir = process.env.CREDENTIAL_DROP_DIR || (home ? join(home, 'credential-drop') : null)
  const homeDefault = dropDir ? join(dropDir, 'gh-product-bridge', SIBLING_WEBHOOK_NAME) : null
  return homeDefault && homeDefault !== sibling ? [sibling, homeDefault] : [sibling]
}

async function readWebhookUrl(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    fail(2, 'alert webhook unavailable; inspect private webhook file placement and permissions')
  }
  let info
  try {
    info = await lstat(path)
  } catch {
    fail(2, 'alert webhook unavailable; inspect private webhook file placement and permissions')
  }
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 ||
      info.size <= 0 || info.size > URL_FILE_LIMIT) {
    fail(2, 'alert webhook unavailable; inspect private webhook file placement and permissions')
  }
  let raw
  try {
    raw = (await readFile(path, 'utf8')).trim()
  } catch {
    fail(2, 'alert webhook unavailable; inspect private webhook file placement and permissions')
  }
  if (!isAcceptableWebhookUrl(raw)) {
    fail(2, 'alert webhook unavailable; inspect private webhook file placement and permissions')
  }
  return raw
}

export function isAcceptableWebhookUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 || /\s/.test(raw)) return false
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return false
  const loopbackAllowed = process.env.DISCORD_ALERT_HOOK_ALLOW_HTTP_LOOPBACK === '1'
  if (loopbackAllowed && parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
    return parsed.pathname.length > 1
  }
  if (parsed.protocol !== 'https:' || !DISCORD_HOSTS.has(parsed.hostname)) return false
  const parts = parsed.pathname.split('/').filter(Boolean)
  return parts.length >= 4 && parts[0] === 'api' && parts[1] === 'webhooks' &&
    parts.every(part => part.length > 0 && part.length <= 256)
}

function readStdin(limit) {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    let overflow = false
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      data += chunk
      if (data.length > limit) overflow = true
    })
    process.stdin.on('end', () => {
      if (overflow) reject(new Error('stdin too large'))
      else resolvePromise(data)
    })
    process.stdin.on('error', reject)
  })
}

export function parsePayload(line) {
  let payload
  try {
    payload = JSON.parse(line)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  if (payload.version !== VERSION || payload.service !== SERVICE) return null
  if (typeof payload.incidentId !== 'string' || !INCIDENT_RE.test(payload.incidentId)) return null
  if (!Number.isSafeInteger(payload.sinceMs) || payload.sinceMs < 0) return null
  if (!Array.isArray(payload.reasons) || payload.reasons.length === 0 || payload.reasons.length > 20) return null
  if (!payload.reasons.every(reason => typeof reason === 'string' && REASON_RE.test(reason))) return null
  return { incidentId: payload.incidentId, sinceMs: payload.sinceMs, reasons: payload.reasons }
}

function formatContent({ incidentId, sinceMs, reasons }) {
  let stamp
  try {
    stamp = new Date(sinceMs).toISOString()
  } catch {
    return null
  }
  const content = `[${SERVICE}] ${reasons.join('+')} since ${stamp} incident ${incidentId}`
  return content.length > 0 && content.length <= 2000 ? content : null
}

async function loadDelivered(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    console.error('alert dedup state unreadable; proceeding to delivery and rewriting on success')
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error('alert dedup state unreadable; proceeding to delivery and rewriting on success')
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('alert dedup state unreadable; proceeding to delivery and rewriting on success')
    return {}
  }
  const now = Date.now()
  const clean = {}
  for (const [id, at] of Object.entries(parsed)) {
    if (INCIDENT_RE.test(id) && Number.isSafeInteger(at) && at >= 0 && now - at <= DEDUP_PRUNE_MS) clean[id] = at
  }
  return clean
}

async function recordDelivered(path, incidentId) {
  const delivered = await loadDelivered(path)
  delivered[incidentId] = Date.now()
  await writeFile(path, JSON.stringify(delivered) + '\n', { mode: 0o600 })
}

async function postWebhook(url, content) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  })
  return response.status >= 200 && response.status < 300
}

export async function main(argv = process.argv) {
  const [webhookFile, ...fallbacks] = webhookCandidates(argv)
  let url = null
  let resolvedFile = null
  for (const candidate of [webhookFile, ...fallbacks]) {
    try {
      await lstat(candidate)
    } catch {
      continue
    }
    resolvedFile = candidate
    break
  }
  if (resolvedFile === null) {
    fail(2, 'alert webhook unavailable; inspect private webhook file placement and permissions')
  }
  url = await readWebhookUrl(resolvedFile)
  const dedupFile = `${resolvedFile}.delivered`

  let input
  try {
    input = await readStdin(STDIN_LIMIT)
  } catch {
    fail(2, 'alert payload unreadable; expected one JSON line on stdin')
  }
  const firstLine = input.split('\n').find(line => line.trim() !== '')
  const payload = firstLine === undefined ? null : parsePayload(firstLine)
  if (payload === null) fail(2, 'alert payload invalid; expected version, service, incidentId, sinceMs and reasons')
  const content = formatContent(payload)
  if (content === null) fail(2, 'alert payload invalid; expected version, service, incidentId, sinceMs and reasons')

  const delivered = await loadDelivered(dedupFile)
  if (delivered[payload.incidentId]) {
    console.error(`alert ${payload.incidentId} already delivered; skipping repost`)
    return 0
  }
  let confirmed = false
  try {
    confirmed = await postWebhook(url, content)
  } catch {
    confirmed = false
  }
  if (!confirmed) fail(1, `alert ${payload.incidentId} not confirmed; transport will retry with the same incident`)
  try {
    await recordDelivered(dedupFile, payload.incidentId)
  } catch {
    fail(1, `alert ${payload.incidentId} not confirmed; transport will retry with the same incident`)
  }
  return 0
}

if (import.meta.url === new URL(`file://${resolve(process.argv[1] ?? '')}`).href) {
  process.exitCode = await main(process.argv)
}
