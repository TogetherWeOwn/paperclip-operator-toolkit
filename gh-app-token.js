#!/usr/bin/env node
// Mints short-lived GitHub App installation tokens on demand.
//
// ---------------------------------------------------------------------------
// CLIENT OF: plugins/gh-token-broker
//
// This file used to be the thing the broker was going to replace. As of the
// broker cutover it is instead the broker's client: `credential` mode asks the control plane
// for a token, and the PEM path below is the fallback, not the default.
//
// That inversion is the whole cutover. Previously the plan had a removal half
// and no replacement half — unbinding GH_APP_PRIVATE_KEY from an agent did not
// move it to the broker, it just took away its ability to use git, because
// nothing had ever pointed the host gitconfig's credential helper at the
// broker. Now the unbind is the *last* step rather than the leap: every agent
// exercises the broker on ordinary git traffic first (GH_APP_TOKEN_SOURCE=auto,
// broker-first), and the unbind only removes a fallback that has already stopped
// being used.
//
// Why the PEM path is going away: every mode below that uses it begins by
// reading GH_APP_PRIVATE_KEY out of this process's own environment. That is the
// exposure, not an implementation detail — any same-uid process can
// read the PEM from /proc, so binding the key per-agent is not a boundary. The
// broker keeps the key behind the host: the agent asks for a token and only a
// short-lived, repo-scoped one crosses back.
//
// The down-scoping this file does (GH_APP_REPOS / GH_APP_PERMISSIONS, below) is
// the right idea and the broker keeps it — but here it is VOLUNTARY. This
// process holds the PEM, so anything that can run it can also decline to
// narrow. In the broker the scope is derived server-side from the issue the
// caller demonstrably holds, and a caller may only narrow it further.
//
// Removal of the PEM path is gated on unbinding GH_APP_PRIVATE_KEY from the
// remaining agents — not on this file becoming
// unused-looking.
// ---------------------------------------------------------------------------
//
// No daemon, no rotation, no long-lived stored token. Modes:
//   gh-app-token.js            -> print a fresh installation token to stdout
//   gh-app-token.js credential -> speak git's credential-helper protocol on stdin/stdout
//   gh-app-token.js doctor     -> report the permissions GitHub actually granted
//   gh-app-token.js scope      -> mint, then report the token's EFFECTIVE scope (not the ceiling)
//   gh-app-token.js scope-check-> report whether strict mode accepts this env; MINTS NOTHING
//   gh-app-token.js verify     -> mint and assert least-privilege; non-zero exit if violated
//
// --- Where the credential comes from -----------------------------------------
//
// Two ways to obtain a token:
//
//   broker  The gh-token-broker plugin mints it in the control plane. The App
//           PEM is resolved inside the host process and never crosses into this
//           address space. Scope is derived server-side from the issue the
//           caller demonstrably holds; this process can only ever narrow it.
//   pem     This process signs an App JWT with GH_APP_PRIVATE_KEY and mints
//           directly. The older path: the raw signing key is in our env,
//           and therefore in /proc, readable by every same-uid agent.
//
//   GH_APP_TOKEN_SOURCE  auto (default) | broker | pem
//
//     auto    Broker first; fall back to the PEM, loudly on stderr, if the
//             broker cannot answer. This is the transition setting. Broker-first
//             is the point: every agent exercises the broker on ordinary git
//             traffic *before* its PEM is unbound, so the unbind stops being the
//             moment anyone finds out whether the broker works for them.
//     broker  Broker only, no fallback. The post-cutover setting. Once an
//             agent's GH_APP_PRIVATE_KEY is unbound, pinning this makes a broker
//             failure report as a broker failure, rather than as a confusing
//             "GH_APP_PRIVATE_KEY is not set".
//     pem     PEM only. Escape hatch if the broker is down.
//
// Config (env):
//   GH_APP_ID                 required for the PEM path  numeric App ID (JWT `iss`)
//   GH_APP_PRIVATE_KEY        required for the PEM path  PEM. Literal newlines or \n-escaped both work.
//   GH_APP_ORG                optional  org to resolve the installation from (default: sole installation)
//   GH_APP_INSTALL_ID         optional  skip discovery entirely
//   GH_APP_TOKEN_CACHE        optional  cache path (default: $PAPERCLIP_RUN_SCRATCH_DIR/.gh-app-token.json)
//   GH_APP_BROKER_URL         optional  control-plane base (default: $PAPERCLIP_API_URL)
//   GH_APP_BROKER_PLUGIN      optional  plugin key (default: gh-token-broker)
//   GH_APP_BROKER_TIMEOUT_MS  optional  hard timeout per broker attempt (default: 60000)
//   GH_APP_BROKER_RETRIES     optional  retries after a transient broker failure (default: 1)
//   GH_APP_BROKER_RETRY_DELAY_MS optional  delay before each retry (default: 1000)
//
// The broker is a control-plane plugin RPC, not a separate daemon, so
// it queues behind whatever else is loading the host. The old 10000ms default
// was one sample of a noisy queue: under host load (observed loadavg ~24 on an
// 8-way box) a broker call that would have succeeded at 90000ms timed out at
// 10000ms and reported itself as an "unreachable" outage. 60000ms plus one
// retry covers that queueing without hanging forever; a genuine broker outage
// still fails closed, just after a bounded couple of attempts instead of one.
//
// The broker path additionally reads PAPERCLIP_API_URL, PAPERCLIP_API_KEY,
// PAPERCLIP_TASK_ID and PAPERCLIP_RUN_ID, all of which the runtime already
// projects into every agent run.
//
// Down-scoping. An installation token defaults to EVERY permission the App
// declares on EVERY repo it can see. That default is the blast radius, so it is worth
// narrowing at mint time even when the App itself is over-granted:
//   GH_APP_REPOS        optional  comma-separated repo names (not owner/name) to scope the token to
//   GH_APP_PERMISSIONS  optional  comma-separated k=v, e.g. contents=write,issues=write
//   GH_APP_SCOPE_STRICT optional  set to 1 to require BOTH of the above; refuses to mint otherwise
// Equivalent flags: --repos a,b  --permissions contents=write,metadata=read
//
// GH_APP_SCOPE_STRICT=1 requires BOTH halves as of 2026-08-24. It used
// to accept either one, which meant a permissions-only scope passed strict mode
// while still minting across every repo in the installation. Note where the repo
// half comes from in this deployment: GH_APP_REPOS is projected from the PROJECT
// an issue belongs to, so a project-less issue has no value to inherit and no
// workspace repo URL to fall back on either — both sources are null together.
// Enabling strict mode therefore fails closed for project-less runs BY DESIGN;
// sweep them with `scope-check` first.
//
// It gates the PEM path, not the broker path — including the `auto` fallback,
// which is the case that matters. The broker bounds scope server-side and
// refuses to mint when it cannot derive one, so an empty LOCAL scope on a
// broker mint is still bounded; the PEM has no such backstop, and `auto`
// reaches it during any retryable broker failure. Gating on GH_APP_TOKEN_SOURCE
// alone would leave strict mode switched off for the default setting on exactly
// the path that mints a ceiling token.
//
// The App's own grants are a hard ceiling: a requested scope can only ever subtract.
// Requesting a permission the App lacks is an error from GitHub, not an escalation.
// On the broker path the ceiling is tighter still, and is enforced server-side.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const API = process.env.GH_API_URL || 'https://api.github.com'
const SKEW = 60           // clock-skew backdate on the JWT, seconds
const LIFETIME = 480      // exp offset; exp-iat = 540, under GitHub's hard 600 ceiling
const REFRESH_FLOOR = 300 // re-mint when under 5 min of life remains

