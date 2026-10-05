import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, chmod, rm, copyFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const hookSource = join(repoRoot, 'scripts', 'discord-alert-hook.mjs')
const incidentId = 'c'.repeat(64)
const payload = { version: 1, service: 'gh-product-bridge', incidentId, sinceMs: 1000000, reasons: ['two-missed-firings'] }

function stubDiscord(t, statuses = [200]) {
  const hits = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      hits.push({ url: req.url, body })
      res.writeHead(statuses[Math.min(hits.length - 1, statuses.length - 1)], { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close())
      resolve({ hits, port: server.address().port })
    })
  })
}

// Mirror production: the hook lives at $SECURE/alert-hook (0700) with the bare
// webhook URL beside it at $SECURE/discord-webhook.key (0600). The child gets a
// minimal environment, exactly as runtime-cli invokeAlertHook provides.
async function harness(t, { webhookUrl, hookMode = 0o700, keyMode = 0o600, extraEnv = {} } = {}) {
  const home = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'discord-hook-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const secure = join(home, 'credential-drop', 'gh-product-bridge')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(secure, { recursive: true })
  const hook = join(secure, 'alert-hook')
  await copyFile(hookSource, hook)
  await chmod(hook, hookMode)
  const keyFile = join(secure, 'discord-webhook.key')
  if (webhookUrl !== undefined) {
    await writeFile(keyFile, `${webhookUrl}\n`, { mode: keyMode })
    if (keyMode !== 0o600) await chmod(keyFile, keyMode)
  }
  const run = (input, env = {}) => new Promise(resolve => {
    const child = spawn(hook, [], { stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8',
        DISCORD_ALERT_HOOK_ALLOW_HTTP_LOOPBACK: '1', ...extraEnv, ...env } })
    let stdout = '', stderr = ''
    child.stdout.on('data', s => { stdout += s })
    child.stderr.on('data', s => { stderr += s })
    // A fast refusal exits before draining stdin; swallow the resulting EPIPE.
    child.stdin.on('error', () => {})
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
  return { home, secure, hook, keyFile, run }
}

function webhookFor(port) {
  return `http://127.0.0.1:${port}/api/webhooks/test-token-segment/final-segment`
}

test('valid payload posts once to the private webhook and records delivery', async (t) => {
  const { hits, port } = await stubDiscord(t)
  const h = await harness(t, { webhookUrl: webhookFor(port) })
  const first = await h.run(`${JSON.stringify(payload)}\n`)
  assert.equal(first.code, 0)
  assert.equal(hits.length, 1)
  const sent = JSON.parse(hits[0].body)
  assert.ok(sent.content.includes('gh-product-bridge'))
  assert.ok(sent.content.includes('two-missed-firings'))
  assert.ok(sent.content.includes(incidentId))
  assert.equal(hits[0].body.includes('127.0.0.1'), false, 'webhook URL must not appear in the posted body')
  assert.equal(first.stdout.includes('127.0.0.1'), false)
  assert.equal(first.stderr.includes('127.0.0.1'), false)
  const delivered = JSON.parse(await readFile(`${h.keyFile}.delivered`, 'utf8'))
  assert.ok(Number.isSafeInteger(delivered[incidentId]))
  assert.equal((await stat(`${h.keyFile}.delivered`)).mode & 0o777 & 0o077, 0)
})

test('repeat delivery of the same incident exits 0 without reposting', async (t) => {
  const { hits, port } = await stubDiscord(t)
  const h = await harness(t, { webhookUrl: webhookFor(port) })
  assert.equal((await h.run(`${JSON.stringify(payload)}\n`)).code, 0)
  assert.equal(hits.length, 1)
  const repeat = await h.run(`${JSON.stringify(payload)}\n`)
  assert.equal(repeat.code, 0)
  assert.equal(hits.length, 1, 'dedup hit must not repost')
})

test('ambiguous delivery (5xx) exits nonzero, records nothing, and retries the same ID', async (t) => {
  const { hits, port } = await stubDiscord(t, [500])
  const h = await harness(t, { webhookUrl: webhookFor(port) })
  const failed = await h.run(`${JSON.stringify(payload)}\n`)
  assert.notEqual(failed.code, 0)
  assert.equal(hits.length, 1)
  assert.equal(failed.stderr.includes('127.0.0.1'), false, 'failure message must not leak the webhook URL')
  await assert.rejects(readFile(`${h.keyFile}.delivered`), { code: 'ENOENT' })
  const retry = await h.run(`${JSON.stringify(payload)}\n`)
  assert.notEqual(retry.code, 0)
  assert.equal(hits.length, 2, 'ambiguous delivery must be retried, not swallowed')
  assert.ok(hits[0].body.includes(incidentId) && hits[1].body.includes(incidentId), 'retry keeps the same incident ID')
})

test('malformed, wrong-service and wrong-version payloads refuse without posting', async (t) => {
  const { hits, port } = await stubDiscord(t)
  const h = await harness(t, { webhookUrl: webhookFor(port) })
  const bad = ['not json\n', '{}\n',
    `${JSON.stringify({ ...payload, service: 'other' })}\n`,
    `${JSON.stringify({ ...payload, version: 2 })}\n`,
    `${JSON.stringify({ ...payload, incidentId: 'short' })}\n`,
    `${JSON.stringify({ ...payload, reasons: [] })}\n`,
    `${JSON.stringify({ ...payload, incidentId: 'd'.repeat(64) }).slice(0, 40)}\n`]
  for (const input of bad) {
    const result = await h.run(input)
    assert.notEqual(result.code, 0, `must refuse: ${input.trim().slice(0, 60)}`)
  }
  assert.equal(hits.length, 0, 'no invalid payload may reach the transport')
})

test('missing, public or non-Discord webhook file refuses without posting', async (t) => {
  const { hits, port } = await stubDiscord(t)
  const url = webhookFor(port)
  const missing = await harness(t, {})
  assert.notEqual((await missing.run(`${JSON.stringify(payload)}\n`)).code, 0)
  const pub = await harness(t, { webhookUrl: url, keyMode: 0o644 })
  assert.notEqual((await pub.run(`${JSON.stringify(payload)}\n`)).code, 0)
  const foreign = await harness(t, { webhookUrl: 'https://example.com/hook' })
  assert.notEqual((await foreign.run(`${JSON.stringify(payload)}\n`)).code, 0)
  assert.equal(hits.length, 0, 'no misconfigured run may reach the transport')
})

test('explicit webhook path via argv still refuses a public file without posting', async (t) => {
  const { hits, port } = await stubDiscord(t)
  const h = await harness(t, { webhookUrl: webhookFor(port), keyMode: 0o644 })
  const result = await new Promise(resolve => {
    const child = spawn(h.hook, [h.keyFile], { stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: h.home, LANG: 'C.UTF-8', DISCORD_ALERT_HOOK_ALLOW_HTTP_LOOPBACK: '1' } })
    let stderr = ''
    child.stderr.on('data', s => { stderr += s })
    child.stdin.on('error', () => {})
    child.on('close', code => resolve({ code, stderr }))
    child.stdin.end(`${JSON.stringify(payload)}\n`)
  })
  assert.notEqual(result.code, 0)
  assert.equal(hits.length, 0)
})
