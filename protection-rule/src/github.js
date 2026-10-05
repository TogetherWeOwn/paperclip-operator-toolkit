// Fresh GitHub reads for the protection rule. Use the installed credential
// path (an App installation token minted at request time from the configured
// App identity), never shell interpolation or tokens in arguments. No polling
// and no retries in this module: a read that cannot complete throws and the
// caller fails closed.
//
// Every decision input is recomputed from these reads, never from delivery
// payloads: webhook fields are claims, and a claim is only established when a
// fresh API read confirms it.

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
const SHA40 = /^[0-9a-f]{40}$/

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Import an App RSA private key for RS256 JWT signing. Accepts PKCS#8
 * ("PRIVATE KEY" armor) and SEC1/RSA ("RSA PRIVATE KEY" armor) PEM blocks.
 * Throws on anything else — including OpenSSH and encrypted armor.
 *
 * @param {string} pem
 * @returns {Promise<CryptoKey>}
 */
async function importAppKey(pem) {
  try {
    const cleaned = pem.replace(/\r/g, '')
    const match = /-----BEGIN ([A-Za-z0-9 ]+)-----([\s\S]*?)-----END [A-Za-z0-9 ]+-----/.exec(cleaned)
    if (!match) throw new Error('no armor')
    const label = match[1].trim()
    let bytes = base64ToBytes(match[2].replace(/\s+/g, ''))
    if (label === 'PRIVATE KEY') {
      // PKCS#8 imports directly.
    } else if (label === 'RSA PRIVATE KEY') {
      // SEC1/RSA raw key: wrap in a PKCS#8 envelope (version 0, rsaEncryption).
      bytes = pkcs8WrapRsa(bytes)
    } else {
      throw new Error('unsupported armor')
    }
    return await globalThis.crypto.subtle.importKey('pkcs8', bytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  } catch {
    throw new Error('GitHub App key is invalid')
  }
}

/**
 * Wrap raw RSA (SEC1) DER in a PKCS#8 envelope. Minimal DER writer for exactly
 * this shape: SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL },
 * OCTET STRING key }. Lengths use the short form where they fit and the
 * 0x81/0x82 long form otherwise — App keys are small enough that 0x83+ never
 * applies, and the size guard below enforces that assumption loudly.
 *
 * @param {Uint8Array} rsaDer
 * @returns {Uint8Array}
 */
function pkcs8WrapRsa(rsaDer) {
  const len = (n) => {
    if (n < 128) return [n]
    if (n < 256) return [0x81, n]
    if (n < 65536) return [0x82, n >> 8, n & 0xff]
    throw new Error('key too large')
  }
  const tlv = (tag, content) => [tag, ...len(content.length), ...content]
  const oidRsa = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]
  const nullTag = [0x05, 0x00]
  const version = [0x02, 0x01, 0x00]
  const algorithm = tlv(0x30, [...oidRsa, ...nullTag])
  const octet = tlv(0x04, [...rsaDer])
  return Uint8Array.from(tlv(0x30, [...version, ...algorithm, ...octet]))
}

/**
 * Encode bytes as unpadded base64url. No Buffer: this runs on Workers too.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base64Url(bytes) {
  let text = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode base64 (armor interior) to bytes. Throws on invalid input.
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
function base64ToBytes(text) {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Mint an installation token for the claimed installation, using ONLY the
 * configured App identity. On ANY mint failure the caller fails closed; the
 * failure is never answered by trying another credential.
 *
 * @param {object} args
 * @param {(url: string, init?: object) => Promise<Response>} args.fetchImpl
 * @param {string | number} args.appId
 * @param {string} args.privateKeyPem
 * @param {number} args.installationId
 * @param {number} [args.nowMs]
 * @returns {Promise<string>} the installation token (never logged by callers)
 */