const BROKER_PLUGIN = process.env.GH_APP_BROKER_PLUGIN || 'gh-token-broker'

// Same shape as `Number(env) > 0 ? Number(env) : default`, but allows 0 as an
// explicit override (GH_APP_BROKER_RETRIES=0 means "never retry").
function numEnv(name, def, { min = 0 } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  return Number.isFinite(n) && n >= min ? n : def
}

const BROKER_TIMEOUT = numEnv('GH_APP_BROKER_TIMEOUT_MS', 60000, { min: 1 })
const BROKER_RETRIES = numEnv('GH_APP_BROKER_RETRIES', 1, { min: 0 })
const BROKER_RETRY_DELAY_MS = numEnv('GH_APP_BROKER_RETRY_DELAY_MS', 1000, { min: 0 })

const SOURCES = ['auto', 'broker', 'pem']
const SOURCE = (process.env.GH_APP_TOKEN_SOURCE || 'auto').trim().toLowerCase()

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex')

// Set once we have decided this process owns the answer to a git credential
// request. It changes what `die` has to do — see below.
let owningCredentialRequest = false

// Non-zero while a lookup the caller has declared OPTIONAL is running. See
// bestEffort().
let bestEffortDepth = 0

function die(msg) {
  // Inside a bestEffort() window this throws instead of exiting, so the caller's
  // catch is real. It does NOT soften any refusal: nothing is minted either way,
  // and the refusal text travels out on the thrown error for the caller to
  // report. Outside such a window `die` is unchanged — it exits.
  if (bestEffortDepth > 0) throw new Error(msg)
  process.stderr.write(`gh-app-token: ${msg}\n`)
  if (owningCredentialRequest) {
    // git discards a credential helper's exit status. Without this line it would
    // carry on to the next helper and then to its own prompt, and the last thing
    // on the terminal would be git's opaque `could not read Username` — so
    // anything capturing only the tail of the output sees an unattributable auth
    // failure and the `gh-app-token:` line above is merely advisory.
    //
    // `quit=1` makes git abandon the whole credential lookup and die with
    // "credential helper '<us>' told us to quit", which names the failing
    // component in the final visible line. Verified against git 2.47.3; the
    // field has been understood since 1.7.9.
    //
    // Note this also suppresses any credential helper configured after us. We
    // are the last helper for github.com in the host gitconfig (the empty
    // `helper =` there resets the list first), and we only get here for hosts we
    // have already claimed, so nothing else is entitled to answer.
    process.stdout.write('quit=1\n')
  }
  process.exit(1)
}

// Run a lookup whose failure must not take the whole command down, and let the
// caller see why it failed.
//
// This exists because `die()` calls process.exit, so a plain try/catch around
// anything that can reach it is INERT — the process is gone before the catch
// runs. `doctor` had exactly that shape: a git-identity lookup commented
// "best-effort: a failure here must not fail the permission report", wrapped in
// a catch that could never fire, which killed the entire permission report in
// every environment running GH_APP_SCOPE_STRICT=1. A comment is not
// a mechanism. This is the mechanism.
async function bestEffort(fn) {
  bestEffortDepth++
  try {
    return await fn()
  } finally {
    bestEffortDepth--
  }
}

// --- credential material -----------------------------------------------------

function pem() {
  const raw = process.env.GH_APP_PRIVATE_KEY
  if (!raw) return null
  // Secret stores frequently flatten PEMs to a single \n-escaped line.
  const value = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw
  return value.includes('BEGIN') ? value : null
}

