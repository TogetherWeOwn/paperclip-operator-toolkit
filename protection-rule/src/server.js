#!/usr/bin/env node
// Host entrypoint. No embedded policy, approval identity or repository scope.
// The operator controls and reviews the configuration file and its parent path;
// a writable request/caller-selected file is NOT trusted configuration.
// Secrets travel by inherited environment, never argv and never in that JSON.
// Required: PROTECTION_RULE_CONFIG_FILE, PROTECTION_RULE_WEBHOOK_SECRET,
// PROTECTION_RULE_APP_ID, PROTECTION_RULE_KEY_FILE, PROTECTION_RULE_BOARD_TOKEN,
// PROTECTION_RULE_BOARD_ORIGIN. Optional: PROTECTION_RULE_PORT (loopback only).
// Exit 2 means configuration refused BEFORE serving; there is no degraded start.

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createApp } from './app.js'
import { validateTrustedConfig } from './environments.js'
import { validateBoardOrigin } from './board.js'

// readText is an offline test seam, not request input. Importing this module
// never binds a port, reads host inputs or invokes a transport.
export async function main(env = process.env, serve = null, readText = readFile) {
  for (const name of [
    'PROTECTION_RULE_CONFIG_FILE', 'PROTECTION_RULE_WEBHOOK_SECRET',
    'PROTECTION_RULE_APP_ID', 'PROTECTION_RULE_KEY_FILE',
    'PROTECTION_RULE_BOARD_TOKEN', 'PROTECTION_RULE_BOARD_ORIGIN',
  ]) {
    if (typeof env[name] !== 'string' || env[name].length === 0) {
      console.error(`protection-rule: ${name} is not set; refusing to start`)
      return 2
    }
  }
  const port = Number(env.PROTECTION_RULE_PORT ?? '8788')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('protection-rule: PROTECTION_RULE_PORT is invalid; refusing to start')
    return 2
  }
  let trustedConfig
  let app
  try {
    // Validate all authority configuration before reading the key or serving.
    trustedConfig = validateTrustedConfig(JSON.parse(await readText(env.PROTECTION_RULE_CONFIG_FILE, 'utf8')))
    validateBoardOrigin(env.PROTECTION_RULE_BOARD_ORIGIN)
    const appPrivateKey = await readText(env.PROTECTION_RULE_KEY_FILE, 'utf8')
    if (typeof appPrivateKey !== 'string' || !appPrivateKey.includes('PRIVATE KEY')) throw new Error('invalid key')
    app = createApp({
      webhookSecret: env.PROTECTION_RULE_WEBHOOK_SECRET,
      appId: env.PROTECTION_RULE_APP_ID,
      appPrivateKey,
      boardToken: env.PROTECTION_RULE_BOARD_TOKEN,
      boardOrigin: env.PROTECTION_RULE_BOARD_ORIGIN,
      trustedConfig,
    })
  } catch {
    // Never print configuration values, key bytes or parse errors containing them.
    console.error('protection-rule: configuration is unreadable or invalid; refusing to start')
    return 2
  }
  if (serve !== null) return serve({ app, port })
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const v of value) headers.append(name, v)
        } else if (value !== undefined) {
          headers.set(name, value)
        }
      }
      const url = `http://127.0.0.1:${port}${req.url ?? '/'}`
      app(new Request(url, {
        method: req.method ?? 'GET',
        headers,
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      })).then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        const bytes = new Uint8Array(await response.arrayBuffer())
        res.end(Buffer.from(bytes))
      }).catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":"internal"}\n')
      })
    })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  console.log(`protection-rule: serving ${trustedConfig.policies.length} configured environments on 127.0.0.1:${port}`)
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main()
  if (typeof code === 'number') process.exit(code)
}