export async function mintInstallationToken({ fetchImpl, appId, privateKeyPem, installationId, nowMs = Date.now() }) {
  requireValue(typeof fetchImpl === 'function', 'GitHub transport is required')
  requireValue(
    (typeof appId === 'string' && appId.length > 0) || (typeof appId === 'number' && Number.isSafeInteger(appId)),
    'GitHub App identity is not configured',
  )
  requireValue(typeof privateKeyPem === 'string' && privateKeyPem.includes('PRIVATE KEY'), 'GitHub App key is not configured')
  requireValue(Number.isSafeInteger(installationId) && installationId > 0, 'GitHub installation is invalid')

  // WebCrypto RS256 via PKCS#8 import — no node:crypto, so this runs on the
  // request path (Workers) as well as in the test harness. A key that cannot
  // be imported or cannot sign fails closed: the verdict is REJECT.
  const key = await importAppKey(privateKeyPem)
  const issued = Math.floor(nowMs / 1000) - 60
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const body = base64Url(new TextEncoder().encode(JSON.stringify({ iss: String(appId), iat: issued, exp: issued + 600 })))
  const signingInput = new TextEncoder().encode(`${header}.${body}`)
  let signature
  try {
    signature = new Uint8Array(await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, signingInput))
  } catch {
    throw new Error('GitHub App key cannot sign')
  }
  const jwt = `${header}.${body}.${base64Url(signature)}`

  const response = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'protection-rule',
    },
  })
  if (response.status !== 201) throw new Error('GitHub installation token mint failed')
  const data = await response.json()
  requireValue(data && typeof data.token === 'string' && data.token.length > 0 && !/\s/.test(data.token),
    'GitHub installation token response is invalid')
  return data.token
}

/**
 * Create a scoped GitHub API reader bound to one installation token.
 *
 * @param {object} args
 * @param {(url: string, init?: object) => Promise<Response>} args.fetchImpl
 * @param {string} args.token            installation token; sent as a header, never logged
 * @param {string[]} args.allowedRepositories  explicit allowlist; every read is scoped to it
 * @param {number} [args.timeoutMs]
 */