function privateKey() {
  const value = pem()
  if (!value) {
    die(
      process.env.GH_APP_PRIVATE_KEY
        ? 'GH_APP_PRIVATE_KEY does not look like a PEM'
        : 'GH_APP_PRIVATE_KEY is not set'
    )
  }
  return value
}

// A stable identifier for the credential that minted a token, safe to write to
// disk. See `cached()` for why this exists at all.
function pemFingerprint() {
  const value = pem()
  if (!value) return null
  try {
    // The *public* half of the key, not the key. A rotated PEM yields a
    // different fingerprint and a withdrawn one yields none, which is all the
    // cache needs — while the value written to disk discloses nothing, which a
    // digest of the PEM itself would not quite manage.
    const spki = crypto.createPublicKey(value).export({ type: 'spki', format: 'der' })
    return `pem:${sha256(Buffer.concat([spki, Buffer.from(`|${process.env.GH_APP_ID || ''}`)])).slice(0, 16)}`
  } catch {
    return null
  }
}

function brokerFingerprint() {
  const cfg = brokerConfig()
  if (!cfg.ok) return null
  // One-way over the bearer key, so rotating or unbinding PAPERCLIP_API_KEY
  // invalidates anything it minted. Domain-separated and truncated, and it is
  // only ever written into per-run scratch.
  return `broker:${sha256(`gh-app-token.v1|${cfg.base}|${cfg.key}`).slice(0, 16)}`
}

// Every credential this process can currently present. Order is preference
// order; membership is what the cache checks.
function availableCredentials() {
  const out = []
  if (SOURCE !== 'pem') {
    const broker = brokerFingerprint()
    if (broker) out.push(broker)
  }
  if (SOURCE !== 'broker') {
    const key = pemFingerprint()
    if (key) out.push(key)
  }
  return out
}

// --- scope -------------------------------------------------------------------
// Parsed once from flags-then-env so a caller can override a binding-level default.

function flag(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null
}

function parsePermissions(spec) {
  const out = {}
  for (const pair of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = pair.split('=').map((s) => (s || '').trim())
    if (!k || !v) die(`--permissions expects k=v pairs, got "${pair}"`)
    if (!['read', 'write', 'admin'].includes(v)) {
      die(`permission level for "${k}" must be read|write|admin, got "${v}"`)
    }
    out[k] = v
  }
  return out
}

// What strict mode requires, as data, so `scope-check` can report the same
// verdict `currentScope()` enforces without minting to find out.
//
// BOTH halves are required, and the repository half is the load-bearing one.
// Until 2026-08-24 this was an OR: a scope carrying only GH_APP_PERMISSIONS
// satisfied strict mode, so `GH_APP_SCOPE_STRICT=1` passed while the token
// still spanned every repo in the installation. That is the entire
// blast radius down-scoping exists to remove, so strict mode was not strict — it
// only constrained the axis that was already the cheaper one to constrain.
// An unbounded repo set is not a lesser finding than an unbounded permission
// set; `repository_selection: all` is what turns one compromised token into
// org-wide reach.
function strictGaps(scope) {
  const gaps = []
  if (!scope.repositories) gaps.push('GH_APP_REPOS (or --repos) — without it the token spans EVERY repo in the installation')
  if (!scope.permissions) gaps.push('GH_APP_PERMISSIONS (or --permissions) — without it the token carries every permission the App holds')
  return gaps
}

// Strict mode is a statement about the PEM path only: the broker derives scope
// server-side from the issue the caller demonstrably holds and refuses to mint
// when it cannot, so a locally-empty scope on a broker mint is bounded
// even though nothing local says so.
//
// But "PEM path" is NOT the same question as GH_APP_TOKEN_SOURCE === 'pem'.
// Under the default `auto`, a retryable broker failure falls back to the raw
// signing key — so gating on the startup value of SOURCE leaves strict mode
// unenforced on exactly the path that mints a ceiling token. This is called at
// the moment the PEM is actually used, which covers `pem` and the `auto`
// fallback alike. A strict flag that lapses during a broker outage is the same
// bug fixed for the startup setting above, one layer down.
function assertStrictForPem(scope) {
  if (process.env.GH_APP_SCOPE_STRICT !== '1') return
  const gaps = strictGaps(scope)
  if (!gaps.length) return
  die(
    'GH_APP_SCOPE_STRICT=1 requires BOTH a repository scope and a permission set. Missing:\n' +
      gaps.map((g) => `  - ${g}`).join('\n') +
      '\nRefusing to mint with GH_APP_PRIVATE_KEY rather than issuing a broader token\n' +
      'than strict mode implies.\n' +
      'Fix: pin GH_APP_REPOS on the project this issue belongs to, or pass --repos.\n' +
      'Run `gh-app-token.js scope-check` to see this verdict without minting.'
  )
}

// Normalised so two spellings of the same scope share one cache entry, and two
// different scopes never do. The latter is the load-bearing half: without it a
// narrow request could be served a cached ceiling token, which would be a silent
// privilege escalation introduced by the cache.
function currentScope({ enforce = true } = {}) {
  const reposSpec = flag('--repos') || process.env.GH_APP_REPOS || ''
  const permsSpec = flag('--permissions') || process.env.GH_APP_PERMISSIONS || ''
  const repositories = reposSpec.split(',').map((s) => s.trim()).filter(Boolean).sort()
  const permissions = permsSpec ? parsePermissions(permsSpec) : null
  const scope = {}
  // Note both halves are set only when non-empty, so GH_APP_REPOS="" and
  // GH_APP_REPOS=" , " are indistinguishable from unset — deliberately. A
  // present-but-empty value is how this reaches most environments (the
  // projection writes the key whether or not the project pinned a value), and
  // treating "set to nothing" as "scoped" would reopen the hole under a
  // spelling that looks configured.
  if (repositories.length) scope.repositories = repositories
  if (permissions && Object.keys(permissions).length) {
    scope.permissions = Object.fromEntries(Object.entries(permissions).sort(([a], [b]) => (a < b ? -1 : 1)))
  }
  // Enforced early whenever the PEM is reachable at all — `pem` AND the default
  // `auto`, which falls back to it on a broker outage. Early matters: token()
  // consults the cache BEFORE acquire(), so a check that lived only at mint time
  // would still hand back a previously cached ceiling token under strict mode.
  // Only GH_APP_TOKEN_SOURCE=broker is exempt, because there the scope is
  // derived and enforced server-side and no local value can widen it.
  if (enforce && SOURCE !== 'broker') assertStrictForPem(scope)
  return scope
}

