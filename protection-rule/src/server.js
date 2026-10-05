#!/usr/bin/env node
// Host entrypoint. Deliberately thin: reads private inputs from the inherited
// environment, binds them to `createApp`, and serves one port. Everything
// worth testing lives in modules the offline suite reaches without this file.
//
// Secrets travel by inherited environment, never argv: /proc/*/cmdline is
// world-readable and every company on a shared box shares the host. The port
// is the only non-secret configuration, and it defaults to loopback-safe.
//
// Required env:
//   PROTECTION_RULE_WEBHOOK_SECRET   App webhook secret (fail-closed when absent)
//   PROTECTION_RULE_APP_ID           GitHub App id for installation-token minting
//   PROTECTION_RULE_KEY_FILE         path to the App RSA key (0600, read once)
//   PROTECTION_RULE_BOARD_TOKEN      Paperclip credential for the CEO-GO scan
//   PROTECTION_RULE_BOARD_ORIGIN     board origin, e.g. https://board.example
//   PROTECTION_RULE_POLICIES_FILE    path to the operator-owned policy-table
//                                    JSON file (0600, read once; validated at
//                                    startup, entries are (repository,
//                                    environment, mode, goIssueId) objects)
//   PROTECTION_RULE_CEO_AGENT_ID     CEO agent UUID for the GO scan
// Optional env:
//   PROTECTION_RULE_PORT             listen port (default 8788)
//
// The protected scope — (repository, environment) pairs plus each pair's GO
// card — is operator-owned configuration, not code: it is read from
// PROTECTION_RULE_POLICIES_FILE and validated at startup. Adding an
// environment is a reviewed configuration change on purpose — scope that
// moves without review is how an approver starts approving the wrong thing.
// PROTECTION_RULE_ISSUE_ID is accepted and ignored (see app.js): a staged
// operator config that still sets it keeps starting instead of failing half
// the fleet.
//
// Exit codes: 0 served until signal, 2 configuration error. There is no third
// mode in which the server runs half-configured: a missing input is a refusal
// to start, not a degraded start.

import { readFile } from 'node:fs/promises'
import { createApp } from './app.js'

async function readKeyFile(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    console.error('protection-rule: App key file is unreadable; refusing to start')
    process.exit(2)
  }
  if (!text.includes('PRIVATE KEY')) {
    console.error('protection-rule: App key file holds no private key; refusing to start')
    process.exit(2)
  }
  return text
}

export async function main(env = process.env, serve = null) {
  const secret = env.PROTECTION_RULE_WEBHOOK_SECRET
  const appId = env.PROTECTION_RULE_APP_ID
  const keyFile = env.PROTECTION_RULE_KEY_FILE
  const boardToken = env.PROTECTION_RULE_BOARD_TOKEN
  const boardOrigin = env.PROTECTION_RULE_BOARD_ORIGIN
  const policiesFile = env.PROTECTION_RULE_POLICIES_FILE
  const ceoAgentId = env.PROTECTION_RULE_CEO_AGENT_ID
  const portRaw = env.PROTECTION_RULE_PORT ?? '8788'
  for (const [name, value] of [
    ['PROTECTION_RULE_WEBHOOK_SECRET', secret],
    ['PROTECTION_RULE_APP_ID', appId],
    ['PROTECTION_RULE_KEY_FILE', keyFile],
    ['PROTECTION_RULE_BOARD_TOKEN', boardToken],
    ['PROTECTION_RULE_BOARD_ORIGIN', boardOrigin],
    ['PROTECTION_RULE_POLICIES_FILE', policiesFile],
    ['PROTECTION_RULE_CEO_AGENT_ID', ceoAgentId],
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      console.error(`protection-rule: ${name} is not set; refusing to start`)
      return 2
    }
  }
  let policies
  try {
    policies = JSON.parse(await readFile(policiesFile, 'utf8'))
  } catch {
    console.error('protection-rule: policies file is unreadable or invalid; refusing to start')
    return 2
  }
  if (!Array.isArray(policies) || policies.length === 0) {
    console.error('protection-rule: policies file holds no policy table; refusing to start')
    return 2
  }
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('protection-rule: PROTECTION_RULE_PORT is invalid; refusing to start')
    return 2
  }
  const appPrivateKey = await readKeyFile(keyFile)
  let app
  try {
    app = createApp({
      webhookSecret: secret, appId, appPrivateKey, boardToken,
      boardOrigin, policies, ceoAgentId,
    })
  } catch {
    console.error('protection-rule: policy table or CEO identity is invalid; refusing to start')
    return 2
  }
  if (serve === null) {
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
    console.log(`protection-rule: serving ${policies.length} environments on 127.0.0.1:${port}`)
    return server
  }
  return serve({ app, port })
}

// Direct run only. Importing this module (tests, review tooling) must never
// bind a port or read the host environment.
import { pathToFileURL } from 'node:url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main()
  if (typeof code === 'number') process.exit(code)
}
