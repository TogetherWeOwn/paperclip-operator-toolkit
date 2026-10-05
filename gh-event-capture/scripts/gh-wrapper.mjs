#!/usr/bin/env node
// Versioned unattended `gh` wrapper source for the gh-product-bridge consumer.
//
// Mechanism binding: per-invocation GitHub App installation-token minting
// (unattended wrapper, no interactive login). Install: the operator copies THIS file to
// $SECURE/bin/gh (0700, user-owned) beside consumer.json; the runtime resolves
// it by absolute path, never through PATH (src/runtime-github.js pins it;
// preflight, init and every run refuse a missing/public/symlinked wrapper).
//
// Mechanism (a broker path is explicitly NOT approved for
// this): per-invocation GitHub App installation-token minting from a
// host-private PEM file. No agent lease, no run JWT, no PAPERCLIP_API_KEY, no
// imported GH_TOKEN/GITHUB_TOKEN, no expiring interactive login, no static
// token in the wrapper. The minted token lives only in the child process's
// environment (the one channel `gh` supports) and is never printed, cached to
// disk, or placed on argv (world-readable via /proc).
//
// Down-scope: the token request carries the consumer's repository allowlist
// (names only) plus { pull_requests: read, metadata: read } — the exact grants
// the read-only PR GraphQL queries in src/github-adapter.js need. The App's
// own grants are a ceiling: this narrows, never widens. Requesting more than
// the App holds is a GitHub-side error, not an escalation.
//
// argv/exit semantics: every argument after this program's own is forwarded
// verbatim to the real gh; the child's exit code is this process's exit code.
//
// Grant check (read-only, never `auth token` output): `gh grant-check
// <owner/name>` mints once and runs a first:1 open-PR GraphQL read against
// that repository. A JWT-shaped minted value is refused before any use.
import { execFile } from 'node:child_process'
import { readFile, lstat } from 'node:fs/promises'
import { createPrivateKey, createSign } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

const APP_ID_FILE = 'gh-app.id'
const PEM_FILE = 'gh-app.pem'
const INSTALL_FILE = 'gh-install.id'
const REAL_GH_FILE = 'gh-real.path'
const DEFAULT_REAL_GH = '/usr/bin/gh'
const APP_ID = '4685085'
const MINT_TIMEOUT_MS = 15000
const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
const GRANT_QUERY = `query BridgeGrantCheck($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequests(first: 1, states: [OPEN]) { totalCount }
  }
}`

function fail(code, message) {
  console.error(`gh-wrapper: ${message}`)
  process.exit(code)
}

function isJwtShaped(value) {
  return typeof value === 'string' && value.split('.').length === 3
}

async function privateFile(path, limit, label) {
  let info
  try {
    info = await lstat(path)
  } catch {
    fail(2, `${label} unavailable; inspect private file placement and permissions`)
  }
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 ||
      info.size <= 0 || info.size > limit) {
    fail(2, `${label} unavailable; inspect private file placement and permissions`)
  }
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    fail(2, `${label} unreadable; inspect private file placement and permissions`)
  }
}