const scopeId = (scope) =>
  Object.keys(scope).length === 0
    ? 'ceiling'
    : crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 12)

// --- github ------------------------------------------------------------------

async function gh(url, { token, method = 'GET', body } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'untended-gh-app-token',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) die(`${method} ${url} -> ${res.status} ${res.statusText}\n${text.slice(0, 600)}`)
  return JSON.parse(text)
}

// Discovery keeps human config down to App ID + PEM. One less field to paste wrong.
async function installationId(jwt) {
  if (process.env.GH_APP_INSTALL_ID) return process.env.GH_APP_INSTALL_ID
  const org = process.env.GH_APP_ORG
  if (org) return String((await gh(`/orgs/${org}/installation`, { token: jwt })).id)
  const list = await gh('/app/installations', { token: jwt })
  if (list.length === 1) return String(list[0].id)
  die(
    list.length === 0
      ? 'App has no installations. Install it on the org first.'
      : `App has ${list.length} installations; set GH_APP_ORG or GH_APP_INSTALL_ID.`
  )
}

// App JWT: proves we are the App. GitHub rejects exp-iat > 600, so stay under it.
function appJwt() {
  const appId = process.env.GH_APP_ID
  if (!appId) die('GH_APP_ID is not set')
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat: now - SKEW, exp: now + LIFETIME, iss: appId }))
  const signing = `${header}.${payload}`
  let sig
  try {
    sig = crypto.createSign('RSA-SHA256').update(signing).end().sign(privateKey())
  } catch (e) {
    die(`could not sign JWT with GH_APP_PRIVATE_KEY: ${e.message}`)
  }
  return `${signing}.${b64url(sig)}`
}

// --- broker ------------------------------------------------------------------

class BrokerError extends Error {
  // `retryable` distinguishes "the broker could not answer" from "the broker
  // answered no". Only the former is worth falling back to the PEM for.
  //
  // `transient` is a narrower question: is THIS SAME broker call worth
  // attempting again, same credential, no fallback? A timeout or a 5xx is —
  // that is the noisy-queue case the same-call retry exists for. A 404 (route/plugin
  // absent) is retryable-to-PEM but not transient: the route will not appear
  // a second later, so retrying it only adds latency to a case that was never
  // going to change without different config or without the PEM anyway.
  constructor(message, { status = 0, retryable = false, transient = false } = {}) {
    super(message)
    this.name = 'BrokerError'
    this.status = status
    this.retryable = retryable
    this.transient = transient
  }
}

const normaliseBase = (url) => String(url).replace(/\/+$/, '').replace(/\/api$/, '')