export function createGithubReader({ fetchImpl, token, allowedRepositories, timeoutMs = 30000 }) {
  requireValue(typeof fetchImpl === 'function', 'GitHub transport is required')
  requireValue(typeof token === 'string' && token.length > 0 && !/\s/.test(token), 'GitHub credential is missing')
  requireValue(
    Array.isArray(allowedRepositories) &&
      allowedRepositories.length > 0 &&
      allowedRepositories.every((repo) => typeof repo === 'string' && REPOSITORY.test(repo)),
    'an explicit valid GitHub repository allowlist is required',
  )
  requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'GitHub timeout is invalid')
  const repositories = new Set(allowedRepositories)

  async function api(pathOrUrl, { method = 'GET', body, maxRedirects = 5 } = {}) {
    // Artifact downloads answer with a redirect to object storage. Redirects
    // are followed https-only and bounded — but the installation token travels
    // same-origin only. A cross-origin hop (the artifact redirect) is followed
    // WITHOUT Authorization, the way a pre-signed URL is fetched: sending the
    // token to object storage would hand GitHub authority to a third party.
    // Anything else — non-https, missing location, too many hops — fails the
    // read, which fails the verdict closed.
    requireValue(Number.isInteger(maxRedirects) && maxRedirects >= 0 && maxRedirects <= 10, 'GitHub redirect budget is invalid')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let next = pathOrUrl.startsWith('https://')
        ? pathOrUrl
        : `https://api.github.com${pathOrUrl}`
      for (let hop = 0; ; hop++) {
        const target = new URL(next)
        requireValue(target.protocol === 'https:', 'GitHub request must use HTTPS')
        const sameOrigin = target.hostname === 'api.github.com'
        const response = await fetchImpl(target.toString(), {
          method,
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            accept: 'application/vnd.github+json',
            // Token to the API origin only — never to a redirect target.
            ...(sameOrigin ? { authorization: `Bearer ${token}` } : {}),
            'x-github-api-version': '2022-11-28',
            'user-agent': 'protection-rule',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
          requireValue(hop < maxRedirects, 'GitHub redirect budget exceeded')
          const location = response.headers.get('location')
          requireValue(typeof location === 'string' && location.length > 0, 'GitHub redirect has no location')
          try { await response.arrayBuffer() } catch { /* drain best-effort; the body is discarded either way */ }
          next = new URL(location, target).toString()
          continue
        }
        return response
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function readJson(response, what) {
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    requireValue(data && typeof data === 'object' && !Array.isArray(data), `${what} response is invalid`)
    return data
  }

  /**
   * Fresh read of one workflow run. The returned head SHA is the claim the
   * decision binds to — never the SHA from the webhook body.
   */
  async function getRun(repository, runId) {
    requireValue(repositories.has(repository), 'GitHub repository is outside the configured scope')
    requireValue(Number.isSafeInteger(runId) && runId > 0, 'GitHub run id is invalid')
    const [owner, name] = repository.split('/')
    const response = await api(`/repos/${owner}/${name}/actions/runs/${runId}`)
    requireValue(response.status === 200, 'GitHub run read failed')
    const run = await readJson(response, 'GitHub run')
    requireValue(run.id === runId, 'GitHub run identity does not match')
    requireValue(typeof run.head_sha === 'string' && SHA40.test(run.head_sha), 'GitHub run head is invalid')
    requireValue(typeof run.event === 'string' && run.event.length > 0, 'GitHub run event is invalid')
    requireValue(typeof run.html_url === 'string' && run.html_url.length > 0, 'GitHub run URL is invalid')
    return { id: run.id, headSha: run.head_sha, event: run.event, htmlUrl: run.html_url }
  }

  /**
   * List non-expired artifacts of one run. Returns only identity fields —
   * content is fetched by the evidence layer through the same scoped reader.
   */
  async function listArtifacts(repository, runId) {
    requireValue(repositories.has(repository), 'GitHub repository is outside the configured scope')
    requireValue(Number.isSafeInteger(runId) && runId > 0, 'GitHub run id is invalid')
    const [owner, name] = repository.split('/')
    const response = await api(`/repos/${owner}/${name}/actions/runs/${runId}/artifacts?per_page=100`)
    requireValue(response.status === 200, 'GitHub artifact list failed')
    const data = await readJson(response, 'GitHub artifact list')
    requireValue(Array.isArray(data.artifacts), 'GitHub artifact list is invalid')
    const out = []
    for (const artifact of data.artifacts) {
      requireValue(artifact && typeof artifact === 'object', 'GitHub artifact entry is malformed')
      requireValue(Number.isSafeInteger(artifact.id) && artifact.id > 0, 'GitHub artifact id is invalid')
      requireValue(typeof artifact.name === 'string' && artifact.name.length > 0, 'GitHub artifact name is invalid')
      requireValue(typeof artifact.expired === 'boolean', 'GitHub artifact expiry is invalid')
      requireValue(typeof artifact.archive_download_url === 'string' &&
        artifact.archive_download_url.startsWith('https://'), 'GitHub artifact download URL is invalid')
      if (!artifact.expired) out.push({ id: artifact.id, name: artifact.name, downloadUrl: artifact.archive_download_url })
    }
    return out
  }

  /**
   * Download raw bytes through the same scoped reader. Caps the body so a
   * hostile or runaway artifact cannot exhaust the host.
   */
  async function downloadBytes(url, maxBytes) {
    requireValue(typeof url === 'string' && url.startsWith('https://'), 'GitHub download URL is invalid')
    requireValue(Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= 64 * 1024 * 1024, 'GitHub download budget is invalid')
    const response = await api(url)
    requireValue(response.status === 200, 'GitHub download failed')
    const buffer = new Uint8Array(await response.arrayBuffer())
    requireValue(buffer.length > 0 && buffer.length <= maxBytes, 'GitHub download size is invalid')
    return buffer
  }

  return { getRun, listArtifacts, downloadBytes, api }
}