async function resolveRealGh(secure) {
  let candidate = DEFAULT_REAL_GH
  // Test seam: GH_REAL_GH_FILE names a file holding the stand-in's absolute
  // path (one line), mirroring the gh-real.path override file. Passing a full
  // command line through env would reintroduce argv-splitting; the probe file
  // itself is executable (a #!/usr/bin/env node script), so a path suffices.
  // Production never sets it — the service units provide only PATH/HOME/LANG.
  if (process.env.GH_REAL_GH_FILE && !process.env.GH_REAL_GH_FILE.includes('\0')) {
    try {
      const seam = (await readFile(process.env.GH_REAL_GH_FILE, 'utf8')).trim()
      if (seam.startsWith('/') && !seam.includes('\0')) candidate = seam
    } catch {
      fail(2, 'test seam unreadable')
    }
  } else {
    try {
      const info = await lstat(join(secure, REAL_GH_FILE))
      if (info.isFile() && !info.isSymbolicLink()) {
        const override = (await readFile(join(secure, REAL_GH_FILE), 'utf8')).trim()
        if (override.startsWith('/') && !override.includes('\0')) candidate = override
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') fail(2, 'real gh override unreadable')
    }
  }
  try {
    const info = await lstat(candidate)
    if (!info.isFile() || (info.mode & 0o111) === 0) fail(2, 'real gh is not an executable file')
  } catch {
    fail(2, 'real gh is not installed at the pinned path')
  }
  return candidate
}

function appJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000)
  const b64url = (text) => Buffer.from(text).toString('base64url')
  const signing = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 480, iss: appId }))}`
  let key
  try {
    key = createPrivateKey(pem)
  } catch {
    fail(2, 'App signing key is not a usable PEM')
  }
  return `${signing}.${createSign('RSA-SHA256').update(signing).end().sign(key).toString('base64url')}`
}

async function api(base, path, { token, method = 'GET', body } = {}) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'gh-product-bridge-wrapper' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response
  try {
    response = await fetch(`${base}${path}`, { method, headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS) })
  } catch {
    fail(1, 'GitHub App minting transport failed; no token was issued to this invocation')
  }
  const text = await response.text()
  if (!response.ok) fail(1, `GitHub App minting refused (HTTP ${response.status}); no token was issued to this invocation`)
  try {
    return JSON.parse(text)
  } catch {
    fail(1, 'GitHub App minting returned an unreadable response; no token was used')
  }
}

async function mintToken({ secure, apiBase, repositories }) {
  const appId = await privateFile(join(secure, APP_ID_FILE), 32, 'App ID file')
  if (!/^[0-9]{1,19}$/.test(appId)) fail(2, 'App ID file is not a bare numeric ID')
  const pem = await privateFile(join(secure, PEM_FILE), 16384, 'App signing key file')
  if (!pem.includes('BEGIN') || !pem.includes('PRIVATE KEY')) fail(2, 'App signing key file is not a PEM')
  const jwt = appJwt(appId, pem)
  let installation
  try {
    const info = await lstat(join(secure, INSTALL_FILE))
    if (info.isFile() && (info.mode & 0o077) === 0 && info.uid === process.getuid() && info.size > 0 && info.size <= 32) {
      installation = (await readFile(join(secure, INSTALL_FILE), 'utf8')).trim()
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') fail(2, 'installation override unreadable')
  }
  if (installation !== undefined && !/^[0-9]{1,19}$/.test(installation)) fail(2, 'installation override is not a bare numeric ID')
  if (installation === undefined) {
    const list = await api(apiBase, '/app/installations', { token: jwt })
    if (!Array.isArray(list) || list.length !== 1 || !Number.isSafeInteger(list[0]?.id)) {
      fail(2, 'App installation is not uniquely discoverable; the Operator must pin it in gh-install.id')
    }
    installation = String(list[0].id)
  }
  const names = [...new Set(repositories.map((repo) => repo.split('/')[1]))].sort()
  const minted = await api(apiBase, `/app/installations/${installation}/access_tokens`, { token: jwt,
    method: 'POST', body: { repositories: names, permissions: { pull_requests: 'read', metadata: 'read' } } })
  const token = minted?.token
  if (typeof token !== 'string' || token.length === 0) fail(1, 'GitHub issued no token; nothing was executed')
  if (isJwtShaped(token)) fail(1, 'GitHub-issued credential has an unexpected shape; nothing was executed')
  return token
}

function runChild(file, args, env) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { shell: false, env }, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
      resolve(typeof error?.code === 'number' ? error.code : (error ? 1 : 0))
    })
    child.on('error', () => resolve(127))
  })
}

export async function main(argv = process.argv) {
  const invoked = argv[1] ? resolve(argv[1]) : null
  const secure = invoked ? dirname(dirname(invoked)) : null
  if (!secure) fail(2, 'wrapper location is not resolvable')
  // Fail closed on any inherited credential: this wrapper mints its own, and
  // an ambient token would silently substitute a foreign identity/grant set.
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    fail(2, 'inherited GH_TOKEN/GITHUB_TOKEN refused; the wrapper mints its own credential')
  }
  if (isJwtShaped(process.env.PAPERCLIP_API_KEY)) fail(2, 'agent run credential present; unattended path refuses it')
  const apiBase = process.env.GH_API_URL || 'https://api.github.com'
  const args = argv.slice(2)
  if (args[0] === 'grant-check') {
    if (args.length !== 2 || !REPOSITORY_RE.test(args[1])) {
      fail(2, 'usage: gh grant-check <owner/name>')
    }
    const token = await mintToken({ secure, apiBase, repositories: [args[1]] })
    const env = { ...process.env, GH_TOKEN: token }
    delete env.GITHUB_TOKEN
    delete env.PAPERCLIP_API_KEY
    delete env.PAPERCLIP_RUN_ID
    const code = await runChild(await resolveRealGh(secure),
      ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${GRANT_QUERY}`,
        '-f', `owner=${args[1].split('/')[0]}`, '-f', `name=${args[1].split('/')[1]}`],
      env)
    if (code !== 0) fail(1, 'read-only PR grant check failed; the grant is not established')
    return 0
  }
  // The down-scope allowlist comes from the consumer config beside this
  // wrapper (the service units provide only PATH/HOME/LANG, never the
  // allowlist), never from argv. This keeps one binding source per install.
  let allowlist = []
  try {
    const consumer = JSON.parse(await readFile(join(secure, 'consumer.json'), 'utf8'))
    if (Array.isArray(consumer.allowedRepositories)) allowlist = consumer.allowedRepositories
  } catch {
    fail(2, 'consumer allowlist unreadable; inspect consumer.json beside the wrapper')
  }
  if (allowlist.length === 0 || !allowlist.every((repo) => typeof repo === 'string' && REPOSITORY_RE.test(repo))) {
    fail(2, 'consumer allowlist is missing or invalid; inspect consumer.json beside the wrapper')
  }
  const token = await mintToken({ secure, apiBase, repositories: allowlist })
  const env = { ...process.env, GH_TOKEN: token }
  delete env.GITHUB_TOKEN
  delete env.PAPERCLIP_API_KEY
  delete env.PAPERCLIP_RUN_ID
  process.exitCode = await runChild(await resolveRealGh(secure), args, env)
  return process.exitCode
}

if (import.meta.url === new URL(`file://${resolve(process.argv[1] ?? '')}`).href) {
  process.exitCode = await main(process.argv)
}