function brokerConfig() {
  const base = process.env.GH_APP_BROKER_URL || process.env.PAPERCLIP_API_URL
  const key = process.env.PAPERCLIP_API_KEY
  const issueId = process.env.GH_APP_BROKER_ISSUE || process.env.PAPERCLIP_TASK_ID

  const missing = []
  if (!base) missing.push('PAPERCLIP_API_URL')
  if (!key) missing.push('PAPERCLIP_API_KEY')
  if (!issueId) missing.push('PAPERCLIP_TASK_ID')
  if (missing.length) return { ok: false, missing }

  return {
    ok: true,
    base: normaliseBase(base),
    key,
    issueId,
    runId: process.env.PAPERCLIP_RUN_ID || null,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A single attempt against an already-resolved broker config. Split out of
// mintViaBroker() so a retry re-issues the HTTP call without re-checking
// config or re-deriving the URL each time.
async function mintViaBrokerOnce(cfg, scope) {
  const url =
    `${cfg.base}/api/plugins/${encodeURIComponent(BROKER_PLUGIN)}` +
    `/api/issues/${encodeURIComponent(cfg.issueId)}/github-token`

  const headers = {
    Authorization: `Bearer ${cfg.key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'gh-app-token',
  }
  // The run lock the checkout policy asserts against. Under an agent JWT the
  // host derives the run itself and ignores this; under an agent API key it is
  // how the run is identified.
  if (cfg.runId) headers['X-Paperclip-Run-Id'] = cfg.runId

  // The broker derives the repo and permission ceiling server-side from the
  // issue. Anything sent here can only narrow that ceiling — the broker rejects
  // a request outside it — so forwarding the local scope cannot widen anything.
  const body = {}
  if (scope.repositories) body.repositories = scope.repositories
  if (scope.permissions) body.permissions = scope.permissions

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // Never hang forever. A stalled control plane must still fail the git
      // operation within a bounded time; mintViaBroker() below is what makes
      // that bound "a couple of timeouts", not "one sample of a noisy queue".
      signal: AbortSignal.timeout(BROKER_TIMEOUT),
    })
  } catch (e) {
    // A timeout under host-load queueing and an actually-unreachable
    // endpoint (DNS/connection failure) read the same to `fetch`, but only the
    // former has a documented knob — name it so the next agent has the
    // workaround in hand instead of drafting a "the broker is down" report.
    if (e && e.name === 'TimeoutError') {
      throw new BrokerError(
        `broker timed out (no response in ${BROKER_TIMEOUT}ms; raise with GH_APP_BROKER_TIMEOUT_MS if the host is under load)`,
        { retryable: true, transient: true }
      )
    }
    throw new BrokerError(`broker unreachable (${(e && e.message) || String(e)})`, { retryable: true, transient: true })
  }

  const text = await res.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    /* handled below */
  }

  if (!res.ok) {
    const detail = (payload && payload.error) || text.slice(0, 300).replace(/\s+/g, ' ').trim()
    // 404 (plugin not installed / route absent) and 5xx (broker down) mean the
    // broker could not answer. 401/403/409 mean it answered, and the answer was
    // no — a definitive refusal must not be retried with the bigger credential.
    const retryable = res.status === 404 || res.status >= 500
    // Only 5xx is worth retrying against the SAME broker call: it is the
    // "temporarily struggling" signal. A 404 is a stable fact about this
    // deployment (route/plugin absent) that a same-second retry cannot fix —
    // retrying it only delays the PEM fallback `retryable` already allows.
    throw new BrokerError(`broker refused (${res.status}: ${detail})`, {
      status: res.status,
      retryable,
      transient: res.status >= 500,
    })
  }

  if (!payload || typeof payload.token !== 'string' || !payload.token) {
    throw new BrokerError('broker returned no token', { status: res.status, retryable: false })
  }

  return {
    token: payload.token,
    expires_at: payload.expiresAt || payload.expires_at || null,
    permissions: payload.permissions || {},
    repositories: payload.repositories || [],
    // The broker refuses to mint without a repository scope, so anything it
    // returns is scoped by construction.
    repository_selection: 'selected',
    via: 'broker',
  }
}

// One 10s (now 60s) sample of a noisy queue was being reported as an
// outage. Retries here are for the SAME credential, no fallback yet — only
// `transient` failures (timeout, connection error, 5xx) qualify; a definitive
// refusal or a stable 404 is not retried, so this never turns an authorization
// "no" into a slower "no", and never delays the PEM fallback for a failure mode
// retrying can't fix.
async function mintViaBroker(scope) {
  const cfg = brokerConfig()
  if (!cfg.ok) {
    // Not configured is not the same as broken: in `auto` this is exactly the
    // case where the PEM should still be tried. Nothing to retry — no request
    // was even attempted.
    throw new BrokerError(`broker not configured (${cfg.missing.join(', ')} unset)`, { retryable: true })
  }

  const attempts = BROKER_RETRIES + 1
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await mintViaBrokerOnce(cfg, scope)
    } catch (e) {
      if (!(e instanceof BrokerError) || !e.transient || attempt === attempts) throw e
      process.stderr.write(
        `gh-app-token: ${e.message} (attempt ${attempt}/${attempts}); retrying in ${BROKER_RETRY_DELAY_MS}ms...\n`
      )
      await sleep(BROKER_RETRY_DELAY_MS)
    }
  }
}

// --- cache -------------------------------------------------------------------

// No os.tmpdir() fallback. PAPERCLIP_RUN_SCRATCH_DIR is per-run and
// reaped; os.tmpdir() is neither. Every agent on this host runs as the same
// uid, so mode 0600 separates nothing between agents: a token file in
// /tmp is readable by every other agent and outlives the run that minted it.
// If there is nowhere run-scoped to write, run cache-less instead.
function cachePath(scope) {
  const id = scopeId(scope)
  const explicit = process.env.GH_APP_TOKEN_CACHE
  if (explicit) {
    // Keep the caller's path but keep scopes in separate files under it.
    return id === 'ceiling' ? explicit : `${explicit}.${id}`
  }
  const dir = process.env.PAPERCLIP_RUN_SCRATCH_DIR
  if (!dir) return null
  return path.join(dir, id === 'ceiling' ? '.gh-app-token.json' : `.gh-app-token.${id}.json`)
}

function cached(scope) {
  const p = cachePath(scope)
  if (!p) return null
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'))

    // A past defect in this check: it used to be `c.appId !== GH_APP_ID`, which
    // never consulted the credential at all: an agent whose PEM had been
    // unbound but which still had GH_APP_ID bound — precisely the intended
    // post-unbind state — kept authenticating from cache for the remaining life
    // of the token. Validity is now keyed on the credential that actually
    // minted the entry, so withdrawing that credential invalidates it.
    //
    // A record with no `cred` predates this and cannot be attributed to any
    // credential we still hold, so it is refused. Unlike the `scopeId`
    // migration below there is no safe default to read it as.
    if (!c.cred || !availableCredentials().includes(c.cred)) return null

    // Belt and braces: the filename already separates scopes, but a stale or
    // hand-edited cache must never hand back a token wider than was asked for.
    // A cache written before down-scoping existed has no scopeId and can only
    // ever have held a ceiling token, so read it as such rather than discarding it.
    if ((c.scopeId || 'ceiling') !== scopeId(scope)) return null
    if ((Date.parse(c.expires_at) - Date.now()) / 1000 < REFRESH_FLOOR) return null
    return c.token
  } catch {
    return null
  }
}

function store(result, scope, cred) {
  const p = cachePath(scope)
  if (!p) {
    process.stderr.write(
      'gh-app-token: no PAPERCLIP_RUN_SCRATCH_DIR and no GH_APP_TOKEN_CACHE; not caching ' +
        '(refusing to write a token where it would outlive this run and be readable by other agents)\n'
    )
    return
  }
  // Without an expiry there is no way to know when the entry stops being valid,
  // and a token that is trusted forever is worse than no cache.
  if (!result.expires_at || Number.isNaN(Date.parse(result.expires_at))) return
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({
        token: result.token,
        expires_at: result.expires_at,
        cred,
        via: result.via,
        appId: process.env.GH_APP_ID || null, // diagnostic only; `cred` is the check
        scopeId: scopeId(scope),
        scope,
        granted: {
          permissions: result.permissions || {},
          repository_selection: result.repository_selection,
          repositories: result.repositories || [],
        },
      }),
      { mode: 0o600 }
    )
    // writeFileSync's mode applies only when it creates the file, so an existing
    // entry with looser permissions would keep them.
    fs.chmodSync(p, 0o600)
  } catch {
    // Cache is an optimisation; minting still works without it.
  }
}

// Returns { token, permissions, repository_selection, repositories } for the mint.
// The `granted` fields come from GitHub's response, so they describe the token that
// actually exists rather than the one that was asked for.
async function mintViaPem(scope) {
  // Last gate before the signing key is used, and the only one the `auto`
  // broker-outage fallback passes through. Before appJwt(), so a strict refusal
  // costs no signature and no network call.
  assertStrictForPem(scope)
  const jwt = appJwt()
  const id = await installationId(jwt)
  const body = Object.keys(scope).length ? scope : undefined
  const res = await gh(`/app/installations/${id}/access_tokens`, { token: jwt, method: 'POST', body })
  return {
    token: res.token,
    expires_at: res.expires_at,
    permissions: res.permissions || {},
    repository_selection: res.repository_selection || (scope.repositories ? 'selected' : 'all'),
    repositories: (res.repositories || []).map((r) => r.name),
    via: 'pem',
  }
}

// Mint a fresh token from whichever credential GH_APP_TOKEN_SOURCE allows, and
// cache it against that credential. Never reads the cache — `token()` does that.
async function acquire(scope) {
  if (SOURCE === 'pem') {
    const result = await mintViaPem(scope)
    store(result, scope, pemFingerprint())
    return result
  }

  let brokerError
  try {
    const result = await mintViaBroker(scope)
    store(result, scope, brokerFingerprint())
    return result
  } catch (e) {
    if (!(e instanceof BrokerError)) throw e
    brokerError = e
  }

  if (SOURCE === 'broker') {
    die(`${brokerError.message}. GH_APP_TOKEN_SOURCE=broker, so there is no fallback.`)
  }

  // auto
  if (!brokerError.retryable) {
    die(
      `${brokerError.message}. This is a definitive refusal, not an outage, so the ` +
        'GH_APP_PRIVATE_KEY fallback is deliberately not attempted.'
    )
  }
  if (!pem()) {
    die(`${brokerError.message}; and GH_APP_PRIVATE_KEY is not set, so there is no fallback.`)
  }
  process.stderr.write(
    `gh-app-token: ${brokerError.message}; falling back to GH_APP_PRIVATE_KEY. ` +
      'This agent is still minting with the raw signing key.\n'
  )
  const result = await mintViaPem(scope)
  store(result, scope, pemFingerprint())
  return result
}

async function token(scope) {
  const sc = scope || currentScope()
  const hit = cached(sc)
  if (hit) return hit
  return (await acquire(sc)).token
}

// --- main --------------------------------------------------------------------

async function main() {
  const mode = process.argv[2]

  if (!SOURCES.includes(SOURCE)) {
    die(`GH_APP_TOKEN_SOURCE must be one of ${SOURCES.join(' | ')}, got "${SOURCE}"`)
  }

  if (mode === 'credential') {
    // git speaks: <verb> on argv[3], then key=value lines on stdin.
    // Only `get` needs an answer. `store`/`erase` are no-ops: nothing is persisted
    // that outlives the run, so there is nothing to store or erase.
    if (process.argv[3] !== 'get') return
    let stdin = ''
    try {
      stdin = fs.readFileSync(0, 'utf8')
    } catch {
      // git may close stdin without writing; treat as no constraints.
    }
    const host = (stdin.match(/^host=(.*)$/m) || [])[1]
    // Not ours: stay silent so any other helper still gets its turn. In
    // particular do NOT emit `quit=1` here.
    if (host && host !== 'github.com' && !host.endsWith('.github.com')) return

    // From here this process owns the answer, so a failure has to be terminal and
    // attributable rather than a fall-through to git's own prompt. See `die`.
    owningCredentialRequest = true
    // Scope comes from the environment here: git controls the argv, so per-agent
    // narrowing has to be configurable without touching this file.
    process.stdout.write(`username=x-access-token\npassword=${await token()}\n`)
    return
  }

  // Preflight for the strict-mode rollout. `scope` and `verify` both MINT to report
  // the effective scope, which makes them useless for sweeping environments that
  // are about to start failing: you cannot ask "would strict mode reject this
  // agent?" by issuing a credential in it. This answers from configuration
  // alone — no JWT, no network, no token, no cache read — so it is safe to run
  // across every agent environment before flipping strict mode on.
  //
  // Exit 0 = this environment survives hardened strict mode. Exit 1 = it does
  // not, and the gaps say which half is missing.
  if (mode === 'scope-check') {
    const scope = currentScope({ enforce: false })
    const gaps = strictGaps(scope)
    const strict = process.env.GH_APP_SCOPE_STRICT === '1'
    // Strict gates the PEM path only, so on GH_APP_TOKEN_SOURCE=broker the gaps
    // are informational: the broker bounds scope server-side. Under `auto` they
    // are NOT informational — the broker-outage fallback reaches the PEM, so an
    // `auto` env with gaps is one broker hiccup away from a failed mint (and,
    // previously, from a ceiling token). It is reported as blocked.
    const pemReachable = SOURCE !== 'broker'
    const blocked = strict && gaps.length > 0 && pemReachable
    process.stdout.write(
      JSON.stringify(
        {
          strictMode: strict,
          credentialSource: SOURCE,
          requestedScope: Object.keys(scope).length ? scope : null,
          repositoriesBounded: Boolean(scope.repositories),
          permissionsBounded: Boolean(scope.permissions),
          gaps,
          // Only a gate when strict is actually on, but the gaps are reported
          // either way so an environment can be fixed BEFORE strict is enabled
          // rather than discovered by an outage after.
          wouldMint: !blocked,
          pemMintAllowed: !blocked,
          // Never gated locally; the broker's own server-side refusal applies.
          brokerMintAllowed: SOURCE !== 'pem',
        },
        null,
        2
      ) + '\n'
    )
    if (blocked) process.exitCode = 1
    return
  }

  if (mode === 'scope' || mode === 'verify') {
    const scope = currentScope()
    const m = await acquire(scope)
    const orgKeys = Object.keys(m.permissions).filter((k) => k.startsWith('organization_'))
    const writeish = Object.entries(m.permissions).filter(([, v]) => v === 'write' || v === 'admin')
    const violations = []
    if (orgKeys.length) violations.push(`token carries ${orgKeys.length} organization_* permission(s): ${orgKeys.join(', ')}`)
    if (m.repository_selection === 'all') violations.push('repository_selection is "all" (token is not scoped to specific repos)')

    process.stdout.write(
      JSON.stringify(
        {
          source: m.via,
          requestedScope: Object.keys(scope).length ? scope : null,
          effective: {
            repository_selection: m.repository_selection,
            repositories: m.repositories,
            permissionCount: Object.keys(m.permissions).length,
            writeOrAdminCount: writeish.length,
            permissions: m.permissions,
          },
          violations,
          leastPrivilege: violations.length === 0,
        },
        null,
        2
      ) + '\n'
    )
    // `verify` is the least-privilege acceptance test: no organization_* key and
    // repository_selection != "all". `scope` is the same report without the verdict.
    if (mode === 'verify' && violations.length) process.exitCode = 1
    return
  }

  if (mode === 'doctor') {
    // Deliberately PEM-only. `doctor` reports on the App and its installation,
    // which needs an App JWT; the broker mints installation tokens and does not
    // expose App metadata. Say so plainly rather than failing as if the PEM were
    // merely missing.
    if (!pem()) {
      die(
        'doctor inspects the App itself and needs GH_APP_PRIVATE_KEY to sign an App JWT. ' +
          'The broker does not expose App metadata, so there is nothing to fall back to. ' +
          'Run this where the PEM is bound, or use `verify` to check an actual minted token.'
      )
    }
    const jwt = appJwt()
    const app = await gh('/app', { token: jwt })
    const id = await installationId(jwt)
    const inst = await gh(`/app/installations/${id}`, { token: jwt })

    // The commit identity is not guessable: the email uses the *bot user's* numeric
    // id, not the App id. Resolve it here so nobody has to look it up by hand.
    //
    // Best-effort, and now actually so: this needs a minted token, and every way
    // minting can refuse goes through `die()`, which exits. Run it inside a
    // bestEffort() window so the catch below is reachable and the permission
    // report — the entire reason to run `doctor` — still prints.
    let gitIdentity = null
    try {
      gitIdentity = await bestEffort(async () => {
        const login = `${app.slug}[bot]`
        // `token()` with NO argument, so the mint is attempted against the
        // CALLER'S scope. This was `token({})`: `{}` is truthy, so token() kept
        // it instead of calling currentScope(), and a strict-mode refusal then
        // reported the gaps of that hardcoded empty object — telling the caller
        // to set GH_APP_REPOS and GH_APP_PERMISSIONS while they were set, and
        // disagreeing with `scope-check` on identical input.
        const u = await gh(`/users/${encodeURIComponent(login)}`, { token: await token() })
        return {
          'user.name': login,
          'user.email': `${u.id}+${login}@users.noreply.github.com`,
        }
      })
    } catch (e) {
      // Carry the reason. "could not resolve bot user id" alone sent an operator
      // hunting for a network fault when the cause was a scope refusal this tool
      // had already diagnosed in full.
      const why = String((e && e.message) || e).replace(/\s*\n\s*/g, ' ').trim()
      gitIdentity = { error: `could not resolve bot user id; set user.email manually — ${why}` }
    }

    // Two profiles, because "what the App must grant" depends on who is asking.
    //   factory - what gh-app-smoke.sh needs, including creating and deleting repos.
    //             Stays the default: this is the long-standing contract and callers
    //             gating on `doctor` expect it. Changing it would quietly weaken a
    //             check rather than strengthen anything.
    //   agent   - what the day-to-day repo-work tasks actually need.
    //             Opt in with --profile agent to ask "is the App narrow enough yet?"
    //             without pretending the factory script's needs went away.
    // Either way `excessWriteOrAdmin` reports the over-grant, so the over-grant signal
    // is visible from the default invocation too.
    const PROFILES = {
      agent: {
        metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write',
        // Read-only CI visibility, so an agent can observe whether its
        // own PR passed. `actions` is deliberately NOT here — it also grants
        // workflow log download. See WITHHELD_CI_SOURCES in the broker's scope.js.
        checks: 'read', statuses: 'read',
      },
      factory: {
        metadata: 'read', contents: 'write', pull_requests: 'write', workflows: 'write',
        actions: 'write', checks: 'write', statuses: 'write', issues: 'write',
        administration: 'write', environments: 'write', deployments: 'write',
        secrets: 'write', variables: 'write',
      },
    }
    const profileName = flag('--profile') || process.env.GH_APP_PROFILE || 'factory'
    const REQUIRED = PROFILES[profileName]
    if (!REQUIRED) die(`unknown --profile "${profileName}" (expected: ${Object.keys(PROFILES).join(', ')})`)

    const granted = inst.permissions || {}
    const rank = { read: 1, write: 2, admin: 3 }
    const missing = Object.entries(REQUIRED)
      .filter(([k, v]) => (rank[granted[k]] || 0) < rank[v])
      .map(([k, v]) => `${k}: have ${granted[k] || 'none'}, need ${v}`)

    // Over-grant is the finding that matters here, so report it next to under-grant instead
    // of only failing on what is absent.
    //
    // Compared by LEVEL, not by presence. The agent profile needs `checks` and
    // `statuses` at read while the App grants both at write; keying
    // this on `!REQUIRED[k]` would treat "required at read, granted at write" as
    // acceptable and silently drop two write scopes off the over-grant report.
    // An over-grant is a level we do not need, whether or not we need the name.
    const excess = Object.entries(granted)
      .filter(([k, v]) => (rank[v] || 0) > (rank[REQUIRED[k]] || 0) && (v === 'write' || v === 'admin'))
      .map(([k, v]) => (REQUIRED[k] ? `${k}: ${v} (need only ${REQUIRED[k]})` : `${k}: ${v}`))
      .sort()

    process.stdout.write(
      JSON.stringify(
        {
          app: app.slug,
          appId: app.id,
          installationId: id,
          account: inst.account && inst.account.login,
          repositorySelection: inst.repository_selection,
          gitIdentity,
          profile: profileName,
          permissions: granted,
          permissionCount: Object.keys(granted).length,
          missingPermissions: missing,
          excessWriteOrAdmin: excess,
          excessCount: excess.length,
          ok: missing.length === 0,
        },
        null,
        2
      ) + '\n'
    )
    if (missing.length) process.exitCode = 1
    return
  }

  // Explicit mint only. THIS TOOL EMITS A LIVE CREDENTIAL, so an unrecognised
  // argument must never fall through to a mint. An earlier version did exactly
  // that: `gh-app-token.js --help` printed a real installation token, which then
  // had to be revoked (2026-08-23).
  if (mode === undefined || mode === 'token') {
    process.stdout.write((await token()) + '\n')
    return
  }

  if (mode === 'source') {
    // Diagnostic: which credential would be used, and is it actually present.
    // Emits no credential material, so it is safe to run anywhere — including
    // as the pre-unbind readiness check.
    const cfg = brokerConfig()
    process.stdout.write(
      JSON.stringify(
        {
          mode: SOURCE,
          broker: cfg.ok
            ? {
                configured: true,
                base: cfg.base,
                issueId: cfg.issueId,
                runId: cfg.runId,
                plugin: BROKER_PLUGIN,
                timeoutMs: BROKER_TIMEOUT,
                retries: BROKER_RETRIES,
                retryDelayMs: BROKER_RETRY_DELAY_MS,
              }
            : { configured: false, missing: cfg.missing },
          pem: { present: Boolean(pem()), appId: process.env.GH_APP_ID || null },
          cache: cachePath(currentScope()),
          credentials: availableCredentials(),
        },
        null,
        2
      ) + '\n'
    )
    return
  }

  if (mode === 'help' || mode === '--help' || mode === '-h') {
    process.stdout.write(
      [
        'gh-app-token.js - mints short-lived GitHub App installation tokens.',
        '',
        '  credential get   answer a git credential request (used by .gitconfig)',
        '  token            print a token   <-- THE ONLY MINTING COMMAND',
        '  scope            report what the current scope would mint',
        '  scope-check      report whether strict mode accepts this env (no mint)',
        '  verify           scope + non-zero exit if not least-privilege',
        '  doctor           report the permissions GitHub actually granted (PEM only)',
        '  source           report which credential would be used (mints nothing)',
        '  help             this text',
        '',
        'Credential: GH_APP_TOKEN_SOURCE=auto|broker|pem (default auto).',
        '  auto   = gh-token-broker first, GH_APP_PRIVATE_KEY as a loud fallback',
        '  broker = control-plane broker only, no fallback (post-cutover setting)',
        '  pem    = local signing key only',
        '',
        'Scope: GH_APP_REPOS / GH_APP_PERMISSIONS (or --repos/--permissions).',
        'On the broker path scope is derived server-side and can only be narrowed.',
        'GH_APP_SCOPE_STRICT=1 requires BOTH halves on the pem path (incl. the',
        '  auto fallback), and refuses to mint otherwise.',
        '',
        'Broker resilience: GH_APP_BROKER_TIMEOUT_MS (default 60000) is the per-',
        '  attempt timeout; GH_APP_BROKER_RETRIES (default 1) and',
        '  GH_APP_BROKER_RETRY_DELAY_MS (default 1000) bound the retry on a',
        '  timeout or 5xx before falling back per GH_APP_TOKEN_SOURCE.',
        '',
      ].join('\n')
    )
    return
  }

  die(
    `unknown command "${mode}". Commands: credential | token | scope | verify | doctor | source | help. ` +
      'Refusing to mint: this tool emits a live credential and does not fall through ' +
      'on unrecognised arguments.'
  )
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)))
